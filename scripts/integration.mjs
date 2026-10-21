// Starts VS Code with the extension and runs test/integration/suite.ts in it.
// Usage: node scripts/integration.mjs [path to the VS Code (Electron) binary]
//
// The test window runs on a hidden virtual display (xvfb-run), so that it does not cover
// other windows or take the focus. Set MDIFF_SHOW_WINDOW=1 to run it on the real display.
import * as esbuild from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
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
copyFileSync('test/fixtures/old.md', resolve(ws, 'doc.md'));
git('add', 'doc.md');
git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'old');
copyFileSync('test/fixtures/new.md', resolve(ws, 'doc.md'));

const showWindow = process.env.MDIFF_SHOW_WINDOW === '1';
const hasXvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
if (!showWindow && !hasXvfb) {
  console.error('xvfb-run is not installed. Install it (sudo apt install xvfb), or set MDIFF_SHOW_WINDOW=1 to open the test window on your display.');
  process.exit(2);
}
const [command, prefix] = showWindow ? [code, []] : ['xvfb-run', ['-a', code]];

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
], { stdio: 'inherit' });
process.exit(result.status ?? 1);
