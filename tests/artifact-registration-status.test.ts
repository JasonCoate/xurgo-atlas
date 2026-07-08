import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import YAML from 'yaml';
import { Project } from '../src/core/project.js';
import { createMcpServer } from '../src/mcp/create-server.js';
import { buildHarnessArtifactId } from '../src/core/artifact-registration-proposal.js';
import * as harnessDiscovery from '../src/core/harness-discovery.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-artifact-status-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('atlas.artifact_registration_status', () => {
  it('reports missing artifacts[] as empty and proposes the proposal-only next step', async () => {
    const project = await initProject('artifact-status-empty');
    const before = await snapshotState(project);

    const result = await callTool(project, 'atlas.artifact_registration_status', {
      projectId: project.projectId,
    });

    expect(result.isError).toBeFalsy();
    const status = parseStatus(result);
    expect(status).toMatchObject({
      kind: 'artifact_registration_status',
      schemaVersion: 1,
      project: {
        projectId: project.projectId,
      },
      branch: {
        name: 'main',
        manifestPath: 'docs/manifest.yml',
      },
      status: 'available',
      advisoryOnly: true,
      proposalCapability: {
        toolName: 'atlas.propose_artifact_registration',
        available: true,
        mode: 'proposal_only',
      },
      guardedCommitCapability: {
        toolName: 'atlas.commit_artifact_registration',
        available: true,
        requiresExplicitApproval: true,
      },
      manifest: {
        available: true,
        valid: true,
        artifactCount: 0,
        artifacts: [],
      },
      lookup: {
        status: 'not_requested',
        requested: false,
      },
      nextStep: {
        code: 'propose_registration_first',
      },
    });
    expect(status.readOnlyGuarantees).toEqual(expect.arrayContaining([
      'does_not_create_proposals',
      'does_not_commit_proposals',
      'does_not_write_manifest',
      'does_not_append_artifacts',
      'does_not_modify_documents',
      'does_not_infer_approval',
      'does_not_create_audit_records',
      'does_not_auto_discover_artifacts',
      'does_not_export_docs',
    ]));
    await expectNoMutation(project, before);
  });

  it('returns existing artifacts and lookup matches without creating a proposal', async () => {
    const project = await initProject('artifact-status-registered');
    const entry = expectedAgentsEntry();
    await addArtifactToManagedManifest(project, entry);
    const before = await snapshotState(project);

    const combined = parseStatus(await callTool(project, 'atlas.artifact_registration_status', {
      projectId: project.projectId,
      artifactId: entry.id,
      adapterId: entry.adapterId,
      path: entry.path,
    }));
    expect(combined.manifest.artifactCount).toBe(1);
    expect(combined.manifest.artifacts).toEqual([entry]);
    expect(combined.lookup).toMatchObject({
      status: 'registered',
      requested: true,
      matchCount: 1,
      artifacts: [entry],
    });
    expect(combined.nextStep.code).toBe('review_existing_registration');

    for (const hint of [
      { artifactId: entry.id },
      { adapterId: entry.adapterId },
      { path: entry.path },
    ]) {
      const status = parseStatus(await callTool(project, 'atlas.artifact_registration_status', {
        projectId: project.projectId,
        ...hint,
      }));
      expect(status.lookup.status).toBe('registered');
      expect(status.nextStep.code).toBe('review_existing_registration');
    }

    await expectNoMutation(project, before);
  });

  it('stays advisory-available when root safety is unsafe and does not record root-ledger drift', async () => {
    const project = await initProject('artifact-status-root');
    const before = await snapshotState(project);
    await fs.promises.rm(path.join(tmpDir, '.xurgo-atlas', 'project.json'));

    const result = await callTool(project, 'atlas.artifact_registration_status', {
      projectId: project.projectId,
    });

    expect(result.isError).toBeFalsy();
    const status = parseStatus(result);
    expect(status.status).toBe('read_only_available_root_unsafe');
    expect(status.rootContext.safeForWrites).toBe(false);
    expect(status.rootContext.warnings).toContain('missing local project marker');
    expect(status.nextStep.code).toBe('stay_read_only_resolve_root_safety');
    await expectNoMutation(project, {
      ...before,
      diskManifest: await fs.promises.readFile(path.join(tmpDir, 'docs', 'manifest.yml'), 'utf-8'),
    });
  });

  it('reports unavailable and invalid manifests without proposals, audits, commits, exports, or disk mutation', async () => {
    const unavailableProject = await initProject('artifact-status-unavailable');
    const unavailableBefore = await snapshotState(unavailableProject);
    const unavailable = parseStatus(await callTool(unavailableProject, 'atlas.artifact_registration_status', {
      projectId: unavailableProject.projectId,
      branch: 'missing-managed-branch',
    }));
    expect(unavailable.status).toBe('manifest_unavailable');
    expect(unavailable.manifest).toMatchObject({
      available: false,
      artifactCount: 0,
      artifacts: [],
    });
    expect(unavailable.nextStep.code).toBe('repair_manifest_before_registration');
    await expectNoMutation(unavailableProject, unavailableBefore);

    const invalidProject = unavailableProject;
    const { revision } = await invalidProject.readFile('main', 'docs/manifest.yml');
    expect(revision).toBeTruthy();
    await invalidProject.gitStore.applyAndCommit(
      'main',
      'docs/manifest.yml',
      'documents:\n  - path: [\n',
      'Make test manifest invalid',
      revision!,
    );
    const invalidBefore = await snapshotState(invalidProject);
    const invalid = parseStatus(await callTool(invalidProject, 'atlas.artifact_registration_status', {
      projectId: invalidProject.projectId,
    }));
    expect(invalid.status).toBe('manifest_invalid');
    expect(invalid.manifest).toMatchObject({
      available: true,
      valid: false,
      artifactCount: 0,
      artifacts: [],
    });
    expect(invalid.nextStep.code).toBe('repair_manifest_before_registration');
    await expectNoMutation(invalidProject, invalidBefore);
  });

  it('does not call harness discovery or auto-discover/persist artifact results', async () => {
    const project = await initProject('artifact-status-no-discovery');
    const discoverySpy = vi.spyOn(harnessDiscovery, 'snapshotHarnessDiscovery');
    const before = await snapshotState(project);

    const status = parseStatus(await callTool(project, 'atlas.artifact_registration_status', {
      projectId: project.projectId,
      adapterId: 'atlas.interop.agents-md',
    }));

    expect(status.lookup.status).toBe('not_registered');
    expect(discoverySpy).not.toHaveBeenCalled();
    await expectNoMutation(project, before);
  });

  it('rejects unknown and write-like input fields through the strict read-only schema', async () => {
    const project = await initProject('artifact-status-schema');

    for (const extra of [
      { unknown: true },
      { patch: '--- a/docs/manifest.yml\n' },
      { approval: 'APPROVE_ARTIFACT_REGISTRATION_COMMIT' },
      { entry: expectedAgentsEntry() },
      { manifestPath: 'docs/manifest.yml' },
      { changedFiles: ['docs/manifest.yml'] },
      { status: 'pending' },
      { riskOverride: 'accept' },
    ]) {
      const result = await callTool(project, 'atlas.artifact_registration_status', {
        projectId: project.projectId,
        ...extra,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unrecognized key');
    }
  });
});

async function initProject(projectId: string): Promise<Project> {
  return Project.init({
    projectRoot: tmpDir,
    projectId,
    configDir: path.join(tmpDir, 'config'),
    dataDir: path.join(tmpDir, 'data'),
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

function parseStatus(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text) as Record<string, any>;
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

async function addArtifactToManagedManifest(
  project: Project,
  entry: ReturnType<typeof expectedAgentsEntry>,
) {
  const { content, revision } = await project.readFile('main', 'docs/manifest.yml');
  expect(content).toBeTruthy();
  expect(revision).toBeTruthy();
  const parsed = YAML.parse(content!) as Record<string, unknown>;
  await project.gitStore.applyAndCommit(
    'main',
    'docs/manifest.yml',
    YAML.stringify({
      ...parsed,
      artifacts: [entry],
    }),
    'Register test artifact in manifest',
    revision!,
  );
}

interface StateSnapshot {
  branchHead: string | null;
  managedManifest: string | null;
  diskManifest: string;
  documents: unknown;
  artifactProposalCount: number;
  documentProposalCount: number;
  commitAuditCount: number;
  rootLedgerRows: Array<Record<string, unknown>>;
}

async function snapshotState(project: Project): Promise<StateSnapshot> {
  const managedManifest = await project.gitStore.readFile('main', 'docs/manifest.yml');
  return {
    branchHead: await project.gitStore.getBranchHead('main'),
    managedManifest,
    diskManifest: await fs.promises.readFile(path.join(tmpDir, 'docs', 'manifest.yml'), 'utf-8'),
    documents: parseDocumentsOrNull(managedManifest),
    artifactProposalCount: project.eventLog.listArtifactRegistrationProposals({
      projectId: project.projectId,
      status: 'all',
    }).length,
    documentProposalCount: project.eventLog.listProposals({
      projectId: project.projectId,
      status: 'all',
    }).length,
    commitAuditCount: getTableCount(project, 'artifact_registration_commit_audits'),
    rootLedgerRows: getRootLedgerRows(project),
  };
}

async function expectNoMutation(project: Project, before: StateSnapshot) {
  const managedManifest = await project.gitStore.readFile('main', 'docs/manifest.yml');
  expect(await project.gitStore.getBranchHead('main')).toBe(before.branchHead);
  expect(managedManifest).toBe(before.managedManifest);
  expect(await fs.promises.readFile(path.join(tmpDir, 'docs', 'manifest.yml'), 'utf-8')).toBe(before.diskManifest);
  expect(parseDocumentsOrNull(managedManifest)).toEqual(before.documents);
  expect(project.eventLog.listArtifactRegistrationProposals({
    projectId: project.projectId,
    status: 'all',
  })).toHaveLength(before.artifactProposalCount);
  expect(project.eventLog.listProposals({
    projectId: project.projectId,
    status: 'all',
  })).toHaveLength(before.documentProposalCount);
  expect(getTableCount(project, 'artifact_registration_commit_audits')).toBe(before.commitAuditCount);
  expect(getRootLedgerRows(project)).toEqual(before.rootLedgerRows);
}

function getTableCount(project: Project, tableName: string): number {
  const db = new DatabaseSync(project.storage.projectEventsPath(project.projectId), {
    readOnly: true,
  });
  try {
    const table = db.prepare(
      'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
    ).get('table', tableName) as { name?: string } | undefined;
    if (table?.name !== tableName) {
      return 0;
    }
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function parseDocumentsOrNull(manifest: string | null): unknown {
  if (!manifest) {
    return null;
  }
  try {
    return YAML.parse(manifest).documents;
  } catch {
    return null;
  }
}

function getRootLedgerRows(project: Project): Array<Record<string, unknown>> {
  const db = new DatabaseSync(project.storage.projectEventsPath(project.projectId), {
    readOnly: true,
  });
  try {
    const table = db.prepare(
      'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
    ).get('table', 'root_worktree_ledger') as { name?: string } | undefined;
    if (table?.name !== 'root_worktree_ledger') {
      return [];
    }
    return db.prepare(
      `
      SELECT *
      FROM root_worktree_ledger
      WHERE project_id = ?
      ORDER BY first_seen_at ASC, identity_key ASC
      `,
    ).all(project.projectId) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}
