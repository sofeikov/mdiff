import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Bibliography, bibliographyPaths, parseBibtex } from './core/quarto';

/** Parsed files by path, with the modification time when they were read. */
const cache = new Map<string, { mtimeMs: number; bib: Bibliography }>();

/** The last merged bibliography, by its files and their modification times. */
let lastMerged: { key: string; bib: Bibliography } | undefined;

/**
 * Reads the BibTeX files that the front matter of a Quarto document names, relative to the
 * document. A file that does not exist or is not BibTeX is skipped. Returns undefined when the
 * document names no file that could be read.
 *
 * While the files do not change, the result is the same object, so the diff can reuse the
 * parsed documents that used it.
 */
export function loadBibliography(docPath: string, source: string): Bibliography | undefined {
  const files: { file: string; mtimeMs: number }[] = [];
  for (const p of bibliographyPaths(source)) {
    if (!/\.bib$/i.test(p)) continue;
    const file = resolve(dirname(docPath), p);
    try {
      files.push({ file, mtimeMs: statSync(file).mtimeMs });
    } catch {
      // A missing file: its citations show their keys.
    }
  }
  if (files.length === 0) return undefined;
  const key = files.map((f) => `${f.file}\u0000${f.mtimeMs}`).join('\u0000');
  if (lastMerged?.key === key) return lastMerged.bib;
  const merged: Bibliography = new Map();
  for (const { file, mtimeMs } of files) {
    let entry = cache.get(file);
    if (!entry || entry.mtimeMs !== mtimeMs) {
      try {
        entry = { mtimeMs, bib: parseBibtex(readFileSync(file, 'utf8')) };
      } catch {
        continue;
      }
      cache.set(file, entry);
    }
    for (const [k, v] of entry.bib) merged.set(k, v);
  }
  lastMerged = { key, bib: merged };
  return merged;
}
