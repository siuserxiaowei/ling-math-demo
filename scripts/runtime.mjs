import { spawn } from 'node:child_process';
import { access, stat, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadPlaywright(modulePath) {
  const require = createRequire(import.meta.url);
  const candidates = [];
  if (modulePath) {
    candidates.push(() => require.resolve(resolve(modulePath)));
  } else {
    candidates.push(() => require.resolve('playwright'));
    candidates.push(() => createRequire(resolve(process.cwd(), 'package.json')).resolve('playwright'));
  }
  const failures = [];
  for (const locate of candidates) {
    try {
      const entry = locate();
      const imported = await import(pathToFileURL(entry).href);
      const api = imported.chromium ? imported : imported.default;
      if (!api?.chromium) throw new Error('The selected module does not export chromium.');
      return { chromium: api.chromium, moduleEntry: entry };
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error('Playwright could not be resolved. Install it in your project, or pass --playwright-module /path/to/playwright.\n' + failures.join('\n'));
}

export async function runCommand(executable, args, { timeout = 15000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-2_000_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32000); });
    child.once('error', (error) => { clearTimeout(timer); reject(new Error(`${executable}: ${error.message}`)); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveResult({ stdout, stderr });
      else reject(new Error(`${executable} failed (${signal || code}): ${stderr.trim() || 'no diagnostic output'}`));
    });
  });
}

/** Select an actual Python 3.10+ interpreter without assuming its command name. */
export async function resolvePython({ run = runCommand, platform = process.platform, env = process.env, listDirectory = readdir } = {}) {
  const candidates = [
    { command: 'python3', args: [] },
    { command: 'python', args: [] },
    ...(platform === 'win32' ? [{ command: 'py', args: ['-3'] }] : []),
  ];
  async function probe(candidate) {
    try {
      const result = await run(candidate.command, [...candidate.args, '--version'], { timeout: 10000 });
      const match = /(?:^|\n)Python\s+(\d+)\.(\d+)(?:\.(\d+))?(?:\s|$)/.exec(
        [result.stdout || '', result.stderr || ''].join('\n').trim(),
      );
      if (!match || Number(match[1]) !== 3 || Number(match[2]) < 10) return null;
      return { ...candidate, version: [match[1], match[2], match[3] || '0'].join('.') };
    } catch {
      // Error diagnostics can contain local paths or other environment data.
      // The final error deliberately reports only the dependency to repair.
    }
    return null;
  }
  for (const candidate of candidates) {
    const result = await probe(candidate);
    if (result) return result;
  }
  // A system python3 can shadow a newer versioned command later in PATH.
  // Discover names rather than hard-coding a currently "latest" Python release.
  const versioned = new Map();
  const paths = new Set(String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean));
  for (const directory of paths) {
    try {
      for (const name of await listDirectory(directory)) {
        const match = /^python3\.(\d+)(?:\.exe)?$/.exec(name);
        if (match && Number(match[1]) >= 10) versioned.set(name, Number(match[1]));
      }
    } catch { /* Missing PATH entries are normal. */ }
  }
  for (const [command] of [...versioned.entries()].sort((a, b) => b[1] - a[1])) {
    const result = await probe({ command, args: [] });
    if (result) return result;
  }
  const error = new Error('找不到可执行的Python 3.10或更新的3.x版本。安装后让Agent重新运行环境检查；Windows也支持py -3。');
  error.code = 'PYTHON_NOT_FOUND';
  throw error;
}

export async function inspectAudio(filePath, ffprobe = 'ffprobe') {
  const { stdout } = await runCommand(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', filePath,
  ]);
  const data = JSON.parse(stdout);
  const audio = (data.streams || []).filter((stream) => stream.codec_type === 'audio');
  if (!audio.length) throw new Error(`No audio stream found in ${filePath}`);
  const durations = audio.map((stream) => Number(stream.duration)).filter((value) => Number.isFinite(value) && value > 0);
  const fallback = Number(data.format?.duration);
  const duration = durations.length ? Math.max(...durations) : fallback;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not determine the audio duration of ${filePath}`);
  return { duration, streams: audio.length };
}

export async function assertFile(filePath, label) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new Error(`${label} must be an existing file: ${filePath}`);
}

export async function assertAbsentUnlessForce(filePath, force) {
  const info = await stat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && !info.isFile()) throw new Error(`Output is not a regular file: ${filePath}`);
  if (info && !force) throw new Error(`Refusing to overwrite ${filePath}. Use --force to replace this exact file.`);
}

export async function browserExecutableStatus(chromium, override) {
  const executablePath = override ? resolve(override) : chromium.executablePath();
  const available = await access(executablePath).then(() => true).catch(() => false);
  return { executablePath, available };
}

export function commandPath(value) {
  return value && (isAbsolute(value) || value.includes('/') || value.includes('\\')) ? resolve(value) : value;
}
