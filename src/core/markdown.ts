import markdownIt from 'markdown-it';
import type { MarkdownIt, Token } from 'markdown-it';
import katexPlugin from '@vscode/markdown-it-katex';
import katex from 'katex';
import yaml from 'js-yaml';
import { isMermaid, mermaidAttr } from './mermaid';
import { mergeMeta, quartoPlugin, type QuartoContext } from './quarto';

export type { Token };

/** The most formulas that one parser keeps rendered. */
const FORMULA_CACHE_SIZE = 5000;

/** True for a Quarto document. */
export function isQuartoPath(path: string): boolean {
  return /\.qmd$/i.test(path);
}

/**
 * Creates a parser with the same math settings as the built-in VS Code preview.
 * With `quarto`, the parser also reads Quarto syntax (see `quarto.ts`).
 *
 * The parser keeps the HTML of each formula that it renders. A diff renders the same formula
 * several times (for the block keys and for the output), and a live update renders the
 * unchanged formulas again, so the cache saves most of the KaTeX work.
 */
export function createMarkdown(options: { quarto?: boolean } = {}): MarkdownIt {
  const md = new markdownIt({ html: true, linkify: true });
  const cache = new Map<string, string>();
  const cachedKatex = {
    ...katex,
    renderToString(tex: string, options?: katex.KatexOptions): string {
      const key = `${options?.displayMode ? 'D' : 'I'}${tex}`;
      let html = cache.get(key);
      if (html === undefined) {
        // An error is not kept: the plugin catches it and renders an error message.
        html = katex.renderToString(tex, options);
        if (cache.size >= FORMULA_CACHE_SIZE) cache.clear();
        cache.set(key, html);
      }
      return html;
    },
  };
  const katexOptions = { enableBareBlocks: true, enableFencedBlocks: true, strict: 'ignore', katex: cachedKatex };
  katexPlugin(md, katexOptions as Parameters<typeof katexPlugin>[1]);
  mermaidPlugin(md, !!options.quarto);
  if (options.quarto) quartoPlugin(md);
  return md;
}

/**
 * Marks the Mermaid diagrams (see `mermaid.ts`), after the Quarto rules have read the cells, and
 * puts their source on their `<pre>`. The Quarto rule for cells renders the code with this rule.
 */
function mermaidPlugin(md: MarkdownIt, quarto: boolean): void {
  md.core.ruler.push('mermaid', (s) => {
    for (const tok of s.tokens) {
      if (isMermaid(tok, quarto)) tok.meta = { ...tok.meta, mermaid: true };
    }
  });
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = fence(tokens, idx, options, env, self);
    const attr = mermaidAttr(tokens[idx]);
    return attr ? html.replace(/^<pre/, `<pre${attr}`) : html;
  };
}

export interface ParsedDoc {
  frontMatter: Record<string, unknown> | undefined;
  frontMatterError: string | undefined;
  /** The number of source lines of the front matter, with its `---` lines. */
  frontMatterLines: number;
  tokens: Token[];
  env: Record<string, unknown>;
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Parses a document. `env` can hold values for the parser rules, such as the bibliography of a
 * Quarto document and its `quartoContext`, whose project metadata the rules read under the
 * front matter's (section numbers, `execute:`).
 */
export function parseDoc(md: MarkdownIt, source: string, env: Record<string, unknown> = {}): ParsedDoc {
  let body = source;
  let frontMatter: Record<string, unknown> | undefined;
  let frontMatterError: string | undefined;
  let frontMatterLines = 0;
  const match = FRONT_MATTER.exec(source);
  if (match) {
    // Keep the line count, so that token line maps stay correct.
    frontMatterLines = match[0].split('\n').length - 1;
    body = '\n'.repeat(frontMatterLines) + source.slice(match[0].length);
    try {
      const data = yaml.load(match[1]);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        frontMatter = data as Record<string, unknown>;
      }
    } catch (error) {
      frontMatterError = String(error);
    }
  }
  const project = (env.quartoContext as QuartoContext | undefined)?.project;
  env.frontMatter = project ? mergeMeta(project, frontMatter) : frontMatter;
  const tokens = md.parse(body, env);
  return { frontMatter, frontMatterError, frontMatterLines, tokens, env };
}
