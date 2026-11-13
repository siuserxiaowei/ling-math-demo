#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadPlaywright } from './runtime.mjs';
import {
  SUPPORTED_N,
  convexIntersectionArea,
  polygonArea,
  relativeError,
  rigidMatrixDiagnostics,
} from './math-oracle.mjs';

const CATEGORIES = Object.freeze({ geometry: 'geometry', dom: 'dom', media: 'mediaTechnology' });
const DEFAULT_SAMPLES = 12;
const GEOMETRY_AREA_TOLERANCE = 3e-4;
// SVGPathElement.getPointAtLength() is implemented with float-like geometry
// internally.  A fixed area threshold therefore becomes too strict as r grows;
// compare overlap against a small, scale-aware fraction of r² instead.
const OVERLAP_RELATIVE_TO_RADIUS_SQUARED = 1e-8;

const HELP = `Usage:
  node verify_lesson.mjs --html path --out report.json [--playwright-module path] [--screenshots-dir path]

The verifier opens the local lesson in a fresh headless Chromium context, blocks
non-local requests, jumps through window.lesson.setTime(), and writes a JSON
report. It does not assess educational effectiveness or human listening quality.
`;

function parseFlagValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
  return value;
}

export function parseArgs(argv) {
  const options = { html: null, out: null, playwrightModule: null, screenshotsDir: null, help: false };
  const flags = new Set(['html', 'out', 'playwright-module', 'screenshots-dir']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (!token.startsWith('--') || !flags.has(token.slice(2))) {
      throw new Error(`Unknown argument: ${token}`);
    }
    const name = token.slice(2);
    const value = parseFlagValue(argv, i, name);
    i += 1;
    if (name === 'playwright-module') options.playwrightModule = resolve(value);
    else if (name === 'screenshots-dir') options.screenshotsDir = resolve(value);
    else options[name] = resolve(value);
  }
  if (options.help) return options;
  if (!options.html || !options.out) throw new Error('--html and --out are required.');
  if (!['.html', '.htm'].includes(extname(options.html).toLowerCase())) {
    throw new Error('--html must name an HTML file.');
  }
  if (extname(options.out).toLowerCase() !== '.json') throw new Error('--out must use the .json extension.');
  return options;
}

async function isFile(filePath) {
  const info = await stat(filePath).catch(() => null);
  return Boolean(info?.isFile());
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function makeReport(options) {
  return {
    schemaVersion: 1,
    ok: false,
    input: { html: options.html },
    lesson: { topic: null, duration: null },
    checks: {
      geometry: { status: 'not-run', results: [] },
      dom: { status: 'not-run', results: [] },
      mediaTechnology: { status: 'not-run', results: [] },
    },
    errors: [],
    warnings: [],
    evidence: { randomTimes: [], screenshots: [] },
    limitations: [
      'This report checks rendering, geometry, DOM determinism, responsive bounds, and media technical constraints.',
      'It does not establish educational effectiveness, factual completeness beyond the encoded geometry checks, or human listening quality.',
    ],
  };
}

function addResult(report, category, name, status, details = {}) {
  const group = report.checks[category];
  group.results.push({ name, status, ...details });
  if (status === 'failed') group.status = 'failed';
  else if (group.status === 'not-run') group.status = 'passed';
}

function addError(report, category, name, error, details = {}) {
  const message = errorMessage(error);
  addResult(report, category, name, 'failed', { message, ...details });
  report.errors.push({ category, name, message, ...details });
}

async function runCheck(report, category, name, fn) {
  try {
    const details = await fn();
    addResult(report, category, name, 'passed', details || {});
    return { ok: true, details };
  } catch (error) {
    addError(report, category, name, error);
    return { ok: false, error };
  }
}

function makeLocalFileUrl(filePath, video) {
  const url = pathToFileURL(filePath);
  if (video) url.searchParams.set('video', '1');
  return url.href;
}

async function openTrackedPage(browser, htmlPath, { width, height, video = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const tracker = { pageErrors: [], remoteRequests: [] };
  page.on('pageerror', (error) => tracker.pageErrors.push(errorMessage(error)));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/^(file:|data:|blob:|about:)/.test(url)) return route.continue();
    tracker.remoteRequests.push(url);
    return route.abort('blockedbyclient');
  });
  await page.goto(makeLocalFileUrl(htmlPath, video), { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.lesson && typeof window.lesson.setTime === 'function' && Number.isFinite(window.lesson.duration),
    undefined,
    { timeout: 10000 },
  );
  await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
  return { context, page, tracker };
}

async function readLessonMeta(page) {
  return page.evaluate(() => {
    const raw = document.querySelector('#lessonConfig')?.textContent || '{}';
    let config;
    try { config = JSON.parse(raw); } catch (error) { throw new Error(`Invalid #lessonConfig JSON: ${error.message}`); }
    return {
      config,
      topic: config.topic || null,
      duration: Number(window.lesson.duration),
    };
  });
}

function deterministicTimes(duration, count = DEFAULT_SAMPLES) {
  const values = [0, duration, duration * 0.17, duration * 0.37, duration * 0.61, duration * 0.83];
  let state = 0x9e3779b9;
  while (values.length < count) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values.push(duration * (state / 0x100000000));
  }
  return [...new Set(values.map((value) => Number(value.toFixed(6))))].sort((a, b) => a - b);
}

async function setLessonTime(page, seconds) {
  await page.evaluate((time) => {
    const result = window.lesson.setTime(time);
    if (result && typeof result.then === 'function') return result;
    return undefined;
  }, seconds);
}

async function domSignature(page, selector) {
  return page.evaluate((query) => document.querySelector(query)?.outerHTML || '', selector);
}

async function checkTimeDeterminism(page, duration, selector, report, label) {
  const times = deterministicTimes(duration);
  const mismatches = [];
  for (let i = 0; i < times.length; i += 1) {
    const time = times[i];
    await setLessonTime(page, time);
    const forward = await domSignature(page, selector);
    const detour = times[(i + 3) % times.length];
    await setLessonTime(page, detour);
    await setLessonTime(page, time);
    const reverse = await domSignature(page, selector);
    if (forward !== reverse) mismatches.push({ time, detour, forward: hashText(forward), reverse: hashText(reverse) });
  }
  report.evidence.randomTimes.push({ label, times });
  if (mismatches.length) throw new Error(`${label}: same-time forward/reverse DOM differs at ${mismatches.length} sample(s).`);
  return { sampleCount: times.length, selector, mismatches: 0 };
}

function matrixArray(matrix) {
  return [[matrix.a, matrix.c, matrix.e], [matrix.b, matrix.d, matrix.f], [0, 0, 1]];
}

function pointDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function localPointToWorld(point, matrix) {
  return [matrix.a * point[0] + matrix.c * point[1] + matrix.e, matrix.b * point[0] + matrix.d * point[1] + matrix.f];
}

function maxDistanceFromLine(points, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = Math.hypot(dx, dy) || 1;
  return Math.max(...points.map((point) => Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) / denominator));
}

function extractCircleAnalysis(snapshot, expectedN) {
  const n = Number(snapshot.inspect?.n);
  const radius = Number(snapshot.inspect?.radius);
  if (!Number.isInteger(n) || n !== expectedN) throw new Error(`inspect().n is ${snapshot.inspect?.n}; expected ${expectedN}.`);
  if (!Number.isFinite(radius) || radius <= 0) throw new Error(`inspect().radius is not a positive finite number: ${snapshot.inspect?.radius}`);
  if (snapshot.sectors.length !== expectedN) throw new Error(`SVG [data-sector] count is ${snapshot.sectors.length}; expected ${expectedN}.`);
  const ids = snapshot.sectors.map((sector) => Number(sector.id));
  if (new Set(ids).size !== expectedN || ids.some((id) => !Number.isInteger(id) || id < 0 || id >= expectedN)) {
    throw new Error('SVG [data-sector] ids are not a unique 0..n-1 set.');
  }

  const expectedArcLength = radius * 2 * Math.PI / expectedN;
  const expectedSectorArea = Math.PI * radius * radius / expectedN;
  const sectorAnalyses = snapshot.sectors.map((sector) => {
    if (!sector.matrix) throw new Error(`sector ${sector.id} has no transform.baseVal matrix.`);
    const matrix = matrixArray(sector.matrix);
    const rigid = rigidMatrixDiagnostics(matrix);
    if (!rigid.isRigid) throw new Error(`sector ${sector.id} transform is not a proper rigid matrix.`);
    if (sector.contour.length < 32) throw new Error(`sector ${sector.id} contour sampling is too sparse.`);
    const worldContour = sector.contour.map((point) => localPointToWorld(point, sector.matrix));
    const area = polygonArea(worldContour);
    const radialStart = sector.radialPoints[0];
    const radialEnd = sector.radialPoints.at(-1);
    const radialLength = pointDistance(radialStart, radialEnd);
    const radialLineError = maxDistanceFromLine(sector.radialPoints, radialStart, radialEnd);
    const arcRadiusErrors = sector.arcPoints.map((point) => Math.abs(Math.hypot(point[0], point[1]) - radius));
    const arcEnd = sector.arcPoints.at(-1);
    const arcChord = pointDistance(sector.arcPoints[0], arcEnd);
    const pathLengthError = relativeError(sector.totalLength, 2 * radius + expectedArcLength);
    if (relativeError(radialLength, radius) > 2e-3) throw new Error(`sector ${sector.id} radial path is not radius r.`);
    if (radialLineError > radius * 2e-4) throw new Error(`sector ${sector.id} radial segment is not straight.`);
    if (Math.max(...arcRadiusErrors) > radius * 2e-3) throw new Error(`sector ${sector.id} arc radius differs from inspect().radius.`);
    if (pathLengthError > 3e-3) throw new Error(`sector ${sector.id} path length does not match 2r + r·2π/n.`);
    const expectedChord = 2 * radius * Math.sin(Math.PI / expectedN);
    if (relativeError(arcChord, expectedChord) > 4e-3) throw new Error(`sector ${sector.id} arc chord does not match n and r.`);
    if (relativeError(area, expectedSectorArea) > GEOMETRY_AREA_TOLERANCE) throw new Error(`sector ${sector.id} SVG-sampled area differs from πr²/n.`);
    return { id: Number(sector.id), area, radialLength, radialLineError, maxArcRadiusError: Math.max(...arcRadiusErrors), pathLengthError, arcChord, rigid };
  });

  const polygons = snapshot.sectors.map((sector) => sector.contour.map((point) => localPointToWorld(point, sector.matrix)));
  let maxOverlap = 0;
  for (let i = 0; i < polygons.length; i += 1) {
    for (let j = i + 1; j < polygons.length; j += 1) {
      maxOverlap = Math.max(maxOverlap, convexIntersectionArea(polygons[i], polygons[j]));
    }
  }
  const totalActualArea = sectorAnalyses.reduce((sum, sector) => sum + sector.area, 0);
  const expectedCircleArea = Math.PI * radius * radius;
  if (relativeError(totalActualArea, expectedCircleArea) > GEOMETRY_AREA_TOLERANCE) throw new Error('SVG-sampled total area differs from πr².');
  const overlapTolerance = Math.max(1e-12, OVERLAP_RELATIVE_TO_RADIUS_SQUARED * radius * radius);
  const maxPairwiseOverlapRelative = maxOverlap / expectedCircleArea;
  if (maxOverlap > overlapTolerance) {
    throw new Error(`final SVG sectors overlap with positive area (${maxOverlap}; relative to πr² ${maxPairwiseOverlapRelative}).`);
  }
  return {
    n: expectedN,
    radius,
    sectorCount: snapshot.sectors.length,
    expectedSectorArea,
    expectedCircleArea,
    sampledSectorAreas: sectorAnalyses.map((sector) => sector.area),
    sampledTotalArea: totalActualArea,
    totalAreaRelativeError: relativeError(totalActualArea, expectedCircleArea),
    maxPairwiseOverlapArea: maxOverlap,
    overlapTolerance,
    maxPairwiseOverlapRelative,
    sectors: sectorAnalyses,
    areaSource: 'SVGPathElement.getPointAtLength contour samples; inspect().area is not used as evidence',
  };
}

async function readCircleSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#diagramContent');
    const inspect = typeof window.lesson.inspect === 'function' ? window.lesson.inspect() : null;
    if (!root) throw new Error('Missing #diagramContent.');
    const paths = [...root.querySelectorAll('[data-sector]')];
    const radius = Number(inspect?.radius);
    const n = Number(inspect?.n);
    return {
      inspect,
      sectors: paths.map((path) => {
        const totalLength = path.getTotalLength();
        const matrix = path.transform.baseVal.consolidate()?.matrix || null;
        const radialEndLength = Math.min(Number.isFinite(radius) ? radius : 0, totalLength);
        const arcEndLength = Math.min(Number.isFinite(radius) && Number.isFinite(n) ? radius + radius * 2 * Math.PI / n : totalLength, totalLength);
        const at = (length) => { const point = path.getPointAtLength(Math.max(0, Math.min(totalLength, length))); return [point.x, point.y]; };
        const contour = Array.from({ length: 257 }, (_, index) => at(totalLength * index / 256));
        const radialPoints = Number.isFinite(radius)
          ? Array.from({ length: 25 }, (_, index) => at(radius * index / 24))
          : contour.slice(0, 25);
        const expectedArc = Number.isFinite(radius) && Number.isFinite(n) ? radius * 2 * Math.PI / n : 0;
        const arcPoints = Number.isFinite(radius)
          ? Array.from({ length: 129 }, (_, index) => at(radius + expectedArc * index / 128))
          : contour.slice(0, 129);
        return {
          id: path.getAttribute('data-sector'),
          totalLength,
          matrix: matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : null,
          contour,
          radialPoints,
          arcPoints,
        };
      }),
    };
  });
}

async function forceCircleN(page, n, duration) {
  const seconds = Math.min(duration, Math.max(0, duration * 0.87));
  return page.evaluate(({ requestedN, time }) => {
    if (typeof window.lesson.setParts === 'function') window.lesson.setParts(requestedN);
    window.lesson.setTime(time);
    const selector = document.querySelector('#parts');
    const selectedValue = selector?.value ?? null;
    if (selector && selectedValue !== String(requestedN)) {
      throw new Error(`setParts(${requestedN}) left #parts.value=${selectedValue}.`);
    }
    return { selectedValue };
  }, { requestedN: n, time: seconds });
}

function colorName(value) {
  const normalized = String(value || '').toLowerCase().replaceAll(' ', '');
  if (normalized === '#168b89' || normalized === 'rgb(22,139,137)') return 'blue';
  if (normalized === '#f39764' || normalized === 'rgb(243,151,100)') return 'orange';
  return normalized;
}

function fractionString(numerator, denominator) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
  const divisor = gcd(numerator, denominator) || 1;
  const n = numerator / divisor;
  const d = denominator / divisor;
  return d === 1 ? String(n) : `${n}/${d}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readFractionSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#diagramContent');
    if (!root) throw new Error('Missing #diagramContent.');
    const rects = [...root.querySelectorAll('rect')].map((rect) => {
      const box = rect.getBBox();
      const computed = getComputedStyle(rect).fill;
      return { fill: rect.getAttribute('fill') || computed, computedFill: computed, x: box.x, y: box.y, width: box.width, height: box.height };
    });
    return {
      inspect: typeof window.lesson.inspect === 'function' ? window.lesson.inspect() : null,
      rects,
      text: root.textContent || '',
      formula: document.querySelector('#formula')?.textContent || '',
    };
  });
}

function analyzeFractionSnapshot(snapshot, values) {
  const [a, b, c, d] = values;
  const expectedNumerator = a * d;
  const expectedDenominator = b * c;
  const expected = expectedNumerator / expectedDenominator;
  const expectedDisplay = fractionString(expectedNumerator, expectedDenominator);
  const blue = snapshot.rects.find((rect) => colorName(rect.fill) === 'blue' || colorName(rect.computedFill) === 'blue');
  const orange = snapshot.rects.find((rect) => colorName(rect.fill) === 'orange' || colorName(rect.computedFill) === 'orange');
  if (!blue || !orange || blue.width <= 0 || orange.width <= 0) throw new Error('Could not find positive-width blue dividend and orange divisor bars.');
  const widthRatio = blue.width / orange.width;
  if (relativeError(widthRatio, expected) > 1e-6) throw new Error(`bar width ratio ${widthRatio} does not equal ${expected}.`);
  const visibleResult = new RegExp(`能装下\\s*${escapeRegExp(expectedDisplay)}\\s*组`).test(snapshot.text)
    || new RegExp(`=\\s*${escapeRegExp(expectedDisplay)}(?:\\s|$)`).test(snapshot.formula);
  if (!visibleResult) throw new Error(`displayed result does not contain ${expectedDisplay}.`);
  return {
    dividend: [a, b],
    divisor: [c, d],
    expected: expectedDisplay,
    blueWidth: blue.width,
    orangeWidth: orange.width,
    measuredWidthRatio: widthRatio,
    displayVerified: true,
    evidence: 'actual SVG rect.getBBox() widths plus visible result text; inspect().quotient is not used as evidence',
  };
}

async function checkControlBounds(page, width, height, label) {
  await page.setViewportSize({ width, height });
  const result = await page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const selectors = ['.controls', '.controls button', '.controls label', '.controls input', '.controls select'];
    const elements = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    }).map((element) => {
      const box = element.getBoundingClientRect();
      return { selector: element.tagName.toLowerCase(), text: element.textContent?.trim().slice(0, 40) || '', left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    });
    const buttons = [...document.querySelectorAll('.controls button')].filter((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    });
    const scrollYBefore = window.scrollY;
    const reachableButtons = buttons.map((element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const box = element.getBoundingClientRect();
      return {
        text: element.textContent?.trim().slice(0, 40) || '',
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        reachable: box.left >= -1 && box.right <= window.innerWidth + 1 && box.top >= -1 && box.bottom <= window.innerHeight + 1,
      };
    });
    window.scrollTo(0, scrollYBefore);
    return { viewport, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, elements, reachableButtons };
  });
  const horizontalOut = result.elements.filter((box) => box.left < -1 || box.right > width + 1);
  const unreachableButtons = result.reachableButtons.filter((button) => !button.reachable);
  if (result.scrollWidth > width + 1 || horizontalOut.length || unreachableButtons.length) {
    throw new Error(`${label}: interactive controls overflow horizontally or cannot be reached after scrollIntoView.`);
  }
  return {
    viewport: result.viewport,
    scrollWidth: result.scrollWidth,
    scrollHeight: result.scrollHeight,
    elementsChecked: result.elements.length,
    buttonsChecked: result.reachableButtons.length,
    buttonsReachable: result.reachableButtons.length - unreachableButtons.length,
    verticalScrollingAllowed: result.scrollHeight > height + 1,
  };
}

async function captureScreenshot(page, directory, label, report) {
  if (!directory) return null;
  await mkdir(directory, { recursive: true });
  const buffer = await page.screenshot({ type: 'png' });
  const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '_');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt ? `-${attempt}` : '';
    const target = resolve(directory, `${safe}${suffix}.png`);
    try {
      await writeFile(target, buffer, { flag: 'wx' });
      report.evidence.screenshots.push(target);
      return target;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not allocate a unique screenshot path for ${label}.`);
}

async function checkPageDiagnostics(report, tracker, label) {
  await runCheck(report, CATEGORIES.media, `${label}:page-errors`, () => {
    if (tracker.pageErrors.length) throw new Error(`${label} emitted pageerror: ${tracker.pageErrors.join('; ')}`);
    return { pageErrors: 0 };
  });
  await runCheck(report, CATEGORIES.media, `${label}:external-requests`, () => {
    if (tracker.remoteRequests.length) throw new Error(`${label} requested non-local resources: ${tracker.remoteRequests.join(', ')}`);
    return { blockedRequests: 0 };
  });
}

async function verifyInteractivePage(browser, options, report) {
  const opened = await openTrackedPage(browser, options.html, { width: 1280, height: 900 });
  const { context, page, tracker } = opened;
  try {
    const meta = await readLessonMeta(page);
    report.lesson.topic = meta.topic;
    report.lesson.duration = meta.duration;
    if (!Number.isFinite(meta.duration) || meta.duration <= 0) throw new Error('window.lesson.duration must be positive and finite.');
    const selector = '#diagramContent';
    await runCheck(report, CATEGORIES.dom, 'interactive:random-time-forward-reverse', () => checkTimeDeterminism(page, meta.duration, selector, report, 'interactive'));

    if (meta.topic === 'circle-area') {
      await runCheck(report, CATEGORIES.geometry, 'circle:actual-svg-sector-geometry', async () => {
        const nResults = [];
        for (const n of SUPPORTED_N) {
          const controlState = await forceCircleN(page, n, meta.duration);
          const snapshot = await readCircleSnapshot(page);
          const analysis = extractCircleAnalysis(snapshot, n);
          analysis.partsSelectorValue = controlState.selectedValue;
          nResults.push(analysis);
          await captureScreenshot(page, options.screenshotsDir, `interactive-circle-n${n}`, report);
        }
        return { source: 'rendered SVG [data-sector] paths', nResults };
      });
    } else if (meta.topic === 'fraction-division') {
      await runCheck(report, CATEGORIES.geometry, 'fraction:actual-svg-bars-and-result', async () => {
        const cases = [[3, 4, 1, 2], [2, 3, 1, 6], [4, 7, 3, 1]];
        const results = [];
        for (const values of cases) {
          const controlState = await page.evaluate(([a, b, c, d]) => {
            if (typeof window.lesson.setFraction !== 'function') throw new Error('window.lesson.setFraction is missing.');
            window.lesson.setFraction(a, b, c, d);
            window.lesson.setTime(window.lesson.duration * 0.87);
            const selector = document.querySelector('#fractionExample');
            const expectedValue = [a, b, c, d].join(',');
            const selectedValue = selector?.value ?? null;
            if (selector && selectedValue !== expectedValue) {
              throw new Error(`setFraction(${expectedValue}) left #fractionExample.value=${selectedValue}.`);
            }
            return { selectedValue, selectedText: selector?.selectedOptions?.[0]?.textContent || null };
          }, values);
          const snapshot = await readFractionSnapshot(page);
          const result = analyzeFractionSnapshot(snapshot, values);
          result.fractionSelectorValue = controlState.selectedValue;
          result.fractionSelectorText = controlState.selectedText;
          results.push(result);
          await captureScreenshot(page, options.screenshotsDir, `interactive-fraction-${values.join('_')}`, report);
        }
        return { source: 'rendered SVG rect.getBBox() and visible text', cases: results };
      });
    } else {
      addResult(report, CATEGORIES.geometry, 'topic-specific-geometry', 'skipped', { reason: `Unsupported topic: ${meta.topic}` });
    }

    await runCheck(report, CATEGORIES.dom, 'interactive:desktop-control-bounds', () => checkControlBounds(page, 1280, 900, 'desktop'));
    await runCheck(report, CATEGORIES.dom, 'interactive:390px-control-bounds', () => checkControlBounds(page, 390, 844, '390px'));
    await checkPageDiagnostics(report, tracker, 'interactive');
  } finally {
    await context.close();
  }
}

async function verifyVideoPage(browser, options, report) {
  const opened = await openTrackedPage(browser, options.html, { width: 1080, height: 1920, video: true });
  const { context, page, tracker } = opened;
  try {
    const meta = await readLessonMeta(page);
    const selector = '#videoSvg';
    await runCheck(report, CATEGORIES.media, 'video:random-time-forward-reverse', () => checkTimeDeterminism(page, meta.duration, selector, report, 'video'));
    await runCheck(report, CATEGORIES.media, 'video:1080x1920-text-bounds', async () => {
      const times = deterministicTimes(meta.duration, 8);
      const failures = [];
      for (const time of times) {
        await setLessonTime(page, time);
        const snapshot = await page.evaluate(() => {
          const svg = document.querySelector('#videoSvg');
          const canvas = svg?.getBoundingClientRect();
          const texts = [...(svg?.querySelectorAll('text') || [])].map((element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return { text: element.textContent || '', display: style.display, visibility: style.visibility, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
          }).filter((box) => box.display !== 'none' && box.visibility !== 'hidden' && box.width > 0 && box.height > 0);
          return { canvas: canvas ? { left: canvas.left, right: canvas.right, top: canvas.top, bottom: canvas.bottom, width: canvas.width, height: canvas.height } : null, texts };
        });
        if (!snapshot.canvas) throw new Error('Missing #videoSvg canvas.');
        const bad = snapshot.texts.filter((box) => box.left < snapshot.canvas.left - 1 || box.right > snapshot.canvas.right + 1 || box.top < snapshot.canvas.top - 1 || box.bottom > snapshot.canvas.bottom + 1);
        if (bad.length) failures.push({ time, bad });
      }
      if (failures.length) throw new Error(`visible SVG text leaves the 1080x1920 canvas at ${failures.length} sample(s).`);
      await captureScreenshot(page, options.screenshotsDir, 'video-final-1080x1920', report);
      return { viewport: { width: 1080, height: 1920 }, sampleCount: times.length, textOverflowSamples: 0 };
    });
    await checkPageDiagnostics(report, tracker, 'video');
  } finally {
    await context.close();
  }
}

export async function verifyLesson(options) {
  if (!(await isFile(options.html))) throw new Error(`--html must be an existing file: ${options.html}`);
  const report = makeReport(options);
  let browser;
  try {
    const { chromium, moduleEntry } = await loadPlaywright(options.playwrightModule);
    report.runtime = { playwrightModule: moduleEntry, browserLaunched: false, externalRequestsBlocked: true };
    browser = await chromium.launch({ headless: true });
    report.runtime.browserLaunched = true;
    await verifyInteractivePage(browser, options, report);
    await verifyVideoPage(browser, options, report);
  } catch (error) {
    addError(report, CATEGORIES.media, 'verifier-runtime', error);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  report.ok = report.errors.length === 0;
  await mkdir(dirname(options.out), { recursive: true });
  const staged = `${options.out}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(staged, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  await rename(staged, options.out);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
    } else {
      const report = await verifyLesson(options);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`Lesson verification failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

