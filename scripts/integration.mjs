// Starts VS Code with the extension and runs test/integration/suite.ts in it.
// Usage: node scripts/integration.mjs [path to the VS Code (Electron) binary]
//
// The test window runs on a hidden virtual display (xvfb-run), so that it does not cover
// other windows or take the focus. Set MDIFF_SHOW_WINDOW=1 to run it on the real display.
//
// MDIFF_QUARTO_BUILD=1 also tries the experimental Quarto build (test/integration/quarto.ts) on a
// small Python report. It needs Quarto and uv, and makes the report's environment with uv.
import * as esbuild from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const code = process.argv[2] ?? process.env.VSCODE_BIN ?? '/snap/code/current/usr/share/code/code';
const out = resolve('test/out/integration');
const quartoBuild = process.env.MDIFF_QUARTO_BUILD === '1';
// The Quarto build is tried under a folder whose name starts with a dot, as VS Code's storage is
// on Linux (~/.config): Quarto leaves such files out of their project.
const home = quartoBuild ? resolve(out, '.dot') : out;
const ws = resolve(home, 'ws');
const userData = resolve(home, 'user-data');

await esbuild.build({
  entryPoints: ['test/integration/suite.ts'],
  outfile: resolve(out, 'suite.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});

rmSync(ws, { recursive: true, force: true });
// The results of Quarto builds of an earlier run.
const storage = resolve(userData, 'User', 'globalStorage', 'konstantinsofeikov.mdiff');
rmSync(storage, { recursive: true, force: true });
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
// A uv project with a report whose numbers come from a data file, and a report.md of the user's
// own next to it, which a build must not touch.
const fx = (p) => resolve('test/fixtures/quarto-build', p);
if (quartoBuild) {
  mkdirSync(resolve(ws, 'report'));
  mkdirSync(resolve(ws, 'data'));
  copyFileSync(fx('pyproject.toml'), resolve(ws, 'pyproject.toml'));
  copyFileSync(fx('report/report.qmd'), resolve(ws, 'report/report.qmd'));
  copyFileSync(fx('report/metrics.py'), resolve(ws, 'report/metrics.py'));
  copyFileSync(fx('data/scores.old.csv'), resolve(ws, 'data/scores.csv'));
  writeFileSync(resolve(ws, 'report/report.md'), 'My own report.md\n');
  writeFileSync(resolve(ws, '.gitignore'), '.venv/\n');
  // A Quarto project, whose files Quarto leaves out under a hidden folder unless it gets another path.
  writeFileSync(resolve(ws, '_quarto.yml'), 'project:\n  type: default\n');
  execFileSync('uv', ['lock', '-q'], { cwd: ws, stdio: 'inherit' });
}
git('add', '.');
git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'old');
writeFileSync(resolve(ws, 'doc.md'), withTail('test/fixtures/new.md'));
copyFileSync('test/fixtures/quarto-new.qmd', resolve(ws, 'doc.qmd'));
if (quartoBuild) {
  // New data, and one more sentence: the first paragraph's source stays the same.
  copyFileSync(fx('data/scores.new.csv'), resolve(ws, 'data/scores.csv'));
  writeFileSync(resolve(ws, 'report/report.qmd'), readFileSync(fx('report/report.qmd'), 'utf8') + '\nThe numbers come from the scores file.\n');
}

const showWindow = process.env.MDIFF_SHOW_WINDOW === '1';
const hasXvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
if (!showWindow && !hasXvfb) {
  console.error('xvfb-run is not installed. Install it (sudo apt install xvfb), or set MDIFF_SHOW_WINDOW=1 to open the test window on your display.');
  process.exit(2);
}
const [command, prefix] = showWindow ? [code, []] : ['xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', code]];
// In a Wayland session, Electron opens its window on Wayland and ignores the virtual X display.
// Without WAYLAND_DISPLAY, and with the X11 backend, the window stays on the virtual display.
const env = { ...process.env, MDIFF_TEST_STORAGE: storage };
if (!showWindow) delete env.WAYLAND_DISPLAY;
const hidden = showWindow ? [] : ['--ozone-platform=x11'];

const result = spawnSync(command, [
  ...prefix,
  ws,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${resolve(out, 'suite.js')}`,
  `--user-data-dir=${userData}`,
  `--extensions-dir=${resolve(out, 'extensions')}`,
  '--disable-extensions',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--no-sandbox',
  ...hidden,
], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
