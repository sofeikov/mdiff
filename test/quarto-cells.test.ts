import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { diffMarkdown, previewMarkdown } from '../src/core/diff';
import { createMarkdown, parseDoc } from '../src/core/markdown';
import { cellInfo, cellOptions, includeArgs, inlineExpr, mergeMeta, metaValue, QuartoContext, shortcodeArgs } from '../src/core/quarto';
import { loadQuarto } from '../src/project';

const qmd = createMarkdown({ quarto: true });
const options = { formulaParts: true };
const text = (html: string) => html.replace(/<[^>]+>/g, '');

function render(src: string, context?: QuartoContext): string {
  const env: Record<string, unknown> = { quartoContext: context };
  const doc = parseDoc(qmd, src, env);
  return qmd.renderer.render(doc.tokens, qmd.options, env);
}

describe('code cell options', () => {
  it('reads `#|` lines, `# |` as formatters write them, and no invalid YAML', () => {
    expect(cellOptions('#| echo: false\n# | label: fig-a\n#|fig-cap: "A: b"\nx = 1\n#| not: this')).toEqual({ echo: false, label: 'fig-a', 'fig-cap': 'A: b' });
    expect(cellOptions('%%| label: fig-m\nflowchart TD')).toEqual({ label: 'fig-m' });
    expect(cellOptions('#| a: [unclosed')).toEqual({});
  });

  it('takes echo, include and code-fold from the cell, execute: and the format', () => {
    const info = (code: string, meta?: unknown) => cellInfo('python', code, meta);
    expect(info('x').code).toBe('shown');
    expect(info('x', { execute: { echo: false } }).code).toBe('hidden');
    expect(info('#| echo: true\nx', { execute: { echo: false } }).code).toBe('shown');
    expect(info('#| include: false\nx').code).toBe('excluded');
    expect(info('x', { format: { html: { 'code-fold': true } } }).code).toBe('folded');
    expect(info('#| label: fig-a\n#| fig-cap: The cap\nplot()').targets).toEqual([{ id: 'fig-a', kind: 'fig', caption: 'The cap' }]);
    const asis = info('#| output: asis\nprint(f": Rows {{#tbl-rows}}")');
    expect(asis.targets.map((t) => t.id)).toEqual(['tbl-rows']);
  });
});

describe('Quarto cells, rendered', () => {
  const doc = [
    '---', 'execute:', '  echo: false', '---', '',
    'See @fig-a, @tbl-made, @tbl-lit, @tbl-w and @fig-flow.', '',
    '```{python}', '#| label: fig-a', '#| fig-cap: "A *plot* of @tbl-lit"', 'plot()', '```', '',
    '| a |', '|---|', '| 1 |', '', ': Literal {#tbl-lit}', '',
    '```{python}', '#| output: asis', 'print(": Made {{#tbl-made}}")', '```', '',
    '```{python}', '#| output: asis', 'print(table)', '```', '', ': Written {#tbl-w}', '',
    '```{mermaid}', '%%| label: fig-flow', '%%| fig-cap: The flow', 'flowchart TD', '```', '',
  ].join('\n');

  it('folds hidden code and numbers the figures and tables of cells with the rest', () => {
    const html = render(doc);
    expect(text(html)).toContain('See Figure 1, Table 2, Table 1, Table 3 and Figure 2.');
    expect(html).toContain('<div class="qcell code-hidden"><details class="qcode"><summary class="cell-label">python · 3 lines · not shown in the document</summary><pre>');
    expect(html).toMatch(/<figure class="qfig" id="fig-a"><div class="qfig-ph">Figure made by this cell when the document is rendered<\/div><figcaption><span class="cap-label">Figure 1:<\/span> A <em>plot<\/em> of <a class="xref" href="#tbl-lit">Table 1<\/a><\/figcaption><\/figure>/);
    expect(html).toContain('<span class="cap-label">Table 2</span> <code class="qfig-id">tbl-made</code>');
    expect(html).toContain('<div class="qfig-ph">Table made by this cell when the document is rendered</div></div>\n<p class="tbl-cap" id="tbl-w">');
    expect(html).toMatch(/<div class="qcell diagram"><div class="cell-label">mermaid diagram<\/div><figure class="qfig" id="fig-flow"><pre data-mermaid="[^"]+">/);
  });

  it('opens hidden code that changed, and does not mark a renumbered figure', () => {
    const before = doc.replace('plot()', 'plot(old=True)');
    const r = diffMarkdown(qmd, before, doc, options);
    expect(r.changed).toBe(1);
    expect(r.html).toMatch(/<details class="qcode" open><summary class="cell-label">python · 3 lines · not shown in the document<\/summary><pre class="code-diff"><code>.*<span class="l-ins">plot\(\)<\/span>/s);
    // A new figure before the others renumbers them, but only the new cell is a change.
    const more = doc.replace('```{python}\n#| label: fig-a', '```{python}\n#| label: fig-new\nnew()\n```\n\n```{python}\n#| label: fig-a');
    const r2 = diffMarkdown(qmd, doc, more, options);
    expect(r2.added).toBe(1);
    expect(r2.changed).toBe(0);
    expect(r2.html).toContain('<div class="b-ins"><div class="qcell code-hidden"><details class="qcode" open>');
  });

  it('reads the project under the front matter', () => {
    expect(render('```{python}\nx\n```\n', { project: { execute: { echo: false } } })).toContain('code-hidden');
  });
});

describe('inline expressions', () => {
  it('show as a value to compute, with the code on hover', () => {
    const html = render('Covers `{python} f"{n_matches:,}"` matches, `not {python} code`.\n');
    expect(html).toContain('<code class="qexpr" title="Computed when the document is rendered · python: f&quot;{n_matches:,}&quot;">n_matches</code>');
    expect(html).toContain('<code>not {python} code</code>');
    expect(inlineExpr('{python} f"{x[1:2]!r:>8}"')?.short).toBe('x[1:2]');
    expect(inlineExpr(`{python} ${'x'.repeat(60)}`)?.short.length).toBe(48);
  });
});

describe('shortcodes, includes and divs', () => {
  it('show values, keys, the included file and what a div does', () => {
    const ctx: QuartoContext = {
      path: '/p/docs/paper.qmd',
      vars: { version: '1.2' },
      includes: new Map([['/p/docs/_part.qmd', '## Included\n\nFrom the part.\n']]),
      resolveInclude: (from, arg) => `${from.slice(0, from.lastIndexOf('/'))}/${arg}`,
    };
    const html = render('---\ntitle: The paper\n---\n\n{{< meta title >}} v{{< var version >}}, {{< meta nope >}}. {{< kbd Ctrl-C >}}\n\n{{< include _part.qmd >}}\n\n{{< include gone.qmd >}}\n', ctx);
    expect(text(html)).toContain('The paper v1.2, {{&lt; meta nope &gt;}}. Ctrl-C');
    expect(html).toContain('<div class="qinclude"><div class="qinclude-label">Included from <code>_part.qmd</code></div><h2>Included</h2>\n<p>From the part.</p>');
    expect(html).toContain('<div class="qinclude missing"><div class="qinclude-label">Includes <code>gone.qmd</code>, which can\'t be read</div></div>');
    const p = previewMarkdown(qmd, '::: {.content-visible when-format="html"}\nX\n:::\n', options);
    expect(p.rows[0]).toContain('<div class="qdiv-label">Only in html output</div>');
  });

  it('helpers: arguments, includes, metadata', () => {
    expect(shortcodeArgs('{{< kbd mac=Cmd "Ctrl C" >}}')).toEqual(['kbd', 'mac=Cmd', 'Ctrl C']);
    expect(includeArgs('{{< include a.qmd >}} {{< include "b c.qmd" >}} {{< include a.qmd >}}')).toEqual(['a.qmd', 'b c.qmd']);
    expect(mergeMeta({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] } }, undefined)).toEqual({ a: { b: 1, c: [2] }, d: 1 });
    expect(metaValue({ a: { b: 'x' } }, 'a.b')).toBe('x');
  });
});

describe('loadQuarto', () => {
  const root = mkdtempSync(join(tmpdir(), 'mdiff-project-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads the project, directory metadata, variables, bibliography and includes from disk', () => {
    mkdirSync(join(root, 'docs', 'reports'), { recursive: true });
    mkdirSync(join(root, 'docs', 'refs'));
    writeFileSync(join(root, 'docs', '_quarto.yml'), 'project:\n  type: default\nexecute:\n  echo: false\nbibliography: refs/all.bib\n');
    writeFileSync(join(root, 'docs', 'reports', '_metadata.yml'), 'number-sections: true\n');
    writeFileSync(join(root, 'docs', '_variables.yml'), 'version: 3\n');
    writeFileSync(join(root, 'docs', 'refs', 'all.bib'), readFileSync(join(__dirname, 'fixtures', 'quarto.bib'), 'utf8'));
    writeFileSync(join(root, 'docs', 'reports', '_inc.qmd'), '{{< include /shared.qmd >}}\n');
    writeFileSync(join(root, 'docs', 'shared.qmd'), 'Shared.\n');
    const doc = join(root, 'docs', 'reports', 'r.qmd');
    const src = '# R\n\n{{< include _inc.qmd >}}\n';
    const q = loadQuarto(doc, src);
    expect(q.context.project).toEqual({ execute: { echo: false }, bibliography: 'refs/all.bib', 'number-sections': true });
    expect(q.context.vars).toEqual({ version: 3 });
    expect(q.bibliography?.has('smith2020')).toBe(true);
    expect([...q.context.includes!.keys()]).toEqual([join(root, 'docs', 'reports', '_inc.qmd'), join(root, 'docs', 'shared.qmd')]);
    expect(loadQuarto(doc, src)).toBe(q);
    const html = previewMarkdown(qmd, src, { formulaParts: true, ...q }).html;
    expect(html).toContain('<span class="secnum">1</span> R');
    expect(html).toContain('<p>Shared.</p>');
  });
});
