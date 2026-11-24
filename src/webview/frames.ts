// Outputs of a Quarto build that draw themselves with scripts (a Plotly figure written as HTML,
// say), each in a sandboxed frame of its own: its scripts run there, and can reach neither the
// page nor VS Code. The build bundles this file into `media/frames/frames.js`, which the page
// loads before `preview.js`; `preview.js` calls `mdiffFrames.place` on the rows it puts in.
//
// The extension marks such an output with its HTML (`data-frame`, URI-encoded, see
// `core/quarto.ts`); `core/outputFrame.ts` makes the frame's document from it, with the scripts
// the output loads from the web put in as text, which the extension downloads
// (`src/outputScripts.ts`). The frame is `sandbox="allow-scripts"` with `srcdoc`: it gets the
// page's content security policy, so the scripts carry the page's nonce, and it has no origin of
// its own, so it can't reach the page, its scripts or `acquireVsCodeApi`.
//
// A frame is made when its place comes near the view, as a plotting library takes a moment to
// start. A row that is the same after an update stays in the page with its frame (`setRows` in
// `preview.js` moves it with `moveBefore`, which doesn't load a frame again).
import { frameDocument, frameScripts, type FrameScript } from '../core/outputFrame';

type ScriptReply = { text?: string; error?: string };

let ask: ((scripts: FrameScript[]) => void) | undefined;
let shown: (height: number) => void = () => undefined;
/** The scripts downloaded so far, by URL. */
const texts = new Map<string, string>();
const waiting = new Map<string, ((reply: ScriptReply) => void)[]>();
/** The frames, by the number each one's document reports its height under. */
const byId = new Map<number, HTMLIFrameElement>();
let count = 0;
let watcher: IntersectionObserver | undefined;

/**
 * Whether a message came from an output's frame, or from a frame inside one. The page's own
 * listener must not take one of these for the extension's: a script of the document would then
 * feed the page its rows. A sandboxed frame has no origin of its own, and so have the frames it
 * makes: their messages say "null", while the extension's come from the webview's origin. (The
 * window around the page can't be asked for: VS Code takes `window.parent` away.)
 */
function fromFrame(event: MessageEvent): boolean {
  if (!event.source || event.source === window) return false;
  return event.origin === 'null' || [...byId.values()].some((frame) => frame.contentWindow === event.source);
}

/**
 * Starts listening to the frames. `post` asks the extension for scripts; without it (the page
 * opened from a file) an output that loads a script from the web can't be drawn. `onShown` hears
 * the height of a frame when its content is laid out, for the tests.
 */
function init(post: ((scripts: FrameScript[]) => void) | undefined, onShown?: (height: number) => void): void {
  ask = post;
  if (onShown) shown = onShown;
  window.addEventListener('message', (event: MessageEvent<{ mdiffFrame?: unknown; height?: unknown } | null>) => {
    const data = event.data;
    if (!data || typeof data.mdiffFrame !== 'number' || typeof data.height !== 'number') return;
    const frame = byId.get(data.mdiffFrame);
    // Only a frame's own document sets its height. A frame that isn't laid out yet says 0.
    if (frame && event.source === frame.contentWindow && data.height > 0) {
      const height = Math.min(Math.ceil(data.height), 6000);
      if (frame.style.height !== `${height}px`) {
        frame.style.height = `${height}px`;
        shown(height);
      }
    }
  });
}

/** The extension's answer about one script. */
function reply(url: string, r: ScriptReply): void {
  if (r.text !== undefined) texts.set(url, r.text);
  const list = waiting.get(url) ?? [];
  waiting.delete(url);
  list.forEach((done) => done(r));
}

function script(s: FrameScript): Promise<ScriptReply> {
  const text = texts.get(s.url);
  if (text !== undefined) return Promise.resolve({ text });
  if (!ask) return Promise.resolve({ error: 'scripts load only in VS Code' });
  const post = ask;
  return new Promise((done) => {
    const list = waiting.get(s.url);
    if (list) list.push(done);
    else {
      waiting.set(s.url, [done]);
      post([s]);
    }
  });
}

/** The height an output asks for at its start, which its place has until the frame says its own. */
function heightHint(html: string): number | undefined {
  const m = /height:\s*(\d+)px/.exec(html.slice(0, 400));
  return m ? Math.min(Math.max(Number(m[1]), 40), 6000) : undefined;
}

function decode(holder: HTMLElement): string {
  try {
    return decodeURIComponent(holder.dataset.frame ?? '');
  } catch {
    return '';
  }
}

/**
 * After rows are put in: watches the places under `root` that have no frame yet, and forgets the
 * frames whose rows are gone.
 */
function place(root: ParentNode): void {
  watcher ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          watcher?.unobserve(e.target);
          void fill(e.target as HTMLElement);
        }
      }
    },
    { rootMargin: '600px 0px' },
  );
  for (const holder of root.querySelectorAll<HTMLElement>('.qout-frame[data-frame]')) {
    // A row that stayed in the page keeps its frame, or is watched already.
    if (holder.dataset.placed) continue;
    holder.dataset.placed = '1';
    const hint = heightHint(decode(holder));
    const note = holder.querySelector<HTMLElement>('.qfig-ph');
    if (hint && note) note.style.minHeight = `${hint}px`;
    watcher.observe(holder);
  }
  for (const [id, frame] of byId) if (!frame.isConnected) byId.delete(id);
}

async function fill(holder: HTMLElement): Promise<void> {
  const html = decode(holder);
  const note = holder.querySelector<HTMLElement>('.qfig-ph');
  const say = (text: string) => {
    if (note) note.textContent = text;
  };
  say('Loading the interactive output…');
  const needed = frameScripts(html);
  const replies = await Promise.all(needed.map(script));
  // The row may be gone while the scripts were on their way.
  if (!holder.isConnected) return;
  const failed = replies.findIndex((r) => r.text === undefined);
  if (failed >= 0) {
    say(`Interactive output: couldn’t load ${needed[failed].url} (${replies[failed].error ?? 'no answer'})`);
    return;
  }
  const frame = document.createElement('iframe');
  const id = ++count;
  frame.className = 'qout-iframe';
  frame.title = 'Interactive output';
  // Scripts, and nothing else: not the page's origin, no forms, no popups, no way out of the frame.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.style.height = `${heightHint(html) ?? 150}px`;
  frame.srcdoc = frameDocument(html, texts, document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? '', id);
  byId.set(id, frame);
  holder.replaceChildren(frame);
}

(window as unknown as { mdiffFrames: unknown }).mdiffFrames = { init, place, reply, fromFrame };
