import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildConfigurationCommand, parseArgs, runConfiguration } from './configure.mjs';

test('configuration keeps Windows launcher prefixes and script paths as separate arguments', () => {
  const runtime = { command: 'py', args: ['-3'], version: '3.12.4' };
  assert.deepEqual(buildConfigurationCommand(runtime, '/temporary path/configure_ling.py'), {
    command: 'py', args: ['-3', '/temporary path/configure_ling.py'],
  });
  assert.deepEqual(runtime.args, ['-3']);
});

test('no plaintext credential or extra argument is accepted or echoed', () => {
  assert.deepEqual(parseArgs([]), { help: false });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const argv of [['--api-key', 'private-test-value'], ['private-test-value'], ['--help', 'private-test-value']]) {
    assert.throws(() => parseArgs(argv), error => !error.message.includes('private-test-value'));
  }
});

test('interactive configuration inherits the terminal without a shell and preserves child exit status', async () => {
  let observed;
  const result = await runConfiguration({
    resolver: async () => ({ command: 'python3.14', args: [], version: '3.14.7' }),
    spawnImpl: (command, args, options) => {
      observed = { command, args, options }; const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 2, null)); return child;
    },
  });
  assert.equal(observed.command, 'python3.14');
  assert.equal(observed.args.length, 1); assert.ok(observed.args[0].endsWith('configure_ling.py'));
  assert.deepEqual(observed.options, { stdio: 'inherit', shell: false, windowsHide: false });
  assert.deepEqual(result, { code: 2, signal: null });
});

test('spawn errors do not expose arbitrary process diagnostics', async () => {
  await assert.rejects(runConfiguration({
    resolver: async () => ({ command: 'python', args: [], version: '3.12.0' }),
    spawnImpl: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('private-test-value'))); return child; },
  }), error => !error.message.includes('private-test-value'));
});
