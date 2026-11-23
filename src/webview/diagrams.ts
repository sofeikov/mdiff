// Draws the Mermaid diagrams of the rendered diff and of the preview. The build bundles this file
// into `media/mermaid/diagrams.js`, which the page loads before `preview.js`; `preview.js` calls
// `mdiffDiagrams.draw` on the rows it puts in.
//
// The parser marks each diagram's `<pre>` with its source (`data-mermaid`, URI-encoded, see
// `core/mermaid.ts`). Where the code is shown as it is, the diagram takes its place, as in the
// rendered document. Where the code has its changed lines marked (`pre.code-diff`), the diagram
// goes below it, so the marks stay in view. Each side of a diff draws its own source. A diagram
// that Mermaid can't draw stays code, with a note saying why.
//
// The Mermaid library is large, so the page loads it only when it has a diagram to draw; its URL
// is on the body (`data-mermaid`).
import { mermaidTheme } from '../core/mermaid';

interface Mermaid {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

type Drawing = { svg: string } | { error: string };

/** The drawings made so far, by theme and source: rows that are built again draw from these. */
const drawings = new Map<string, Promise<Drawing>>();
const done = new Map<string, Drawing>();
let library: Promise<Mermaid | undefined> | undefined;
let initialized: string | undefined;
let count = 0;

/**
 * Mermaid runs in an empty frame of its own. It lays out labels by measuring them in the
 * document, and the page's styles would change what it measured there. The frame is about:blank,
 * which shares the page's origin and its content security policy, so the page's nonce lets the
 * library in. A shadow root would not do: Mermaid finds its elements by id in the document.
 *
 * In VS Code, the webview's files come through a service worker that serves the page but not
 * the frame, so the page fetches the library and the frame runs it as an inline script. A page
 * opened from a file can't fetch; there the frame loads the library itself.
 */
function load(): Promise<Mermaid | undefined> {
  const src = document.body.dataset.mermaid;
  if (!src) return Promise.resolve(undefined);
  return (library ??= (async () => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    // Laid out, as labels are measured, but out of sight.
    frame.style.cssText = 'position: fixed; left: -10000px; top: 0; width: 1600px; height: 900px; border: 0; visibility: hidden;';
    document.body.append(frame);
    const win = frame.contentWindow as (Window & { mermaid?: Mermaid }) | null;
    const doc = frame.contentDocument;
    if (!win || !doc) return undefined;
    const url = new URL(src, document.baseURI).href;
    const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
    const script = () => {
      const s = doc.createElement('script');
      if (nonce) s.nonce = nonce;
      return s;
    };
    const code = await fetch(url).then((r) => (r.ok ? r.text() : undefined)).catch(() => undefined);
    if (code !== undefined) {
      const s = script();
      s.textContent = code;
      // An inline script runs as it is put in.
      doc.head.append(s);
      if (win.mermaid) return win.mermaid;
    }
    return new Promise<Mermaid | undefined>((resolve) => {
      const s = script();
      s.src = url;
      s.onload = () => resolve(win.mermaid);
      s.onerror = () => resolve(undefined);
      doc.head.append(s);
    });
  })());
}

/** The diagram drawn from `source` in `theme`, or why it couldn't be drawn. */
function drawing(source: string, theme: string): Promise<Drawing> {
  const key = `${theme}\n${source}`;
  let d = drawings.get(key);
  if (!d) {
    // One drawing at a time, as the theme is set for all of them.
    const previous = Promise.all([...drawings.values()]);
    d = previous
      .then(load)
      .then(async (mermaid): Promise<Drawing> => {
        if (!mermaid) return { error: 'the Mermaid library didn’t load' };
        try {
          if (initialized !== theme) {
            // `strict` escapes HTML in labels and turns off click handlers.
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, suppressErrorRendering: true });
            initialized = theme;
          }
          return { svg: (await mermaid.render(`mdiff-mermaid-${++count}`, source)).svg };
        } catch (e) {
          return { error: (e instanceof Error ? e.message : String(e)).split('\n')[0].replace(/^Error: /, '').replace(/:$/, '') };
        }
      })
      .then((result) => {
        done.set(key, result);
        return result;
      });
    drawings.set(key, d);
  }
  return d;
}

/**
 * The element that shows a drawing. The SVG goes in a shadow root, where the page's styles don't
 * reach it, and as markup, so a script in it would never run (nor would the page's policy let it).
 */
function element(d: Drawing): HTMLElement {
  if ('error' in d) {
    const note = document.createElement('div');
    note.className = 'mermaid-out mermaid-error';
    note.textContent = `Couldn’t draw this Mermaid diagram: ${d.error}`;
    return note;
  }
  const figure = document.createElement('div');
  figure.className = 'mermaid-out mermaid-diagram';
  figure.setAttribute('role', 'img');
  figure.setAttribute('aria-label', 'Mermaid diagram');
  const host = document.createElement('div');
  host.attachShadow({ mode: 'open' }).innerHTML =
    `<style>:host { all: initial; display: block; } svg { display: block; height: auto; margin: 0 auto; }</style>${d.svg}`;
  figure.append(host);
  return figure;
}

/** Puts a drawing after its `<pre>`, in place of an older one (from another theme). */
function put(pre: HTMLElement, d: Drawing, theme: string): void {
  // The rows or the theme may have changed while it was drawing; the call after that change drew
  // the new ones.
  if (!pre.isConnected || pre.dataset.drawn === theme || theme !== mermaidTheme(document.body.className)) return;
  pre.dataset.drawn = theme;
  const old = pre.nextElementSibling;
  if (old?.classList.contains('mermaid-out')) old.remove();
  pre.after(element(d));
  // The diagram takes the place of code without marks; code with marked lines stays above it.
  pre.classList.toggle('mermaid-source', 'svg' in d && !pre.classList.contains('code-diff'));
}

/**
 * Draws the diagrams under `root` in the current colour theme. A diagram drawn before goes in at
 * once, so that the page, which restores its scroll position after it puts rows in, doesn't jump
 * when the diagram replaces the code; a new one goes in when it is ready.
 */
function draw(root: ParentNode): void {
  const theme = mermaidTheme(document.body.className);
  for (const pre of root.querySelectorAll<HTMLElement>('pre[data-mermaid]')) {
    if (pre.dataset.drawn === theme) continue;
    const source = decodeURIComponent(pre.dataset.mermaid ?? '');
    const ready = done.get(`${theme}\n${source}`);
    if (ready) put(pre, ready, theme);
    else void drawing(source, theme).then((d) => put(pre, d, theme));
  }
}

(window as unknown as { mdiffDiagrams: { draw: typeof draw } }).mdiffDiagrams = { draw };

// VS Code changes the class of the body when the colour theme changes: draw again in the new theme.
// The old drawings stay until the new ones replace them.
new MutationObserver(() => {
  const content = document.getElementById('content');
  if (content) draw(content);
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });
