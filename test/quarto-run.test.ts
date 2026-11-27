import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffMarkdown, previewMarkdown } from '../src/core/diff';
import { createMarkdown } from '../src/core/markdown';
import { frameDocument, frameScripts, needsFrame, scriptsOnly, withoutRunIds } from '../src/core/outputFrame';
import { integrityHolds } from '../src/outputScripts';
import { createHash } from 'node:crypto';
import { cellCode, extrasConflict, failureLine, hiddenPath, keptNotebook, outputsKey, parseQuartoRun, quartoCommand, readQuartoRun, RunCursor, splitCommand, type QuartoRun } from '../src/core/quartoRun';

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
    expect(quartoCommand('', 'a.qmd', true, '/tmp/o')).toEqual(['uv', 'run', '--all-extras', 'quarto', 'render', ...tail]);
    expect(quartoCommand('', 'a.qmd', true, '/tmp/o', false)).toEqual(['uv', 'run', 'quarto', 'render', ...tail]);
    expect(extrasConflict('uv ended with code 2: error: Extras `a` and `b` are incompatible with the declared conflicts: {`toy[a]`, `toy[b]`}')).toBe(true);
    expect(extrasConflict("uv ended with code 1: cell 2/6: ModuleNotFoundError: No module named 'lance'")).toBe(false);
    expect(quartoCommand('conda run -n "my env" quarto render', 'a.qmd', true, '/tmp/o')).toEqual(['conda', 'run', '-n', 'my env', 'quarto', 'render', ...tail]);
    expect(splitCommand(`  a 'b c'  "d"  `)).toEqual(['a', 'b c', 'd']);
  });

  it('has no output folder for a build in a copy that is deleted', () => {
    expect(quartoCommand('', 'a.qmd', false)).toEqual(['quarto', 'render', 'a.qmd', '--to', 'gfm', '-M', 'keep-ipynb:true', '-M', 'freeze:false', '--no-execute-daemon']);
  });

  it('knows a path that Quarto leaves out of its project, and reports a failure by its ERROR line', () => {
    expect(hiddenPath('/home/u/.config/Code/User/globalStorage/x/a.qmd')).toBe(true);
    expect(hiddenPath('/home/u/repo/.claude/worktrees/w/a.qmd')).toBe(true);
    expect(hiddenPath('/home/u/my.repo/docs/a.qmd')).toBe(false);
    expect(hiddenPath('C:\\Users\\u\\.vscode\\a.qmd')).toBe(true);
    const out = 'Starting\n\u001b[91mERROR: The --output-dir flag can only be used when rendering projects.\u001b[39m\n\nStack trace:\n    at render (file:///x.js:1:1)\n';
    expect(failureLine(out)).toBe('ERROR: The --output-dir flag can only be used when rendering projects.');
    expect(failureLine('a\nb\nc\n')).toBe('b c');
  });

  it('reports a failed cell by its exception, not by the last line of its source', () => {
    const run = "Executing 'r.quarto_ipynb'\n  Cell 1/6: ''....Done\n  Cell 2/6: ''....\n\nAn error occurred while executing the following cell:\n------------------\n\nimport lance\nshare = n / total\n------------------\n\n";
    const tb = "\u001b[0;31mModuleNotFoundError\u001b[0m                       Traceback (most recent call last)\nCell \u001b[0;32mIn[2], line 1\u001b[0m\n\u001b[0;32m----> 1\u001b[0m import lance\n\n\u001b[0;31mModuleNotFoundError\u001b[0m: No module named 'lance'\n\n";
    expect(failureLine(run + tb)).toBe("cell 2/6: ModuleNotFoundError: No module named 'lance'");
    // Rich's traceback (ZenML installs it) goes to the cell's output, and Quarto reports none.
    expect(failureLine(run + '\n\n\n')).toBe("cell 2/6 failed, and its error wasn't reported");
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

  it('respects output: false, include: false, warning: false and output: asis, and puts an interactive output in a frame, not in the page', () => {
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
    expect(html).not.toMatch(/>hidden<|>excluded<|a warning/);
    expect(html).toMatch(/<pre class="qout-text">printed<\/pre>/);
    expect(html).toMatch(/<div class="qout"><div class="qout-md"><p><strong>bold<\/strong> text<\/p>/);
    // The output's HTML is there for the page to make a frame of, encoded: nothing of it is markup of the page.
    expect(html).not.toMatch(/<script/);
    const holder = /<div class="qout-frame" data-frame="([^"]*)">/.exec(html);
    expect(decodeURIComponent(holder?.[1] ?? '')).toBe('<div id="p"></div><script>draw()</script>');
    expect(html).toMatch(/<div class="qout-html"><table>/);
  });

  it('leaves out an output of scripts alone, which shows nothing', () => {
    const setup = '\n<script>window.PlotlyConfig = {};</script>\n<script type="module">import "https://cdn.plot.ly/plotly-4.1.1.min.js"</script>\n';
    const run: QuartoRun = { exprs: [], cells: [{ code: 'fig.show()', outputs: [{ kind: 'html', html: setup, text: '' }, { kind: 'html', html: '<div id="f"></div><script>draw()</script>', text: '' }] }] };
    const html = preview('```{python}\nfig.show()\n```\n', run);
    expect(html.match(/qout-frame/g)?.length).toBe(1);
    expect(html).not.toMatch(/PlotlyConfig/);
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

describe('interactive outputs', () => {
  const qmd = createMarkdown({ quarto: true });
  const PLOTLY = (id: string, y: number[]) => '<div style="height:440px; width:100%;">'
    + '<script>window.PlotlyConfig = {MathJaxConfig: \'local\'};</script>\n'
    + '<script charset="utf-8" src="https://cdn.plot.ly/plotly-3.0.1.min.js" integrity="sha256-abc=" crossorigin="anonymous"></script>'
    + `<div id="${id}" class="plotly-graph-div" style="height:100%; width:100%;"></div>`
    + `<script>if (document.getElementById("${id}")) { Plotly.newPlot("${id}", [{"y":${JSON.stringify(y)}}], {}, {"responsive": true}) }</script></div>`;

  it('need a frame when they have a script, and load the scripts they name over https', () => {
    expect(needsFrame('<table><tr><td>1</td></tr></table>')).toBe(false);
    expect(needsFrame(PLOTLY('a', [1]))).toBe(true);
    expect(scriptsOnly(PLOTLY('a', [1]))).toBe(false);
    expect(scriptsOnly('<style>p {}</style><script>x()</script><!-- y -->')).toBe(true);
    expect(scriptsOnly('<table><tr><td>1</td></tr></table>')).toBe(false);
    expect(frameScripts(PLOTLY('a', [1]))).toEqual([{ url: 'https://cdn.plot.ly/plotly-3.0.1.min.js', integrity: 'sha256-abc=' }]);
    // Each once, `//host` as https, and nothing that isn't on the web over https.
    expect(
      frameScripts('<script src="//cdn.jsdelivr.net/npm/vega@5?a=1&amp;b=2"></script><script src=\'https://cdn.plot.ly/x.js\'></script><script src="https://cdn.plot.ly/x.js"></script><script src="http://example.org/a.js"></script><script src="lib/b.js"></script><script src="file:///etc/passwd"></script>'),
    ).toEqual([{ url: 'https://cdn.jsdelivr.net/npm/vega@5?a=1&b=2' }, { url: 'https://cdn.plot.ly/x.js' }]);
  });

  it('get a frame document that gives every script the nonce, with the downloaded ones in as text', () => {
    const lib = 'window.Plotly = { newPlot: function () { return "</script><!-- x -->"; } };';
    const doc = frameDocument(PLOTLY('fig1', [1, 2]), new Map([['https://cdn.plot.ly/plotly-3.0.1.min.js', lib]]), 'N0nce', 7);
    // No script without the nonce, and none that the frame would have to load.
    const scripts = [...doc.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(4);
    expect(scripts.every((a) => / nonce="N0nce"/.test(a) && !/src=/.test(a))).toBe(true);
    // The library's text can't end its script element early.
    expect(doc).toContain('return "<\\/script><\\!-- x -->"; } };</script><div id="fig1"');
    expect(doc).toContain('Plotly.newPlot("fig1", [{"y":[1,2]}]');
    expect(doc).toMatch(/parent\.postMessage\(\{ mdiffFrame: 7, height: h \}, '\*'\)/);
    expect(doc).toMatch(/^<!DOCTYPE html>/);
  });

  it('leave out a script that could not be downloaded, or is not on the web', () => {
    const doc = frameDocument('<script src="https://cdn.example.org/a.js"></script><script src="lib/b.js"></script><script type="module">go()</script>', new Map(), 'n', 1);
    expect(doc).not.toMatch(/a\.js|b\.js/);
    expect(doc).toMatch(/<script nonce="n" type="module">go\(\)<\/script>/);
  });

  it('are the same in two runs that differ only in the id the library made up', () => {
    const a = PLOTLY('99a5c6d6-316c-4570-a5c7-584093b1c791', [1, 2]);
    const b = PLOTLY('bff3fcf1-736d-46de-9f4a-04470445c0b3', [1, 2]);
    const c = PLOTLY('1a739377-c29a-4a3f-aee8-911051efe7cf', [1, 3]);
    expect(withoutRunIds(a)).toBe(withoutRunIds(b));
    const key = (html: string) => outputsKey([{ kind: 'html', html, text: '' }]);
    expect(key(a)).toBe(key(b));
    expect(key(a)).not.toBe(key(c));

    const src = '```{python}\n#| echo: false\nshow(fig)\n```\n';
    const run = (html: string): QuartoRun => ({ exprs: [], cells: [{ code: 'show(fig)', outputs: [{ kind: 'html', html, text: '' }] }] });
    const diff = (x: string, y: string) => diffMarkdown(qmd, src, src, { formulaParts: true, runs: { a: run(x), b: run(y) } });
    const same = diff(a, b);
    expect(same.changed).toBe(0);
    expect(same.rows.join('')).not.toMatch(/out-chg/);
    const changed = diff(a, c);
    expect(changed.changed).toBe(1);
    expect(changed.rows.join('')).toMatch(/<div class="qout out-chg"><div class="qout-frame"[^]*<div class="qout out-chg"><div class="qout-frame"/);
  });

  it('take a downloaded script only with the hash the output expects, when it gives one', () => {
    const bytes = new TextEncoder().encode('window.x = 1;');
    const hash = (alg: string) => `${alg}-${createHash(alg).update(bytes).digest('base64')}`;
    expect(integrityHolds(undefined, bytes)).toBe(true);
    expect(integrityHolds(hash('sha256'), bytes)).toBe(true);
    expect(integrityHolds(`sha384-AAAA ${hash('sha512')}`, bytes)).toBe(true);
    expect(integrityHolds(hash('sha256'), new TextEncoder().encode('window.x = 2;'))).toBe(false);
    // A hash of a kind we don't know says nothing either way.
    expect(integrityHolds('md5-AAAA', bytes)).toBe(true);
  });
});
