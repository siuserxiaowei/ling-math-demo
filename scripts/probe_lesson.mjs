#!/usr/bin/env node
import { fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaywright } from './runtime.mjs';

const SELF = fileURLToPath(import.meta.url);
const HELP = `Probe a locally generated lesson without assuming its diagram structure.

node probe_lesson.mjs --html lesson.html --out-dir NEW_OR_EMPTY_DIR
  [--playwright-module PACKAGE_PATH] [--timeout-ms 60000]

Writes probe.json and desktop start.png/middle.png/end.png, plus 390x844
mobile.png. An optional detected ?video=1 mode also gets video.png.
Exit 0 means technically usable; exit 1 means a blocking issue or timeout.
Mathematical correctness is always reported as not_assessed.
No external model is called, no dependency is installed, and remote requests
from the lesson are blocked. No existing output files are overwritten.
`;

function scrub(value) {
  return String(value ?? '').slice(0, 3000)
    .replace(/(?:https?|wss?):\/\/[^\s<>"')]+/gi, (url) => {
      try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.hostname}/[redacted]`; }
      catch { return '[remote-url]'; }
    })
    .replace(/file:\/\/[^\s<>"')]+/gi, '[local-file]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted-key]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]+\.)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/\b(api[_-]?key|access[_-]?token|authorization|password|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\/(?:Users|home|private|tmp|var|opt|Volumes)\/[^\s<>"')]+/g, '[local-path]');
}

function issue(report, kind, message, blocking = true) {
  report.issues.push({ kind, message: scrub(message), blocking });
}

function emptyReport(inputName) {
  return {
    ok: false,
    mathStatus: 'not_assessed',
    input: inputName,
    duration: null,
    issues: [],
    screenshots: {},
    checks: {
      contract: { ok: false },
      desktop: { ok: false, viewport: { width: 1280, height: 900 } },
      determinism: { ok: false, method: 'PNG SHA-256, then isolated PNG pixel comparison on hash mismatch; no clock/random/CSS animation overrides', rasterNoiseThreshold: { maxChannelDelta: 1, changedPixelRatio: 0.0001 }, comparisons: [] },
      visibleMathText: { ok: true, method: 'visible rendered DOM text in numeric fractions/results; code examples excluded; Canvas text not assessed', canvasTextAssessed: false, findings: [] },
      mobile: { ok: false, viewport: { width: 390, height: 844 }, samples: [] },
      offline: { ok: true, blockedOrigins: [] },
      pageErrors: { ok: true, messages: [] },
      video: { available: null, ok: null },
    },
  };
}

function args(argv) {
  const options = { timeoutMs: 60000 };
  const flags = new Set(['html', 'out-dir', 'playwright-module', 'timeout-ms']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { options.help = true; continue; }
    if (!argv[i].startsWith('--') || !flags.has(argv[i].slice(2))) throw new Error(`Unknown argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = argv[++i];
  }
  if (options.help) return options;
  if (!options.html || !options['out-dir']) throw new Error('--html and --out-dir are required.');
  options.html = resolve(options.html);
  options.outDir = resolve(options['out-dir']);
  options.timeoutMs = Number(options['timeout-ms'] ?? options.timeoutMs);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 300000) throw new Error('--timeout-ms must be an integer between 1000 and 300000.');
  return options;
}

async function prepareDirectory(options) {
  if ([parse(options.outDir).root, resolve(homedir()), resolve(process.cwd()), dirname(options.html)].includes(options.outDir)) {
    throw new Error('--out-dir must be a dedicated new or empty subdirectory.');
  }
  const info = await lstat(options.outDir).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (info?.isSymbolicLink()) throw new Error('--out-dir must not be a symbolic link.');
  if (info && !info.isDirectory()) throw new Error('--out-dir must be a directory.');
  if (info && (await readdir(options.outDir)).length) throw new Error('--out-dir must be new or empty; no files will be overwritten.');
  await mkdir(options.outDir, { recursive: true });
  options.outDir = await realpath(options.outDir);
}

function pngHash(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function sleep(ms) { return new Promise((done) => setTimeout(done, ms)); }

async function runProbe(options) {
  const report = emptyReport(basename(options.html));
  const coreErrors = [];
  const coreOrigins = new Set();
  const coreLocalResources = { count: 0 };
  let browser;
  let comparisonContext;
  let comparisonPage;
  try {
    const info = await stat(options.html).catch(() => null);
    if (!info?.isFile() || !['.html', '.htm'].includes(extname(options.html).toLowerCase())) {
      issue(report, 'input_file', '--html must name an existing local HTML file.');
      return report;
    }
    const source = await readFile(options.html, 'utf8');
    const { chromium } = await loadPlaywright(options['playwright-module']);
    browser = await chromium.launch({ headless: true });
    // Register only this fresh browser's own process with the supervisor.
    // Chromium may have a process group separate from its Node launcher.
    const browserSession = await browser.newBrowserCDPSession();
    const processInfo = await browserSession.send('SystemInfo.getProcessInfo');
    const browserPid = processInfo.processInfo?.find((entry) => entry.type === 'browser')?.id;
    if (Number.isInteger(browserPid) && browserPid > 1 && process.send) process.send({ type: 'owned-browser', pid: browserPid });
    await browserSession.detach();

    async function makeContext(viewport, errors, origins, localResources) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'zh-CN', serviceWorkers: 'block', acceptDownloads: false });
      context.on('page', (page) => page.on('pageerror', (error) => { if (errors.length < 20) errors.push(scrub(error.message)); }));
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (/^(data:|blob:|about:)/i.test(url)) return route.continue();
        if (/^file:/i.test(url)) {
          try { if (resolve(fileURLToPath(url)) === options.html) return route.continue(); }
          catch {}
          localResources.count++;
          return route.abort('blockedbyclient');
        }
        try { const parsed = new URL(url); origins.add(`${parsed.protocol}//${parsed.hostname}`); }
        catch { origins.add('[remote-resource]'); }
        return route.abort('blockedbyclient');
      });
      if (typeof context.routeWebSocket === 'function') {
        await context.routeWebSocket(/^(?:ws|wss):/i, (socket) => {
          try { const parsed = new URL(socket.url()); origins.add(`${parsed.protocol}//${parsed.hostname}`); }
          catch { origins.add('[remote-websocket]'); }
          socket.close({ code: 1008, reason: 'Offline lesson probe' });
        });
      }
      return context;
    }

    async function navigate(page, video = false) {
      const url = pathToFileURL(options.html);
      if (video) url.searchParams.set('video', '1');
      page.setDefaultTimeout(5000);
      page.setDefaultNavigationTimeout(8000);
      await page.goto(url.href, { waitUntil: 'load' });
      await page.waitForFunction(() => window.lesson, undefined, { timeout: 2500 }).catch(() => {});
      await page.evaluate(async () => { await document.fonts.ready; });
    }

    async function contract(page) {
      const result = await page.evaluate(() => {
        const result = {
          present: !!window.lesson,
          duration: typeof window.lesson?.duration === 'number' && Number.isFinite(window.lesson.duration) && window.lesson.duration > 0 ? window.lesson.duration : null,
          setTimeFunction: typeof window.lesson?.setTime === 'function',
          inspectFunction: typeof window.lesson?.inspect === 'function',
          inspectSynchronous: false,
          inspectPlainObject: false,
          inspectError: null,
        };
        if (result.inspectFunction) {
          try {
            const value = window.lesson.inspect();
            result.inspectSynchronous = !(value && typeof value.then === 'function');
            if (result.inspectSynchronous && value !== null && typeof value === 'object') {
              const prototype = Object.getPrototypeOf(value);
              result.inspectPlainObject = prototype === Object.prototype || prototype === null;
            }
          } catch (error) { result.inspectError = String(error?.message ?? error); }
        }
        // Only the return type crosses this boundary. Model-reported values
        // are neither mathematical evidence nor part of the pass decision.
        return result;
      });
      if (result.inspectError) result.inspectError = scrub(result.inspectError);
      return result;
    }

    async function seek(page, time) {
      const result = await page.evaluate((seconds) => {
        const returned = window.lesson.setTime(seconds);
        return { synchronous: !(returned && typeof returned.then === 'function') };
      }, time);
      if (!result.synchronous) throw new Error('lesson.setTime returned a Promise; the time-seeking contract must finish synchronously.');
      const buffer = await page.screenshot({ type: 'png', fullPage: false, animations: 'allow', caret: 'hide', timeout: 5000 });
      return { buffer, hash: pngHash(buffer) };
    }

    async function compareFrames(time, sequence, reference, actual) {
      const record = { time, sequence, referenceSha256: reference.hash, actualSha256: actual.hash, rawHashEqual: reference.hash === actual.hash, equal: reference.hash === actual.hash, rasterNoise: false, pixelDiff: null };
      if (record.rawHashEqual) return record;
      if (!comparisonPage) {
        comparisonContext = await browser.newContext({ viewport: { width: 1, height: 1 }, serviceWorkers: 'block' });
        await comparisonContext.route('**/*', (route) => /^(about:|data:|blob:)/.test(route.request().url()) ? route.continue() : route.abort('blockedbyclient'));
        comparisonPage = await comparisonContext.newPage();
        await comparisonPage.goto('about:blank');
      }
      record.pixelDiff = await comparisonPage.evaluate(async ({ left, right }) => {
        const decode = async (encoded) => { const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode(); return image; };
        const [a, b] = await Promise.all([decode(left), decode(right)]);
        if (a.width !== b.width || a.height !== b.height) return { sameDimensions: false, referenceWidth: a.width, referenceHeight: a.height, actualWidth: b.width, actualHeight: b.height, changedPixels: null, changedPixelRatio: 1, maxChannelDelta: 255 };
        const canvas = document.createElement('canvas'); canvas.width = a.width; canvas.height = a.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(a, 0, 0); const pixelsA = context.getImageData(0, 0, a.width, a.height).data;
        context.clearRect(0, 0, a.width, a.height); context.drawImage(b, 0, 0); const pixelsB = context.getImageData(0, 0, b.width, b.height).data;
        let changedPixels = 0, maxChannelDelta = 0, minX = a.width, minY = a.height, maxX = -1, maxY = -1;
        for (let offset = 0; offset < pixelsA.length; offset += 4) {
          let changed = false;
          for (let channel = 0; channel < 4; channel++) { const delta = Math.abs(pixelsA[offset + channel] - pixelsB[offset + channel]); maxChannelDelta = Math.max(maxChannelDelta, delta); changed ||= delta > 0; }
          if (changed) { changedPixels++; const pixel = offset / 4, x = pixel % a.width, y = Math.floor(pixel / a.width); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
        }
        return { sameDimensions: true, width: a.width, height: a.height, totalPixels: a.width * a.height, changedPixels, changedPixelRatio: changedPixels / (a.width * a.height), maxChannelDelta, boundingBox: changedPixels ? [minX, minY, maxX + 1, maxY + 1] : null };
      }, { left: reference.buffer.toString('base64'), right: actual.buffer.toString('base64') });
      record.rasterNoise = record.pixelDiff.sameDimensions && record.pixelDiff.maxChannelDelta <= 1 && record.pixelDiff.changedPixelRatio <= 0.0001;
      record.equal = record.rasterNoise;
      return record;
    }

    async function scanVisibleMathText(page, time, mode) {
      const found = await page.evaluate(() => {
        const matches = [];
        const theme = document.title + ' ' + [...document.querySelectorAll('h1,h2')].slice(0, 3).map((element) => element.textContent).join(' ');
        const terminologyTheme = /JavaScript|ECMAScript|\bJS\b|typeof|Number\.isNaN/i.test(theme);
        const numericFraction = /\d+(?:\.\d+)?\s*[/⁄÷]\s*(?:undefined|NaN)\b/i;
        const nanResult = /(?:\d[\d\s.,/⁄()+\-−×*÷π²³^]*|商|结果|面积|体积|长度|和|差|积)\s*[=≈]\s*NaN\b/i;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!/\b(?:undefined|NaN)\b/.test(node.textContent || '')) continue;
          const parent = node.parentElement;
          if (!parent || parent.closest('script,style,noscript,template,code,pre,kbd,samp,textarea,[contenteditable="true"]')) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          let visible = false;
          for (const rectangle of range.getClientRects()) {
            let left = Math.max(0, rectangle.left), top = Math.max(0, rectangle.top), right = Math.min(innerWidth, rectangle.right), bottom = Math.min(innerHeight, rectangle.bottom);
            if (right <= left || bottom <= top) continue;
            let hidden = false;
            for (let element = parent; element; element = element.parentElement) {
              const style = getComputedStyle(element);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') { hidden = true; break; }
              const bounds = element.getBoundingClientRect();
              if (/hidden|clip|scroll|auto/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
              if (/hidden|clip|scroll|auto/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
            }
            if (!hidden && right > left && bottom > top) { visible = true; break; }
          }
          if (!visible) continue;
          let element = parent.closest('text,math') || parent;
          for (let depth = 0; element && depth < 3; depth++, element = element.parentElement) {
            const text = (element.textContent || '').trim();
            if (!text || text.length > 500 || element === document.body) break;
            const pattern = numericFraction.test(text) ? 'numeric_denominator' : nanResult.test(text) ? 'nonfinite_numeric_result' : null;
            if (pattern) {
              const terminologyContext = terminologyTheme || /JavaScript|ECMAScript|typeof|Number\.isNaN|Number\.NaN|\b(?:const|let|var)\s+\w+/i.test(text);
              matches.push({ pattern, text: text.slice(0, 240), tag: element.tagName, blocking: !terminologyContext });
              break;
            }
          }
          if (matches.length >= 20) break;
        }
        return matches;
      });
      for (const finding of found) {
        const safe = { time, mode, ...finding, text: scrub(finding.text) };
        if (!report.checks.visibleMathText.findings.some((item) => item.time === safe.time && item.mode === safe.mode && item.text === safe.text)) report.checks.visibleMathText.findings.push(safe);
      }
    }

    async function layout(page) {
      return page.evaluate(() => {
        const root = document.documentElement;
        const body = document.body;
        const width = Math.max(root?.scrollWidth || 0, body?.scrollWidth || 0);
        const height = Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0);
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        return {
          viewport: { width: innerWidth, height: innerHeight }, scrollWidth: width, scrollHeight: height,
          horizontalOverflowPx: Math.max(0, width - innerWidth), verticalOverflowPx: Math.max(0, height - innerHeight),
          visibleSvgCount: [...document.querySelectorAll('svg')].filter(visible).length,
          visibleCanvasCount: [...document.querySelectorAll('canvas')].filter(visible).length,
          visibleControls: [...document.querySelectorAll('button,input,select,textarea')].filter(visible).length,
          hasVisibleContent: !!body && ((body.innerText || '').trim().length > 0 || [...document.querySelectorAll('svg,canvas')].some(visible)),
        };
      });
    }

    const desktopContext = await makeContext({ width: 1280, height: 900 }, coreErrors, coreOrigins, coreLocalResources);
    const page = await desktopContext.newPage();
    await navigate(page);
    const found = await contract(page);
    report.duration = found.duration;
    report.checks.contract = { ...found, setTimeSynchronous: false, ok: false };
    if (!found.present) issue(report, 'lesson_contract_missing', 'Expose window.lesson with duration, setTime(seconds), and inspect().');
    if (found.present && found.duration === null) issue(report, 'lesson_duration_invalid', 'window.lesson.duration must be a positive finite number of seconds.');
    if (!found.setTimeFunction) issue(report, 'lesson_settime_missing', 'Expose a synchronous window.lesson.setTime(seconds) function.');
    if (!found.inspectFunction) issue(report, 'lesson_inspect_missing', 'Expose a synchronous window.lesson.inspect() function returning a non-null plain object.');
    else if (found.inspectError) issue(report, 'lesson_inspect_failed', found.inspectError);
    else if (!found.inspectSynchronous) issue(report, 'lesson_inspect_async', 'window.lesson.inspect() must return its object synchronously, not a Promise.');
    else if (!found.inspectPlainObject) issue(report, 'lesson_inspect_return_invalid', 'window.lesson.inspect() must return a non-null plain object, not an array, class instance, or primitive.');

    if (found.duration !== null && found.setTimeFunction) {
      const times = [0, found.duration * 0.45, found.duration * 0.98];
      const names = ['start', 'middle', 'end'];
      const references = new Map();
      const referenceFrames = new Map();
      let seekFailed = false;
      try {
        for (let i = 0; i < times.length; i++) {
          const result = await seek(page, times[i]);
          references.set(times[i], result.hash);
          referenceFrames.set(times[i], result);
          await scanVisibleMathText(page, times[i], 'desktop');
          await writeFile(resolve(options.outDir, `${names[i]}.png`), result.buffer, { flag: 'wx' });
          report.screenshots[names[i]] = `${names[i]}.png`;
        }
        report.checks.contract.setTimeSynchronous = true;
        report.checks.contract.ok = found.inspectFunction && found.inspectSynchronous && found.inspectPlainObject && !found.inspectError;
        report.checks.desktop = { ok: true, ...(await layout(page)), sampleTimes: times, hashes: Object.fromEntries(names.map((name, i) => [name, references.get(times[i])])) };
        for (const i of [1, 0, 2]) {
          const result = await seek(page, times[i]);
          report.checks.determinism.comparisons.push(await compareFrames(times[i], 'reverse-and-forward-seek', referenceFrames.get(times[i]), result));
        }
        const beforeDelay = await seek(page, times[1]);
        await sleep(1100);
        const afterDelay = await seek(page, times[1]);
        report.checks.determinism.comparisons.push(await compareFrames(times[1], 'same-time-after-1100ms-wall-clock-delay', beforeDelay, afterDelay));
        report.checks.determinism.rawHashesEqual = report.checks.determinism.comparisons.every((comparison) => comparison.rawHashEqual);
        report.checks.determinism.ok = report.checks.determinism.comparisons.every((comparison) => comparison.equal);
        if (report.checks.determinism.comparisons.some((comparison) => comparison.rasterNoise)) issue(report, 'lesson_raster_noise', 'Raw PNG hashes differed, but decoded differences stayed within the recorded 1-channel-level / 0.01% raster-noise limit. Raw hashes and pixel statistics were retained.', false);
        if (!report.checks.determinism.ok) issue(report, 'lesson_nondeterministic', 'The same setTime value produced different viewport pixels after revisiting time or waiting. Remove wall-clock/random-state dependence from rendering.');
        report.checks.desktop.timelineChanges = new Set(references.values()).size > 1;
        if (!report.checks.desktop.timelineChanges) issue(report, 'lesson_timeline_static', 'The 0%, 45%, and 98% frames were identical; verify that setTime actually drives the lesson.');
        if (!report.checks.desktop.hasVisibleContent) issue(report, 'lesson_empty', 'No visible text, SVG, or Canvas content was found.');
      } catch (error) {
        seekFailed = true;
        issue(report, /Promise|synchronously/.test(error.message) ? 'lesson_settime_async' : 'lesson_settime_failed', error.message);
      }

      if (!seekFailed) {
        await page.setViewportSize({ width: 390, height: 844 });
        for (let i = 0; i < times.length; i++) {
          const result = await seek(page, times[i]);
          await scanVisibleMathText(page, times[i], 'mobile');
          const size = await layout(page);
          report.checks.mobile.samples.push({ time: times[i], ...size });
          if (i === 1) {
            await writeFile(resolve(options.outDir, 'mobile.png'), result.buffer, { flag: 'wx' });
            report.screenshots.mobile = 'mobile.png';
          }
        }
        report.checks.mobile.ok = report.checks.mobile.samples.every((sample) => sample.horizontalOverflowPx <= 1);
        if (!report.checks.mobile.ok) issue(report, 'mobile_horizontal_overflow', 'The lesson extends horizontally beyond a 390px phone viewport. Fix responsive layout; this is a layout issue, not a mathematical result.');

        // Compare the ordinary and ?video=1 pages at the same viewport. No
        // diagram IDs, element types, colors, or topic-specific APIs are used.
        await page.setViewportSize({ width: 1080, height: 1920 });
        const normalPortrait = await seek(page, times[1]);
        const normalLayout = await layout(page);
        const videoErrors = [];
        const videoOrigins = new Set();
        const videoLocalResources = { count: 0 };
        let videoContext;
        try {
          videoContext = await makeContext({ width: 1080, height: 1920 }, videoErrors, videoOrigins, videoLocalResources);
          const videoPage = await videoContext.newPage();
          await navigate(videoPage, true);
          const videoContract = await contract(videoPage);
          if (videoContract.duration === null || !videoContract.setTimeFunction || !videoContract.inspectFunction || !videoContract.inspectSynchronous || !videoContract.inspectPlainObject || videoContract.inspectError) {
            report.checks.video = { available: false, ok: null, contract: videoContract };
            issue(report, 'video_mode_contract_unavailable', 'The optional ?video=1 page has no usable timeline contract. The ordinary interactive lesson can still pass.', false);
          } else {
            const result = await seek(videoPage, times[1]);
            const size = await layout(videoPage);
            const imageDiffers = result.hash !== normalPortrait.hash;
            const mentionsQuery = /video/.test(source) && /URLSearchParams|location\.search|searchParams/.test(source);
            const fewerControls = size.visibleControls < normalLayout.visibleControls;
            const detected = imageDiffers && (mentionsQuery || fewerControls);
            report.checks.video = { available: detected, ok: detected ? size.horizontalOverflowPx <= 1 && size.verticalOverflowPx <= 1 && !videoErrors.length && !videoOrigins.size && !videoLocalResources.count : null,
              detectionMethod: 'same-viewport PNG difference plus query handling or fewer visible controls', imageDiffers, sourceMentionsVideoQuery: mentionsQuery, fewerControls,
              ...size, contract: videoContract, pageErrors: videoErrors, blockedOrigins: [...videoOrigins], blockedLocalResources: videoLocalResources.count };
            if (detected) {
              await writeFile(resolve(options.outDir, 'video.png'), result.buffer, { flag: 'wx' });
              report.screenshots.video = 'video.png';
              if (size.horizontalOverflowPx > 1 || size.verticalOverflowPx > 1) issue(report, 'video_viewport_overflow', 'The optional video mode does not fit the 1080x1920 frame. Repair its video layout before export.', false);
              if (videoErrors.length) issue(report, 'video_page_error', videoErrors.join('; '), false);
              if (videoOrigins.size) issue(report, 'video_external_resource', 'The optional video page requested remote resources; bundle them locally before video export.', false);
              if (videoLocalResources.count) issue(report, 'video_local_resource', 'The optional video page requested another local file. The single-file contract requires inline assets.', false);
            } else issue(report, 'video_mode_not_detected', 'No distinct ?video=1 presentation was detected. This does not invalidate an interactive lesson.', false);
          }
        } catch (error) {
          report.checks.video = { available: false, ok: null, error: scrub(error.message) };
          issue(report, 'video_mode_probe_failed', `Optional video-mode probe failed: ${error.message}`, false);
        } finally { if (videoContext) await videoContext.close().catch(() => {}); }
      }
    } else {
      const buffer = await page.screenshot({ type: 'png', animations: 'allow', caret: 'hide', timeout: 5000 });
      await writeFile(resolve(options.outDir, 'start.png'), buffer, { flag: 'wx' });
      report.screenshots.start = 'start.png';
    }
  } catch (error) {
    issue(report, 'probe_runtime_error', error.message);
  } finally {
    report.checks.visibleMathText.ok = !report.checks.visibleMathText.findings.some((finding) => finding.blocking);
    if (!report.checks.visibleMathText.ok) issue(report, 'visible_math_placeholder', 'Visible numeric fractions or results contain undefined/NaN. Repair the displayed content; this check does not prove mathematical correctness.');
    if (report.checks.visibleMathText.findings.some((finding) => !finding.blocking)) issue(report, 'visible_math_text_risk', 'Potential undefined/NaN arithmetic text appears in a terminology explanation; review it in context. It was not treated as a mathematical failure.', false);
    report.checks.pageErrors = { ok: !coreErrors.length, messages: coreErrors };
    report.checks.offline = { ok: !coreOrigins.size && !coreLocalResources.count, blockedOrigins: [...coreOrigins], blockedLocalResources: coreLocalResources.count };
    if (coreErrors.length) issue(report, 'lesson_page_error', coreErrors.join('; '));
    if (coreOrigins.size) issue(report, 'lesson_external_resource', 'The interactive lesson requested remote resources. Its dependencies must be available offline.');
    if (coreLocalResources.count) issue(report, 'lesson_local_resource', 'The lesson requested another local file. Only its own HTML document and embedded data/blob resources are permitted; inline the required asset.');
    if (comparisonContext) await comparisonContext.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
  report.ok = !report.issues.some((entry) => entry.blocking);
  return report;
}

async function stopGroup(child, signal) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((done) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', done); killer.once('close', done);
    });
  } else {
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      try { process.kill(child.pid, signal); }
      catch (inner) { if (inner.code !== 'ESRCH') throw inner; }
    }
  }
}

async function supervisedProbe(options) {
  const fallback = emptyReport(basename(options.html));
  fallback.checks.supervision = { totalTimeoutMs: options.timeoutMs, isolatedWorker: true };
  const child = fork(SELF, ['--probe-worker'], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.resume();
  // Worker stderr is intentionally not copied into the report: generated
  // source or dependency errors can contain unredacted local paths/secrets.
  child.stderr.resume();
  let finished = false;
  const ownedBrowsers = new Set();
  return new Promise((done) => {
    const timer = setTimeout(async () => {
      if (finished) return;
      finished = true;
      issue(fallback, 'probe_timeout', `The local lesson probe exceeded its ${options.timeoutMs}ms deadline. A script may be stuck; its isolated browser process group was terminated.`);
      for (const pid of ownedBrowsers) await stopGroup({ pid }, 'SIGTERM').catch(() => {});
      await stopGroup(child, 'SIGTERM').catch(() => {});
      await sleep(250);
      for (const pid of ownedBrowsers) await stopGroup({ pid }, 'SIGKILL').catch(() => {});
      await stopGroup(child, 'SIGKILL').catch(() => {});
      fallback.checks.supervision.ownedBrowserProcesses = ownedBrowsers.size;
      for (const name of ['start', 'middle', 'end', 'mobile', 'video']) {
        if (await stat(resolve(options.outDir, `${name}.png`)).then((s) => s.isFile()).catch(() => false)) fallback.screenshots[name] = `${name}.png`;
      }
      done(fallback);
    }, options.timeoutMs);
    child.once('error', (error) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      issue(fallback, 'probe_worker_error', error.message); done(fallback);
    });
    child.on('message', (message) => {
      if (message?.type === 'owned-browser' && Number.isInteger(message.pid) && message.pid > 1 && message.pid !== child.pid && message.pid !== process.pid) {
        ownedBrowsers.add(message.pid);
        return;
      }
      if (finished || message?.type !== 'result') return;
      finished = true; clearTimeout(timer);
      message.report.checks.supervision = { totalTimeoutMs: options.timeoutMs, isolatedWorker: true, ownedBrowserProcesses: ownedBrowsers.size };
      done(message.report);
    });
    child.once('exit', (code, signal) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      issue(fallback, 'probe_worker_exit', `Probe worker exited before reporting (${signal || code}).`); done(fallback);
    });
    child.send({ type: 'start', options });
  });
}

if (process.argv[2] === '--probe-worker') {
  process.once('message', async (message) => {
    if (message?.type !== 'start') process.exit(1);
    const report = await runProbe(message.options).catch((error) => {
      const failed = emptyReport(basename(message.options.html));
      issue(failed, 'probe_runtime_error', error.message); return failed;
    });
    process.send({ type: 'result', report }, () => process.exit(0));
  });
} else if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  let safeOptions;
  try {
    const options = args(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else {
      await prepareDirectory(options);
      safeOptions = options;
      const report = await supervisedProbe(options);
      await writeFile(resolve(options.outDir, 'probe.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      process.stdout.write(JSON.stringify({ ok: report.ok, mathStatus: report.mathStatus, report: resolve(options.outDir, 'probe.json'), issues: report.issues }, null, 2) + '\n');
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) {
    if (safeOptions) {
      const failed = emptyReport(basename(safeOptions.html));
      issue(failed, 'probe_program_error', error.message);
      await writeFile(resolve(safeOptions.outDir, 'probe.json'), JSON.stringify(failed, null, 2) + '\n', { flag: 'wx' }).catch(() => {});
      process.stderr.write(`Probe failed; a diagnostic report was attempted in the validated output directory: ${scrub(error.message)}\n`);
    } else process.stderr.write(`Probe failed before a safe report could be written: ${scrub(error.message)}\n`);
    process.exitCode = 1;
  }
}
