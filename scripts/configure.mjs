#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePython } from './runtime.mjs';

const CONFIGURE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'configure_ling.py');
const HELP = 'node scripts/configure.mjs\n自动选择Python 3.10+并启动本机隐藏输入配置。Key只在交互提示中输入，不作为命令参数。\n';

export function buildConfigurationCommand(python, script = CONFIGURE_SCRIPT) {
  if (typeof python?.command !== 'string' || !python.command || !Array.isArray(python.args) || python.args.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('Python运行时描述无效。');
  }
  return { command: python.command, args: [...python.args, script] };
}

export function parseArgs(argv) {
  if (!argv.length) return { help: false };
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  throw new Error('本命令不接受Key或其他参数。请不带参数运行，在本机隐藏输入提示中配置。');
}

/** The child owns interactive input; this wrapper never reads a credential. */
export async function runConfiguration({ resolver = resolvePython, spawnImpl = spawn } = {}) {
  const python = await resolver();
  const invocation = buildConfigurationCommand(python);
  return new Promise((resolveResult, reject) => {
    let child;
    try { child = spawnImpl(invocation.command, invocation.args, { stdio: 'inherit', shell: false, windowsHide: false }); }
    catch { reject(new Error('无法启动本机Python配置程序。')); return; }
    child.once('error', () => reject(new Error('无法启动本机Python配置程序。')));
    child.once('close', (code, signal) => resolveResult({ code: Number.isInteger(code) ? code : 1, signal: signal || null }));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(HELP); return; }
  const result = await runConfiguration();
  if (result.code !== 0) process.exitCode = result.code >= 1 && result.code <= 255 ? result.code : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  process.stderr.write('配置未启动或未完成。先运行doctor.mjs检查环境；Key不放在命令参数或聊天中。\n');
  process.exitCode = 1;
});
