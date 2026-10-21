import type { MarkdownIt } from 'markdown-it';
import yaml from 'js-yaml';
import type { ParsedDoc, Token } from './markdown';

/**
 * One block of a rendered document.
 *
 * - `leaf`: a paragraph, a heading or a front matter line. It has inline content.
 * - `math`, `code`: diffed as one unit or line by line.
 * - `container`: a list, a list item or a blockquote. It has child blocks.
 * - `table`: rows of cells with inline content.
 * - `opaque`: anything else. It is compared and shown as one unit.
 */
export interface Block {
  kind: 'leaf' | 'math' | 'code' | 'container' | 'table' | 'opaque';
  /** The kind and tag, for example `paragraph`, `heading:h2`, `bullet_list`. Blocks pair only when this is the same. */
  type: string;
  /** Tokens from the open token to the close token, inclusive. */
  tokens: Token[];
  /** The inline token of a leaf block. */
  inline?: Token;
  /** The HTML element of a leaf block, and its class. */
  tag?: string;
  cls?: string;
  /** True for the paragraphs of a tight list item, which render without `<p>`. */
  hidden?: boolean;
  children?: Block[];
  rows?: TableRow[];
  /** Pre-rendered HTML, for synthetic blocks that have no tokens. */
  html?: string;
  /** Rendered HTML. Two blocks are equal when this is equal. */
  key: string;
  /** Plain text, for the similarity score. */
  text: string;
  /** First source line (0-based), if known. */
  line?: number;
}

export interface TableRow {
  section: 'thead' | 'tbody';
  cells: { tag: string; style: string | null; inline: Token }[];
  key: string;
  text: string;
}

export class BlockBuilder {
  constructor(
    readonly md: MarkdownIt,
    readonly env: Record<string, unknown>,
  ) {}

  render(tokens: Token[]): string {
    return this.md.renderer.render(tokens, this.md.options, this.env);
  }

  renderInline(tokens: Token[]): string {
    return this.md.renderer.renderInline(tokens, this.md.options, this.env);
  }

  /** Builds the blocks of a document: the front matter first, then the body. */
  documentBlocks(doc: ParsedDoc): Block[] {
    const blocks: Block[] = [];
    if (doc.frontMatter) {
      blocks.push(...this.frontMatterBlocks(doc.frontMatter));
    }
    if (doc.frontMatterError) {
      const html = `<pre class="fm-error">Front matter error: ${this.md.utils.escapeHtml(doc.frontMatterError)}</pre>`;
      blocks.push({ kind: 'opaque', type: 'fm_error', tokens: [], html, key: html, text: doc.frontMatterError });
    }
    blocks.push(...this.build(doc.tokens, 0, doc.tokens.length));
    return blocks;
  }

  build(tokens: Token[], start: number, end: number): Block[] {
    const blocks: Block[] = [];
    let i = start;
    while (i < end) {
      const tok = tokens[i];
      if (tok.nesting === -1) {
        i++;
        continue;
      }
      if (tok.nesting === 0) {
        blocks.push(this.single(tok));
        i++;
        continue;
      }
      const close = findClose(tokens, i, end);
      blocks.push(this.compound(tokens, i, close));
      i = close + 1;
    }
    return blocks;
  }

  private single(tok: Token): Block {
    const tokens = [tok];
    const key = this.render(tokens);
    const line = tok.map?.[0];
    if (tok.type === 'math_block' || tok.type === 'math_block_eqno' || (tok.type === 'fence' && tok.info.trim().toLowerCase() === 'math')) {
      return { kind: 'math', type: 'math', tokens, key, text: tok.content, line };
    }
    if (tok.type === 'fence' || tok.type === 'code_block') {
      return { kind: 'code', type: 'code', tokens, key, text: tok.content, line };
    }
    return { kind: 'opaque', type: tok.type, tokens, key, text: tok.content, line };
  }

  private compound(tokens: Token[], open: number, close: number): Block {
    const tok = tokens[open];
    const slice = tokens.slice(open, close + 1);
    const key = this.render(slice);
    const line = tok.map?.[0];
    const base = tok.type.replace(/_open$/, '');

    if ((base === 'paragraph' || base === 'heading') && close === open + 2 && tokens[open + 1].type === 'inline') {
      const inline = tokens[open + 1];
      return {
        kind: 'leaf',
        type: base === 'heading' ? `heading:${tok.tag}` : 'paragraph',
        tokens: slice,
        inline,
        tag: tok.tag,
        hidden: tok.hidden,
        key,
        text: inlineText(inline),
        line,
      };
    }
    if (base === 'table') {
      const rows = this.tableRows(tokens, open, close);
      return { kind: 'table', type: 'table', tokens: slice, rows, key, text: rows.map((r) => r.text).join('\n'), line };
    }
    if (base === 'bullet_list' || base === 'ordered_list' || base === 'list_item' || base === 'blockquote') {
      const children = this.build(tokens, open + 1, close);
      return { kind: 'container', type: base, tokens: slice, children, key, text: children.map((c) => c.text).join('\n'), line };
    }
    return { kind: 'opaque', type: base, tokens: slice, key, text: slice.map((t) => t.content).join(' '), line };
  }

  private tableRows(tokens: Token[], open: number, close: number): TableRow[] {
    const rows: TableRow[] = [];
    let section: TableRow['section'] = 'tbody';
    let row: TableRow | undefined;
    for (let i = open + 1; i < close; i++) {
      const tok = tokens[i];
      if (tok.type === 'thead_open') section = 'thead';
      else if (tok.type === 'tbody_open') section = 'tbody';
      else if (tok.type === 'tr_open') row = { section, cells: [], key: '', text: '' };
      else if ((tok.type === 'th_open' || tok.type === 'td_open') && row) {
        const inline = tokens[i + 1];
        const style = tok.attrGet('style');
        row.cells.push({ tag: tok.tag, style: style === null ? null : String(style), inline });
      } else if (tok.type === 'tr_close' && row) {
        row.key = row.section + ':' + row.cells.map((c) => `${c.tag}|${c.style ?? ''}|${this.renderInline(c.inline.children ?? [])}`).join('\u0001');
        row.text = row.cells.map((c) => inlineText(c.inline)).join(' ');
        rows.push(row);
        row = undefined;
      }
    }
    return rows;
  }

  /** Builds blocks for Pandoc-style front matter: title, subtitle, author, date, abstract, then other keys. */
  frontMatterBlocks(data: Record<string, unknown>): Block[] {
    const blocks: Block[] = [];
    const lineField = (field: string, tag: string, cls: string) => {
      const value = data[field];
      if (value === undefined || value === null) return;
      const text = Array.isArray(value) ? value.map(String).join(', ') : String(value);
      const inline = this.md.parseInline(text, this.env)[0];
      blocks.push({
        kind: 'leaf',
        type: `fm:${field}`,
        tokens: [],
        inline,
        tag,
        cls,
        key: `fm:${field}:${this.renderInline(inline.children ?? [])}`,
        text,
      });
    };
    lineField('title', 'h1', 'fm-title');
    lineField('subtitle', 'p', 'fm-subtitle');
    lineField('author', 'p', 'fm-author');
    lineField('date', 'p', 'fm-date');

    if (data.abstract !== undefined && data.abstract !== null) {
      const env: Record<string, unknown> = {};
      const tokens = this.md.parse(String(data.abstract), env);
      const heading = '<p class="fm-abstract-label">Abstract</p>';
      blocks.push({ kind: 'opaque', type: 'fm:abstract-label', tokens: [], html: heading, key: heading, text: 'Abstract' });
      for (const block of new BlockBuilder(this.md, env).build(tokens, 0, tokens.length)) {
        blocks.push(markAbstract(block));
      }
    }

    const known = new Set(['title', 'subtitle', 'author', 'date', 'abstract']);
    const rest = Object.entries(data).filter(([k]) => !known.has(k));
    if (rest.length > 0) {
      const esc = this.md.utils.escapeHtml;
      const rows = rest
        .map(([k, v]) => `<tr><th>${esc(k)}</th><td><code>${esc(yaml.dump(v, { flowLevel: 1 }).trim())}</code></td></tr>`)
        .join('');
      const html = `<table class="fm-meta">${rows}</table>`;
      blocks.push({ kind: 'opaque', type: 'fm:meta', tokens: [], html, key: html, text: rest.map(([k, v]) => `${k} ${String(v)}`).join(' ') });
    }
    return blocks;
  }
}

function markAbstract(block: Block): Block {
  return { ...block, type: `abstract:${block.type}`, cls: 'fm-abstract', key: `abstract:${block.key}` };
}

function findClose(tokens: Token[], open: number, end: number): number {
  const level = tokens[open].level;
  for (let j = open + 1; j < end; j++) {
    if (tokens[j].nesting === -1 && tokens[j].level === level) return j;
  }
  return end - 1;
}

export function inlineText(inline: Token): string {
  return (inline.children ?? []).map((t) => t.content).join(' ');
}
