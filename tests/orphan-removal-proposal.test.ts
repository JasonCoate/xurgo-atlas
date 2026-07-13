import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { Project } from '../src/core/project.js';
import { proposeOrphanRemoval } from '../src/core/orphan-removal-proposal.js';
import { createUnifiedDiffForDeletion, isExactUnifiedDiffForDeletion } from '../src/core/unified-diff.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-orphan-proposal-'));
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.raw(['config', 'user.name', 'Test Reviewer']);
  await git.raw(['config', 'user.email', 'test@example.invalid']);
  await git.raw(['commit', '--allow-empty', '-m', 'Establish source identity']);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('orphan removal proposal evidence', () => {
  it('is an exact one-file deletion to /dev/null', () => {
    const diff = createUnifiedDiffForDeletion('docs/atlas/orphan.md', '# orphan\n');
    expect(diff).toBe('--- a/docs/atlas/orphan.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-# orphan\n');
    expect(isExactUnifiedDiffForDeletion('docs/atlas/orphan.md', '# orphan\n', diff)).toBe(true);
    expect(isExactUnifiedDiffForDeletion('docs/atlas/orphan.md', '# orphan\n', `${diff}extra`)).toBe(false);
  });

  it.each([
      ['docs/atlas/orphan.md', 'not_orphan'],
      ['docs/atlas//orphan.md', 'evidence_unavailable'],
      ['docs/atlas/../atlas/orphan.md', 'evidence_unavailable'],
      ['STATUS.md', 'evidence_unavailable'],
    ] as const)('rejects manifest path evidence %s', async (pathEntry, expectedCode) => {
    const project = await projectWithTarget(`manifest-${pathEntry.replace(/[^a-z]/g, '')}`);
    const { content, revision } = await project.readFile('main', 'docs/manifest.yml');
    await project.gitStore.applyAndCommit('main', 'docs/manifest.yml', `${content}\n  - path: ${pathEntry}\n`, 'Test manifest evidence', revision!);
    await expect(propose(project)).rejects.toMatchObject({ code: expectedCode });
  });

  it('blocks a non-Markdown textual reference', async () => {
    const project = await projectWithTarget('text-reference');
    await project.gitStore.applyAndCommit('main', 'src/reference.ts', 'export const removed = "docs/atlas/orphan.md";\n', 'Add source reference');
    await expect(propose(project)).rejects.toMatchObject({ code: 'reference_conflict' });
  });

  it('creates a reviewable proposal when every branch blob is searchable text with no references', async () => {
    const project = await projectWithTarget('complete-evidence');
    const proposal = await propose(project);
    const evidence = proposal.evidence as any;
    expect(evidence.references).toMatchObject({
      policyVersion: 'branch-tree-utf8-text-v1',
      complete: true,
      references: [],
    });
    expect(proposal.status).toBe('pending_review');
    expect(evidence.references.excluded).toEqual([]);
    expect(evidence.references.inspectedTextualPaths).toContain('docs/manifest.yml');
  });

  it('fails closed when a binary blob contains the target path bytes', async () => {
    await expectExcludedBlobToFailClosed(
      'binary-target-bytes',
      'assets/binary-reference.bin',
      Buffer.concat([Buffer.from('docs/atlas/orphan.md'), Buffer.from([0])]),
      'binary',
    );
  });

  it('fails closed when an invalid UTF-8 blob contains the target path bytes', async () => {
    await expectExcludedBlobToFailClosed(
      'invalid-utf8-target-bytes',
      'assets/invalid-utf8-reference.bin',
      Buffer.concat([Buffer.from('docs/atlas/orphan.md'), Buffer.from([0xc3, 0x28])]),
      'binary',
    );
  });

  it('fails closed when an over-limit blob contains the target path', async () => {
    await expectExcludedBlobToFailClosed(
      'oversized-target-bytes',
      'assets/oversized-reference.txt',
      Buffer.concat([Buffer.from('docs/atlas/orphan.md'), Buffer.alloc(4 * 1024 * 1024, 0x61)]),
      'unsupported',
    );
  });
});

async function projectWithTarget(projectId: string): Promise<Project> {
  const projectRoot = path.join(tmpDir, projectId);
  await fs.promises.mkdir(projectRoot, { recursive: true });
  const git = simpleGit({ baseDir: projectRoot });
  await git.init();
  await git.raw(['config', 'user.name', 'Test Reviewer']);
  await git.raw(['config', 'user.email', 'test@example.invalid']);
  await git.raw(['commit', '--allow-empty', '-m', 'Establish source identity']);
  const project = await Project.init({
    projectRoot,
    projectId,
    configDir: path.join(projectRoot, 'config'),
    dataDir: path.join(projectRoot, 'data'),
  });
  await project.gitStore.applyAndCommit('main', 'docs/atlas/orphan.md', '# orphan\n', 'Add orphan candidate');
  return project;
}

async function propose(project: Project) {
  const target = await project.gitStore.getTreeFileEntry('main', 'docs/atlas/orphan.md');
  expect(target).toBeTruthy();
  return proposeOrphanRemoval(project, { path: 'docs/atlas/orphan.md', baseRevision: target!.revision, reason: 'No manifest registration or managed reference remains.' });
}

async function commitBlob(project: Project, filePath: string, blob: Buffer): Promise<void> {
  const workDir = path.join(project.gitStore.repoDir, 'workdir');
  await fs.promises.mkdir(path.dirname(path.join(workDir, filePath)), { recursive: true });
  await fs.promises.writeFile(path.join(workDir, filePath), blob);
  const git = simpleGit({ baseDir: workDir });
  await git.add(filePath);
  await git.commit('Add excluded-blob fixture');
  await git.push('origin', 'main');
}

async function expectExcludedBlobToFailClosed(projectId: string, filePath: string, blob: Buffer, classification: 'binary' | 'unsupported'): Promise<void> {
  const project = await projectWithTarget(projectId);
  await commitBlob(project, filePath, blob);
  const targetBefore = await project.gitStore.getTreeFileEntry('main', 'docs/atlas/orphan.md');
  const branchHeadBefore = await project.gitStore.getBranchHead('main');
  expect(targetBefore).toBeTruthy();
  expect(branchHeadBefore).toBeTruthy();

  const storeProposal = vi.spyOn(project.eventLog, 'storeOrphanRemovalProposal');
  const prepareAudit = vi.spyOn(project.eventLog, 'prepareOrphanRemovalCommitAudit');
  const commitDeletion = vi.spyOn(project.gitStore, 'commitOneFileDeletionLocal');
  const rejected = await propose(project).catch((error: unknown) => error);

  expect(rejected).toMatchObject({ code: 'evidence_unavailable' });
  expect((rejected as Error).message).toContain(filePath + ' (' + classification + ')');
  expect((rejected as { evidence?: { references?: { complete?: boolean } } }).evidence?.references?.complete).not.toBe(true);
  expect(storeProposal).not.toHaveBeenCalled();
  expect(prepareAudit).not.toHaveBeenCalled();
  expect(commitDeletion).not.toHaveBeenCalled();
  expect(await project.gitStore.getBranchHead('main')).toBe(branchHeadBefore);
  expect(await project.gitStore.getTreeFileEntry('main', 'docs/atlas/orphan.md')).toEqual(targetBefore);
}
