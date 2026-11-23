import { describe, expect, it } from 'vitest';
import { diffMarkdown, previewMarkdown } from '../src/core/diff';
import { createMarkdown } from '../src/core/markdown';
import { mermaidTheme } from '../src/core/mermaid';

const md = createMarkdown();
const qmd = createMarkdown({ quarto: true });
const options = { formulaParts: true };

/** The decoded sources of the diagrams that a page would draw, in order. */
const sources = (html: string) => [...html.matchAll(/<pre[^>]* data-mermaid="([^"]*)"/g)].map((m) => decodeURIComponent(m[1]));

const flow = 'flowchart LR\n  A["Start & <go>"] --> B\n';

describe('Mermaid diagrams', () => {
  it('marks a ```mermaid block in Markdown with its source', () => {
    const html = md.render(['```mermaid', flow.trimEnd(), '```', '', '```Mermaid  title', 'pie', '```', '', '```js', 'a --> b', '```'].join('\n'));
    expect(sources(html)).toEqual([flow, 'pie\n']);
    expect(html).toContain('<pre data-mermaid="');
    expect(html).toContain('<code class="language-mermaid">');
  });

  it('marks diagrams in lists and quotes', () => {
    expect(sources(md.render('- item\n\n  ```mermaid\n  pie\n  ```\n\n> ```mermaid\n> pie\n> ```\n'))).toEqual(['pie\n', 'pie\n']);
  });

  it('encodes the source, so the attribute has no quotes, `<` or `-->`', () => {
    const attr = /data-mermaid="([^"]*)"/.exec(md.render('```mermaid\n' + flow + '```\n'))![1];
    expect(attr).not.toMatch(/["<>&]|-->/);
    expect(decodeURIComponent(attr)).toBe(flow);
  });

  it('in Quarto, marks `{mermaid}` cells, but not plain ```mermaid blocks, Graphviz or left-out cells', () => {
    const doc = [
      '```{mermaid}', '%%| label: fig-a', 'flowchart TD', '```', '',
      '```mermaid', 'flowchart TD', '```', '',
      '```{dot}', 'digraph { a -> b }', '```', '',
      '```{mermaid}', '%%| include: false', 'pie', '```', '',
      '```{mermaid}', '%%| echo: true', 'pie', '```', '',
    ].join('\n');
    const html = previewMarkdown(qmd, doc, options).html;
    expect(sources(html)).toEqual(['%%| label: fig-a\nflowchart TD\n', '%%| echo: true\npie\n']);
    expect(html).toContain('<div class="cell-label">mermaid diagram</div>');
    expect(html).toContain('<div class="cell-label">dot diagram · drawn when the document is rendered</div>');
  });

  it('keeps the source of each side on a changed diagram, with its lines marked', () => {
    const r = diffMarkdown(md, '```mermaid\nflowchart LR\n  A --> B\n```\n', '```mermaid\nflowchart LR\n  A --> C\n```\n', options);
    expect(r.changed).toBe(1);
    expect(sources(r.html)).toEqual(['flowchart LR\n  A --> B\n', 'flowchart LR\n  A --> C\n']);
    expect(r.html).toContain('<pre class="code-diff" data-mermaid="');
    expect(r.html).toContain('<span class="l-ins">  A --&gt; C</span>');
  });

  it('marks a changed `{mermaid}` cell in Quarto too, and not a changed plain block', () => {
    const cell = (to: string) => `\`\`\`{mermaid}\nflowchart LR\n  A --> ${to}\n\`\`\`\n`;
    const r = diffMarkdown(qmd, cell('B'), cell('C'), options);
    expect(sources(r.html)).toEqual(['flowchart LR\n  A --> B\n', 'flowchart LR\n  A --> C\n']);
    const plain = diffMarkdown(qmd, '```mermaid\nA --> B\n```\n', '```mermaid\nA --> C\n```\n', options);
    expect(sources(plain.html)).toEqual([]);
  });

  it('takes the dark Mermaid theme for dark and high contrast VS Code themes', () => {
    expect(mermaidTheme('vscode-dark')).toBe('dark');
    expect(mermaidTheme('only vscode-high-contrast preview')).toBe('dark');
    expect(mermaidTheme('vscode-light')).toBe('default');
    // VS Code puts both classes on the body for a high contrast light theme.
    expect(mermaidTheme('vscode-high-contrast-light vscode-high-contrast')).toBe('default');
    expect(mermaidTheme('vscode-high-contrast-light')).toBe('default');
    expect(mermaidTheme('')).toBe('default');
  });
});
