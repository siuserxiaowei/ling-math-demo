import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectEnvironment, parseArgs } from './doctor.mjs';
import { MODEL } from './ling_client.mjs';

function dependencies(overrides = {}) {
  return {
    nodeVersion: '22.1.0', platform: 'darwin',
    runCommand: async (command, args) => ({ stdout: args.includes('-encoders') ? ' V....D libx264 H.264 encoder\n' : command + ' version 8.1.1\n', stderr: '' }),
    resolvePython: async () => ({ command: 'python3', args: [], version: '3.14.0' }),
    loadPlaywright: async () => ({ chromium: { launch: async () => ({ close: async () => {} }) } }),
    browserExecutableStatus: async () => ({ available: true }),
    checkConfiguration: async () => ({ configured: true, model: MODEL, transportMode: 'official', apiKey: 'must-never-appear' }),
    ...overrides,
  };
}

test('ready doctor checks local dependencies and real browser launch without exposing configuration fields', async () => {
  let launches = 0, closes = 0;
  const report = await inspectEnvironment({}, dependencies({ loadPlaywright: async () => ({ chromium: {
    launch: async () => { launches++; return { close: async () => { closes++; } }; },
  } }) }));
  assert.equal(report.ready, true); assert.equal(report.networkRequested, false);
  assert.equal(launches, 1); assert.equal(closes, 1);
  assert.equal(report.checks.ffmpeg.libx264, true);
  assert.ok(!JSON.stringify(report).includes('must-never-appear'));
});

test('missing dependencies become actionable safe report errors rather than raw diagnostics', async () => {
  const error = () => { throw new Error('private-diagnostic-value'); };
  const report = await inspectEnvironment({}, dependencies({ nodeVersion: '20.11.0', runCommand: error, resolvePython: error, loadPlaywright: error, checkConfiguration: error }));
  assert.equal(report.ready, false);
  assert.deepEqual(report.errors.map(error => error.component), ['node', 'python', 'ffmpeg', 'ffprobe', 'browser', 'ling']);
  assert.ok(report.errors.every(error => error.fix));
  assert.ok(!JSON.stringify(report).includes('private-diagnostic-value'));
});

test('missing x264, absent browser executable and custom API configuration prevent default-film readiness', async () => {
  let launched = false;
  const report = await inspectEnvironment({}, dependencies({
    runCommand: async () => ({ stdout: '', stderr: '' }),
    loadPlaywright: async () => ({ chromium: { launch: async () => { launched = true; } } }),
    browserExecutableStatus: async () => ({ available: false }),
    checkConfiguration: async () => ({ configured: true, transportMode: 'custom_https' }),
  }));
  assert.equal(report.ready, false); assert.equal(launched, false);
  assert.deepEqual(report.errors.map(error => error.code), ['H264_ENCODER_MISSING', 'CHROMIUM_NOT_INSTALLED', 'OFFICIAL_CONFIG_REQUIRED']);
});

test('installed browser that cannot launch is distinguished from missing module and key', async () => {
  const report = await inspectEnvironment({}, dependencies({
    loadPlaywright: async () => ({ chromium: { launch: async () => { throw new Error('OS library missing'); } } }),
    checkConfiguration: async () => ({ configured: false }),
  }));
  assert.deepEqual(report.errors.map(error => error.code), ['CHROMIUM_LAUNCH_FAILED', 'LING_CONFIG_REQUIRED']);
});

test('doctor CLI accepts only local paths and does not echo unknown values', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.ok(parseArgs(['--playwright-module', './module', '--config', './config']).config);
  assert.throws(() => parseArgs(['--api-key', 'private-value']), error => !error.message.includes('private-value'));
  assert.throws(() => parseArgs(['--config']));
});
