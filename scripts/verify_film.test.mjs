import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { activeCue, filmSampleTimes, narrationCues, normalizeCaption, teachingPauseIntervals } from './verify_film.mjs';
import { loadPlaywright } from './runtime.mjs';

const playwrightModule = process.env.MATH_PROBE_PLAYWRIGHT_MODULE;
const script = fileURLToPath(new URL('./verify_film.mjs', import.meta.url));
const manifest = { duration: 3, actualDuration: 3, segments: [
  { id: 'one', text: '线段帮助我们看清数量关系。', spokenText: '线段帮助我们看清数量关系。', start: 0, end: 1.5, voiceStart: 0.1, voiceEnd: 1.3, visual: { scene: 'bars' } },
  { id: 'two', text: '保持同一个单位，再比较。', spokenText: '保持同一个单位，再比较。', start: 1.5, end: 3, voiceStart: 1.5, voiceEnd: 2.8, visual: { scene: 'comparison' } },
] };

test('measured intervals reject overlap and malformed durations', () => {
  assert.equal(narrationCues(manifest).length, 2);
  assert.throws(() => narrationCues({ ...manifest, duration: -1 }), /duration/);
  const overlap = structuredClone(manifest); overlap.segments[1].start = 1.4;
  assert.throws(() => narrationCues(overlap), /overlap/);
  const shortened = structuredClone(manifest); shortened.segments[1].end = 2.9;
  assert.throws(() => narrationCues(shortened), /last segment.end/);
});

test('sampling covers speech midpoints and both sides of every internal cue boundary', () => {
  const cues = narrationCues(manifest), samples = filmSampleTimes(cues, manifest.duration);
  assert.equal(activeCue(cues, 0), null);
  assert.equal(activeCue(cues, 1.5).id, 'two');
  assert.ok(samples.some((sample) => sample.time < 1.5 && sample.time > 1.48));
  assert.ok(samples.some((sample) => sample.time > 1.5 && sample.time < 1.52));
  assert.ok(samples.some((sample) => sample.reasons.includes('one:voice-midpoint')));
  assert.equal(normalizeCaption(' 同一个\n单位 \t'), '同一个单位');
});

before(async () => { await loadPlaywright(playwrightModule); });

test('thinking samples cover the actual held question and reject early answer narration',()=>{
  const m=structuredClone(manifest);m.duration=8;m.segments[0].end=6;m.segments[1]={...m.segments[1],start:6,voiceStart:6,voiceEnd:7.5,end:8};
  m.teaching={check:{questionSegmentId:'one',answerSegmentId:'two',pauseSeconds:4}};
  const pauses=teachingPauseIntervals(m),samples=filmSampleTimes(narrationCues(m),m.duration,pauses);
  assert.equal(pauses[0].start,1.3);assert.equal(pauses[0].end,6);
  for(const sample of samples.filter(s=>s.reasons.some(r=>r.includes('thinking-'))))assert.equal(activeCue(narrationCues(m),sample.time).id,'one');
  const early=structuredClone(m);early.segments[1].voiceStart=4;early.segments[1].start=4;early.segments[0].end=4;
  assert.throws(()=>teachingPauseIntervals(early),/complete thinking pause/);
  assert.deepEqual(teachingPauseIntervals(manifest),[]);
});

async function runFixture(mode) {
  const root = await mkdtemp(join(tmpdir(), 'film-contract-'));
  const html = join(root, 'video.html'), narration = join(root, 'narration.json'), output = join(root, 'check');
  const source = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:1080px;height:1920px;overflow:hidden;background:#fff9ed}svg{position:absolute;left:0;top:0;width:1080px;height:1200px;overflow:hidden}#film-caption{position:absolute;left:0;right:0;bottom:120px;height:${mode === 'three-lines' ? 228 : 144}px;padding:0 96px;font:52px/72px sans-serif;display:flex;justify-content:center;align-items:center;text-align:center;box-sizing:border-box}</style><svg viewBox="0 0 1080 1200"><text x="90" y="${mode === 'scene-clipped' ? 1230 : 180}" font-size="64">知识动画</text><rect id="bar" x="140" y="320" width="500" height="120" fill="teal"/></svg><div id="film-caption"></div><script>const cues=${JSON.stringify(narrationCues(manifest))},mode=${JSON.stringify(mode)};let time=0,calls=0;const cap=document.querySelector('#film-caption');window.lesson={duration:3,setTime(t){time=t;calls++;const lookup=mode==='late-switch'&&t>=1.5&&t<1.65?1.49:t;const cue=cues.find(c=>lookup>=c.start&&lookup<c.end);cap.style.visibility=cue?'visible':'hidden';cap.dataset.segmentId=cue?cue.id:'';cap.textContent=cue?cue.text:'';if(mode==='wrong-dom'&&cue)cap.textContent='这不是当前旁白对应的字幕';if(mode==='wrong-font')cap.style.fontSize='42px';if(mode==='three-lines'&&cue){const chars=[...cue.text],size=Math.ceil(chars.length/3);cap.innerHTML=[chars.slice(0,size).join(''),chars.slice(size,size*2).join(''),chars.slice(size*2).join('')].join('<br>');}document.querySelector('#bar').setAttribute('x',String(140+t*20+(mode==='stateful'?(calls%2)*2:0)));},inspect(){const expected=cues.find(c=>time>=c.start&&time<c.end);return {segmentId:expected?expected.id:''}}};lesson.setTime(0);</script>`;
  await writeFile(html, source); await writeFile(narration, JSON.stringify(manifest));
  const args = [script, '--html', html, '--narration', narration, '--out-dir', output];
  if (playwrightModule) args.push('--playwright-module', playwrightModule);
  const result = await new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); let stderr = ''; child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8000); });
    child.once('error', fail); child.once('close', (code) => done({ code, stderr }));
  });
  const report = JSON.parse(await readFile(join(output, 'verify-film.json'), 'utf8'));
  return { root, result, report };
}

test('a measured two-segment film passes actual captions, boundaries and reverse seeking', async () => {
  const run = await runFixture('valid');
  try {
    assert.equal(run.result.code, 0, JSON.stringify(run.report.issues)); assert.equal(run.report.ok, true);
    assert.equal(run.report.mathStatus, 'not_assessed'); assert.equal(run.report.inspectUsedAsEvidence, false);
    assert.ok(run.report.samples.length >= 10); assert.equal(run.report.determinism.ok, true);
    assert.ok(run.report.samples.some((sample) => sample.expectedSegmentId === null && !sample.actual.visible));
  } finally { await rm(run.root, { recursive: true, force: true }); }
});

test('a boundary-only delayed subtitle switch fails even when segment midpoints are correct', async () => {
  const run = await runFixture('late-switch');
  try {
    assert.equal(run.result.code, 1); assert.equal(run.report.ok, false);
    assert.ok(run.report.issues.some((issue) => issue.kind === 'caption_segment_mismatch' && issue.time > 1.5 && issue.time < 1.52));
  } finally { await rm(run.root, { recursive: true, force: true }); }
});

test('correct inspect self-report cannot hide wrong visible subtitle text', async () => {
  const run = await runFixture('wrong-dom');
  try { assert.equal(run.result.code, 1); assert.ok(run.report.issues.some((issue) => issue.kind === 'caption_text_mismatch')); }
  finally { await rm(run.root, { recursive: true, force: true }); }
});

test('actual small type and three rendered subtitle lines are rejected', async () => {
  for (const [mode, kind] of [['wrong-font', 'caption_font_size'], ['three-lines', 'caption_line_count']]) {
    const run = await runFixture(mode);
    try { assert.equal(run.result.code, 1); assert.ok(run.report.issues.some((issue) => issue.kind === kind), JSON.stringify(run.report.issues)); }
    finally { await rm(run.root, { recursive: true, force: true }); }
  }
});

test('clipped SVG labels and real stateful displacement are rejected', async () => {
  for (const [mode, kind] of [['scene-clipped', 'svg_text_clipped'], ['stateful', 'film_nondeterministic']]) {
    const run = await runFixture(mode);
    try { assert.equal(run.result.code, 1); assert.ok(run.report.issues.some((issue) => issue.kind === kind), JSON.stringify(run.report.issues)); }
    finally { await rm(run.root, { recursive: true, force: true }); }
  }
});
