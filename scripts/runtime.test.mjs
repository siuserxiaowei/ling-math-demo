import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePython } from './runtime.mjs';

test('Windows with only the Python launcher resolves py -3 as an argument array', async () => {
  const observed = [];
  const result = await resolvePython({ platform: 'win32', run: async (command, args) => {
    observed.push([command, args]);
    if (command !== 'py') throw new Error('not installed');
    assert.deepEqual(args, ['-3', '--version']);
    return { stdout: '', stderr: 'Python 3.12.4\r\n' };
  } });
  assert.deepEqual(result, { command: 'py', args: ['-3'], version: '3.12.4' });
  assert.deepEqual(observed.map(([command]) => command), ['python3', 'python', 'py']);
});

test('Python2, old Python3 and non-Python output are not accepted', async () => {
  const versions = { python3: 'Python 3.9.20', python: 'Python 2.7.18', py: 'not a Python interpreter' };
  await assert.rejects(resolvePython({ platform: 'win32', env: {}, run: async command => ({ stdout: versions[command], stderr: '' }) }),
    error => error.code === 'PYTHON_NOT_FOUND');
});

test('resolver uses the first supported interpreter and never propagates raw command diagnostics', async () => {
  let calls = 0;
  assert.deepEqual(await resolvePython({ platform: 'darwin', run: async () => {
    calls++;
    return { stdout: 'Python 3.14.0\n', stderr: '' };
  } }), { command: 'python3', args: [], version: '3.14.0' });
  assert.equal(calls, 1);
  await assert.rejects(resolvePython({ env: {}, run: async () => { throw new Error('sensitive-test-value'); } }),
    error => error.code === 'PYTHON_NOT_FOUND' && !error.message.includes('sensitive-test-value'));
});

test('a modern versioned interpreter is found when system python3 shadows it', async () => {
  const commands = [];
  const result = await resolvePython({ platform: 'darwin', env: { PATH: '/system:/modern' },
    listDirectory: async directory => directory === '/modern' ? ['python3.9', 'python3.12', 'python3.14', 'python-not-code'] : [],
    run: async command => {
      commands.push(command);
      if (command === 'python3') return { stdout: 'Python 3.9.6\n', stderr: '' };
      if (command === 'python3.14') return { stdout: 'Python 3.14.7\n', stderr: '' };
      throw new Error('missing');
    },
  });
  assert.deepEqual(result, { command: 'python3.14', args: [], version: '3.14.7' });
  assert.deepEqual(commands, ['python3', 'python', 'python3.14']);
});
