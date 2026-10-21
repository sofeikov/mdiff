import { diffArrays } from 'diff';

export interface Alignable {
  type: string;
  key: string;
  text: string;
}

export type Op<T> = { op: 'eq' | 'chg'; a: T; b: T } | { op: 'del'; a: T } | { op: 'ins'; b: T };

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
  // Split each text into words once, and compute each score once.
  const bagsA = a.map((x) => wordBag(x.text));
  const bagsB = b.map((x) => wordBag(x.text));
  const scores = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      scores[i * m + j] = a[i].type !== b[j].type ? -1 : Math.max(bagSimilarity(bagsA[i], bagsB[j]), 0.01);
    }
  }
  const score = (i: number, j: number) => scores[i * m + j];
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

/** The words of a text with their counts. */
interface WordBag {
  counts: Map<string, number>;
  size: number;
}

function wordBag(text: string): WordBag {
  const counts = new Map<string, number>();
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return { counts, size: words.length };
}

/** Dice coefficient of two word multisets. */
function bagSimilarity(x: WordBag, y: WordBag): number {
  if (x.size === 0 && y.size === 0) return 1;
  const [small, large] = x.counts.size <= y.counts.size ? [x.counts, y.counts] : [y.counts, x.counts];
  let common = 0;
  for (const [w, c] of small) common += Math.min(c, large.get(w) ?? 0);
  return (2 * common) / (x.size + y.size);
}

/** Dice coefficient of the word multisets of two texts. */
export function similarity(x: string, y: string): number {
  return bagSimilarity(wordBag(x), wordBag(y));
}
