// Runs inside a VS Code extension host. scripts/screenshots.mjs starts it on a hidden display.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { MdiffApi } from '../../src/extension';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, get: () => T | undefined | false, timeoutMs = 20000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = get();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function shot(name: string): Promise<void> {
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
  const out = join(process.env.MDIFF_SHOTS_DIR!, `${name}.xwd`);
  execFileSync('xwd', ['-root', '-silent', '-out', out]);
  console.log(`MDIFF SHOTS: ${out}`);
}

/** Sets the widths of the two editor groups: the source diff and the rendered diff. */
async function layout(diffShare: number): Promise<void> {
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 0,
    groups: [{ size: diffShare }, { size: 1 - diffShare }],
  });
}

export async function run(): Promise<void> {
  try {
    await steps();
    console.log('MDIFF SHOTS: DONE');
  } catch (error) {
    console.error('MDIFF SHOTS: FAILED', error);
    throw error;
  }
}

async function steps(): Promise<void> {
  // Make the window fill the hidden screen.
  execFileSync('sh', ['-c', 'xdotool search --sync --onlyvisible --class code | xargs -I{} xdotool windowmove {} 0 0 windowsize {} 1600 1000']);
  const api = (await vscode.extensions.getExtension('KonstantinSofeikov.mdiff')!.activate()) as MdiffApi;
  const git = vscode.extensions.getExtension('vscode.git')!;
  await git.activate();
  const gitApi = git.exports.getAPI(1);
  const folder = vscode.workspace.workspaceFolders![0].uri;
  const file = vscode.Uri.joinPath(folder, 'value-estimates.md');
  await waitFor('the git repository', () => gitApi.repositories[0]?.state.workingTreeChanges.length > 0);

  // 1. Overview: the Source Control view, the source diff and the rendered diff.
  await vscode.commands.executeCommand('workbench.view.scm');
  await vscode.commands.executeCommand('git.openChange', file);
  await waitFor('the rendered diff', () => api.lastRendered);
  await layout(0.45);
  await sleep(2500);
  await shot('overview');

  // 2. Close-ups: no side bar, a wider rendered diff.
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await layout(0.3);
  const editor = await waitFor('the modified editor', () =>
    vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === file.toString()),
  );
  editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
  await sleep(1500);
  await shot('paragraphs');
  // A diff editor cannot scroll past its last line, so scroll the rendered diff itself.
  // The demo is short: this shows sections 2 and 3, down to the end.
  api.testScroll('2. Value of a state');
  await sleep(1500);
  await shot('sections');
}
