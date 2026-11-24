import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadQuarto } from './project';
import { diffMarkdown, previewMarkdown } from './core/diff';
import { createMarkdown, isQuartoPath } from './core/markdown';
import { buildShell, QuartoStatus, toRowsMessage, UpdateMessage } from './core/page';
import { canBuild, QuartoBuilds, type BuildSide, type BuildState } from './quartoBuild';

const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd|mkdn|qmd)$/i;
/** The files that get a preview. VS Code previews Markdown itself. */
const PREVIEW_FILE = /\.qmd$/i;

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
  readonly lastRendered: { rows: number; parsed: number; lastRow: string; grid: boolean; katexFont: string; fonts: string[] } | undefined;
  /** The scroll offset of the webview after the last scroll from the editor. */
  readonly lastSynced: number | undefined;
  /** Sends a scroll to the webview as if the reader made it: to an offset, or to the first row with a text. Only for the tests. */
  testScroll(to: number | string): void;
  /** The state of the Quarto build that the page shows, as last posted. */
  readonly lastQuarto: QuartoStatus | undefined;
  /** Does what the page's buttons of the Quarto build do. Only for the tests. */
  testQuarto(action: 'build' | 'cancel'): void;
  /** The same state for the preview panel of a Quarto file. */
  readonly preview: Omit<MdiffApi, 'preview'>;
}

export function activate(context: vscode.ExtensionContext): MdiffApi {
  const builds = new QuartoBuilds(context.globalStorageUri.fsPath);
  const preview = new RenderedDiffController(context, 'preview', builds);
  const controller = new RenderedDiffController(context, 'diff', builds, preview);
  context.subscriptions.push(
    controller,
    preview,
    builds,
    builds.onDidChange(() => {
      controller.refresh();
      preview.refresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      controller.refresh();
      preview.refresh();
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => preview.onActiveEditor(e)),
    vscode.window.tabGroups.onDidChangeTabs((e) => controller.onTabsChanged(e)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      controller.onDocumentChanged(e.document);
      preview.onDocumentChanged(e.document);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      controller.onEditorScrolled(e.textEditor);
      preview.onEditorScrolled(e.textEditor);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('mdiff.formulaDiff')) return;
      controller.refresh();
      preview.refresh();
    }),
    vscode.commands.registerCommand('mdiff.showPreviewToSide', (uri?: vscode.Uri) => preview.showPreview(uri)),
    vscode.commands.registerCommand('mdiff.showRenderedDiff', (uri?: vscode.Uri) => controller.showForActiveTab(uri)),
    vscode.commands.registerCommand('mdiff.openChange', (...states: unknown[]) => controller.openChange(states)),
    vscode.commands.registerCommand('mdiff.compareWithHead', (uri?: vscode.Uri) => controller.compareWithHead(uri)),
    vscode.commands.registerCommand('mdiff.buildWithQuarto', () => {
      const target = [preview, controller].find((c) => c.panelActive) ?? [preview, controller].find((c) => c.panelVisible && c.isQuarto);
      if (target?.isQuarto) void target.buildQuarto();
      else void vscode.window.showInformationMessage('Open the Quarto preview or the rendered diff of a Quarto file first.');
    }),
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

/** The text editor of a file, not one side of a diff editor. */
function isPlainEditor(editor: vscode.TextEditor): boolean {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return !(tab?.input instanceof vscode.TabInputTextDiff) && editor === vscode.window.activeTextEditor;
}

/**
 * One rendered panel. In `diff` mode it shows the side-by-side diff of a diff tab. In
 * `preview` mode it shows one Quarto file, in one column, and follows the active Quarto editor.
 */
class RenderedDiffController implements MdiffApi, vscode.Disposable {
  private readonly md = createMarkdown();
  private readonly qmd = createMarkdown({ quarto: true });
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
  /** The rows that the webview shows, as last posted, and their number. */
  private shownRows: { seq: number; rows: string[] } | undefined;
  private seq = 0;
  lastQuarto: QuartoStatus | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly mode: 'diff' | 'preview',
    private readonly builds: QuartoBuilds,
    /** The preview controller, which the API exposes for the tests. */
    private readonly previewController?: RenderedDiffController,
  ) {}

  get panelActive(): boolean {
    return !!this.panel?.active;
  }

  /** True when the panel shows a Quarto file. */
  get isQuarto(): boolean {
    return !!this.pair && (isQuartoPath(this.pair.original.path) || isQuartoPath(this.pair.modified.path));
  }

  /** The versions that the page shows, to build: the new one first, which is read most. */
  private buildSides(): BuildSide[] {
    const pair = this.pair;
    if (!pair) return [];
    if (this.mode === 'preview') return [{ uri: pair.modified, label: path.basename(pair.modified.fsPath) }];
    const sides = [
      { uri: pair.modified, label: `the new version (${describe(pair.modified)})` },
      { uri: pair.original, label: `the old version (${describe(pair.original)})` },
    ];
    return sides.filter((s, i) => i === 0 || s.uri.toString() !== sides[0].uri.toString());
  }

  /** Builds the versions that the page shows with Quarto. Only from a click (or the command). */
  async buildQuarto(): Promise<void> {
    const sides = this.buildSides();
    // The working-tree file is built as it is saved.
    const dirty = sides.some((s) => s.uri.scheme === 'file' && vscode.workspace.textDocuments.some((d) => d.uri.toString() === s.uri.toString() && d.isDirty));
    if (dirty) void vscode.window.showInformationMessage('The file has unsaved changes: the Quarto build uses the saved file.');
    await this.builds.build(sides);
  }

  testQuarto(action: 'build' | 'cancel'): void {
    this.onMessage({ type: action === 'build' ? 'quartoBuild' : 'quartoCancel' });
  }

  get preview(): Omit<MdiffApi, 'preview'> {
    return this.previewController ?? this;
  }

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
    if (this.mode !== 'diff' || !isMarkdownDiff(tab.input)) return;
    // With auto-open off, the panel still follows the active diff after the reader opened it once.
    if (!autoOpen() && !this.panel && Date.now() > this.forceUntil) return;
    this.show({ original: tab.input.original, modified: tab.input.modified, title: tab.label }, tab.group);
  }

  /** Preview: an open preview follows the active Quarto editor, as the built-in Markdown preview does. */
  onActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (this.mode !== 'preview' || !this.panel || !editor || !isPlainEditor(editor)) return;
    const uri = editor.document.uri;
    if (!PREVIEW_FILE.test(uri.path) || uri.toString() === this.pair?.modified.toString()) return;
    this.show({ original: uri, modified: uri, title: path.basename(uri.path) }, undefined, false);
  }

  /** Command: show the preview of a Quarto file next to its editor. */
  async showPreview(uri?: vscode.Uri): Promise<void> {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target || !PREVIEW_FILE.test(target.path)) {
      void vscode.window.showInformationMessage('Open a Quarto (.qmd) file first.');
      return;
    }
    const group = vscode.window.tabGroups.activeTabGroup;
    this.show({ original: target, modified: target, title: path.basename(target.path) }, group);
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
      void vscode.window.showInformationMessage('Open a Markdown or Quarto file from the workspace first.');
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

  /** Shows a pair in the panel. Without `reveal`, a hidden panel stays hidden and only updates. */
  private show(pair: DiffPair, group: vscode.TabGroup | undefined, reveal = true): void {
    const same = !!this.pair && this.pair.original.toString() === pair.original.toString() && this.pair.modified.toString() === pair.modified.toString();
    // Keep the same object for the same files: a render in progress checks it before it posts.
    if (same) this.pair!.title = pair.title;
    else this.pair = pair;
    if (!this.panel) {
      this.panel = this.createPanel(pair.modified);
    } else if (!reveal) {
      // Leave the panel where it is.
    } else if (group && this.panel.viewColumn === group.viewColumn) {
      // Do not cover the source diff: move the panel next to it.
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    } else if (!this.panel.visible) {
      this.panel.reveal(this.panel.viewColumn, true);
    }
    this.panel.title = `${this.mode === 'preview' ? 'Preview' : 'Rendered'}: ${path.basename(pair.modified.path)}`;
    if (!same || !this.lastMessage) void this.render(true);
  }

  private createPanel(doc: vscode.Uri): vscode.WebviewPanel {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    // The images of the document: the workspace folders, and the folder of the first document.
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
    const roots = [media, ...folders, vscode.Uri.file(path.dirname(doc.fsPath))];
    const panel = vscode.window.createWebviewPanel(
      this.mode === 'preview' ? 'mdiff.preview' : 'mdiff.renderedDiff',
      this.mode === 'preview' ? 'Preview' : 'Rendered diff',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots },
    );
    const asset = (...p: string[]) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    this.ready = false;
    panel.webview.html = buildShell({
      cspSource: panel.webview.cspSource,
      nonce: nonce(),
      katexCss: asset('katex', 'katex.min.css'),
      previewCss: asset('preview.css'),
      previewJs: asset('preview.js'),
      diagramsJs: asset('mermaid', 'diagrams.js'),
      mermaidJs: asset('mermaid', 'mermaid.js'),
    });
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.shownRows = undefined;
      this.pair = undefined;
      this.lastMessage = undefined;
      this.lastRendered = undefined;
      this.lastQuarto = undefined;
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

  private onMessage(msg: { type: string; href?: string; rows?: number; parsed?: number; lastRow?: string; grid?: boolean; katexFont?: string; fonts?: string[]; line?: number; top?: number }): void {
    if (msg.type === 'ready') {
      this.ready = true;
      this.shownRows = undefined;
      if (this.queued) {
        this.post(this.queued);
        this.queued = undefined;
        this.syncFromEditor();
      }
    } else if (msg.type === 'resync') {
      // The webview does not have the rows that the last patch referred to: send all rows.
      this.shownRows = undefined;
      if (this.lastMessage) this.post(this.lastMessage);
    } else if (msg.type === 'reveal' && typeof msg.line === 'number') {
      this.revealInEditor(msg.line);
    } else if (msg.type === 'synced') {
      this.lastSynced = msg.top;
    } else if (msg.type === 'rendered') {
      this.lastRendered = { rows: msg.rows ?? 0, parsed: msg.parsed ?? 0, lastRow: msg.lastRow ?? '', grid: !!msg.grid, katexFont: msg.katexFont ?? '', fonts: msg.fonts ?? [] };
    } else if (msg.type === 'open' && msg.href) {
      void this.openLink(msg.href);
    } else if (msg.type === 'quartoBuild') {
      void this.buildQuarto();
    } else if (msg.type === 'quartoCancel') {
      this.builds.cancel();
    } else if (msg.type === 'quartoLog') {
      this.builds.showLog();
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

  private post(message: UpdateMessage): void {
    if (!this.panel) return;
    const wire = toRowsMessage(message, this.shownRows, ++this.seq);
    this.shownRows = message.error ? undefined : { seq: wire.seq, rows: message.rows ?? [] };
    void this.panel.webview.postMessage(wire);
    if (this.lastQuarto) void this.panel.webview.postMessage(this.lastQuarto);
  }

  /** What the page says of the Quarto build of its versions. */
  private quartoStatus(sides: { uri: vscode.Uri; label: string; state: BuildState }[]): QuartoStatus {
    const mine = sides.some((s) => this.builds.isBuilding(s.uri));
    return {
      type: 'quarto',
      show: true,
      trusted: vscode.workspace.isTrusted,
      building: mine ? this.builds.building : undefined,
      busy: !mine && !!this.builds.building,
      sides: sides.map((s) => ({ label: s.label, status: s.state.status, builtAt: s.state.builtAt, error: s.state.error })),
    };
  }

  private async render(reset: boolean): Promise<void> {
    const pair = this.pair;
    if (!pair) return;
    let message: UpdateMessage;
    const preview = this.mode === 'preview';
    // Relative images resolve against the folder of the file. A Git URI has the path of the file in the working tree.
    const folder = this.panel?.webview.asWebviewUri(vscode.Uri.file(path.dirname(pair.modified.fsPath))).toString();
    const base = {
      type: 'update' as const,
      title: pair.title,
      labelA: describe(pair.original),
      labelB: describe(pair.modified),
      reset,
      preview,
      baseUrl: folder && `${folder.replace(/\/$/, '')}/`,
    };
    let quartoStatus: QuartoStatus | undefined;
    try {
      const quarto = isQuartoPath(pair.original.path) || isQuartoPath(pair.modified.path);
      const md = quarto ? this.qmd : this.md;
      // What a Quarto build of each version computed, when one was made (experimental).
      const state = async (uri: vscode.Uri, text: string): Promise<BuildState> => (quarto && canBuild(uri) ? this.builds.state(uri, text) : { status: 'unsupported' });
      if (preview) {
        const b = await readText(pair.modified);
        const q = quarto ? loadQuarto(pair.modified.fsPath, b) : undefined;
        const sb = await state(pair.modified, b);
        if (quarto) quartoStatus = this.quartoStatus([{ uri: pair.modified, label: 'Document', state: sb }]);
        message = { ...base, hunks: 0, added: 0, removed: 0, changed: 0, ...previewMarkdown(md, b, { formulaParts: formulaParts(), ...q, runs: { b: sb.run } }) };
      } else {
        const [a, b] = await Promise.all([readText(pair.original), readText(pair.modified)]);
        // The bibliography and project next to the working-tree file are found also for a Git URI.
        const q = quarto ? loadQuarto(pair.modified.fsPath, b) : undefined;
        const [sa, sb] = await Promise.all([state(pair.original, a), state(pair.modified, b)]);
        if (quarto) {
          quartoStatus = this.quartoStatus([
            { uri: pair.original, label: base.labelA, state: sa },
            { uri: pair.modified, label: base.labelB, state: sb },
          ]);
        }
        message = { ...base, ...diffMarkdown(md, a, b, { formulaParts: formulaParts(), ...q, runs: { a: sa.run, b: sb.run } }) };
      }
    } catch (error) {
      message = { ...base, html: '', hunks: 0, added: 0, removed: 0, changed: 0, error: `Cannot render the ${preview ? 'preview' : 'diff'}: ${String(error)}` };
    }
    // A newer request replaced this one while the files were read.
    if (pair !== this.pair || !this.panel) return;
    this.lastQuarto = quartoStatus ?? { type: 'quarto', show: false, trusted: true, sides: [] };
    this.lastMessage = message;
    if (this.ready) this.post(message);
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
