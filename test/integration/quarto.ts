// The experimental Quarto build, tried for real on the report that scripts/integration.mjs makes
// when MDIFF_QUARTO_BUILD=1: a preview build, a two-sided diff build, and a cancel.
import * as assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import type { MdiffApi } from '../../src/extension';
import { waitFor } from './suite';

const BUILD_MS = 240_000;

/** What a build may leave behind: copies of the document, and the scratch and export folders. */
function leftovers(folder: string): string[] {
  const here = readdirSync(`${folder}/report`).filter((n) => n.includes('.mdiff-') || n.endsWith('_ipynb') || n === '.quarto');
  const tmp = readdirSync(tmpdir()).filter((n) => n.startsWith('mdiff-quarto-')).map((n) => `${tmpdir()}/${n}`);
  // The exports of Git versions, in the extension's storage.
  const exports = `${process.env.MDIFF_TEST_STORAGE}/quarto-builds`;
  const built = existsSync(exports) ? readdirSync(exports).map((n) => `${exports}/${n}`) : [];
  return [...here, ...tmp, ...built];
}

/**
 * The processes of a build: those that run in the workspace (Quarto and its kernel run in the
 * report's folder) or in an export of the repository. Linux only, from /proc.
 */
function buildProcesses(root: string): string[] {
  const found: string[] = [];
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (!cwd.startsWith(root) && !cwd.startsWith(`${tmpdir()}/mdiff-quarto-`) && !cwd.startsWith(`${process.env.MDIFF_TEST_STORAGE}`)) continue;
      found.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()} (in ${cwd})`);
    } catch {
      // Gone, or not ours.
    }
  }
  return found;
}

export async function quartoBuildSteps(api: MdiffApi, folder: vscode.Uri): Promise<void> {
  const root = folder.fsPath;
  const file = vscode.Uri.joinPath(folder, 'report', 'report.qmd');
  const gitignore = readFileSync(`${root}/.gitignore`, 'utf8');
  const tmpBefore = new Set(leftovers(root));
  // VS Code's own processes (a language server, git) run in the workspace too.
  const running = () => buildProcesses(root).filter((l) => !l.includes(process.execPath) && !/^\d+ (\S*\/)?git\b/.test(l));
  const clean = () => {
    assert.deepEqual(leftovers(root).filter((x) => !tmpBefore.has(x)), [], 'the build left nothing behind');
    assert.equal(readFileSync(`${root}/report/report.md`, 'utf8'), 'My own report.md\n', 'the report.md next to the document is untouched');
    assert.equal(readFileSync(`${root}/.gitignore`, 'utf8'), gitignore, 'the .gitignore is as it was');
  };

  // 1. The preview shows placeholders and a build bar, then the values of a build of the working tree.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.window.showTextDocument(file);
  await vscode.commands.executeCommand('mdiff.showPreviewToSide');
  const before = await waitFor('the report preview', () => api.preview.lastQuarto?.show && api.preview.pair?.modified.path.endsWith('report.qmd') && api.preview.lastQuarto);
  assert.equal(before.sides[0].status, 'none');
  assert.ok(api.preview.lastMessage!.html.includes('made by this cell when the document is rendered'));
  api.preview.testQuarto('build');
  await waitFor('the preview build to start', () => api.preview.lastQuarto?.building);
  const built = await waitFor('the preview build', () => !api.preview.lastQuarto?.building && api.preview.lastQuarto, BUILD_MS);
  assert.equal(built.sides[0].status, 'built', JSON.stringify(built));
  const html = api.preview.lastMessage!.html;
  assert.match(html, /<span class="qval"[^>]*>E1<\/span> with a log loss of <span class="qval"[^>]*>0\.2650<\/span> on <span class="qval"[^>]*>13,000<\/span>/);
  assert.match(html, /id="tbl-scores"><div class="qout"><div class="qout-md"><table>/);
  assert.match(html, /id="fig-loss"><div class="qout"><img class="qout-img"/);
  assert.match(html, /2 models compared/);
  assert.ok(!html.includes('made by this cell'), 'no placeholder is left');
  // The output that draws itself with a script: in a sandboxed frame, where its script runs and
  // can reach neither the page nor VS Code, and the page takes no message from it.
  assert.match(html, /<div class="qout"><div class="qout-frame" data-frame="/);
  assert.ok(!/<script/.test(html), 'no script of the document is in the page');
  const height = await waitFor('the interactive output to draw itself', () => api.preview.lastFrames.find((h) => h >= 170));
  assert.equal(height, 180, 'its script ran, without reach to the page or acquireVsCodeApi');
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(api.preview.lastRendered!.rows > 3 && !api.preview.lastRendered!.lastRow.includes('Forged'), `the page took no message from the frame: ${JSON.stringify(api.preview.lastRendered)}`);
  clean();
  console.log('MDIFF INTEGRATION: Quarto preview build', JSON.stringify(built.sides), 'frames', JSON.stringify(api.preview.lastFrames));

  // 2. An edit makes the build older than the file; the page says so and keeps the values.
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === file.toString())!;
  await editor.edit((e) => e.insert(new vscode.Position(editor.document.lineCount, 0), '\nAn edit.\n'));
  await waitFor('the preview to say the build is older', () => api.preview.lastQuarto?.sides[0].status === 'stale');
  assert.ok(api.preview.lastMessage!.html.includes('0.2650'));
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await waitFor('the build to match the file again', () => api.preview.lastQuarto?.sides[0].status === 'built');

  // 3. The rendered diff against HEAD: the working tree is built already, HEAD is not.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor('the panels to close', () => !api.panelVisible && api.pair === undefined);
  await vscode.commands.executeCommand('mdiff.compareWithHead', file);
  const one = await waitFor('the report diff', () => api.lastQuarto?.show && api.pair?.modified.path.endsWith('report.qmd') && api.lastQuarto);
  assert.deepEqual(one.sides.map((s) => s.status), ['none', 'built']);
  // With one side built, its values show and nothing is marked for them.
  assert.ok(api.lastMessage!.html.includes('0.2650'));
  assert.ok(!/x-ins"><span class="qval/.test(api.lastMessage!.html), 'no value is marked');
  const changedBefore = api.lastMessage!.changed + api.lastMessage!.added;

  // 4. Cancel a build of both sides: nothing is left running or on disk.
  api.testQuarto('build');
  await waitFor('the export build to start', () => /Building/.test(api.lastQuarto?.building ?? '') && api.lastQuarto, 60_000);
  await new Promise((r) => setTimeout(r, 1500));
  api.testQuarto('cancel');
  await waitFor('the build to stop', () => !api.lastQuarto?.building, 20_000);
  await new Promise((r) => setTimeout(r, 4000));
  assert.deepEqual(running(), [], 'no process of the build is left');
  clean();
  assert.equal(api.lastQuarto!.sides[0].status, 'none', 'a cancelled build changes nothing');
  console.log('MDIFF INTEGRATION: Quarto build cancelled cleanly');

  // 5. Build both sides: the old one in an export of HEAD, with its own environment and data.
  api.testQuarto('build');
  await waitFor('the diff build to start', () => api.lastQuarto?.building);
  const both = await waitFor('the diff build', () => !api.lastQuarto?.building && api.lastQuarto, BUILD_MS);
  assert.deepEqual(both.sides.map((s) => [s.status, s.error]), [['built', undefined], ['built', undefined]], JSON.stringify(both));
  const d = api.lastMessage!;
  // The first paragraph's source is the same, its values are not.
  assert.match(d.html, /<span class="x-del"><span class="qval"[^>]*>0\.2731<\/span><\/span>/);
  assert.match(d.html, /<span class="x-ins"><span class="qval"[^>]*>0\.2650<\/span><\/span>/);
  assert.match(d.html, /<span class="x-ins"><span class="qval"[^>]*>13,000<\/span><\/span>/);
  assert.ok(!/x-ins"><span class="qval"[^>]*>E1</.test(d.html), 'a value that is the same is not marked');
  // The table has its changed numbers marked; the printed line is the same.
  assert.match(d.html, /<div class="qout out-chg"><div class="qout-md"><table>/);
  assert.match(d.html, /<tr class="r-chg"><td[^>]*>E1<\/td><td[^>]*><span class="x-ins">0\.265<\/span><\/td><td[^>]*><span class="x-ins">13000<\/span>/);
  assert.ok(d.changed + d.added > changedBefore, `more blocks are changes (${changedBefore} → ${d.changed + d.added})`);
  // The interactive output is the same in both versions, and drawn in each column.
  await waitFor('the interactive outputs of both columns', () => api.lastFrames.filter((h) => h === 180).length >= 2 || undefined);
  await new Promise((r) => setTimeout(r, 2000));
  assert.deepEqual(running(), [], 'no process of the build is left');
  clean();
  console.log('MDIFF INTEGRATION: Quarto diff build', JSON.stringify({ changed: d.changed, added: d.added, sides: both.sides }));

  // 6. A build that fails leaves the page as it was, and says why.
  const source = readFileSync(file.fsPath, 'utf8');
  writeFileSync(file.fsPath, `${source}\n\`\`\`{python}\nraise ValueError("a failing cell")\n\`\`\`\n`);
  try {
    await waitFor('the page to see the new text', () => api.lastQuarto?.sides[1].status === 'stale');
    api.testQuarto('build');
    await waitFor('the failing build to start', () => api.lastQuarto?.building);
    const failed = await waitFor('the failing build', () => !api.lastQuarto?.building && api.lastQuarto, BUILD_MS);
    assert.equal(failed.sides[1].status, 'stale', 'the earlier build is still shown');
    assert.match(failed.sides[1].error ?? '', /ended with code 1: .*ValueError: a failing cell$/);
    assert.ok(api.lastMessage!.html.includes('0.2650'), 'the values of the earlier build are still shown');
    clean();
    console.log('MDIFF INTEGRATION: failed Quarto build', JSON.stringify(failed.sides[1]));
  } finally {
    writeFileSync(file.fsPath, source);
  }
}
