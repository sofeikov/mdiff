// Experimental: builds a Quarto document with Quarto itself, so the preview and the rendered diff
// can show what it computes (see core/quartoRun.ts). Nothing else in the extension runs code, so a
// build starts only from an explicit click, and never in an untrusted workspace.
//
// A build needs the document's folder, for its data and its imports.
// - The working-tree file is built where it is. Quarto writes its output next to the file it
//   renders before it moves it to `--output-dir`, so a build of `report.qmd` would take away a
//   `report.md` or `report_files/` of the user's. So the saved text is copied to a file of its own
//   in the same folder, `report.mdiff-1a2b3c4d.qmd`, and that one is rendered. The copy, the
//   notebook Quarto keeps of it, a `.quarto` folder that Quarto made and its change to
//   `.gitignore` are removed when the build ends; Quarto's output goes to a scratch folder outside
//   the repository.
// - A `git:` version is built in a temporary export of the repository at that commit (or of the
//   index), with its own environment (`uv run`, when the project has a `uv.lock`), so the old side
//   doesn't import the new code. The export is in the extension's storage, on disk: the system's
//   temporary folder can be in memory (tmpfs), where uv can't hard-link and copies the whole
//   environment. The export is deleted when its build ends: with the environment in it, it can
//   take gigabytes.
// - Quarto leaves a file out of its project when any folder of its absolute path starts with a
//   dot (as the extension's storage, `~/.config/...`, does on Linux), and then refuses
//   `--output-dir`. In such a folder, Quarto gets the file through a link to the repository made
//   in the system's temporary folder (`aliasOf`).
//
// What a build gave is kept by version: the text of the file, or the commit of a `git:` one.
// When the file changes after the build, the page still shows the build and says it is older.
import * as vscode from 'vscode';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extrasConflict, failureLine, hiddenPath, keptNotebook, parseQuartoRun, quartoCommand, readQuartoRun, type QuartoRun } from './core/quartoRun';

/** A build that takes longer than this is stopped. */
export const TIME_LIMIT_MINUTES = 30;
/** Results are deleted this long after their build. */
const KEEP_DAYS = 30;
/**
 * In the environment of every process of a build, with an id of its own: the kernel that Quarto
 * starts is in a session of its own, and outlives a signal to the build's process group, so it is
 * found by this.
 */
const MARK = 'MDIFF_BUILD_MARK';

/** What the page knows of one version's build. */
export interface BuildState {
  /** `stale`: the file changed since the build, whose run is still shown. */
  status: 'none' | 'built' | 'stale' | 'unsupported';
  run?: QuartoRun;
  builtAt?: number;
  /** Why the last build of this version failed, when it did. */
  error?: string;
}

/** One version to build: a file of the working tree or a `git:` version. */
export interface BuildSide {
  uri: vscode.Uri;
  label: string;
}

interface Record {
  version: string;
  builtAt: number;
  run: QuartoRun;
}

/** What a build changes in the user's folders, to undo when it ends, even after a crash. */
interface Cleanup {
  /** Files and folders to delete. */
  remove: string[];
  /** Links to remove, each alone in a folder of its own, which is removed too: never followed. */
  links?: string[];
  /** `.gitignore` files to restore: their text before the build, or null when there was none. */
  restore: { file: string; text: string | null }[];
}

class Cancelled extends Error {}

/** True for a version that can be built. */
export function canBuild(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || (uri.scheme === 'git' && !!gitQuery(uri));
}

function gitQuery(uri: vscode.Uri): { path: string; ref: string } | undefined {
  try {
    const q = JSON.parse(uri.query) as { path?: unknown; ref?: unknown };
    return typeof q.path === 'string' && typeof q.ref === 'string' ? { path: q.path, ref: q.ref } : undefined;
  } catch {
    return undefined;
  }
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class QuartoBuilds implements vscode.Disposable {
  private readonly records = new Map<string, Promise<Record | undefined>>();
  private readonly errors = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when a build starts, moves on or ends. */
  readonly onDidChange = this.changed.event;
  private log: vscode.OutputChannel | undefined;
  /** The build that is running: the version it is building now, and what it is doing. */
  private current: { id: string; note: string; cancel: vscode.CancellationTokenSource } | undefined;
  /** The commands that are running: their process (group) ids, and the mark in their environment. */
  private readonly running = new Map<number, string>();
  /** What the build that is running changed, to undo. */
  private readonly cleanups = new Set<Cleanup>();
  private pruned = false;
  /** Commits by repository and ref, for a few seconds: a render asks for them on every edit. */
  private readonly commits = new Map<string, { at: number; commit: Promise<string> }>();

  /** `root` is the extension's storage folder. */
  constructor(private readonly root: string) {
    // A window that closed during a build couldn't finish its cleanup.
    for (const c of this.readPending()) undo(c);
    this.writePending();
  }

  dispose(): void {
    // A build must not outlive the window that started it.
    this.current?.cancel.cancel();
    for (const [pid, mark] of this.running) killAll(pid, mark, 'SIGKILL');
    for (const c of this.cleanups) undo(c);
    this.cleanups.clear();
    this.writePending();
    this.changed.dispose();
    this.log?.dispose();
  }

  /** What is being built, for the page to show; undefined when nothing is. */
  get building(): string | undefined {
    return this.current?.note;
  }

  /** True while this version is being built. */
  isBuilding(uri: vscode.Uri): boolean {
    return this.current?.id === idOf(uri);
  }

  /** What the page shows of one version, whose text is `text`. */
  async state(uri: vscode.Uri, text: string): Promise<BuildState> {
    if (!canBuild(uri)) return { status: 'unsupported' };
    const id = idOf(uri);
    const error = this.errors.get(id);
    const rec = await this.record(id);
    if (!rec) return { status: 'none', ...(error ? { error } : {}) };
    const version = await this.version(uri, text).catch(() => '');
    return { status: rec.version === version ? 'built' : 'stale', run: rec.run, builtAt: rec.builtAt, ...(error ? { error } : {}) };
  }

  showLog(): void {
    this.channel().show(true);
  }

  /** Adds a line to the output channel of the builds. */
  note(line: string): void {
    this.say(line);
  }

  cancel(): void {
    this.current?.cancel.cancel();
  }

  /**
   * Builds the versions one after the other, with a notification that can cancel. Resolves when
   * all are done; a version that fails is reported, and the others still build.
   */
  async build(sides: BuildSide[]): Promise<void> {
    if (this.current) {
      void vscode.window.showInformationMessage('A Quarto build is already running. Wait for it, or cancel it.');
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('A Quarto build runs the code of the document, so it is off in an untrusted workspace.');
      return;
    }
    const todo = sides.filter((s) => canBuild(s.uri));
    if (!todo.length) return;
    const setting = vscode.workspace.getConfiguration('mdiff').get<string>('quarto.command', '').trim();
    const cancel = new vscode.CancellationTokenSource();
    this.current = { id: idOf(todo[0].uri), note: 'Starting…', cancel };
    this.changed.fire();
    const failures: string[] = [];
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Quarto build (experimental)', cancellable: true }, async (progress, token) => {
        const sub = token.onCancellationRequested(() => cancel.cancel());
        try {
          if (!this.pruned) {
            this.pruned = true;
            await this.prune().catch(() => undefined);
          }
          for (const side of todo) {
            this.current!.id = idOf(side.uri);
            const say = (what: string) => {
              this.current!.note = `${what} ${side.label}…`;
              progress.report({ message: this.current!.note });
              this.changed.fire();
            };
            const id = idOf(side.uri);
            try {
              const rec = await this.buildOne(side, setting, say, cancel.token);
              this.records.set(id, Promise.resolve(rec));
              this.errors.delete(id);
              await fs.mkdir(path.dirname(this.file(id)), { recursive: true });
              await fs.writeFile(this.file(id), JSON.stringify(rec));
            } catch (e) {
              if (e instanceof Cancelled) {
                this.say('Cancelled.');
                return;
              }
              this.say(`Failed: ${message(e)}`);
              this.errors.set(id, message(e));
              failures.push(`${side.label}: ${message(e)}`);
            }
            this.changed.fire();
          }
        } finally {
          sub.dispose();
        }
      });
    } finally {
      cancel.dispose();
      this.current = undefined;
      this.changed.fire();
    }
    if (failures.length) {
      const pick = await vscode.window.showWarningMessage(`The Quarto build failed. ${failures.join('; ')}`, 'Show Log');
      if (pick) this.showLog();
    }
  }

  private channel(): vscode.OutputChannel {
    this.log ??= vscode.window.createOutputChannel('Markdown Rendered Diff: Quarto');
    return this.log;
  }

  private say(line: string): void {
    this.channel().appendLine(line);
  }

  private file(id: string): string {
    return path.join(this.root, 'quarto-runs', `${sha(id).slice(0, 32)}.json`);
  }

  private record(id: string): Promise<Record | undefined> {
    let rec = this.records.get(id);
    if (!rec) {
      rec = fs.readFile(this.file(id), 'utf8').then(
        (text) => {
          try {
            const r = JSON.parse(text) as Record;
            const run = parseQuartoRun(JSON.stringify(r.run));
            return run && typeof r.version === 'string' ? { ...r, run } : undefined;
          } catch {
            return undefined;
          }
        },
        () => undefined,
      );
      this.records.set(id, rec);
    }
    return rec;
  }

  /**
   * The version of a text: the text for a file (without a byte order mark, which VS Code drops),
   * and the commit for a `git:` version at a commit, which fixes the text and the data.
   */
  private async version(uri: vscode.Uri, text: string): Promise<string> {
    const plain = text.replace(/^\uFEFF/, '');
    if (uri.scheme === 'file') return sha(plain);
    const q = gitQuery(uri)!;
    if (q.ref === '' || q.ref === '~') return `index:${sha(plain)}`;
    const key = `${q.path}\u0000${q.ref}`;
    let hit = this.commits.get(key);
    if (!hit || Date.now() - hit.at > 5000) {
      hit = { at: Date.now(), commit: gitOut(['rev-parse', '--verify', `${q.ref}^{commit}`], path.dirname(q.path)) };
      this.commits.set(key, hit);
    }
    return `commit:${await hit.commit}`;
  }

  private async buildOne(side: BuildSide, setting: string, say: (what: string) => void, token: vscode.CancellationToken): Promise<Record> {
    const started = Date.now();
    this.say(`\n=== ${side.label}: ${side.uri.scheme === 'file' ? side.uri.fsPath : side.uri.toString()} (${new Date().toLocaleString()}) ===`);
    const deadline = started + TIME_LIMIT_MINUTES * 60_000;
    const { text, run } = side.uri.scheme === 'file' ? await this.buildInPlace(side.uri.fsPath, setting, say, token, deadline) : await this.buildExport(side.uri, setting, say, token, deadline);
    const version = await this.version(side.uri, text);
    this.say(`Done in ${Math.round((Date.now() - started) / 1000)} s: ${run.exprs.length} inline values, ${run.cells.length} cells.`);
    return { version, builtAt: Date.now(), run };
  }

  /** Builds the saved working-tree file in its folder, from a copy of its own (see the top of this file). */
  private async buildInPlace(file: string, setting: string, say: (what: string) => void, token: vscode.CancellationToken, deadline: number): Promise<{ text: string; run: QuartoRun }> {
    const text = await fs.readFile(file, 'utf8');
    const folder = path.dirname(file);
    const top = (await gitOut(['rev-parse', '--show-toplevel'], folder).catch(() => undefined)) ?? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ?? folder;
    const stem = `${path.basename(file).replace(/\.[^.]+$/, '')}.mdiff-${randomBytes(4).toString('hex')}`;
    const copy = path.join(folder, `${stem}.qmd`);
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mdiff-quarto-out-'));
    // Quarto may add `/.quarto/` to the `.gitignore` and make `.quarto` in the folder and in the project's.
    const project = await findAbove(folder, top, '_quarto.yml');
    const dirs = [...new Set([folder, ...(project ? [path.dirname(project)] : [])])];
    const cleanup: Cleanup = { remove: [copy, out], restore: [] };
    for (const dir of dirs) {
      cleanup.restore.push({ file: path.join(dir, '.gitignore'), text: await fs.readFile(path.join(dir, '.gitignore'), 'utf8').catch(() => null) });
      if (!(await exists(path.join(dir, '.quarto')))) cleanup.remove.push(path.join(dir, '.quarto'));
    }
    if (project) cleanup.remove.push(path.join(path.dirname(project), '_freeze', path.relative(path.dirname(project), folder), stem));
    this.begin(cleanup);
    try {
      const before = new Set(await fs.readdir(folder));
      // A notebook Quarto keeps, and a folder of figures, are named after the copy.
      cleanup.remove.push(path.join(folder, `${stem}.quarto_ipynb`), path.join(folder, `${stem}.ipynb`), path.join(folder, `${stem}_files`));
      await fs.writeFile(copy, text, { flag: 'wx' });
      this.writePending();
      const uv = !!(await findAbove(folder, top, 'uv.lock'));
      const alias = hiddenPath(folder) ? await this.alias(top, cleanup) : undefined;
      say('Building');
      const arg = alias ? path.join(alias, path.relative(top, copy)) : path.basename(copy);
      const run = await this.render(setting, arg, uv, out, folder, process.env, token, deadline, before);
      return { text, run };
    } finally {
      await this.end(cleanup);
    }
  }

  /** Builds a `git:` version in a temporary export of the repository at its commit, or of the index. */
  private async buildExport(uri: vscode.Uri, setting: string, say: (what: string) => void, token: vscode.CancellationToken, deadline: number): Promise<{ text: string; run: QuartoRun }> {
    const q = gitQuery(uri)!;
    const repo = await gitOut(['rev-parse', '--show-toplevel'], path.dirname(q.path));
    const rel = path.relative(repo, q.path);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('the file is not in its repository');
    const builds = path.join(this.root, 'quarto-builds');
    await fs.mkdir(builds, { recursive: true });
    const work = await fs.mkdtemp(path.join(builds, 'export-'));
    const cleanup: Cleanup = { remove: [work], restore: [] };
    this.begin(cleanup);
    try {
      const src = path.join(work, path.basename(repo).replace(/^\.+/, '') || 'repo');
      await fs.mkdir(src);
      say('Exporting');
      if (q.ref === '' || q.ref === '~') {
        await this.exec(['git', 'checkout-index', '-a', `--prefix=${src}${path.sep}`], repo, process.env, token, deadline);
      } else {
        const commit = await gitOut(['rev-parse', '--verify', `${q.ref}^{commit}`], repo);
        const tar = path.join(work, 'src.tar');
        await this.exec(['git', 'archive', '--format=tar', '-o', tar, commit], repo, process.env, token, deadline);
        await this.exec(['tar', '-xf', tar, '-C', src], work, process.env, token, deadline);
        await fs.rm(tar, { force: true });
      }
      const file = path.join(src, rel);
      const text = await fs.readFile(file, 'utf8').catch(() => {
        throw new Error('the file is not in the repository at this version');
      });
      const folder = path.dirname(file);
      // The export's own environment, not the one of the working tree.
      const env = { ...process.env };
      delete env.VIRTUAL_ENV;
      delete env.UV_PROJECT_ENVIRONMENT;
      const uv = !!(await findAbove(folder, src, 'uv.lock'));
      const alias = hiddenPath(folder) ? await this.alias(src, cleanup) : undefined;
      say(uv ? 'Building (with the environment of that version)' : 'Building');
      // Quarto's output stays in the export, which is deleted.
      const arg = alias ? path.join(alias, path.relative(src, file)) : path.basename(file);
      const run = await this.render(setting, arg, uv, undefined, folder, env, token, deadline, new Set(await fs.readdir(folder)));
      return { text, run };
    } finally {
      await this.end(cleanup);
    }
  }

  /**
   * Runs Quarto on `file` (a name in `folder`, or a path to it through a link) in `folder`, and
   * reads the notebook it kept there: one that wasn't there `before`.
   */
  private async render(
    setting: string,
    file: string,
    uv: boolean,
    out: string | undefined,
    folder: string,
    env: NodeJS.ProcessEnv,
    token: vscode.CancellationToken,
    deadline: number,
    before: Set<string>,
  ): Promise<QuartoRun> {
    // ZenML replaces the notebook's traceback with Rich's, printed as the cell's output, which
    // Quarto doesn't show when the cell fails: the log would say a cell failed but not why.
    const buildEnv = { ...env, ZENML_ENABLE_RICH_TRACEBACK: 'false' };
    try {
      await this.exec(quartoCommand(setting, file, uv, out), folder, buildEnv, token, deadline);
    } catch (e) {
      if (setting || !uv || !(e instanceof Error) || !extrasConflict(e.message)) throw e;
      this.say('The project\'s extras conflict, so they can\'t all be installed: building without them.');
      await this.exec(quartoCommand(setting, file, uv, out, false), folder, buildEnv, token, deadline);
    }
    const kept = keptNotebook(path.basename(file), (await fs.readdir(folder)).filter((n) => !before.has(n)));
    if (!kept) throw new Error('Quarto kept no notebook of the document: only documents run by its Jupyter engine (Python, for one) can be built');
    const notebook = path.join(folder, kept);
    try {
      return readQuartoRun(await fs.readFile(notebook, 'utf8'));
    } finally {
      await fs.rm(notebook, { force: true });
    }
  }

  /**
   * A path to `dir` without a folder that starts with a dot: a link to it in a new folder of the
   * system's temporary folder, removed with the build's cleanup. Undefined when none can be made;
   * the build then goes on, and Quarto may build the file without its project.
   */
  private async alias(dir: string, cleanup: Cleanup): Promise<string | undefined> {
    let top: string | undefined;
    try {
      top = await fs.mkdtemp(path.join(os.tmpdir(), 'mdiff-quarto-link-'));
      const link = path.join(top, path.basename(dir).replace(/^\.+/, '') || 'repo');
      if (hiddenPath(link)) throw new Error('the temporary folder is hidden too');
      await fs.symlink(dir, link, 'dir');
      (cleanup.links ??= []).push(link);
      this.writePending();
      return link;
    } catch (e) {
      if (top) await fs.rmdir(top).catch(() => undefined);
      this.say(`Note: Quarto leaves out of a project a file under a folder whose name starts with a dot, and no other path to it could be made (${message(e)}). The file is built without its project's settings.`);
      return undefined;
    }
  }

  private begin(c: Cleanup): void {
    this.cleanups.add(c);
    this.writePending();
  }

  private async end(c: Cleanup): Promise<void> {
    await undoAsync(c);
    this.cleanups.delete(c);
    this.writePending();
  }

  private pendingFile(): string {
    return path.join(this.root, 'quarto-pending.json');
  }

  private readPending(): Cleanup[] {
    try {
      const list = JSON.parse(readFileSync(this.pendingFile(), 'utf8')) as Cleanup[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** Writes what the running build changed, so the next window undoes it if this one can't. */
  private writePending(): void {
    try {
      if (this.cleanups.size) {
        mkdirSync(this.root, { recursive: true });
        writeFileSync(this.pendingFile(), JSON.stringify([...this.cleanups]));
      } else {
        rmSync(this.pendingFile(), { force: true });
      }
    } catch {
      // Not fatal: the cleanup at the end of the build still runs.
    }
  }

  /** Runs a command to its end, its output going to the log. Rejects when it fails, is cancelled or takes too long. */
  private exec(command: string[], cwd: string, env: NodeJS.ProcessEnv, token: vscode.CancellationToken, deadline: number): Promise<void> {
    this.say(`$ ${command.join(' ')}   (in ${cwd})`);
    return new Promise((resolve, reject) => {
      if (token.isCancellationRequested) {
        reject(new Cancelled());
        return;
      }
      const windows = process.platform === 'win32';
      const mark = randomBytes(8).toString('hex');
      // Its own process group, so that a cancel also stops what Quarto started.
      const child = spawn(command[0], command.slice(1), { cwd, env: { ...env, [MARK]: mark }, shell: windows, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
      const pid = child.pid;
      if (pid !== undefined && !windows) this.running.set(pid, mark);
      let tail = '';
      let cancelled = false;
      let late = false;
      const out = (chunk: Buffer) => {
        // Without the colours of a terminal, which an output channel and a message show as codes.
        // eslint-disable-next-line no-control-regex
        const text = chunk.toString().replace(/\u001b\[[0-9;]*m/g, '');
        // Long enough for a failed cell's source and its traceback, which say why it failed.
        tail = (tail + text).slice(-20000);
        this.log?.append(text);
      };
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      const kill = () => {
        if (pid === undefined) return;
        if (windows) {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
          return;
        }
        const first = killAll(pid, mark, 'SIGTERM');
        setTimeout(() => {
          first.forEach((p) => signal(p, 'SIGKILL'));
          killAll(pid, mark, 'SIGKILL');
        }, 3000).unref();
      };
      const sub = token.onCancellationRequested(() => {
        cancelled = true;
        kill();
      });
      const timer = setTimeout(() => {
        late = true;
        kill();
      }, Math.max(0, deadline - Date.now()));
      const end = (err?: Error) => {
        sub.dispose();
        clearTimeout(timer);
        if (pid !== undefined && !windows) {
          this.running.delete(pid);
          // Whatever the command left running, such as a kernel after a crash.
          if (marked(mark).length) {
            killAll(pid, mark, 'SIGTERM');
            setTimeout(() => killAll(pid, mark, 'SIGKILL'), 3000).unref();
          }
        }
        if (err) reject(err);
        else resolve();
      };
      child.on('error', (e) =>
        end((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`"${command[0]}" wasn't found. Install it, or set the command in the setting mdiff.quarto.command`) : e),
      );
      child.on('close', (code) => {
        if (cancelled) end(new Cancelled());
        else if (late) end(new Error(`stopped after ${TIME_LIMIT_MINUTES} minutes`));
        else if (code !== 0) {
          const why = failureLine(tail);
          end(new Error(`${path.basename(command[0])} ended with code ${code}${why ? `: ${why}` : ''}`));
        } else end();
      });
    });
  }

  /** Deletes the results built more than `KEEP_DAYS` days ago. */
  private async prune(): Promise<void> {
    const dir = path.join(this.root, 'quarto-runs');
    const old = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat && stat.mtimeMs < old) await fs.rm(file, { force: true });
    }
  }
}

/** The key of the results of a version: its file, and the ref of a `git:` one. */
function idOf(uri: vscode.Uri): string {
  if (uri.scheme === 'git') {
    const q = gitQuery(uri);
    return `git:${q?.path ?? uri.fsPath}:${q?.ref ?? ''}`;
  }
  return `${uri.scheme}:${uri.fsPath}`;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone.
  }
}

/**
 * Signals a command's process group, every process under it, and every process with its `mark`,
 * and returns them. Quarto's Jupyter kernel starts a session of its own, so the group's signal
 * misses it; and once Quarto is gone, the kernel's parent is the user's service manager, not init,
 * and the kernel doesn't notice that it is alone.
 */
function killAll(pid: number, mark: string, sig: NodeJS.Signals): number[] {
  const all = [...new Set([-pid, pid, ...descendants(pid), ...marked(mark)])];
  all.forEach((p) => signal(p, sig));
  return all;
}

/** The processes with this mark in their environment. Linux only: elsewhere, the process tree does. */
function marked(mark: string): number[] {
  if (process.platform !== 'linux') return [];
  const needle = `${MARK}=${mark}\0`;
  const out: number[] = [];
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  for (const p of pids) {
    try {
      if (readFileSync(`/proc/${p}/environ`, 'latin1').includes(needle)) out.push(Number(p));
    } catch {
      // Gone, or another user's.
    }
  }
  return out;
}

/** The processes under a process, from `ps`. */
function descendants(pid: number): number[] {
  let table: string;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!p || pp === undefined) continue;
    children.set(pp, [...(children.get(pp) ?? []), p]);
  }
  const out: number[] = [];
  const todo = [pid];
  while (todo.length) {
    for (const c of children.get(todo.pop()!) ?? []) {
      if (out.includes(c)) continue;
      out.push(c);
      todo.push(c);
    }
  }
  return out;
}

/** Removes the links of a cleanup and their folders, without following them. */
function unlinkAll(c: Cleanup): void {
  for (const link of c.links ?? []) {
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {
      // Gone already.
    }
    try {
      rmdirSync(path.dirname(link));
    } catch {
      // Not empty, or gone: left as it is.
    }
  }
}

function undo(c: Cleanup): void {
  unlinkAll(c);
  for (const r of c.restore) {
    try {
      if (r.text === null) rmSync(r.file, { force: true });
      else if (readFileSync(r.file, 'utf8') !== r.text) writeFileSync(r.file, r.text);
    } catch {
      // A .gitignore that is gone now needs no restore.
    }
  }
  for (const p of c.remove) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // Not there.
    }
  }
}

async function undoAsync(c: Cleanup): Promise<void> {
  unlinkAll(c);
  for (const r of c.restore) {
    const now = await fs.readFile(r.file, 'utf8').catch(() => null);
    if (now === r.text) continue;
    if (r.text === null) await fs.rm(r.file, { force: true });
    else await fs.writeFile(r.file, r.text);
  }
  for (const p of c.remove) await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
}

function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

/** The first `name` in `folder` or a folder above it, up to `top`. */
async function findAbove(folder: string, top: string, name: string): Promise<string | undefined> {
  for (let dir = folder; ; dir = path.dirname(dir)) {
    const file = path.join(dir, name);
    if (await exists(file)) return file;
    if (dir === top || !dir.startsWith(top) || path.dirname(dir) === dir) return undefined;
  }
}

/** The trimmed output of a git command; rejects when it fails. */
function gitOut(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `git ${args[0]} failed`))));
  });
}
