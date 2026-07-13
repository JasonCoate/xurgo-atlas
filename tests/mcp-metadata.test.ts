import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { createMcpServer } from '../src/mcp/create-server.js';
import { Project } from '../src/core/project.js';
import { proposeOrphanRemoval } from '../src/core/orphan-removal-proposal.js';

let orphanRoutingTmpDir: string;

describe('MCP server metadata', () => {
  it('registers the dedicated guarded orphan-removal family', async () => {
    const server = createMcpServer(async () => { throw new Error('not used'); });
    const handlers = (server as any)._requestHandlers as Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>>;
    const result = await handlers.get('tools/list')!({ method: 'tools/list', params: {} });
    for (const name of ['docs.propose_orphan_removal', 'docs.preview_orphan_removal', 'docs.commit_orphan_removal', 'docs.orphan_removal_status']) {
      expect(result.tools.find((tool) => tool.name === name)).toBeDefined();
    }
    expect(result.tools.find((tool) => tool.name === 'docs.orphan_removal_status')?.description).toContain('matching_commit');
    expect(result.tools.find((tool) => tool.name === 'docs.commit_orphan_removal')?.inputSchema).toMatchObject({
      required: ['projectId', 'proposalId', 'approval', 'reviewDigest', 'actor'],
    });
  });

  it('defaults the server name to Xurgo Atlas', () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    expect((server as unknown as { _serverInfo?: { name?: string } })._serverInfo?.name).toBe('Xurgo Atlas');
  });

  it('registers docs.preview_diff in tools/list', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }>>;
    })._requestHandlers;
    const listTools = handlers.get('tools/list');

    expect(listTools).toBeTypeOf('function');

    const result = await listTools!({
      method: 'tools/list',
      params: {},
    });
    const previewTool = result.tools.find((tool) => tool.name === 'docs.preview_diff');

    expect(previewTool).toBeDefined();
    expect(previewTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['projectId', 'proposalId'],
    });
  });

  it('registers docs.preview_export in tools/list', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }>>;
    })._requestHandlers;
    const listTools = handlers.get('tools/list');

    expect(listTools).toBeTypeOf('function');

    const result = await listTools!({
      method: 'tools/list',
      params: {},
    });
    const previewExportTool = result.tools.find((tool) => tool.name === 'docs.preview_export');

    expect(previewExportTool).toBeDefined();
    expect(previewExportTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['projectId'],
      properties: {
        branch: { type: 'string' },
        targetDir: { type: 'string' },
      },
    });
  });

  it('registers docs.list_proposals in tools/list', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }>>;
    })._requestHandlers;
    const listTools = handlers.get('tools/list');

    expect(listTools).toBeTypeOf('function');

    const result = await listTools!({
      method: 'tools/list',
      params: {},
    });
    const listProposalsTool = result.tools.find((tool) => tool.name === 'docs.list_proposals');

    expect(listProposalsTool).toBeDefined();
    expect(listProposalsTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['projectId'],
      properties: {
        status: {
          enum: ['pending', 'committed', 'discarded', 'all'],
        },
      },
    });
  });

  it('registers docs.discard_proposal in tools/list', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }>>;
    })._requestHandlers;
    const listTools = handlers.get('tools/list');

    expect(listTools).toBeTypeOf('function');

    const result = await listTools!({
      method: 'tools/list',
      params: {},
    });
    const discardProposalTool = result.tools.find((tool) => tool.name === 'docs.discard_proposal');

    expect(discardProposalTool).toBeDefined();
    expect(discardProposalTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['projectId', 'proposalId'],
    });
  });

  it('registers docs.propose_patch with unified-diff guidance in tools/list', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>>;
    })._requestHandlers;
    const listTools = handlers.get('tools/list');

    expect(listTools).toBeTypeOf('function');

    const result = await listTools!({
      method: 'tools/list',
      params: {},
    });
    const proposePatchTool = result.tools.find((tool) => tool.name === 'docs.propose_patch');

    expect(proposePatchTool).toBeDefined();
    expect(proposePatchTool?.description).toContain('standard unified diff');
    expect(proposePatchTool?.description).toContain('*** Begin Patch');
    expect(proposePatchTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['projectId', 'branch', 'path', 'baseRevision', 'patch', 'intent', 'summary'],
      properties: {
        patch: {
          type: 'string',
          description: expect.stringContaining('Standard unified diff patch text only.'),
        },
      },
    });
  });

  it('registers docs.propose_document in tools/list', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }>>;
    })._requestHandlers;
    const listTools = handlers.get('tools/list');

    expect(listTools).toBeTypeOf('function');

    const result = await listTools!({
      method: 'tools/list',
      params: {},
    });
    const proposeDocumentTool = result.tools.find((tool) => tool.name === 'docs.propose_document');

    expect(proposeDocumentTool).toBeDefined();
    expect(proposeDocumentTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['projectId', 'mode', 'path', 'content', 'document', 'intent', 'summary'],
      properties: {
        mode: { enum: ['create'] },
        document: {
          type: 'object',
          required: ['role', 'summary'],
        },
      },
    });
  });

  it('registers docs.search in tools/list', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>>;
    })._requestHandlers;
    const listTools = handlers.get('tools/list');

    expect(listTools).toBeTypeOf('function');

    const result = await listTools!({
      method: 'tools/list',
      params: {},
    });
    const searchTool = result.tools.find((tool) => tool.name === 'docs.search');

    expect(searchTool).toBeDefined();
    expect(searchTool?.description).toContain('local SQLite FTS');
    expect(searchTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['projectId', 'query'],
      properties: {
        branch: { type: 'string' },
        limit: { type: 'number' },
      },
    });
  });

  it('registers docs.capabilities and returns a read-only capability summary', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools?: Array<{ name: string; inputSchema: unknown }> ; content?: Array<{ text: string }> }>>;
    })._requestHandlers;
    const listTools = handlers.get('tools/list');
    const callTool = handlers.get('tools/call');

    expect(listTools).toBeTypeOf('function');
    expect(callTool).toBeTypeOf('function');

    const listed = await listTools!({
      method: 'tools/list',
      params: {},
    });
    const capabilitiesTool = listed.tools.find((tool) => tool.name === 'docs.capabilities');

    expect(capabilitiesTool).toBeDefined();
    expect(capabilitiesTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {},
    });

    const result = await callTool!({
      method: 'tools/call',
      params: {
        name: 'docs.capabilities',
        arguments: {},
      },
    });

    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
        },
      ],
    });

    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({
      service: 'xurgo-atlas',
      capabilitiesVersion: 1,
      scope: {
        managedDocsOnly: true,
        projectContextOnly: true,
      },
      tools: {
        status: true,
        manifest: true,
        read: true,
        readSection: true,
        contextPack: true,
        projectIdentity: true,
        guardedWrites: true,
        exportPreview: true,
        proposalCleanup: true,
        search: true,
        semanticSearch: false,
      },
      retrieval: {
        lexical: {
          available: true,
          plannedTool: 'docs.search',
          plannedBackend: 'sqlite-fts',
          scope: 'atlas-managed-docs',
        },
        semantic: {
          available: false,
          plannedTool: 'docs.semantic_search',
          plannedBackend: 'optional-local-sqlite-vector-extension',
          required: false,
        },
        externalVectorDatabaseDefault: false,
      },
    });
  });

  it('registers atlas read-only tools in tools/list', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>>;
    })._requestHandlers;
    const listTools = handlers.get('tools/list');

    expect(listTools).toBeTypeOf('function');

    const result = await listTools!({
      method: 'tools/list',
      params: {},
    });
    const projectIdentityTool = result.tools.find((tool) => tool.name === 'atlas.project_identity');
    const registrationProposalTool = result.tools.find((tool) => tool.name === 'atlas.project_registration_proposal');
    const managedStateProvenanceTool = result.tools.find((tool) => tool.name === 'atlas.managed_state_provenance');
    const projectRootsTool = result.tools.find((tool) => tool.name === 'atlas.project_roots');
    const lockStatusTool = result.tools.find((tool) => tool.name === 'atlas.lock_status');
    const atlasToolNames = result.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('atlas.'));

    expect(projectIdentityTool).toBeDefined();
    expect(registrationProposalTool).toBeDefined();
    expect(managedStateProvenanceTool).toBeUndefined();
    expect(projectRootsTool).toBeUndefined();
    expect(lockStatusTool).toBeUndefined();
    expect(atlasToolNames).toEqual([
      'atlas.project_identity',
      'atlas.project_registration_proposal',
      'atlas.propose_artifact_registration',
      'atlas.artifact_registration_status',
      'atlas.commit_artifact_registration',
    ]);
    expect(projectIdentityTool?.description).toContain('read-only runtime identity');
    expect(projectIdentityTool?.description).toContain('mcp-config --json');
    expect(projectIdentityTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        projectId: { type: 'string' },
      },
    });
    expect(registrationProposalTool?.description).toContain('ephemeral diagnostic-only');
    expect(registrationProposalTool?.description).toContain('does not register');
    expect(registrationProposalTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        projectRoot: { type: 'string' },
        cwd: { type: 'string' },
        configDir: { type: 'string' },
        dataDir: { type: 'string' },
      },
    });
  });

  it('registers only the bounded artifact registration proposal, status, and commit tools', async () => {
    const server = createMcpServer(async () => {
      throw new Error('not used');
    });

    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>>;
    })._requestHandlers;
    const listTools = handlers.get('tools/list');

    expect(listTools).toBeTypeOf('function');

    const result = await listTools!({
      method: 'tools/list',
      params: {},
    });
    const artifactToolNames = result.tools
      .map((tool) => tool.name)
      .filter((name) => name.includes('artifact'));
    const proposalTool = result.tools.find(
      (tool) => tool.name === 'atlas.propose_artifact_registration',
    );
    const commitTool = result.tools.find(
      (tool) => tool.name === 'atlas.commit_artifact_registration',
    );
    const statusTool = result.tools.find(
      (tool) => tool.name === 'atlas.artifact_registration_status',
    );

    expect(artifactToolNames).toEqual([
      'atlas.propose_artifact_registration',
      'atlas.artifact_registration_status',
      'atlas.commit_artifact_registration',
    ]);
    expect(proposalTool).toBeDefined();
    expect(proposalTool?.description).toContain('review-only');
    expect(proposalTool?.description).toContain('does not approve');
    expect(proposalTool?.description).toContain('write the manifest');
    expect(proposalTool?.description).toContain('activate artifacts');
    expect(proposalTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['adapterId'],
      properties: {
        adapterId: { type: 'string' },
      },
    });
    expect(Object.keys((proposalTool?.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual([
      'adapterId',
    ]);
    expect(statusTool).toBeDefined();
    expect(statusTool?.description).toContain('Read-only advisory status');
    expect(statusTool?.description).toContain('does not create proposals');
    expect(statusTool?.description).toContain('write the manifest');
    expect(statusTool?.description).toContain('discover artifacts');
    expect(statusTool?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string' },
        branch: { type: 'string' },
        artifactId: { type: 'string' },
        adapterId: { type: 'string' },
        path: { type: 'string' },
      },
    });
    expect(Object.keys((statusTool?.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual([
      'projectId',
      'branch',
      'artifactId',
      'adapterId',
      'path',
    ]);
    expect(commitTool).toBeDefined();
    expect(commitTool?.description).toContain('Commit exactly one pending stored artifact_registration proposal');
    expect(commitTool?.description).toContain('does not accept caller-supplied branch');
    expect(commitTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['proposalId', 'approval', 'actor', 'projectId'],
      additionalProperties: false,
      properties: {
        proposalId: { type: 'string' },
        approval: {
          type: 'string',
          enum: ['APPROVE_ARTIFACT_REGISTRATION_COMMIT'],
        },
        actor: { type: 'string' },
        projectId: { type: 'string' },
      },
    });
  });

});

describe('guarded orphan-removal MCP routing', () => {
  beforeEach(async () => {
    orphanRoutingTmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-orphan-routing-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(orphanRoutingTmpDir, { recursive: true, force: true });
  });

  it('refuses unsafe proposal roots before proposal storage and rejects caller bypass fields', async () => {
    const project = await orphanRoutingProject('proposal-root');
    const target = await project.gitStore.getTreeFileEntry('main', 'docs/atlas/orphan.md');
    const beforeHead = await project.gitStore.getBranchHead('main');
    const storeProposal = vi.spyOn(project.eventLog, 'storeOrphanRemovalProposal');
    await fs.promises.rm(path.join(project.root, '.xurgo-atlas', 'project.json'));

    const refused = await callOrphanTool(project, 'docs.propose_orphan_removal', {
      projectId: project.projectId, path: 'docs/atlas/orphan.md', baseRevision: target!.revision, reason: 'No managed registration or references remain.',
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('ROOT_CONTEXT_UNSAFE');
    expect(storeProposal).not.toHaveBeenCalled();
    expect(await project.gitStore.getBranchHead('main')).toBe(beforeHead);
    expect(await project.gitStore.getTreeFileEntry('main', 'docs/atlas/orphan.md')).toEqual(target);

    const bypass = await callOrphanTool(project, 'docs.propose_orphan_removal', {
      projectId: project.projectId, path: 'docs/atlas/orphan.md', baseRevision: target!.revision, reason: 'No managed registration or references remain.', projectRoot: project.root, riskOverride: true,
    });
    expect(bypass.isError).toBe(true);
    expect(bypass.content[0].text).toContain('Unrecognized key');
  });

  it('refuses unsafe commit roots before prepared audit or Git mutation', async () => {
    const project = await orphanRoutingProject('commit-root');
    const target = await project.gitStore.getTreeFileEntry('main', 'docs/atlas/orphan.md');
    const proposal = await proposeOrphanRemoval(project, {
      path: 'docs/atlas/orphan.md', baseRevision: target!.revision, reason: 'No managed registration or references remain.',
    });
    const beforeHead = await project.gitStore.getBranchHead('main');
    const prepareAudit = vi.spyOn(project.eventLog, 'prepareOrphanRemovalCommitAudit');
    const remove = vi.spyOn(project.gitStore, 'commitOneFileDeletionLocal');
    await fs.promises.rm(path.join(project.root, '.xurgo-atlas', 'project.json'));

    const refused = await callOrphanTool(project, 'docs.commit_orphan_removal', {
      projectId: project.projectId, proposalId: proposal.id, approval: 'APPROVE_ORPHAN_REMOVAL', reviewDigest: proposal.review_digest, actor: 'test-reviewer',
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('ROOT_CONTEXT_UNSAFE');
    expect(prepareAudit).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(project.eventLog.getOrphanRemovalCommitAudit(proposal.id)).toBeNull();
    expect(await project.gitStore.getBranchHead('main')).toBe(beforeHead);
    expect(await project.gitStore.getTreeFileEntry('main', 'docs/atlas/orphan.md')).toEqual(target);
  });
});

async function orphanRoutingProject(projectId: string): Promise<Project> {
  const projectRoot = path.join(orphanRoutingTmpDir, projectId);
  await fs.promises.mkdir(projectRoot, { recursive: true });
  const git = simpleGit({ baseDir: projectRoot });
  await git.init();
  await git.raw(['config', 'user.name', 'Test Reviewer']);
  await git.raw(['config', 'user.email', 'test@example.invalid']);
  await git.raw(['commit', '--allow-empty', '-m', 'Establish source identity']);
  const project = await Project.init({ projectRoot, projectId, configDir: path.join(projectRoot, 'config'), dataDir: path.join(projectRoot, 'data') });
  await project.gitStore.applyAndCommit('main', 'docs/atlas/orphan.md', '# orphan\n', 'Add orphan candidate');
  return project;
}

async function callOrphanTool(project: Project, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  const server = createMcpServer(project);
  const handlers = (server as unknown as { _requestHandlers: Map<string, (request: unknown) => Promise<unknown>> })._requestHandlers;
  return await handlers.get('tools/call')!({ method: 'tools/call', params: { name, arguments: args } }) as { content: Array<{ text: string }>; isError?: boolean };
}
