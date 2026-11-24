import type { MarkdownIt, RendererRule, StateBlock, StateCore, StateInline, Token } from 'markdown-it';
import yaml from 'js-yaml';
import { OPTION_LINE, outputsKey, RunCursor, type QuartoRun, type RunCell, type RunExpr, type RunOutput } from './quartoRun';

/**
 * Quarto syntax on top of Markdown: attributes of headings, section numbers, cross-references,
 * table captions, equation labels, citations, fenced divs, code cells with their options
 * (`#| echo: false`, figure labels and captions), inline expressions, shortcodes and includes.
 * What a document takes from its project (`_quarto.yml` and the rest) is read by `project.ts`.
 *
 * Nothing here runs Quarto. The rules imitate the text that Quarto shows, close enough for a
 * review. Numbers and citations are resolved when a document is parsed, one document at a time, so
 * the old and the new side each show their own numbers. When a version was built with Quarto
 * (`quartoRun.ts`, experimental), its inline expressions show their values and its cells their
 * outputs, still in the blocks of the source.
 *
 * A diff compares a cross-reference by its id and a citation by its keys, not by the text that
 * they show. A new section changes the numbers of the sections after it, but the references to
 * them do not show as changes. In the same way, a section number is shown but not compared.
 */

/** The author names and year of each entry of a bibliography, by key. */
export type Bibliography = Map<string, { authors: string[]; year: string }>;

/** What a cross-reference can point to. */
interface Target {
  /** For example `Section`, `Table`. */
  prefix: string;
  /** The number, or undefined for an unnumbered section. */
  num?: string;
  /** The heading text, for an unnumbered section. */
  title?: string;
}

/** The state of the Quarto rules for one document, in the parser env. */
interface QuartoState {
  /** Equation labels by the 0-based line of the closing `$$`. */
  eqLabels: Map<number, string>;
  targets: Map<string, Target>;
}

/** Set in the env when a block is rendered for its comparison key, not for display. */
export const KEY_ENV = 'mdiffKey';

/**
 * In the env of a document: what a Quarto build of it computed (`QuartoRun`), and whether the
 * other version of the diff was built too, so that values and outputs are compared.
 */
export const RUN_ENV = 'quartoRun';
export const COMPARE_ENV = 'quartoCompare';

/** Set in the env to render one cell with its outputs marked as changed (see `CellOutputsDiff`). */
export const OUTPUTS_ENV = 'mdiffOutputs';

const XREF_PREFIXES: Record<string, string> = {
  sec: 'Section',
  fig: 'Figure',
  tbl: 'Table',
  eq: 'Equation',
  lst: 'Listing',
  thm: 'Theorem',
  lem: 'Lemma',
  cor: 'Corollary',
  prp: 'Proposition',
  cnj: 'Conjecture',
  def: 'Definition',
  exm: 'Example',
  exr: 'Exercise',
  sol: 'Solution',
  rem: 'Remark',
  alg: 'Algorithm',
};

const CALLOUTS = new Set(['note', 'tip', 'warning', 'important', 'caution']);

/** Cells whose output is a diagram drawn from their source, not a result of running code. */
const DIAGRAMS = new Set(['mermaid', 'dot']);

/** A citation key: Pandoc allows some punctuation inside a key, but not at its end. */
const KEY = /[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&\-+?<>~/]*[\p{L}\p{N}_])?/uy;

/** `{...}` at the end of a heading or a caption. */
const TRAILING_ATTRS = /\s*\{([^{}]*)\}\s*$/;

export interface Attrs {
  id?: string;
  classes: string[];
  values: Record<string, string>;
}

/** Parses Pandoc attributes, for example `#sec-x .unnumbered title="A title"`. A bare word is a class. */
export function parseAttrs(text: string): Attrs {
  const out: Attrs = { classes: [], values: {} };
  const re = /([\w-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))|#(\S+)|\.(\S+)|(\S+)/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) out.values[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
    else if (m[5]) out.id = m[5];
    else if (m[6]) out.classes.push(m[6]);
    else if (m[7] === '-') out.classes.push('unnumbered');
    else if (m[7]) out.classes.push(m[7]);
  }
  return out;
}

function state(env: Record<string, unknown>): QuartoState {
  let s = env.quarto as QuartoState | undefined;
  if (!s) {
    s = { eqLabels: new Map(), targets: new Map() };
    env.quarto = s;
  }
  return s;
}

/** True when the front matter asks for section numbers, at the top level or in one of its formats. */
function numberSections(frontMatter: unknown): boolean {
  if (!frontMatter || typeof frontMatter !== 'object') return false;
  const fm = frontMatter as Record<string, unknown>;
  if (fm['number-sections'] === true) return true;
  const format = fm.format;
  if (format && typeof format === 'object') {
    return Object.values(format).some((f) => !!f && typeof f === 'object' && (f as Record<string, unknown>)['number-sections'] === true);
  }
  return false;
}

/** Reads a value at a dotted path, `a.b.c`, of YAML data. */
export function metaValue(data: unknown, path: string): unknown {
  let v = data;
  for (const k of path.split('.')) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** One output option of the document: at the top level or under any of its formats. */
function formatOption(meta: unknown, key: string): unknown {
  const top = metaValue(meta, key);
  if (top !== undefined) return top;
  const format = metaValue(meta, 'format');
  if (format && typeof format === 'object') {
    for (const f of Object.values(format)) {
      const v = metaValue(f, key);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/** What a Quarto document takes from the files around it, besides its bibliography. */
export interface QuartoContext {
  /** The document's path, for the files it includes. */
  path?: string;
  /** The metadata of the project (`_quarto.yml`, then `_metadata.yml` files), under the front matter's. */
  project?: Record<string, unknown>;
  /** The project's `_variables.yml`, for `{{< var >}}`. */
  vars?: Record<string, unknown>;
  /** The text of the files that `{{< include >}}` names, by their path. */
  includes?: Map<string, string>;
  /** The path of an include's argument, written in the file at `from`. */
  resolveInclude?: (from: string, arg: string) => string | undefined;
}

/** Parses a YAML file as an object; undefined when it isn't one. */
export function readYaml(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const data = yaml.load(text, { schema: yaml.CORE_SCHEMA });
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Metadata merged as Quarto does: objects key by key, anything else replaced by the later value. */
export function mergeMeta(...layers: (Record<string, unknown> | undefined)[]): Record<string, unknown> {
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      const old = out[k];
      out[k] = isObj(old) && isObj(v) ? mergeMeta(old, v) : v;
    }
  }
  return out;
}

const INCLUDE = /\{\{<\s*include\s+("[^"]+"|'[^']+'|\S+)\s*>\}\}/g;
const INCLUDE_ALONE = /^\{\{<\s*include\s+("[^"]+"|'[^']+'|\S+)\s*>\}\}$/;

/** The arguments of the `{{< include … >}}` shortcodes of a document, without quotes. */
export function includeArgs(text: string): string[] {
  return [...new Set([...text.matchAll(INCLUDE)].map((m) => unquote(m[1])))];
}

function unquote(arg: string): string {
  return arg.replace(/^(["'])(.*)\1$/, '$2');
}

/** The bibliography files that the front matter of a document names, as written. */
export function bibliographyPaths(source: string): string[] {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source);
  if (!m || !m[1].includes('bibliography')) return [];
  try {
    const data = yaml.load(m[1]) as Record<string, unknown> | undefined;
    const b = data?.bibliography;
    if (typeof b === 'string') return [b];
    if (Array.isArray(b)) return b.filter((x): x is string => typeof x === 'string');
  } catch {
    // The diff shows the front matter error.
  }
  return [];
}

/** Reads the author names and the year of each entry of a BibTeX file. Other fields are ignored. */
export function parseBibtex(text: string): Bibliography {
  const bib: Bibliography = new Map();
  const entry = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  for (let m = entry.exec(text); m; m = entry.exec(text)) {
    if (/^(comment|string|preamble)$/i.test(m[1])) continue;
    const fields = new Map<string, string>();
    let i = entry.lastIndex;
    // Fields: name = {value} | "value" | bare, up to the closing brace of the entry.
    const field = /\s*([\w-]+)\s*=\s*/y;
    for (;;) {
      field.lastIndex = i;
      const f = field.exec(text);
      if (!f) break;
      i = field.lastIndex;
      let value = '';
      if (text[i] === '{') {
        let depth = 0;
        const start = i;
        for (; i < text.length; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}' && --depth === 0) break;
        }
        value = text.slice(start + 1, i);
        i++;
      } else if (text[i] === '"') {
        const end = text.indexOf('"', i + 1);
        value = text.slice(i + 1, end < 0 ? text.length : end);
        i = end < 0 ? text.length : end + 1;
      } else {
        const bare = /[^,}\s]*/y;
        bare.lastIndex = i;
        value = bare.exec(text)![0];
        i = bare.lastIndex;
      }
      fields.set(f[1].toLowerCase(), value);
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === ',') i++;
      else break;
    }
    entry.lastIndex = i;
    const names = fields.get('author') ?? fields.get('editor') ?? '';
    const authors = names ? names.split(/\s+and\s+/).map(lastName).filter(Boolean) : [];
    const year = (fields.get('year') ?? fields.get('date') ?? '').match(/\d{4}/)?.[0] ?? 'n.d.';
    bib.set(m[2], { authors, year });
  }
  return bib;
}

/** The family name of a BibTeX name: `Last, First` or `First Last`. Braces and accents are removed. */
function lastName(name: string): string {
  const clean = name
    .replace(/\\[`'^"~=.]\{?(\w)\}?/g, '$1')
    .replace(/[{}]/g, '')
    .trim();
  if (clean.includes(',')) return clean.split(',')[0].trim();
  // A braced name such as {Real Analytics} is one name.
  if (/^\{[^{}]*\}$/.test(name.trim())) return clean;
  const words = clean.split(/\s+/);
  return words[words.length - 1];
}

function authorText(authors: string[]): string {
  if (authors.length === 0) return '';
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} and ${authors[1]}`;
  return `${authors[0]} et al.`;
}

/** The meta of a `quarto_xref` token. */
interface XrefMeta {
  refs: { id: string; suppress: boolean }[];
  text?: string;
  missing?: boolean;
}

/** The meta of a `quarto_cite` token. */
interface CiteMeta {
  items: CiteItem[];
  bracket: boolean;
  text?: string;
  missing?: boolean;
}

interface CiteItem {
  prefix: string;
  suppress: boolean;
  key: string;
  suffix: string;
}

/** The text of a citation, in the author-date style of Quarto's default. */
function citeText(items: CiteItem[], bracket: boolean, bib: Bibliography | undefined): { text: string; missing: boolean } {
  let missing = false;
  const one = (it: CiteItem, inText: boolean) => {
    const e = bib?.get(it.key);
    if (!bib) return it.key;
    if (!e) {
      missing = true;
      return `?${it.key}`;
    }
    const who = authorText(e.authors) || it.key;
    if (it.suppress) return e.year;
    return inText ? `${who} (${e.year})` : `${who} ${e.year}`;
  };
  if (!bracket) return { text: one(items[0], true), missing };
  const parts = items.map((it) => [it.prefix.trim(), one(it, false)].filter(Boolean).join(' ') + it.suffix.replace(/\s+$/, ''));
  return { text: `(${parts.join('; ')})`, missing };
}

function xrefKind(key: string): string | undefined {
  const m = /^([A-Za-z]+)-/.exec(key);
  return m && XREF_PREFIXES[m[1].toLowerCase()] ? m[1].toLowerCase() : undefined;
}

/** Core rule before `block`: removes the `{#eq-…}` label after a closing `$$`, which the KaTeX plugin does not read. */
function eqLabelsRule(s: StateCore): void {
  if (!s.src.includes('{#eq-')) return;
  const labels = state(s.env).eqLabels;
  const lines = s.src.split('\n');
  lines.forEach((line, k) => {
    const m = /^(.*\$\$)[ \t]*\{#(eq-[^}\s]+)\}[ \t]*$/.exec(line);
    if (!m) return;
    labels.set(k, m[2]);
    lines[k] = m[1];
  });
  s.src = lines.join('\n');
}

/**
 * Core rule between `block` and `inline`: reads the attributes of headings, table captions,
 * images and divs, and numbers sections, tables, figures and equations in document order.
 */
function blocksRule(s: StateCore): void {
  const q = state(s.env);
  // Made now, before an include copies the env, so that the include takes values from the same cursor.
  const cursor = runCursor(s.env);
  const tokens = s.tokens;
  const numbered = numberSections(s.env.frontMatter);
  const count: Record<string, number> = {};
  const next = (kind: string) => String((count[kind] = (count[kind] ?? 0) + 1));
  const register = (id: string | undefined, target: Target) => {
    if (id && !q.targets.has(id)) q.targets.set(id, target);
  };

  // Section numbers start at the highest heading level of the body, as Quarto does.
  let top = 7;
  for (const t of tokens) if (t.type === 'heading_open') top = Math.min(top, Number(t.tag.slice(1)));
  const counters: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const inline = tokens[i + 1]?.type === 'inline' ? tokens[i + 1] : undefined;
    if (tok.type === 'heading_open' && inline) {
      const m = TRAILING_ATTRS.exec(inline.content);
      const attrs = m ? parseAttrs(m[1]) : { classes: [], values: {} };
      if (m) inline.content = inline.content.slice(0, m.index);
      if (attrs.id) tok.attrSet('id', attrs.id);
      const unnumbered = attrs.classes.includes('unnumbered');
      let num: string | undefined;
      if (numbered && !unnumbered) {
        const depth = Number(tok.tag.slice(1)) - top;
        counters.length = depth + 1;
        for (let d = 0; d < depth; d++) counters[d] ??= 0;
        counters[depth] = (counters[depth] ?? 0) + 1;
        num = counters.join('.');
      }
      tok.meta = { ...tok.meta, secnum: num };
      if (attrs.id?.startsWith('sec-')) register(attrs.id, { prefix: XREF_PREFIXES.sec, num, title: inline.content.trim() });
    } else if (tok.type === 'paragraph_open' && inline && isCaption(tokens, i, inline)) {
      let content = inline.content.replace(/^(?:Table)?:\s+/, '');
      const m = TRAILING_ATTRS.exec(content);
      const attrs = m ? parseAttrs(m[1]) : undefined;
      if (m) content = content.slice(0, m.index);
      inline.content = content;
      tok.attrSet('class', 'tbl-cap');
      const id = attrs?.id;
      const num = id?.startsWith('tbl-') ? next('tbl') : undefined;
      tok.meta = { ...tok.meta, caption: num ? `Table ${num}` : undefined };
      if (id && num) {
        tok.attrSet('id', id);
        register(id, { prefix: XREF_PREFIXES.tbl, num });
      }
      const cell = asisCell(tokens[i - 1]);
      if (cell) cell.writesTable = true;
    } else if (tok.type === 'fence' && cellLanguage(tok.info)) {
      const info = cellInfo(cellLanguage(tok.info)!, tok.content, s.env.frontMatter);
      const targets = info.targets.map((t) => ({ ...t, num: next(t.kind) }));
      for (const t of targets) register(t.id, { prefix: XREF_PREFIXES[t.kind], num: t.num });
      const run = cursor && info.code !== 'excluded' && !info.diagram ? cursor.cell(tok.content) : undefined;
      // With a run of both versions, a cell whose outputs changed is a change, whatever its code.
      const diffKey = cursor && s.env[COMPARE_ENV] ? outputsKey(shownOutputs(info, run)) : undefined;
      const ran = cursor && !info.diagram ? { ran: true, ...(run ? { run } : {}) } : {};
      tok.meta = { ...tok.meta, cell: { ...info, targets, ...ran } satisfies CellInfo, ...(diffKey ? { diffKey } : {}) };
    } else if (tok.type === 'paragraph_open' && inline && tokens[i + 2]?.type === 'paragraph_close' && INCLUDE_ALONE.test(inline.content.trim())) {
      // An include on its own line: the included file, rendered in its place.
      tok.type = 'html_block';
      tok.tag = '';
      tok.nesting = 0;
      tok.content = includeHtml(s, unquote(INCLUDE_ALONE.exec(inline.content.trim())![1]));
      tokens.splice(i + 1, 2);
    } else if (tok.type === 'math_block' && tok.map) {
      const label = q.eqLabels.get(tok.map[1] - 1);
      if (label) {
        const num = next('eq');
        tok.meta = { ...tok.meta, eqnum: num, eqid: label };
        register(label, { prefix: XREF_PREFIXES.eq, num });
      }
    } else if (tok.type === 'quarto_div_open') {
      const id = (tok.meta as { attrs: Attrs }).attrs.id;
      const kind = id ? xrefKind(id) : undefined;
      if (id && kind && kind !== 'sec') register(id, { prefix: XREF_PREFIXES[kind], num: next(kind) });
    } else if (tok.type === 'inline' && tok.content.includes('){#fig-')) {
      // A figure: ![caption](path){#fig-x}. Remove the attributes, which markdown-it shows as text.
      tok.content = tok.content.replace(/(!\[[^\]]*\]\([^)]*\))\{([^}]*)\}/g, (_all, image: string, text: string) => {
        const id = parseAttrs(text).id;
        if (id?.startsWith('fig-')) {
          register(id, { prefix: XREF_PREFIXES.fig, num: next('fig') });
          // The figure's paragraph carries its id, which a click on `@fig-…` scrolls to.
          const open = tokens[i - 1];
          if (open?.type === 'paragraph_open' && !open.attrGet('id')) open.attrSet('id', id);
        }
        return image;
      });
    }
  }
}

/** A paragraph that starts with `: ` or `Table: ` right before or after a table is its caption. */
function isCaption(tokens: Token[], open: number, inline: Token): boolean {
  if (!/^(?:Table)?:\s/.test(inline.content)) return false;
  return tokens[open - 1]?.type === 'table_close' || tokens[open + 3]?.type === 'table_open' || !!asisCell(tokens[open - 1]);
}

/** A cell that writes Markdown: the caption right after it is that of the table it writes. */
function asisCell(tok: Token | undefined): CellInfo | undefined {
  const cell = tok?.type === 'fence' ? (tok.meta as { cell?: CellInfo } | null)?.cell : undefined;
  return cell?.asis ? cell : undefined;
}

/**
 * An included file in its place, rendered by itself: its sections and figures are numbered apart
 * from the document's, and the whole of it is one block.
 */
function includeHtml(s: StateCore, arg: string): string {
  const esc = s.md.utils.escapeHtml;
  const ctx = s.env.quartoContext as QuartoContext | undefined;
  const depth = (s.env.includeDepth as number | undefined) ?? 0;
  const path = ctx?.path !== undefined ? ctx.resolveInclude?.(ctx.path, arg) : undefined;
  const text = path !== undefined && depth < 3 ? ctx?.includes?.get(path) : undefined;
  if (text === undefined) {
    return `<div class="qinclude missing"><div class="qinclude-label">Includes <code>${esc(arg)}</code>, which can't be read</div></div>\n`;
  }
  const body = text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
  const child = { ...s.env, quarto: undefined, quartoContext: { ...ctx, path }, includeDepth: depth + 1 };
  return `<div class="qinclude"><div class="qinclude-label">Included from <code>${esc(arg)}</code></div>${s.md.render(body, child)}</div>\n`;
}

// Code cells -------------------------------------------------------------------------------------

/** A figure or a table that a code cell makes. */
export interface CellTarget {
  id: string;
  kind: 'fig' | 'tbl';
  num: string;
  caption?: string;
}

/** A code cell as the rendered document has it. */
export interface CellInfo {
  lang: string;
  /** How its code shows: as it is, folded under a button, not at all, or the whole cell left out. */
  code: 'shown' | 'folded' | 'hidden' | 'excluded';
  /** It writes Markdown into the document (`output: asis`), such as a table. */
  asis: boolean;
  /** A Mermaid or Graphviz diagram, drawn from its source. */
  diagram: boolean;
  targets: CellTarget[];
  /** It writes Markdown and a table caption follows it: the table is what it writes. */
  writesTable?: boolean;
  /** The document doesn't show the cell's outputs (`output: false`), or its warnings (`warning: false`). */
  noOutput?: boolean;
  noWarning?: boolean;
  /** The document has a run (see quartoRun.ts), and `run` is this cell in it, when it ran. */
  ran?: boolean;
  run?: RunCell;
}

/** How the outputs of a cell differ from the other version's, in a diff of two builds. */
export interface CellOutputsDiff {
  changed: boolean;
  /** The HTML of the outputs that were compared in detail (a table), by their index. */
  html?: (string | undefined)[];
}

/** The options of a code cell, from the `#|` lines at its top. Lines that aren't valid YAML give none. */
export function cellOptions(code: string): Record<string, unknown> {
  const body: string[] = [];
  for (const line of code.split('\n')) {
    const m = OPTION_LINE.exec(line);
    if (!m) break;
    body.push(m[1]);
  }
  return readYaml(body.join('\n')) ?? {};
}

/** The language of an executable cell, `{python}` → `python`; undefined for a raw block or a plain fence. */
export function cellLanguage(info: string): string | undefined {
  return /^\{([A-Za-z][\w-]*)[^}]*\}/.exec(info.trim())?.[1];
}

/**
 * How a code cell shows in the rendered document, from its options and the document's: `echo`,
 * `include` and `output` under `execute:`, `code-fold` as an output option. Without numbers: the
 * caller numbers the targets in document order.
 */
export function cellInfo(lang: string, code: string, meta: unknown): Omit<CellInfo, 'targets'> & { targets: Omit<CellTarget, 'num'>[] } {
  const o = cellOptions(code);
  const exec = (key: string) => o[key] ?? metaValue(meta, `execute.${key}`) ?? metaValue(meta, key);
  const diagram = DIAGRAMS.has(lang.toLowerCase());
  const fold = o['code-fold'] ?? formatOption(meta, 'code-fold');
  const shows: CellInfo['code'] =
    exec('include') === false
      ? 'excluded'
      : (exec('echo') ?? !diagram) === false
        ? 'hidden'
        : fold === true || fold === 'true' || fold === 'hide'
          ? 'folded'
          : 'shown';
  const asis = exec('output') === 'asis';
  const noOutput = exec('output') === false;
  const noWarning = exec('warning') === false;
  const targets: Omit<CellTarget, 'num'>[] = [];
  if (shows !== 'excluded') {
    const label = typeof o.label === 'string' ? o.label : undefined;
    const kind = label ? (/^(fig|tbl)-/.exec(label)?.[1] as 'fig' | 'tbl' | undefined) : undefined;
    if (label && kind) {
      const cap = o[`${kind}-cap`];
      targets.push({ id: label, kind, caption: typeof cap === 'string' ? cap : undefined });
    }
    // A cell that writes Markdown can write a table or a figure with its id, `{#tbl-x}`; in an
    // f-string the braces are doubled.
    if (asis) {
      for (const m of code.matchAll(/\{\{?#((fig|tbl)-[\w-]+)\}?\}/g)) {
        if (!targets.some((t) => t.id === m[1])) targets.push({ id: m[1], kind: m[2] as 'fig' | 'tbl' });
      }
    }
  }
  return { lang, code: shows, asis, diagram, targets, ...(noOutput ? { noOutput } : {}), ...(noWarning ? { noWarning } : {}) };
}

/** The outputs of a cell's run that the rendered document shows. */
export function shownOutputs(cell: Pick<CellInfo, 'code' | 'noOutput' | 'noWarning'>, run: RunCell | undefined): RunOutput[] {
  if (!run || cell.noOutput || cell.code === 'excluded') return [];
  return run.outputs.filter((o) => !(cell.noWarning && o.kind === 'stream' && o.name === 'stderr'));
}

/** The Markdown text of an output, which a diff compares like the document's own: a table a cell writes. */
export function outputMarkdown(cell: Pick<CellInfo, 'asis'>, o: RunOutput | undefined): string | undefined {
  return o?.kind === 'markdown' || (o?.kind === 'stream' && cell.asis && o.name !== 'stderr') ? o.text : undefined;
}

/** HTML of one output of a cell's run. */
function outputHtml(md: MarkdownIt, o: RunOutput, asis: boolean): string {
  const esc = md.utils.escapeHtml;
  const markdown = (text: string) => `<div class="qout-md">${md.render(text, {})}</div>`;
  switch (o.kind) {
    case 'markdown':
      return markdown(o.text);
    case 'image': {
      const src = o.mime === 'image/svg+xml' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(o.data)}` : `data:${esc(o.mime)};base64,${esc(o.data)}`;
      return `<img class="qout-img" alt="" src="${src}">`;
    }
    case 'html':
      // The page runs no scripts of a document, so an interactive plot can't be drawn here.
      return /<script[\s>]/i.test(o.html) ? '<div class="qfig-ph">Interactive output: drawn only in the rendered document</div>' : `<div class="qout-html">${o.html}</div>`;
    case 'stream':
      // What a cell prints with `output: asis` is Markdown of the document.
      return asis && o.name !== 'stderr' ? markdown(o.text) : `<pre class="qout-text${o.name === 'stderr' ? ' stderr' : ''}">${esc(o.text.replace(/\n$/, ''))}</pre>`;
    case 'error':
      return `<pre class="qout-text error">${esc(o.text)}</pre>`;
    default:
      return `<pre class="qout-text">${esc(o.text)}</pre>`;
  }
}

/**
 * The run of the document being parsed, handed out in document order; undefined without one. It
 * is kept in the env, which an included file's env copies, so the include takes its values from
 * the same run.
 */
function runCursor(env: Record<string, unknown>): RunCursor | undefined {
  const run = env[RUN_ENV] as QuartoRun | undefined;
  if (!run) return undefined;
  return (env.quartoRunCursor ??= new RunCursor(run)) as RunCursor;
}

/** What an inline expression token carries: its result in the run, and what the diff compares it by. */
export interface ExprMeta {
  expr: true;
  /** The document has a run: `value` is the expression's result in it, if it has one. */
  ran: boolean;
  value?: RunExpr;
  /** Set when both versions have a run: the value, so a number that changed is a change. */
  diffKey?: string;
}

/** An inline expression, `` `{python} x` ``: its language, its code, and a short form to show. */
export function inlineExpr(code: string): { lang: string; expr: string; short: string } | undefined {
  const m = /^\{([A-Za-z][\w-]*)\}\s+(\S[\s\S]*)$/.exec(code);
  if (!m) return undefined;
  const expr = m[2].trim();
  // An f-string that is one placeholder, `f"{x:.2f}"`, shows as the expression in it, without the
  // conversion and the format spec, which close no bracket.
  const f = /^f(["'])\{([^{}]+)\}\1$/.exec(expr);
  const short = f ? f[2].replace(/(?:![rsa])?(?::[^'"\])}]*)?$/, '').trim() || f[2] : expr;
  return { lang: m[1], expr, short: short.length > 48 ? `${short.slice(0, 47)}…` : short };
}

/**
 * HTML of a code cell: its code, folded away when the document doesn't show it, and a place for
 * each figure or table it makes, with its number and caption. `pre` is the highlighted code;
 * `open` unfolds the code, for a cell whose code changed. For a comparison key, a figure shows its
 * id, not its number, so a new figure before it is not a change.
 *
 * With a run, the cell's outputs take the place of the placeholders, and `outputs` marks them when
 * they differ from the other version's. A comparison key has no outputs, only their hash when both
 * versions were built: a run of one version only is not a change.
 */
export function cellHtml(md: MarkdownIt, tok: Token, pre: string, env: Record<string, unknown> | undefined, open = false, outputs?: CellOutputsDiff): string {
  const esc = md.utils.escapeHtml;
  const cell = (tok.meta as { cell?: CellInfo } | null)?.cell;
  const key = !!env?.[KEY_ENV];
  const label = fenceLabel(tok, esc);
  if (!cell) return `<div class="qcell${tok.info.trim().startsWith('{=') ? ' raw' : ''}">${label}${pre}</div>\n`;
  const caption = (t: CellTarget) => {
    const name = env?.[KEY_ENV] ? t.id : `${t.kind === 'fig' ? 'Figure' : 'Table'} ${t.num}`;
    if (!t.caption) return `<span class="cap-label">${name}</span>${env?.[KEY_ENV] ? '' : ` <code class="qfig-id">${esc(t.id)}</code>`}`;
    return `<span class="cap-label">${name}:</span> ${md.renderInline(t.caption, env ?? {})}`;
  };
  const target = (t: CellTarget, inner: string) => `<figure class="qfig" id="${esc(t.id)}">${inner}<figcaption>${caption(t)}</figcaption></figure>`;
  const lines = tok.content.replace(/\n$/, '').split('\n').length;
  const lang = esc(cell.lang);
  if (cell.diagram && cell.code !== 'excluded') {
    // The page draws a Mermaid diagram from its source (see `mermaid.ts`). A Graphviz one isn't
    // drawn, and its source is the nearest thing to the picture, so it stays in view.
    const drawn = cell.lang.toLowerCase() === 'mermaid';
    const head = `<div class="cell-label">${lang} diagram${drawn ? '' : ' · drawn when the document is rendered'}</div>`;
    const [t, ...rest] = cell.targets;
    return `<div class="qcell diagram">${head}${t ? target(t, pre) : `<figure class="qfig">${pre}</figure>`}${rest.map((x) => target(x, '')).join('')}</div>\n`;
  }
  const ran = cell.ran && !key;
  const made = ran
    ? ranHtml(md, cell, target, outputs)
    : cell.targets.map((t) => target(t, `<div class="qfig-ph">${t.kind === 'fig' ? 'Figure' : 'Table'} made by this cell when the document is rendered</div>`));
  if (!ran && cell.asis && !cell.targets.length) {
    made.push(`<div class="qfig-ph">${cell.writesTable ? 'Table made by this cell when the document is rendered' : 'Writes Markdown into the document when it is rendered'}</div>`);
  }
  const runKey = key ? (tok.meta as { diffKey?: string } | null)?.diffKey : undefined;
  if (runKey) made.push(`<!--run ${runKey}-->`);
  if (cell.code === 'shown') return `<div class="qcell">${label}${pre}${made.join('')}</div>\n`;
  const note = { folded: 'folded in the document', hidden: 'not shown in the document', excluded: 'left out of the document' }[cell.code];
  const summary = `<summary class="cell-label">${lang} · ${lines} line${lines === 1 ? '' : 's'} · ${note}</summary>`;
  return `<div class="qcell code-${cell.code}"><details class="qcode"${open ? ' open' : ''}>${summary}${pre}</details>${made.join('')}</div>\n`;
}

/**
 * What a cell made in the document's run, in place of the placeholders: its outputs, under the
 * number and caption of its figure or table when it has one. Markdown a cell writes brings its
 * own captions, so it is shown as it is.
 */
function ranHtml(md: MarkdownIt, cell: CellInfo, target: (t: CellTarget, inner: string) => string, diff: CellOutputsDiff | undefined): string[] {
  const outputs = shownOutputs(cell, cell.run);
  const changed = diff?.changed ? ' out-chg' : '';
  const body = outputs.map((o, i) => diff?.html?.[i] ?? outputHtml(md, o, cell.asis)).join('');
  const [first, ...rest] = cell.targets;
  if (!outputs.length) {
    // A labelled cell keeps its place, which a reference scrolls to, and says why it is empty.
    const why = !cell.run ? 'Not in the Quarto build of this version' : 'No output in the Quarto build';
    const empty = cell.targets.map((t) => target(t, `<div class="qfig-ph">${why}</div>`));
    // An output that went away is a change too.
    return diff?.changed && !empty.length ? [`<div class="qout out-chg"><div class="qfig-ph">${why}</div></div>`] : empty;
  }
  if (!first || cell.asis) return [`<div class="qout${changed}"${first ? ` id="${md.utils.escapeHtml(first.id)}"` : ''}>${body}</div>`];
  return [target(first, `<div class="qout${changed}">${body}</div>`), ...rest.map((t) => target(t, ''))];
}

/**
 * Core rule after `inline`: resolves cross-references and citations to their text, and inline
 * expressions to their values when the document has a run.
 */
function resolveRule(s: StateCore): void {
  const q = state(s.env);
  const bib = s.env.bibliography as Bibliography | undefined;
  // Not for a piece parsed by itself (a title, a caption): Quarto computes only the body's.
  const cursor = s.inlineMode ? undefined : runCursor(s.env);
  for (const tok of s.tokens) {
    if (tok.type !== 'inline') continue;
    for (const child of tok.children ?? []) {
      if (child.type === 'quarto_xref') {
        const meta = child.meta as unknown as XrefMeta;
        meta.text = meta.refs
          .map(({ id, suppress }) => {
            const t = q.targets.get(id);
            if (!t) {
              meta.missing = true;
              return `?@${id}`;
            }
            if (t.num === undefined) return t.title ?? id;
            return suppress ? t.num : `${t.prefix} ${t.num}`;
          })
          .join('; ');
      } else if (child.type === 'quarto_cite') {
        const meta = child.meta as unknown as CiteMeta;
        const r = citeText(meta.items, meta.bracket, bib);
        meta.text = r.text;
        meta.missing = r.missing;
      } else if (child.type === 'quarto_shortcode') {
        child.meta = { html: shortcodeHtml(child.content, s.env, s.md.utils.escapeHtml) };
      } else if (child.type === 'code_inline' && cursor) {
        const e = inlineExpr(child.content);
        if (e) {
          const value = cursor.expr(e.expr);
          const diffKey = s.env[COMPARE_ENV] ? `=${value?.text ?? ''}` : undefined;
          child.meta = { expr: true, ran: true, ...(value ? { value } : {}), ...(diffKey !== undefined ? { diffKey } : {}) } satisfies ExprMeta;
        }
      }
    }
  }
}

/** Reads one citation item: `prefix @key suffix` or `prefix -@key suffix`. */
function citeItem(text: string): CiteItem | undefined {
  const at = /(^|[\s(])(-?)@/.exec(text);
  if (!at) return undefined;
  const start = at.index + at[1].length + at[2].length + 1;
  KEY.lastIndex = start;
  const key = KEY.exec(text);
  if (!key) return undefined;
  return { prefix: text.slice(0, at.index + at[1].length), suppress: at[2] === '-', key: key[0], suffix: text.slice(KEY.lastIndex) };
}

/** Inline rule: `[@key; see @other, p. 3]`, `[@sec-x]`. Runs before `link`. */
function bracketRule(s: StateInline, silent: boolean): boolean {
  if (s.src.charCodeAt(s.pos) !== 0x5b /* [ */ || s.linkLevel > 0) return false;
  const end = s.src.indexOf(']', s.pos);
  if (end < 0) return false;
  const body = s.src.slice(s.pos + 1, end);
  if (!body.includes('@') || body.includes('[')) return false;
  // `[text](url)` and `[text][ref]` are links.
  const after = s.src.charCodeAt(end + 1);
  if (after === 0x28 /* ( */ || after === 0x5b /* [ */) return false;
  const items: CiteItem[] = [];
  for (const part of body.split(';')) {
    const item = citeItem(part);
    if (!item) return false;
    items.push(item);
  }
  if (!silent) {
    const kinds = items.map((it) => xrefKind(it.key));
    if (kinds.every(Boolean)) pushXref(s, items.map((it) => ({ id: it.key, suppress: it.suppress })), s.src.slice(s.pos, end + 1));
    else pushCite(s, items, true, s.src.slice(s.pos, end + 1));
  }
  s.pos = end + 1;
  return true;
}

/** Inline rule: `@key`, `-@key`, `@sec-x`, `@Sec-x`. Not inside a word, so an e-mail address is text. */
function atRule(s: StateInline, silent: boolean): boolean {
  let pos = s.pos;
  const c = s.src.charCodeAt(pos);
  // Not inside the text of a link.
  if ((c !== 0x40 /* @ */ && c !== 0x2d) /* - */ || s.linkLevel > 0) return false;
  const suppress = c === 0x2d;
  if (suppress) {
    if (s.src.charCodeAt(pos + 1) !== 0x40) return false;
    pos++;
  }
  const before = s.pos > 0 ? s.src[s.pos - 1] : '';
  if (/[\p{L}\p{N}_\\]/u.test(before)) return false;
  KEY.lastIndex = pos + 1;
  const key = KEY.exec(s.src);
  if (!key) return false;
  if (!silent) {
    const raw = s.src.slice(s.pos, KEY.lastIndex);
    if (xrefKind(key[0])) pushXref(s, [{ id: key[0], suppress }], raw);
    else pushCite(s, [{ prefix: '', suppress, key: key[0], suffix: '' }], false, raw);
  }
  s.pos = KEY.lastIndex;
  return true;
}

function pushXref(s: StateInline, refs: { id: string; suppress: boolean }[], raw: string): void {
  // Quarto writes ids as given, but `@Sec-x` points to `sec-x`.
  const norm = refs.map((r) => ({ ...r, id: r.id.replace(/^[A-Z][a-z]*-/, (p) => p.toLowerCase()) }));
  const tok = s.push('quarto_xref', '', 0);
  tok.content = norm.map((r) => (r.suppress ? '-' : '') + r.id).join(';');
  tok.markup = raw;
  tok.meta = { refs: norm } satisfies XrefMeta;
}

function pushCite(s: StateInline, items: CiteItem[], bracket: boolean, raw: string): void {
  const tok = s.push('quarto_cite', '', 0);
  tok.content = raw;
  tok.meta = { items, bracket } satisfies CiteMeta;
}

/** Inline rule: a shortcode, `{{< name args >}}`, shown as it is written. */
function shortcodeRule(s: StateInline, silent: boolean): boolean {
  if (!s.src.startsWith('{{<', s.pos)) return false;
  const end = s.src.indexOf('>}}', s.pos + 3);
  if (end < 0) return false;
  if (!silent) {
    const tok = s.push('quarto_shortcode', '', 0);
    tok.content = s.src.slice(s.pos, end + 3);
  }
  s.pos = end + 3;
  return true;
}

/** The words of a shortcode, `{{< name a "b c" >}}` → `['name', 'a', 'b c']`. */
export function shortcodeArgs(raw: string): string[] {
  const body = /^\{\{<\s*([\s\S]*?)\s*>\}\}$/.exec(raw)?.[1] ?? '';
  return [...body.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/**
 * What a shortcode shows: a value from the metadata or `_variables.yml`, a key, a page break, or
 * the shortcode as written when it is filled in only by Quarto (`env`, `lipsum`, extensions).
 */
function shortcodeHtml(raw: string, env: Record<string, unknown>, esc: (s: string) => string): string {
  const [name, ...args] = shortcodeArgs(raw);
  const chip = (title?: string, missing = false) =>
    `<code class="shortcode${missing ? ' missing' : ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(raw)}</code>`;
  const value = (v: unknown, title: string) =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      ? `<span class="shortcode-value" title="${esc(`${raw} · ${title}`)}">${esc(String(v))}</span>`
      : chip(`Not found: ${title}`, true);
  if (name === 'meta' && args[0]) return value(metaValue(env.frontMatter, args[0]), 'from the front matter and the project');
  if (name === 'var' && args[0]) return value(metaValue((env.quartoContext as QuartoContext | undefined)?.vars, args[0]), 'from _variables.yml');
  if (name === 'pagebreak') return '<span class="pagebreak">page break</span>';
  if (name === 'kbd' && args.length) return args.filter((a) => !a.includes('=')).map((k) => `<kbd>${esc(k)}</kbd>`).join(' ') || chip();
  if (name === 'video' && args[0] && /^https?:\/\//.test(args[0])) return `<a class="shortcode-video" href="${esc(args[0])}">Video: ${esc(args[0])}</a>`;
  if (name === 'include') return chip('An include inside a paragraph: Quarto puts the file here when it renders the document');
  return chip('Filled in by Quarto when it renders the document');
}

/**
 * What a layout or conditional div does in the rendered document, said above its content, which
 * the diff shows all of: tabs, content for some formats only, the margin, wider columns.
 */
export function divNote(attrs: Attrs): string | undefined {
  const c = new Set(attrs.classes);
  const v = attrs.values;
  if (c.has('panel-tabset')) return 'Tabs: each heading below is a tab';
  for (const [cls, shown] of [['content-visible', true], ['content-hidden', false]] as const) {
    if (!c.has(cls)) continue;
    const when = v['when-format'] ?? v['when-profile'] ?? v['when-meta'];
    const unless = v['unless-format'] ?? v['unless-profile'] ?? v['unless-meta'];
    const what = v['when-meta'] || v['unless-meta'] ? 'when' : v['when-profile'] || v['unless-profile'] ? 'in profile' : 'in';
    const out = v['when-format'] || v['unless-format'] ? ' output' : '';
    if (when) return `${shown ? 'Only' : 'Not'} ${what} ${when}${out}`;
    if (unless) return `${shown ? 'Not' : 'Only'} ${what} ${unless}${out}`;
    return shown ? undefined : 'Hidden in the document';
  }
  if (c.has('hidden')) return 'Hidden in the document';
  if (c.has('column-margin') || c.has('aside')) return 'In the margin';
  const column = attrs.classes.find((x) => /^column-(page|screen|body)/.test(x));
  if (column) return `Wider than the text (${column})`;
  if (c.has('notes')) return 'Speaker notes';
  return undefined;
}

/** Block rule: a fenced div, `::: {.callout-note}` … `:::`. Divs nest. */
function divRule(s: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (s.sCount[startLine] - s.blkIndent >= 4) return false;
  const lineText = (n: number) => s.src.slice(s.bMarks[n] + s.tShift[n], s.eMarks[n]);
  const open = /^(:{3,})\s*(.*?)\s*:*\s*$/.exec(lineText(startLine));
  if (!open || !open[2]) return false;
  if (silent) return true;

  let depth = 0;
  let close = startLine + 1;
  let found = false;
  for (; close < endLine; close++) {
    // A line with less indent than the div ends it, as for other containers.
    if (s.bMarks[close] + s.tShift[close] < s.eMarks[close] && s.sCount[close] < s.blkIndent) break;
    const text = lineText(close);
    if (/^:{3,}\s*$/.test(text)) {
      if (depth === 0) {
        found = true;
        break;
      }
      depth--;
    } else if (/^:{3,}\s*\S/.test(text)) {
      depth++;
    }
  }

  const info = open[2].replace(/^\{(.*)\}$/, '$1');
  const oldParent = s.parentType;
  const oldMax = s.lineMax;
  s.parentType = 'quarto_div' as typeof s.parentType;
  s.lineMax = close;
  const tokOpen = s.push('quarto_div_open', 'div', 1);
  tokOpen.markup = open[1];
  tokOpen.info = info;
  tokOpen.block = true;
  tokOpen.map = [startLine, close + (found ? 1 : 0)];
  tokOpen.meta = { attrs: parseAttrs(info) };
  s.md.block.tokenize(s, startLine + 1, close);
  const tokClose = s.push('quarto_div_close', 'div', -1);
  tokClose.markup = open[1];
  tokClose.block = true;
  s.parentType = oldParent;
  s.lineMax = oldMax;
  s.line = close + (found ? 1 : 0);
  return true;
}

/** How a fenced div shows: a callout box, the generated reference list, or only its content. */
export function divKind(tok: Token): { kind: 'callout'; type: string; title: string } | { kind: 'refs' } | { kind: 'plain' } {
  const attrs = (tok.meta as { attrs: Attrs }).attrs;
  if (attrs.id === 'refs') return { kind: 'refs' };
  for (const c of attrs.classes) {
    const m = /^callout-(\w+)$/.exec(c);
    if (m && CALLOUTS.has(m[1])) {
      return { kind: 'callout', type: m[1], title: attrs.values.title ?? m[1][0].toUpperCase() + m[1].slice(1) };
    }
  }
  return { kind: 'plain' };
}

/** The HTML that marks a code cell or a raw block, for example `python` or `raw latex`. Empty for a plain fence. */
export function fenceLabel(tok: Token, esc: (s: string) => string): string {
  const m = /^\{(=?)([\w.+-]+)[^}]*\}/.exec(tok.info.trim());
  if (!m) return '';
  return `<div class="cell-label">${m[1] ? 'raw ' : ''}${esc(m[2])}</div>`;
}

/** The number of a labelled equation, for display. */
export function eqNumberHtml(tok: Token): string {
  const n = tok.meta?.eqnum as string | undefined;
  return n ? `<span class="eqnum">(${n})</span>` : '';
}

/** The section number of a heading or the label of a table caption, shown before its text but not compared. */
export function blockPrefix(tok: Token | undefined): string {
  const meta = tok?.meta as { secnum?: string; caption?: string } | undefined;
  if (meta?.secnum) return `<span class="secnum">${meta.secnum}</span> `;
  if (meta?.caption) return `<span class="cap-label">${meta.caption}:</span> `;
  return '';
}

/** Adds the Quarto rules to a parser. */
export function quartoPlugin(md: MarkdownIt): void {
  md.core.ruler.before('block', 'quarto_eq_labels', eqLabelsRule);
  md.core.ruler.after('block', 'quarto_blocks', blocksRule);
  md.core.ruler.after('inline', 'quarto_resolve', resolveRule);
  md.block.ruler.before('fence', 'quarto_div', divRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.inline.ruler.before('link', 'quarto_bracket', bracketRule);
  md.inline.ruler.before('link', 'quarto_at', atRule);
  md.inline.ruler.before('link', 'quarto_shortcode', shortcodeRule);

  const esc = md.utils.escapeHtml;
  const r = md.renderer.rules;
  r.quarto_xref = (tokens, idx, _o, env) => {
    const tok = tokens[idx];
    if (env?.[KEY_ENV]) return `<span class="xref">${esc(tok.content)}</span>`;
    const meta = tok.meta as unknown as XrefMeta;
    const cls = meta.missing ? 'xref missing' : 'xref';
    return `<a class="${cls}" href="#${esc(meta.refs[0].id)}">${esc(meta.text ?? tok.content)}</a>`;
  };
  r.quarto_cite = (tokens, idx, _o, env) => {
    const tok = tokens[idx];
    if (env?.[KEY_ENV]) return `<span class="cite">${esc(tok.content)}</span>`;
    const meta = tok.meta as unknown as CiteMeta;
    const cls = meta.missing ? 'cite missing' : 'cite';
    return `<span class="${cls}" title="${esc(tok.content)}">${esc(meta.text ?? tok.content)}</span>`;
  };
  r.quarto_shortcode = (tokens, idx) => (tokens[idx].meta as { html?: string } | null)?.html ?? `<code class="shortcode">${esc(tokens[idx].content)}</code>`;
  // An inline expression shows what it computes, not as code in the middle of a sentence.
  const codeInline = r.code_inline!;
  r.code_inline = (tokens, idx, options, env, self) => {
    const e = inlineExpr(tokens[idx].content);
    if (!e) return codeInline(tokens, idx, options, env, self);
    const meta = tokens[idx].meta as ExprMeta | null;
    if (env?.[KEY_ENV]) {
      // Compared by its source, and by its value only when both versions were built.
      return `<code class="qexpr">${esc(e.expr)}${meta?.diffKey !== undefined ? esc(meta.diffKey) : ''}</code>`;
    }
    const value = meta?.value;
    if (value?.text !== undefined) {
      // The value reads as text of the sentence; the expression is a hover away.
      return `<span class="qval" title="${esc(`${e.lang}: ${e.expr}`)}">${value.markdown ? md.renderInline(value.text, {}) : esc(value.text)}</span>`;
    }
    const why = meta?.ran ? (value ? 'Failed in the Quarto build' : 'Not in the Quarto build of this version') : 'Computed when the document is rendered';
    return `<code class="qexpr${meta?.ran ? ' missing' : ''}" title="${esc(`${why} · ${e.lang}: ${e.expr}`)}">${esc(e.short)}</code>`;
  };
  r.quarto_div_open = (tokens, idx) => {
    const tok = tokens[idx];
    const d = divKind(tok);
    if (d.kind === 'callout') return `<div class="callout callout-${d.type}"><div class="callout-title">${esc(d.title)}</div>\n`;
    if (d.kind === 'refs') return '<div class="quarto-refs">References: the list that Quarto generates from the citations.';
    const attrs = (tok.meta as { attrs: Attrs }).attrs;
    const cls = attrs.classes.length ? ` class="${esc(attrs.classes.join(' '))}"` : '';
    const note = divNote(attrs);
    return `<div${attrs.id ? ` id="${esc(attrs.id)}"` : ''}${cls}>${note ? `<div class="qdiv-label">${esc(note)}</div>` : ''}\n`;
  };
  r.quarto_div_close = () => '</div>\n';

  const fence = r.fence!;
  r.fence = (tokens, idx, options, env, self) => {
    const tok = tokens[idx];
    const label = fenceLabel(tok, esc);
    if (!label) return fence(tokens, idx, options, env, self);
    // Show a cell as code in its language, without the braces and the options.
    const info = tok.info;
    tok.info = /^\{=?([\w.+-]+)/.exec(info.trim())![1];
    const html = fence(tokens, idx, options, env, self);
    tok.info = info;
    return cellHtml(md, tok, html, env, false, env?.[OUTPUTS_ENV] as CellOutputsDiff | undefined);
  };

  // Section numbers and caption labels, where a block is rendered whole, for example inside a callout.
  for (const type of ['heading_open', 'paragraph_open']) {
    const open: RendererRule = r[type] ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
    r[type] = (tokens, idx, options, env, self) => open(tokens, idx, options, env, self) + (env?.[KEY_ENV] ? '' : blockPrefix(tokens[idx]));
  }

  const math = r.math_block;
  if (math) {
    r.math_block = (tokens, idx, options, env, self) => {
      const html = math(tokens, idx, options, env, self);
      const num = env?.[KEY_ENV] ? '' : eqNumberHtml(tokens[idx]);
      // The id is what a click on `@eq-…` scrolls to.
      const id = tokens[idx].meta?.eqid as string | undefined;
      return num ? `<div class="eq"${id ? ` id="${esc(id)}"` : ''}>${html}${num}</div>\n` : html;
    };
  }
}
