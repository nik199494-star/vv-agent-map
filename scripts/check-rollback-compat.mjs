import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const windowsPrograms = [
  process.env.ProgramFiles ?? 'C:/Program Files',
  process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
];
const browserPaths = {
  win32: windowsPrograms.flatMap(root => [
    join(root, 'Google/Chrome/Application/chrome.exe'),
    join(root, 'Microsoft/Edge/Application/msedge.exe'),
  ]),
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};
const chrome = process.env.VV_AGENT_CHROME ?? (browserPaths[process.platform] ?? []).find(existsSync);
if (!chrome || !existsSync(chrome)) {
  throw Error('Установите Chrome или укажите путь к Chromium в VV_AGENT_CHROME.');
}

const playwright = fileURLToPath(import.meta.resolve('playwright-core'));
const options = {
  cwd: new URL('../', import.meta.url),
  env: {...process.env, VV_AGENT_PLAYWRIGHT: playwright, VV_AGENT_CHROME: chrome},
  stdio: 'inherit',
};
for (const args of [['--test'], ['build.mjs']]) {
  const run = spawnSync(process.execPath, args, options);
  if (run.error) throw run.error;
  if (run.status !== 0) {
    process.exitCode = run.status ?? 1;
    break;
  }
}
