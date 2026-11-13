#!/usr/bin/env node
import { fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaywright } from './runtime.mjs';

const SELF = fileURLToPath(import.meta.url);
const LIMITS = { width: 1080, height: 1920, minFontPx: 48, maxFontPx: 60, safeBottomPx: 96, safeSidePx: 64, boundaryEpsilon: 1 / 60, rasterMaxChannelDelta: 1, rasterChangedPixelRatio: 0.0001 };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const normalizeCaption = (text) => String(text ?? '').normalize('NFC').replace(/\s+/gu, '');

function safeError(value) {
  return String(value ?? '').slice(0, 1600)
    .replace(/(?:https?|wss?|file):\/\/[^\s<>"')]+/gi, '[resource-url]')
    .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/\b(api[_-]?key|token|authorization|password|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\/(?:Users|home|private|tmp|var|opt|Volumes)\/[^\s<>"')]+/g, '[local-path]');
}

function addIssue(report, kind, message, extra = {}) {
  report.issues.push({ kind, message: safeError(message), blocking: true, ...extra });
}

function baseReport(options) {
  return { ok: false, mathStatus: 'not_assessed', audioMeasurement: 'Uses the upstream measured narration manifest; this tool does not measure or synthesize audio.', inspectUsedAsEvidence: false,
    input: basename(options.html), narration: basename(options.narration), narrationDuration: null, lessonDuration: null,
    thresholds: { ...LIMITS }, issues: [], samples: [], screenshots: [], determinism: { ok: false, comparisons: [] }, pageErrors: [], blockedResources: [] };
}

export function narrationCues(manifest) {
  if (!Number.isFinite(manifest?.duration) || manifest.duration <= 0) throw new Error('narration.duration must be a positive measured duration.');
  if (!Array.isArray(manifest.segments) || !manifest.segments.length) throw new Error('narration.segments must be a non-empty array.');
  const ids = new Set();
  const cues = manifest.segments.map((segment, index) => {
    if (typeof segment.id !== 'string' || !segment.id || ids.has(segment.id)) throw new Error(`Segment ${index + 1} needs a unique non-empty string id.`);
    ids.add(segment.id);
    if (typeof segment.text !== 'string' || !normalizeCaption(segment.text)) throw new Error(`Segment ${segment.id} needs non-empty on-screen text.`);
    const { start, end, voiceStart, voiceEnd } = segment;
    if (![start, end, voiceStart, voiceEnd].every(Number.isFinite) || start < 0 || voiceStart < start || voiceEnd <= voiceStart || end < voiceEnd || end > manifest.duration + 0.000001) throw new Error(`Invalid measured timing for segment ${segment.id}.`);
    if (index && start < manifest.segments[index - 1].end - 0.000001) throw new Error(`Visual intervals overlap at segment ${segment.id}.`);
    return { id: segment.id, start: voiceStart, end, voiceStart, voiceEnd, text: segment.text, visual: segment.visual ?? null };
  });
  if (Math.abs(cues.at(-1).end - manifest.duration) > 0.000001) throw new Error('The last segment.end must equal narration.duration.');
  return cues;
}

export function teachingPauseIntervals(manifest) {
  if (!manifest.teaching) return [];
  const check=manifest.teaching.check,segments=manifest.segments;
  const index=segments.findIndex(s=>s.id===check?.questionSegmentId);
  const question=segments[index],answer=segments[index+1];
  if (!check || !Number.isFinite(check.pauseSeconds) || check.pauseSeconds<3 || check.pauseSeconds>15 || index<0 || answer?.id!==check.answerSegmentId) throw new Error('Teaching question and answer must reference adjacent measured segments and a 3–15 second pause.');
  const start=question.voiceEnd,end=answer.voiceStart;
  if (end-start<check.pauseSeconds-0.0001 || Math.abs(question.end-end)>0.0001) throw new Error('Measured narration does not leave the complete thinking pause before the answer.');
  return [{questionSegmentId:question.id,answerSegmentId:answer.id,start,end,duration:end-start,requiredSeconds:check.pauseSeconds,audioSilenceAssessed:false,answerConcealment:'requires host visual review'}];
}

export function filmSampleTimes(cues, duration, thinkingPauses=[]) {
  const times = new Map();
  const add = (time, reason) => {
    if (time < 0 || time >= duration) return;
    const key = time.toFixed(9);
    if (!times.has(key)) times.set(key, { time, reasons: [] });
    times.get(key).reasons.push(reason);
  };
  add(0, 'film-start');
  for (const pause of thinkingPauses) {
    add(pause.start+1/60, `${pause.questionSegmentId}:thinking-start`);
    add((pause.start+pause.end)/2, `${pause.questionSegmentId}:thinking-midpoint`);
    add(pause.end-1/60, `${pause.questionSegmentId}:thinking-end`);
  }
  for (const cue of cues) {
    add((cue.voiceStart + cue.voiceEnd) / 2, `${cue.id}:voice-midpoint`);
    add((cue.start + cue.end) / 2, `${cue.id}:cue-midpoint`);
    for (const boundary of ['start', 'end']) {
      const epsilon = Math.min(LIMITS.boundaryEpsilon, (cue.end - cue.start) / 4);
      add(cue[boundary] - epsilon, `${cue.id}:${boundary}-before`);
      add(cue[boundary] + epsilon, `${cue.id}:${boundary}-after`);
    }
  }
  add(Math.max(0, duration - 1 / 30), 'last-video-frame');
  return [...times.values()].sort((a, b) => a.time - b.time);
}

export function activeCue(cues, time) { return cues.find((cue) => time >= cue.start && time < cue.end) || null; }

function parseArgs(argv) {
  const options = { timeoutMs: 90000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { help: true };
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !['html', 'narration', 'out-dir', 'playwright-module', 'timeout-ms'].includes(key)) throw new Error(`Unknown argument: ${argv[i]}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = argv[++i];
  }
  if (!options.html || !options.narration || !options['out-dir']) throw new Error('--html, --narration and --out-dir are required.');
  options.html = resolve(options.html); options.narration = resolve(options.narration); options.outDir = resolve(options['out-dir']);
  options.timeoutMs = Number(options['timeout-ms'] ?? options.timeoutMs);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 300000) throw new Error('--timeout-ms must be between 1000 and 300000.');
  return options;
}

async function outputDirectory(options) {
  if ([parse(options.outDir).root, resolve(homedir()), resolve(process.cwd()), dirname(options.html), dirname(options.narration)].includes(options.outDir)) throw new Error('Choose a dedicated new or empty --out-dir.');
  const entry = await lstat(options.outDir).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || (await readdir(options.outDir)).length)) throw new Error('--out-dir must be new or empty, and must not be a symbolic link.');
  await mkdir(options.outDir, { recursive: true }); options.outDir = await realpath(options.outDir);
}

async function verify(options) {
  const report = baseReport(options);
  let browser, comparisonContext, comparisonPage;
  try {
    const manifest = JSON.parse(await readFile(options.narration, 'utf8'));
    const cues = narrationCues(manifest); report.narrationDuration = manifest.duration;
    report.captionIntervals = cues.map(({ id, start, end, text, visual }) => ({ id, start, end, text, visual }));
    report.thinkingPauses=teachingPauseIntervals(manifest);
    report.teachingContentStatus=manifest.teaching?'pending_host_review':'legacy_not_assessed';
    const { chromium } = await loadPlaywright(options['playwright-module']);
    browser = await chromium.launch({ headless: true });
    const cdp = await browser.newBrowserCDPSession();
    const processes = await cdp.send('SystemInfo.getProcessInfo');
    const pid = processes.processInfo?.find((process) => process.type === 'browser')?.id;
    if (Number.isInteger(pid) && pid > 1 && process.send) process.send({ type: 'owned-browser', pid });
    await cdp.detach();
    const context = await browser.newContext({ viewport: { width: LIMITS.width, height: LIMITS.height }, deviceScaleFactor: 1, locale: 'zh-CN', serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (/^(data:|blob:|about:)/i.test(url)) return route.continue();
      if (/^file:/i.test(url)) { try { if (resolve(fileURLToPath(url)) === options.html) return route.continue(); } catch {} }
      if (report.blockedResources.length < 30) report.blockedResources.push(/^file:/i.test(url) ? '[another-local-file]' : '[remote-resource]');
      return route.abort('blockedbyclient');
    });
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket(/^(ws|wss):/i, (socket) => { report.blockedResources.push('[remote-websocket]'); socket.close({ code: 1008, reason: 'Offline film verification' }); });
    const page = await context.newPage(); page.on('pageerror', (error) => { if (report.pageErrors.length < 20) report.pageErrors.push(safeError(error.message)); });
    page.setDefaultTimeout(6000); page.setDefaultNavigationTimeout(10000);
    const url = pathToFileURL(options.html); url.searchParams.set('video', '1');
    await page.goto(url.href, { waitUntil: 'load' }); await page.evaluate(async () => { await document.fonts.ready; });
    const contract = await page.evaluate(() => ({ duration: window.lesson?.duration, setTime: typeof window.lesson?.setTime === 'function', captionCount: document.querySelectorAll('#film-caption').length }));
    report.lessonDuration = contract.duration ?? null;
    if (!Number.isFinite(contract.duration) || contract.duration <= 0 || !contract.setTime) { addIssue(report, 'film_contract', 'Expose a positive lesson.duration and synchronous lesson.setTime(seconds).'); return report; }
    if (contract.duration + 0.000001 < manifest.duration) addIssue(report, 'film_too_short', 'lesson.duration is shorter than the measured narration.duration.');
    if (contract.captionCount !== 1) { addIssue(report, 'caption_dom', 'The film must have exactly one #film-caption element.'); return report; }

    async function stateAt(time) {
      return page.evaluate((seconds) => {
        const result = window.lesson.setTime(seconds);
        if (result && typeof result.then === 'function') throw new Error('lesson.setTime must be synchronous.');
        const caption = document.querySelector('#film-caption');
        const box = (element) => { const b = element.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
        const isVisible = (element) => {
          const b = element.getBoundingClientRect(); if (!b.width || !b.height) return false;
          for (let current = element; current; current = current.parentElement) { const s = getComputedStyle(current); if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false; }
          return true;
        };
        const captionRect = box(caption), textRects = [], fonts = [];
        const walker = document.createTreeWalker(caption, NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) {
          if (!(node.textContent || '').trim() || !isVisible(node.parentElement)) continue;
          const element = node.parentElement, style = getComputedStyle(element);
          let scale = 1;
          if (element instanceof SVGGraphicsElement) { const m = element.getScreenCTM(); scale = Math.hypot(m.c, m.d); }
          else { let matrix = new DOMMatrix(); for (let current = element; current; current = current.parentElement) { const css = getComputedStyle(current); if (css.transform !== 'none') matrix = new DOMMatrix(css.transform).multiply(matrix); scale *= Number.parseFloat(css.zoom) || 1; } scale *= Math.hypot(matrix.c, matrix.d); }
          if (!element.closest('sup,sub')) fonts.push(Number.parseFloat(style.fontSize) * scale);
          const range = document.createRange(); range.selectNodeContents(node);
          for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) textRects.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
        }
        const tops = []; for (const rect of textRects) if (!tops.some((top) => Math.abs(top - rect.top) < 12)) tops.push(rect.top);
        const glyphBounds = textRects.length ? { left: Math.min(...textRects.map((r) => r.left)), right: Math.max(...textRects.map((r) => r.right)), top: Math.min(...textRects.map((r) => r.top)), bottom: Math.max(...textRects.map((r) => r.bottom)) } : null;
        let clipped = false;
        for (const rect of textRects) {
          if (rect.left < captionRect.left - 1 || rect.right > captionRect.right + 1 || rect.top < captionRect.top - 1 || rect.bottom > captionRect.bottom + 1) clipped = true;
          for (let current = caption; current; current = current.parentElement) { const css = getComputedStyle(current), b = current.getBoundingClientRect(); if (/hidden|clip|scroll|auto/.test(css.overflowX) && (rect.left < b.left - 1 || rect.right > b.right + 1)) clipped = true; if (/hidden|clip|scroll|auto/.test(css.overflowY) && (rect.top < b.top - 1 || rect.bottom > b.bottom + 1)) clipped = true; }
        }
        const sceneIssues = [];
        for (const svg of document.querySelectorAll('svg')) {
          if (svg.ownerSVGElement || caption.contains(svg) || !isVisible(svg)) continue;
          const bounds = box(svg), css = getComputedStyle(svg);
          if (bounds.left < -1 || bounds.right > innerWidth + 1 || bounds.top < -1 || bounds.bottom > innerHeight + 1) sceneIssues.push({ kind: 'svg_outside_frame', bounds });
          for (const text of svg.querySelectorAll('text')) {
            if (!isVisible(text) || caption.contains(text)) continue;
            const rect = box(text);
            if (/hidden|clip/.test(css.overflow) && (rect.left < bounds.left - 2 || rect.right > bounds.right + 2 || rect.top < bounds.top - 2 || rect.bottom > bounds.bottom + 2)) sceneIssues.push({ kind: 'svg_text_clipped', text: (text.textContent || '').slice(0, 100), bounds: rect });
            const dx = Math.min(rect.right, captionRect.right) - Math.max(rect.left, captionRect.left), dy = Math.min(rect.bottom, captionRect.bottom) - Math.max(rect.top, captionRect.top);
            if (isVisible(caption) && dx > 2 && dy > 2) sceneIssues.push({ kind: 'caption_scene_text_overlap', text: (text.textContent || '').slice(0, 100), bounds: rect });
          }
        }
        return { text: caption.innerText ?? caption.textContent ?? '', segmentId: caption.getAttribute('data-segment-id'), visible: isVisible(caption), captionRect, glyphBounds, lineCount: tops.length, fonts, clipped, sceneIssues,
          frame: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight } };
      }, time);
    }

    async function pngDiff(a, b) {
      if (!comparisonPage) { comparisonContext = await browser.newContext({ serviceWorkers: 'block' }); comparisonPage = await comparisonContext.newPage(); await comparisonPage.goto('about:blank'); }
      return comparisonPage.evaluate(async ({ a, b }) => {
        const decode = async (data) => { const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode(); return image; };
        const [left, right] = await Promise.all([decode(a), decode(b)]);
        if (left.width !== right.width || left.height !== right.height) return { maxChannelDelta: 255, changedPixelRatio: 1, sameDimensions: false };
        const canvas = document.createElement('canvas'); canvas.width = left.width; canvas.height = left.height; const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(left, 0, 0); const pixelsA = ctx.getImageData(0, 0, left.width, left.height).data; ctx.clearRect(0, 0, left.width, left.height); ctx.drawImage(right, 0, 0); const pixelsB = ctx.getImageData(0, 0, left.width, left.height).data;
        let changedPixels = 0, maxChannelDelta = 0;
        for (let i = 0; i < pixelsA.length; i += 4) { let changed = false; for (let c = 0; c < 4; c++) { const delta = Math.abs(pixelsA[i + c] - pixelsB[i + c]); maxChannelDelta = Math.max(maxChannelDelta, delta); changed ||= delta > 0; } if (changed) changedPixels++; }
        return { sameDimensions: true, maxChannelDelta, changedPixels, totalPixels: left.width * left.height, changedPixelRatio: changedPixels / (left.width * left.height) };
      }, { a: a.toString('base64'), b: b.toString('base64') });
    }

    const samples = filmSampleTimes(cues, manifest.duration, report.thinkingPauses), references = new Map();
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i], expected = activeCue(cues, sample.time), state = await stateAt(sample.time);
      const png = await page.screenshot({ type: 'png', fullPage: false, animations: 'allow', caret: 'hide', timeout: 6000 });
      const filename = `frame-${String(i + 1).padStart(3, '0')}-${sample.time.toFixed(3)}.png`; await writeFile(resolve(options.outDir, filename), png, { flag: 'wx' }); report.screenshots.push(filename);
      references.set(sample.time, { png, hash: sha(png) });
      const evidence = { ...sample, expectedSegmentId: expected?.id ?? null, expectedText: expected?.text ?? '', screenshot: filename, actual: state }; report.samples.push(evidence);
      const extra = { time: sample.time, segmentId: expected?.id ?? null };
      if (expected) {
        if (!state.visible || !normalizeCaption(state.text)) addIssue(report, 'caption_empty', 'An active narration cue has no visible subtitle.', extra);
        if (normalizeCaption(state.text) !== normalizeCaption(expected.text)) addIssue(report, 'caption_text_mismatch', 'Visible subtitle text differs from this cue’s on-screen text.', extra);
        if (state.segmentId !== expected.id) addIssue(report, 'caption_segment_mismatch', 'The subtitle DOM data-segment-id is not the active measured segment.', extra);
        if (state.lineCount < 1 || state.lineCount > 2) addIssue(report, 'caption_line_count', `Subtitle uses ${state.lineCount} actual rendered lines; expected one or two.`, extra);
        if (!state.fonts.length || state.fonts.some((size) => size < LIMITS.minFontPx - 0.5 || size > LIMITS.maxFontPx + 0.5)) addIssue(report, 'caption_font_size', 'Actual subtitle glyph styles are outside the approximately 48–60px film specification.', extra);
        const subtitleBounds = state.glyphBounds || state.captionRect;
        if (subtitleBounds.left < LIMITS.safeSidePx - 1 || subtitleBounds.right > LIMITS.width - LIMITS.safeSidePx + 1 || subtitleBounds.bottom > LIMITS.height - LIMITS.safeBottomPx + 1 || subtitleBounds.top < 0) addIssue(report, 'caption_safe_area', 'Visible subtitle glyphs violate the configured side or bottom safe margin.', extra);
        if (state.clipped) addIssue(report, 'caption_clipped', 'Subtitle glyphs extend beyond their own box or a clipping ancestor.', extra);
      } else if (state.visible && normalizeCaption(state.text)) addIssue(report, 'caption_outside_cue', 'A subtitle is visible outside all measured caption cue intervals.', extra);
      if (state.frame.width !== LIMITS.width || state.frame.height !== LIMITS.height || state.frame.scrollWidth > LIMITS.width + 1 || state.frame.scrollHeight > LIMITS.height + 1) addIssue(report, 'film_frame_overflow', 'The video page does not fit a 1080×1920 frame.', extra);
      for (const problem of state.sceneIssues) addIssue(report, problem.kind, 'A rendered SVG label is clipped, outside the frame, or overlaps the subtitle area.', { ...extra, evidence: problem });
    }
    for (const sample of [...samples].reverse()) {
      await stateAt(sample.time); const png = await page.screenshot({ type: 'png', fullPage: false, animations: 'allow', caret: 'hide', timeout: 6000 }); const reference = references.get(sample.time), actualHash = sha(png);
      const comparison = { time: sample.time, referenceSha256: reference.hash, actualSha256: actualHash, rawHashEqual: reference.hash === actualHash, accepted: reference.hash === actualHash, pixelDiff: null };
      if (!comparison.rawHashEqual) { comparison.pixelDiff = await pngDiff(reference.png, png); comparison.accepted = comparison.pixelDiff.sameDimensions && comparison.pixelDiff.maxChannelDelta <= LIMITS.rasterMaxChannelDelta && comparison.pixelDiff.changedPixelRatio <= LIMITS.rasterChangedPixelRatio; }
      report.determinism.comparisons.push(comparison);
    }
    report.determinism.ok = report.determinism.comparisons.every((item) => item.accepted);
    if (!report.determinism.ok) addIssue(report, 'film_nondeterministic', 'Returning to the same film time changes visible pixels beyond the recorded raster-noise tolerance.');
  } catch (error) { addIssue(report, 'film_verification_error', error.message); }
  finally {
    if (report.pageErrors.length) addIssue(report, 'film_page_error', 'The film raised JavaScript errors; see the redacted pageErrors field.');
    if (report.blockedResources.length) addIssue(report, 'film_resource_dependency', 'The film requested a remote resource or another local file; the single-file video must be self-contained.');
    if (comparisonContext) await comparisonContext.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
  report.ok = !report.issues.some((issue) => issue.blocking);
  return report;
}

async function terminate(pid, signal) {
  if (!pid) return;
  if (process.platform === 'win32') await new Promise((done) => { const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killer.once('error', done); killer.once('close', done); });
  else { try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; try { process.kill(pid, signal); } catch (inner) { if (inner.code !== 'ESRCH') throw inner; } } }
}

async function supervised(options) {
  const fallback = baseReport(options), owned = new Set(); let finished = false;
  const child = fork(SELF, ['--film-worker'], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); child.stdout.resume(); child.stderr.resume();
  return new Promise((done) => {
    const timer = setTimeout(async () => { if (finished) return; finished = true; addIssue(fallback, 'film_verification_timeout', `The isolated film verification exceeded ${options.timeoutMs}ms.`); for (const pid of [...owned, child.pid]) await terminate(pid, 'SIGTERM').catch(() => {}); await new Promise((resolveDelay) => setTimeout(resolveDelay, 250)); for (const pid of [...owned, child.pid]) await terminate(pid, 'SIGKILL').catch(() => {}); done(fallback); }, options.timeoutMs);
    child.on('message', (message) => { if (message?.type === 'owned-browser' && Number.isInteger(message.pid) && message.pid > 1 && message.pid !== process.pid) owned.add(message.pid); if (!finished && message?.type === 'result') { finished = true; clearTimeout(timer); done(message.report); } });
    child.once('error', (error) => { if (finished) return; finished = true; clearTimeout(timer); addIssue(fallback, 'film_worker_error', error.message); done(fallback); });
    child.once('exit', (code, signal) => { if (finished) return; finished = true; clearTimeout(timer); addIssue(fallback, 'film_worker_exit', `Film worker exited before reporting (${signal || code}).`); done(fallback); });
    child.send({ type: 'start', options });
  });
}

if (process.argv[2] === '--film-worker') {
  process.once('message', async (message) => { if (message?.type !== 'start') process.exit(1); const report = await verify(message.options); process.send({ type: 'result', report }, () => process.exit(0)); });
} else if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  let prepared;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write('node verify_film.mjs --html video.html --narration narration.json --out-dir NEW_OR_EMPTY_DIR [--playwright-module PATH] [--timeout-ms 90000]\nChecks actual subtitle DOM, measured cue timing, film safe area, frame boundaries, and reverse seeking. Mathematical correctness is not assessed.\n');
    else { await outputDirectory(options); prepared = options; const report = await supervised(options); await writeFile(resolve(options.outDir, 'verify-film.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); process.stdout.write(JSON.stringify({ ok: report.ok, mathStatus: report.mathStatus, report: resolve(options.outDir, 'verify-film.json'), samples: report.samples.length, issues: report.issues }, null, 2) + '\n'); if (!report.ok) process.exitCode = 1; }
  } catch (error) { if (prepared) { const report = baseReport(prepared); addIssue(report, 'film_program_error', error.message); await writeFile(resolve(prepared.outDir, 'verify-film.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }).catch(() => {}); } process.stderr.write(`Film verification failed: ${safeError(error.message)}\n`); process.exitCode = 1; }
}
