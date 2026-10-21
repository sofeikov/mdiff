import * as path from 'node:path';
import * as vscode from 'vscode';
import { diffMarkdown } from './core/diff';
import { createMarkdown } from './core/markdown';
import { buildShell, UpdateMessage } from './core/page';

const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd|mkdn)$/i;

interface DiffPair {
  original: vscode.Uri;
  modified: vscode.Uri;
  title: string;
}

/** The API that `activate` returns. The integration tests use it. */
export interface MdiffApi {
  readonly pair: DiffPair | undefined;
  readonly lastMessage: UpdateMessage | undefined;
  readonly panelVisible: boolean;
  /** What the webview reported after it showed the last update. */
  readonly lastRendered: { rows: number; grid: boolean; katexFont: string } | undefined;
  /** The scroll offset of the webview after the last scroll from the editor. */
  readonly lastSynced: number | undefined;
  /** Sends a scroll to the webview as if the reader made it: to an offset, or to the first row with a text. Only for the tests. */
  testScroll(to: number | string): void;
}

export function activate(context: vscode.ExtensionContext): MdiffApi {
  const controller = new RenderedDiffController(context);
  context.subscriptions.push(
    controller,
    vscode.window.tabGroups.onDidChangeTabs((e) => controller.onTabsChanged(e)),
    vscode.workspace.onDidChangeTextDocument((e) => controller.onDocumentChanged(e.document)),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => controller.onEditorScrolled(e.textEditor)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mdiff.formulaDiff')) controller.refresh();
    }),
    vscode.commands.registerCommand('mdiff.showRenderedDiff', (uri?: vscode.Uri) => controller.showForActiveTab(uri)),
    vscode.commands.registerCommand('mdiff.openChange', (...states: unknown[]) => controller.openChange(states)),
    vscode.commands.registerCommand('mdiff.compareWithHead', (uri?: vscode.Uri) => controller.compareWithHead(uri)),
  );
  // A Markdown diff can be open already when VS Code starts.
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab && autoOpen()) controller.onTab(tab);
  return controller;
}

export function deactivate(): void {}

function autoOpen(): boolean {
  return vscode.workspace.getConfiguration('mdiff').get<boolean>('autoOpen', true);
}

function formulaParts(): boolean {
  return vscode.workspace.getConfiguration('mdiff').get<string>('formulaDiff', 'parts') === 'parts';
}

function scrollSync(): boolean {
  return vscode.workspace.getConfiguration('mdiff').get<boolean>('scrollSync', true);
}

/** After a scroll that the extension makes, ignore the scroll events that it causes for this long. */
const ECHO_MS = 200;

function isMarkdownDiff(input: unknown): input is vscode.TabInputTextDiff {
  return input instanceof vscode.TabInputTextDiff && (MARKDOWN_FILE.test(input.modified.path) || MARKDOWN_FILE.test(input.original.path));
}

class RenderedDiffController implements MdiffApi, vscode.Disposable {
  private readonly md = createMarkdown();
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private queued: UpdateMessage | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Until this time, a Markdown diff tab opens the panel even when auto-open is off. */
  private forceUntil = 0;
  pair: DiffPair | undefined;
  lastMessage: UpdateMessage | undefined;
  lastRendered: MdiffApi['lastRendered'];
  lastSynced: number | undefined;
  /** Until this time, editor scroll events come from a reveal by the extension. */
  private ignoreEditorUntil = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get panelVisible(): boolean {
    return !!this.panel?.visible;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.panel?.dispose();
  }

  onTabsChanged(e: vscode.TabChangeEvent): void {
    for (const tab of [...e.opened, ...e.changed]) {
      if (tab.isActive && isMarkdownDiff(tab.input)) {
        this.onTab(tab);
        return;
      }
    }
  }

  onTab(tab: vscode.Tab): void {
    if (!isMarkdownDiff(tab.input)) return;
    // With auto-open off, the panel still follows the active diff after the reader opened it once.
    if (!autoOpen() && !this.panel && Date.now() > this.forceUntil) return;
    this.show({ original: tab.input.original, modified: tab.input.modified, title: tab.label }, tab.group);
  }

  onDocumentChanged(doc: vscode.TextDocument): void {
    const pair = this.pair;
    if (!pair || !this.panel) return;
    const uri = doc.uri.toString();
    if (uri !== pair.original.toString() && uri !== pair.modified.toString()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.render(false), 300);
  }

  /** Editor to webview: show the top line of the editor at the top of the rendered diff. */
  onEditorScrolled(editor: vscode.TextEditor): void {
    if (!scrollSync() || !this.panel || !this.ready || !this.pair || Date.now() < this.ignoreEditorUntil) return;
    if (editor.document.uri.toString() !== this.pair.modified.toString()) return;
    const top = editor.visibleRanges[0]?.start.line ?? 0;
    void this.panel.webview.postMessage({ type: 'scroll', line: top });
  }

  /** Webview to editor: show the line at the top of the rendered diff at the top of the editor. */
  private revealInEditor(line: number): void {
    if (!scrollSync() || !this.pair) return;
    const uri = this.pair.modified.toString();
    const target = Math.max(0, Math.floor(line));
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== uri) continue;
      this.ignoreEditorUntil = Date.now() + ECHO_MS;
      editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.AtTop);
    }
  }

  testScroll(to: number | string): void {
    void this.panel?.webview.postMessage(typeof to === 'number' ? { type: 'testScroll', y: to } : { type: 'testScroll', text: to });
  }

  /** Renders the current diff again, for example after a settings change. */
  refresh(): void {
    if (this.pair && this.panel) void this.render(false);
  }

  /** Command: show the rendered diff for the active diff tab, or for a Markdown file against HEAD. */
  async showForActiveTab(uri?: vscode.Uri): Promise<void> {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab && isMarkdownDiff(tab.input)) {
      this.show({ original: tab.input.original, modified: tab.input.modified, title: tab.label }, tab.group);
      return;
    }
    await this.compareWithHead(uri);
  }

  /** Command from the Source Control view: open the source diff and the rendered diff. */
  async openChange(states: unknown[]): Promise<void> {
    this.forceUntil = Date.now() + 3000;
    await vscode.commands.executeCommand('git.openChange', ...states);
    // If the diff tab was already active, no tab event comes.
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab) this.onTab(tab);
  }

  /** Command: diff a Markdown file in the working tree against HEAD. */
  async compareWithHead(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file' || !MARKDOWN_FILE.test(target.path)) {
      void vscode.window.showInformationMessage('Open a Markdown file from the workspace first.');
      return;
    }
    // The same URI form that the built-in Git extension uses for a file at a ref.
    const head = target.with({ scheme: 'git', query: JSON.stringify({ path: target.fsPath, ref: 'HEAD' }) });
    this.forceUntil = Date.now() + 3000;
    const title = `${path.basename(target.fsPath)} (HEAD ↔ Working Tree)`;
    await vscode.commands.executeCommand('vscode.diff', head, target, title);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab) this.onTab(tab);
  }

  private show(pair: DiffPair, group: vscode.TabGroup | undefined): void {
    const same = !!this.pair && this.pair.original.toString() === pair.original.toString() && this.pair.modified.toString() === pair.modified.toString();
    // Keep the same object for the same files: a render in progress checks it before it posts.
    if (same) this.pair!.title = pair.title;
    else this.pair = pair;
    if (!this.panel) {
      this.panel = this.createPanel();
    } else if (group && this.panel.viewColumn === group.viewColumn) {
      // Do not cover the source diff: move the panel next to it.
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    } else if (!this.panel.visible) {
      this.panel.reveal(this.panel.viewColumn, true);
    }
    this.panel.title = `Rendered: ${path.basename(pair.modified.path)}`;
    if (!same || !this.lastMessage) void this.render(true);
  }

  private createPanel(): vscode.WebviewPanel {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'mdiff.renderedDiff',
      'Rendered diff',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    const asset = (...p: string[]) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    this.ready = false;
    panel.webview.html = buildShell({
      cspSource: panel.webview.cspSource,
      nonce: nonce(),
      katexCss: asset('katex', 'katex.min.css'),
      previewCss: asset('preview.css'),
      previewJs: asset('preview.js'),
    });
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.pair = undefined;
      this.lastMessage = undefined;
      this.lastRendered = undefined;
      this.ready = false;
    });
    return panel;
  }

  /** Scrolls the rendered diff to the current position of the editor, after a new file is shown. */
  private syncFromEditor(): void {
    const uri = this.pair?.modified.toString();
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
    if (editor) this.onEditorScrolled(editor);
  }

  private onMessage(msg: { type: string; href?: string; rows?: number; grid?: boolean; katexFont?: string; line?: number; top?: number }): void {
    if (msg.type === 'ready') {
      this.ready = true;
      if (this.queued) {
        void this.panel?.webview.postMessage(this.queued);
        this.queued = undefined;
        this.syncFromEditor();
      }
    } else if (msg.type === 'reveal' && typeof msg.line === 'number') {
      this.revealInEditor(msg.line);
    } else if (msg.type === 'synced') {
      this.lastSynced = msg.top;
    } else if (msg.type === 'rendered') {
      this.lastRendered = { rows: msg.rows ?? 0, grid: !!msg.grid, katexFont: msg.katexFont ?? '' };
    } else if (msg.type === 'open' && msg.href) {
      void this.openLink(msg.href);
    }
  }

  private async openLink(href: string): Promise<void> {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (!this.pair) return;
    const rel = decodeURIComponent(href.split('#')[0]);
    if (!rel) return;
    const target = vscode.Uri.file(path.resolve(path.dirname(this.pair.modified.fsPath), rel));
    await vscode.commands.executeCommand('vscode.open', target);
  }

  private async render(reset: boolean): Promise<void> {
    const pair = this.pair;
    if (!pair) return;
    let message: UpdateMessage;
    const base = { type: 'update' as const, title: pair.title, labelA: describe(pair.original), labelB: describe(pair.modified), reset };
    try {
      const [a, b] = await Promise.all([readText(pair.original), readText(pair.modified)]);
      message = { ...base, ...diffMarkdown(this.md, a, b, { formulaParts: formulaParts() }) };
    } catch (error) {
      message = { ...base, html: '', hunks: 0, added: 0, removed: 0, changed: 0, error: `Cannot render the diff: ${String(error)}` };
    }
    // A newer request replaced this one while the files were read.
    if (pair !== this.pair || !this.panel) return;
    this.lastMessage = message;
    if (this.ready) void this.panel.webview.postMessage(message);
    else this.queued = message;
    if (reset) this.syncFromEditor();
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(uri);
  return doc.getText();
}

/** A short label for one side of the diff, for example `HEAD`, `Index` or `Working tree`. */
function describe(uri: vscode.Uri): string {
  if (uri.scheme === 'file') return 'Working tree';
  if (uri.scheme === 'git') {
    try {
      const { ref } = JSON.parse(uri.query) as { ref?: string };
      if (ref === undefined) return 'Git';
      if (ref === '' || ref === '~') return 'Index';
      return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 8) : ref;
    } catch {
      return 'Git';
    }
  }
  return uri.scheme;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
