import markdownIt from 'markdown-it';
import type { MarkdownIt, Token } from 'markdown-it';
import katexPlugin from '@vscode/markdown-it-katex';
import yaml from 'js-yaml';

export type { Token };

/** Creates a parser with the same math settings as the built-in VS Code preview. */
export function createMarkdown(): MarkdownIt {
  const md = new markdownIt({ html: true, linkify: true });
  const katexOptions = { enableBareBlocks: true, enableFencedBlocks: true, strict: 'ignore' };
  katexPlugin(md, katexOptions as Parameters<typeof katexPlugin>[1]);
  return md;
}

export interface ParsedDoc {
  frontMatter: Record<string, unknown> | undefined;
  frontMatterError: string | undefined;
  tokens: Token[];
  env: Record<string, unknown>;
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function parseDoc(md: MarkdownIt, source: string): ParsedDoc {
  let body = source;
  let frontMatter: Record<string, unknown> | undefined;
  let frontMatterError: string | undefined;
  const match = FRONT_MATTER.exec(source);
  if (match) {
    // Keep the line count, so that token line maps stay correct.
    body = '\n'.repeat(match[0].split('\n').length - 1) + source.slice(match[0].length);
    try {
      const data = yaml.load(match[1]);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        frontMatter = data as Record<string, unknown>;
      }
    } catch (error) {
      frontMatterError = String(error);
    }
  }
  const env: Record<string, unknown> = {};
  const tokens = md.parse(body, env);
  return { frontMatter, frontMatterError, tokens, env };
}
