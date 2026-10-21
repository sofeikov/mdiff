// Takes the README screenshots: starts VS Code with the extension on a hidden X display,
// opens the change of docs/demo/new.md from the Source Control view and saves PNG files.
// Usage: node scripts/screenshots.mjs [path to the VS Code (Electron) binary]
// Needs Xvfb, xwd and xdotool, and Python with Pillow for the conversion to PNG.
import * as esbuild from 'esbuild';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const code = process.argv[2] ?? process.env.VSCODE_BIN ?? '/snap/code/current/usr/share/code/code';
const out = resolve('test/out/shots');
const ws = resolve(out, 'ws');
const raw = resolve(out, 'raw');
const display = ':97';

await esbuild.build({
  entryPoints: ['test/integration/shots.ts'],
  outfile: resolve(out, 'shots.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});

rmSync(out + '/ws', { recursive: true, force: true });
rmSync(raw, { recursive: true, force: true });
rmSync(resolve(out, 'user-data'), { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
mkdirSync(raw, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', ws, ...args], { stdio: 'ignore' });
git('init', '-q');
copyFileSync('docs/demo/old.md', resolve(ws, 'value-estimates.md'));
git('add', '.');
git('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'old');
copyFileSync('docs/demo/new.md', resolve(ws, 'value-estimates.md'));

// A clean window: no AI panels, no welcome page, no minimap.
const settingsDir = resolve(out, 'user-data', 'User');
mkdirSync(settingsDir, { recursive: true });
writeFileSync(resolve(settingsDir, 'settings.json'), JSON.stringify({
  'chat.disableAIFeatures': true,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.layoutControl.enabled': false,
  'window.commandCenter': false,
  'editor.minimap.enabled': false,
  'diffEditor.hideUnchangedRegions.enabled': false,
  'git.openRepositoryInParentFolders': 'never',
  'update.mode': 'none',
  'extensions.ignoreRecommendations': true,
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
}, null, 2));

const xvfb = spawn('Xvfb', [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1000));
let status = 1;
try {
  const result = spawnSync(code, [
    ws,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${resolve(out, 'shots.js')}`,
    `--user-data-dir=${resolve(out, 'user-data')}`,
    `--extensions-dir=${resolve(out, 'extensions')}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-sandbox',
  ], { stdio: 'inherit', env: { ...process.env, DISPLAY: display, MDIFF_SHOTS_DIR: raw } });
  status = result.status ?? 1;
} finally {
  xvfb.kill();
}
if (status !== 0) process.exit(status);

execFileSync('python3', ['-I', resolve('scripts/xwd2png.py'), raw], { stdio: 'inherit' });

// Images: [capture, crop box (left, top, right, bottom)] for the 1600x1000 window. The overview
// drops the title bar; the close-ups show only the rendered diff panel.
const crops = {
  overview: ['overview', [0, 30, 1600, 1000]],
  paragraphs: ['paragraphs', [518, 34, 1600, 480]],
  formulas: ['sections', [518, 160, 1600, 565]],
  tables: ['sections', [518, 560, 1600, 965]],
};
mkdirSync('images', { recursive: true });
execFileSync('python3', ['-I', '-c', `
import json, sys
from PIL import Image
crops = json.loads(sys.argv[1])
for name, (capture, box) in crops.items():
    Image.open(f"{sys.argv[2]}/{capture}.png").crop(tuple(box)).save(f"images/{name}.png", optimize=True)
    print("images/" + name + ".png")
`, JSON.stringify(crops), raw], { stdio: 'inherit' });
