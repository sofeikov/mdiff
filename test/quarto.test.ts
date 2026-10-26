import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffMarkdown } from '../src/core/diff';
import { createMarkdown, parseDoc } from '../src/core/markdown';
import { Bibliography, bibliographyPaths, parseAttrs, parseBibtex } from '../src/core/quarto';

const qmd = createMarkdown({ quarto: true });
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const bibliography = parseBibtex(fixture('quarto.bib'));
const options = { formulaParts: true, bibliography };

/** Renders one document as Quarto. */
function render(src: string, bib: Bibliography | undefined = bibliography): string {
  const env: Record<string, unknown> = { bibliography: bib };
  const doc = parseDoc(qmd, src, env);
  return qmd.renderer.render(doc.tokens, qmd.options, env);
}

/** Parses the result rows into a list of { status, left, right }. */
function rows(html: string) {
  const out: { status: string; left: string; right: string }[] = [];
  const re = /<div class="row ([a-z]+)[^>]*><div class="cell a">([\s\S]*?)<\/div><div class="cell b">([\s\S]*?)<\/div><\/div>(?=\n<div|$)/g;
  for (const m of html.matchAll(re)) out.push({ status: m[1], left: m[2], right: m[3] });
  return out;
}

const text = (html: string) => html.replace(/<[^>]+>/g, '');
const numbered = (body: string) => `---\nnumber-sections: true\n---\n\n${body}`;

describe('parseAttrs', () => {
  it('reads an id, classes, values, and - for unnumbered', () => {
    expect(parseAttrs('#sec-a .x title="A title" -')).toEqual({ id: 'sec-a', classes: ['x', 'unnumbered'], values: { title: 'A title' } });
    expect(parseAttrs('callout-note')).toEqual({ classes: ['callout-note'], values: {} });
  });
});

describe('parseBibtex', () => {
  it('reads family names and years from braced, quoted and bare values', () => {
    expect(bibliography.get('smith2020')).toEqual({ authors: ['Smith', 'Doe'], year: '2020' });
    expect(bibliography.get('lee2019')).toEqual({ authors: ['Lee', 'Lee', 'Kim'], year: '2019' });
  });
  it('removes accents, keeps a braced name whole, and takes the year of a date', () => {
    expect(bibliography.get('muller2021')).toEqual({ authors: ['Muller'], year: '2021' });
    expect(bibliography.get('team2018')).toEqual({ authors: ['Real Analytics Team'], year: '2018' });
  });
  it('finds the bibliography files in the front matter', () => {
    expect(bibliographyPaths(fixture('quarto-old.qmd'))).toEqual(['quarto.bib']);
    expect(bibliographyPaths('---\nbibliography: [a.bib, b.bib]\n---\n')).toEqual(['a.bib', 'b.bib']);
    expect(bibliographyPaths('# No front matter\n')).toEqual([]);
  });
});

describe('Quarto rendering', () => {
  it('removes heading attributes, keeps the id and numbers the sections', () => {
    const html = render(numbered('## Intro {#sec-intro}\n\n### Part\n\n## Notes {.unnumbered}\n\n## Method\n'));
    expect(html).toContain('<h2 id="sec-intro"><span class="secnum">1</span> Intro</h2>');
    expect(html).toContain('<span class="secnum">1.1</span> Part');
    expect(html).toContain('<h2>Notes</h2>');
    expect(html).toContain('<span class="secnum">2</span> Method');
  });

  it('does not number sections without number-sections', () => {
    expect(render('## Intro {#sec-intro}\n')).toBe('<h2 id="sec-intro">Intro</h2>\n');
  });

  it('numbers sections from a format of the front matter', () => {
    expect(render('---\nformat:\n  html:\n    number-sections: true\n---\n\n## A\n')).toContain('<span class="secnum">1</span> A');
  });

  it('resolves cross-references to sections, tables and equations', () => {
    const html = render(fixture('quarto-old.qmd'));
    expect(text(html)).toContain('The method is in Section 2.');
    expect(text(html)).toContain('The loss is Equation 1. The rungs are in Table 1.');
    expect(html).toContain('<p class="tbl-cap" id="tbl-rungs"><span class="cap-label">Table 1:</span> The rungs</p>');
    expect(html).toContain('<span class="eqnum">(1)</span>');
  });

  it('shows a capitalised, a suppressed and a missing cross-reference', () => {
    const html = render(numbered('## A {#sec-a}\n\n@Sec-a, -@sec-a and @sec-none.\n'));
    expect(text(html)).toContain('Section 1, 1 and ?@sec-none.');
    expect(html).toContain('class="xref missing"');
  });

  it('shows the title of an unnumbered section', () => {
    expect(text(render('## Appendix {#sec-app .unnumbered}\n\nSee @sec-app.\n'))).toContain('See Appendix.');
  });

  it('numbers a one-line equation with a label', () => {
    const html = render('$$ a + b $$ {#eq-sum}\n\nSee @eq-sum.\n');
    expect(html).not.toContain('katex-error');
    expect(text(html)).toContain('See Equation 1.');
  });

  it('renders citations in the author-date style', () => {
    const t = text(render('A @smith2020, B [@lee2019, p. 3], C [see @smith2020; -@muller2021], D [@team2018].\n'));
    expect(t).toContain('A Smith and Doe (2020), B (Lee et al. 2019, p. 3), C (see Smith and Doe 2020; 2021), D (Real Analytics Team 2018).');
  });

  it('marks a key that is not in the bibliography, and shows keys without a bibliography', () => {
    expect(render('[@nobody]\n')).toContain('<span class="cite missing" title="[@nobody]">(?nobody)</span>');
    const env: Record<string, unknown> = {};
    const doc = parseDoc(qmd, '[@smith2020]\n', env);
    expect(text(qmd.renderer.render(doc.tokens, qmd.options, env))).toContain('(smith2020)');
  });

  it('leaves e-mail addresses, links and plain brackets alone', () => {
    const html = render('Mail a@b.org, [x @y](https://e.org) and [a b].\n');
    expect(html).not.toContain('class="cite');
    expect(html).toContain('<a href="https://e.org">x');
    expect(html).toContain('[a b]');
  });

  it('renders callouts, the reference list, and the content of other divs', () => {
    expect(render('::: {.callout-warning title="Careful"}\nText.\n:::\n')).toContain('<div class="callout callout-warning"><div class="callout-title">Careful</div>\n<p>Text.</p>\n</div>');
    expect(render('::: {#refs}\n:::\n')).toContain('class="quarto-refs"');
    expect(render(':::: {.panel-tabset}\n::: {.inner}\nA\n:::\n::::\n')).toBe('<div class="panel-tabset">\n<div class="inner">\n<p>A</p>\n</div>\n</div>\n');
  });

  it('labels code cells and raw blocks, and shows shortcodes as written', () => {
    expect(render('```{python}\nx = 1\n```\n')).toContain('<div class="qcell"><div class="cell-label">python</div><pre><code class="language-python">x = 1');
    expect(render('```{=latex}\n\\newpage\n```\n')).toContain('<div class="cell-label">raw latex</div>');
    expect(render('{{< pagebreak >}}\n')).toContain('<code class="shortcode">{{&lt; pagebreak &gt;}}</code>');
  });

  it('removes the attributes of a figure and numbers it', () => {
    const html = render('![A plot](plot.png){#fig-plot}\n\nSee @fig-plot.\n');
    expect(html).not.toContain('{#fig-plot}');
    expect(text(html)).toContain('See Figure 1.');
  });

  it('shows the name of an author object in the front matter', () => {
    const r = diffMarkdown(qmd, '---\nauthor:\n  - name: Jane Smith\n---\n', '---\nauthor:\n  - name: Jane Smith\n---\n', options);
    expect(text(rows(r.html)[0].right)).toBe('Jane Smith\n');
  });

  it('leaves Quarto syntax as text in the Markdown parser', () => {
    const html = createMarkdown().render('## A {#sec-a}\n\nSee @sec-a.\n');
    expect(html).toContain('A {#sec-a}');
    expect(html).toContain('See @sec-a.');
  });
});

describe('Quarto diff', () => {
  it('finds no changes in the same document', () => {
    const src = fixture('quarto-old.qmd');
    expect(diffMarkdown(qmd, src, src, options).hunks).toBe(0);
  });

  it('shows only the edits when a new section renumbers the rest', () => {
    const r = diffMarkdown(qmd, fixture('quarto-old.qmd'), fixture('quarto-new.qmd'), options);
    const changed = rows(r.html).filter((x) => x.status !== 'eq');
    // The new section (heading and paragraph), the table row, the callout and the code cell.
    expect(changed.map((x) => x.status)).toEqual(['ins', 'ins', 'chg', 'chg', 'chg']);
    expect(r.hunks).toBe(3);
    // The reference to the renumbered section is not a change, and each side shows its own number.
    const ref = rows(r.html).find((x) => x.left.includes('The method is in'))!;
    expect(ref.status).toBe('eq');
    expect(text(ref.left)).toContain('Section 2.');
    expect(text(ref.right)).toContain('Section 3.');
  });

  it('marks a changed citation key as one unit', () => {
    const r = diffMarkdown(qmd, 'See [@smith2020].\n', 'See [@lee2019].\n', options);
    const [row] = rows(r.html);
    expect(row.left).toContain('<span class="x-del"><span class="cite" title="[@smith2020]">(Smith and Doe 2020)</span></span>');
    expect(row.right).toContain('<span class="x-ins"><span class="cite" title="[@lee2019]">(Lee et al. 2019)</span></span>');
  });

  it('diffs inside a callout and keeps its box', () => {
    const r = diffMarkdown(qmd, '::: {.callout-note}\nOne two.\n:::\n', '::: {.callout-note}\nOne three.\n:::\n', options);
    const [row] = rows(r.html);
    expect(row.status).toBe('chg');
    expect(row.right).toContain('<div class="callout callout-note"><div class="callout-title">Note</div>');
    expect(row.right).toContain('<span class="x-ins">three</span>');
  });

  it('labels a changed code cell', () => {
    const r = diffMarkdown(qmd, '```{r}\nx <- 1\n```\n', '```{r}\nx <- 2\n```\n', options);
    expect(rows(r.html)[0].right).toMatch(/^<div class="cell-label">r<\/div><pre class="code-diff">/);
  });

  it('keeps the number of a changed equation', () => {
    const r = diffMarkdown(qmd, '$$\na + b\n$$ {#eq-x}\n', '$$\na + c\n$$ {#eq-x}\n', options);
    expect(rows(r.html)[0].right).toContain('<span class="eqnum">(1)</span>');
  });
});
