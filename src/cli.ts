// Writes the rendered diff of two Markdown or Quarto files to a standalone HTML page.
// Usage: node dist/cli.js OLD.md NEW.md OUT.html
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { diffMarkdown } from './core/diff';
import { loadBibliography } from './bibliography';
import { createMarkdown, isQuartoPath } from './core/markdown';
import { buildShell } from './core/page';

const [oldPath, newPath, outPath] = process.argv.slice(2);
if (!oldPath || !newPath || !outPath) {
  console.error('Usage: node dist/cli.js OLD.md NEW.md OUT.html');
  process.exit(2);
}

const root = resolve(__dirname, '..');
const outDir = dirname(resolve(outPath));
const asset = (p: string) => relative(outDir, resolve(root, p));

const oldSource = readFileSync(oldPath, 'utf8');
const newSource = readFileSync(newPath, 'utf8');
const quarto = isQuartoPath(oldPath) || isQuartoPath(newPath);
const bibliography = quarto ? loadBibliography(newPath, newSource) : undefined;
const result = diffMarkdown(createMarkdown({ quarto }), oldSource, newSource, { formulaParts: true, bibliography });
const html = buildShell({
  cspSource: "'self' file:",
  nonce: 'standalone',
  katexCss: asset('media/katex/katex.min.css'),
  previewCss: asset('media/preview.css'),
  previewJs: asset('media/preview.js'),
  initial: {
    type: 'update',
    title: basename(newPath),
    labelA: oldPath,
    labelB: newPath,
    reset: true,
    ...result,
    // The page shows `rows`, as the webview does; the same rows joined would double the page.
    html: '',
  },
});
writeFileSync(outPath, html);
console.log(`${outPath}: ${result.hunks} hunks, ${result.changed} changed, ${result.added} added, ${result.removed} removed`);
