import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, planTiming } from './render_video.mjs';
import { assertAbsentUnlessForce, inspectAudio, loadPlaywright, runCommand } from './runtime.mjs';

test('H.264 output rejects odd dimensions, invalid FPS, and path collisions', () => {
  const base = ['--html', 'lesson.html', '--output', 'lesson.mp4'];
  assert.throws(() => parseArgs([...base, '--width', '1079']), /even integer/);
  assert.throws(() => parseArgs([...base, '--fps', '0']), /frames|fps/i);
  assert.throws(() => parseArgs([...base, '--audio', 'lesson.html']), /paths must be different/);
});

test('missing values, unknown flags, and non-finite duration fail before starting tools', () => {
  assert.throws(() => parseArgs(['--html']), /Missing value/);
  assert.throws(() => parseArgs(['--typo', '1']), /Unknown argument/);
  assert.throws(() => parseArgs(['--html', 'a.html', '--output', 'a.mp4', '--duration', 'Infinity']), /finite/);
});

test('frame quantization never makes a requested video shorter', () => {
  const plan = planTiming(1.01, undefined, undefined, 30);
  assert.equal(plan.frameCount, 31);
  assert.ok(plan.duration >= 1.01);
});

test('narration cannot be silently truncated and explicit extension holds the final scene', () => {
  assert.throws(() => planTiming(10, undefined, 10.2, 30), /never be silently truncated/);
  const plan = planTiming(10, 10.2, 10.2, 30);
  assert.equal(plan.frameCount, 306);
  assert.ok(Math.abs(plan.finalSceneHold - 0.2) < 1e-10);
  assert.equal(plan.trimmedLesson, false);
});

test('only an explicit duration override can shorten the lesson', () => {
  assert.equal(planTiming(12, 8, undefined, 30).trimmedLesson, true);
  assert.equal(planTiming(12, undefined, undefined, 30).trimmedLesson, false);
});

test('existing outputs require force', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'math-export-target-'));
  try {
    const path = join(dir, 'lesson.mp4');
    await writeFile(path, 'existing');
    await assert.rejects(assertAbsentUnlessForce(path, false), /Refusing to overwrite/);
    await assert.doesNotReject(assertAbsentUnlessForce(path, true));
    await assert.rejects(assertAbsentUnlessForce(dir, true), /not a regular file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('FFprobe measures the actual generated narration duration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'math-export-audio-'));
  try {
    const audio = join(dir, 'tone.wav');
    await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.35', '-c:a', 'pcm_s16le', audio]);
    const result = await inspectAudio(audio);
    assert.equal(result.streams, 1);
    assert.ok(Math.abs(result.duration - 0.35) < 0.002);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an invalid explicit Playwright module yields an actionable error', async () => {
  await assert.rejects(loadPlaywright('/a/path/that/does/not/exist'), /--playwright-module/);
});
