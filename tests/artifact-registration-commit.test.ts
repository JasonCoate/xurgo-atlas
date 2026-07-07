import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';
import { Project } from '../src/core/project.js';
import { createMcpServer } from '../src/mcp/create-server.js';
import { buildHarnessArtifactId } from '../src/core/artifact-registration-proposal.js';
import * as harnessDiscovery from '../src/core/harness-discovery.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-artifact-commit-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('atlas.commit_artifact_registration', () => {
  it('commits one pending stored artifact registration with durable audit and no disk export', async () => {
    const project = await initProject('artifact-commit-success');
    const proposal = await propose(project);
    const beforeManagedManifest = await project.gitStore.readFile('main', 'docs/manifest.yml');
    const beforeDiskManifest = await fs.promises.readFile(path.join(tmpDir, 'docs', 'manifest.yml'), 'utf-8');
    const beforeDocuments = YAML.parse(beforeManagedManifest!).documents;
    const discoverySpy = vi.spyOn(harnessDiscovery, 'snapshotHarnessDiscovery');
    discoverySpy.mockClear();

    const result = await commit(project, proposal.proposalId);

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      proposalId: proposal.proposalId,
      projectId: project.projectId,
      branch: 'main',
      manifestPath: 'docs/manifest.yml',
      changedFiles: ['docs/manifest.yml'],
      commit: expect.any(String),
      idempotency: 'applied_new',
      actor: 'reviewer',
    });
    expect(payload.artifact).toEqual(expectedAgentsEntry());
    expect(discoverySpy).not.toHaveBeenCalled();

    const afterManagedManifest = await project.gitStore.readFile('main', 'docs/manifest.yml');
    const parsedAfter = YAML.parse(afterManagedManifest!);
    expect(parsedAfter.documents).toEqual(beforeDocuments);
    expect(parsedAfter.artifacts).toEqual([expectedAgentsEntry()]);
    expect(await fs.promises.readFile(path.join(tmpDir, 'docs', 'manifest.yml'), 'utf-8')).toBe(beforeDiskManifest);

    const stored = project.eventLog.getArtifactRegistrationProposal(proposal.proposalId);
    expect(stored?.status).toBe('committed');
    const audit = project.eventLog.getArtifactRegistrationCommitAudit(proposal.proposalId);
    expect(audit).toMatchObject({
      proposal_id: proposal.proposalId,
      state: 'finalized',
      approval: 'APPROVE_ARTIFACT_REGISTRATION_COMMIT',
      actor: 'reviewer',
      project_id: project.projectId,
      branch: 'main',
      manifest_path: 'docs/manifest.yml',
      changed_files: ['docs/manifest.yml'],
      commit_sha: payload.commit,
      resulting_manifest_revision: payload.resultingManifestRevision,
      idempotency_state: 'applied_new',
    });
  });

  it('exposes strict metadata for exactly the proposal and commit artifact-registration tools', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });
    const listTools = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>>;
    })._requestHandlers.get('tools/list')!;

    const result = await listTools({ method: 'tools/list', params: {} });
    const artifactTools = result.tools.filter((tool) => tool.name.includes('artifact'));
    expect(artifactTools.map((tool) => tool.name)).toEqual([
      'atlas.propose_artifact_registration',
      'atlas.commit_artifact_registration',
    ]);
    const commitTool = artifactTools.find((tool) => tool.name === 'atlas.commit_artifact_registration');
    expect(commitTool?.description).toContain('Commit exactly one pending stored artifact_registration proposal');
    expect(commitTool?.description).toContain('does not accept caller-supplied branch');
    expect(commitTool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
        approval: {
          type: 'string',
          enum: ['APPROVE_ARTIFACT_REGISTRATION_COMMIT'],
        },
        actor: { type: 'string' },
        projectId: { type: 'string' },
      },
      required: ['proposalId', 'approval', 'actor', 'projectId'],
      additionalProperties: false,
    });
  });

  it('rejects unknown fields, prohibited write details, wrong approval, and blank actor', async () => {
    const project = await initProject('artifact-commit-schema');
    const proposal = await propose(project);

    for (const extra of [
      { branch: 'main' },
      { path: 'docs/manifest.yml' },
      { manifestPath: 'docs/manifest.yml' },
      { baseRevision: proposal.manifestBaseRevision },
      { patch: proposal.patch },
      { entry: proposal.proposedArtifactEntry },
      { artifactClass: 'instruction_only' },
      { changedFiles: ['docs/manifest.yml'] },
      { status: 'pending' },
      { kind: 'artifact_registration' },
      { riskOverride: 'accept' },
    ]) {
      const result = await commit(project, proposal.proposalId, extra);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unrecognized key');
    }

    const wrongApproval = await commit(project, proposal.proposalId, {
      approval: 'APPROVE',
    });
    expect(wrongApproval.isError).toBe(true);
    expect(wrongApproval.content[0].text).toContain('Invalid literal value');

    const blankActor = await commit(project, proposal.proposalId, {
      actor: '   ',
    });
    expect(blankActor.isError).toBe(true);
    expect(blankActor.content[0].text).toContain('String must contain at least 1 character');
  });

  it('rejects project routing mismatch before audit or managed manifest mutation', async () => {
    const project = await initProject('artifact-commit-routing');
    const proposal = await propose(project);
    const beforeHead = await project.gitStore.getBranchHead('main');

    const result = await commit(project, proposal.proposalId, {
      projectId: 'different-project',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Project routing mismatch');
    expect(project.eventLog.getArtifactRegistrationCommitAudit(proposal.proposalId)).toBeNull();
    expect(project.eventLog.getArtifactRegistrationProposal(proposal.proposalId)?.status).toBe('pending');
    expect(await project.gitStore.getBranchHead('main')).toBe(beforeHead);
  });

  it('root safety refusal blocks before manifest, proposal-status, or audit mutation', async () => {
    const project = await initProject('artifact-commit-root');
    const proposal = await propose(project);
    const beforeHead = await project.gitStore.getBranchHead('main');
    await fs.promises.rm(path.join(tmpDir, '.xurgo-atlas', 'project.json'));

    const result = await commit(project, proposal.proposalId);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ROOT_CONTEXT_UNSAFE');
    expect(project.eventLog.getArtifactRegistrationCommitAudit(proposal.proposalId)).toBeNull();
    expect(project.eventLog.getArtifactRegistrationProposal(proposal.proposalId)?.status).toBe('pending');
    expect(await project.gitStore.getBranchHead('main')).toBe(beforeHead);
  });

  it('rejects stale base before already-applied handling and leaves proposal pending', async () => {
    const project = await initProject('artifact-commit-stale');
    const proposal = await propose(project);
    await project.gitStore.applyPatchAndCommit(
      'main',
      'docs/manifest.yml',
      proposal.patch,
      'Apply artifact outside commit tool',
      proposal.manifestBaseRevision,
    );

    const result = await commit(project, proposal.proposalId);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Stale manifest base');
    expect(project.eventLog.getArtifactRegistrationProposal(proposal.proposalId)?.status).toBe('pending');
    expect(project.eventLog.getArtifactRegistrationCommitAudit(proposal.proposalId)).toBeNull();
  });

  it('returns already-applied read-only when the exact entry is present at the stored base without audit', async () => {
    const project = await initProject('artifact-commit-already-applied');
    const proposal = await propose(project);
    await project.gitStore.applyPatchAndCommit(
      'main',
      'docs/manifest.yml',
      proposal.patch,
      'Apply artifact outside commit tool',
      proposal.manifestBaseRevision,
    );
    const resultingRevision = await project.gitStore.getFileRevision('main', 'docs/manifest.yml');
    const stored = project.eventLog.getArtifactRegistrationProposal(proposal.proposalId)!;
    const payload = {
      ...stored.payload,
      manifestBaseRevision: resultingRevision,
      preview: {
        ...stored.payload.preview,
        manifestBaseRevision: resultingRevision,
      },
    };
    db(project).prepare(`
      UPDATE artifact_registration_proposals
      SET manifest_base_revision = ?, payload_json = ?
      WHERE id = ?
    `).run(resultingRevision, JSON.stringify(payload), proposal.proposalId);
    const beforeHead = await project.gitStore.getBranchHead('main');

    const result = await commit(project, proposal.proposalId);

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      proposalId: proposal.proposalId,
      commit: null,
      idempotency: 'already_applied_without_commit_record',
    });
    expect(project.eventLog.getArtifactRegistrationProposal(proposal.proposalId)?.status).toBe('pending');
    expect(project.eventLog.getArtifactRegistrationCommitAudit(proposal.proposalId)).toBeNull();
    expect(await project.gitStore.getBranchHead('main')).toBe(beforeHead);
  });

  it('returns already_committed from finalized audit and rejects committed proposals without it', async () => {
    const project = await initProject('artifact-commit-idempotent');
    const proposal = await propose(project);
    const first = JSON.parse((await commit(project, proposal.proposalId)).content[0].text);
    const headAfterFirst = await project.gitStore.getBranchHead('main');

    const second = await commit(project, proposal.proposalId);
    expect(second.isError).toBeFalsy();
    expect(JSON.parse(second.content[0].text)).toMatchObject({
      proposalId: proposal.proposalId,
      commit: first.commit,
      idempotency: 'already_committed',
    });
    expect(await project.gitStore.getBranchHead('main')).toBe(headAfterFirst);

    db(project).prepare(
      'DELETE FROM artifact_registration_commit_audits WHERE proposal_id = ?',
    ).run(proposal.proposalId);
    const missingAudit = await commit(project, proposal.proposalId);
    expect(missingAudit.isError).toBe(true);
    expect(missingAudit.content[0].text).toContain('missing finalized audit metadata');
    expect(await project.gitStore.getBranchHead('main')).toBe(headAfterFirst);
  });

  it('preserves prepared audit when final audit persistence fails and blocks retry', async () => {
    const project = await initProject('artifact-commit-final-failure');
    const proposal = await propose(project);
    vi.spyOn(project.eventLog, 'finalizeArtifactRegistrationCommitAudit')
      .mockImplementationOnce(() => {
        throw new Error('simulated final audit persistence failure');
      });

    const first = await commit(project, proposal.proposalId);
    expect(first.isError).toBe(true);
    expect(JSON.parse(first.content[0].text)).toMatchObject({
      proposalId: proposal.proposalId,
      idempotency: 'audit_reconciliation_required',
    });
    expect(project.eventLog.getArtifactRegistrationProposal(proposal.proposalId)?.status).toBe('pending');
    expect(project.eventLog.getArtifactRegistrationCommitAudit(proposal.proposalId)).toMatchObject({
      proposal_id: proposal.proposalId,
      state: 'prepared',
      commit_sha: null,
    });

    const second = await commit(project, proposal.proposalId);
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content[0].text)).toMatchObject({
      proposalId: proposal.proposalId,
      idempotency: 'audit_reconciliation_required',
    });
  });

  it('rejects malformed and mismatched stored bindings without audit or commit', async () => {
    for (const [name, mutate, expected] of [
      ['wrong kind', (p: Project, id: string) => db(p).prepare('UPDATE artifact_registration_proposals SET kind = ? WHERE id = ?').run('document_patch', id), 'stored kind'],
      ['unsupported schema', (p: Project, id: string) => db(p).prepare('UPDATE artifact_registration_proposals SET schema_version = ? WHERE id = ?').run(2, id), 'schema version'],
      ['root mismatch', (p: Project, id: string) => db(p).prepare('UPDATE artifact_registration_proposals SET canonical_project_root = ? WHERE id = ?').run('/tmp/not-this-root', id), 'canonical root'],
      ['branch mismatch', (p: Project, id: string) => db(p).prepare('UPDATE artifact_registration_proposals SET branch = ? WHERE id = ?').run('feature', id), 'fixed branch'],
      ['manifest mismatch', (p: Project, id: string) => db(p).prepare('UPDATE artifact_registration_proposals SET manifest_path = ? WHERE id = ?').run('docs/other.yml', id), 'manifest target'],
      ['changed files mismatch', (p: Project, id: string) => db(p).prepare('UPDATE artifact_registration_proposals SET changed_files_json = ? WHERE id = ?').run(JSON.stringify(['docs/manifest.yml', 'AGENTS.md']), id), 'changed files'],
      ['entry mismatch', (p: Project, id: string) => {
        const stored = p.eventLog.getArtifactRegistrationProposal(id)!;
        db(p).prepare('UPDATE artifact_registration_proposals SET proposed_entry_json = ? WHERE id = ?')
          .run(JSON.stringify({ ...stored.proposed_entry, adapterId: 'other.adapter' }), id);
      }, 'descriptor identity'],
      ['patch mismatch', (p: Project, id: string) => db(p).prepare('UPDATE artifact_registration_proposals SET patch = ? WHERE id = ?').run('--- a/docs/manifest.yml\n+++ b/docs/manifest.yml\n@@ -1,1 +1,1 @@\n-version: 1\n+version: 1\n', id), 'patch'],
      ['prohibited implication mismatch', (p: Project, id: string) => db(p).prepare('UPDATE artifact_registration_proposals SET prohibited_implications_json = ? WHERE id = ?').run(JSON.stringify(['approval']), id), 'prohibited implications'],
    ] as const) {
      const caseRoot = path.join(tmpDir, name.replace(/\W/g, '-'));
      await fs.promises.mkdir(caseRoot, { recursive: true });
      const project = await initProject(
        `artifact-commit-bad-${name.replace(/\W/g, '-')}`,
        caseRoot,
      );
      const proposal = await propose(project);
      const beforeHead = await project.gitStore.getBranchHead('main');
      mutate(project, proposal.proposalId);

      const result = await commit(project, proposal.proposalId);

      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toContain(expected);
      expect(project.eventLog.getArtifactRegistrationCommitAudit(proposal.proposalId), name).toBeNull();
      expect(await project.gitStore.getBranchHead('main'), name).toBe(beforeHead);
    }
  });
});

async function initProject(projectId: string, projectRoot = tmpDir): Promise<Project> {
  return Project.init({
    projectRoot,
    projectId,
    configDir: path.join(projectRoot, 'config'),
    dataDir: path.join(projectRoot, 'data'),
  });
}

async function propose(project: Project): Promise<Record<string, any>> {
  const result = await callTool(project, 'atlas.propose_artifact_registration', {
    adapterId: 'atlas.interop.agents-md',
  });
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

async function commit(
  project: Project,
  proposalId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  return callTool(project, 'atlas.commit_artifact_registration', {
    proposalId,
    approval: 'APPROVE_ARTIFACT_REGISTRATION_COMMIT',
    actor: 'reviewer',
    projectId: project.projectId,
    ...overrides,
  });
}

async function callTool(
  project: Project,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  const server = createMcpServer(project);
  const handlers = (server as unknown as {
    _requestHandlers: Map<string, (request: unknown) => Promise<unknown>>;
  })._requestHandlers;
  const call = handlers.get('tools/call');
  expect(call).toBeTypeOf('function');
  return await call!({
    method: 'tools/call',
    params: {
      name,
      arguments: args,
    },
  }) as { content: Array<{ text: string }>; isError?: boolean };
}

function expectedAgentsEntry() {
  return {
    id: buildHarnessArtifactId({
      adapterId: 'atlas.interop.agents-md',
      toolNativeRootId: 'agents_md_interoperability',
      projectRelativePath: 'AGENTS.md',
      artifactClass: 'instruction_only',
      capabilityTier: 'discover_only',
    }),
    kind: 'harness',
    adapterId: 'atlas.interop.agents-md',
    toolNativeRootId: 'agents_md_interoperability',
    path: 'AGENTS.md',
    role: 'harness',
    artifactClass: 'instruction_only',
    capabilityTier: 'discover_only',
  };
}

function db(project: Project) {
  return (project.eventLog as unknown as {
    db: {
      prepare: (sql: string) => {
        run: (...args: unknown[]) => unknown;
      };
    };
  }).db;
}
