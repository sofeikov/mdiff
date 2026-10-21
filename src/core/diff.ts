import { diffArrays } from 'diff';
import type { MarkdownIt } from 'markdown-it';
import { Block, BlockBuilder, TableRow } from './blocks';
import { diffInline, renderInlinePlain } from './inline';
import { parseDoc } from './markdown';

interface Alignable {
  type: string;
  key: string;
  text: string;
}

export type Op<T> = { op: 'eq' | 'chg'; a: T; b: T } | { op: 'del'; a: T } | { op: 'ins'; b: T };

/** Paired blocks with a lower similarity than this show as whole-block changes, not as a word diff. */
const MIN_WORD_DIFF_SIMILARITY = 0.25;

/**
 * Aligns two sequences. Equal items match first (longest common subsequence). In each gap
 * between equal items, the removed and added items of the same type pair up by similarity.
 */
export function align<T extends Alignable>(a: T[], b: T[]): Op<T>[] {
  const keyOf = (x: T) => `${x.type}\u0000${x.key}`;
  const parts = diffArrays(a.map(keyOf), b.map(keyOf));
  const ops: Op<T>[] = [];
  let ia = 0;
  let ib = 0;
  let gapA: T[] = [];
  let gapB: T[] = [];
  const flush = () => {
    ops.push(...pairGap(gapA, gapB));
    gapA = [];
    gapB = [];
  };
  for (const part of parts) {
    const n = part.count ?? part.value.length;
    if (part.removed) {
      gapA.push(...a.slice(ia, ia + n));
      ia += n;
    } else if (part.added) {
      gapB.push(...b.slice(ib, ib + n));
      ib += n;
    } else {
      flush();
      for (let k = 0; k < n; k++) ops.push({ op: 'eq', a: a[ia + k], b: b[ib + k] });
      ia += n;
      ib += n;
    }
  }
  flush();
  return ops;
}

function pairGap<T extends Alignable>(a: T[], b: T[]): Op<T>[] {
  if (a.length === 0 || b.length === 0) {
    return [...a.map((x) => ({ op: 'del' as const, a: x })), ...b.map((x) => ({ op: 'ins' as const, b: x }))];
  }
  // Best total similarity of an order-preserving pairing (Needleman-Wunsch, no gap cost).
  // Blocks of the same type always pair, with a small score when they are not similar,
  // so that a rewritten paragraph shows on the same row as the old one.
  const n = a.length;
  const m = b.length;
  const score = (i: number, j: number) => {
    if (a[i].type !== b[j].type) return -1;
    return Math.max(similarity(a[i].text, b[j].text), 0.01);
  };
  const s: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const p = score(i - 1, j - 1);
      s[i][j] = Math.max(s[i - 1][j], s[i][j - 1], p > 0 ? s[i - 1][j - 1] + p : -Infinity);
    }
  }
  const out: Op<T>[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const p = score(i - 1, j - 1);
      if (p > 0 && s[i][j] === s[i - 1][j - 1] + p) {
        out.push({ op: 'chg', a: a[i - 1], b: b[j - 1] });
        i--;
        j--;
        continue;
      }
    }
    // Walking backwards: take the added item first, so that removed items come first in the result.
    if (j > 0 && (i === 0 || s[i][j] === s[i][j - 1])) {
      out.push({ op: 'ins', b: b[--j] });
    } else {
      out.push({ op: 'del', a: a[--i] });
    }
  }
  return out.reverse();
}

/** Dice coefficient of the word multisets. */
export function similarity(x: string, y: string): number {
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  const wx = words(x);
  const wy = words(y);
  if (wx.length === 0 && wy.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const w of wx) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of wy) {
    const c = counts.get(w) ?? 0;
    if (c > 0) {
      common++;
      counts.set(w, c - 1);
    }
  }
  return (2 * common) / (wx.length + wy.length);
}

type Mark = 'del' | 'ins';
type Pair = { left: string; right: string };

/** Renders blocks, and pairs of changed blocks, as HTML. */
class PairRenderer {
  constructor(readonly b: BlockBuilder) {}

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
        const { left, right } = diffInline(this.b, a.inline, b.inline);
        return { left: this.leaf(a, left), right: this.leaf(b, right) };
      }
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
          const d = diffInline(this.b, ca?.inline, cb?.inline);
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
export function diffMarkdown(md: MarkdownIt, oldSource: string, newSource: string): DiffResult {
  const docA = parseDoc(md, oldSource);
  const docB = parseDoc(md, newSource);
  const builderA = new BlockBuilder(md, docA.env);
  const builderB = new BlockBuilder(md, docB.env);
  // Link references resolve at parse time, so one renderer serves both sides.
  const render = new PairRenderer(builderB);
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
    const la = op.op !== 'ins' ? op.a.block.line : undefined;
    const lb = op.op !== 'del' ? op.b.block.line : undefined;
    if (la !== undefined) lines += ` data-line-a="${la}"`;
    if (lb !== undefined) lines += ` data-line-b="${lb}"`;
    rows.push(`<div class="row ${cls}"${lines}><div class="cell a">${left}</div><div class="cell b">${right}</div></div>`);
  });
  flushFold();
  result.html = rows.join('\n');
  return result;
}

