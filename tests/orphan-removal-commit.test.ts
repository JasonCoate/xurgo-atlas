import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { Project } from '../src/core/project.js';
import { commitOrphanRemoval, ORPHAN_REMOVAL_APPROVAL, previewOrphanRemoval, proposeOrphanRemoval } from '../src/core/orphan-removal-proposal.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-orphan-commit-'));
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

describe('orphan removal approval and revalidation', () => {
  it('uses a distinct exact approval phrase', () => {
    expect(ORPHAN_REMOVAL_APPROVAL).toBe('APPROVE_ORPHAN_REMOVAL');
  });

  it('repeats manifest and branch-wide reference evidence before preparing an audit', async () => {
    const { project, proposal } = await preparedProposal('revalidate-reference');
    await project.gitStore.applyAndCommit('main', 'config.ts', 'export const former = "docs/atlas/orphan.md";\n', 'Add late reference');
    await expect(commit(project, proposal)).rejects.toMatchObject({ code: 'reference_conflict' });
    expect(project.eventLog.getOrphanRemovalCommitAudit(proposal.id)).toBeNull();

    const manifest = await preparedProposal('revalidate-manifest');
    const current = await manifest.project.readFile('main', 'docs/manifest.yml');
    await manifest.project.gitStore.applyAndCommit('main', 'docs/manifest.yml', `${current.content}\n  - path: docs/atlas/orphan.md\n`, 'Register target after review', current.revision!);
    await expect(commit(manifest.project, manifest.proposal)).rejects.toMatchObject({ code: 'not_orphan' });
    expect(manifest.project.eventLog.getOrphanRemovalCommitAudit(manifest.proposal.id)).toBeNull();
  });

  it('keeps preview stored-evidence-only and does not rescan or mutate', async () => {
    const { project, proposal } = await preparedProposal('preview');
    const scan = vi.spyOn(project.gitStore, 'observeTreeEntries');
    const before = project.eventLog.getOrphanRemovalProposal(proposal.id)!;
    const preview = previewOrphanRemoval(project, proposal.id);
    expect(preview.reviewDigest).toBe(proposal.review_digest);
    expect(scan).not.toHaveBeenCalled();
    expect(project.eventLog.getOrphanRemovalProposal(proposal.id)).toMatchObject({ updated_at: before.updated_at, status: 'pending_review' });
  });

  it('uses the local bare-store primitive without adding a remote path', async () => {
    const source = await fs.promises.readFile(path.join(process.cwd(), 'src/core/git-store.ts'), 'utf8');
    const method = source.slice(source.indexOf('async commitOneFileDeletionLocal'), source.indexOf('/**\n   * Create a new branch'));
    expect(method).toContain('commit-tree');
    expect(method).not.toMatch(/fetch|push|remote/);
  });

  it('reports git_failed only when a pre-ref failure proves the reviewed head remains intact', async () => {
    const { project, proposal } = await preparedProposal('before-ref-failure');
    const beforeHead = await project.gitStore.getBranchHead('main');
    const beforeTarget = await project.gitStore.getTreeFileEntry('main', proposal.target_path);
    (project.gitStore as any).orphanRemovalRefUpdateFault = (stage: string) => {
      if (stage === 'before_update_ref') throw new Error('Injected pre-ref failure');
    };

    const result = await commit(project, proposal);
    expect(result).toMatchObject({ status: 'git_failed' });
    expect(await project.gitStore.getBranchHead('main')).toBe(beforeHead);
    expect(await project.gitStore.getTreeFileEntry('main', proposal.target_path)).toEqual(beforeTarget);
    expect(project.eventLog.getOrphanRemovalCommitAudit(proposal.id)).toMatchObject({ state: 'prepared', commit_sha: null });
    expect(project.eventLog.getOrphanRemovalProposal(proposal.id)?.status).toBe('git_failed');
  });

  it('reconciles an exception after the exact ref update, retains its commit identity, and never retries deletion', async () => {
    const { project, proposal } = await preparedProposal('after-ref-failure');
    const deleteOnce = vi.spyOn(project.gitStore, 'commitOneFileDeletionLocal');
    (project.gitStore as any).orphanRemovalRefUpdateFault = (stage: string) => {
      if (stage === 'after_update_ref') throw new Error('Injected post-ref failure');
    };

    const result = await commit(project, proposal);
    expect(result).toMatchObject({ status: 'audit_reconciliation_required', observation: 'matching_commit', commit: expect.any(String) });
    expect(await project.gitStore.getBranchHead('main')).toBe((result as { commit: string }).commit);
    expect(project.eventLog.getOrphanRemovalCommitAudit(proposal.id)).toMatchObject({ state: 'prepared', commit_sha: (result as { commit: string }).commit });
    expect(project.eventLog.getOrphanRemovalProposal(proposal.id)?.status).toBe('audit_reconciliation_required');
    await expect(commit(project, proposal)).rejects.toMatchObject({ code: 'audit_reconciliation_required' });
    expect(deleteOnce).toHaveBeenCalledTimes(1);
  });

  it('returns reconciliation-required for an unobservable post-update outcome without ref repair or audit finalization', async () => {
    const { project, proposal } = await preparedProposal('unobservable-ref');
    const beforeFinalize = vi.spyOn(project.eventLog, 'finalizeOrphanRemovalCommitAudit');
    (project.gitStore as any).orphanRemovalRefUpdateFault = (stage: string) => {
      if (stage === 'after_update_ref') {
        vi.spyOn(project.gitStore, 'getBranchHead').mockResolvedValue(null);
        throw new Error('Injected unobservable outcome');
      }
    };

    const result = await commit(project, proposal);
    expect(result).toMatchObject({ status: 'audit_reconciliation_required', observation: 'head_unavailable', commit: expect.any(String) });
    expect(beforeFinalize).not.toHaveBeenCalled();
    expect(project.eventLog.getOrphanRemovalCommitAudit(proposal.id)).toMatchObject({ state: 'prepared', commit_sha: (result as { commit: string }).commit });
  });

  it('preserves ordinary finalization and treats a finalization failure as reconciliation-required', async () => {
    const ordinary = await preparedProposal('ordinary-success');
    await expect(commit(ordinary.project, ordinary.proposal)).resolves.toMatchObject({ status: 'committed', commit: expect.any(String) });
    expect(ordinary.project.eventLog.getOrphanRemovalCommitAudit(ordinary.proposal.id)).toMatchObject({ state: 'finalized', commit_sha: expect.any(String) });

    const finalizationFailure = await preparedProposal('finalization-failure');
    vi.spyOn(finalizationFailure.project.eventLog, 'finalizeOrphanRemovalCommitAudit').mockImplementation(() => { throw new Error('Injected audit failure'); });
    const result = await commit(finalizationFailure.project, finalizationFailure.proposal);
    expect(result).toMatchObject({ status: 'audit_reconciliation_required', commit: expect.any(String) });
    expect(finalizationFailure.project.eventLog.getOrphanRemovalCommitAudit(finalizationFailure.proposal.id)).toMatchObject({ state: 'prepared', commit_sha: (result as { commit: string }).commit });
  });
});

async function preparedProposal(projectId: string) {
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
  const entry = await project.gitStore.getTreeFileEntry('main', 'docs/atlas/orphan.md');
  const proposal = await proposeOrphanRemoval(project, {
    path: 'docs/atlas/orphan.md', baseRevision: entry!.revision, reason: 'No registration or textual reference remains.',
  });
  return { project, proposal };
}

function commit(project: Project, proposal: Awaited<ReturnType<typeof proposeOrphanRemoval>>) {
  return commitOrphanRemoval(project, {
    proposalId: proposal.id,
    approval: ORPHAN_REMOVAL_APPROVAL,
    reviewDigest: proposal.review_digest,
    actor: 'test-reviewer',
  });
}
