import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { simpleGit, SimpleGit } from 'simple-git';
import { normalizeUnifiedDiffPatch } from './unified-diff.js';

export interface FileEntry {
  path: string;
  content: string;
}

export interface CommitResult {
  hash: string;
  branch: string;
  message: string;
}

/**
 * The deletion primitive never throws an ambiguous ref-update result into its
 * caller. A caller may report git_failed only after observing the old head;
 * every other outcome is retained for manual audit reconciliation.
 */
export type LocalDeletionCommitResult =
  | { state: 'applied'; commit: CommitResult }
  | { state: 'not_applied'; error: string }
  | { state: 'reconciliation_required'; commit?: CommitResult; observation: 'matching_commit' | 'unexpected_head' | 'head_unavailable'; error: string };

export interface HistoryEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface PatchApplyCheckResult {
  applyable: boolean;
  error?: string;
}

export interface ExportTargetBranchInfo {
  repoRoot: string | null;
  branch: string | null;
  revision: string | null;
}

export interface TreeFileEntry {
  mode: string;
  type: string;
  revision: string;
}

export interface TreeEntry extends TreeFileEntry {
  path: string;
}

export interface CommitFileChange {
  oldMode: string;
  newMode: string;
  oldRevision: string;
  newRevision: string;
  status: string;
  path: string;
}

function runBareGit(repoPath: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: repoPath,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => resolve(error ? null : Buffer.from(stdout)));
  });
}

function runBareGitOrThrow(repoPath: string, args: string[], environment: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: repoPath,
      env: environment,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => error ? reject(new Error(stderr.toString('utf8').trim() || error.message)) : resolve(Buffer.from(stdout)));
  });
}

function parseTreeEntry(raw: string): TreeFileEntry | undefined {
  const match = raw.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t/);
  return match ? { mode: match[1], type: match[2], revision: match[3] } : undefined;
}

function sameChangedFiles(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }

  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((file, index) => file === expectedSorted[index]);
}

export class GitStore {
  private repoPath: string;
  private workDir: string;
  // Private fault seam for deterministic state-machine tests. It is never
  // populated by production callers and cannot alter the public MCP contract.
  private orphanRemovalRefUpdateFault?: (stage: 'before_update_ref' | 'after_update_ref') => void | Promise<void>;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.workDir = path.join(repoPath, 'workdir');
  }

  get repoDir(): string {
    return this.repoPath;
  }

  /**
   * Initialize a new bare Git repository for the docs store.
   */
  async init(): Promise<void> {
    await fs.promises.mkdir(this.repoPath, { recursive: true });
    const git = simpleGit({ baseDir: this.repoPath });
    await git.init(true);
  }

  /**
   * Check if the store has been initialized.
   */
  async isInitialized(): Promise<boolean> {
    try {
      const gitDir = path.join(this.repoPath, 'HEAD');
      await fs.promises.access(gitDir);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a simple-git instance for the working directory.
   * Clones the bare repo to workDir if not already cloned.
   */
  private async getGit(branch?: string): Promise<SimpleGit> {
    const gitDirExists = await this.dirExists(this.workDir);
    if (!gitDirExists) {
      await fs.promises.mkdir(this.workDir, { recursive: true });
      const git = simpleGit({ baseDir: this.workDir });
      await git.clone(this.repoPath, this.workDir, ['--no-checkout', '--shared']);
    }

    const git = simpleGit({ baseDir: this.workDir });
    if (branch) {
      try {
        await git.checkout(branch);
      } catch {
        // Branch may not exist locally; fetch from origin
        try {
          await git.fetch('origin', branch);
          await git.checkout(branch);
        } catch {
          // Branch doesn't exist yet
        }
      }
    }
    return git;
  }

  /**
   * Clone the bare repo to workDir, checkout branch, perform work, and push back.
   */
  private async withWorkDir<T>(
    branch: string,
    fn: (git: SimpleGit, workDir: string) => Promise<T>,
  ): Promise<T> {
    // Clone or fetch the bare repo
    if (!(await this.dirExists(this.workDir))) {
      await fs.promises.mkdir(this.workDir, { recursive: true });
      const git = simpleGit({ baseDir: this.workDir });
      await git.clone(this.repoPath, this.workDir, ['--shared']);
    }

    const git = simpleGit({ baseDir: this.workDir });

    // Fetch all branches
    try {
      await git.fetch('origin', '--all');
    } catch {
      // First fetch may fail if repo is empty
    }

    // Check if branch exists remotely
    let branchExists = false;
    try {
      const branches = await git.branch(['-a']);
      branchExists = branches.all.some(
        (b: string) => b === branch || b === `origin/${branch}` || b === `remotes/origin/${branch}`,
      );
    } catch {
      // No branches yet
    }

    if (branchExists) {
      // Checkout the branch (tracking origin)
      try {
        await git.checkout(branch);
      } catch {
        await git.checkoutBranch(branch, `origin/${branch}`);
      }
    } else {
      // Create a new orphan branch or checkout default
      try {
        await git.checkout('main');
      } catch {
        // No commits yet, create an initial commit
        await git.raw(['checkout', '--orphan', 'main']);
        try {
          await git.raw(['commit', '--allow-empty', '-m', 'Initial commit']);
        } catch {
          // Already has commits
        }
      }
    }

    // Ensure clean working directory before each operation.
    // This prevents stale files from a previous failed or interrupted
    // operation from leaking into the current one.
    try {
      await git.raw(['reset', '--hard', 'HEAD']);
      await git.raw(['clean', '-fd']);
    } catch {
      // No commits yet — nothing to reset or clean
    }

    const result = await fn(git, this.workDir);

    // Push changes back to bare repo
    try {
      const currentBranch = (await git.branch()).current;
      await git.push('origin', currentBranch);
    } catch {
      // Push may fail if no changes
    }

    return result;
  }

  /**
   * Snapshot a set of files into the store.
   * Creates an initial commit on 'main' branch.
   */
  async snapshotInitial(files: FileEntry[]): Promise<CommitResult> {
    return this.withWorkDir('main', async (git: SimpleGit, workDir: string) => {
      // Write all files to workdir
      for (const file of files) {
        const fullPath = path.join(workDir, file.path);
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.promises.writeFile(fullPath, file.content, 'utf-8');
      }

      // Check if there are any existing commits
      let hasCommits = false;
      try {
        const log = await git.log({ maxCount: 1 });
        hasCommits = log.total > 0;
      } catch {
        hasCommits = false;
      }

      if (!hasCommits) {
        // Initial commit on main
        await git.add('.');
        const result = await git.commit('Initial documentation snapshot');
        return {
          hash: result.commit,
          branch: 'main',
          message: 'Initial documentation snapshot',
        };
      }

      // Check for changes
      const status = await git.status();
      if (status.files.length > 0) {
        await git.add('.');
        const result = await git.commit('Update documentation snapshot');
        return {
          hash: result.commit,
          branch: 'main',
          message: 'Update documentation snapshot',
        };
      }

      // No changes, return current HEAD
      const log = await git.log({ maxCount: 1 });
      return {
        hash: log.latest?.hash ?? 'unknown',
        branch: 'main',
        message: 'No changes',
      };
    });
  }

  /**
   * Read a file from a branch at its HEAD revision.
   */
  async readFile(branch: string, filePath: string): Promise<string | null> {
    const bareGit = simpleGit({ baseDir: this.repoPath });

    try {
      const content = await bareGit.show([`${branch}:${filePath}`]);
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Read a file at a specific revision.
   */
  async readFileAtRevision(revision: string, filePath: string): Promise<string | null> {
    const bareGit = simpleGit({ baseDir: this.repoPath });

    try {
      const content = await bareGit.show([`${revision}:${filePath}`]);
      return content;
    } catch {
      return null;
    }
  }

  /** Read a tree entry without checking out, fetching, or consulting a remote. */
  async getTreeFileEntry(branch: string, filePath: string): Promise<TreeFileEntry | null> {
    try {
      const output = await simpleGit({ baseDir: this.repoPath }).raw([
        'ls-tree', branch, '--', filePath,
      ]);
      return parseTreeEntry(output.trim()) ?? null;
    } catch { return null; }
  }

  /**
   * Read a tree entry at an immutable object. Undefined is a proven absence;
   * null is deliberately reserved for an observation failure so callers can
   * fail closed instead of confusing missing content with unavailable Git.
   */
  async observeTreeFileEntry(revision: string, filePath: string): Promise<TreeFileEntry | undefined | null> {
    const output = await runBareGit(this.repoPath, ['ls-tree', '-z', revision, '--', filePath]);
    if (output === null) return null;
    if (output.length === 0) return undefined;
    const record = output.toString('utf8').replace(/\0$/, '');
    return parseTreeEntry(record) ?? null;
  }

  /** Enumerate the exact branch tree with modes, object types, and blob IDs. */
  async observeTreeEntries(branch: string): Promise<TreeEntry[] | null> {
    const output = await runBareGit(this.repoPath, ['ls-tree', '-r', '-z', branch]);
    if (output === null) return null;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      const entries: TreeEntry[] = [];
      const seen = new Set<string>();
      for (const raw of output.toString('binary').split('\0')) {
        if (!raw) continue;
        const tab = raw.indexOf('\t');
        if (tab < 0) return null;
        const header = raw.slice(0, tab);
        const pathBytes = Buffer.from(raw.slice(tab + 1), 'binary');
        const filePath = decoder.decode(pathBytes);
        const parsed = parseTreeEntry(`${header}\t`);
        if (!parsed || !filePath || seen.has(filePath)) return null;
        seen.add(filePath);
        entries.push({ path: filePath, ...parsed });
      }
      return entries;
    } catch {
      return null;
    }
  }

  /** Read an exact Git blob as bytes; this has no worktree or remote behavior. */
  async readBlob(revision: string): Promise<Buffer | null> {
    return runBareGit(this.repoPath, ['cat-file', 'blob', revision]);
  }

  /** Observe a commit's sole parent. Multiple parents are intentionally ambiguous. */
  async observeSingleCommitParent(commit: string): Promise<string | null> {
    const output = await runBareGit(this.repoPath, ['rev-list', '--parents', '-n', '1', commit]);
    if (output === null) return null;
    const fields = output.toString('utf8').trim().split(/\s+/);
    return fields.length === 2 && fields[0] === commit ? fields[1] : null;
  }

  /** Observe raw commit changes so status checks can prove a full-file deletion. */
  async observeCommitFileChanges(commit: string): Promise<CommitFileChange[] | null> {
    const output = await runBareGit(this.repoPath, ['diff-tree', '--no-commit-id', '--raw', '-r', '-z', commit]);
    if (output === null) return null;
    try {
      const fields = output.toString('utf8').split('\0').filter(Boolean);
      const changes: CommitFileChange[] = [];
      for (let index = 0; index < fields.length; index += 2) {
        const header = fields[index];
        const filePath = fields[index + 1];
        const match = header.match(/^:(\d+)\s+(\d+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([A-Z])$/);
        if (!match || !filePath) return null;
        changes.push({
          oldMode: match[1], newMode: match[2], oldRevision: match[3], newRevision: match[4], status: match[5], path: filePath,
        });
      }
      return changes;
    } catch {
      return null;
    }
  }

  /**
   * Commit one already-reviewed deletion directly in the local bare store.
   * This intentionally avoids withWorkDir and every remote command/config path.
   */
  async commitOneFileDeletionLocal(
    branch: 'main', filePath: string, expectedHead: string, expectedRevision: string, message: string,
  ): Promise<LocalDeletionCommitResult> {
    const git = simpleGit({ baseDir: this.repoPath });
    const commitResult = (hash: string): CommitResult => ({ hash, branch, message });
    const observeNonApplication = async (error: unknown, commit?: string): Promise<LocalDeletionCommitResult> => {
      const observedHead = await this.getBranchHead(branch);
      const detail = error instanceof Error ? error.message : String(error);
      if (observedHead === expectedHead) return { state: 'not_applied', error: detail };
      if (commit) return {
        state: 'reconciliation_required', commit: commitResult(commit),
        observation: observedHead === null ? 'head_unavailable' : 'unexpected_head', error: detail,
      };
      // Without a generated commit identity this still cannot honestly be
      // treated as git_failed unless the old head was observed above.
      return {
        state: 'reconciliation_required',
        observation: observedHead === null ? 'head_unavailable' : 'unexpected_head', error: detail,
      };
    };
    let head: string;
    let entry: TreeFileEntry | null;
    try {
      head = (await git.raw(['rev-parse', branch])).trim();
      if (head !== expectedHead) throw new Error(`Managed branch head changed from ${expectedHead} to ${head}`);
      entry = await this.getTreeFileEntry(branch, filePath);
      if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || entry.revision !== expectedRevision) {
        throw new Error('Target is missing, non-regular, or no longer matches the reviewed revision');
      }
    } catch (error) {
      return observeNonApplication(error);
    }
    const index = path.join(this.repoPath, `.orphan-removal-${process.pid}-${Date.now()}.index`);
    // Explicit GIT_DIR keeps every plumbing command in the bare managed store;
    // no source worktree is consulted or required for this guarded deletion.
    const environment = { ...process.env, GIT_DIR: this.repoPath, GIT_WORK_TREE: this.repoPath, GIT_INDEX_FILE: index };
    const local = (args: string[]) => runBareGitOrThrow(this.repoPath, args, environment);
    try {
      await local(['read-tree', branch]);
      await local(['update-index', '--force-remove', '--', filePath]);
      const tree = (await local(['write-tree'])).toString('utf8').trim();
      const commit = (await local([
        '-c', 'user.name=Xurgo Atlas', '-c', 'user.email=atlas@localhost',
        'commit-tree', tree, '-p', head, '-m', message,
      ])).toString('utf8').trim();
      // Prove the prospective object has the reviewed one-file deletion shape
      // before it can become reachable from the managed branch.
      const changes = await this.observeCommitFileChanges(commit);
      const exactDeletion = changes?.length === 1 && changes[0].path === filePath && changes[0].status === 'D' &&
        changes[0].oldMode === entry.mode && changes[0].newMode === '000000' &&
        changes[0].oldRevision === expectedRevision && /^0+$/.test(changes[0].newRevision);
      if (!exactDeletion) throw new Error('Prospective local deletion commit is not the exact reviewed one-file deletion');
      try {
        await this.orphanRemovalRefUpdateFault?.('before_update_ref');
        await local(['update-ref', `refs/heads/${branch}`, commit, head]);
        await this.orphanRemovalRefUpdateFault?.('after_update_ref');
      } catch (error) {
        const observedHead = await this.getBranchHead(branch);
        const detail = error instanceof Error ? error.message : String(error);
        if (observedHead === expectedHead) return { state: 'not_applied', error: detail };
        return {
          state: 'reconciliation_required', commit: commitResult(commit),
          observation: observedHead === commit ? 'matching_commit' : observedHead === null ? 'head_unavailable' : 'unexpected_head', error: detail,
        };
      }
      const observedHead = await this.getBranchHead(branch);
      if (observedHead === commit) return { state: 'applied', commit: commitResult(commit) };
      return {
        state: 'reconciliation_required', commit: commitResult(commit),
        observation: observedHead === null ? 'head_unavailable' : 'unexpected_head',
        error: 'Managed branch ref update outcome could not be proven exact',
      };
    } catch (error) {
      return observeNonApplication(error);
    } finally {
      await fs.promises.rm(index, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Create a new branch from an existing branch.
   */
  async createBranch(branch: string, sourceBranch = 'main'): Promise<void> {
    return this.withWorkDir(sourceBranch, async (git: SimpleGit, _workDir: string) => {
      await git.checkoutLocalBranch(branch);
      await git.push('origin', branch);
    });
  }

  /**
   * Check if a branch exists.
   */
  async branchExists(branch: string): Promise<boolean> {
    const bareGit = simpleGit({ baseDir: this.repoPath });
    try {
      const result = await bareGit.branch(['-a']);
      return result.all.some(
        (b: string) =>
          b === branch ||
          b === `origin/${branch}` ||
          b === `remotes/origin/${branch}`,
      );
    } catch {
      return false;
    }
  }

  /**
   * Get the HEAD revision for a file on a branch.
   */
  async getFileRevision(branch: string, filePath: string): Promise<string | null> {
    const bareGit = simpleGit({ baseDir: this.repoPath });
    try {
      const result = await bareGit.log([
        branch,
        '--',
        filePath,
        '-n',
        '1',
        '--pretty=format:%H',
      ]);
      if (result.latest) {
        return result.latest.hash;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get the HEAD revision for a branch.
   */
  async getBranchHead(branch: string): Promise<string | null> {
    const bareGit = simpleGit({ baseDir: this.repoPath });
    try {
      const result = await bareGit.revparse([branch]);
      return result.trim();
    } catch {
      return null;
    }
  }

  /**
   * Apply content changes to a file and commit on the branch.
   */
  async applyAndCommit(
    branch: string,
    filePath: string,
    content: string,
    message: string,
    baseRevision?: string,
  ): Promise<CommitResult> {
    return this.withWorkDir(branch, async (git: SimpleGit, workDir: string) => {
      // Verify base revision if provided
      if (baseRevision) {
        const currentRevision = await this.getFileRevision(branch, filePath);
        if (currentRevision && currentRevision !== baseRevision) {
          throw new Error(
            `Base revision mismatch: expected ${baseRevision}, but current revision is ${currentRevision}. The file has been modified since you read it.`,
          );
        }
      }

      // Write the new content
      const fullPath = path.join(workDir, filePath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, content, 'utf-8');

      await git.add(filePath);
      const result = await git.commit(message);
      await git.push('origin', branch);

      return {
        hash: result.commit,
        branch,
        message,
      };
    });
  }

  /**
   * Apply a unified diff patch to a file on a branch and commit.
   */
  async applyPatchAndCommit(
    branch: string,
    filePath: string,
    patchContent: string,
    message: string,
    baseRevision?: string,
  ): Promise<CommitResult> {
    return this.applyMultiFilePatchAndCommit(
      branch,
      patchContent,
      message,
      [filePath],
      baseRevision ? { [filePath]: baseRevision } : undefined,
    );
  }

  /**
   * Validate whether a unified diff can be applied cleanly on a branch without committing.
   */
  async validatePatchApplyability(
    branch: string,
    patchContent: string,
    changedFiles: string[],
  ): Promise<PatchApplyCheckResult> {
    return this.withWorkDir(branch, async (git: SimpleGit, workDir: string) => {
      if (changedFiles.length === 0) {
        return {
          applyable: false,
          error: 'Patch does not name any changed files',
        };
      }

      let normalizedPatch: string;
      try {
        const normalized = normalizeUnifiedDiffPatch(patchContent);
        if (!sameChangedFiles(normalized.changedFiles, changedFiles)) {
          return {
            applyable: false,
            error:
              `Patch changes ${normalized.changedFiles.join(', ') || '(none)'} ` +
              `but expected ${changedFiles.join(', ')}.`,
          };
        }
        normalizedPatch = normalized.normalizedPatch;
      } catch (err: unknown) {
        return {
          applyable: false,
          error: (err as Error).message,
        };
      }

      for (const filePath of changedFiles) {
        const fullPath = path.join(workDir, filePath);
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      }

      const patchFile = path.join(workDir, '.xurgo-atlas-patch-check.tmp');
      await fs.promises.writeFile(patchFile, normalizedPatch, 'utf-8');

      try {
        const applyResult = await git.raw([
          'apply',
          '--check',
          '--unidiff-zero',
          '--whitespace=nowarn',
          patchFile,
        ]);

        if (applyResult && applyResult.includes('error:')) {
          return {
            applyable: false,
            error: applyResult.trim(),
          };
        }

        return { applyable: true };
      } catch (err: unknown) {
        return {
          applyable: false,
          error: (err as Error).message,
        };
      } finally {
        try {
          await fs.promises.unlink(patchFile);
        } catch { /* ignore */ }
      }
    });
  }

  /**
   * Apply a unified diff patch that can touch multiple files and commit atomically.
   */
  async applyMultiFilePatchAndCommit(
    branch: string,
    patchContent: string,
    message: string,
    changedFiles: string[],
    baseRevisions?: Record<string, string>,
  ): Promise<CommitResult> {
    return this.withWorkDir(branch, async (git: SimpleGit, workDir: string) => {
      if (changedFiles.length === 0) {
        throw new Error('Patch does not name any changed files');
      }

      if (baseRevisions) {
        for (const [filePath, expectedRevision] of Object.entries(baseRevisions)) {
          const currentRevision = await this.getFileRevision(branch, filePath);
          if (currentRevision && currentRevision !== expectedRevision) {
            throw new Error(
              `Base revision mismatch: expected ${expectedRevision}, but current revision is ${currentRevision}. The file has been modified since you read it.`,
            );
          }
        }
      }

      for (const filePath of changedFiles) {
        const fullPath = path.join(workDir, filePath);
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      }

      let normalizedPatch: string;
      try {
        const normalized = normalizeUnifiedDiffPatch(patchContent);
        if (!sameChangedFiles(normalized.changedFiles, changedFiles)) {
          throw new Error(
            `Patch changes ${normalized.changedFiles.join(', ') || '(none)'} but expected ${changedFiles.join(', ')}.`,
          );
        }
        normalizedPatch = normalized.normalizedPatch;
      } catch (err: unknown) {
        throw new Error(
          `Patch does not apply cleanly: ${(err as Error).message}`,
        );
      }

      const patchFile = path.join(workDir, '.xurgo-atlas-patch.tmp');
      await fs.promises.writeFile(patchFile, normalizedPatch, 'utf-8');

      try {
        const applyResult = await git.raw([
          'apply',
          '--unidiff-zero',
          '--whitespace=nowarn',
          patchFile,
        ]);
        if (applyResult && applyResult.includes('error:')) {
          throw new Error(
            `Patch application failed: ${applyResult}`,
          );
        }
      } catch (err: unknown) {
        try {
          await fs.promises.unlink(patchFile);
        } catch { /* ignore */ }
        throw new Error(
          `Patch does not apply cleanly: ${(err as Error).message}`,
        );
      }

      // Clean up patch file
      try {
        await fs.promises.unlink(patchFile);
      } catch { /* ignore */ }

      await git.add(changedFiles);
      const result = await git.commit(message);
      await git.push('origin', branch);

      return {
        hash: result.commit,
        branch,
        message,
      };
    });
  }

  /**
   * Get the diff for a file between two revisions, or against HEAD.
   */
  async getDiff(
    branch: string,
    filePath: string,
    baseRevision?: string,
  ): Promise<string | null> {
    const bareGit = simpleGit({ baseDir: this.repoPath });
    try {
      if (baseRevision) {
        const result = await bareGit.diff([baseRevision, branch, '--', filePath]);
        return result;
      }
      // Show working tree diff vs HEAD
      const result = await bareGit.diff([branch, '--', filePath]);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Get the history (log) for a file.
   */
  async getHistory(filePath: string, limit = 50): Promise<HistoryEntry[]> {
    const bareGit = simpleGit({ baseDir: this.repoPath });
    try {
      const log = await bareGit.log({
        '--': filePath,
        maxCount: limit,
      });
      return log.all.map((entry) => ({
        hash: entry.hash,
        author: entry.author_name,
        date: entry.date,
        message: entry.message,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get the diff of a specific commit.
   */
  async getCommitDiff(revision: string): Promise<string | null> {
    const bareGit = simpleGit({ baseDir: this.repoPath });
    try {
      const result = await bareGit.show([revision, '--format=""', '--']);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Restore a file from a specific revision to the working tree.
   */
  async restoreFile(
    branch: string,
    filePath: string,
    revision: string,
  ): Promise<CommitResult> {
    return this.withWorkDir(branch, async (git: SimpleGit, _workDir: string) => {
      // Checkout the file from the specified revision
      await git.raw(['checkout', revision, '--', filePath]);

      await git.add(filePath);
      const result = await git.commit(`Restore ${filePath} from revision ${revision.slice(0, 8)}`);
      await git.push('origin', branch);

      return {
        hash: result.commit,
        branch,
        message: `Restore ${filePath} from revision ${revision.slice(0, 8)}`,
      };
    });
  }

  /**
   * Export files from a branch to a target directory.
   *
   * @param branch - The managed branch to export from.
   * @param targetDir - The filesystem directory to write files into.
   * @param files - Optional explicit list of files to export. When provided,
   *                only these files are written (useful for filtering to
   *                current owned/tracked docs). When omitted, every file
   *                tracked in the managed branch is exported (legacy behavior).
   */
  async exportBranch(branch: string, targetDir: string, files?: string[]): Promise<string[]> {
    const branchExists = await this.branchExists(branch);
    if (!branchExists) {
      throw new Error(
        `Managed docs branch "${branch}" does not exist. Managed docs branches are separate from the source repo branch. Create it with docs.create_branch or export an existing managed branch.`,
      );
    }

    const targetBranchInfo = await this.getExportTargetBranchInfo(targetDir);
    if (targetBranchInfo.branch && targetBranchInfo.branch !== branch) {
      throw new Error(
        `Refusing to export managed docs branch "${branch}" into source branch "${targetBranchInfo.branch}" at "${targetBranchInfo.repoRoot ?? targetDir}". Export copies the full managed branch snapshot and may introduce unrelated cross-branch drift. Check out the matching source branch first, or create/export the matching managed branch explicitly.`,
      );
    }

    return this.withWorkDir(branch, async (_git: SimpleGit, _workDir: string) => {
      // Determine which files to export
      let filesToExport: string[];

      if (files) {
        // Use the caller-provided file list (typically current owned/tracked docs)
        filesToExport = files;
      } else {
        // Legacy: list all tracked files in the branch
        const bareGit = simpleGit({ baseDir: this.repoPath });
        const filesOutput = await bareGit.raw(['ls-tree', '-r', '--name-only', branch]);
        filesToExport = filesOutput
          .split('\n')
          .map((f: string) => f.trim())
          .filter((f: string) => f.length > 0);
      }

      const exported: string[] = [];

      for (const file of filesToExport) {
        const content = await this.readFileAtRevision(branch, file);
        if (content !== null) {
          const fullPath = path.join(targetDir, file);
          await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.promises.writeFile(fullPath, content, 'utf-8');
          exported.push(file);
        }
      }

      return exported;
    });
  }

  /**
   * List all files tracked in a branch.
   */
  async listFiles(branch = 'main'): Promise<string[]> {
    try {
      const bareGit = simpleGit({ baseDir: this.repoPath });
      const result = await bareGit.raw(['ls-tree', '-r', '--name-only', branch]);
      return result
        .split('\n')
        .map((f: string) => f.trim())
        .filter((f: string) => f.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Check if a file exists in a branch.
   */
  async fileExists(branch: string, filePath: string): Promise<boolean> {
    const bareGit = simpleGit({ baseDir: this.repoPath });
    try {
      await bareGit.show([`${branch}:${filePath}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async dirExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    try {
      await fs.promises.rm(this.workDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  async getExportTargetBranchInfo(targetDir: string): Promise<ExportTargetBranchInfo> {
    const existingDir = await this.findExistingDirectory(targetDir);
    if (!existingDir) {
      return {
        repoRoot: null,
        branch: null,
        revision: null,
      };
    }

    const git = simpleGit({ baseDir: existingDir });

    try {
      const repoRoot = (await git.revparse(['--show-toplevel'])).trim();
      const branchSummary = await git.branch();
      const branch = branchSummary.current.trim();
      const revision = (await git.revparse(['HEAD'])).trim();

      return {
        repoRoot,
        branch: branch.length > 0 && branch !== 'HEAD' ? branch : null,
        revision: revision.length > 0 ? revision : null,
      };
    } catch {
      return {
        repoRoot: null,
        branch: null,
        revision: null,
      };
    }
  }

  private async findExistingDirectory(targetDir: string): Promise<string | null> {
    let currentDir = path.resolve(targetDir);

    while (true) {
      if (await this.dirExists(currentDir)) {
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        return null;
      }

      currentDir = parentDir;
    }
  }
}
