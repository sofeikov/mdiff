import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { align, similarity } from '../src/core/align';
import { diffMarkdown } from '../src/core/diff';
import { diffFormula } from '../src/core/formula';
import { createMarkdown } from '../src/core/markdown';
import { toRowsMessage, UpdateMessage } from '../src/core/page';

const md = createMarkdown();
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

/** Parses the result rows into a list of { status, left, right } for easy checks. */
function rows(html: string) {
  const out: { status: string; left: string; right: string }[] = [];
  const re = /<div class="row ([a-z]+)[^>]*><div class="cell a">([\s\S]*?)<\/div><div class="cell b">([\s\S]*?)<\/div><\/div>(?=\n<div|$)/g;
  for (const m of html.matchAll(re)) out.push({ status: m[1], left: m[2], right: m[3] });
  return out;
}

describe('similarity', () => {
  it('is 1 for the same text and 0 for no common words', () => {
    expect(similarity('a b c', 'a b c')).toBe(1);
    expect(similarity('a b', 'c d')).toBe(0);
  });
});

describe('align', () => {
  const item = (type: string, key: string, text = key) => ({ type, key, text });
  it('matches equal items and pairs similar changed items', () => {
    const a = [item('p', 'one two three'), item('p', 'four five six'), item('h', 'title')];
    const b = [item('p', 'one two three'), item('p', 'four five seven'), item('h', 'title')];
    expect(align(a, b).map((o) => o.op)).toEqual(['eq', 'chg', 'eq']);
  });
  it('does not pair items of different types', () => {
    const ops = align([item('p', 'x')], [item('h', 'y')]);
    expect(ops.map((o) => o.op)).toEqual(['del', 'ins']);
  });
  it('puts an inserted item between pairs', () => {
    const a = [item('li', 'first'), item('li', 'second thing with bold')];
    const b = [item('li', 'first'), item('li', 'new item'), item('li', 'second thing with italic')];
    expect(align(a, b).map((o) => o.op)).toEqual(['eq', 'ins', 'chg']);
  });
});

describe('diffMarkdown', () => {
  it('finds no changes in the same document', () => {
    const src = fixture('old.md');
    const r = diffMarkdown(md, src, src);
    expect(r.hunks).toBe(0);
    expect(rows(r.html).every((x) => x.status === 'eq')).toBe(true);
  });

  const whole = { formulaParts: false };

  it('marks a changed block formula as one unit when formula parts are off', () => {
    const r = diffMarkdown(md, '$$a + b$$\n', '$$a + c$$\n', whole);
    const [row] = rows(r.html);
    expect(row.status).toBe('chg');
    expect(row.left).toMatch(/^<div class="b-del"><p class="katex-block">/);
    expect(row.right).toMatch(/^<div class="b-ins"><p class="katex-block">/);
  });

  it('marks a changed inline formula as one atom when formula parts are off', () => {
    const r = diffMarkdown(md, 'Value $x_1 + y$ here.\n', 'Value $x_2 + y$ here.\n', whole);
    const [row] = rows(r.html);
    expect(row.status).toBe('chg');
    expect(row.left.match(/class="x-del"/g)).toHaveLength(1);
    expect(row.right.match(/class="x-ins"/g)).toHaveLength(1);
    expect(row.right).toMatch(/<span class="x-ins"><span class="katex">/);
  });

  it('marks only the changed part of a block formula', () => {
    const r = diffMarkdown(md, '$$\\frac{a}{b} + c$$\n', '$$\\frac{a}{d} + c$$\n');
    const [row] = rows(r.html);
    expect(row.left).toMatch(/^<div class="m-del"><p class="katex-block">/);
    expect(row.left.match(/enclosing f-del/g)).toHaveLength(1);
    expect(row.right.match(/enclosing f-ins/g)).toHaveLength(1);
    // The mark holds the denominator only.
    const marked = row.right.slice(row.right.indexOf('f-ins'));
    expect(marked).toContain('>d<');
    expect(marked.slice(0, 400)).not.toContain('>a<');
  });

  it('marks an added term at the end of a formula', () => {
    const r = diffMarkdown(md, '$$\\mathcal{L} = \\sum_n x_n$$\n', '$$\\mathcal{L} = \\sum_n x_n + \\lambda w$$\n');
    const [row] = rows(r.html);
    expect(row.left).not.toContain('f-del');
    expect(row.right.match(/enclosing f-ins/g)).toHaveLength(1);
  });

  it('marks a changed subscript, not the base', () => {
    const r = diffMarkdown(md, 'Value $x_1 + y$ here.\n', 'Value $x_2 + y$ here.\n');
    const [row] = rows(r.html);
    expect(row.left).toContain('<span class="m-del"><span class="katex">');
    expect(row.right).toContain('<span class="m-ins"><span class="katex">');
    expect(row.right.match(/enclosing f-ins/g)).toHaveLength(1);
    expect(row.right).not.toContain('x-ins');
  });

  it('keeps a whole mark when a formula cannot be marked part by part', () => {
    // A mark inside \big( is not valid LaTeX, so the whole formula is marked.
    const r = diffMarkdown(md, '$$\\big( a \\big)$$\n', '$$\\big[ a \\big]$$\n');
    const [row] = rows(r.html);
    expect(row.right).toMatch(/^<div class="(b-ins|m-ins)">/);
    expect(row.right).not.toContain('katex-error');
  });

  it('marks changed words in a paragraph and keeps the other words plain', () => {
    const r = diffMarkdown(md, 'The quick brown fox jumps.\n', 'The quick red fox jumps.\n');
    const [row] = rows(r.html);
    expect(row.left).toBe('<p>The quick <span class="x-del">brown</span> fox jumps.</p>\n');
    expect(row.right).toBe('<p>The quick <span class="x-ins">red</span> fox jumps.</p>\n');
  });

  it('treats a decimal number as one word', () => {
    const r = diffMarkdown(md, 'The rate is 0.9 here.\n', 'The rate is 0.99 here.\n');
    const [row] = rows(r.html);
    expect(row.left).toContain('<span class="x-del">0.9</span>');
    expect(row.right).toContain('<span class="x-ins">0.99</span>');
  });

  it('joins the highlight across one space between two changed words', () => {
    const r = diffMarkdown(md, 'Keep alpha beta keep.\n', 'Keep gamma delta keep.\n');
    const [row] = rows(r.html);
    expect(row.right).toBe('<p>Keep <span class="x-ins">gamma</span><span class="x-ins"> </span><span class="x-ins">delta</span> keep.</p>\n');
  });

  it('shows a change of emphasis as a change', () => {
    const r = diffMarkdown(md, 'A **bold** word.\n', 'A *bold* word.\n');
    const [row] = rows(r.html);
    expect(row.left).toContain('<strong><span class="x-del">bold</span></strong>');
    expect(row.right).toContain('<em><span class="x-ins">bold</span></em>');
  });

  it('aligns table rows and shows an inserted row with a placeholder on the old side', () => {
    const r = diffMarkdown(md, fixture('old.md'), fixture('new.md'));
    const table = rows(r.html).find((x) => x.left.includes('<table>'))!;
    expect(table.status).toBe('chg');
    expect(table.left).toContain('<tr class="r-ph">');
    expect(table.right).toContain('<tr class="r-ins"><td>gamma</td><td>3</td></tr>');
  });

  it('shows each top-level list item as a row with its own number', () => {
    const r = diffMarkdown(md, fixture('old.md'), fixture('new.md'));
    const inserted = rows(r.html).find((x) => x.status === 'ins' && x.right.includes('New inserted item'))!;
    expect(inserted.right).toMatch(/^<ol start="2" class="unit">/);
    expect(inserted.left).toBe('<div class="ph"></div>');
    const third = rows(r.html).find((x) => x.right.includes('Third item'))!;
    expect(third.status).toBe('eq');
    expect(third.left).toMatch(/^<ol start="3"/);
    expect(third.right).toMatch(/^<ol start="4"/);
  });

  it('diffs front matter fields', () => {
    const r = diffMarkdown(md, fixture('old.md'), fixture('new.md'));
    const title = rows(r.html)[0];
    expect(title.status).toBe('chg');
    expect(title.right).toContain('<h1 class="fm-title">');
    expect(title.right).toContain('<span class="x-ins">revised</span>');
  });

  it('diffs code blocks line by line', () => {
    const r = diffMarkdown(md, fixture('old.md'), fixture('new.md'));
    const code = rows(r.html).find((x) => x.left.includes('code-diff'))!;
    expect(code.left).toContain('<span class="l-del">    return x + 1</span>');
    expect(code.right).toContain('<span class="l-ins">    return x + 2</span>');
  });

  it('counts hunks and block changes', () => {
    const r = diffMarkdown(md, fixture('old.md'), fixture('new.md'));
    expect(r).toMatchObject({ hunks: 7, changed: 7, added: 1, removed: 1 });
  });

  // Set MDIFF_SAMPLE to a large real document to run this check.
  const sample = process.env.MDIFF_SAMPLE;
  it.skipIf(!sample || !existsSync(sample))('renders a large real document with no KaTeX errors', () => {
    const src = readFileSync(sample!, 'utf8');
    const r = diffMarkdown(md, src, src);
    expect(r.hunks).toBe(0);
    expect(r.html).not.toContain('katex-error');
  });

  it.skipIf(!sample || !existsSync(sample))('parses every formula of a large real document for the part diff', () => {
    const tokens = md.parse(readFileSync(sample!, 'utf8'), {});
    const formulas = tokens
      .flatMap((t) => [t, ...(t.children ?? [])])
      .filter((t) => t.type === 'math_block' || t.type === 'math_inline')
      .map((t) => t.content);
    expect(formulas.length).toBeGreaterThan(100);
    // An added term must give a part diff for every formula, not the whole-formula fallback.
    const failed = formulas.filter((tex) => !diffFormula(tex, `${tex} + \\zeta`, false));
    expect(failed).toEqual([]);
  });
});

describe('parsed side cache', () => {
  it('gives the same result as a new parser, also when one side is reused', () => {
    const a = fixture('old.md');
    const b = fixture('new.md');
    const fresh = diffMarkdown(createMarkdown(), a, b).html;
    const reused = createMarkdown();
    expect(diffMarkdown(reused, a, b).html).toBe(fresh);
    // The old side is reused here, as on a live update of the working file.
    expect(diffMarkdown(reused, a, b).html).toBe(fresh);
    expect(diffMarkdown(reused, a, a).hunks).toBe(0);
    expect(diffMarkdown(reused, a, b).html).toBe(fresh);
  });

  it('parses a side again for another bibliography', () => {
    const q = createMarkdown({ quarto: true });
    const src = 'See [@a].\n';
    const one = new Map([['a', { authors: ['One'], year: '2001' }]]);
    const two = new Map([['a', { authors: ['Two'], year: '2002' }]]);
    expect(diffMarkdown(q, src, src, { formulaParts: true, bibliography: one }).html).toContain('(One 2001)');
    expect(diffMarkdown(q, src, src, { formulaParts: true, bibliography: two }).html).toContain('(Two 2002)');
  });

  it('returns the rows that html joins', () => {
    const r = diffMarkdown(md, fixture('old.md'), fixture('new.md'));
    expect(r.rows.join('\n')).toBe(r.html);
    expect(r.rows.every((row) => /^<div class="(row|fold)/.test(row))).toBe(true);
  });
});

describe('toRowsMessage', () => {
  const message = (rows: string[], extra: Partial<UpdateMessage> = {}): UpdateMessage => ({
    type: 'update', title: 't', labelA: 'a', labelB: 'b', html: rows.join('\n'), rows, hunks: 1, added: 0, removed: 0, changed: 1, reset: false, ...extra,
  });

  it('sends all rows as HTML when the webview shows nothing, a new file or an error', () => {
    const first = toRowsMessage(message(['x', 'y']), undefined, 1);
    expect(first).toMatchObject({ rows: ['x', 'y'], seq: 1 });
    expect(first).not.toHaveProperty('base');
    expect(toRowsMessage(message(['x'], { reset: true }), { seq: 1, rows: ['x'] }, 2).rows).toEqual(['x']);
    expect(toRowsMessage(message([], { error: 'e' }), { seq: 1, rows: ['x'] }, 2).rows).toEqual([]);
  });

  it('sends a shown row as its index, and each shown row once', () => {
    const wire = toRowsMessage(message(['a', 'new', 'b', 'a', 'a']), { seq: 4, rows: ['a', 'b', 'a', 'gone'] }, 5);
    expect(wire).toMatchObject({ rows: [0, 'new', 1, 2, 'a'], seq: 5, base: 4 });
    expect(wire).not.toHaveProperty('html');
  });
});
