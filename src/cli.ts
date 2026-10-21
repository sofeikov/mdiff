// Writes the rendered diff of two Markdown files to a standalone HTML page.
// Usage: node dist/cli.js OLD.md NEW.md OUT.html
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { diffMarkdown } from './core/diff';
import { createMarkdown } from './core/markdown';
import { buildShell } from './core/page';

const [oldPath, newPath, outPath] = process.argv.slice(2);
if (!oldPath || !newPath || !outPath) {
  console.error('Usage: node dist/cli.js OLD.md NEW.md OUT.html');
  process.exit(2);
}

const root = resolve(__dirname, '..');
const outDir = dirname(resolve(outPath));
const asset = (p: string) => relative(outDir, resolve(root, p));

const result = diffMarkdown(createMarkdown(), readFileSync(oldPath, 'utf8'), readFileSync(newPath, 'utf8'));
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
  },
});
writeFileSync(outPath, html);
console.log(`${outPath}: ${result.hunks} hunks, ${result.changed} changed, ${result.added} added, ${result.removed} removed`);
