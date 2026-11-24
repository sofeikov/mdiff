import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffMarkdown, previewMarkdown } from '../src/core/diff';
import { createMarkdown } from '../src/core/markdown';
import { cellCode, keptNotebook, outputsKey, parseQuartoRun, quartoCommand, readQuartoRun, RunCursor, splitCommand, type QuartoRun } from '../src/core/quartoRun';

// The fixtures are a small document at two versions, and the notebooks Quarto 1.6 kept of them
// (`quarto render x.qmd --to gfm -M keep-ipynb:true`).
const fx = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const headRun = readQuartoRun(fx('quarto-run.head.ipynb'));

describe('reading a Quarto run', () => {
  it('has every inline expression with its value, and every cell with its outputs', () => {
    expect(headRun.exprs).toEqual([
      { expr: `f"{facts['shots']:,}"`, text: '12,345' },
      { expr: `facts['name']`, text: 'E1' },
      { expr: `f"{facts['ll']:.4f}"`, text: '0.2731' },
      { expr: `f"{facts['shots']:,}"`, text: '12,345' },
      { expr: 'str(10)', text: '10' },
    ]);
    expect(headRun.cells.map((c) => c.outputs.map((o) => o.kind))).toEqual([[], ['markdown'], ['image'], ['stream']]);
    // Without the option lines, which Quarto writes again (`# | label` becomes `#| label`).
    expect(headRun.cells[2].code.startsWith('import matplotlib')).toBe(true);
    expect(headRun.cells[3].outputs[0]).toEqual({ kind: 'stream', name: 'stdout', text: 'plain text\n' });
  });

  it('survives being stored, and anything else is not a run', () => {
    expect(parseQuartoRun(JSON.stringify(headRun))).toEqual(headRun);
    expect(parseQuartoRun('{"cells": 1}')).toBeUndefined();
    expect(parseQuartoRun('not json')).toBeUndefined();
    expect(() => readQuartoRun('{"nbformat": 4}')).toThrow();
  });

  it('reads quoted strings without the quotes, Markdown as it is, and nothing for an error', () => {
    const nb = (result: unknown) => JSON.stringify({ cells: [{ cell_type: 'markdown', metadata: { user_expressions: [{ expression: ' x ', result }] } }] });
    const value = (result: unknown) => readQuartoRun(nb(result)).exprs[0];
    expect(value({ status: 'ok', data: { 'text/plain': '"it\'s"' } })).toEqual({ expr: 'x', text: "it's" });
    expect(value({ status: 'ok', data: { 'text/plain': '42' } })).toEqual({ expr: 'x', text: '42' });
    expect(value({ status: 'ok', data: { 'text/plain': '<M>', 'text/markdown': '**b**' } })).toEqual({ expr: 'x', text: '**b**', markdown: true });
    expect(value({ status: 'error', ename: 'NameError' })).toEqual({ expr: 'x' });
  });

  it('drops the option lines of a cell, however they are written', () => {
    expect(cellCode('#| label: a\n# | echo: false\n\nx = 1  \ny = 2\n')).toBe('x = 1\ny = 2');
    expect(cellCode('x = 1\n#| not: an option here')).toBe('x = 1\n#| not: an option here');
  });

  it('matches by text, in order, and leaves what the run has not', () => {
    const run: QuartoRun = {
      exprs: [{ expr: 'n', text: '1' }, { expr: 'm', text: '5' }, { expr: 'n', text: '2' }],
      cells: [{ code: 'x', outputs: [{ kind: 'text', text: 'a' }] }],
    };
    const c = new RunCursor(run);
    expect(c.expr('other')).toBeUndefined();
    expect(c.expr(' n ')?.text).toBe('1');
    expect(c.expr('n')?.text).toBe('2');
    expect(c.expr('n')).toBeUndefined();
    expect(c.expr('m')?.text).toBe('5');
    expect(c.cell('#| echo: false\nx\n')?.outputs.length).toBe(1);
    expect(c.cell('x')).toBeUndefined();
    expect(outputsKey(run.cells[0].outputs)).not.toBe(outputsKey([]));
  });
});

describe('the build command', () => {
  it('is Quarto as installed, through uv for a uv project, or the user\'s own', () => {
    const tail = ['a.qmd', '--to', 'gfm', '-M', 'keep-ipynb:true', '-M', 'freeze:false', '--no-execute-daemon', '--output-dir', '/tmp/o'];
    expect(quartoCommand('', 'a.qmd', false, '/tmp/o')).toEqual(['quarto', 'render', ...tail]);
    expect(quartoCommand('', 'a.qmd', true, '/tmp/o')).toEqual(['uv', 'run', 'quarto', 'render', ...tail]);
    expect(quartoCommand('conda run -n "my env" quarto render', 'a.qmd', true, '/tmp/o')).toEqual(['conda', 'run', '-n', 'my env', 'quarto', 'render', ...tail]);
    expect(splitCommand(`  a 'b c'  "d"  `)).toEqual(['a', 'b c', 'd']);
  });

  it('finds the notebook that Quarto kept', () => {
    expect(keptNotebook('a.qmd', ['a.qmd', 'a.quarto_ipynb', 'b.quarto_ipynb'])).toBe('a.quarto_ipynb');
    expect(keptNotebook('a.qmd', ['a.qmd', 'a.quarto_ipynb_1'])).toBe('a.quarto_ipynb_1');
    expect(keptNotebook('a.qmd', ['a.qmd', 'a.ipynb'])).toBe('a.ipynb');
    expect(keptNotebook('a.qmd', ['a.qmd', 'ab.ipynb'])).toBeUndefined();
  });
});

describe('a document with a run', () => {
  const qmd = createMarkdown({ quarto: true });
  const base = fx('quarto-run.base.qmd');
  const head = fx('quarto-run.head.qmd');
  const baseRun = readQuartoRun(fx('quarto-run.base.ipynb'));
  const text = (html: string) => html.replace(/<[^>]+>/g, '');
  const preview = (src: string, run?: QuartoRun) => previewMarkdown(qmd, src, { formulaParts: true, runs: { b: run } }).html;
  /** The old and the new column of a diff, each joined. */
  const diff = (a?: QuartoRun, b?: QuartoRun) => {
    const r = diffMarkdown(qmd, base, head, { formulaParts: true, runs: { a, b } });
    const side = (k: 0 | 1) => r.rows.map((row) => row.split('<div class="cell b">')[k] ?? '').join('\n');
    return { ...r, a: side(0), b: side(1) };
  };

  it('shows the values in its sentences and the outputs of its cells', () => {
    const html = preview(head, headRun);
    expect(text(html)).toMatch(/On 12,345 shots the log loss of E1 is 0\.2731\. Again: 12,345 shots\./);
    expect(html).toMatch(/<span class="qval" title="python: facts\['name'\]">E1<\/span>/);
    // The table the cell wrote, under its number and caption; no placeholder is left.
    expect(html).toMatch(/<figure class="qfig" id="tbl-a"><div class="qout"><div class="qout-md"><table>/);
    expect(html).toMatch(/<td>0\.2731<\/td>/);
    expect(html).toMatch(/<figcaption><span class="cap-label">Table 1:<\/span> A table\.<\/figcaption>/);
    expect(html).toMatch(/<figure class="qfig" id="fig-b"><div class="qout"><img class="qout-img" alt="" src="data:image\/png;base64,/);
    expect(html).toMatch(/<pre class="qout-text">plain text<\/pre>/);
    expect(html).not.toMatch(/made by this cell when the document is rendered/);
    // The first cell has `output: false`.
    expect(html).not.toMatch(/qout"><\/div>/);
  });

  it('is as before without a run, and says so when the run lacks a piece', () => {
    const plain = preview(head);
    expect(plain).toMatch(/<code class="qexpr" title="Computed when the document is rendered/);
    expect(plain).toMatch(/Table made by this cell when the document is rendered/);
    const partial = preview(head, { exprs: headRun.exprs.slice(0, 1), cells: [] });
    expect(text(partial)).toMatch(/On 12,345 shots/);
    expect(partial).toMatch(/<code class="qexpr missing" title="Not in the Quarto build of this version/);
    expect(partial).toMatch(/<div class="qfig-ph">Not in the Quarto build of this version<\/div>/);
  });

  it('respects output: false, include: false, warning: false and output: asis, and draws no interactive output', () => {
    const src = [
      '```{python}', '#| output: false', 'x', '```', '',
      '```{python}', '#| include: false', 'z', '```', '',
      '```{python}', '#| warning: false', 'w', '```', '',
      '```{python}', '#| output: asis', 'a', '```', '',
      '```{python}', 'y', '```', '',
    ].join('\n');
    const run: QuartoRun = {
      exprs: [],
      cells: [
        { code: 'x', outputs: [{ kind: 'text', text: 'hidden' }] },
        { code: 'z', outputs: [{ kind: 'text', text: 'excluded' }] },
        { code: 'w', outputs: [{ kind: 'stream', name: 'stderr', text: 'a warning' }, { kind: 'stream', name: 'stdout', text: 'printed' }] },
        { code: 'a', outputs: [{ kind: 'stream', name: 'stdout', text: '**bold** text\n' }] },
        { code: 'y', outputs: [{ kind: 'html', html: '<div id="p"></div><script>draw()</script>', text: 'Figure' }, { kind: 'html', html: '<table><tr><td>1</td></tr></table>', text: '1' }] },
      ],
    };
    const html = preview(src, run);
    expect(html).not.toMatch(/>hidden<|>excluded<|a warning|draw\(\)/);
    expect(html).toMatch(/<pre class="qout-text">printed<\/pre>/);
    expect(html).toMatch(/<div class="qout"><div class="qout-md"><p><strong>bold<\/strong> text<\/p>/);
    expect(html).toMatch(/Interactive output: drawn only in the rendered document/);
    expect(html).toMatch(/<div class="qout-html"><table>/);
  });

  it('with a run of both versions, marks a value that changed though its source did not', () => {
    const d = diff(baseRun, headRun);
    expect(d.a).toMatch(/<span class="x-del"><span class="qval"[^>]*>12,000<\/span><\/span>/);
    expect(d.b).toMatch(/<span class="x-ins"><span class="qval"[^>]*>12,345<\/span><\/span>/);
    // The value that is the same on both sides is not.
    expect(d.b).not.toMatch(/<span class="x-ins"><span class="qval"[^>]*>E1/);
    expect(d.b).toMatch(/<span class="qval"[^>]*>E1<\/span>/);
    // The paragraph whose values are all the same is not a change.
    const same = d.rows.find((r) => r.includes('The model reads'))!;
    expect(same).toMatch(/^<div class="row eq/);
  });

  it('with a run of both versions, marks the changed numbers of a table, and keeps its code folded', () => {
    const d = diff(baseRun, headRun);
    const table = (html: string) => html.slice(html.indexOf('id="tbl-a"'), html.indexOf('</figure>', html.indexOf('id="tbl-a"')));
    expect(table(d.b)).toMatch(/<div class="qout out-chg">/);
    expect(table(d.b)).toMatch(/<span class="x-ins">0\.2731<\/span>/);
    expect(table(d.a)).toMatch(/<span class="x-del">0\.2810<\/span>/);
    // The unchanged row is not marked.
    expect(table(d.b)).not.toMatch(/r-chg[^<]*><td>champion/);
    // Its code didn't change, so it isn't opened or shown as a code diff.
    const cell = d.b.slice(d.b.lastIndexOf('<div class="qcell', d.b.indexOf('id="tbl-a"')), d.b.indexOf('id="tbl-a"'));
    expect(cell).not.toMatch(/code-diff|<details class="qcode" open/);
    // The plot changed too; the printed text did not.
    expect(d.b).toMatch(/id="fig-b"><div class="qout out-chg">/);
    expect(d.b).toMatch(/<div class="qout"><pre class="qout-text">plain text/);
  });

  it('with a run of one version only, shows its values and marks nothing for them', () => {
    const d = diff(undefined, headRun);
    expect(d.b).toMatch(/<span class="qval"[^>]*>12,345<\/span>/);
    expect(d.a).toMatch(/<code class="qexpr"/);
    expect(d.b).not.toMatch(/<span class="x-ins"><span class="qval"/);
    expect(d.b).not.toMatch(/out-chg/);
    // Only the line of the first cell changed.
    expect(d.changed).toBe(1);
    expect(diff().changed).toBe(1);
    expect(diff(baseRun, headRun).changed).toBeGreaterThan(1);
  });
});
