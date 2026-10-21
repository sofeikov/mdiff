import katex from 'katex';
import { align, similarity } from './align';

/**
 * Diff of two LaTeX formulas, part by part.
 *
 * The formula is parsed into a small tree: symbols, `{…}` groups, commands with their
 * arguments, sub- and superscripts, `\left…\right` pairs and environments. The two trees
 * are aligned level by level. Each changed part is wrapped in `\htmlClass{f-del}{…}` or
 * `\htmlClass{f-ins}{…}`, and KaTeX renders the result. When the marked formula does not
 * render, the caller falls back to a mark on the whole formula.
 */

type Node =
  | { t: 'tok'; s: string }
  | { t: 'group'; c: Node[] }
  | { t: 'cmd'; name: string; opt?: string; args: Node[] }
  | { t: 'raw'; name: string; src: string }
  | { t: 'scripts'; base: Node | null; sub?: Node; sup?: Node }
  | { t: 'lr'; open: string; close: string; c: Node[] }
  | { t: 'env'; src: string };

/** Commands with arguments. All other commands are symbols. */
const ARITY: Record<string, number> = {
  '\\frac': 2, '\\dfrac': 2, '\\tfrac': 2, '\\cfrac': 2, '\\binom': 2, '\\dbinom': 2, '\\tbinom': 2,
  '\\overset': 2, '\\underset': 2, '\\stackrel': 2, '\\htmlClass': 2,
  '\\sqrt': 1, '\\hat': 1, '\\widehat': 1, '\\bar': 1, '\\overline': 1, '\\underline': 1, '\\tilde': 1,
  '\\widetilde': 1, '\\vec': 1, '\\dot': 1, '\\ddot': 1, '\\check': 1, '\\breve': 1, '\\acute': 1, '\\grave': 1,
  '\\overrightarrow': 1, '\\overleftarrow': 1, '\\overbrace': 1, '\\underbrace': 1, '\\boxed': 1,
  '\\mathrm': 1, '\\mathbf': 1, '\\mathit': 1, '\\mathcal': 1, '\\mathbb': 1, '\\mathsf': 1, '\\mathtt': 1,
  '\\mathfrak': 1, '\\mathscr': 1, '\\boldsymbol': 1, '\\bm': 1, '\\operatorname': 1, '\\operatorname*': 1,
  '\\cancel': 1, '\\phantom': 1, '\\not': 1, '\\color': 1,
  '\\big': 1, '\\Big': 1, '\\bigg': 1, '\\Bigg': 1, '\\bigl': 1, '\\bigr': 1, '\\Bigl': 1, '\\Bigr': 1,
  '\\biggl': 1, '\\biggr': 1, '\\Biggl': 1, '\\Biggr': 1, '\\bigm': 1, '\\Bigm': 1, '\\middle': 1,
};

/** Commands whose argument is text, kept as written. */
/** Commands whose argument must stay a bare token, such as a delimiter. They change as a whole. */
const WHOLE_COMMANDS = new Set([
  '\\big', '\\Big', '\\bigg', '\\Bigg', '\\bigl', '\\bigr', '\\Bigl', '\\Bigr',
  '\\biggl', '\\biggr', '\\Biggl', '\\Biggr', '\\bigm', '\\Bigm', '\\middle', '\\not', '\\color',
]);

const TEXT_COMMANDS = new Set(['\\text', '\\textrm', '\\textit', '\\textbf', '\\textsf', '\\texttt', '\\mbox', '\\textnormal']);

const TOKEN = /\\[a-zA-Z]+\*?|\\[^a-zA-Z]|[0-9]+(?:\.[0-9]+)?|%[^\n]*|\s+|[\s\S]/g;

class FormulaParser {
  private toks: { s: string; at: number }[] = [];
  private i = 0;

  constructor(private readonly src: string) {
    for (const m of src.matchAll(TOKEN)) {
      const s = m[0];
      if (/^\s/.test(s) || s.startsWith('%')) continue;
      // `\name*` is one token only for `\operatorname*`; otherwise the star is a symbol.
      if (s.endsWith('*') && s.length > 2 && s !== '\\operatorname*') {
        this.toks.push({ s: s.slice(0, -1), at: m.index! }, { s: '*', at: m.index! + s.length - 1 });
      } else {
        this.toks.push({ s, at: m.index! });
      }
    }
  }

  parse(): Node[] {
    const nodes = this.seq(null);
    if (this.i < this.toks.length) throw new Error('unbalanced formula');
    return nodes;
  }

  private peek(): string | undefined {
    return this.toks[this.i]?.s;
  }

  private next(): string {
    const tok = this.toks[this.i++];
    if (!tok) throw new Error('unexpected end of formula');
    return tok.s;
  }

  private seq(until: '}' | '\\right' | ']' | null): Node[] {
    const nodes: Node[] = [];
    for (;;) {
      const s = this.peek();
      if (s === undefined) {
        if (until !== null) throw new Error(`missing ${until}`);
        return nodes;
      }
      if (s === until) return nodes;
      if (s === '}' || s === '\\right') throw new Error(`unexpected ${s}`);
      if (s === '^' || s === '_') {
        this.i++;
        const prev = nodes.pop() ?? null;
        const scripts = prev?.t === 'scripts' ? prev : ({ t: 'scripts', base: prev } as Extract<Node, { t: 'scripts' }>);
        const arg = this.atom();
        if (s === '^') scripts.sup = arg;
        else scripts.sub = arg;
        nodes.push(scripts);
        continue;
      }
      nodes.push(this.atom());
    }
  }

  private atom(): Node {
    const s = this.next();
    if (s === '{') {
      const c = this.seq('}');
      this.next();
      return { t: 'group', c };
    }
    if (s === '\\left') {
      const open = this.next();
      const c = this.seq('\\right');
      this.next();
      const close = this.next();
      return { t: 'lr', open, close, c };
    }
    if (s === '\\begin') {
      return { t: 'env', src: this.environment() };
    }
    if (TEXT_COMMANDS.has(s)) {
      return { t: 'raw', name: s, src: this.rawGroup() };
    }
    const arity = ARITY[s];
    if (arity !== undefined) {
      let opt: string | undefined;
      if (s === '\\sqrt' && this.peek() === '[') opt = this.rawBetween('[', ']');
      const args: Node[] = [];
      for (let k = 0; k < arity; k++) args.push(this.atom());
      return { t: 'cmd', name: s, opt, args };
    }
    return { t: 'tok', s };
  }

  /** The source of `{…}` after a text command, as written. */
  private rawGroup(): string {
    if (this.peek() !== '{') return this.next();
    return this.rawBetween('{', '}');
  }

  private rawBetween(open: string, close: string): string {
    const start = this.toks[this.i].at;
    let depth = 0;
    for (;;) {
      const tok = this.toks[this.i++];
      if (!tok) throw new Error('unbalanced formula');
      if (tok.s === open) depth++;
      else if (tok.s === close && --depth === 0) return this.src.slice(start, tok.at + tok.s.length);
    }
  }

  private environment(): string {
    const start = this.toks[this.i - 1].at;
    let depth = 1;
    while (depth > 0) {
      const tok = this.toks[this.i++];
      if (!tok) throw new Error('unbalanced environment');
      if (tok.s === '\\begin') depth++;
      else if (tok.s === '\\end') depth--;
    }
    // The `{name}` after `\end`.
    this.rawBetween('{', '}');
    const last = this.toks[this.i - 1];
    return this.src.slice(start, last.at + last.s.length);
  }
}

function ser(n: Node | null | undefined): string {
  if (!n) return '';
  switch (n.t) {
    case 'tok':
      return n.s;
    case 'group':
      return `{${serSeq(n.c)}}`;
    case 'cmd':
      return `${n.name}${n.opt ?? ''}${n.args.map((a) => ' ' + ser(a)).join('')}`;
    case 'raw':
      return `${n.name}${n.src}`;
    case 'scripts':
      return `${ser(n.base)}${n.sub ? `_${braced(ser(n.sub), n.sub)}` : ''}${n.sup ? `^${braced(ser(n.sup), n.sup)}` : ''}`;
    case 'lr':
      return `\\left${n.open} ${serSeq(n.c)} \\right${n.close}`;
    case 'env':
      return n.src;
  }
}

function serSeq(nodes: Node[]): string {
  return nodes.map(ser).join(' ');
}

function braced(s: string, n: Node): string {
  return n.t === 'group' ? s : `{${s}}`;
}

/** The type that decides which parts can pair: the same kind and, for commands, the same name. */
function shape(n: Node): string {
  switch (n.t) {
    case 'cmd':
    case 'raw':
      return `${n.t}:${n.name}`;
    case 'scripts':
      return `scripts:${n.base ? shape(n.base) : ''}`;
    case 'lr':
      return `lr:${n.open}${n.close}`;
    default:
      return n.t;
  }
}

type Side = 'del' | 'ins';
const mark = (s: string, side: Side) => `\\htmlClass{f-${side}}{${s}}`;

interface Piece {
  s: string;
  marked: boolean;
}

/** Joins pieces, and wraps each run of marked pieces in one mark. */
function joinPieces(pieces: Piece[], side: Side): string {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(mark(run.join(' '), side));
    run = [];
  };
  for (const p of pieces) {
    if (p.marked) run.push(p.s);
    else {
      flush();
      out.push(p.s);
    }
  }
  flush();
  return out.join(' ');
}

function diffSeq(a: Node[], b: Node[]): [string, string] {
  const item = (n: Node) => ({ n, type: shape(n), key: ser(n), text: ser(n) });
  const left: Piece[] = [];
  const right: Piece[] = [];
  for (const op of align(a.map(item), b.map(item))) {
    if (op.op === 'eq') {
      left.push({ s: op.a.key, marked: false });
      right.push({ s: op.b.key, marked: false });
    } else if (op.op === 'chg') {
      const [l, r] = diffNode(op.a.n, op.b.n);
      left.push(l);
      right.push(r);
    } else if (op.op === 'del') {
      left.push({ s: op.a.key, marked: true });
    } else {
      right.push({ s: op.b.key, marked: true });
    }
  }
  return [joinPieces(left, 'del'), joinPieces(right, 'ins')];
}

/** Diffs two nodes of the same shape. A part that cannot be diffed further is marked whole. */
function diffNode(a: Node, b: Node): [Piece, Piece] {
  const whole = (): [Piece, Piece] => [
    { s: ser(a), marked: true },
    { s: ser(b), marked: true },
  ];
  const inner = (l: string, r: string): [Piece, Piece] => [
    { s: l, marked: false },
    { s: r, marked: false },
  ];
  if (ser(a) === ser(b)) return inner(ser(a), ser(b));
  if (a.t === 'group' && b.t === 'group') {
    const [l, r] = diffSeq(a.c, b.c);
    return inner(`{${l}}`, `{${r}}`);
  }
  if (a.t === 'lr' && b.t === 'lr' && a.open === b.open && a.close === b.close) {
    const [l, r] = diffSeq(a.c, b.c);
    return inner(`\\left${a.open} ${l} \\right${a.close}`, `\\left${b.open} ${r} \\right${b.close}`);
  }
  if (a.t === 'cmd' && b.t === 'cmd' && !WHOLE_COMMANDS.has(a.name) && a.name === b.name && a.opt === b.opt && a.args.length === b.args.length) {
    const ls: string[] = [];
    const rs: string[] = [];
    a.args.forEach((arg, k) => {
      const [l, r] = diffArg(arg, b.args[k]);
      ls.push(l);
      rs.push(r);
    });
    return inner(`${a.name}${a.opt ?? ''} ${ls.join(' ')}`, `${b.name}${b.opt ?? ''} ${rs.join(' ')}`);
  }
  if (a.t === 'scripts' && b.t === 'scripts') {
    let baseL = '';
    let baseR = '';
    if (a.base && b.base && shape(a.base) === shape(b.base)) {
      const [l, r] = diffNode(a.base, b.base);
      baseL = l.marked ? mark(l.s, 'del') : l.s;
      baseR = r.marked ? mark(r.s, 'ins') : r.s;
    } else if (ser(a.base) !== ser(b.base)) {
      baseL = a.base ? mark(ser(a.base), 'del') : '';
      baseR = b.base ? mark(ser(b.base), 'ins') : '';
    } else {
      baseL = ser(a.base);
      baseR = ser(b.base);
    }
    const script = (x: Node | undefined, y: Node | undefined, op: string): [string, string] => {
      if (!x && !y) return ['', ''];
      if (x && !y) return [`${op}{${mark(ser(x), 'del')}}`, ''];
      if (!x && y) return ['', `${op}{${mark(ser(y), 'ins')}}`];
      const [l, r] = diffArg(x!, y!);
      return [`${op}${l}`, `${op}${r}`];
    };
    const [subL, subR] = script(a.sub, b.sub, '_');
    const [supL, supR] = script(a.sup, b.sup, '^');
    return inner(`${baseL}${subL}${supL}`, `${baseR}${subR}${supR}`);
  }
  return whole();
}

/** Diffs an argument and returns it in braces. */
function diffArg(a: Node, b: Node): [string, string] {
  if (ser(a) === ser(b)) return [braced(ser(a), a), braced(ser(b), b)];
  if (shape(a) === shape(b) && a.t !== 'tok' && a.t !== 'raw' && a.t !== 'env') {
    const [l, r] = diffNode(a, b);
    const ls = l.marked ? mark(l.s, 'del') : l.s;
    const rs = r.marked ? mark(r.s, 'ins') : r.s;
    return [a.t === 'group' ? ls : `{${ls}}`, b.t === 'group' ? rs : `{${rs}}`];
  }
  return [`{${mark(ser(a), 'del')}}`, `{${mark(ser(b), 'ins')}}`];
}

/** Formulas with fewer parts in common than this are marked whole. */
const MIN_FORMULA_SIMILARITY = 0.3;

const KATEX_OPTIONS = {
  throwOnError: true,
  strict: 'ignore' as const,
  trust: (ctx: { command: string }) => ctx.command === '\\htmlClass',
};

/**
 * Renders two versions of a formula with the changed parts marked.
 * Returns undefined when the formulas cannot be diffed part by part.
 */
export function diffFormula(oldTex: string, newTex: string, displayMode: boolean): { left: string; right: string } | undefined {
  try {
    const a = new FormulaParser(oldTex).parse();
    const b = new FormulaParser(newTex).parse();
    // Compare the parts, not the characters, so that `\alpha` counts as one part.
    if (similarity(serSeq(a), serSeq(b)) < MIN_FORMULA_SIMILARITY) return undefined;
    const [l, r] = diffSeq(a, b);
    return {
      left: katex.renderToString(l, { ...KATEX_OPTIONS, displayMode }),
      right: katex.renderToString(r, { ...KATEX_OPTIONS, displayMode }),
    };
  } catch {
    return undefined;
  }
}
