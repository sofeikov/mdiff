import { readFileSync, statSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { loadBibliography, loadBibliographyFiles } from './bibliography';
import { Bibliography, bibliographyPaths, includeArgs, mergeMeta, QuartoContext, readYaml } from './core/quarto';

/**
 * What a Quarto document takes from the files around it, read from disk: the nearest
 * `_quarto.yml` above it and the `_metadata.yml` files between, the project's `_variables.yml`,
 * the bibliography (the document's own, or the project's), and the files it includes, two levels
 * down.
 *
 * While none of these files change, the result is the same objects, so the diff can reuse the
 * parsed documents that used them, as it does for the bibliography.
 */
export function loadQuarto(docPath: string, source: string): { bibliography: Bibliography | undefined; context: QuartoContext } {
  const used: string[] = [];
  const read = (file: string) => {
    const r = readCached(file);
    used.push(`${file}\u0000${r?.mtimeMs ?? -1}`);
    return r?.text;
  };
  const dirs = parentDirs(dirname(docPath));
  const k = dirs.findIndex((d) => read(join(d, '_quarto.yml')) !== undefined);
  const projectDir = k < 0 ? undefined : dirs[k];
  let project: Record<string, unknown> | undefined;
  let vars: Record<string, unknown> | undefined;
  if (projectDir !== undefined) {
    // `project:` holds the project's own settings, not metadata.
    const own = { ...readYaml(read(join(projectDir, '_quarto.yml'))) };
    delete own.project;
    // Directory metadata applies from the project folder down to the document's.
    const metas = dirs.slice(0, k + 1).reverse().map((d) => readYaml(read(join(d, '_metadata.yml'))));
    project = mergeMeta(own, ...metas);
    vars = readYaml(read(join(projectDir, '_variables.yml')));
  }
  const resolveInclude = (from: string, arg: string) => (arg.startsWith('/') ? join(projectDir ?? dirname(from), arg.slice(1)) : resolve(dirname(from), arg));
  const includes = new Map<string, string>();
  let todo = includeArgs(source).map((a) => resolveInclude(docPath, a));
  for (let depth = 0; depth < 3 && todo.length; depth++) {
    const next: string[] = [];
    for (const file of todo) {
      const text = includes.has(file) ? undefined : read(file);
      if (text === undefined) continue;
      includes.set(file, text);
      next.push(...includeArgs(text).map((a) => resolveInclude(file, a)));
    }
    todo = next;
  }
  // A bibliography is relative to the file that names it: the document, or the project.
  const bibliography = bibliographyPaths(source).length
    ? loadBibliography(docPath, source)
    : projectDir !== undefined && project?.bibliography !== undefined
      ? loadBibliographyFiles(names(project.bibliography).map((n) => resolve(projectDir, n)))
      : undefined;
  const key = [docPath, ...used].join('\u0001');
  if (last?.key === key && last.bibliography === bibliography) return last.result;
  const result = { bibliography, context: { path: docPath, project, vars, includes, resolveInclude } };
  last = { key, bibliography, result };
  return result;
}

let last: { key: string; bibliography: Bibliography | undefined; result: ReturnType<typeof loadQuarto> } | undefined;

/** Files by path, with the modification time when they were read; a missing file has none. */
const cache = new Map<string, { mtimeMs: number; text: string } | null>();

function readCached(file: string): { mtimeMs: number; text: string } | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  try {
    const entry = { mtimeMs, text: readFileSync(file, 'utf8') };
    cache.set(file, entry);
    return entry;
  } catch {
    return undefined;
  }
}

/** The folder and each one above it, up to the root. */
function parentDirs(dir: string): string[] {
  const out = [dir];
  const root = parse(dir).root;
  while (out[out.length - 1] !== root && dirname(out[out.length - 1]) !== out[out.length - 1]) out.push(dirname(out[out.length - 1]));
  return out;
}

function names(value: unknown): string[] {
  return typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}
