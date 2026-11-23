import type { Token } from 'markdown-it';
import type { CellInfo } from './quarto';

// Mermaid diagrams. The parser marks each code block that is a diagram with its source, in a
// `data-mermaid` attribute on its `<pre>`, and the page draws the diagram from it
// (`src/webview/diagrams.ts`). The page also takes the colour theme of the diagram from here.

/**
 * True when a code block is a Mermaid diagram that the rendered document draws: a ```mermaid
 * block in Markdown, as GitHub and the VS Code preview with Mermaid draw it, and a `{mermaid}`
 * cell in Quarto, as Quarto does (a plain ```mermaid block stays code there), unless the cell is
 * left out of the document (`include: false`).
 */
export function isMermaid(tok: Token, quarto: boolean): boolean {
  if (tok.type !== 'fence') return false;
  if (quarto) {
    const cell = (tok.meta as { cell?: CellInfo } | null)?.cell;
    return !!cell?.diagram && cell.lang.toLowerCase() === 'mermaid' && cell.code !== 'excluded';
  }
  return tok.info.trim().split(/\s+/)[0].toLowerCase() === 'mermaid';
}

/**
 * ` data-mermaid="…"` with the source of a block that the parser marked as a diagram, else ''.
 * The source is URI-encoded: it has no quotes or `<` then, nor any `-->` (which every arrow has),
 * which HTML sanitizers take for the end of a comment.
 */
export function mermaidAttr(tok: Token): string {
  return (tok.meta as { mermaid?: boolean } | null)?.mermaid ? ` data-mermaid="${encodeURIComponent(tok.content)}"` : '';
}

/**
 * Mermaid's theme for VS Code's, from the class of the webview's body: `dark` for dark and high
 * contrast themes. A high contrast light theme also has `vscode-high-contrast`, for older pages.
 */
export function mermaidTheme(bodyClass: string): 'dark' | 'default' {
  const classes = bodyClass.split(/\s+/);
  if (classes.includes('vscode-high-contrast-light')) return 'default';
  return classes.includes('vscode-dark') || classes.includes('vscode-high-contrast') ? 'dark' : 'default';
}
