// Bundles the extension and the preview CLI, and copies the KaTeX assets.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('media/katex', { recursive: true, force: true });
mkdirSync('media/katex', { recursive: true });
cpSync('node_modules/katex/dist/katex.min.css', 'media/katex/katex.min.css');
cpSync('node_modules/katex/dist/fonts', 'media/katex/fonts', { recursive: true });

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
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
  esbuild.context({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js' }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
