import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Project } from '../src/core/project.js';
import { Registry } from '../src/core/registry.js';
import { createMcpServer } from '../src/mcp/create-server.js';
import { startHttpServer } from '../src/mcp/http.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = 37376;

async function post(address: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const payload = Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: address,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
          Accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = chunks.join('').toString();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = text; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function postRaw(address: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return post(address, body);
}

async function get(address: string): Promise<{ status: number; data: unknown }> {
  return await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${address}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = chunks.join('').toString();
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode ?? 0, data });
      });
    }).on('error', reject);
  });
}

async function options(address: string): Promise<{ status: number; headers: Record<string, string> }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: address,
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Method': 'POST' },
      },
      (res) => {
        const responseHeaders: Record<string, string> = {};
        for (const key of Object.keys(res.headers)) {
          responseHeaders[key] = res.headers[key] as string;
        }
        resolve({ status: res.statusCode ?? 0, headers: responseHeaders });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let server: http.Server;

// Isolated temp directories for v0.3 managed storage
const testRoot = path.join(os.tmpdir(), `docu-guard-http-test-${Date.now()}`);
const configDir = path.join(testRoot, 'config');
const dataDir = path.join(testRoot, 'data');
const projectRoot = path.join(testRoot, 'project');

describe('HTTP server', () => {
  beforeAll(async () => {
    await fs.promises.mkdir(projectRoot, { recursive: true });
    await fs.promises.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await fs.promises.writeFile(path.join(projectRoot, 'docs', 'README.md'), '# README');
    await fs.promises.mkdir(path.join(projectRoot, 'docs', 'atlas'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(projectRoot, 'docs', 'atlas', 'guide.md'),
      `# Guide

Intro.

## Target

Target body.

### Child

Child body.

## Next

Next body.
`,
    );

    // Initialize with v0.3 managed storage — no .docu-guard/
    await Project.init({
      projectRoot,
      projectId: 'http-test',
      configDir,
      dataDir,
    });

    // Register in the registry
    const registry = await Registry.load(configDir, dataDir);
    await registry.addProject('http-test', projectRoot);

    const resolveProject = async (projectId: string) => {
      const entry = registry.listProjects().find((p) => p.projectId === projectId);
      if (!entry) throw new Error(`Project not found: ${projectId}`);
      return Project.load({
        projectRoot: entry.projectRoot,
        projectId: entry.projectId,
        configDir,
        dataDir,
      });
    };

    const result = await startHttpServer(
      () => createMcpServer(resolveProject, { version: '0.2.0' }),
      {
        host: '127.0.0.1',
        port: PORT,
        rest: {
          resolveProject,
          listProjects: () => registry.listProjects().map((project) => ({
            projectId: project.projectId,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            default: false,
          })),
        },
      },
    );
    server = result.server;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.promises.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('GET /health returns 200 OK', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ status: 'ok' });
  });

  it('GET / and /ui serve the read-only web UI shell', async () => {
    const root = await get('/');
    expect(root.status).toBe(200);
    expect(root.data).toContain('<div id="app"');
    expect(root.data).toContain('/ui/app.js');
    expect(root.data).toContain('/ui/styles.css');

    const ui = await get('/ui');
    expect(ui.status).toBe(200);
    expect(ui.data).toContain('Xurgo Atlas');
  });

  it('GET /ui/app.js bootstraps from read-only REST endpoints', async () => {
    const res = await get('/ui/app.js');
    expect(res.status).toBe(200);
    expect(res.data).toContain("api('/projects')");
    expect(res.data).toContain('/manifest?branch=');
    expect(res.data).toContain('/docs/');
    expect(res.data).toContain('/sections?');
    expect(res.data).toContain('/context-pack');
    expect(res.data).not.toContain('propose_patch');
    expect(res.data).not.toContain('commit_patch');
    expect(res.data).not.toContain('restore_file');
  });

  it('GET /ui/app.js escapes rendered Markdown and falls back for clipboard copies', async () => {
    const res = await get('/ui/app.js');
    expect(res.status).toBe(200);
    const source = String(res.data);

    expect(source).toContain('function escapeHtml(value)');
    expect(source).toContain("replaceAll('<', '&lt;')");
    expect(source).toContain('els.viewer.innerHTML = renderMarkdown(state.currentContent)');
    expect(source).not.toContain('els.viewer.innerHTML = state.currentContent');
    expect(source).toContain('button.append(path, summary)');
    expect(source).toContain('new URLSearchParams');
    expect(source).toContain('navigator.clipboard && typeof navigator.clipboard.writeText');
    expect(source).toContain("document.execCommand('copy')");
  });

  it('GET /ui/styles.css serves the static UI stylesheet', async () => {
    const res = await get('/ui/styles.css');
    expect(res.status).toBe(200);
    expect(res.data).toContain('.layout');
    expect(res.data).toContain('.viewer');
  });

  it('GET /projects lists registered projects without write actions', async () => {
    const res = await get('/projects');
    expect(res.status).toBe(200);
    const data = res.data as { projects: Array<Record<string, unknown>> };
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].projectId).toBe('http-test');
    expect(JSON.stringify(data)).not.toContain('propose');
    expect(JSON.stringify(data)).not.toContain('commit');
    expect(JSON.stringify(data)).not.toContain('restore');
  });

  it('GET /projects/:projectId/status returns STATUS.md data', async () => {
    const res = await get('/projects/http-test/status?maxChars=100');
    expect(res.status).toBe(200);
    const data = res.data as Record<string, unknown>;
    expect(data.projectId).toBe('http-test');
    expect(data.path).toBe('STATUS.md');
    expect(data.frontMatter).toBeTruthy();
    expect(data.body).toContain('# Project Status');
  });

  it('GET /projects/:projectId/manifest returns manifest data with query options', async () => {
    const res = await get('/projects/http-test/manifest?maxDocuments=1&validatePaths=false&includeRaw=true');
    expect(res.status).toBe(200);
    const data = res.data as {
      projectId: string;
      documents: unknown[];
      documentCount: number;
      truncated: boolean;
      raw?: string;
      validation?: unknown;
    };
    expect(data.projectId).toBe('http-test');
    expect(data.documentCount).toBe(1);
    expect(data.documents).toHaveLength(1);
    expect(data.truncated).toBe(true);
    expect(data.raw).toContain('documents:');
    expect(data.validation).toBeUndefined();
  });

  it('GET /projects/:projectId/docs/* performs bounded document reads', async () => {
    const res = await get('/projects/http-test/docs/docs/atlas/guide.md?maxChars=12&offset=9');
    expect(res.status).toBe(200);
    const data = res.data as Record<string, unknown>;
    expect(data.projectId).toBe('http-test');
    expect(data.path).toBe('docs/atlas/guide.md');
    expect(data.content).toBe('Intro.\n\n## T');
    expect(data.returnedChars).toBe(12);
    expect(data.truncated).toBe(true);
  });

  it('GET /projects/:projectId/sections returns matching sections', async () => {
    const res = await get('/projects/http-test/sections?path=docs%2Fatlas%2Fguide.md&heading=Target');
    expect(res.status).toBe(200);
    const data = res.data as Record<string, unknown>;
    expect(data.path).toBe('docs/atlas/guide.md');
    expect(data.heading).toBe('Target');
    expect(data.matchedHeading).toBe('Target');
    expect(data.content).toContain('### Child');
    expect(data.content).not.toContain('## Next');
  });

  it('POST /projects/:projectId/context-pack returns ordered read-only context items', async () => {
    const res = await postRaw('/projects/http-test/context-pack', {
      maxChars: 4000,
      paths: ['docs/atlas/guide.md'],
    });
    expect(res.status).toBe(200);
    const data = res.data as {
      projectId: string;
      items: Array<{ kind: string; path: string }>;
    };
    expect(data.projectId).toBe('http-test');
    expect(data.items.map((item) => [item.kind, item.path])).toEqual([
      ['status', 'STATUS.md'],
      ['agents', 'AGENTS.md'],
      ['manifest', 'docs/manifest.yml'],
      ['document', 'docs/atlas/guide.md'],
    ]);
  });

  it('REST read endpoints reject unsafe paths with structured errors', async () => {
    const res = await get('/projects/http-test/docs/%2E%2E%2Fsecrets.md');
    expect(res.status).toBe(400);
    const data = res.data as { error: { code: string; message: string } };
    expect(data.error.code).toBe('unsafe_path');
    expect(data.error.message).toContain('Path traversal');

    const untracked = await get('/projects/http-test/docs/notes/random.md');
    expect(untracked.status).toBe(403);
    expect((untracked.data as { error: { code: string } }).error.code).toBe('untracked_path');

    const unsafeSection = await get('/projects/http-test/sections?path=..%2Fsecrets.md&heading=Target');
    expect(unsafeSection.status).toBe(400);
    expect((unsafeSection.data as { error: { code: string } }).error.code).toBe('unsafe_path');

    const unsafeContextPack = await postRaw('/projects/http-test/context-pack', {
      paths: ['../secrets.md'],
    });
    expect(unsafeContextPack.status).toBe(400);
    expect((unsafeContextPack.data as { error: { code: string } }).error.code).toBe('unsafe_path');
  });

  it('REST read endpoints return structured errors for missing documents and sections', async () => {
    const missingDoc = await get('/projects/http-test/docs/docs/atlas/missing.md');
    expect(missingDoc.status).toBe(404);
    expect((missingDoc.data as { error: { code: string } }).error.code).toBe('not_found');

    const missingSection = await get('/projects/http-test/sections?path=docs%2Fatlas%2Fguide.md&heading=Missing');
    expect(missingSection.status).toBe(404);
    const sectionData = missingSection.data as { error: { code: string; details: { availableHeadings: unknown[] } } };
    expect(sectionData.error.code).toBe('not_found');
    expect(sectionData.error.details.availableHeadings.length).toBeGreaterThan(0);
  });

  it('REST does not expose write actions', async () => {
    const writeRoutes = [
      'create_branch',
      'propose_patch',
      'preview_diff',
      'commit_patch',
      'restore_file',
      'export',
      'merge_branch',
      'approve',
      'publish',
      'release',
    ];

    for (const route of writeRoutes) {
      const res = await postRaw(`/projects/http-test/${route}`, {});
      expect(res.status, route).toBe(404);
    }
  });

  it('OPTIONS /mcp returns CORS headers', async () => {
    const res = await options('/mcp');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('POST /mcp without Content-Type is rejected', async () => {
    const r = await await new Promise<{ status: number; data: unknown }>((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: {} }, (res) => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(chunks.join('').toString()) }); } catch { resolve({ status: res.statusCode ?? 0, data: chunks.join('').toString() }); }
        });
      });
      req.on('error', () => resolve({ status: 0, data: null }));
      req.end();
    });
    expect(r.status).not.toBe(200);
  });

  it('POST /mcp with Content-Type is dispatched', async () => {
    const res = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it('does not log full MCP request bodies by default', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      expect(res.status).not.toBe(404);
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('Request body:'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('debug logging emits bounded metadata without raw request bodies', async () => {
    const previousDebug = process.env.XURGO_ATLAS_DEBUG_MCP;
    process.env.XURGO_ATLAS_DEBUG_MCP = '1';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await post('/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          authorization: 'Bearer secret-token-123',
          documentBody: '# Confidential notes',
          patch: 'diff --git a/file.md b/file.md',
        },
      });

      expect(res.status).not.toBe(404);
      const output = errorSpy.mock.calls.flat().map((value) => String(value)).join('\n');

      expect(output).toContain('"component":"mcp-http"');
      expect(output).toContain('"eventCode":"MCP_REQUEST_RECEIVED"');
      expect(output).toContain('"eventCode":"MCP_REQUEST_HANDLED"');
      expect(output).not.toContain('secret-token-123');
      expect(output).not.toContain('documentBody');
      expect(output).not.toContain('diff --git');
      expect(output).not.toContain('Confidential notes');
    } finally {
      errorSpy.mockRestore();
      if (previousDebug === undefined) {
        delete process.env.XURGO_ATLAS_DEBUG_MCP;
      } else {
        process.env.XURGO_ATLAS_DEBUG_MCP = previousDebug;
      }
    }
  });

  it('debug logging sanitizes transport errors without leaking request content', async () => {
    const previousDebug = process.env.XURGO_ATLAS_DEBUG_MCP;
    process.env.XURGO_ATLAS_DEBUG_MCP = '1';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handleRequestSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockImplementationOnce(async () => {
      throw new Error('transport failure with token=abc123 and patch @@ secret');
    });

    try {
      const res = await post('/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          authorization: 'Bearer another-secret-token',
          patch: 'diff --git a/alpha.md b/alpha.md',
        },
      });

      expect(res.status).toBe(500);
      const output = errorSpy.mock.calls.flat().map((value) => String(value)).join('\n');

      expect(output).toContain('"eventCode":"MCP_REQUEST_FAILED"');
      expect(output).toContain('"errorCategory":"Error"');
      expect(output).not.toContain('token=abc123');
      expect(output).not.toContain('another-secret-token');
      expect(output).not.toContain('patch @@ secret');
      expect(output).not.toContain('alpha.md');
    } finally {
      handleRequestSpy.mockRestore();
      errorSpy.mockRestore();
      if (previousDebug === undefined) {
        delete process.env.XURGO_ATLAS_DEBUG_MCP;
      } else {
        process.env.XURGO_ATLAS_DEBUG_MCP = previousDebug;
      }
    }
  });

  it('POST /mcp with disallowed Origin returns 403', async () => {
    const r = await new Promise<{ status: number; data: unknown }>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: PORT,
          path: '/mcp',
          method: 'POST',
          headers: {
            Origin: 'https://evil.example.com',
          },
        },
        (res) => {
          const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
            try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(chunks.join('').toString()) }); } catch { resolve({ status: res.statusCode ?? 0, data: chunks.join('').toString() }); }
          });
        },
      );
      req.on('error', () => resolve({ status: 0, data: null }));
      req.end();
    });
    expect(r.status).toBe(403);
  });

  it('GET to unknown path returns non-200', async () => {
    const r = await await new Promise<{ status: number; data: unknown }>((resolve) => {
      http.get(`http://127.0.0.1:${PORT}/unknown`, (res) => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(chunks.join('').toString()) }); } catch { resolve({ status: res.statusCode ?? 0, data: chunks.join('').toString() }); }
        });
      }).on('error', () => resolve({ status: 0, data: null }));
    });
    expect(r.status).not.toBe(200);
  });

  it('should not create .docu-guard/ in project root', async () => {
    await expect(fs.promises.stat(path.join(projectRoot, '.docu-guard'))).rejects.toThrow();
  });

  it('should have managed state under dataDir', async () => {
    const managedDir = path.join(dataDir, 'projects', 'http-test');
    const managedStat = await fs.promises.stat(managedDir);
    expect(managedStat.isDirectory()).toBe(true);

    const repoPath = path.join(managedDir, 'repo.git');
    const repoStat = await fs.promises.stat(repoPath);
    expect(repoStat.isDirectory()).toBe(true);
  });

  it('should have registry at configDir/projects.json', async () => {
    const registryPath = path.join(configDir, 'projects.json');
    const regStat = await fs.promises.stat(registryPath);
    expect(regStat.isFile()).toBe(true);
  });
});
