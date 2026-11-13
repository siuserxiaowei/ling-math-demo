#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertAbsentUnlessForce, assertFile, browserExecutableStatus, commandPath, inspectAudio, loadPlaywright, runCommand } from './runtime.mjs';

const HELP = `Render an offline HTML lesson into an MP4.

node render_video.mjs --html lesson.html --output lesson.mp4 [options]

Required HTML contract:
  window.lesson.duration          Positive duration in seconds.
  window.lesson.setTime(seconds)  Synchronous, deterministic rendering.
  ?video=1                       Hide controls and disable automatic playback.

Options:
  --width N              Even width in pixels (default: 1080)
  --height N             Even height in pixels (default: 1920)
  --fps N                Integer frames per second, 1–120 (default: 30)
  --audio FILE           Narration; its measured duration must fit the video
  --duration SECONDS     Override duration; a longer duration holds the final scene
  --frames-dir DIRECTORY Keep PNG frames in a new or empty directory
  --poster FILE.png      Save the final frame as a poster
  --playwright-module P  Playwright package directory or entry file
  --browser FILE         Optional Chromium executable
  --ffmpeg COMMAND       FFmpeg command or file path (default: ffmpeg)
  --ffprobe COMMAND      FFprobe command or file path (default: ffprobe)
  --force                Replace the exact MP4/poster output files
  --help                 Show this message

The renderer blocks remote network requests. It does not install dependencies.
Without --audio, the output is explicitly reported as silent.
`;

export function parseArgs(argv) {
  const valueFlags = new Set(['html', 'output', 'width', 'height', 'fps', 'audio', 'duration', 'frames-dir', 'poster', 'playwright-module', 'browser', 'ffmpeg', 'ffprobe']);
  const options = { width: 1080, height: 1920, fps: 30, force: false, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    if (token === '--force') { options.force = true; continue; }
    if (!token.startsWith('--') || !valueFlags.has(token.slice(2))) throw new Error(`Unknown argument: ${token}`);
    const key = token.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
  }
  if (options.help) return options;
  if (!options.html || !options.output) throw new Error('--html and --output are required.');
  for (const key of ['width', 'height']) {
    const value = Number(options[key]);
    if (!Number.isInteger(value) || value < 2 || value > 8192 || value % 2) throw new Error(`--${key} must be an even integer between 2 and 8192.`);
    options[key] = value;
  }
  options.fps = Number(options.fps);
  if (!Number.isInteger(options.fps) || options.fps < 1 || options.fps > 120) throw new Error('--fps must be an integer between 1 and 120.');
  if (options.duration !== undefined) {
    options.duration = Number(options.duration);
    if (!Number.isFinite(options.duration) || options.duration <= 0) throw new Error('--duration must be a positive finite number.');
  }
  for (const key of ['html', 'output', 'audio', 'frames-dir', 'poster', 'browser']) if (options[key]) options[key] = resolve(options[key]);
  if (!['.html', '.htm'].includes(extname(options.html).toLowerCase())) throw new Error('--html must name an HTML file.');
  if (extname(options.output).toLowerCase() !== '.mp4') throw new Error('--output must use the .mp4 extension.');
  if (options.poster && extname(options.poster).toLowerCase() !== '.png') throw new Error('--poster must use the .png extension.');
  const uniquePaths = [options.html, options.output, options.audio, options.poster].filter(Boolean);
  if (new Set(uniquePaths).size !== uniquePaths.length) throw new Error('Input and output paths must be different.');
  options.ffmpeg = commandPath(options.ffmpeg);
  options.ffprobe = commandPath(options.ffprobe);
  return options;
}

export function planTiming(lessonDuration, overrideDuration, audioDuration, fps) {
  if (!Number.isFinite(lessonDuration) || lessonDuration <= 0) throw new Error('window.lesson.duration must be a positive finite number.');
  const requestedDuration = overrideDuration ?? lessonDuration;
  if (!Number.isFinite(requestedDuration) || requestedDuration <= 0) throw new Error('Video duration must be positive and finite.');
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('FPS must be an integer between 1 and 120.');
  const frameCount = Math.ceil(requestedDuration * fps);
  if (!Number.isSafeInteger(frameCount)) throw new Error('The requested video has too many frames.');
  const duration = frameCount / fps;
  if (audioDuration !== undefined && (!Number.isFinite(audioDuration) || audioDuration <= 0)) throw new Error('Audio duration must be positive and finite.');
  if (audioDuration !== undefined && audioDuration > duration + 0.000001) {
    throw new Error(`Narration is ${audioDuration.toFixed(3)}s, longer than the ${duration.toFixed(3)}s video. Set --duration to at least ${audioDuration.toFixed(3)}; narration will never be silently truncated.`);
  }
  return { lessonDuration, requestedDuration, frameCount, duration, fps, trimmedLesson: requestedDuration < lessonDuration, finalSceneHold: Math.max(0, duration - lessonDuration) };
}

async function commitFile(stagedPath, targetPath, force) {
  if (force) return rename(stagedPath, targetPath);
  // Same-directory hard linking makes the non-overwrite promise atomic.
  try {
    await link(stagedPath, targetPath);
  } catch (error) {
    if (['ENOSYS', 'ENOTSUP', 'EPERM'].includes(error.code)) await copyFile(stagedPath, targetPath, constants.COPYFILE_EXCL);
    else throw error;
  }
  await unlink(stagedPath);
}

function writeFrame(stream, data) {
  return new Promise((resolveWrite, reject) => {
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('FFmpeg closed its input before the frame was written.')); };
    const cleanup = () => { stream.off('error', onError); stream.off('close', onClose); };
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.write(data, (error) => { cleanup(); error ? reject(error) : resolveWrite(); });
  });
}

export async function render(options) {
  await assertFile(options.html, '--html');
  if (options.audio) await assertFile(options.audio, '--audio');
  await assertAbsentUnlessForce(options.output, options.force);
  if (options.poster) await assertAbsentUnlessForce(options.poster, options.force);
  await runCommand(options.ffmpeg, ['-version']);
  await runCommand(options.ffprobe, ['-version']);
  const audio = options.audio ? await inspectAudio(options.audio, options.ffprobe) : null;
  const { chromium, moduleEntry } = await loadPlaywright(options['playwright-module']);
  const executable = await browserExecutableStatus(chromium, options.browser);
  if (!executable.available) throw new Error(`Chromium is missing: ${executable.executablePath}. Install Playwright's Chromium in your environment, or pass --browser.`);
  await mkdir(dirname(options.output), { recursive: true });
  if (options.poster) await mkdir(dirname(options.poster), { recursive: true });
  if (options['frames-dir']) {
    await mkdir(options['frames-dir'], { recursive: true });
    if ((await readdir(options['frames-dir'])).length) throw new Error('--frames-dir must be empty; existing files will not be replaced.');
  }

  const token = randomUUID();
  const stagedOutput = join(dirname(options.output), `.${basename(options.output)}.${token}.mp4`);
  const stagedPoster = options.poster ? join(dirname(options.poster), `.${basename(options.poster)}.${token}.png`) : null;
  const deniedRequests = new Set();
  const pageErrors = [];
  let browser;
  let encoder;
  let encoderResult;
  let encoderDone;
  let encoderStderr = '';
  let lastFrame;
  let timing;
  const abort = () => { encoder?.kill('SIGTERM'); void browser?.close().catch(() => {}); };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    browser = await chromium.launch({ headless: true, executablePath: executable.executablePath });
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (/^(data:|blob:|about:)/.test(url)) return route.continue();
      if (/^file:/.test(url)) {
        try { if (resolve(fileURLToPath(url)) === options.html) return route.continue(); }
        catch {}
        deniedRequests.add('[blocked-local-file-resource]');
        return route.abort('blockedbyclient');
      }
      deniedRequests.add(url);
      return route.abort('blockedbyclient');
    });
    const url = pathToFileURL(options.html);
    url.searchParams.set('video', '1');
    await page.goto(url.href, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.lesson && typeof window.lesson.setTime === 'function' && typeof window.lesson.duration === 'number', undefined, { timeout: 10000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    const lessonDuration = await page.evaluate(() => window.lesson.duration);
    timing = planTiming(lessonDuration, options.duration, audio?.duration, options.fps);
    if (timing.trimmedLesson) process.stderr.write(`Warning: --duration intentionally shortens the ${lessonDuration}s lesson to ${timing.duration}s.\n`);
    if (deniedRequests.size) throw new Error(`The lesson requested remote assets, so offline rendering was stopped:\n${[...deniedRequests].join('\n')}`);
    if (pageErrors.length) throw new Error(`Lesson script failed: ${pageErrors.join('; ')}`);

    const encoderArgs = ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(options.fps), '-i', 'pipe:0'];
    if (options.audio) encoderArgs.push('-i', options.audio);
    encoderArgs.push('-map', '0:v:0');
    if (options.audio) encoderArgs.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-af', 'apad', '-t', String(timing.duration));
    else encoderArgs.push('-an');
    encoderArgs.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', stagedOutput);
    encoder = spawn(options.ffmpeg, encoderArgs, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    encoder.stdin.on('error', () => {});
    encoder.stderr.on('data', (chunk) => { encoderStderr = (encoderStderr + chunk).slice(-32000); });
    encoderResult = new Promise((resolveEncoder) => {
      encoder.once('error', (error) => { encoderDone = { error }; resolveEncoder(encoderDone); });
      encoder.once('close', (code, signal) => { encoderDone = { code, signal }; resolveEncoder(encoderDone); });
    });
    const progressStep = Math.max(1, Math.floor(timing.frameCount / 10));
    for (let frame = 0; frame < timing.frameCount; frame++) {
      if (encoderDone) throw new Error(`FFmpeg stopped early: ${encoderDone.error?.message || encoderStderr || encoderDone.code}`);
      const time = Math.min(frame / options.fps, lessonDuration);
      await page.evaluate((seconds) => {
        const result = window.lesson.setTime(seconds);
        if (result && typeof result.then === 'function') throw new Error('lesson.setTime must complete synchronously.');
      }, time);
      if (pageErrors.length) throw new Error(`Lesson script failed: ${pageErrors.join('; ')}`);
      if (deniedRequests.size) throw new Error(`The lesson requested remote assets: ${[...deniedRequests].join(', ')}`);
      const screenshot = await page.screenshot({ type: 'png', fullPage: false });
      if (options['frames-dir']) await writeFile(join(options['frames-dir'], `${String(frame).padStart(6, '0')}.png`), screenshot, { flag: 'wx' });
      await writeFrame(encoder.stdin, screenshot);
      lastFrame = screenshot;
      if (frame % progressStep === 0 || frame === timing.frameCount - 1) process.stderr.write(`Rendering ${frame + 1}/${timing.frameCount} frames\n`);
    }
    encoder.stdin.end();
    const result = await encoderResult;
    if (result.error || result.code !== 0) throw new Error(`FFmpeg failed: ${result.error?.message || encoderStderr || result.signal || result.code}`);
    await browser.close();
    browser = null;

    const { stdout } = await runCommand(options.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,pix_fmt,nb_frames', '-of', 'json', stagedOutput]);
    const media = JSON.parse(stdout);
    const video = media.streams?.find((stream) => stream.codec_type === 'video');
    const encodedDuration = Number(media.format?.duration);
    if (!video || video.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p' || video.width !== options.width || video.height !== options.height) throw new Error('Encoded video failed codec, pixel format, or dimension verification.');
    if (Number(video.nb_frames) !== timing.frameCount) throw new Error(`Encoded frame count differs from the timeline: expected ${timing.frameCount}, received ${video.nb_frames}.`);
    if (!audio && (media.streams || []).some((stream) => stream.codec_type === 'audio')) throw new Error('A silent export unexpectedly contains an audio stream.');
    if (audio && (!(media.streams || []).some((stream) => stream.codec_type === 'audio') || encodedDuration + 0.001 < audio.duration)) throw new Error('Encoded output does not contain the complete narration.');
    if (stagedPoster) await writeFile(stagedPoster, lastFrame, { flag: 'wx' });
    await commitFile(stagedOutput, options.output, options.force);
    if (stagedPoster) await commitFile(stagedPoster, options.poster, options.force);
    return {
      output: options.output, html: options.html, width: options.width, height: options.height,
      ...timing, encodedDuration, audio: audio ? { path: options.audio, duration: audio.duration, silenceTail: Math.max(0, timing.duration - audio.duration) } : { mode: 'silent' },
      poster: options.poster || null, posterTime: options.poster ? Math.min((timing.frameCount - 1) / options.fps, lessonDuration) : null,
      framesDirectory: options['frames-dir'] || null, playwrightModule: moduleEntry, remoteRequests: [],
      verification: { codec: video.codec_name, pixelFormat: video.pix_fmt, frames: Number(video.nb_frames) || null },
    };
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    if (encoder && !encoderDone) {
      encoder.stdin?.destroy();
      encoder.kill('SIGTERM');
      const killTimer = setTimeout(() => encoder.kill('SIGKILL'), 3000);
      await encoderResult;
      clearTimeout(killTimer);
    }
    if (browser) await browser.close().catch(() => {});
    await rm(stagedOutput, { force: true });
    if (stagedPoster) await rm(stagedPoster, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else process.stdout.write(JSON.stringify(await render(options), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`Render failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
