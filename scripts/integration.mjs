// Starts VS Code with the extension and runs test/integration/suite.ts in it.
// Usage: node scripts/integration.mjs [path to the VS Code (Electron) binary]
//
// The test window runs on a hidden virtual display (xvfb-run), so that it does not cover
// other windows or take the focus. Set MDIFF_SHOW_WINDOW=1 to run it on the real display.
import * as esbuild from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const code = process.argv[2] ?? process.env.VSCODE_BIN ?? '/snap/code/current/usr/share/code/code';
const out = resolve('test/out/integration');
const ws = resolve(out, 'ws');

await esbuild.build({
  entryPoints: ['test/integration/suite.ts'],
  outfile: resolve(out, 'suite.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});

rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', ws, ...args], { stdio: 'ignore' });
git('init', '-q');
// The same long tail on both sides, so that the document scrolls.
let tail = '';
for (let k = 1; k <= 60; k++) {
  if (k % 10 === 1) tail += `\n## Section ${k}\n`;
  tail += `\nFiller paragraph ${k}. It has some words so that it wraps on a narrow panel, and $x_${k}$ too.\n`;
}
const withTail = (fixture) => readFileSync(fixture, 'utf8') + tail;
writeFileSync(resolve(ws, 'doc.md'), withTail('test/fixtures/old.md'));
copyFileSync('test/fixtures/quarto-old.qmd', resolve(ws, 'doc.qmd'));
copyFileSync('test/fixtures/quarto.bib', resolve(ws, 'quarto.bib'));
git('add', '.');
git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'old');
writeFileSync(resolve(ws, 'doc.md'), withTail('test/fixtures/new.md'));
copyFileSync('test/fixtures/quarto-new.qmd', resolve(ws, 'doc.qmd'));

const showWindow = process.env.MDIFF_SHOW_WINDOW === '1';
const hasXvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
if (!showWindow && !hasXvfb) {
  console.error('xvfb-run is not installed. Install it (sudo apt install xvfb), or set MDIFF_SHOW_WINDOW=1 to open the test window on your display.');
  process.exit(2);
}
const [command, prefix] = showWindow ? [code, []] : ['xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', code]];
// In a Wayland session, Electron opens its window on Wayland and ignores the virtual X display.
// Without WAYLAND_DISPLAY, and with the X11 backend, the window stays on the virtual display.
const env = { ...process.env };
if (!showWindow) delete env.WAYLAND_DISPLAY;
const hidden = showWindow ? [] : ['--ozone-platform=x11'];

const result = spawnSync(command, [
  ...prefix,
  ws,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${resolve(out, 'suite.js')}`,
  `--user-data-dir=${resolve(out, 'user-data')}`,
  `--extensions-dir=${resolve(out, 'extensions')}`,
  '--disable-extensions',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--no-sandbox',
  ...hidden,
], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
