#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODEL, checkConfiguration } from './ling_client.mjs';
import { runCommand, resolvePython, loadPlaywright, browserExecutableStatus } from './runtime.mjs';

const HELP = `本地环境检查；不请求Ling或Ming API，不安装依赖。\nnode scripts/doctor.mjs [--playwright-module PATH] [--config FILE]\n输出JSON；ready=true时退出0，缺依赖或官方API配置时退出1。\n`;
const versionFrom = (text, name) => {
  const match = new RegExp('(?:^|\\n)' + name + ' version ([0-9][0-9A-Za-z.+_-]{0,40})(?:\\s|$)').exec(text || '');
  return match?.[1] || null;
};

/** Local readiness only. Injectable dependencies keep tests offline. */
export async function inspectEnvironment(options = {}, deps = {}) {
  const run = deps.runCommand || runCommand;
  const python = deps.resolvePython || resolvePython;
  const playwright = deps.loadPlaywright || loadPlaywright;
  const browserStatus = deps.browserExecutableStatus || browserExecutableStatus;
  const configuration = deps.checkConfiguration || checkConfiguration;
  const nodeVersion = deps.nodeVersion || process.versions.node;
  const platform = deps.platform || process.platform;
  const report = { schemaVersion: 1, ready: false, networkRequested: false, checks: {}, errors: [] };
  const fail = (component, code, message, fix) => report.errors.push({ component, code, message, fix });
  const parsedNode = /^(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  report.checks.node = { ok: Boolean(parsedNode && Number(parsedNode[1]) >= 22), version: parsedNode ? nodeVersion : null };
  if (!report.checks.node.ok) fail('node', 'NODE_VERSION', '需要Node.js 22或更新版本。', '安装Node.js 22+，重新打开Agent后再运行体检。');

  await Promise.all([
    (async () => {
      try { report.checks.python = { ok: true, runtime: await python({ run, platform }) }; }
      catch { report.checks.python = { ok: false }; fail('python', 'PYTHON_NOT_FOUND', '未发现Python 3.10+。', '安装Python 3.10+；Windows可用py -3，macOS/Linux可用python3。重新打开Agent后再体检。'); }
    })(),
    (async () => {
      try {
        const [version, encoders] = await Promise.all([
          run('ffmpeg', ['-version']), run('ffmpeg', ['-hide_banner', '-encoders']),
        ]);
        const hasX264 = /^\s*[A-Z.]{6}\s+libx264(?:\s|$)/m.test(encoders.stdout + '\n' + encoders.stderr);
        report.checks.ffmpeg = { ok: hasX264, version: versionFrom(version.stdout, 'ffmpeg'), libx264: hasX264 };
        if (!hasX264) fail('ffmpeg', 'H264_ENCODER_MISSING', 'FFmpeg未提供libx264编码器。', '安装包含libx264的FFmpeg构建，并让ffmpeg命令可执行。');
      } catch { report.checks.ffmpeg = { ok: false, libx264: false }; fail('ffmpeg', 'FFMPEG_NOT_FOUND', 'FFmpeg不可执行。', '安装带libx264的FFmpeg并加入PATH，重新打开Agent。'); }
    })(),
    (async () => {
      try { const r = await run('ffprobe', ['-version']); report.checks.ffprobe = { ok: true, version: versionFrom(r.stdout, 'ffprobe') }; }
      catch { report.checks.ffprobe = { ok: false }; fail('ffprobe', 'FFPROBE_NOT_FOUND', 'FFprobe不可执行。', '安装FFmpeg配套FFprobe并加入PATH。'); }
    })(),
    (async () => {
      let browser;
      try {
        const { chromium } = await playwright(options['playwright-module']);
        const status = await browserStatus(chromium);
        report.checks.browser = { ok: false, playwrightResolved: true, executableFound: Boolean(status.available), launched: false };
        if (!status.available) {
          fail('browser', 'CHROMIUM_NOT_INSTALLED', 'Playwright已找到，但Chromium尚未安装。', '在Skill目录执行npx playwright install chromium，再重新体检。');
          return;
        }
        browser = await chromium.launch({ headless: true });
        await browser.close(); browser = null;
        report.checks.browser.ok = true; report.checks.browser.launched = true;
      } catch {
        if (report.checks.browser?.playwrightResolved) fail('browser', 'CHROMIUM_LAUNCH_FAILED', 'Chromium已安装但无法启动。', '检查系统浏览器依赖；Linux可按Playwright官方指引安装依赖后重试。');
        else {
          report.checks.browser = { ok: false, playwrightResolved: false, executableFound: false, launched: false };
          fail('browser', 'PLAYWRIGHT_NOT_FOUND', '未找到Playwright。', '在Skill目录执行npm install，再执行npx playwright install chromium；已有依赖可传--playwright-module PATH。');
        }
      } finally { if (browser) await browser.close().catch(() => {}); }
    })(),
    (async () => {
      try {
        const c = await configuration({ configPath: options.config, env: options.env || process.env });
        const official = c.configured && c.transportMode === 'official';
        report.checks.ling = { ok: Boolean(official), configured: Boolean(c.configured), requiredModel: MODEL, transportMode: c.transportMode === 'official' ? 'official' : c.configured ? 'non-official' : null };
        if (!c.configured) fail('ling', 'LING_CONFIG_REQUIRED', '百灵API本地配置尚未就绪。', '在自己的终端运行node scripts/configure.mjs隐藏输入Key，或配置LING_API_KEY；不要发到聊天。');
        else if (!official) fail('ling', 'OFFICIAL_CONFIG_REQUIRED', '默认Ming配音需要百灵官方API配置。', '使用官方API配置；不将第三方服务令牌发往百灵语音端点。');
      } catch {
        report.checks.ling = { ok: false, configured: false, requiredModel: MODEL, transportMode: null };
        fail('ling', 'LING_CONFIG_REQUIRED', '百灵API配置无法读取。', '在自己的终端运行node scripts/configure.mjs检查本地配置，不要发送Key。');
      }
    })(),
  ]);
  const order = ['node', 'python', 'ffmpeg', 'ffprobe', 'browser', 'ling'];
  report.checks = Object.fromEntries(order.map(key => [key, report.checks[key]]));
  report.errors.sort((a, b) => order.indexOf(a.component) - order.indexOf(b.component));
  report.ready = report.errors.length === 0;
  return report;
}

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!['--playwright-module', '--config'].includes(flag)) throw new Error('未知参数，请用--help查看。');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('参数缺少值。');
    options[flag.slice(2)] = path.resolve(value);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(HELP); return; }
  const report = await inspectEnvironment(options);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.ready) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => {
  process.stderr.write('本地环境检查未完成；用--help检查参数，不要在命令参数中提供Key。\n');
  process.exitCode = 1;
});
