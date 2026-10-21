import { diffArrays } from 'diff';
import type { BlockBuilder } from './blocks';
import type { Token } from './markdown';

/**
 * The smallest unit of an inline diff: a word, a run of white space, one punctuation mark,
 * or one whole inline element such as a formula, a code span or an image.
 */
interface Atom {
  key: string;
  html: string;
  /** The open tokens (strong, em, link ...) that contain this atom. */
  ctx: Token[];
  space: boolean;
}

export type Mark = 'del' | 'ins' | null;

const WORD = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

function atomize(builder: BlockBuilder, inline: Token): Atom[] {
  const esc = builder.md.utils.escapeHtml;
  const atoms: Atom[] = [];
  const stack: Token[] = [];
  for (const tok of inline.children ?? []) {
    if (tok.nesting === 1) {
      stack.push(tok);
      continue;
    }
    if (tok.nesting === -1) {
      stack.pop();
      continue;
    }
    const ctx = stack.slice();
    const ctxKey = ctx.map((t) => t.type + (t.attrGet('href') ?? '')).join('>');
    if (tok.type === 'text') {
      for (const piece of tok.content.match(WORD) ?? []) {
        const space = /^\s/.test(piece);
        atoms.push({ key: `${ctxKey}|${space ? ' ' : piece}`, html: esc(piece), ctx, space });
      }
    } else if (tok.type === 'softbreak') {
      atoms.push({ key: `${ctxKey}| `, html: '\n', ctx, space: true });
    } else {
      const html = builder.renderInline([tok]);
      atoms.push({ key: `${ctxKey}|${tok.type}:${tok.content}:${html}`, html, ctx, space: false });
    }
  }
  return atoms;
}

function renderAtoms(atoms: Atom[], marks: Mark[]): string {
  let html = '';
  let open: Token[] = [];
  const closeTo = (depth: number) => {
    while (open.length > depth) {
      html += `</${open.pop()!.tag}>`;
    }
  };
  atoms.forEach((atom, i) => {
    let common = 0;
    while (common < open.length && common < atom.ctx.length && open[common] === atom.ctx[common]) common++;
    closeTo(common);
    for (const tok of atom.ctx.slice(common)) {
      html += renderOpen(tok);
      open.push(tok);
    }
    const mark = marks[i];
    html += mark ? `<span class="x-${mark}">${atom.html}</span>` : atom.html;
  });
  closeTo(0);
  return html;
}

function renderOpen(tok: Token): string {
  const attrs = (tok.attrs ?? []).map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`).join('');
  return `<${tok.tag}${attrs}>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Diffs the inline content of two blocks. Returns the HTML of each side, with removed atoms
 * marked on the old side and added atoms marked on the new side.
 */
export function diffInline(builder: BlockBuilder, oldInline: Token | undefined, newInline: Token | undefined): { left: string; right: string } {
  const a = oldInline ? atomize(builder, oldInline) : [];
  const b = newInline ? atomize(builder, newInline) : [];
  const parts = diffArrays(
    a.map((x) => x.key),
    b.map((x) => x.key),
  );

  // Segments of the diff, in order. An equal segment has atoms on both sides.
  type Seg = { op: 'eq' | 'del' | 'ins'; a: number; b: number; n: number };
  const segs: Seg[] = [];
  let ia = 0;
  let ib = 0;
  for (const part of parts) {
    const n = part.count ?? part.value.length;
    if (part.added) {
      segs.push({ op: 'ins', a: ia, b: ib, n });
      ib += n;
    } else if (part.removed) {
      segs.push({ op: 'del', a: ia, b: ib, n });
      ia += n;
    } else {
      segs.push({ op: 'eq', a: ia, b: ib, n });
      ia += n;
      ib += n;
    }
  }

  const marksA: Mark[] = a.map(() => null);
  const marksB: Mark[] = b.map(() => null);
  segs.forEach((seg, k) => {
    if (seg.op === 'del') for (let i = 0; i < seg.n; i++) marksA[seg.a + i] = 'del';
    else if (seg.op === 'ins') for (let i = 0; i < seg.n; i++) marksB[seg.b + i] = 'ins';
    else if (k > 0 && k < segs.length - 1 && isFiller(a.slice(seg.a, seg.a + seg.n))) {
      // A short equal run between two changes, such as one space, makes the highlight
      // look broken. Mark it as changed on both sides, so each side reads as one run.
      const ops = (from: number, step: number) => {
        const found = new Set<string>();
        for (let j = from; j >= 0 && j < segs.length && segs[j].op !== 'eq'; j += step) found.add(segs[j].op);
        return found;
      };
      const before = ops(k - 1, -1);
      const after = ops(k + 1, 1);
      const leftChanged = before.has('del') && after.has('del');
      const rightChanged = before.has('ins') && after.has('ins');
      for (let i = 0; i < seg.n; i++) {
        if (leftChanged) marksA[seg.a + i] = 'del';
        if (rightChanged) marksB[seg.b + i] = 'ins';
      }
    }
  });

  return { left: renderAtoms(a, marksA), right: renderAtoms(b, marksB) };
}

function isFiller(atoms: Atom[]): boolean {
  const words = atoms.filter((x) => !x.space);
  if (words.length === 0) return true;
  return words.length === 1 && atoms.length <= 3 && words[0].html.length <= 1;
}

/** Renders inline content without changes. */
export function renderInlinePlain(builder: BlockBuilder, inline: Token | undefined): string {
  return inline ? builder.renderInline(inline.children ?? []) : '';
}
