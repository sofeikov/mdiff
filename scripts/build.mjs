// Bundles the extension and the preview CLI, and copies the KaTeX assets.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');

// The webview loads the woff2 fonts, so the woff and ttf copies are left out of the package.
rmSync('media/katex', { recursive: true, force: true });
mkdirSync('media/katex/fonts', { recursive: true });
const css = readFileSync('node_modules/katex/dist/katex.min.css', 'utf8').replace(/,url\([^)]+\.(woff|ttf)\) format\("(woff|truetype)"\)/g, '');
writeFileSync('media/katex/katex.min.css', css);
for (const font of readdirSync('node_modules/katex/dist/fonts').filter((f) => f.endsWith('.woff2'))) {
  copyFileSync(`node_modules/katex/dist/fonts/${font}`, `media/katex/fonts/${font}`);
}

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  // The KaTeX plugin loads katex.js with require, and the formula diff loads katex with import,
  // which resolves to katex.mjs. Use one file for both, so that the bundle has one copy.
  alias: { katex: './node_modules/katex/dist/katex.js' },
};

const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'], minify: !watch }),
  esbuild.context({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js' }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
