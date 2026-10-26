// A/B benchmark of the diff core: the code at a git ref ("before") against the working tree ("after").
//
// Usage: node --expose-gc scripts/bench.mjs [--before REF] [--runs N] OLD.md NEW.md [OLD2.md NEW2.md ...]
//
// For each pair of files and each mode, the two builds run in random order, once per round.
// The result is the paired difference before − after: its mean and a 95% bootstrap confidence
// interval. A change is faster only when the whole interval is above 0.
//   cold: a new parser for each call, as when the panel opens.
//   warm: the same parser for each call, and a new edit at the end of the new file each time,
//         as on a live update while the reader edits. The old file stays the same.
import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const k = args.indexOf(name);
  if (k < 0) return fallback;
  const [value] = args.splice(k, 2).slice(1);
  return value;
};
const beforeRef = opt('--before', 'HEAD');
const runs = Number(opt('--runs', '60'));
const files = args;
if (files.length < 2 || files.length % 2) {
  console.error('Usage: node --expose-gc scripts/bench.mjs [--before REF] [--runs N] OLD.md NEW.md [...]');
  process.exit(2);
}
if (typeof globalThis.gc !== 'function') {
  console.error('Run with node --expose-gc.');
  process.exit(2);
}

const root = resolve('.');
const out = resolve('test/out/bench');
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'before'), { recursive: true });
execSync(`git archive ${beforeRef} src | tar -x -C ${resolve(out, 'before')}`);

const entry = "export { diffMarkdown } from './core/diff'; export { createMarkdown } from './core/markdown';";
async function bundle(srcDir, name) {
  const outfile = resolve(out, `${name}.cjs`);
  await esbuild.build({
    stdin: { contents: entry, resolveDir: srcDir, loader: 'ts' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    nodePaths: [resolve(root, 'node_modules')],
    alias: { katex: resolve(root, 'node_modules/katex/dist/katex.js') },
    logLevel: 'error',
  });
  return createRequire(import.meta.url)(outfile);
}
const builds = {
  before: await bundle(resolve(out, 'before/src'), 'before'),
  after: await bundle(resolve(root, 'src'), 'after'),
};

const cases = [];
for (let k = 0; k < files.length; k += 2) {
  const quarto = /\.qmd$/i.test(files[k]) || /\.qmd$/i.test(files[k + 1]);
  cases.push({ name: `${basename(files[k])} → ${basename(files[k + 1])}`, a: readFileSync(files[k], 'utf8'), b: readFileSync(files[k + 1], 'utf8'), quarto });
}

// Both builds must give the same output, or the comparison means nothing.
const parser = (build, c) => build.createMarkdown({ quarto: c.quarto });
for (const c of cases) {
  const x = builds.before.diffMarkdown(parser(builds.before, c), c.a, c.b).html;
  const y = builds.after.diffMarkdown(parser(builds.after, c), c.a, c.b).html;
  if (x !== y) console.warn(`WARNING: the output differs for ${c.name}`);
}

function time(build, c, mode, md, edit) {
  globalThis.gc();
  const b = mode === 'cold' ? c.b : `${c.b}\nEdit ${edit}.\n`;
  const t0 = performance.now();
  build.diffMarkdown(mode === 'cold' ? parser(build, c) : md, c.a, b);
  return performance.now() - t0;
}

function bootstrapCI(d, n = 10000) {
  const means = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < d.length; j++) s += d[Math.floor(Math.random() * d.length)];
    means[i] = s / d.length;
  }
  means.sort();
  return [means[Math.floor(n * 0.025)], means[Math.floor(n * 0.975)]];
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const median = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
const f = (x) => x.toFixed(2).padStart(8);

console.log(`before = ${beforeRef}, after = working tree, ${runs} rounds\n`);
console.log('case                               mode   before ms  after ms   diff ms  95% CI of diff        result');
for (const c of cases) {
  for (const mode of ['cold', 'warm']) {
    const md = { before: parser(builds.before, c), after: parser(builds.after, c) };
    // Warm-up: let the JIT settle and fill any per-parser caches.
    let edit = 0;
    for (let i = 0; i < 5; i++, edit++) for (const k of ['before', 'after']) time(builds[k], c, mode, md[k], edit);
    const t = { before: [], after: [] };
    for (let i = 0; i < runs; i++, edit++) {
      const order = Math.random() < 0.5 ? ['before', 'after'] : ['after', 'before'];
      for (const k of order) t[k].push(time(builds[k], c, mode, md[k], edit));
    }
    const d = t.before.map((x, i) => x - t.after[i]);
    const [lo, hi] = bootstrapCI(d);
    const result = lo > 0 ? `faster (${(mean(t.before) / mean(t.after)).toFixed(2)}x)` : hi < 0 ? 'SLOWER' : 'no clear change';
    console.log(`${c.name.slice(0, 34).padEnd(34)} ${mode}  ${f(median(t.before))}  ${f(median(t.after))}  ${f(mean(d))}  [${f(lo)}, ${f(hi)}]  ${result}`);
  }
}
