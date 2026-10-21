// Runs inside a VS Code extension host. scripts/integration.mjs starts it.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { MdiffApi } from '../../src/extension';

async function waitFor<T>(what: string, get: () => T | undefined | false, timeoutMs = 20000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = get();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function tabs() {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ t, g })));
}

export async function run(): Promise<void> {
  try {
    await steps();
    console.log('MDIFF INTEGRATION: PASSED');
  } catch (error) {
    console.error('MDIFF INTEGRATION: FAILED', error);
    throw error;
  }
}

async function steps(): Promise<void> {
  const api = (await vscode.extensions.getExtension('KonstantinSofeikov.mdiff')!.activate()) as MdiffApi;
  const git = vscode.extensions.getExtension('vscode.git')!;
  await git.activate();
  const gitApi = git.exports.getAPI(1);
  const folder = vscode.workspace.workspaceFolders![0].uri;
  const file = vscode.Uri.joinPath(folder, 'doc.md');
  await waitFor('the git repository', () => gitApi.repositories[0]?.state.workingTreeChanges.length > 0);

  // 1. What a click in the Source Control view does: open the change of the file.
  await vscode.commands.executeCommand('git.openChange', file);
  const msg = await waitFor('the rendered diff', () => api.lastMessage);
  assert.equal(msg.error, undefined, msg.error);
  assert.equal(msg.hunks, 7);
  assert.equal(msg.labelB, 'Working tree');
  assert.ok(api.panelVisible, 'the panel is visible');
  const page = await waitFor('the webview to show the diff', () => api.lastRendered);
  assert.ok(page.rows > 10, `the page has rows (${page.rows})`);
  assert.ok(page.grid, 'preview.css is loaded');
  assert.match(page.katexFont, /KaTeX/, 'katex.min.css is loaded');
  console.log('MDIFF INTEGRATION: webview', JSON.stringify(page));

  const diffTab = tabs().find(({ t }) => t.input instanceof vscode.TabInputTextDiff);
  const panelTab = tabs().find(({ t }) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('mdiff.renderedDiff'));
  assert.ok(diffTab, 'the source diff tab is open');
  assert.ok(panelTab, 'the rendered diff tab is open');
  assert.notEqual(diffTab.g.viewColumn, panelTab.g.viewColumn, 'the two tabs are in different groups');
  assert.ok(vscode.window.tabGroups.activeTabGroup === diffTab.g, 'the source diff keeps the focus');

  // 2. Scroll sync. Editor to rendered diff:
  const editor = await waitFor('the modified editor', () =>
    vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === file.toString()),
  );
  editor.revealRange(new vscode.Range(100, 0, 100, 0), vscode.TextEditorRevealType.AtTop);
  const down = await waitFor('the rendered diff to scroll down', () => (api.lastSynced ?? 0) > 300 && api.lastSynced);
  editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
  await waitFor('the rendered diff to scroll up', () => api.lastSynced !== undefined && api.lastSynced < down / 4);
  console.log('MDIFF INTEGRATION: editor line 100 -> webview offset', down);

  // Rendered diff to editor:
  await new Promise((r) => setTimeout(r, 300));
  api.testScroll(down);
  const line = await waitFor('the editor to scroll', () => {
    const top = editor.visibleRanges[0]?.start.line ?? 0;
    return top > 50 && top;
  });
  console.log('MDIFF INTEGRATION: webview offset', down, '-> editor line', line);
  assert.ok(Math.abs(line - 100) <= 6, `the editor shows about line 100 (${line})`);

  // 3. An edit of the working file updates the rendered diff.
  const doc = await vscode.workspace.openTextDocument(file);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(file, new vscode.Position(doc.lineCount, 0), '\nA new closing paragraph.\n');
  await vscode.workspace.applyEdit(edit);
  await waitFor('the live update', () => api.lastMessage?.html.includes('closing'));
  await vscode.commands.executeCommand('workbench.action.files.revert');

  // 4. The command for a file against HEAD.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor('the panel to close', () => !api.panelVisible && api.pair === undefined);
  await vscode.commands.executeCommand('mdiff.compareWithHead', file);
  const head = await waitFor('the HEAD diff', () => api.lastMessage);
  assert.equal(head.labelA, 'HEAD');
  assert.equal(head.hunks, 7);
}
