import { diffArrays } from 'diff';
import type { MarkdownIt } from 'markdown-it';
import { Alignable, align, similarity } from './align';
import { Block, BlockBuilder, TableRow } from './blocks';
import { diffFormula } from './formula';
import { diffInline, renderInlinePlain } from './inline';
import { parseDoc } from './markdown';

/** Paired blocks with a lower similarity than this show as whole-block changes, not as a word diff. */
const MIN_WORD_DIFF_SIMILARITY = 0.25;

type Mark = 'del' | 'ins';
type Pair = { left: string; right: string };

/** Renders blocks, and pairs of changed blocks, as HTML. */
export interface DiffOptions {
  /** Mark the changed parts of a formula (true), or the whole formula (false). */
  formulaParts: boolean;
}

class PairRenderer {
  constructor(
    readonly b: BlockBuilder,
    readonly options: DiffOptions,
  ) {}

  plain(block: Block): string {
    if (block.html !== undefined) return wrapClass(block.html, block.cls);
    if (block.kind === 'leaf') return this.leaf(block, renderInlinePlain(this.b, block.inline));
    return wrapClass(this.b.render(block.tokens), block.cls);
  }

  marked(block: Block, mark: Mark): string {
    if (block.kind === 'leaf') return this.leaf(block, renderInlinePlain(this.b, block.inline), `b-${mark}`);
    if (block.type === 'list_item') {
      return `<li class="b-${mark}">${(block.children ?? []).map((c) => this.plain(c)).join('')}</li>\n`;
    }
    return `<div class="b-${mark}">${this.plain(block)}</div>\n`;
  }

  pair(a: Block, b: Block): Pair {
    if (a.type !== b.type) return this.whole(a, b);
    switch (a.kind) {
      case 'leaf': {
        if (similarity(a.text, b.text) < MIN_WORD_DIFF_SIMILARITY) return this.whole(a, b);
        const { left, right } = diffInline(this.b, a.inline, b.inline, this.options.formulaParts);
        return { left: this.leaf(a, left), right: this.leaf(b, right) };
      }
      case 'math':
        return this.math(a, b);
      case 'code':
        return this.code(a, b);
      case 'table':
        return this.table(a, b);
      case 'container':
        return this.container(a, b);
      default:
        return this.whole(a, b);
    }
  }

  private whole(a: Block, b: Block): Pair {
    return { left: this.marked(a, 'del'), right: this.marked(b, 'ins') };
  }

  private leaf(block: Block, inner: string, extraCls?: string): string {
    const classes = [block.cls, extraCls].filter(Boolean).join(' ');
    if (block.hidden) return classes ? `<span class="${classes}">${inner}</span>\n` : `${inner}\n`;
    const open = block.tokens[0];
    const attrs = (open?.attrs ?? []).filter(([k]) => k !== 'class').map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`).join('');
    const cls = classes ? ` class="${classes}"` : '';
    return `<${block.tag}${attrs}${cls}>${inner}</${block.tag}>\n`;
  }

  private container(a: Block, b: Block): Pair {
    const ops = align(a.children ?? [], b.children ?? []);
    let left = '';
    let right = '';
    for (const op of ops) {
      if (op.op === 'eq') {
        left += this.plain(op.a);
        right += this.plain(op.b);
      } else if (op.op === 'chg') {
        const p = this.pair(op.a, op.b);
        left += p.left;
        right += p.right;
      } else if (op.op === 'del') {
        left += this.marked(op.a, 'del');
      } else {
        right += this.marked(op.b, 'ins');
      }
    }
    return { left: this.wrapTokens(a, left), right: this.wrapTokens(b, right) };
  }

  private wrapTokens(block: Block, inner: string): string {
    const r = this.b.md.renderer;
    const t = block.tokens;
    const html = r.renderToken(t, 0, this.b.md.options) + inner + r.renderToken(t, t.length - 1, this.b.md.options);
    return wrapClass(html, block.cls);
  }

  private math(a: Block, b: Block): Pair {
    const d = this.options.formulaParts ? diffFormula(a.tokens[0].content, b.tokens[0].content, true) : undefined;
    if (!d) return this.whole(a, b);
    return {
      left: `<div class="m-del"><p class="katex-block">${d.left}</p></div>\n`,
      right: `<div class="m-ins"><p class="katex-block">${d.right}</p></div>\n`,
    };
  }

  private code(a: Block, b: Block): Pair {
    const esc = this.b.md.utils.escapeHtml;
    const lines = (blk: Block) => blk.tokens[0].content.replace(/\n$/, '').split('\n');
    const la = lines(a);
    const lb = lines(b);
    let left = '';
    let right = '';
    let ia = 0;
    let ib = 0;
    for (const part of diffArrays(la, lb)) {
      const n = part.count ?? part.value.length;
      if (part.removed) {
        for (const l of la.slice(ia, ia + n)) left += `<span class="l-del">${esc(l)}</span>`;
        ia += n;
      } else if (part.added) {
        for (const l of lb.slice(ib, ib + n)) right += `<span class="l-ins">${esc(l)}</span>`;
        ib += n;
      } else {
        for (const l of la.slice(ia, ia + n)) left += `<span>${esc(l)}</span>`;
        for (const l of lb.slice(ib, ib + n)) right += `<span>${esc(l)}</span>`;
        ia += n;
        ib += n;
      }
    }
    return { left: `<pre class="code-diff"><code>${left}</code></pre>\n`, right: `<pre class="code-diff"><code>${right}</code></pre>\n` };
  }

  private table(a: Block, b: Block): Pair {
    type R = TableRow & { type: string };
    const rows = (blk: Block): R[] => (blk.rows ?? []).map((r) => ({ ...r, type: r.section }));
    const ra = rows(a);
    const rb = rows(b);
    const width = (rs: R[]) => Math.max(1, ...rs.map((r) => r.cells.length));
    const placeholder = (section: TableRow['section'], cols: number) => ({ section, html: `<tr class="r-ph"><td colspan="${cols}"></td></tr>` });
    const left: { section: TableRow['section']; html: string }[] = [];
    const right: { section: TableRow['section']; html: string }[] = [];
    for (const op of align(ra, rb)) {
      if (op.op === 'eq') {
        left.push(this.row(op.a));
        right.push(this.row(op.b));
      } else if (op.op === 'chg') {
        const n = Math.max(op.a.cells.length, op.b.cells.length);
        const cellsA: string[] = [];
        const cellsB: string[] = [];
        for (let k = 0; k < n; k++) {
          const ca = op.a.cells[k];
          const cb = op.b.cells[k];
          const d = diffInline(this.b, ca?.inline, cb?.inline, this.options.formulaParts);
          if (ca) cellsA.push(cell(ca.tag, ca.style, d.left));
          if (cb) cellsB.push(cell(cb.tag, cb.style, d.right));
        }
        left.push({ section: op.a.section, html: `<tr class="r-chg">${cellsA.join('')}</tr>` });
        right.push({ section: op.b.section, html: `<tr class="r-chg">${cellsB.join('')}</tr>` });
      } else if (op.op === 'del') {
        left.push(this.row(op.a, 'r-del'));
        right.push(placeholder(op.a.section, width(rb)));
      } else {
        left.push(placeholder(op.b.section, width(ra)));
        right.push(this.row(op.b, 'r-ins'));
      }
    }
    return { left: wrapClass(tableHtml(left), a.cls), right: wrapClass(tableHtml(right), b.cls) };
  }

  private row(r: TableRow, cls?: string): { section: TableRow['section']; html: string } {
    const cells = r.cells.map((c) => cell(c.tag, c.style, renderInlinePlain(this.b, c.inline))).join('');
    return { section: r.section, html: `<tr${cls ? ` class="${cls}"` : ''}>${cells}</tr>` };
  }
}

function cell(tag: string, style: string | null, inner: string): string {
  return `<${tag}${style ? ` style="${escapeAttr(style)}"` : ''}>${inner}</${tag}>`;
}

function tableHtml(rows: { section: TableRow['section']; html: string }[]): string {
  const head = rows.filter((r) => r.section === 'thead').map((r) => r.html).join('\n');
  const body = rows.filter((r) => r.section === 'tbody').map((r) => r.html).join('\n');
  return `<table>\n${head ? `<thead>\n${head}\n</thead>\n` : ''}${body ? `<tbody>\n${body}\n</tbody>\n` : ''}</table>\n`;
}

function wrapClass(html: string, cls: string | undefined): string {
  return cls ? `<div class="${cls}">${html}</div>\n` : html;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A top-level row of the side-by-side view: one block, or one item of a top-level list. */
interface Unit extends Alignable {
  block: Block;
  list?: Block;
  ordinal?: number;
}

function toUnits(blocks: Block[]): Unit[] {
  const units: Unit[] = [];
  for (const block of blocks) {
    if (block.type === 'bullet_list' || block.type === 'ordered_list') {
      const start = Number(block.tokens[0].attrGet('start') ?? 1);
      (block.children ?? []).forEach((item, k) => {
        units.push({ block: item, list: block, ordinal: start + k, type: `li:${block.type}`, key: item.key, text: item.text });
      });
    } else {
      units.push({ block, type: block.type, key: block.key, text: block.text });
    }
  }
  return units;
}

function wrapUnit(unit: Unit, inner: string): string {
  if (!unit.list) return inner;
  const cls = ` class="${['unit', unit.list.cls].filter(Boolean).join(' ')}"`;
  if (unit.list.type === 'ordered_list') return `<ol start="${unit.ordinal}"${cls}>\n${inner}</ol>\n`;
  return `<ul${cls}>\n${inner}</ul>\n`;
}

export interface DiffResult {
  /** The rows of the side-by-side view. */
  html: string;
  /** The number of change hunks: runs of rows next to each other that are not equal. */
  hunks: number;
  added: number;
  removed: number;
  changed: number;
}

/** Diffs two Markdown sources and returns the rows of the side-by-side view. */
export function diffMarkdown(md: MarkdownIt, oldSource: string, newSource: string, options: DiffOptions = { formulaParts: true }): DiffResult {
  const docA = parseDoc(md, oldSource);
  const docB = parseDoc(md, newSource);
  const builderA = new BlockBuilder(md, docA.env);
  const builderB = new BlockBuilder(md, docB.env);
  // Link references resolve at parse time, so one renderer serves both sides.
  const render = new PairRenderer(builderB, options);
  const ops = align(toUnits(builderA.documentBlocks(docA)), toUnits(builderB.documentBlocks(docB)));

  const result: DiffResult = { html: '', hunks: 0, added: 0, removed: 0, changed: 0 };
  const isChange = (k: number) => k >= 0 && k < ops.length && ops[k].op !== 'eq';
  const rows: string[] = [];
  let hidden = 0;
  const flushFold = () => {
    if (hidden > 0) rows.push(`<div class="fold">${hidden} unchanged block${hidden === 1 ? '' : 's'}</div>`);
    hidden = 0;
  };

  ops.forEach((op, k) => {
    let left: string;
    let right: string;
    let cls: string = op.op;
    let lines = '';
    if (op.op === 'eq') {
      left = wrapUnit(op.a, render.plain(op.a.block));
      right = wrapUnit(op.b, render.plain(op.b.block));
      const context = isChange(k - 1) || isChange(k + 1);
      if (!context) {
        hidden++;
        cls += ' far';
      } else {
        flushFold();
      }
    } else {
      flushFold();
      if (!isChange(k - 1)) result.hunks++;
      if (op.op === 'chg') {
        const p = render.pair(op.a.block, op.b.block);
        left = wrapUnit(op.a, p.left);
        right = wrapUnit(op.b, p.right);
        result.changed++;
      } else if (op.op === 'del') {
        left = wrapUnit(op.a, render.marked(op.a.block, 'del'));
        right = '<div class="ph"></div>';
        result.removed++;
      } else {
        left = '<div class="ph"></div>';
        right = wrapUnit(op.b, render.marked(op.b.block, 'ins'));
        result.added++;
      }
      cls += '" data-hunk="' + result.hunks;
    }
    // The source lines of each side, for the scroll sync with the editor.
    const la = op.op !== 'ins' ? op.a.block.lines : undefined;
    const lb = op.op !== 'del' ? op.b.block.lines : undefined;
    if (la) lines += ` data-a="${la[0]},${la[1]}"`;
    if (lb) lines += ` data-b="${lb[0]},${lb[1]}"`;
    rows.push(`<div class="row ${cls}"${lines}><div class="cell a">${left}</div><div class="cell b">${right}</div></div>`);
  });
  flushFold();
  result.html = rows.join('\n');
  return result;
}

