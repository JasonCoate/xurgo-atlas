import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { Project } from '../src/core/project.js';
import { commitOrphanRemoval, orphanRemovalStatus, ORPHAN_REMOVAL_APPROVAL, proposeOrphanRemoval } from '../src/core/orphan-removal-proposal.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-orphan-status-'));
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

describe('orphan removal status observations', () => {
  it('reports not_applied only for the exact reviewed branch blob', async () => {
    const { project, proposal } = await preparedProposal('not-applied');
    const result = await orphanRemovalStatus(project, proposal.id);
    expect(result.observation).toMatchObject({ classification: 'not_applied', targetPresent: true, readOnly: true, retriesPerformed: false });
    expect(project.eventLog.getOrphanRemovalProposal(proposal.id)?.status).toBe('pending_review');
  });

  it('reports matching_commit only after proving the exact one-file reviewed deletion commit', async () => {
    const { project, proposal } = await preparedProposal('matching');
    await commit(project, proposal);
    const result = await orphanRemovalStatus(project, proposal.id);
    expect(result.observation).toMatchObject({ classification: 'matching_commit', targetPresent: false });
  });

  it('reports an exact applied deletion while retaining reconciliation-required audit state', async () => {
    const { project, proposal } = await preparedProposal('reconciliation-match');
    (project.gitStore as any).orphanRemovalRefUpdateFault = (stage: string) => {
      if (stage === 'after_update_ref') throw new Error('Injected post-update failure');
    };
    const commitResult = await commitOrphanRemoval(project, {
      proposalId: proposal.id,
      approval: ORPHAN_REMOVAL_APPROVAL,
      reviewDigest: proposal.review_digest,
      actor: 'test-reviewer',
    });
    expect(commitResult).toMatchObject({ status: 'audit_reconciliation_required', commit: expect.any(String) });

    const result = await orphanRemovalStatus(project, proposal.id);
    expect(result.status).toBe('audit_reconciliation_required');
    expect(result.audit).toMatchObject({ state: 'prepared', commit_sha: (commitResult as { commit: string }).commit });
    expect(result.observation).toMatchObject({ classification: 'matching_commit', targetPresent: false, readOnly: true, retriesPerformed: false });
  });

  it('reports diverged for branch advancement and when target absence has no audit proof', async () => {
    const advanced = await preparedProposal('advanced');
    await advanced.project.gitStore.applyAndCommit('main', 'notes.txt', 'unrelated\n', 'Advance managed branch');
    expect((await orphanRemovalStatus(advanced.project, advanced.proposal.id)).observation.classification).toBe('diverged');

    const absent = await preparedProposal('absence');
    await absent.project.gitStore.commitOneFileDeletionLocal('main', absent.proposal.target_path, absent.proposal.branch_head, absent.proposal.base_revision, 'Manual deletion without audit');
    expect((await orphanRemovalStatus(absent.project, absent.proposal.id)).observation).toMatchObject({ classification: 'diverged', targetPresent: false });
  });

  it('requires exact parent and raw deletion evidence rather than trusting an audit SHA', async () => {
    const { project, proposal } = await preparedProposal('exactness');
    await commit(project, proposal);
    vi.spyOn(project.gitStore, 'observeSingleCommitParent').mockResolvedValue('not-the-reviewed-head');
    expect((await orphanRemovalStatus(project, proposal.id)).observation.classification).toBe('diverged');

    vi.restoreAllMocks();
    vi.spyOn(project.gitStore, 'observeCommitFileChanges').mockResolvedValue([]);
    expect((await orphanRemovalStatus(project, proposal.id)).observation.classification).toBe('diverged');
  });

  it('reports unavailable for an unreadable required Git observation', async () => {
    const { project, proposal } = await preparedProposal('unavailable');
    vi.spyOn(project.gitStore, 'getBranchHead').mockResolvedValue(null);
    const result = await orphanRemovalStatus(project, proposal.id);
    expect(result.observation).toMatchObject({ classification: 'unavailable', targetPresent: null });
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

async function commit(project: Project, proposal: Awaited<ReturnType<typeof proposeOrphanRemoval>>) {
  const result = await commitOrphanRemoval(project, {
    proposalId: proposal.id,
    approval: ORPHAN_REMOVAL_APPROVAL,
    reviewDigest: proposal.review_digest,
    actor: 'test-reviewer',
  });
  expect(result.status).toBe('committed');
}
