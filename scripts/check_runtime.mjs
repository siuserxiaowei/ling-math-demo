#!/usr/bin/env node
import { browserExecutableStatus, commandPath, loadPlaywright, runCommand } from './runtime.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('node check_runtime.mjs [--playwright-module PATH] [--browser PATH] [--ffmpeg COMMAND] [--ffprobe COMMAND]\n');
} else {
  const options = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  const allowed = new Set(['playwright-module', 'browser', 'ffmpeg', 'ffprobe']);
  try {
    for (let i = 0; i < args.length; i++) {
      const key = args[i].slice(2);
      if (!args[i].startsWith('--') || !allowed.has(key)) throw new Error(`Unknown argument: ${args[i]}`);
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = args[++i];
    }
    const report = { node: process.version, ffmpeg: null, ffprobe: null, playwright: null, fonts: { verified: false, reminder: 'Use local Chinese fonts or bundled licensed fonts. A browser screenshot must confirm Chinese glyphs and formula layout.' } };
    for (const name of ['ffmpeg', 'ffprobe']) {
      try {
        const { stdout } = await runCommand(commandPath(options[name]), ['-version']);
        report[name] = { available: true, command: options[name], version: stdout.split('\n')[0] };
      } catch (error) { report[name] = { available: false, error: error.message }; }
    }
    try {
      const { chromium, moduleEntry } = await loadPlaywright(options['playwright-module']);
      report.playwright = { available: true, moduleEntry, chromium: await browserExecutableStatus(chromium, options.browser), browserLaunched: false };
    } catch (error) { report.playwright = { available: false, error: error.message }; }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ffmpeg.available || !report.ffprobe.available || !report.playwright.available || !report.playwright.chromium.available) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Runtime check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
