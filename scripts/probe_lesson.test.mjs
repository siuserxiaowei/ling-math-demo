import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaywright } from './runtime.mjs';

const modulePath = process.env.MATH_PROBE_PLAYWRIGHT_MODULE;
const probePath = fileURLToPath(new URL('./probe_lesson.mjs', import.meta.url));
before(async () => { await loadPlaywright(modulePath); });

function run(args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [probePath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stdout.resume(); child.stderr.on('data', (part) => { stderr += part; });
    child.once('error', fail); child.once('close', (code) => done({ code, stderr }));
  });
}

async function fixture(body, title = '数学演示', extraScript = '', localAsset = false) {
  const root = await mkdtemp(join(tmpdir(), 'math-probe-regression-'));
  const html = join(root, 'lesson.html');
  if (localAsset) {
    const asset = join(root, 'private-extra.svg');
    await writeFile(asset, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text x="0" y="8">private-fixture-marker</text></svg>');
    body = body.replace('__LOCAL_ASSET__', pathToFileURL(asset).href);
  }
  const source = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0"><div id="readout"></div><canvas width="600" height="300" style="display:block;width:100%;max-width:600px;height:auto"></canvas><script>const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');let calls=0,time=0;window.lesson={duration:4,setTime(t){time=t;calls++;ctx.fillStyle='white';ctx.fillRect(0,0,600,300);ctx.fillStyle='teal';ctx.fillRect(20+t*30,70,50,50);document.querySelector('#readout').innerHTML=${JSON.stringify(body)};${extraScript}},inspect(){return {time}}};lesson.setTime(0);</script>`;
  await writeFile(html, source);
  const output = join(root, 'probe');
  const args = ['--html', html, '--out-dir', output];
  if (modulePath) args.push('--playwright-module', modulePath);
  const result = await run(args);
  return { root, result, report: JSON.parse(await readFile(join(output, 'probe.json'), 'utf8')) };
}

test('a rendered numeric undefined denominator blocks; a correct fraction and JS code examples do not', async () => {
  const bad = await fixture('商 = 3 个 1/undefined');
  try {
    assert.equal(bad.result.code, 1); assert.equal(bad.report.ok, false);
    assert.ok(bad.report.issues.some((issue) => issue.kind === 'visible_math_placeholder' && issue.blocking));
    assert.equal(bad.report.mathStatus, 'not_assessed');
  } finally { await rm(bad.root, { recursive: true, force: true }); }
  const good = await fixture('商 = 3 个 1/2 <code>const x = 1/undefined; Number.NaN</code><span hidden>1/undefined</span>');
  try {
    assert.equal(good.result.code, 0); assert.equal(good.report.ok, true);
    assert.equal(good.report.checks.visibleMathText.findings.length, 0);
  } finally { await rm(good.root, { recursive: true, force: true }); }
});

test('JS terminology explanation is a content risk rather than a mathematical failure', async () => {
  const result = await fixture('JavaScript 中 1/undefined 返回 NaN', 'JavaScript 中 undefined 与 NaN');
  try {
    assert.equal(result.report.checks.visibleMathText.ok, true);
    assert.ok(!result.report.issues.some((issue) => issue.kind === 'visible_math_placeholder' && issue.blocking));
    assert.ok(result.report.issues.some((issue) => issue.kind === 'visible_math_text_risk' && !issue.blocking));
    assert.equal(result.report.mathStatus, 'not_assessed');
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('one channel-level pixel noise is retained as nonblocking evidence', async () => {
  const result = await fixture('时间轴演示', '数学演示', `ctx.fillStyle=calls%2?'rgb(254,255,255)':'rgb(255,255,255)';ctx.fillRect(590,290,1,1);`);
  try {
    assert.equal(result.result.code, 0); assert.equal(result.report.ok, true);
    assert.equal(result.report.checks.determinism.rawHashesEqual, false);
    assert.ok(result.report.checks.determinism.comparisons.some((item) => item.rasterNoise && item.pixelDiff.maxChannelDelta <= 1 && item.pixelDiff.changedPixelRatio <= 0.0001));
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('a real two-pixel displacement still blocks determinism', async () => {
  const result = await fixture('时间轴演示', '数学演示', `ctx.fillStyle='white';ctx.fillRect(0,0,600,300);ctx.fillStyle='teal';ctx.fillRect(20+t*30+(calls%2)*2,70,50,50);`);
  try {
    assert.equal(result.result.code, 1); assert.equal(result.report.ok, false);
    assert.ok(result.report.issues.some((issue) => issue.kind === 'lesson_nondeterministic' && issue.blocking));
    assert.ok(result.report.checks.determinism.comparisons.some((item) => !item.equal && item.pixelDiff.maxChannelDelta > 1));
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('another local file is blocked without disclosing its path or contents', async () => {
  const result = await fixture('<img src="__LOCAL_ASSET__">单文件课件', '数学演示', '', true);
  try {
    assert.equal(result.result.code, 1); assert.equal(result.report.ok, false);
    assert.ok(result.report.checks.offline.blockedLocalResources > 0);
    assert.ok(result.report.issues.some((issue) => issue.kind === 'lesson_local_resource' && issue.blocking));
    assert.ok(!JSON.stringify(result.report).includes('private-extra.svg'));
    assert.ok(!JSON.stringify(result.report).includes('private-fixture-marker'));
  } finally { await rm(result.root, { recursive: true, force: true }); }
});
