import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { composeFilm, scriptJSON, validateMap } from './compose_film.mjs';
import { loadPlaywright } from './runtime.mjs';

const modulePath = process.env.MATH_PROBE_PLAYWRIGHT_MODULE;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const narration = { duration: 3, segments: [
  { id: 'first', text: '观察同一个单位条。', lines: ['观察同一个单位条。'], start: 0, voiceStart: 0.1, voiceEnd: 1.3, end: 1.5 },
  { id: 'second', text: '切换后仍保持比例。', lines: ['切换后仍保持比例。'], start: 1.5, voiceStart: 1.5, voiceEnd: 2.8, end: 3 },
] };
const map = { schemaVersion: 1, segments: [
  { id: 'first', sourceTimeStart: 0, sourceTimeEnd: 5, actions: [{ selector: '#one', type: 'click' }], showFormula: false },
  { id: 'second', sourceTimeStart: 5, sourceTimeEnd: 10, actions: [{ selector: '#two', type: 'click' }], showFormula: true },
] };
const source = `<!doctype html><meta charset="utf-8"><style>:root{--source-color:#ab3412}svg text{font-family:serif;font-size:17px}svg rect{fill:var(--source-color)}</style><h1>单位条演示</h1><div id="subtitle">同一个尺度</div><button id="one">选择一</button><button id="two">选择二</button><svg id="main-svg" viewBox="0 0 360 360"><text x="20" y="45">单位 1</text><rect data-math="quantity" x="20" y="80" width="100" height="40"/></svg><div id="formula-line"></div><!-- preserve literal </script> marker --><script>let example=1,time=0;function draw(t){time=t;document.querySelector('rect').setAttribute('width',String(example*100+t*3));document.querySelector('#formula-line').textContent=String(example)+' × 1 = '+example;}document.querySelector('#one').onclick=()=>{example=1;draw(time)};document.querySelector('#two').onclick=()=>{example=2;draw(time)};window.lesson={duration:10,setTime:draw,inspect(){return {time,example}}};draw(0);</script>`;

test('script JSON preserves text while removing HTML parser escape sequences', () => {
  const value = { text: '</script><img src=x>\u2028&', nested: { source } };
  const encoded = scriptJSON(value);
  assert.ok(!encoded.includes('<')); assert.ok(!encoded.includes('</script>'));
  assert.deepEqual(JSON.parse(encoded), value);
});

test('map rejects missing ids, arbitrary executable actions and invalid time ranges', () => {
  assert.equal(validateMap(narration, map).length, 2);
  const missing = structuredClone(map); missing.segments[1].id = 'unknown';
  assert.throws(() => validateMap(narration, missing), /ids/);
  const executable = structuredClone(map); executable.segments[0].actions = [{ type: 'eval', selector: '#one', script: 'bad()' }];
  assert.throws(() => validateMap(narration, executable), /declared/);
  const backwards = structuredClone(map); backwards.segments[0].sourceTimeEnd = -1;
  assert.throws(() => validateMap(narration, backwards), /range/);
});

let chromium;
before(async () => { ({ chromium } = await loadPlaywright(modulePath)); });

async function fixture(mapping = map) {
  const root = await mkdtemp(join(tmpdir(), 'compose-film-'));
  const paths = { root, source: join(root, 'original.html'), narration: join(root, 'narration.json'), map: join(root, 'map.json'), output: join(root, 'composed', 'video.html') };
  await writeFile(paths.source, source); await writeFile(paths.narration, JSON.stringify(narration)); await writeFile(paths.map, JSON.stringify(mapping));
  paths.receipt = await composeFilm({ 'source-html': paths.source, narration: paths.narration, map: paths.map, output: paths.output, 'source-model': 'Caller-declared model' });
  return paths;
}

async function contextFor(browser, html) {
  const context = await browser.newContext({ viewport: { width: 1080, height: 1920 }, serviceWorkers: 'block' });
  const blocked = [];
  await context.route('**/*', (route) => { const url = route.request().url(); if (/^(about:|data:|blob:)/.test(url) || (url.startsWith('file:') && fileURLToPath(url) === html)) return route.continue(); blocked.push(url); return route.abort('blockedbyclient'); });
  const page = await context.newPage(); await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
  return { context, page, blocked };
}

test('composition keeps original source bytes and draws only cloned source SVG after reverse seeks', async () => {
  const files = await fixture(), browser = await chromium.launch({ headless: true });
  try {
    const { context, page, blocked } = await contextFor(browser, files.output);
    await page.waitForFunction(() => window.lesson);
    assert.equal(await page.evaluate(() => document.querySelector('#film-source').srcdoc), source);
    for (const t of [0.3, 2.4, 0.3]) {
      const state = await page.evaluate((time) => {
        lesson.setTime(time); const frame = document.querySelector('#film-source'), original = frame.contentDocument.querySelector('rect'), clone = document.querySelector('#film-scene rect');
        return { inspect: lesson.inspect(), originalWidth: original.getAttribute('width'), clonedWidth: clone.getAttribute('width'), fill: getComputedStyle(clone).fill, caption: document.querySelector('#film-caption').innerText, formula: document.querySelector('#film-formula').textContent, formulaHidden: document.querySelector('#film-formula').hidden };
      }, t);
      assert.equal(state.originalWidth, state.clonedWidth); assert.equal(state.fill, 'rgb(171, 52, 18)');
      assert.equal(state.inspect.hostComposition, true); assert.equal(state.inspect.mathStatus, 'not_assessed');
      assert.equal(state.caption, t < 1.5 ? narration.segments[0].text : narration.segments[1].text);
      assert.equal(state.formulaHidden, t < 1.5); if (t > 1.5) assert.equal(state.formula, '2 × 1 = 2');
    }
    assert.equal(blocked.length, 0); await context.close();
    assert.equal(await readFile(files.source, 'utf8'), source);
    const provenance = JSON.parse(await readFile(files.receipt.provenance, 'utf8'));
    assert.equal(provenance.sourceHtmlSha256, digest(source)); assert.equal(provenance.hostComposition, true);
    assert.equal(provenance.sourceModel, 'Caller-declared model'); assert.match(provenance.sourceModelAttribution, /not independently authenticated/);
    await assert.rejects(composeFilm({ 'source-html': files.source, narration: files.narration, map: files.map, output: files.output }), /overwrite/);
  } finally { await browser.close(); await rm(files.root, { recursive: true, force: true }); }
});

test('source upper time bounds are checked against the actual original lesson at load', async () => {
  const invalid = structuredClone(map); invalid.segments[1].sourceTimeEnd = 11;
  const files = await fixture(invalid), browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await contextFor(browser, files.output);
    const failure = await page.evaluate(() => ({ message: document.documentElement.dataset.filmCompositionError, exposed: !!window.lesson }));
    assert.match(failure.message, /exceeds/); assert.equal(failure.exposed, false); await context.close();
  } finally { await browser.close(); await rm(files.root, { recursive: true, force: true }); }
});

test('the composed SVG fixture passes measured-caption film verification', async () => {
  const files = await fixture();
  try {
    const args = [fileURLToPath(new URL('./verify_film.mjs', import.meta.url)), '--html', files.output, '--narration', files.narration, '--out-dir', join(files.root, 'verified')];
    if (modulePath) args.push('--playwright-module', modulePath);
    const result = await new Promise((done, fail) => { const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.resume(); let stderr = ''; child.stderr.on('data', (part) => { stderr += part; }); child.once('error', fail); child.once('close', (code) => done({ code, stderr })); });
    const report = JSON.parse(await readFile(join(files.root, 'verified', 'verify-film.json'), 'utf8'));
    assert.equal(result.code, 0, JSON.stringify(report.issues)); assert.equal(report.ok, true); assert.equal(report.mathStatus, 'not_assessed');
  } finally { await rm(files.root, { recursive: true, force: true }); }
});
