import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../src/mcp/create-server.js';

describe('MCP server metadata', () => {
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

});
