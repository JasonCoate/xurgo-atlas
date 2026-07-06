import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Project } from '../src/core/project.js';
import { createMcpServer } from '../src/mcp/create-server.js';
import { buildHarnessArtifactId } from '../src/core/artifact-registration-proposal.js';
import * as harnessDiscovery from '../src/core/harness-discovery.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-artifact-registration-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('atlas.propose_artifact_registration', () => {
  it('stores a review-only typed harness artifact proposal without changing docs/manifest.yml or document proposals', async () => {
    const project = await initProject('artifact-proposal');
    const beforeManagedManifest = await project.gitStore.readFile('main', 'docs/manifest.yml');
    const beforeDiskManifest = await fs.promises.readFile(path.join(tmpDir, 'docs', 'manifest.yml'), 'utf-8');

    const result = await callTool(project, 'atlas.propose_artifact_registration', {
      adapterId: 'atlas.interop.agents-md',
    });

    expect(result.isError).toBeFalsy();
    const proposal = JSON.parse(result.content[0].text);
    const expectedEntry = {
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

    expect(proposal).toMatchObject({
      proposalId: expect.stringMatching(/^artreg_/),
      kind: 'artifact_registration',
      schemaVersion: 1,
      projectId: 'artifact-proposal',
      branch: 'main',
      descriptor: {
        adapterId: 'atlas.interop.agents-md',
        discoveryStatus: 'present',
        present: true,
        projectRelativePath: 'AGENTS.md',
        toolNativeRootId: 'agents_md_interoperability',
        artifactClass: 'instruction_only',
        capabilityTier: 'discover_only',
        source: 'harness_discovery_catalog',
      },
      canonicalProjectRoot: await fs.promises.realpath(tmpDir),
      projectRelativePath: 'AGENTS.md',
      manifestPath: 'docs/manifest.yml',
      manifestBaseRevision: expect.any(String),
      proposedArtifactEntry: expectedEntry,
      changedFiles: ['docs/manifest.yml'],
      status: 'pending',
      staleBase: false,
      approvalEstablished: false,
      commitAuthorized: false,
      preview: {
        status: 'review_only',
        manifestBaseRevision: expect.any(String),
        staleBase: false,
      },
    });
    expect(proposal.prohibitedImplications).toEqual(
      expect.arrayContaining([
        'approval',
        'manifest write',
        'artifact activation',
        'commit authority',
      ]),
    );
    expect(proposal.nextStep).toContain('Review this proposal');
    expect(proposal.nextStep).toContain('not approval');
    expect(proposal.nextStep).toContain('not a manifest write');
    expect(proposal.nextStep).toContain('not artifact activation');
    expect(proposal.nextStep).toContain('not commit authority');
    expect(proposal.patch).toContain('+++ b/docs/manifest.yml');
    expect(proposal.patch).toContain('+artifacts:');
    expect(proposal.patch).toContain('+  - id: ' + expectedEntry.id);

    const storedArtifacts = project.eventLog.listArtifactRegistrationProposals({
      projectId: project.projectId,
      status: 'pending',
    });
    expect(storedArtifacts).toHaveLength(1);
    expect(storedArtifacts[0]).toMatchObject({
      id: proposal.proposalId,
      kind: 'artifact_registration',
      schema_version: 1,
      adapter_id: 'atlas.interop.agents-md',
      manifest_path: 'docs/manifest.yml',
      manifest_base_revision: proposal.manifestBaseRevision,
      approval_established: false,
      commit_authorized: false,
      proposed_entry: expectedEntry,
      changed_files: ['docs/manifest.yml'],
      patch: proposal.patch,
      payload: proposal,
    });

    expect(project.eventLog.listProposals({
      projectId: project.projectId,
      status: 'all',
    })).toEqual([]);
    const listResult = await callTool(project, 'docs.list_proposals', {
      projectId: project.projectId,
      status: 'all',
    });
    expect(JSON.parse(listResult.content[0].text).proposalCount).toBe(0);
    expect(await project.gitStore.readFile('main', 'docs/manifest.yml')).toBe(beforeManagedManifest);
    expect(await fs.promises.readFile(path.join(tmpDir, 'docs', 'manifest.yml'), 'utf-8')).toBe(beforeDiskManifest);
  });

  it('keeps manifests without artifacts[] valid and exposes artifacts separately when present', async () => {
    const project = await initProject('manifest-artifacts');

    const initialManifest = await callTool(project, 'docs.manifest', {
      projectId: project.projectId,
      branch: 'main',
    });
    const initial = JSON.parse(initialManifest.content[0].text);
    expect(initial.documentCount).toBeGreaterThan(0);
    expect(initial.artifacts).toEqual([]);
    expect(initial.artifactCount).toBe(0);

    const { content, revision } = await project.readFile('main', 'docs/manifest.yml');
    expect(content).toBeTruthy();
    expect(revision).toBeTruthy();
    const entry = {
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
    await project.gitStore.applyAndCommit(
      'main',
      'docs/manifest.yml',
      `${content!}\nartifacts:\n  - id: ${entry.id}\n    kind: harness\n    adapterId: atlas.interop.agents-md\n    toolNativeRootId: agents_md_interoperability\n    path: AGENTS.md\n    role: harness\n    artifactClass: instruction_only\n    capabilityTier: discover_only\n`,
      'Add test artifact manifest entry',
      revision!,
    );

    const withArtifactResult = await callTool(project, 'docs.manifest', {
      projectId: project.projectId,
      branch: 'main',
    });
    const withArtifact = JSON.parse(withArtifactResult.content[0].text);
    expect(withArtifact.documentCount).toBe(initial.documentCount);
    expect(withArtifact.artifacts).toEqual([entry]);
    expect(withArtifact.artifactCount).toBe(1);
  });

  it('rejects unknown, absent, ambiguous, unsafe, and already-registered descriptors', async () => {
    const project = await initProject('artifact-rejections');

    const unknown = await callTool(project, 'atlas.propose_artifact_registration', {
      adapterId: 'unknown.adapter',
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('Unknown harness descriptor');

    const absent = await callTool(project, 'atlas.propose_artifact_registration', {
      adapterId: 'anthropic.claude-code',
    });
    expect(absent.isError).toBe(true);
    expect(absent.content[0].text).toContain('is absent');

    vi.spyOn(harnessDiscovery, 'snapshotHarnessDiscovery').mockResolvedValueOnce({
      descriptors: [
        presentAgentsDescriptor(),
        presentAgentsDescriptor(),
      ],
    });
    const ambiguous = await callTool(project, 'atlas.propose_artifact_registration', {
      adapterId: 'atlas.interop.agents-md',
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain('Ambiguous harness descriptor');

    const outside = path.join(tmpDir, '..', `outside-${Date.now()}.md`);
    await fs.promises.writeFile(outside, '# outside\n', 'utf-8');
    await fs.promises.rm(path.join(tmpDir, 'AGENTS.md'));
    await fs.promises.symlink(outside, path.join(tmpDir, 'AGENTS.md'));
    const unsafe = await callTool(project, 'atlas.propose_artifact_registration', {
      adapterId: 'atlas.interop.agents-md',
    });
    expect(unsafe.isError).toBe(true);
    expect(unsafe.content[0].text).toContain('resolves outside the project root');
    await fs.promises.rm(outside, { force: true });

    await fs.promises.rm(path.join(tmpDir, 'AGENTS.md'));
    await fs.promises.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Agent Instructions\n', 'utf-8');
    const first = await callTool(project, 'atlas.propose_artifact_registration', {
      adapterId: 'atlas.interop.agents-md',
    });
    expect(first.isError).toBeFalsy();
    const stored = project.eventLog.getArtifactRegistrationProposal(JSON.parse(first.content[0].text).proposalId);
    const { content, revision } = await project.readFile('main', 'docs/manifest.yml');
    expect(content).toBeTruthy();
    await project.gitStore.applyAndCommit(
      'main',
      'docs/manifest.yml',
      `${content!}\nartifacts:\n  - id: ${(stored!.proposed_entry as { id: string }).id}\n    kind: harness\n    adapterId: atlas.interop.agents-md\n    toolNativeRootId: agents_md_interoperability\n    path: AGENTS.md\n    role: harness\n    artifactClass: instruction_only\n    capabilityTier: discover_only\n`,
      'Register artifact in test manifest',
      revision!,
    );
    const duplicate = await callTool(project, 'atlas.propose_artifact_registration', {
      adapterId: 'atlas.interop.agents-md',
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0].text).toContain('already contains an artifacts[] entry');
  });

  it('rejects stale manifest base evidence before storing a proposal', async () => {
    const project = await initProject('artifact-stale');
    const manifestRevision = await project.gitStore.getFileRevision('main', 'docs/manifest.yml');
    expect(manifestRevision).toBeTruthy();
    const revisionSpy = vi.spyOn(project.gitStore, 'getFileRevision');
    revisionSpy.mockImplementation(async (branch: string, filePath: string) => {
      if (branch === 'main' && filePath === 'docs/manifest.yml') {
        return revisionSpy.mock.calls.filter(
          ([calledBranch, calledPath]) =>
            calledBranch === 'main' && calledPath === 'docs/manifest.yml',
        ).length === 1
          ? manifestRevision
          : 'changed-manifest-revision';
      }
      return manifestRevision;
    });

    const stale = await callTool(project, 'atlas.propose_artifact_registration', {
      adapterId: 'atlas.interop.agents-md',
    });

    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toContain('Stale manifest base');
    expect(project.eventLog.listArtifactRegistrationProposals({
      projectId: project.projectId,
      status: 'all',
    })).toEqual([]);
  });

  it('rejects caller-supplied path, root, patch, classification, approval, and commit authority fields', async () => {
    const project = await initProject('artifact-schema');
    for (const extra of [
      { path: 'AGENTS.md' },
      { projectRoot: tmpDir },
      { patch: '--- a/docs/manifest.yml\n' },
      { artifactClass: 'instruction_only' },
      { capabilityTier: 'discover_only' },
      { approvalEstablished: true },
      { commitAuthorized: true },
    ]) {
      const result = await callTool(project, 'atlas.propose_artifact_registration', {
        adapterId: 'atlas.interop.agents-md',
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

function presentAgentsDescriptor(): harnessDiscovery.HarnessDiscoveryDescriptor {
  return {
    adapterId: 'atlas.interop.agents-md',
    artifactClass: 'instruction_only',
    capabilityTier: 'discover_only',
    discoveryStatus: 'present',
    present: true,
    projectRelativePath: 'AGENTS.md',
    toolNativeRootId: 'agents_md_interoperability',
  };
}
