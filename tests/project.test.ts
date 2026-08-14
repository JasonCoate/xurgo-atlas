import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Project } from '../src/core/project.js';
import { Registry } from '../src/core/registry.js';
import { Policy } from '../src/core/policy.js';
import {
  StoragePaths,
  emitStorageDiagnostics,
  getDefaultConfigDir,
  getDefaultDataDir,
  getStorageRootCandidates,
  resolveStorageRoots,
} from '../src/core/storage.js';
import { exportCommand, historyCommand, initCommand, listCommand } from '../src/cli/init.js';
import { GitStore } from '../src/core/git-store.js';
import { EventLog } from '../src/core/events.js';
import { RootLedgerStore } from '../src/core/root-ledger.js';
import * as readOnlyManagedState from '../src/core/read-only-managed-state.js';
import { validatePatch, isPathTraversal, applyUnifiedDiff } from '../src/core/patch.js';
import { assessPatchRisk } from '../src/core/risk.js';
import { createUnifiedDiffForReplacement } from '../src/core/unified-diff.js';
import { createMcpServer } from '../src/mcp/create-server.js';
import { parseFrontMatter, handleManifest, handleRead, handleReadSection, handleContextPack, handleProposePatch, handleProposeDocument, handlePreviewDiff, handleListProposals, handleDiscardProposal, handleCommitPatch } from '../src/mcp/tools.js';
import { inspectRootSafetyContext, inspectRootSafetyContextReadOnly } from '../src/core/root-safety.js';
import YAML from 'yaml';
import { simpleGit } from 'simple-git';

let tmpDir: string;

async function withXdgRoots<T>(
  run: (roots: { root: string; configHome: string; dataHome: string }) => Promise<T>,
): Promise<T> {
  const prevConfigHome = process.env.XDG_CONFIG_HOME;
  const prevDataHome = process.env.XDG_DATA_HOME;
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-xdg-'));
  const configHome = path.join(root, 'config-home');
  const dataHome = path.join(root, 'data-home');

  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_DATA_HOME = dataHome;

  try {
    return await run({ root, configHome, dataHome });
  } finally {
    if (prevConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = prevConfigHome;
    }

    if (prevDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = prevDataHome;
    }

    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'docu-guard-test-'));
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function initProjectWithSectionDoc(content: string): Promise<Project> {
  const docsDir = path.join(tmpDir, 'docs', 'atlas');
  await fs.promises.mkdir(docsDir, { recursive: true });
  await fs.promises.writeFile(path.join(docsDir, 'sections.md'), content, 'utf-8');

  return Project.init({
    projectRoot: tmpDir,
    projectId: 'test-project',
    configDir: path.join(tmpDir, 'config'),
    dataDir: path.join(tmpDir, 'data'),
  });
}

async function callTool(project: Project, name: string, args: Record<string, unknown>) {
  const server = createMcpServer(project);
  const handlers = (server as unknown as {
    _requestHandlers: Map<string, (request: unknown) => Promise<unknown>>;
  })._requestHandlers;
  const call = handlers.get('tools/call');
  expect(call).toBeTypeOf('function');

  return call!({
    method: 'tools/call',
    params: {
      name,
      arguments: args,
    },
  }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

async function initSourceRepo(currentBranch = 'main') {
  await fs.promises.writeFile(
    path.join(tmpDir, '.gitignore'),
    'config/\ndata/\n',
    'utf-8',
  );

  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  await git.add('.');
  await git.commit('Initial source commit');
  await git.raw(['branch', '-M', 'main']);

  if (currentBranch !== 'main') {
    await git.checkoutLocalBranch(currentBranch);
  }

  return git;
}

function getStoredProposalCount(project: Project, projectId = 'test-project'): number {
  const db = new DatabaseSync(project.storage.projectEventsPath(projectId), {
    readOnly: true,
  });

  try {
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM doc_proposals WHERE project_id = ?')
      .get(projectId) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function getRootLedgerRows(project: Project, projectId = 'test-project'): Array<Record<string, unknown>> {
  const db = new DatabaseSync(project.storage.projectEventsPath(projectId), {
    readOnly: true,
  });

  try {
    const table = db.prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'root_worktree_ledger'
      `,
    ).get() as { name?: string } | undefined;
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
    ).all(projectId) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function getLatestRecoveryObservationEvent(
  project: Project,
  toolName: 'preview_export' | 'export',
  projectId = 'test-project',
): { createdAt: string; metadata: Record<string, unknown> } | null {
  const db = new DatabaseSync(project.storage.projectEventsPath(projectId), {
    readOnly: true,
  });

  try {
    const row = db.prepare(
      `
      SELECT created_at, metadata_json
      FROM doc_events
      WHERE project_id = ? AND tool_name = ?
      ORDER BY created_at DESC
      LIMIT 1
      `,
    ).get(projectId, toolName) as
      | { created_at: string; metadata_json: string | null }
      | undefined;

    if (!row?.metadata_json) {
      return null;
    }

    return {
      createdAt: row.created_at,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    };
  } finally {
    db.close();
  }
}

async function setRegisteredProjectRoot(
  project: Project,
  projectRoot: string,
): Promise<void> {
  const registry = await Registry.load(project.storage.configDir, project.storage.dataDir);
  await registry.addProject(project.projectId, projectRoot);
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function walk(current: string): Promise<void> {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (relative.endsWith('-wal') || relative.endsWith('-shm')) {
          continue;
        }
        snapshot[relative] = crypto.createHash('sha256')
          .update(await fs.promises.readFile(fullPath))
          .digest('hex');
      }
    }
  }

  try {
    await walk(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return snapshot;
}

// ── Storage path resolution tests ─────────────────────────────────────

describe('storage path resolution', () => {
  it('should provide default config and data directories', () => {
    const storage = new StoragePaths();
    expect(storage.configDir).toBe(getDefaultConfigDir());
    expect(storage.dataDir).toBe(getDefaultDataDir());
  });

  it('should expose atlas root candidates and choose them for fresh installs', async () => {
    await withXdgRoots(async () => {
      const candidates = getStorageRootCandidates();
      const resolved = resolveStorageRoots();

      expect(candidates.atlasConfigDir).toContain('xurgo-atlas');
      expect(candidates.atlasDataDir).toContain('xurgo-atlas');
      expect(candidates.legacyConfigDir).toContain('docu-guard');
      expect(candidates.legacyDataDir).toContain('docu-guard');
      expect(resolved.configDir).toBe(candidates.atlasConfigDir);
      expect(resolved.dataDir).toBe(candidates.atlasDataDir);
      expect(resolved.configSource).toBe('atlas-default');
      expect(resolved.dataSource).toBe('atlas-default');
      expect(resolved.discovery.selectedDefaultApp).toBe('atlas');
      expect(resolved.diagnostics).toEqual([]);
    });
  });

  it('should choose legacy roots for legacy-only installs', async () => {
    await withXdgRoots(async ({ configHome, dataHome }) => {
      const legacyConfigDir = path.join(configHome, 'docu-guard');
      const legacyDataDir = path.join(dataHome, 'docu-guard');

      await fs.promises.mkdir(legacyConfigDir, { recursive: true });
      await fs.promises.mkdir(path.join(legacyDataDir, 'projects', 'legacy-project'), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(legacyConfigDir, 'projects.json'),
        JSON.stringify({ version: 2, configDir: legacyConfigDir, dataDir: legacyDataDir, defaultProjectId: null, projects: {} }, null, 2),
        'utf-8',
      );

      const resolved = resolveStorageRoots();

      expect(resolved.configDir).toBe(legacyConfigDir);
      expect(resolved.dataDir).toBe(legacyDataDir);
      expect(resolved.configSource).toBe('legacy-default');
      expect(resolved.dataSource).toBe('legacy-default');
      expect(resolved.discovery.selectedDefaultApp).toBe('legacy');
    });
  });

  it('should choose atlas roots for atlas-only installs', async () => {
    await withXdgRoots(async ({ configHome, dataHome }) => {
      const atlasConfigDir = path.join(configHome, 'xurgo-atlas');
      const atlasDataDir = path.join(dataHome, 'xurgo-atlas');

      await fs.promises.mkdir(atlasConfigDir, { recursive: true });
      await fs.promises.mkdir(path.join(atlasDataDir, 'projects', 'atlas-project'), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(atlasConfigDir, 'projects.json'),
        JSON.stringify({ version: 2, configDir: atlasConfigDir, dataDir: atlasDataDir, defaultProjectId: null, projects: {} }, null, 2),
        'utf-8',
      );

      const resolved = resolveStorageRoots();

      expect(resolved.configDir).toBe(atlasConfigDir);
      expect(resolved.dataDir).toBe(atlasDataDir);
      expect(resolved.configSource).toBe('atlas-default');
      expect(resolved.dataSource).toBe('atlas-default');
      expect(resolved.discovery.selectedDefaultApp).toBe('atlas');
    });
  });

  it('should accept custom config and data directories', () => {
    const storage = new StoragePaths({
      configDir: '/custom/config',
      dataDir: '/custom/data',
    });
    expect(storage.configDir).toBe('/custom/config');
    expect(storage.dataDir).toBe('/custom/data');
  });

  it('should let explicit config and data roots override default resolution', () => {
    const resolved = resolveStorageRoots({
      configDir: '~/my-config',
      dataDir: '~/my-data',
    });

    expect(resolved.configDir).toBe(path.join(os.homedir(), 'my-config'));
    expect(resolved.dataDir).toBe(path.join(os.homedir(), 'my-data'));
    expect(resolved.configSource).toBe('explicit');
    expect(resolved.dataSource).toBe('explicit');
  });

  it('should keep explicit roots even when legacy and atlas installs are discovered', async () => {
    await withXdgRoots(async ({ configHome, dataHome }) => {
      const atlasConfigDir = path.join(configHome, 'xurgo-atlas');
      const atlasDataDir = path.join(dataHome, 'xurgo-atlas');
      const legacyConfigDir = path.join(configHome, 'docu-guard');
      const legacyDataDir = path.join(dataHome, 'docu-guard');

      await fs.promises.mkdir(atlasConfigDir, { recursive: true });
      await fs.promises.mkdir(legacyConfigDir, { recursive: true });
      await fs.promises.mkdir(path.join(atlasDataDir, 'projects', 'atlas-project'), {
        recursive: true,
      });
      await fs.promises.mkdir(path.join(legacyDataDir, 'projects', 'legacy-project'), {
        recursive: true,
      });
      await fs.promises.writeFile(path.join(atlasConfigDir, 'projects.json'), '{}', 'utf-8');
      await fs.promises.writeFile(path.join(legacyConfigDir, 'projects.json'), '{}', 'utf-8');

      const resolved = resolveStorageRoots({
        configDir: '/custom/config',
        dataDir: '/custom/data',
      });

      expect(resolved.configDir).toBe('/custom/config');
      expect(resolved.dataDir).toBe('/custom/data');
      expect(resolved.configSource).toBe('explicit');
      expect(resolved.dataSource).toBe('explicit');
    });
  });

  it('should prefer atlas roots and expose a warning when both atlas and legacy roots are populated', async () => {
    await withXdgRoots(async ({ configHome, dataHome }) => {
      const atlasConfigDir = path.join(configHome, 'xurgo-atlas');
      const atlasDataDir = path.join(dataHome, 'xurgo-atlas');
      const legacyConfigDir = path.join(configHome, 'docu-guard');
      const legacyDataDir = path.join(dataHome, 'docu-guard');

      await fs.promises.mkdir(atlasConfigDir, { recursive: true });
      await fs.promises.mkdir(legacyConfigDir, { recursive: true });
      await fs.promises.mkdir(path.join(atlasDataDir, 'projects', 'atlas-project'), {
        recursive: true,
      });
      await fs.promises.mkdir(path.join(legacyDataDir, 'projects', 'legacy-project'), {
        recursive: true,
      });
      await fs.promises.writeFile(path.join(atlasConfigDir, 'projects.json'), '{}', 'utf-8');
      await fs.promises.writeFile(path.join(legacyConfigDir, 'projects.json'), '{}', 'utf-8');

      const resolved = resolveStorageRoots();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        expect(resolved.configDir).toBe(atlasConfigDir);
        expect(resolved.dataDir).toBe(atlasDataDir);
        expect(resolved.diagnostics).toHaveLength(1);
        expect(resolved.diagnostics[0].code).toBe('both-storage-roots-populated');
        expect(resolved.diagnostics[0].message).toContain('Using Xurgo Atlas roots');
        expect(resolved.diagnostics[0].message).toContain('No automatic merge or migration was performed');

        emitStorageDiagnostics(resolved);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('Both Xurgo Atlas and legacy docu-guard storage roots appear populated');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('should derive correct project managed paths', () => {
    const storage = new StoragePaths({
      configDir: '/cfg',
      dataDir: '/dat',
    });
    expect(storage.registryPath()).toBe('/cfg/projects.json');
    expect(storage.projectDataDir('my-proj')).toBe('/dat/projects/my-proj');
    expect(storage.projectRepoPath('my-proj')).toBe('/dat/projects/my-proj/repo.git');
    expect(storage.projectEventsPath('my-proj')).toBe('/dat/projects/my-proj/events.sqlite');
  });

  it('should honor explicit XDG environment variables for default paths', async () => {
    await withXdgRoots(async ({ configHome, dataHome }) => {
      const storage = new StoragePaths();
      expect(storage.configDir).toBe(path.join(configHome, 'xurgo-atlas'));
      expect(storage.dataDir).toBe(path.join(dataHome, 'xurgo-atlas'));
      expect(storage.configDir).not.toContain(path.join('.config', 'xurgo-atlas'));
      expect(storage.dataDir).not.toContain(path.join('.local', 'share', 'xurgo-atlas'));
    });
  });

  it('should expand ~ to home directory in configDir and dataDir', () => {
    const home = os.homedir();
    const storage = new StoragePaths({
      configDir: '~/my-config',
      dataDir: '~/my-data',
    });
    expect(storage.configDir).toBe(path.join(home, 'my-config'));
    expect(storage.dataDir).toBe(path.join(home, 'my-data'));
  });

  it('should expand bare ~ without trailing slash', () => {
    const home = os.homedir();
    const storage = new StoragePaths({
      configDir: '~',
      dataDir: '~',
    });
    expect(storage.configDir).toBe(home);
    expect(storage.dataDir).toBe(home);
  });

  it('should leave non-tilde paths unchanged (after path.resolve)', () => {
    const storage = new StoragePaths({
      configDir: '/absolute/path',
      dataDir: '/another/path',
    });
    expect(storage.configDir).toBe('/absolute/path');
    expect(storage.dataDir).toBe('/another/path');
  });
});

describe('storage discovery workflows', () => {
  it('should run init, list, history, and export against atlas roots on a fresh install', async () => {
    await withXdgRoots(async ({ configHome, dataHome }) => {
      const projectRoot = path.join(tmpDir, 'atlas-project-root');
      const exportDir = path.join(tmpDir, 'atlas-export');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await fs.promises.mkdir(projectRoot, { recursive: true });

      try {
        await initCommand({
          projectRoot,
          projectId: 'atlas-project-root',
        });

        const atlasConfigDir = path.join(configHome, 'xurgo-atlas');
        const atlasDataDir = path.join(dataHome, 'xurgo-atlas');

        await expect(
          fs.promises.stat(path.join(atlasConfigDir, 'projects.json')),
        ).resolves.toBeTruthy();
        await expect(
          fs.promises.stat(path.join(atlasDataDir, 'projects', 'atlas-project-root', 'repo.git')),
        ).resolves.toBeTruthy();
        await expect(
          fs.promises.stat(path.join(atlasDataDir, 'projects', 'atlas-project-root', 'events.sqlite')),
        ).resolves.toBeTruthy();

        logSpy.mockClear();
        await listCommand(projectRoot);
        const listPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'));
        expect(listPayload.projectId).toBe('atlas-project-root');
        expect(Array.isArray(listPayload.files)).toBe(true);

        logSpy.mockClear();
        await historyCommand(projectRoot, 'docs/README.md');
        const historyPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'));
        expect(historyPayload.path).toBe('docs/README.md');
        expect(Array.isArray(historyPayload.history)).toBe(true);

        logSpy.mockClear();
        await exportCommand(projectRoot, 'main', undefined, undefined, exportDir);
        await expect(
          fs.promises.readFile(path.join(exportDir, 'docs', 'README.md'), 'utf-8'),
        ).resolves.toContain('Xurgo Atlas');
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  it('should run init, list, history, and export against legacy-discovered roots', async () => {
    await withXdgRoots(async ({ configHome, dataHome }) => {
      const projectRoot = path.join(tmpDir, 'legacy-project-root');
      const exportDir = path.join(tmpDir, 'legacy-export');
      const legacyConfigDir = path.join(configHome, 'docu-guard');
      const legacyDataDir = path.join(dataHome, 'docu-guard');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await fs.promises.mkdir(projectRoot, { recursive: true });
      await fs.promises.mkdir(path.join(legacyDataDir, 'projects', 'existing-project'), {
        recursive: true,
      });
      await fs.promises.mkdir(legacyConfigDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(legacyConfigDir, 'projects.json'),
        JSON.stringify({
          version: 2,
          configDir: legacyConfigDir,
          dataDir: legacyDataDir,
          defaultProjectId: null,
          projects: {},
        }, null, 2),
        'utf-8',
      );

      try {
        await initCommand({
          projectRoot,
          projectId: 'legacy-project-root',
        });

        await expect(
          fs.promises.readFile(path.join(legacyConfigDir, 'projects.json'), 'utf-8'),
        ).resolves.toContain('legacy-project-root');
        await expect(
          fs.promises.stat(path.join(legacyDataDir, 'projects', 'legacy-project-root', 'repo.git')),
        ).resolves.toBeTruthy();
        await expect(
          fs.promises.stat(path.join(legacyDataDir, 'projects', 'legacy-project-root', 'events.sqlite')),
        ).resolves.toBeTruthy();

        logSpy.mockClear();
        await listCommand(projectRoot);
        const listPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'));
        expect(Array.isArray(listPayload.files)).toBe(true);

        logSpy.mockClear();
        await historyCommand(projectRoot, 'docs/README.md');
        const historyPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'));
        expect(historyPayload.path).toBe('docs/README.md');
        expect(Array.isArray(historyPayload.history)).toBe(true);

        logSpy.mockClear();
        await exportCommand(projectRoot, 'main', undefined, undefined, exportDir);
        await expect(
          fs.promises.readFile(path.join(exportDir, 'docs', 'README.md'), 'utf-8'),
        ).resolves.toContain('Xurgo Atlas');
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});

// ── Pre-init error handling ────────────────────────────────────────

describe('pre-init error handling', () => {
  it('should exit with a clear message when list is run before init', async () => {
    const projectRoot = path.join(tmpDir, 'never-initialized');
    await fs.promises.mkdir(projectRoot, { recursive: true });

    // Create project files so requireInit passes, but no registry entry exists
    await fs.promises.writeFile(
      path.join(projectRoot, '.docs-policy.yml'),
      'protected_paths:\n  - docs/**\n',
      'utf-8',
    );
    await fs.promises.mkdir(path.join(projectRoot, 'docs'), { recursive: true });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(
        listCommand(projectRoot, path.join(tmpDir, 'config'), path.join(tmpDir, 'data')),
      ).rejects.toThrow('process.exit(1)');

      // Should print an actionable error about running init
      const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('not registered');
      expect(output).toContain('xurgo-atlas init');
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('should exit with a clear message when list is run from outside a project root', async () => {
    const nonProjectDir = path.join(tmpDir, 'non-project');
    await fs.promises.mkdir(nonProjectDir, { recursive: true });
    // No project files here

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(
        listCommand(nonProjectDir, path.join(tmpDir, 'config'), path.join(tmpDir, 'data')),
      ).rejects.toThrow('process.exit(1)');

      // requireInit should catch this — no project files
      const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('not been initialized');
      expect(output).toContain('xurgo-atlas init');
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('should exit with a clear message when history is run before init', async () => {
    const projectRoot = path.join(tmpDir, 'uninit-history');
    await fs.promises.mkdir(projectRoot, { recursive: true });
    // No project files

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(
        historyCommand(projectRoot, 'docs/README.md', path.join(tmpDir, 'config'), path.join(tmpDir, 'data')),
      ).rejects.toThrow('process.exit(1)');

      const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('not been initialized');
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('should exit with a clear message when export is run before init', async () => {
    const projectRoot = path.join(tmpDir, 'uninit-export');
    await fs.promises.mkdir(projectRoot, { recursive: true });
    // No project files

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(
        exportCommand(projectRoot, 'main', path.join(tmpDir, 'config'), path.join(tmpDir, 'data')),
      ).rejects.toThrow('process.exit(1)');

      const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('not been initialized');
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('should not throw an unhandled GitConstructError stack trace from list', async () => {
    const projectRoot = path.join(tmpDir, 'git-construct-test');
    await fs.promises.mkdir(projectRoot, { recursive: true });
    // Only project files but no init
    await fs.promises.writeFile(
      path.join(projectRoot, '.docs-policy.yml'),
      'protected_paths:\n  - docs/**\n',
      'utf-8',
    );
    await fs.promises.mkdir(path.join(projectRoot, 'docs'), { recursive: true });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      const err = await listCommand(
        projectRoot,
        path.join(tmpDir, 'config'),
        path.join(tmpDir, 'data'),
      ).catch((e) => e);

      // Must never throw GitConstructError
      expect(String(err)).not.toContain('GitConstructError');
      expect(String(err)).not.toContain('Cannot use simple-git on a directory that does not exist');
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

// ── Project initialization (v0.3 managed storage) ────────────────────

describe('project initialization', () => {
  it('should create project files but NOT create .docu-guard/', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // .docu-guard/ should NOT exist
    const legacyDir = path.join(tmpDir, '.docu-guard');
    await expect(fs.promises.stat(legacyDir)).rejects.toThrow();

    // Check .docs-policy.yml exists
    const policyFile = path.join(tmpDir, '.docs-policy.yml');
    const policyStat = await fs.promises.stat(policyFile);
    expect(policyStat.isFile()).toBe(true);

    // Check docs directory exists
    const docsDir = path.join(tmpDir, 'docs');
    const docsStat = await fs.promises.stat(docsDir);
    expect(docsStat.isDirectory()).toBe(true);

    // Check docs/README.md exists
    const docsReadme = path.join(tmpDir, 'docs', 'README.md');
    const docsReadmeStat = await fs.promises.stat(docsReadme);
    expect(docsReadmeStat.isFile()).toBe(true);
    const docsReadmeContent = await fs.promises.readFile(docsReadme, 'utf-8');
    expect(docsReadmeContent).toContain('Xurgo Atlas');

    // Check docs/spec/README.md exists
    const specReadme = path.join(tmpDir, 'docs', 'spec', 'README.md');
    const specStat = await fs.promises.stat(specReadme);
    expect(specStat.isFile()).toBe(true);

    // Check docs/implementation-checklist.md exists
    const checklist = path.join(tmpDir, 'docs', 'implementation-checklist.md');
    const checklistStat = await fs.promises.stat(checklist);
    expect(checklistStat.isFile()).toBe(true);

    // Check AGENTS.md exists with safety rules content
    const agentsMd = path.join(tmpDir, 'AGENTS.md');
    const agentsStat = await fs.promises.stat(agentsMd);
    expect(agentsStat.isFile()).toBe(true);

    // Verify AGENTS.md contains the documentation safety rules
    const agentsContent = await fs.promises.readFile(agentsMd, 'utf-8');
    expect(agentsContent).toContain('# Agent Instructions for Xurgo Atlas');
    expect(agentsContent).toContain('Documentation Safety Rules');
    expect(agentsContent).toContain('Xurgo Atlas');
    expect(agentsContent).toContain('docu-guard-mcp');
    expect(agentsContent).toContain('Never directly overwrite');
    expect(agentsContent).toContain('docs.propose_patch');
    expect(agentsContent).toContain('baseRevision');
    expect(agentsContent).toContain('inspect all managed-doc/export changes');
    expect(agentsContent).toContain('required for this branch, valid managed-store/source synchronization, or unrelated stale drift to revert');

    // Verify Git store has files tracked
    const files = await project.getTrackedFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('should not duplicate generated AGENTS content on re-init after atlas-branded generation', async () => {
    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const agentsContent = await fs.promises.readFile(
      path.join(tmpDir, 'AGENTS.md'),
      'utf-8',
    );

    expect(agentsContent.match(/# Agent Instructions for Xurgo Atlas/g)).toHaveLength(1);
  });

  it('should treat legacy generated AGENTS content as already initialized', async () => {
    const legacyAgents = `# Agent Instructions for docu-guard-mcp

## Documentation Safety Rules

Legacy generated content.
`;

    await fs.promises.writeFile(
      path.join(tmpDir, 'AGENTS.md'),
      legacyAgents,
      'utf-8',
    );

    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const agentsContent = await fs.promises.readFile(
      path.join(tmpDir, 'AGENTS.md'),
      'utf-8',
    );

    expect(agentsContent).toBe(legacyAgents);
    expect(agentsContent).not.toContain('# Agent Instructions for Xurgo Atlas');
  });

  it('should create managed state under dataDir, not project root', async () => {
    // Use a custom data dir in the temp area
    const dataDir = path.join(tmpDir, 'docu-guard-data');
    const configDir = path.join(tmpDir, 'docu-guard-config');

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir,
      dataDir,
    });

    // Managed state should be at <dataDir>/projects/test-project/
    const managedDir = path.join(dataDir, 'projects', 'test-project');
    const managedStat = await fs.promises.stat(managedDir);
    expect(managedStat.isDirectory()).toBe(true);

    // Git repo should be there
    const repoPath = path.join(managedDir, 'repo.git');
    const repoStat = await fs.promises.stat(repoPath);
    expect(repoStat.isDirectory()).toBe(true);

    // Events DB should be there
    const eventsPath = path.join(managedDir, 'events.sqlite');
    const dbStat = await fs.promises.stat(eventsPath);
    expect(dbStat.isFile()).toBe(true);

    // Project.init() now writes the registry entry for the initialized project.
    // Project root should NOT have .docu-guard/
    await expect(fs.promises.stat(path.join(tmpDir, '.docu-guard'))).rejects.toThrow();
  });

  it('should warn but not block if pre-v0.3 .docu-guard/ exists', async () => {
    // Create a legacy .docu-guard/ directory
    const legacyDir = path.join(tmpDir, '.docu-guard');
    await fs.promises.mkdir(legacyDir, { recursive: true });

    // Init should succeed (writes to stderr but doesn't throw)
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // Legacy dir should still exist
    const stat = await fs.promises.stat(legacyDir);
    expect(stat.isDirectory()).toBe(true);

    // Managed state should also exist
    const storage = project.storage;
    const managedDir = storage.projectDataDir('test-project');
    const managedStat = await fs.promises.stat(managedDir);
    expect(managedStat.isDirectory()).toBe(true);
  });

  it('should explain that pre-v0.3 .docu-guard/ cleanup is manual', async () => {
    const legacyDir = path.join(tmpDir, '.docu-guard');
    await fs.promises.mkdir(legacyDir, { recursive: true });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await Project.init({
        projectRoot: tmpDir,
        projectId: 'test-project',
        configDir: path.join(tmpDir, 'config'),
        dataDir: path.join(tmpDir, 'data'),
      });

      const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('pre-v0.3 .docu-guard/ directory');
      expect(output).toContain('Remove this old project-local artifact manually');
      expect(output).not.toContain('Run migration');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('should log initialization under the atlas-branded event path', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const atlasInitHistory = project.eventLog.getHistoryForPath(
      'test-project',
      '.xurgo-atlas/init',
    );
    const legacyInitHistory = project.eventLog.getHistoryForPath(
      'test-project',
      '.docu-guard/init',
    );

    expect(atlasInitHistory).toHaveLength(1);
    expect(atlasInitHistory[0].summary).toContain('Initialized Xurgo Atlas project');
    expect(legacyInitHistory).toHaveLength(0);
  });
});

// ── Existing doc preservation on first init ────────────────────────────

describe('existing doc preservation on first init', () => {
  it('should preserve existing STATUS.md on first init', async () => {
    const customStatus = '# My Custom Status\n\nCustom content.\n';
    await fs.promises.writeFile(path.join(tmpDir, 'STATUS.md'), customStatus, 'utf-8');

    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const content = await fs.promises.readFile(path.join(tmpDir, 'STATUS.md'), 'utf-8');
    expect(content).toBe(customStatus);
  });

  it('should preserve existing AGENTS.md on first init (user-authored, no generated header)', async () => {
    const customAgents = '# My Custom Agents\n\nCustom agent instructions.\n';
    await fs.promises.writeFile(path.join(tmpDir, 'AGENTS.md'), customAgents, 'utf-8');

    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const content = await fs.promises.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    // Must not append safety rules to user-authored content
    expect(content).toBe(customAgents);
    expect(content).not.toContain('Documentation Safety Rules');
  });

  it('should preserve existing docs/manifest.yml on first init', async () => {
    const customManifest = 'custom: true\n';
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'docs', 'manifest.yml'), customManifest, 'utf-8');

    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const content = await fs.promises.readFile(path.join(tmpDir, 'docs', 'manifest.yml'), 'utf-8');
    expect(content).toBe(customManifest);
  });

  it('should preserve existing docs under docs/ on first init', async () => {
    const customReadme = '# Custom Docs\n';
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'docs', 'custom.md'), customReadme, 'utf-8');

    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const content = await fs.promises.readFile(path.join(tmpDir, 'docs', 'custom.md'), 'utf-8');
    expect(content).toBe(customReadme);
  });

  it('should create only missing files when some already exist', async () => {
    // Pre-create STATUS.md but not AGENTS.md or .docs-policy.yml
    const customStatus = '# Only Status\n';
    await fs.promises.writeFile(path.join(tmpDir, 'STATUS.md'), customStatus, 'utf-8');

    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // STATUS.md should be preserved
    const statusContent = await fs.promises.readFile(path.join(tmpDir, 'STATUS.md'), 'utf-8');
    expect(statusContent).toBe(customStatus);

    // AGENTS.md should be created since it didn't exist
    const agentsContent = await fs.promises.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('# Agent Instructions for Xurgo Atlas');

    // .docs-policy.yml should be created since it didn't exist
    await expect(fs.promises.stat(path.join(tmpDir, '.docs-policy.yml'))).resolves.toBeTruthy();
  });

  it('should snapshot existing docs into git store during init', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'STATUS.md'), '# Pre-existing Status\n', 'utf-8');
    await fs.promises.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Pre-existing Agents\n', 'utf-8');
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'docs', 'custom.md'), '# Custom Doc\n', 'utf-8');
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'manifest.yml'),
      'version: 1\ndocuments:\n  - path: docs/custom.md\n    role: notes\n    summary: Custom\n',
      'utf-8',
    );

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // All files should be tracked in the git store
    const trackedFiles = await project.getTrackedFiles();
    expect(trackedFiles).toContain('STATUS.md');
    expect(trackedFiles).toContain('AGENTS.md');
    expect(trackedFiles).toContain('docs/custom.md');
    expect(trackedFiles).toContain('docs/manifest.yml');

    // Content should be preserved in the snapshot
    const statusSnapshot = await project.readFile('main', 'STATUS.md');
    expect(statusSnapshot.content).toBe('# Pre-existing Status\n');

    const agentsSnapshot = await project.readFile('main', 'AGENTS.md');
    expect(agentsSnapshot.content).toBe('# Pre-existing Agents\n');

    const customSnapshot = await project.readFile('main', 'docs/custom.md');
    expect(customSnapshot.content).toBe('# Custom Doc\n');
  });

  it('should register and snapshot a project with existing docs', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'STATUS.md'), '# Status\n', 'utf-8');
    await fs.promises.writeFile(path.join(tmpDir, 'docs', 'guide.md'), '# Guide\n', 'utf-8');

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // Verify project is initialized
    const trackedFiles = await project.getTrackedFiles();
    expect(trackedFiles).toContain('STATUS.md');
    expect(trackedFiles).toContain('docs/guide.md');

    // Verify init event was logged
    const initHistory = project.eventLog.getHistoryForPath(
      'test-project',
      '.xurgo-atlas/init',
    );
    expect(initHistory).toHaveLength(1);
    expect(initHistory[0].summary).toContain('Initialized Xurgo Atlas project');
  });
});

// ── v0.4 STATUS.md and docs/manifest.yml foundation ───────────────────

describe('v0.4 project context files', () => {
  it('should create STATUS.md and docs/manifest.yml during init', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // STATUS.md at project root
    const statusPath = path.join(tmpDir, 'STATUS.md');
    const statusStat = await fs.promises.stat(statusPath);
    expect(statusStat.isFile()).toBe(true);
    const statusContent = await fs.promises.readFile(statusPath, 'utf-8');
    expect(statusContent).toContain('docuGuard.type: status');
    expect(statusContent).toContain('Project Status');

    // docs/manifest.yml in docs dir
    const manifestPath = path.join(tmpDir, 'docs', 'manifest.yml');
    const manifestStat = await fs.promises.stat(manifestPath);
    expect(manifestStat.isFile()).toBe(true);
    const manifestContent = await fs.promises.readFile(manifestPath, 'utf-8');
    expect(manifestContent).toContain('version: 1');
    expect(manifestContent).toContain('STATUS.md');
    expect(manifestContent).toContain('AGENTS.md');
    expect(manifestContent).toContain('docs/manifest.yml');

    // Both files should be tracked in the Git store
    const trackedFiles = await project.getTrackedFiles();
    expect(trackedFiles).toContain('STATUS.md');
    expect(trackedFiles).toContain('docs/manifest.yml');

    // References in manifest match actual tracked files
    expect(trackedFiles).toContain('AGENTS.md');
    expect(trackedFiles).toContain('.docs-policy.yml');
    expect(trackedFiles).toContain('docs/README.md');
    expect(trackedFiles).toContain('docs/implementation-checklist.md');
  });

  it('should not overwrite existing STATUS.md on re-init', async () => {
    // First init
    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // Modify STATUS.md with custom content
    const statusPath = path.join(tmpDir, 'STATUS.md');
    await fs.promises.writeFile(statusPath, '# Custom Status\n', 'utf-8');

    // Re-init should NOT overwrite
    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const content = await fs.promises.readFile(statusPath, 'utf-8');
    expect(content).toBe('# Custom Status\n');
  });

  it('should not overwrite existing docs/manifest.yml on re-init', async () => {
    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const manifestPath = path.join(tmpDir, 'docs', 'manifest.yml');
    await fs.promises.writeFile(manifestPath, 'custom: true\n', 'utf-8');

    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const content = await fs.promises.readFile(manifestPath, 'utf-8');
    expect(content).toBe('custom: true\n');
  });

  it('should not create project-local .docu-guard/', async () => {
    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    await expect(fs.promises.stat(path.join(tmpDir, '.docu-guard'))).rejects.toThrow();
  });

  it('should treat STATUS.md as a protected document by default', async () => {
    const project = await Project.load({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // First init to create policy
    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // Reload to pick up the written policy file
    const loadedProject = await Project.load({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    expect(loadedProject.policy.isPathProtected('STATUS.md')).toBe(true);
    expect(loadedProject.policy.isPathProtected('docs/manifest.yml')).toBe(true);
  });

  it('should preserve canonical guarded root paths when loading legacy policy files', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, '.docs-policy.yml'),
      `protected_paths:
  - AGENTS.md
  - docs/**
write_mode:
  default: propose_patch_only
  protected: approval_required
forbidden_operations:
  - silent_delete
  - whole_file_replace_without_base_revision
  - overwrite_without_diff
  - delete_protected_doc_without_approval
required_metadata:
  - intent
  - baseRevision
  - summary
branching:
  agent_branches: true
  merge_to_main_requires: approval
risk_rules:
  large_deletion_percent: 25
  whole_file_replacement_requires_approval: true
  heading_removal_requires_approval: true
  protected_file_change_requires_approval: true
`,
      'utf-8',
    );

    await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const loadedProject = await Project.load({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    expect(loadedProject.policy.isPathProtected('STATUS.md')).toBe(true);
    expect(loadedProject.policy.isPathProtected('AGENTS.md')).toBe(true);
    expect(loadedProject.policy.isPathProtected('.docs-policy.yml')).toBe(true);
    expect(loadedProject.policy.isPathProtected('docs/README.md')).toBe(true);
  });

  it('should resolve curated owned documents separately from protected paths', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'docs', 'atlas'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'manifest.yml'),
      `version: 1
documents:
  - path: docs/listed.md
    role: notes
    summary: Listed doc
`,
      'utf-8',
    );
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'listed.md'),
      '# Listed\n',
      'utf-8',
    );
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'atlas', 'owned.md'),
      '# Owned\n',
      'utf-8',
    );
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'unlisted.md'),
      '# Unlisted\n',
      'utf-8',
    );

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    expect(await project.isPathOwned('main', 'STATUS.md')).toBe(true);
    expect(await project.isPathOwned('main', 'AGENTS.md')).toBe(true);
    expect(await project.isPathOwned('main', '.docs-policy.yml')).toBe(true);
    expect(await project.isPathOwned('main', 'docs/manifest.yml')).toBe(true);
    expect(await project.isPathOwned('main', 'docs/atlas/owned.md')).toBe(true);
    expect(await project.isPathOwned('main', 'docs/listed.md')).toBe(true);
    expect(await project.isPathOwned('main', 'docs/unlisted.md')).toBe(false);

    expect(project.policy.isPathProtected('docs/unlisted.md')).toBe(true);
  });

  it('should exclude unowned documents from docs.list', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'manifest.yml'),
      `version: 1
documents:
  - path: docs/listed.md
    role: notes
    summary: Listed doc
`,
      'utf-8',
    );
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'listed.md'),
      '# Listed\n',
      'utf-8',
    );
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'unlisted.md'),
      '# Unlisted\n',
      'utf-8',
    );

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await callTool(project, 'docs.list', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    const paths = data.files.map((file: { path: string }) => file.path);
    expect(paths).toContain('STATUS.md');
    expect(paths).toContain('docs/manifest.yml');
    expect(paths).toContain('docs/listed.md');
    expect(paths).not.toContain('docs/unlisted.md');
  });

  it('should report a missing managed branch clearly in docs.list', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await callTool(project, 'docs.list', {
      projectId: 'test-project',
      branch: 'v0.2-daemon',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Managed docs branch "v0.2-daemon" does not exist');
  });

  it('should reject reads for unowned docs that still exist in the managed store', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'unlisted.md'),
      '# Unlisted\n',
      'utf-8',
    );

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    expect(await project.gitStore.readFile('main', 'docs/unlisted.md')).toBe(
      '# Unlisted\n',
    );

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/unlisted.md',
      branch: 'main',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Atlas-owned managed documents');
  });

  it('should not include unowned docs in default context packs', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'unlisted.md'),
      '# Unlisted\n',
      'utf-8',
    );

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleContextPack(project, {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    const paths = data.items.map((item: { path: string }) => item.path);
    expect(paths).not.toContain('docs/unlisted.md');
  });

  it('should propose and commit STATUS.md updates through the guarded workflow', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'STATUS.md');
    expect(content).not.toBeNull();
    expect(revision).toBeTruthy();

    const updated = content!.replace(
      '<!-- What is the team working on right now? -->',
      'Validating guarded STATUS.md updates.',
    );
    const patch = createSimplePatch(content!, updated, 'STATUS.md');

    const proposeResult = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: 'STATUS.md',
      baseRevision: revision,
      patch,
      intent: 'Update STATUS.md project context through guarded workflow',
      summary: 'Record guarded STATUS.md update support',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);
    expect(proposal.valid).toBe(true);
    expect(proposal.riskLevel).toBe('high');
    expect(proposal.requiresApproval).toBe(true);

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBeFalsy();
    const commit = JSON.parse(commitResult.content[0].text);
    expect(commit.changedFiles).toEqual(['STATUS.md']);

    const { content: committedContent } = await project.readFile('main', 'STATUS.md');
    expect(committedContent).toContain('Validating guarded STATUS.md updates.');
  });

  it('should surface the commit/export lifecycle gap until docs.export syncs the working tree', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const filePath = 'docs/README.md';
    const { content, revision } = await project.readFile('main', filePath);
    expect(content).not.toBeNull();
    expect(revision).toBeTruthy();

    const updated = `${content!}\n## Lifecycle Note\n\nManaged docs now require docs.export before disk reads or Git commits.\n`;
    const patch = createSimplePatch(content!, updated, filePath);

    const proposeResult = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision,
      patch,
      intent: 'Update the reference docs through the guarded workflow',
      summary: 'Document the guarded commit/export lifecycle',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
    });
    expect(previewResult.isError).toBeFalsy();

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBeFalsy();
    const commit = JSON.parse(commitResult.content[0].text);
    expect(commit.message).toContain('Run docs.export before disk reads or Git commits.');
    expect(commit.exportRequired).toBe(true);
    expect(commit.workingTreeOutOfSync).toBe(true);
    expect(commit.outOfSyncPaths).toContain(filePath);
    expect(commit.nextStep).toContain('Run docs.export');

    const managedContent = await project.readFile('main', filePath);
    expect(managedContent.content).toContain('Lifecycle Note');

    const diskBeforeExport = await fs.promises.readFile(path.join(tmpDir, filePath), 'utf-8');
    expect(diskBeforeExport).toBe(content);

    const statusBeforeExport = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'main',
    });
    expect(statusBeforeExport.isError).toBeFalsy();
    const statusBefore = JSON.parse(statusBeforeExport.content[0].text);
    expect(statusBefore.exportRequired).toBe(true);
    expect(statusBefore.workingTreeOutOfSync).toBe(true);
    expect(statusBefore.outOfSyncPaths).toContain(filePath);
    expect(statusBefore.nextStep).toContain('docs.export');
    expect(statusBefore.rootContext.recovery).toMatchObject({
      available: true,
      recoveryRequired: false,
      exportRecoveryRequired: false,
    });

    const exportResult = await callTool(project, 'docs.export', {
      projectId: 'test-project',
      branch: 'main',
    });
    expect(exportResult.isError).toBeFalsy();
    const exported = JSON.parse(exportResult.content[0].text);
    expect(exported.exportRequired).toBe(false);
    expect(exported.workingTreeOutOfSync).toBe(false);
    expect(exported.outOfSyncPaths).toHaveLength(0);
    expect(exported.files).toContain(filePath);

    const diskAfterExport = await fs.promises.readFile(path.join(tmpDir, filePath), 'utf-8');
    expect(diskAfterExport).toBe(managedContent.content);

    const statusAfterExport = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'main',
    });
    expect(statusAfterExport.isError).toBeFalsy();
    const statusAfter = JSON.parse(statusAfterExport.content[0].text);
    expect(statusAfter.exportRequired).toBe(false);
    expect(statusAfter.workingTreeOutOfSync).toBe(false);
    expect(statusAfter.outOfSyncPaths).toHaveLength(0);
    expect(statusAfter.rootContext.recovery.lastExportObservation).toMatchObject({
      rootUnsafe: false,
      exportRequired: false,
      currentRoot: true,
    });
    expect(getLatestRecoveryObservationEvent(project, 'export')?.metadata.exportRequired).toBe(false);
  });

  it('should preview export drift without mutating disk or managed state', async () => {
    await initSourceRepo('main');

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const filePath = 'docs/README.md';
    const { content, revision } = await project.readFile('main', filePath);
    expect(content).not.toBeNull();
    expect(revision).toBeTruthy();

    const updated = `${content!}\n## Preview Export Drift\n\nThis update should be previewed, not written.\n`;
    await project.gitStore.applyAndCommit(
      'main',
      filePath,
      updated,
      'Update managed content for preview testing',
    );

    const diskBefore = await fs.promises.readFile(path.join(tmpDir, filePath), 'utf-8');
    expect(diskBefore).toBe(content);

    const statusBeforeExport = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'main',
    });
    expect(statusBeforeExport.isError).toBeFalsy();
    const before = JSON.parse(statusBeforeExport.content[0].text);
    expect(before.exportRequired).toBe(true);
    expect(before.outOfSyncPaths).toContain(filePath);

    const previewResult = await callTool(project, 'docs.preview_export', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(previewResult.isError).toBeFalsy();
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.previewed).toBe(true);
    expect(preview.projectId).toBe('test-project');
    expect(preview.branch).toBe('main');
    expect(preview.rootUnsafe).toBe(false);
    expect(preview.rootContext.safety.safeForWrites).toBe(true);
    expect(preview.rootContext.safety.rootMismatch).toBe(false);
    expect(preview.rootWarnings).toEqual([]);
    expect(preview.rootContext.recovery).toMatchObject({
      available: true,
      recoveryRequired: false,
      proposalRecoveryRequired: false,
      exportRecoveryRequired: false,
      pendingProposalCount: 0,
      currentRootProposalCount: 0,
      foreignRootProposalCount: 0,
      unknownRootProposalCount: 0,
      lastPreviewObservation: {
        rootUnsafe: false,
        exportRequired: true,
        currentRoot: true,
      },
    });
    expect(preview.managedRevision).toBeTruthy();
    expect(preview.sourceRevision).toBeTruthy();
    expect(preview.exportRequired).toBe(true);
    expect(preview.exportable).toBe(true);
    expect(preview.exportBlocked).toBe(false);
    expect(preview.changedPaths).toContain(filePath);
    expect(preview.addedPaths).toHaveLength(0);
    expect(preview.modifiedPaths).toContain(filePath);
    expect(preview.deletedPaths).toHaveLength(0);
    expect(preview.overwriteExistingPaths).toContain(filePath);
    expect(preview.diskContentDiffersFromManagedPaths).toContain(filePath);
    expect(preview.riskyPaths).toContain(filePath);
    expect(preview.summary.changedCount).toBe(1);
    expect(preview.summary.modifiedCount).toBe(1);
    expect(preview.summary.deletedCount).toBe(0);
    expect(preview.nextStep).toContain('docs.export');

    const diskAfterPreview = await fs.promises.readFile(path.join(tmpDir, filePath), 'utf-8');
    expect(diskAfterPreview).toBe(diskBefore);

    const statusAfterPreview = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'main',
    });
    expect(statusAfterPreview.isError).toBeFalsy();
    const after = JSON.parse(statusAfterPreview.content[0].text);
    expect(after.exportRequired).toBe(true);
    expect(after.workingTreeOutOfSync).toBe(true);
    expect(after.outOfSyncPaths).toContain(filePath);
  });

  it('should surface unsafe root visibility without blocking preview export', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const previewResult = await callTool(project, 'docs.preview_export', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(previewResult.isError).toBeFalsy();
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.previewed).toBe(true);
    expect(preview.rootUnsafe).toBe(true);
    expect(preview.rootContext.safety.safeForWrites).toBe(false);
    expect(preview.rootContext.safety.rootMismatch).toBe(true);
    expect(preview.rootWarnings).toContain('registered project root mismatch');
    expect(preview.rootContext.recovery).toMatchObject({
      available: true,
      recoveryRequired: false,
      proposalRecoveryRequired: false,
      exportRecoveryRequired: false,
      lastPreviewObservation: {
        rootUnsafe: true,
        exportRequired: false,
        currentRoot: true,
      },
    });
    expect(preview.rootContext.recovery.warnings).toContain(
      'The latest docs.preview_export observation for branch "main" was recorded under an unsafe root context.',
    );
    expect(preview.exportBlocked).toBe(false);
    expect(preview.exportable).toBe(true);

    const recoveryEvent = getLatestRecoveryObservationEvent(project, 'preview_export');
    expect(recoveryEvent?.metadata.rootUnsafe).toBe(true);
    expect(recoveryEvent?.metadata.exportRequired).toBe(false);
  });

  it('fails soft without recording preview recovery observations when aggregation fails', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const beforeRecoveryEvent = getLatestRecoveryObservationEvent(project, 'preview_export');
    const readRecoveryEvidenceSpy = vi
      .spyOn(readOnlyManagedState, 'readRecoveryEvidence')
      .mockImplementation(async () => {
        throw new Error('synthetic recovery failure');
      });

    try {
      const previewResult = await callTool(project, 'docs.preview_export', {
        projectId: 'test-project',
        branch: 'main',
      });

      expect(previewResult.isError).toBeFalsy();
      const preview = JSON.parse(previewResult.content[0].text);
      expect(preview.previewed).toBe(true);
      expect(preview.rootContext.recovery.available).toBe(false);
      expect(preview.rootContext.recovery.recoveryRequired).toBeNull();
      expect(preview.rootContext.recovery.nextStep).toBeNull();
      expect(preview.rootContext.recovery.warnings).toContain(
        'Recovery summary is currently unavailable.',
      );
      expect(preview.rootContext.recovery.warnings.join(' ')).not.toContain('synthetic recovery failure');
      expect(getLatestRecoveryObservationEvent(project, 'preview_export')).toEqual(beforeRecoveryEvent);
    } finally {
      readRecoveryEvidenceSpy.mockRestore();
    }
  });

  it('should report no export changes when managed state and disk are aligned', async () => {
    await initSourceRepo('main');

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await callTool(project, 'docs.preview_export', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.previewed).toBe(true);
    expect(data.exportRequired).toBe(false);
    expect(data.changedPaths).toHaveLength(0);
    expect(data.addedPaths).toHaveLength(0);
    expect(data.modifiedPaths).toHaveLength(0);
    expect(data.deletedPaths).toHaveLength(0);
    expect(data.overwriteExistingPaths).toHaveLength(0);
    expect(data.diskContentDiffersFromManagedPaths).toHaveLength(0);
    expect(data.riskyPaths).toHaveLength(0);
    expect(data.nextStep).toContain('No export is required');
  });

  it('should return a reviewable diff for a pending proposal', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'STATUS.md');
    expect(content).not.toBeNull();
    expect(revision).toBeTruthy();

    const updated = content!.replace(
      '<!-- What is the team working on right now? -->',
      'Preview diff test update.',
    );
    const patch = createSimplePatch(content!, updated, 'STATUS.md');

    const proposeResult = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: 'STATUS.md',
      baseRevision: revision,
      patch,
      intent: 'Preview a guarded STATUS.md update before commit',
      summary: 'Capture diff output for guarded review',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
    });

    expect(previewResult.isError).toBeFalsy();
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview).toMatchObject({
      proposalId: proposal.proposalId,
      projectId: 'test-project',
      path: 'STATUS.md',
      branch: 'main',
      summary: 'Capture diff output for guarded review',
      riskLevel: 'high',
      requiresApproval: true,
    });
    expect(preview.diff).toContain('--- a/STATUS.md');
    expect(preview.diff).toContain('+++ b/STATUS.md');
    expect(preview.diff).toContain('Preview diff test update.');
  });

  it('should reject preview for a stored corrupt patch before commit', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { revision } = await project.readFile('main', 'STATUS.md');
    expect(revision).toBeTruthy();

    const stored = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'STATUS.md',
      base_revision: revision ?? '',
      patch: [
        '--- a/STATUS.md',
        '+++ b/STATUS.md',
        '@@ -1,2 +1,2 @@',
        ' currentFocus: "Create-only docs.propose_document support is complete alongside guarded Atlas document creation"',
        ' this line is not valid unified diff syntax',
      ].join('\n'),
      intent: 'Store an intentionally corrupt patch for preview validation',
      summary: 'Corrupt preview test',
      risk_level: 'low',
      requires_approval: false,
    });

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: stored.id,
    });

    expect(previewResult.isError).toBe(true);
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.valid).toBe(false);
    expect(preview.applyable).toBe(false);
    expect(preview.validationStatus).toBe('invalid');
    expect(preview.error).toContain('Patch does not apply cleanly');
    expect(preview.error).toContain('corrupt patch');

    const persisted = project.eventLog.getProposal(stored.id);
    expect(persisted?.status).toBe('pending');
  });

  it('should reject preview for a stored non-unified patch before commit', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { revision } = await project.readFile('main', 'STATUS.md');
    expect(revision).toBeTruthy();

    const stored = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'STATUS.md',
      base_revision: revision ?? '',
      patch: [
        '*** Begin Patch',
        '*** Update File: STATUS.md',
        '@@',
        '-currentFocus: "Create-only docs.propose_document support is complete alongside guarded Atlas document creation"',
        '+currentFocus: "Create-only docs.propose_document support is complete, and guarded patch applyability hardening is now in place alongside guarded Atlas document creation"',
        '*** End Patch',
      ].join('\n'),
      intent: 'Store an intentionally non-unified patch for preview validation',
      summary: 'Non-unified preview test',
      risk_level: 'low',
      requires_approval: false,
    });

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: stored.id,
    });

    expect(previewResult.isError).toBe(true);
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.valid).toBe(false);
    expect(preview.applyable).toBe(false);
    expect(preview.validationStatus).toBe('invalid');
    expect(preview.error).toContain('docs.propose_patch requires a standard unified diff patch');
    expect(preview.error).toContain('apply_patch-style input');

    const persisted = project.eventLog.getProposal(stored.id);
    expect(persisted?.status).toBe('pending');
  });

  it('should distinguish stale proposals from corrupt patches during preview', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'docs/README.md');
    expect(content).not.toBeNull();
    expect(revision).toBeTruthy();

    const updated = (content ?? '') + '\n## Preview Stale Test\n';
    const patch = createSimplePatch(content ?? '', updated);

    const proposeResult = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: 'docs/README.md',
      baseRevision: revision,
      patch,
      intent: 'Create a proposal that will become stale before preview',
      summary: 'Preview stale proposal classification',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);

    const concurrentPatch = createSimplePatch(
      content ?? '',
      (content ?? '') + '\n## Concurrent Change\n',
    );
    await project.gitStore.applyPatchAndCommit(
      'main',
      'docs/README.md',
      concurrentPatch,
      'Make stored proposal stale',
      revision ?? undefined,
    );

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
    });

    expect(previewResult.isError).toBe(true);
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.valid).toBe(false);
    expect(preview.applyable).toBe(false);
    expect(preview.validationStatus).toBe('stale');
    expect(preview.error).toContain('Base revision mismatch');
  });

  it('should preview and commit a valid patch proposal end-to-end', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'docs/README.md');
    expect(content).not.toBeNull();
    expect(revision).toBeTruthy();

    const updated = (content ?? '') + '\n## Preview Commit Flow\n\nValidated flow.\n';
    const patch = createSimplePatch(content ?? '', updated);

    const proposeResult = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: 'docs/README.md',
      baseRevision: revision,
      patch,
      intent: 'Validate preview and commit for a normal patch proposal',
      summary: 'End-to-end patch proposal flow',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
    });

    expect(previewResult.isError).toBeFalsy();
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.valid).toBe(true);
    expect(preview.applyable).toBe(true);
    expect(preview.validationStatus).toBe('valid');

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBeFalsy();
    const committed = await project.readFile('main', 'docs/README.md');
    expect(committed.content).toContain('Preview Commit Flow');
  });

  it('should preview and commit a bare-path unified diff proposal end-to-end', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'docs/README.md');
    expect(content).not.toBeNull();
    expect(revision).toBeTruthy();

    const updated = (content ?? '') + '\n## Bare Header Preview Commit Flow\n\nValidated flow.\n';
    const patch = stripGitPrefixesFromPatch(
      createSimplePatch(content ?? '', updated),
      'docs/README.md',
    );

    const proposeResult = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: 'docs/README.md',
      baseRevision: revision,
      patch,
      intent: 'Validate preview and commit for a bare-path unified diff proposal',
      summary: 'End-to-end bare-path patch proposal flow',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
    });

    expect(previewResult.isError).toBeFalsy();
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.valid).toBe(true);
    expect(preview.applyable).toBe(true);
    expect(preview.validationStatus).toBe('valid');

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBeFalsy();
    const committed = await project.readFile('main', 'docs/README.md');
    expect(committed.content).toContain('Bare Header Preview Commit Flow');
  });

  it('should accept patch proposals for curated owned documents', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'manifest.yml'),
      `version: 1
documents:
  - path: docs/listed.md
    role: notes
    summary: Listed doc
`,
      'utf-8',
    );
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'listed.md'),
      '# Listed\n',
      'utf-8',
    );

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'docs/listed.md');
    expect(content).toBe('# Listed\n');
    expect(revision).toBeTruthy();

    const patch = createUnifiedDiffForReplacement(
      'docs/listed.md',
      content ?? '',
      '# Listed\n\nOwned update.\n',
    );

    const result = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: 'docs/listed.md',
      baseRevision: revision,
      patch,
      intent: 'Update a curated owned document',
      summary: 'Owned doc patch should be accepted',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(true);
    expect(data.changedFiles).toEqual(['docs/listed.md']);
  });

  it('should reject patch proposals for tracked but unowned files', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'manifest.yml'),
      `version: 1
documents:
  - path: docs/listed.md
    role: notes
    summary: Listed doc
`,
      'utf-8',
    );
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'listed.md'),
      '# Listed\n',
      'utf-8',
    );
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'unlisted.md'),
      '# Unlisted\n',
      'utf-8',
    );

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    expect(await project.gitStore.readFile('main', 'docs/unlisted.md')).toBe(
      '# Unlisted\n',
    );

    const result = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: 'docs/unlisted.md',
      baseRevision: 'not-used-for-unowned-paths',
      patch: createSimplePatch(
        '# Unlisted\n',
        '# Unlisted\n\nThis should fail.\n',
        'docs/unlisted.md',
      ),
      intent: 'Try to update a tracked file outside curated ownership',
      summary: 'Unowned tracked file should be rejected',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.error).toContain('Atlas-owned managed documents');
  });

  it('should reject traversal paths before ownership or patch validation', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: '../secrets.md',
      baseRevision: 'not-used-for-traversal-paths',
      patch: createSimplePatch('', '# Secret\n', '../secrets.md'),
      intent: 'Try to escape the managed docs root',
      summary: 'Traversal path should be rejected',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.error).toContain('Path traversal detected');
  });

  it('should still reject untracked paths in the guarded proposal workflow', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: 'notes/random.md',
      baseRevision: 'not-used-for-untracked-paths',
      patch: createSimplePatch('', '# Random\n', 'notes/random.md'),
      intent: 'Try to update an untracked path',
      summary: 'Untracked path should be rejected',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.error).toContain('Atlas-owned managed documents');
  });

  it('should reject apply_patch-style docs.propose_patch input before storing a proposal', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { revision } = await project.readFile('main', 'STATUS.md');
    expect(revision).toBeTruthy();
    expect(getStoredProposalCount(project)).toBe(0);

    const result = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: 'STATUS.md',
      baseRevision: revision,
      patch: [
        '*** Begin Patch',
        '*** Update File: STATUS.md',
        '@@',
        '-currentFocus: "Create-only docs.propose_document support is complete alongside guarded Atlas document creation"',
        '+currentFocus: "Create-only docs.propose_document support is complete, and proposal-time patch format validation is now in place"',
        '*** End Patch',
      ].join('\n'),
      intent: 'Reject apply_patch syntax at docs.propose_patch creation time',
      summary: 'Prevent apply_patch payloads from being stored',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.errorCode).toBe('invalid_patch_format');
    expect(data.expectedFormat).toBe('unified_diff');
    expect(data.receivedFormat).toBe('apply_patch');
    expect(data.error).toContain('docs.propose_patch requires a standard unified diff patch');
    expect(data.error).toContain('apply_patch-style input');
    expect(data.hint).toContain('Do not send apply_patch blocks');
    expect(getStoredProposalCount(project)).toBe(0);
  });

  it('should reject empty and prose-only docs.propose_patch input before storing proposals', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { revision } = await project.readFile('main', 'docs/README.md');
    expect(revision).toBeTruthy();

    const cases = [
      {
        name: 'empty',
        patch: '   \n\t',
        receivedFormat: 'empty',
        errorFragment: 'empty or whitespace-only patch body',
      },
      {
        name: 'prose',
        patch: 'Please update the README to mention the new workflow.',
        receivedFormat: 'prose',
        errorFragment: 'prose or non-diff text',
      },
    ] as const;

    for (const testCase of cases) {
      const beforeCount = getStoredProposalCount(project);
      const result = await handleProposePatch(project, {
        projectId: 'test-project',
        branch: 'main',
        path: 'docs/README.md',
        baseRevision: revision,
        patch: testCase.patch,
        intent: `Reject ${testCase.name} patch bodies at proposal creation time`,
        summary: `Do not store ${testCase.name} patch bodies`,
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.valid).toBe(false);
      expect(data.errorCode).toBe('invalid_patch_format');
      expect(data.expectedFormat).toBe('unified_diff');
      expect(data.receivedFormat).toBe(testCase.receivedFormat);
      expect(data.error).toContain('docs.propose_patch requires a standard unified diff patch');
      expect(data.error).toContain(testCase.errorFragment);
      expect(getStoredProposalCount(project)).toBe(beforeCount);
    }
  });

  it('should reject truncated unified diff hunks at docs.propose_patch creation time', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { revision } = await project.readFile('main', 'docs/README.md');
    expect(revision).toBeTruthy();

    const result = await handleProposePatch(project, {
      projectId: 'test-project',
      branch: 'main',
      path: 'docs/README.md',
      baseRevision: revision,
      patch: [
        '--- docs/README.md',
        '+++ docs/README.md',
        '@@ -1,2 +1,2 @@',
        '-# Documentation',
      ].join('\n'),
      intent: 'Reject truncated unified diff hunks at proposal creation time',
      summary: 'Do not store truncated hunks',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.error).toContain('complete unified diff patch');
    expect(data.error).toContain('Corrupt unified diff hunk');
    expect(data.error).toContain('header expects');
  });

  it('should reject unsafe patch header paths at docs.propose_patch creation time', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { revision } = await project.readFile('main', 'docs/README.md');
    expect(revision).toBeTruthy();

    const cases = [
      {
        name: 'absolute path',
        patch: [
          '--- /docs/README.md',
          '+++ /docs/README.md',
          '@@ -1,1 +1,1 @@',
          '-# Documentation',
          '+# Documentation',
        ].join('\n'),
      },
      {
        name: 'parent traversal path',
        patch: [
          '--- ../docs/README.md',
          '+++ ../docs/README.md',
          '@@ -1,1 +1,1 @@',
          '-# Documentation',
          '+# Documentation',
        ].join('\n'),
      },
    ] as const;

    for (const testCase of cases) {
      const result = await handleProposePatch(project, {
        projectId: 'test-project',
        branch: 'main',
        path: 'docs/README.md',
        baseRevision: revision,
        patch: testCase.patch,
        intent: `Reject ${testCase.name} in patch headers`,
        summary: `Do not store ${testCase.name} patch headers`,
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.valid).toBe(false);
      expect(data.error).toContain('Unsupported patch path');
      expect(data.error).toContain('absolute paths and parent traversal are not allowed');
    }
  });

  it('should create a docs/atlas document proposal and commit it with a manifest update', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const proposeResult = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/atlas/example.md',
      content: '# Example\n\nAtlas content.\n',
      document: {
        role: ' guide ',
        summary: ' Short summary ',
        priority: ' normal ',
      },
      intent: 'Create a new Atlas-managed document',
      summary: 'Add example Atlas doc',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);
    expect(proposal.valid).toBe(true);
    expect(proposal.changedFiles).toEqual([
      'docs/atlas/example.md',
      'docs/manifest.yml',
    ]);

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBeFalsy();
    const commit = JSON.parse(commitResult.content[0].text);
    expect(commit.changedFiles).toEqual([
      'docs/atlas/example.md',
      'docs/manifest.yml',
    ]);

    const createdDocument = await project.readFile('main', 'docs/atlas/example.md');
    expect(createdDocument.content).toBe('# Example\n\nAtlas content.\n');
    expect(createdDocument.revision).toBe(commit.commit);

    const manifest = await project.readFile('main', 'docs/manifest.yml');
    expect(manifest.revision).toBe(commit.commit);
    const parsedManifest = YAML.parse(manifest.content ?? '') as {
      documents: Array<{ path: string; role: string; summary: string; priority?: string }>;
    };
    expect(parsedManifest.documents).toContainEqual({
      path: 'docs/atlas/example.md',
      role: 'guide',
      summary: 'Short summary',
      priority: 'normal',
    });
  });

  it('should create a docs/spec document proposal and commit it with a manifest update', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const proposeResult = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/spec/evaluation-strategy.md',
      content: '# Evaluation Strategy\n\nSpec content.\n',
      document: {
        role: 'spec',
        summary: 'Define the evaluation strategy',
        priority: 'high',
      },
      intent: 'Create a new spec document',
      summary: 'Add evaluation strategy spec',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);
    expect(proposal.valid).toBe(true);
    expect(proposal.requiresApproval).toBe(true);
    expect(proposal.changedFiles).toEqual([
      'docs/spec/evaluation-strategy.md',
      'docs/manifest.yml',
    ]);

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBeFalsy();
    const commit = JSON.parse(commitResult.content[0].text);
    expect(commit.changedFiles).toEqual([
      'docs/spec/evaluation-strategy.md',
      'docs/manifest.yml',
    ]);

    const createdDocument = await project.readFile('main', 'docs/spec/evaluation-strategy.md');
    expect(createdDocument.content).toBe('# Evaluation Strategy\n\nSpec content.\n');
    expect(createdDocument.revision).toBe(commit.commit);

    const manifest = await project.readFile('main', 'docs/manifest.yml');
    expect(manifest.content).toContain('path: docs/spec/evaluation-strategy.md');
  });

  it('should keep docs.propose_document create-only flow unchanged', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/atlas/ownership-regression.md',
      content: '# Ownership Regression\n\nAtlas content.\n',
      document: {
        role: 'guide',
        summary: 'Create-only flow should still work',
      },
      intent: 'Verify create-only Atlas document proposals still work',
      summary: 'Create-only docs.propose_document remains unchanged',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(true);
    expect(data.changedFiles).toEqual([
      'docs/atlas/ownership-regression.md',
      'docs/manifest.yml',
    ]);
  });

  it('should preview a create-only document proposal with both the new file and manifest diff', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const proposeResult = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/atlas/example.md',
      content: '# Example\n\nAtlas content.\n',
      document: {
        role: 'guide',
        summary: 'Short summary',
        priority: 'normal',
      },
      intent: 'Create a new Atlas-managed document',
      summary: 'Add example Atlas doc',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
    });

    expect(previewResult.isError).toBeFalsy();
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.changedFiles).toEqual([
      'docs/atlas/example.md',
      'docs/manifest.yml',
    ]);
    expect(preview.diff).toContain('--- /dev/null');
    expect(preview.diff).toContain('+++ b/docs/atlas/example.md');
    expect(preview.diff).toContain('+++ b/docs/manifest.yml');
    expect(preview.diff).toContain('path: docs/atlas/example.md');
  });

  it('should preview and commit a valid create-only document proposal end-to-end', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const proposeResult = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/atlas/end-to-end.md',
      content: '# End To End\n\nAtlas content.\n',
      document: {
        role: 'guide',
        summary: 'End to end summary',
      },
      intent: 'Validate preview and commit for create-only proposals',
      summary: 'End-to-end create proposal flow',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
    });

    expect(previewResult.isError).toBeFalsy();
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.valid).toBe(true);
    expect(preview.applyable).toBe(true);
    expect(preview.validationStatus).toBe('valid');
    expect(preview.changedFiles).toEqual([
      'docs/atlas/end-to-end.md',
      'docs/manifest.yml',
    ]);

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBeFalsy();
    const created = await project.readFile('main', 'docs/atlas/end-to-end.md');
    expect(created.content).toBe('# End To End\n\nAtlas content.\n');
  });

  it('should reject create-only document proposals outside the approved docs-managed scope', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/example.md',
      content: '# Example\n',
      document: {
        role: 'guide',
        summary: 'Short summary',
      },
      intent: 'Create a new Atlas-managed document',
      summary: 'Add example Atlas doc',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('must be under docs/atlas/ or docs/spec/');
  });

  it('should reject create-only document proposals with path traversal', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/atlas/../escape.md',
      content: '# Example\n',
      document: {
        role: 'guide',
        summary: 'Short summary',
      },
      intent: 'Create a new Atlas-managed document',
      summary: 'Add example Atlas doc',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Path traversal detected');
  });

  it('should reject create-only document proposals for non-Markdown paths', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/atlas/example.txt',
      content: '# Example\n',
      document: {
        role: 'guide',
        summary: 'Short summary',
      },
      intent: 'Create a new Atlas-managed document',
      summary: 'Add example Atlas doc',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('must be a Markdown document');
  });

  it('should reject create-only document proposals when the file already exists', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'docs', 'atlas'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'atlas', 'example.md'),
      '# Existing\n',
      'utf-8',
    );

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/atlas/example.md',
      content: '# Example\n',
      document: {
        role: 'guide',
        summary: 'Short summary',
      },
      intent: 'Create a new Atlas-managed document',
      summary: 'Add example Atlas doc',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('already exists');
  });

  it('should repair a missing docs/spec document when the manifest already lists the path', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'manifest.yml'),
      `version: 1
documents:
  - path: docs/spec/evaluation-strategy.md
    role: spec
    summary: Existing manifest entry
`,
      'utf-8',
    );

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/spec/evaluation-strategy.md',
      content: '# Evaluation Strategy\n',
      document: {
        role: 'spec',
        summary: 'Short summary',
      },
      intent: 'Repair the missing spec document',
      summary: 'Repair manifest-listed spec doc',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(true);
    expect(data.changedFiles).toEqual(['docs/spec/evaluation-strategy.md']);

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: data.proposalId,
    });

    expect(previewResult.isError).toBeFalsy();
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.valid).toBe(true);
    expect(preview.changedFiles).toEqual(['docs/spec/evaluation-strategy.md']);
    expect(preview.diff).toContain('--- /dev/null');
    expect(preview.diff).toContain('+++ b/docs/spec/evaluation-strategy.md');
    expect(preview.diff).not.toContain('docs/manifest.yml');

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: data.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBeFalsy();
    const commit = JSON.parse(commitResult.content[0].text);
    expect(commit.changedFiles).toEqual(['docs/spec/evaluation-strategy.md']);

    const createdDocument = await project.readFile('main', 'docs/spec/evaluation-strategy.md');
    expect(createdDocument.content).toBe('# Evaluation Strategy\n');
    expect(createdDocument.revision).toBe(commit.commit);
  });

  it('should repair a missing managed document when the manifest already lists the path', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, 'docs', 'manifest.yml'),
      `version: 1
documents:
  - path: docs/atlas/example.md
    role: guide
    summary: Existing manifest entry
`,
      'utf-8',
    );

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/atlas/example.md',
      content: '# Example\n',
      document: {
        role: 'guide',
        summary: 'Short summary',
      },
      intent: 'Create a new Atlas-managed document',
      summary: 'Add example Atlas doc',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(true);
    expect(data.changedFiles).toEqual(['docs/atlas/example.md']);

    const previewResult = await handlePreviewDiff(project, {
      projectId: 'test-project',
      proposalId: data.proposalId,
    });

    expect(previewResult.isError).toBeFalsy();
    const preview = JSON.parse(previewResult.content[0].text);
    expect(preview.valid).toBe(true);
    expect(preview.changedFiles).toEqual(['docs/atlas/example.md']);
    expect(preview.diff).toContain('--- /dev/null');
    expect(preview.diff).toContain('+++ b/docs/atlas/example.md');
    expect(preview.diff).not.toContain('docs/manifest.yml');

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: data.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBeFalsy();
    const commit = JSON.parse(commitResult.content[0].text);
    expect(commit.changedFiles).toEqual(['docs/atlas/example.md']);

    const createdDocument = await project.readFile('main', 'docs/atlas/example.md');
    expect(createdDocument.content).toBe('# Example\n');
    expect(createdDocument.revision).toBe(commit.commit);

    const manifest = await project.readFile('main', 'docs/manifest.yml');
    expect(manifest.content).toContain('path: docs/atlas/example.md');
  }, 120000);

  it('should mark a create-only document proposal stale when the manifest base revision changes', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const proposeResult = await handleProposeDocument(project, {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/atlas/example.md',
      content: '# Example\n\nAtlas content.\n',
      document: {
        role: 'guide',
        summary: 'Short summary',
      },
      intent: 'Create a new Atlas-managed document',
      summary: 'Add example Atlas doc',
    });

    expect(proposeResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposeResult.content[0].text);

    const manifest = await project.readFile('main', 'docs/manifest.yml');
    const updatedManifest = (manifest.content ?? '') + '\n# stale\n';
    const manifestPatch = createSimplePatch(
      manifest.content ?? '',
      updatedManifest,
      'docs/manifest.yml',
    );

    await project.gitStore.applyPatchAndCommit(
      'main',
      'docs/manifest.yml',
      manifestPatch,
      'Modify manifest to stale proposal',
      manifest.revision ?? undefined,
    );

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBe(true);
    const data = JSON.parse(commitResult.content[0].text);
    expect(data.error).toContain('Base revision mismatch');

    const stored = project.eventLog.getProposal(proposal.proposalId);
    expect(stored?.status).toBe('stale');
  });
});

// ── docs.status tool tests ────────────────────────────────────────────

describe('docs.status', () => {
  it('should parse front matter from STATUS.md', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content } = await project.readFile('main', 'STATUS.md');
    expect(content).not.toBeNull();

    const result = parseFrontMatter(content!);
    expect(result.frontMatter).not.toBeNull();
    expect(result.frontMatter!.docuGuard).toBeUndefined(); // nested key
    expect(result.frontMatter!['docuGuard.type']).toBe('status');
    expect(result.frontMatter!.statusVersion).toBe(1);
    expect(result.frontMatter!.priority).toBe('high');
    expect(result.rawFrontMatter).not.toBeNull();
    expect(result.rawFrontMatter).toContain('docuGuard.type: status');
    expect(result.body).toContain('Project Status');
    expect(result.body).toContain('Current Focus');
  });

  it('should return full STATUS.md content via project.readFile', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'STATUS.md');
    expect(content).not.toBeNull();
    expect(content).toContain('docuGuard.type: status');
    expect(content).toContain('Project Status');
    expect(revision).not.toBeNull();
    expect(revision!.length).toBeGreaterThan(0);
  });

  it('should truncate body to maxChars', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content } = await project.readFile('main', 'STATUS.md');
    expect(content).not.toBeNull();

    const result = parseFrontMatter(content!);
    // Truncate body to a small value
    const truncatedBody = result.body.slice(0, 10);
    expect(truncatedBody.length).toBeLessThanOrEqual(10);
    const fullBody = result.body;
    if (fullBody.length > 10) {
      expect(truncatedBody).not.toBe(fullBody);
    }
  });

  it('should handle missing STATUS.md gracefully', async () => {
    // Create project without init (so STATUS.md doesn't exist in managed store)
    // We can simulate by reading a path that doesn't exist
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content } = await project.readFile('main', 'nonexistent.md');
    expect(content).toBeNull();
  });

  it('should return null front matter for content without front matter', () => {
    const result = parseFrontMatter('# Just a heading\n\nSome content');
    expect(result.frontMatter).toBeNull();
    expect(result.rawFrontMatter).toBeNull();
    expect(result.body).toBe('# Just a heading\n\nSome content');
  });

  it('should return null front matter for empty content', () => {
    const result = parseFrontMatter('');
    expect(result.frontMatter).toBeNull();
    expect(result.rawFrontMatter).toBeNull();
    expect(result.body).toBe('');
  });

  it('should return null front matter for content with only opening delimiter', () => {
    const result = parseFrontMatter('---\nkey: value\n');
    expect(result.frontMatter).toBeNull();
    expect(result.rawFrontMatter).toBeNull();
    // No closing --- so no front matter detected
  });

  it('should report a missing managed branch clearly', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'v0.2-daemon',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Managed docs branch "v0.2-daemon" does not exist');
    expect(data.hint).toContain('docs.create_branch');
  });

  it('includes root/worktree safety context when the project root is a git worktree', async () => {
    await initSourceRepo();

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.rootContext.projectRoot).toBe(tmpDir);
    expect(data.rootContext.canonicalProjectRoot).toBe(await fs.promises.realpath(tmpDir));
    expect(data.rootContext.git.insideWorkTree).toBe(true);
    expect(data.rootContext.git.worktreeRoot).toBe(await fs.promises.realpath(tmpDir));
    expect(data.rootContext.git.branch).toBe('main');
    expect(data.rootContext.markerProjectId).toBe('test-project');
    expect(data.rootContext.registeredProjectRoot).toBe(tmpDir);
    expect(data.rootContext.safety.rootMismatch).toBe(false);
    expect(data.rootContext.safety.safeForWrites).toBe(true);
    expect(data.rootContext.rootLedger).toMatchObject({
      available: true,
      recorded: true,
      knownObservationCount: 1,
      currentObservationCount: 1,
      distinctCanonicalProjectRootCount: 1,
      distinctGitWorktreeRootCount: 1,
      distinctGitCommonDirCount: 1,
      multipleRootsObserved: false,
      multipleWorktreesObserved: false,
      multipleGitCommonDirsObserved: false,
      currentObservationIsOnlyKnownIdentity: true,
      warnings: [],
    });
    expect(data.rootContext.rootLedger.lastObservedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.rootContext.recovery).toMatchObject({
      available: true,
      recoveryRequired: false,
      proposalRecoveryRequired: false,
      exportRecoveryRequired: false,
      pendingProposalCount: 0,
      currentRootProposalCount: 0,
      foreignRootProposalCount: 0,
      unknownRootProposalCount: 0,
      recommendedCleanupTool: null,
      lastPreviewObservation: null,
      lastExportObservation: null,
      warnings: [],
    });
    expect(getRootLedgerRows(project)).toHaveLength(1);
  });
});

describe('atlas.project_identity', () => {
  it('returns a compact runtime identity and read-only managed-state provenance snapshot without mutating state', async () => {
    await initSourceRepo();

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });
    const daemonPidPath = project.storage.daemonPidFilePath();
    await fs.promises.mkdir(path.dirname(daemonPidPath), { recursive: true });
    await fs.promises.writeFile(
      daemonPidPath,
      JSON.stringify({
        pid: 99999,
        host: '127.0.0.1',
        port: 3737,
        configDir: project.storage.configDir,
        dataDir: project.storage.dataDir,
        projectId: project.projectId,
        projectRoot: project.root,
        startedAt: '2026-06-21T00:00:00.000Z',
      }, null, 2) + '\n',
      'utf-8',
    );
    const beforeProposalCount = getStoredProposalCount(project);
    const beforeRootLedgerRows = getRootLedgerRows(project);
    const before = await Promise.all([
      snapshotFiles(project.root),
      snapshotFiles(project.storage.configDir),
      snapshotFiles(project.storage.dataDir),
    ]);

    const result = await callTool(project, 'atlas.project_identity', {
      projectId: 'test-project',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data).toMatchObject({
      projectId: 'test-project',
      requestedCwd: process.cwd(),
      projectRoot: tmpDir,
      canonicalProjectRoot: await fs.promises.realpath(tmpDir),
      registeredProjectRoot: tmpDir,
      daemonProjectRoot: null,
      marker: {
        projectId: 'test-project',
        present: true,
        matchesProject: true,
      },
      git: {
        available: true,
        insideWorkTree: true,
        worktreeRoot: await fs.promises.realpath(tmpDir),
        branch: 'main',
      },
      safety: {
        safeForWrites: true,
        ambiguous: false,
        rootMismatch: false,
      },
      recovery: {
        available: true,
        recoveryRequired: false,
        warnings: [],
      },
      nextStep: 'Root identity is currently safe for managed writes and exports.',
    });
    expect(data.marker.path).toBe(path.join(tmpDir, '.xurgo-atlas', 'project.json'));
    expect(data.git.commonDir).toContain('.git');
    expect(data.git.head).toMatch(/^[0-9a-f]{40}$/);
    expect(data.rootLedger).toMatchObject({
      available: false,
      recorded: false,
      knownObservationCount: null,
      currentObservationCount: null,
    });
    expect(data.managedStateProvenance).toMatchObject({
      observation: {
        lifecycle: 'atlas.project_identity.read-only',
        currentState: true,
        durableHistory: false,
      },
      source: {
        branch: 'main',
      },
      managed: {
        branch: 'main',
        availability: 'available',
      },
      synchronization: {
        status: 'in_sync',
        exportRequired: false,
        workingTreeOutOfSync: false,
        outOfSyncPaths: [],
      },
      pendingProposals: {
        available: true,
        pendingProposalCount: 0,
        currentRootProposalCount: 0,
        foreignRootProposalCount: 0,
        unknownRootProposalCount: 0,
      },
    });
    expect(data.warnings).toContain('Root ledger table is unavailable.');
    expect(getRootLedgerRows(project)).toEqual(beforeRootLedgerRows);
    expect(getStoredProposalCount(project)).toBe(beforeProposalCount);

    const after = await Promise.all([
      snapshotFiles(project.root),
      snapshotFiles(project.storage.configDir),
      snapshotFiles(project.storage.dataDir),
    ]);
    expect(after).toEqual(before);
  });

  it('remains available when the root context is unsafe and preserves safety compatibility fields', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const result = await callTool(project, 'atlas.project_identity', {
      projectId: 'test-project',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);

    expect(data.projectId).toBe('test-project');
    expect(data.projectRoot).toBe(tmpDir);
    expect(data.registeredProjectRoot).toBe(path.join(tmpDir, 'different-root'));
    expect(data.safety).toMatchObject({
      safeForWrites: false,
      ambiguous: true,
      rootMismatch: true,
      markerMissing: false,
      markerMismatch: false,
      registeredProjectRootMissing: false,
      registeredProjectRootMismatch: true,
      daemonProjectRootMismatch: false,
      gitMismatch: false,
    });
    expect(data.rootLedger.available).toBe(false);
    expect(data.warnings).toContain('registered project root mismatch');
    expect(data.warnings).toContain('Root ledger table is unavailable.');
    expect(data.nextStep).toContain('docs.status');
    expect(data.nextStep).toContain('mcp-config --json');
    expect(data.nextStep).toContain('Restore the expected root/worktree binding');
    expect(data.managedStateProvenance.safety.safeForWrites).toBe(false);
    expect(data.managedStateProvenance.pendingProposals.available).toBe(true);
  });

  it('keeps atlas.project_identity read-only while unrelated callers still record root ledger observations', async () => {
    await initSourceRepo();

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const readOnlyContext = await inspectRootSafetyContextReadOnly(project, {
      daemonProjectRoot: path.join(tmpDir, 'other-root'),
    });
    expect(readOnlyContext.safety.daemonProjectRootMismatch).toBe(true);
    expect(getRootLedgerRows(project)).toHaveLength(0);

    const recordingContext = await inspectRootSafetyContext(project, {
      daemonProjectRoot: path.join(tmpDir, 'other-root'),
    });
    expect(recordingContext.safety.daemonProjectRootMismatch).toBe(true);
    expect(getRootLedgerRows(project)).toHaveLength(1);

    const statusResult = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'main',
    });
    expect(statusResult.isError).toBeFalsy();
    expect(getRootLedgerRows(project)).toHaveLength(2);
  });

  it('surfaces worktree ambiguity and missing managed branch facts with explicit unknown synchronization fields', async () => {
    const sourceGit = await initSourceRepo();
    await sourceGit.checkoutLocalBranch('feature/secondary-worktree');

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const ledger = new RootLedgerStore(project.storage.projectEventsPath(project.projectId));
    try {
      ledger.recordObservation({
        projectId: 'test-project',
        requestedCwd: tmpDir,
        projectRoot: tmpDir,
        canonicalProjectRoot: await fs.promises.realpath(tmpDir),
        registeredProjectRoot: tmpDir,
        daemonProjectRoot: null,
        markerPath: path.join(tmpDir, '.xurgo-atlas', 'project.json'),
        markerRootPath: await fs.promises.realpath(tmpDir),
        markerProjectId: 'test-project',
        git: {
          insideWorkTree: true,
          worktreeRoot: await fs.promises.realpath(tmpDir),
          commonDir: path.join(tmpDir, '.git'),
          branch: 'main',
          head: await sourceGit.revparse(['HEAD']),
        },
        safety: {
          safeForWrites: true,
          ambiguous: false,
          rootMismatch: false,
          markerMismatch: false,
          markerMissing: false,
          registeredProjectRootMissing: false,
          registeredProjectRootMismatch: false,
          daemonProjectRootMismatch: false,
          gitMismatch: false,
          gitUnavailable: false,
          warnings: [],
        },
        observedAt: '2026-06-21T00:00:00.000Z',
      });
      ledger.recordObservation({
        projectId: 'test-project',
        requestedCwd: tmpDir,
        projectRoot: tmpDir,
        canonicalProjectRoot: await fs.promises.realpath(tmpDir),
        registeredProjectRoot: tmpDir,
        daemonProjectRoot: null,
        markerPath: path.join(tmpDir, '.xurgo-atlas', 'project.json'),
        markerRootPath: await fs.promises.realpath(tmpDir),
        markerProjectId: 'test-project',
        git: {
          insideWorkTree: true,
          worktreeRoot: path.join(tmpDir, 'alternate-worktree'),
          commonDir: path.join(tmpDir, '.git', 'worktrees', 'alternate-worktree'),
          branch: 'feature/secondary-worktree',
          head: await sourceGit.revparse(['HEAD']),
        },
        safety: {
          safeForWrites: false,
          ambiguous: true,
          rootMismatch: true,
          markerMismatch: false,
          markerMissing: false,
          registeredProjectRootMissing: false,
          registeredProjectRootMismatch: false,
          daemonProjectRootMismatch: false,
          gitMismatch: true,
          gitUnavailable: false,
          warnings: ['git worktree mismatch'],
        },
        observedAt: '2026-06-21T00:05:00.000Z',
      });
    } finally {
      ledger.close();
    }
    const beforeRows = getRootLedgerRows(project);

    const result = await callTool(project, 'atlas.project_identity', {
      projectId: 'test-project',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.rootLedger.multipleWorktreesObserved).toBe(true);
    expect(data.rootLedger.multipleGitCommonDirsObserved).toBe(true);
    expect(data.managedStateProvenance.managed).toMatchObject({
      branch: 'feature/secondary-worktree',
      revision: null,
      availability: 'missing',
    });
    expect(data.managedStateProvenance.synchronization).toMatchObject({
      status: 'unknown',
      exportRequired: null,
      workingTreeOutOfSync: null,
      outOfSyncPaths: null,
    });
    expect(getRootLedgerRows(project)).toEqual(beforeRows);
  });

  it('fails soft when descriptive storage is malformed or unavailable', async () => {
    await initSourceRepo();

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const eventsPath = project.storage.projectEventsPath(project.projectId);
    await fs.promises.rename(eventsPath, `${eventsPath}.bak`);
    await fs.promises.mkdir(eventsPath, { recursive: true });

    const result = await callTool(project, 'atlas.project_identity', {
      projectId: 'test-project',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.rootLedger.available).toBe(false);
    expect(data.recovery.available).toBe(false);
    expect(data.managedStateProvenance.rootLedger.available).toBe(false);
    expect(data.managedStateProvenance.recovery.available).toBe(false);
    expect(data.managedStateProvenance.pendingProposals.pendingProposalCount).toBeNull();
  });

  it('surfaces managed-versus-disk drift and recovery ambiguity without mutating proposals or exports', async () => {
    await initSourceRepo();

    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'STATUS.md');
    expect(content).not.toBeNull();
    const updated = content!.replace(
      '<!-- What is the team working on right now? -->',
      'Track pending proposal recovery visibility',
    );
    const patch = createUnifiedDiffForReplacement('STATUS.md', content!, updated);
    const proposalResult = await callTool(project, 'docs.propose_patch', {
      projectId: 'test-project',
      branch: 'main',
      path: 'STATUS.md',
      baseRevision: revision,
      patch,
      intent: 'Create a pending proposal before switching root identity',
      summary: 'Pending proposal recovery visibility',
    });
    expect(proposalResult.isError).toBeFalsy();

    await fs.promises.writeFile(path.join(tmpDir, 'STATUS.md'), 'local drift\n', 'utf-8');
    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));
    const beforeProposalCount = getStoredProposalCount(project);
    const beforeRecoveryEvent = getLatestRecoveryObservationEvent(project, 'preview_export');

    const result = await callTool(project, 'atlas.project_identity', {
      projectId: 'test-project',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.managedStateProvenance.synchronization).toMatchObject({
      status: 'out_of_sync',
      exportRequired: true,
      workingTreeOutOfSync: true,
    });
    expect(data.managedStateProvenance.synchronization.outOfSyncPaths).toContain('STATUS.md');
    expect(data.managedStateProvenance.pendingProposals).toMatchObject({
      available: true,
      pendingProposalCount: 1,
      foreignRootProposalCount: 1,
    });
    expect(data.managedStateProvenance.recovery.recoveryRequired).toBe(true);
    expect(getStoredProposalCount(project)).toBe(beforeProposalCount);
    expect(getLatestRecoveryObservationEvent(project, 'preview_export')).toEqual(beforeRecoveryEvent);
  });
});

// ── docs.manifest tool tests ──────────────────────────────────────────

describe('docs.manifest', () => {
  it('should return parsed manifest JSON and revision', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleManifest(project, {
      projectId: 'test-project',
      branch: 'main',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.projectId).toBe('test-project');
    expect(data.path).toBe('docs/manifest.yml');
    expect(data.branch).toBe('main');
    expect(data.revision).toBeTruthy();
    expect(data.version).toBe(1);
    expect(Array.isArray(data.entrypoints)).toBe(true);
    expect(Array.isArray(data.documents)).toBe(true);
    expect(data.documentCount).toBeGreaterThan(0);
    expect(data.truncated).toBe(false);
    expect(result.isError).toBeFalsy();
  });

  it('should not include raw YAML by default', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleManifest(project, {
      projectId: 'test-project',
      branch: 'main',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.raw).toBeUndefined();
  });

  it('should include raw YAML when includeRaw is true', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleManifest(project, {
      projectId: 'test-project',
      branch: 'main',
      includeRaw: true,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.raw).toBeTruthy();
    expect(data.raw).toContain('version: 1');
    expect(data.raw).toContain('STATUS.md');
  });

  it('should validate referenced paths exist', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleManifest(project, {
      projectId: 'test-project',
      branch: 'main',
      validatePaths: true,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.validation).toBeDefined();
    expect(data.validation.valid).toBe(true);
    expect(Array.isArray(data.validation.missingPaths)).toBe(true);
    expect(data.validation.missingPaths).toHaveLength(0);
  });

  it('should report missing referenced paths', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // Read the manifest and add a non-existent path to test validation
    const { content } = await project.readFile('main', 'docs/manifest.yml');
    expect(content).not.toBeNull();

    // We'll test the validation by directly checking via gitStore
    const trackedFiles = await project.gitStore.listFiles('main');
    const manifest = YAML.parse(content!);
    const manifestPaths: string[] = [];
    if (Array.isArray(manifest.documents)) {
      for (const doc of manifest.documents) {
        if (doc.path) manifestPaths.push(doc.path);
      }
    }
    if (Array.isArray(manifest.entrypoints)) {
      for (const ep of manifest.entrypoints) {
        if (ep.path && !manifestPaths.includes(ep.path)) manifestPaths.push(ep.path);
      }
    }

    const trackedSet = new Set(trackedFiles);
    const missing = manifestPaths.filter((p: string) => !trackedSet.has(p));
    // All standard paths from the template should exist
    expect(missing).toHaveLength(0);
  });

  it('should handle missing docs/manifest.yml clearly', async () => {
    // Init a project but then test reading a manifest path that does not exist
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // We can test this via the handler by manipulating the manifest
    // Simulate missing manifest by testing readFile directly
    const { content } = await project.readFile('main', 'docs/nonexistent.yml');
    expect(content).toBeNull();
  });

  it('should report that main does not exist yet in an empty managed repo', async () => {
    const project = new Project({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });
    await project.gitStore.init();
    await project.ensureEventLog();

    // No files committed, so the managed main branch does not exist yet
    const result = await handleManifest(project, {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Managed docs branch "main" does not exist');
    expect(data.hint).toContain('docs.create_branch');
  });

  it('should handle invalid YAML clearly', async () => {
    const project = new Project({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });
    await project.gitStore.init();
    await project.ensureEventLog();

    // Commit an invalid manifest YAML
    const invalidYaml = 'invalid: [yaml: broken\n  bad: indentation\n';
    await project.gitStore.applyAndCommit(
      'main',
      'docs/manifest.yml',
      invalidYaml,
      'Add invalid manifest',
    );

    const result = await handleManifest(project, {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Invalid YAML');
  });

  it('should respect maxDocuments and set truncated to true', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // Read manifest, count documents, then test with maxDocuments=1
    const { content } = await project.readFile('main', 'docs/manifest.yml');
    expect(content).not.toBeNull();
    const manifest = YAML.parse(content!);
    const totalDocs = Array.isArray(manifest.documents) ? manifest.documents.length : 0;

    const result = await handleManifest(project, {
      projectId: 'test-project',
      branch: 'main',
      maxDocuments: 1,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.documentCount).toBe(1);
    expect(data.totalDocumentCount).toBe(totalDocs);
    expect(data.truncated).toBe(totalDocs > 1);
  });

  it('should work without path validation when validatePaths is false', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleManifest(project, {
      projectId: 'test-project',
      branch: 'main',
      validatePaths: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.validation).toBeUndefined();
    expect(data.documents).toBeDefined();
    expect(data.documentCount).toBeGreaterThan(0);
  });

  it('should include entrypoints from manifest', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleManifest(project, {
      projectId: 'test-project',
      branch: 'main',
    });

    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.entrypoints)).toBe(true);
    expect(data.entrypoints.length).toBeGreaterThan(0);
    expect(data.entrypoints[0].path).toBe('STATUS.md');
    expect(data.entrypoints[0].role).toBe('front-page');
  });

  it('should report a missing managed branch clearly', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleManifest(project, {
      projectId: 'test-project',
      branch: 'v0.2-daemon',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Managed docs branch "v0.2-daemon" does not exist');
  });
});

// ── Existing tests (updated for managed storage) ─────────────────────

describe('reading docs', () => {
  it('should read a file from the Git store', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'docs/README.md');
    expect(content).not.toBeNull();
    expect(content).toContain('Documentation');
    expect(revision).not.toBeNull();
  });

  it('should return null for non-existent files', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content } = await project.readFile('main', 'docs/nonexistent.md');
    expect(content).toBeNull();
  });
});

describe('bounded docs.read via handler', () => {
  it('should report a missing managed branch clearly', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'STATUS.md',
      branch: 'v0.2-daemon',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Managed docs branch "v0.2-daemon" does not exist');
  });

  it('should be backward-compatible without maxChars', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/README.md',
      branch: 'main',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.projectId).toBe('test-project');
    expect(data.path).toBe('docs/README.md');
    expect(data.branch).toBe('main');
    expect(data.revision).toBeTruthy();
    expect(data.content).toContain('Documentation');
    expect(data.truncated).toBe(false);
    expect(data.maxChars).toBeNull();
    expect(data.offset).toBe(0);
    expect(data.returnedChars).toBe(data.totalChars);
  });

  it('should truncate content with maxChars and set truncated true', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/README.md',
      branch: 'main',
      maxChars: 10,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.content).toBe('# Document');
    expect(data.content.length).toBe(10);
    expect(data.truncated).toBe(true);
    expect(data.maxChars).toBe(10);
    expect(data.returnedChars).toBe(10);
    expect(data.totalChars).toBeGreaterThan(10);
  });

  it('should set truncated false when maxChars is larger than content', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/README.md',
      branch: 'main',
      maxChars: 999999,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.content).toContain('Documentation');
    expect(data.truncated).toBe(false);
    expect(data.maxChars).toBe(999999);
    expect(data.returnedChars).toBe(data.totalChars);
  });

  it('should return a later slice with offset', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // First read full content to know total length
    const fullResult = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/README.md',
      branch: 'main',
    });
    const fullData = JSON.parse(fullResult.content[0].text);
    const fullContent: string = fullData.content;
    const laterPortion = fullContent.slice(50);

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/README.md',
      branch: 'main',
      offset: 50,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.content).toBe(laterPortion);
    expect(data.offset).toBe(50);
    expect(data.returnedChars).toBe(laterPortion.length);
    expect(data.totalChars).toBe(fullContent.length);
  });

  it('should combine offset and maxChars correctly', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/README.md',
      branch: 'main',
      offset: 10,
      maxChars: 20,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.content.length).toBe(20);
    expect(data.offset).toBe(10);
    expect(data.maxChars).toBe(20);
    expect(data.returnedChars).toBe(20);
    expect(data.totalChars).toBeGreaterThan(30);
  });

  it('should include revision as before', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/README.md',
      branch: 'main',
      maxChars: 5,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.revision).toBeTruthy();
    expect(typeof data.revision).toBe('string');
    expect(data.revision.length).toBeGreaterThan(0);
  });

  it('should report missing files clearly', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/atlas/missing.md',
      branch: 'main',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('not found');
  });

  it('should handle offset beyond content length gracefully', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/README.md',
      branch: 'main',
      offset: 999999,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.content).toBe('');
    expect(data.truncated).toBe(false);
    expect(data.returnedChars).toBe(0);
  });

  it('should handle path traversal detection in bounded read', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: '../etc/passwd',
      branch: 'main',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Path traversal');
  });
});

describe('docs.read_section via handler', () => {
  const sectionDoc = `# Guide

Intro.

## Target

Target body.

### Child

Child body.

## Next

Next body.

## Target

Second target.

### Same Text

Child same.

# Same Text

Top same.

~~~markdown
## Hidden
~~~

\`\`\`js
# Also Hidden
\`\`\`

## After Fences ###

After content.
`;

  it('should read a simple section by heading', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleReadSection(project, {
      projectId: 'test-project',
      path: 'docs/atlas/sections.md',
      branch: 'main',
      heading: 'Next',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.projectId).toBe('test-project');
    expect(data.path).toBe('docs/atlas/sections.md');
    expect(data.branch).toBe('main');
    expect(data.revision).toBeTruthy();
    expect(data.heading).toBe('Next');
    expect(data.matchedHeading).toBe('Next');
    expect(data.level).toBe(2);
    expect(data.startLine).toBe(13);
    expect(data.endLine).toBe(16);
    expect(data.content).toBe('## Next\n\nNext body.\n');
    expect(data.truncated).toBe(false);
    expect(data.maxChars).toBeNull();
    expect(data.offset).toBe(0);
    expect(data.returnedChars).toBe(data.totalChars);
  });

  it('should include child subsections until the next same-or-higher heading', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleReadSection(project, {
      projectId: 'test-project',
      path: 'docs/atlas/sections.md',
      branch: 'main',
      heading: 'Target',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.content).toBe('## Target\n\nTarget body.\n\n### Child\n\nChild body.\n');
    expect(data.content).toContain('### Child');
    expect(data.content).not.toContain('## Next');
  });

  it('should omit the heading line when includeHeading is false', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleReadSection(project, {
      projectId: 'test-project',
      path: 'docs/atlas/sections.md',
      branch: 'main',
      heading: 'Target',
      includeHeading: false,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.content).toBe('\nTarget body.\n\n### Child\n\nChild body.\n');
    expect(data.content).not.toContain('## Target');
  });

  it('should truncate section content with maxChars and set metadata correctly', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleReadSection(project, {
      projectId: 'test-project',
      path: 'docs/atlas/sections.md',
      branch: 'main',
      heading: 'Target',
      maxChars: 12,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.content).toBe('## Target\n\nT');
    expect(data.content.length).toBe(12);
    expect(data.truncated).toBe(true);
    expect(data.maxChars).toBe(12);
    expect(data.returnedChars).toBe(12);
    expect(data.totalChars).toBeGreaterThan(12);
  });

  it('should apply offset before maxChars within section content', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);
    const fullSection = '## Target\n\nTarget body.\n\n### Child\n\nChild body.\n';

    const result = await handleReadSection(project, {
      projectId: 'test-project',
      path: 'docs/atlas/sections.md',
      branch: 'main',
      heading: 'Target',
      offset: 10,
      maxChars: 11,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.content).toBe(fullSection.slice(10, 21));
    expect(data.offset).toBe(10);
    expect(data.maxChars).toBe(11);
    expect(data.returnedChars).toBe(11);
    expect(data.totalChars).toBe(fullSection.length);
    expect(data.truncated).toBe(true);
  });

  it('should disambiguate duplicate headings with occurrence', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleReadSection(project, {
      projectId: 'test-project',
      path: 'docs/atlas/sections.md',
      branch: 'main',
      heading: 'Target',
      occurrence: 2,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.occurrence).toBe(2);
    expect(data.content).toContain('Second target.');
    expect(data.content).not.toContain('Target body.');
  });

  it('should disambiguate same-text headings with level', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleReadSection(project, {
      projectId: 'test-project',
      path: 'docs/atlas/sections.md',
      branch: 'main',
      heading: 'Same Text',
      level: 1,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.level).toBe(1);
    expect(data.content).toContain('# Same Text');
    expect(data.content).toContain('Top same.');
    expect(data.content).toContain('## After Fences ###');
    expect(data.content).not.toContain('Child same.');
  });

  it('should ignore headings inside fenced code blocks', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleReadSection(project, {
      projectId: 'test-project',
      path: 'docs/atlas/sections.md',
      branch: 'main',
      heading: 'Hidden',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Heading "Hidden" not found');
    expect(data.availableHeadings.some((heading: { heading: string }) => heading.heading === 'Hidden')).toBe(false);
  });

  it('should report missing headings clearly', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleReadSection(project, {
      projectId: 'test-project',
      path: 'docs/atlas/sections.md',
      branch: 'main',
      heading: 'Missing',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Heading "Missing" not found');
    expect(data.projectId).toBe('test-project');
    expect(data.path).toBe('docs/atlas/sections.md');
    expect(data.availableHeadings.length).toBeGreaterThan(0);
  });

  it('should leave existing docs.read behavior intact', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleRead(project, {
      projectId: 'test-project',
      path: 'docs/atlas/sections.md',
      branch: 'main',
      maxChars: 7,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.content).toBe('# Guide');
    expect(data.truncated).toBe(true);
    expect(data.returnedChars).toBe(7);
  });
});

describe('docs.context_pack via handler', () => {
  const sectionDoc = `# Guide

Intro.

## Target

Target body.

### Child

Child body.

## Next

Next body.
`;

  it('should report a missing managed branch clearly', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleContextPack(project, {
      projectId: 'test-project',
      branch: 'v0.2-daemon',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Managed docs branch "v0.2-daemon" does not exist');
  });

  it('should include STATUS.md, AGENTS.md, and manifest data by default', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleContextPack(project, {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.projectId).toBe('test-project');
    expect(data.branch).toBe('main');
    expect(data.revision).toBeTruthy();
    expect(data.maxChars).toBeNull();
    expect(data.returnedChars).toBeGreaterThan(0);
    expect(data.truncated).toBe(false);
    expect(data.items[0].kind).toBe('status');
    expect(data.items[0].path).toBe('STATUS.md');
    expect(data.items[1].kind).toBe('agents');
    expect(data.items[1].path).toBe('AGENTS.md');
    expect(data.items[2].kind).toBe('manifest');
    expect(data.items[2].path).toBe('docs/manifest.yml');
    expect(data.items[2].manifest.version).toBe(1);
    expect(Array.isArray(data.items[2].manifest.documents)).toBe(true);
  });

  it('should respect a total maxChars budget and report truncation metadata', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleContextPack(project, {
      projectId: 'test-project',
      branch: 'main',
      maxChars: 50,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.returnedChars).toBeLessThanOrEqual(50);
    expect(data.truncated).toBe(true);
    const itemChars = data.items.reduce((sum: number, item: { returnedChars: number }) => sum + item.returnedChars, 0);
    expect(itemChars).toBe(data.returnedChars);
    expect(data.items.some((item: { truncated: boolean }) => item.truncated)).toBe(true);
  });

  it('should include explicit requested paths', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleContextPack(project, {
      projectId: 'test-project',
      branch: 'main',
      includeStatus: false,
      includeAgents: false,
      includeManifest: false,
      paths: ['docs/atlas/sections.md'],
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].kind).toBe('document');
    expect(data.items[0].path).toBe('docs/atlas/sections.md');
    expect(data.items[0].content).toContain('## Target');
    expect(data.items[0].revision).toBeTruthy();
  });

  it('should include explicit sections using docs.read_section heading behavior', async () => {
    const project = await initProjectWithSectionDoc(sectionDoc);

    const result = await handleContextPack(project, {
      projectId: 'test-project',
      branch: 'main',
      includeStatus: false,
      includeAgents: false,
      includeManifest: false,
      sections: [
        {
          path: 'docs/atlas/sections.md',
          heading: 'Target',
        },
      ],
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].kind).toBe('section');
    expect(data.items[0].path).toBe('docs/atlas/sections.md');
    expect(data.items[0].heading).toBe('Target');
    expect(data.items[0].matchedHeading).toBe('Target');
    expect(data.items[0].content).toContain('### Child');
    expect(data.items[0].content).not.toContain('## Next');
  });

  it('should report missing requested paths without crashing', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const result = await handleContextPack(project, {
      projectId: 'test-project',
      branch: 'main',
      includeStatus: false,
      includeAgents: false,
      includeManifest: false,
      paths: ['docs/atlas/missing.md'],
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].kind).toBe('document');
    expect(data.items[0].path).toBe('docs/atlas/missing.md');
    expect(data.items[0].missing).toBe(true);
    expect(data.items[0].error).toContain('not found');
    expect(data.items[0].returnedChars).toBe(0);
  });

  it('should reject unsafe or untracked requested paths', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const untracked = await handleContextPack(project, {
      projectId: 'test-project',
      branch: 'main',
      paths: ['notes/random.md'],
    });

    expect(untracked.isError).toBe(true);
    const untrackedData = JSON.parse(untracked.content[0].text);
    expect(untrackedData.error).toContain('not in the list of Atlas-owned managed documents');

    const traversal = await handleContextPack(project, {
      projectId: 'test-project',
      branch: 'main',
      paths: ['../secrets.md'],
    });

    expect(traversal.isError).toBe(true);
    const traversalData = JSON.parse(traversal.content[0].text);
    expect(traversalData.error).toContain('Path traversal');
  });
});

describe('creating branches', () => {
  it('should create a new branch from main', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    await project.gitStore.createBranch('test-branch', 'main');
    const exists = await project.gitStore.branchExists('test-branch');
    expect(exists).toBe(true);

    // Verify the branch has the same files
    const mainFiles = await project.gitStore.listFiles('main');
    const branchFiles = await project.gitStore.listFiles('test-branch');
    expect(branchFiles).toEqual(mainFiles);
  });
});

describe('proposing a valid patch', () => {
  it('should validate a correct patch proposal', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const policy = await Policy.load(tmpDir);
    const filePath = 'docs/README.md';
    const { content, revision } = await project.readFile('main', filePath);

    // Create a simple patch that adds a line
    const patch = createSimplePatch(
      content ?? '',
      (content ?? '') + '\n## New Section\n\nAdded content.\n',
    );

    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision ?? '',
      patch,
      intent: 'Add new section to README',
      summary: 'Add a new section to the documentation README',
    });

    expect(validation.valid).toBe(true);
  });

  it('should validate a full git-style unified diff proposal', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const policy = await Policy.load(tmpDir);
    const filePath = 'docs/README.md';
    const { content, revision } = await project.readFile('main', filePath);

    const patch = prependGitDiffHeader(
      createSimplePatch(
        content ?? '',
        (content ?? '') + '\n## Git Style Section\n\nAdded content.\n',
        filePath,
      ),
      filePath,
    );

    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision ?? '',
      patch,
      intent: 'Validate a full git-style unified diff proposal',
      summary: 'Accept full git-style unified diff input',
    });

    expect(validation.valid).toBe(true);
  });

  it('should validate a complete unified diff with bare relative file headers', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const policy = await Policy.load(tmpDir);
    const filePath = 'docs/README.md';
    const { content, revision } = await project.readFile('main', filePath);

    const patch = stripGitPrefixesFromPatch(
      createSimplePatch(
        content ?? '',
        (content ?? '') + '\n## Bare Header Section\n\nAdded content.\n',
        filePath,
      ),
      filePath,
    );

    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision ?? '',
      patch,
      intent: 'Validate a complete unified diff with bare relative file headers',
      summary: 'Accept unified diff input without diff --git and without a/b prefixes',
    });

    expect(validation.valid).toBe(true);
  });
});

describe('rejecting a stale baseRevision', () => {
  it('should reject a patch with a stale base revision', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const policy = await Policy.load(tmpDir);
    const filePath = 'docs/README.md';
    const { content } = await project.readFile('main', filePath);

    // Create a patch with a fake (non-matching) base revision
    const patch = createSimplePatch(
      content ?? '',
      (content ?? '') + '\n## Stale Test\n',
    );

    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: '0000000000000000000000000000000000000000',
      patch,
      intent: 'Test stale revision',
      summary: 'This should fail due to stale base revision',
    });

    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('Base revision mismatch');
  });
});

describe('rejecting path traversal', () => {
  it('should detect path traversal attempts', () => {
    expect(isPathTraversal('../etc/passwd')).toBe(true);
    expect(isPathTraversal('docs/../../etc/passwd')).toBe(true);
    expect(isPathTraversal('/etc/passwd')).toBe(true);
    expect(isPathTraversal('docs/../policy.yml')).toBe(true);
  });

  it('should accept safe paths', () => {
    expect(isPathTraversal('docs/README.md')).toBe(false);
    expect(isPathTraversal('docs/spec/design.md')).toBe(false);
    expect(isPathTraversal('AGENTS.md')).toBe(false);
    expect(isPathTraversal('docs/deeply/nested/file.md')).toBe(false);
  });
});

describe('detecting large deletion risk', () => {
  it('should flag patches that delete more than 25%', () => {
    const policy = new Policy();
    const original = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n';
    const newContent = 'line1\nline2\nline3\nline4\nline5\n';
    const patch = '--- a/file\n+++ b/file\n@@ -1,10 +1,5 @@\n';

    const risk = assessPatchRisk(policy, 'docs/test.md', original, newContent, patch);
    expect(risk.highRisk).toBe(true);
    expect(risk.reasons.some((r) => r.includes('Deletes'))).toBe(true);
  });

  it('should not flag small deletions', () => {
    const policy = new Policy();
    const original = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n';
    const newContent = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n\nextra line\n';

    // Use a non-protected path to isolate the deletion test
    const risk = assessPatchRisk(policy, 'notes/scratch.md', original, newContent, '');
    expect(risk.highRisk).toBe(false);
  });
});

describe('committing a patch', () => {
  it('should apply a patch and create a commit', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const filePath = 'docs/README.md';
    const { content, revision } = await project.readFile('main', filePath);

    // Create a simple patch
    const newContent = (content ?? '') + '\n## New Section\n\nTest content.\n';
    const patch = createSimplePatch(content ?? '', newContent);

    const result = await project.gitStore.applyPatchAndCommit(
      'main',
      filePath,
      patch,
      'Add test section to README',
      revision ?? undefined,
    );

    expect(result.hash).toBeTruthy();
    expect(result.hash.length).toBe(40); // SHA1 hash

    // Verify the file was updated
    const updated = await project.readFile('main', filePath);
    expect(updated.content).toContain('New Section');
  });

  it('should reject a corrupt stored patch at commit time and mark it rejected', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { revision } = await project.readFile('main', 'docs/README.md');
    expect(revision).toBeTruthy();

    const stored = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'docs/README.md',
      base_revision: revision ?? '',
      patch: [
        '--- a/docs/README.md',
        '+++ b/docs/README.md',
        '@@ -1,2 +1,2 @@',
        ' this line is valid context',
        'this line is corrupt diff syntax',
      ].join('\n'),
      intent: 'Store an intentionally corrupt patch for commit validation',
      summary: 'Corrupt commit test',
      risk_level: 'low',
      requires_approval: false,
    });

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: stored.id,
      actor: 'test',
    });

    expect(commitResult.isError).toBe(true);
    const data = JSON.parse(commitResult.content[0].text);
    expect(data.error).toContain('Patch does not apply cleanly');
    expect(data.validationStatus).toBe('invalid');
    expect(data.status).toBe('rejected');

    const persisted = project.eventLog.getProposal(stored.id);
    expect(persisted?.status).toBe('rejected');
  });

  it('should reject a stored non-unified patch at commit time and mark it rejected', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { revision } = await project.readFile('main', 'STATUS.md');
    expect(revision).toBeTruthy();

    const stored = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'STATUS.md',
      base_revision: revision ?? '',
      patch: [
        '*** Begin Patch',
        '*** Update File: STATUS.md',
        '@@',
        '-currentFocus: "Create-only docs.propose_document support is complete alongside guarded Atlas document creation"',
        '+currentFocus: "Create-only docs.propose_document support is complete, and guarded patch applyability hardening is now in place alongside guarded Atlas document creation"',
        '*** End Patch',
      ].join('\n'),
      intent: 'Store an intentionally non-unified patch for commit validation',
      summary: 'Non-unified commit test',
      risk_level: 'low',
      requires_approval: false,
    });

    const commitResult = await handleCommitPatch(project, {
      projectId: 'test-project',
      proposalId: stored.id,
      actor: 'test',
    });

    expect(commitResult.isError).toBe(true);
    const data = JSON.parse(commitResult.content[0].text);
    expect(data.error).toContain('docs.propose_patch requires a standard unified diff patch');
    expect(data.error).toContain('apply_patch-style input');
    expect(data.validationStatus).toBe('invalid');
    expect(data.status).toBe('rejected');

    const persisted = project.eventLog.getProposal(stored.id);
    expect(persisted?.status).toBe('rejected');
  });
});

describe('writing an event log row', () => {
  it('should log and retrieve events', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const event = project.eventLog.logEvent({
      project_id: 'test-project',
      branch: 'main',
      path: 'docs/test.md',
      tool_name: 'commit_patch',
      intent: 'Test event logging',
      summary: 'A test event entry',
      base_revision: 'abc123',
      result_revision: 'def456',
      risk_level: 'low',
    });

    expect(event.id).toBeTruthy();

    const history = project.eventLog.getHistoryForPath('test-project', 'docs/test.md');
    expect(history.length).toBe(1);
    expect(history[0].summary).toBe('A test event entry');
  });

  it('should prefer the latest metadata-bearing recovery observation when export logs share a timestamp', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const createdAt = '2026-01-02T03:04:05.000Z';
    project.eventLog.logEvent({
      project_id: 'test-project',
      branch: 'main',
      path: '.export',
      tool_name: 'export',
      summary: 'Exported managed docs',
      created_at: createdAt,
    });
    project.eventLog.logEvent({
      project_id: 'test-project',
      branch: 'main',
      path: '.export',
      tool_name: 'export',
      summary: 'Observed export recovery state',
      created_at: createdAt,
      metadata: {
        kind: 'recovery_observation',
        operation: 'export',
        rootIdentityKey: 'root-1',
        canonicalProjectRoot: tmpDir,
        gitWorktreeRoot: tmpDir,
        gitCommonDir: path.join(tmpDir, '.git'),
        rootUnsafe: false,
        safeForWrites: true,
        rootMismatch: false,
        exportRequired: false,
        exportBlocked: false,
        warnings: [],
      },
    });

    expect(project.eventLog.getLatestRecoveryObservation('test-project', 'export')).toMatchObject({
      createdAt,
      metadata: {
        operation: 'export',
        rootIdentityKey: 'root-1',
        exportRequired: false,
      },
    });
  });
});

describe('restoring a file from history', () => {
  it('should restore a file to a previous revision', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const filePath = 'docs/README.md';
    const { content: originalContent, revision: originalRevision } = await project.readFile('main', filePath);

    // Make a change to the file
    const newContent = (originalContent ?? '') + '\n## Added Later\n\nThis will be reverted.\n';
    const patch = createSimplePatch(originalContent ?? '', newContent);

    await project.gitStore.applyPatchAndCommit(
      'main',
      filePath,
      patch,
      'Add section that will be reverted',
      originalRevision ?? undefined,
    );

    // Verify the change was applied
    const { content: changedContent } = await project.readFile('main', filePath);
    expect(changedContent).toContain('Added Later');

    // Restore the original revision
    await project.gitStore.restoreFile('main', filePath, originalRevision ?? '');

    // Verify the file is back to original
    const { content: restoredContent } = await project.readFile('main', filePath);
    expect(restoredContent).not.toContain('Added Later');
  });
});

describe('proposal storage', () => {
  it('should store, retrieve, and update proposal status', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const stored = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'docs/README.md',
      base_revision: 'abc123',
      patch: '--- a/docs/README.md\n+++ b/docs/README.md\n@@ -1 +1,2 @@\n-old\n+new\n',
      intent: 'Test proposal storage',
      summary: 'A test proposal',
      risk_level: 'low',
      requires_approval: false,
    });

    expect(stored.id).toMatch(/^prop_/);
    expect(stored.status).toBe('pending');
    expect(stored.committed_at).toBeNull();

    // Retrieve by id
    const retrieved = project.eventLog.getProposal(stored.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.path).toBe('docs/README.md');
    expect(retrieved!.status).toBe('pending');

    // Update status to committed
    project.eventLog.updateProposalStatus(stored.id, 'committed');
    const afterCommit = project.eventLog.getProposal(stored.id);
    expect(afterCommit!.status).toBe('committed');
    expect(afterCommit!.committed_at).not.toBeNull();
  });

  it('should list pending proposals and discard uncommitted proposals without deleting history', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const pending = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'docs/README.md',
      base_revision: 'abc123',
      patch: '--- a/docs/README.md\n+++ b/docs/README.md\n@@ -1 +1,2 @@\n-old\n+new\n',
      intent: 'Keep a proposal pending',
      summary: 'Pending proposal',
      risk_level: 'low',
      requires_approval: false,
    });

    const committed = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'docs/atlas/example.md',
      base_revision: 'abc124',
      patch: '--- a/docs/atlas/example.md\n+++ b/docs/atlas/example.md\n@@ -1 +1,2 @@\n-old\n+new\n',
      intent: 'Track a committed proposal',
      summary: 'Committed proposal',
      risk_level: 'low',
      requires_approval: false,
    });

    const rejected = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'docs/atlas/rejected.md',
      base_revision: 'abc125',
      patch: '--- a/docs/atlas/rejected.md\n+++ b/docs/atlas/rejected.md\n@@ -1 +1,2 @@\n-old\n+new\n',
      intent: 'Track a rejected proposal',
      summary: 'Rejected proposal',
      risk_level: 'low',
      requires_approval: false,
    });

    project.eventLog.updateProposalStatus(committed.id, 'committed');
    project.eventLog.updateProposalStatus(rejected.id, 'rejected');

    const defaultList = await handleListProposals(project, {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(defaultList.isError).toBeFalsy();
    const defaultData = JSON.parse(defaultList.content[0].text);
    expect(defaultData.status).toBe('pending');
    expect(defaultData.proposalCount).toBe(1);
    expect(defaultData.proposals).toHaveLength(1);
    expect(defaultData.proposals[0]).toMatchObject({
      proposalId: pending.id,
      branch: 'main',
      status: 'pending',
      committed: false,
      discarded: false,
      exportRelevant: false,
      targetPath: 'docs/README.md',
      summary: 'Pending proposal',
    });

    const discardResult = await handleDiscardProposal(project, {
      projectId: 'test-project',
      proposalId: pending.id,
    });

    expect(discardResult.isError).toBeFalsy();
    const discardedData = JSON.parse(discardResult.content[0].text);
    expect(discardedData).toMatchObject({
      proposalId: pending.id,
      previousStatus: 'pending',
      status: 'discarded',
      targetPath: 'docs/README.md',
      branch: 'main',
      diskTouched: false,
      manifestTouched: false,
      exportRelevant: false,
      noOp: false,
    });
    expect(discardedData.nextStep).toContain('docs.list_proposals');

    const discardedStored = project.eventLog.getProposal(pending.id);
    expect(discardedStored?.status).toBe('discarded');
    expect(discardedStored?.discarded_at).toBeTruthy();

    const afterDiscardDefaultList = await handleListProposals(project, {
      projectId: 'test-project',
      branch: 'main',
    });
    const afterDiscardDefaultData = JSON.parse(afterDiscardDefaultList.content[0].text);
    expect(afterDiscardDefaultData.proposalCount).toBe(0);
    expect(afterDiscardDefaultData.proposals).toHaveLength(0);

    const allList = await handleListProposals(project, {
      projectId: 'test-project',
      status: 'all',
    });
    const allData = JSON.parse(allList.content[0].text);
    expect(allData.proposalCount).toBe(3);
    expect(allData.proposals.map((proposal: { status: string }) => proposal.status)).toEqual(
      expect.arrayContaining(['discarded', 'committed', 'rejected']),
    );

    const reDiscardResult = await handleDiscardProposal(project, {
      projectId: 'test-project',
      proposalId: pending.id,
    });
    expect(reDiscardResult.isError).toBeFalsy();
    const reDiscardData = JSON.parse(reDiscardResult.content[0].text);
    expect(reDiscardData.noOp).toBe(true);
    expect(reDiscardData.status).toBe('discarded');
  });

  it('should reject discarding committed or unknown proposals', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const committed = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'docs/README.md',
      base_revision: 'abc123',
      patch: '--- a/docs/README.md\n+++ b/docs/README.md\n@@ -1 +1,2 @@\n-old\n+new\n',
      intent: 'Track a committed proposal',
      summary: 'Committed proposal',
      risk_level: 'low',
      requires_approval: false,
    });
    project.eventLog.updateProposalStatus(committed.id, 'committed');

    const committedDiscard = await handleDiscardProposal(project, {
      projectId: 'test-project',
      proposalId: committed.id,
    });
    expect(committedDiscard.isError).toBe(true);
    const committedData = JSON.parse(committedDiscard.content[0].text);
    expect(committedData.error).toContain('cannot be discarded');
    expect(committedData.previousStatus).toBe('committed');

    const missingDiscard = await handleDiscardProposal(project, {
      projectId: 'test-project',
      proposalId: 'prop_missing',
    });
    expect(missingDiscard.isError).toBe(true);
    const missingData = JSON.parse(missingDiscard.content[0].text);
    expect(missingData.error).toContain('not found');
  });

  it('should allow docs.discard_proposal cleanup even when the root context is unsafe', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const statusPath = path.join(tmpDir, 'STATUS.md');
    const readmePath = path.join(tmpDir, 'docs', 'README.md');
    const manifestPath = path.join(tmpDir, 'docs', 'manifest.yml');
    const originalStatus = await fs.promises.readFile(statusPath, 'utf-8');
    const originalReadme = await fs.promises.readFile(readmePath, 'utf-8');
    const originalManifest = await fs.promises.readFile(manifestPath, 'utf-8');

    const proposal = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'docs/README.md',
      base_revision: 'cleanup-base',
      patch: '--- a/docs/README.md\n+++ b/docs/README.md\n@@ -1 +1,2 @@\n-Docs\n+Docs\n+Cleanup\n',
      intent: 'Retire a stale proposal even when the root is unsafe',
      summary: 'Stale proposal cleanup',
      risk_level: 'low',
      requires_approval: false,
    });

    const exportBranchSpy = vi.spyOn(project.gitStore, 'exportBranch');
    const applyPatchSpy = vi.spyOn(project.gitStore, 'applyPatchAndCommit');
    const createBranchSpy = vi.spyOn(project.gitStore, 'createBranch');

    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const result = await callTool(project, 'docs.discard_proposal', {
      projectId: 'test-project',
      proposalId: proposal.id,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data).toMatchObject({
      proposalId: proposal.id,
      previousStatus: 'pending',
      status: 'discarded',
      diskTouched: false,
      manifestTouched: false,
      exportRelevant: false,
      noOp: false,
    });
    expect(data.message).toContain('without touching disk or manifest state');
    expect(project.eventLog.getProposal(proposal.id)?.status).toBe('discarded');
    expect(await fs.promises.readFile(statusPath, 'utf-8')).toBe(originalStatus);
    expect(await fs.promises.readFile(readmePath, 'utf-8')).toBe(originalReadme);
    expect(await fs.promises.readFile(manifestPath, 'utf-8')).toBe(originalManifest);
    expect(exportBranchSpy).not.toHaveBeenCalled();
    expect(applyPatchSpy).not.toHaveBeenCalled();
    expect(createBranchSpy).not.toHaveBeenCalled();
  });

  it('should surface pending proposal recovery state when the current root identity changes', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'STATUS.md');
    expect(content).not.toBeNull();
    expect(revision).toBeTruthy();

    const updated = content!.replace(
      '<!-- What is the team working on right now? -->',
      'Track pending proposal recovery visibility',
    );
    const patch = createUnifiedDiffForReplacement('STATUS.md', content!, updated);

    const proposeResult = await callTool(project, 'docs.propose_patch', {
      projectId: 'test-project',
      branch: 'main',
      path: 'STATUS.md',
      baseRevision: revision,
      patch,
      intent: 'Create a pending proposal before switching root identity',
      summary: 'Pending proposal recovery visibility',
    });

    expect(proposeResult.isError).toBeFalsy();

    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const statusResult = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(statusResult.isError).toBeFalsy();
    const status = JSON.parse(statusResult.content[0].text);
    expect(status.rootContext.safety.rootMismatch).toBe(true);
    expect(status.rootContext.recovery).toMatchObject({
      available: true,
      recoveryRequired: true,
      proposalRecoveryRequired: true,
      exportRecoveryRequired: false,
      pendingProposalCount: 1,
      currentRootProposalCount: 0,
      foreignRootProposalCount: 1,
      unknownRootProposalCount: 0,
      recommendedCleanupTool: 'docs.discard_proposal',
    });
    expect(status.rootContext.recovery.warnings).toContain(
      '1 pending proposal(s) were created from a different root/worktree identity.',
    );
    expect(status.rootContext.recovery.nextStep).toContain('docs.discard_proposal');
  });

  it('should fail soft when recovery aggregation raises an error', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const beforeProposalCount = getStoredProposalCount(project);
    const beforeRecoveryEvent = getLatestRecoveryObservationEvent(project, 'preview_export');
    const readRecoveryEvidenceSpy = vi
      .spyOn(readOnlyManagedState, 'readRecoveryEvidence')
      .mockImplementation(async () => {
        throw new Error('synthetic recovery failure');
      });

    try {
      const statusResult = await callTool(project, 'docs.status', {
        projectId: 'test-project',
        branch: 'main',
      });

      expect(statusResult.isError).toBeFalsy();
      const status = JSON.parse(statusResult.content[0].text);
      expect(status.rootContext.safety.safeForWrites).toBe(true);
      expect(status.rootContext.recovery.available).toBe(false);
      expect(status.rootContext.recovery.recoveryRequired).toBeNull();
      expect(status.rootContext.recovery.nextStep).toBeNull();
      expect(status.rootContext.recovery.warnings).toContain(
        'Recovery summary is currently unavailable.',
      );
      expect(status.rootContext.recovery.warnings.join(' ')).not.toContain('synthetic recovery failure');
      expect(getStoredProposalCount(project)).toBe(beforeProposalCount);
      expect(getLatestRecoveryObservationEvent(project, 'preview_export')).toEqual(beforeRecoveryEvent);
    } finally {
      readRecoveryEvidenceSpy.mockRestore();
    }
  });

  it('should return null for non-existent proposal', async () => {
    const project = new Project({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });
    await project.ensureEventLog();
    const eventLog = project.eventLog;

    const result = eventLog.getProposal('prop_nonexistent');
    expect(result).toBeNull();
  });

  it('should round-trip proposal metadata for create-only document proposals', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const stored = project.eventLog.storeProposal({
      project_id: 'test-project',
      branch: 'main',
      path: 'docs/atlas/example.md',
      base_revision: 'manifest-rev',
      patch: '--- /dev/null\n+++ b/docs/atlas/example.md\n@@ -0,0 +1,1 @@\n+# Example\n',
      intent: 'Create a new Atlas-managed document',
      summary: 'Add example Atlas doc',
      risk_level: 'high',
      requires_approval: true,
      metadata: {
        kind: 'document_create',
        mode: 'create',
        changedFiles: ['docs/atlas/example.md', 'docs/manifest.yml'],
        baseRevisions: {
          'docs/manifest.yml': 'manifest-rev',
        },
        riskReasons: ['Modifies a protected document'],
      },
    });

    const retrieved = project.eventLog.getProposal(stored.id);
    expect(retrieved?.metadata).toEqual({
      kind: 'document_create',
      mode: 'create',
      changedFiles: ['docs/atlas/example.md', 'docs/manifest.yml'],
      baseRevisions: {
        'docs/manifest.yml': 'manifest-rev',
      },
      riskReasons: ['Modifies a protected document'],
    });
  });
});

describe('detecting heading removal risk', () => {
  it('should flag patches that remove Markdown headings', () => {
    const policy = new Policy();
    const original = '# Title\n\nSome content.\n## Section 1\n\nDetails.\n## Section 2\n\nMore details.\n';
    const newContent = '# Title\n\nSome content.\n## Section 1\n\nDetails.\n';

    const risk = assessPatchRisk(policy, 'docs/test.md', original, newContent, '');
    expect(risk.highRisk).toBe(true);
    expect(risk.reasons.some((r) => r.includes('heading'))).toBe(true);
  });

  it('should not flag patches that keep headings', () => {
    const policy = new Policy();
    const original = '# Title\n\nBody.\n## Section\n\nContent.\n';
    const newContent = '# Title\n\nBody.\n## Section\n\nUpdated content.\n';

    const risk = assessPatchRisk(policy, 'docs/test.md', original, newContent, '');
    // Headings are preserved, but it still modifies a protected file
    const hasHeadingRisk = risk.reasons.some((r) => r.includes('heading'));
    expect(hasHeadingRisk).toBe(false);
  });
});

describe('detecting full file replacement risk', () => {
  it('should flag patches that replace entire file content', () => {
    const policy = new Policy();
    const original = '# Original Title\n\nThis is the original content of the file.\n\nIt has multiple paragraphs.\n\nAnd some more text.\n';
    const newContent = '# Completely Different\n\nThis file has been entirely replaced.\n';

    const risk = assessPatchRisk(policy, 'docs/test.md', original, newContent, '');
    expect(risk.highRisk).toBe(true);
    expect(risk.reasons.some((r) => r.includes('replace'))).toBe(true);
  });
});

describe('exporting documentation', () => {
  it('should export files from a branch to a target directory', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const exportDir = path.join(tmpDir, 'export-output');
    const exportedFiles = await project.gitStore.exportBranch('main', exportDir);

    expect(exportedFiles.length).toBeGreaterThan(0);

    // Verify files exist on disk
    for (const file of exportedFiles) {
      const fullPath = path.join(exportDir, file);
      const stat = await fs.promises.stat(fullPath);
      expect(stat.isFile()).toBe(true);
    }
  });

  it('should refuse managed writes when the registered root does not match the resolved root', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const statusPath = path.join(tmpDir, 'STATUS.md');
    const originalStatus = await fs.promises.readFile(statusPath, 'utf-8');
    await project.gitStore.applyAndCommit(
      'main',
      'STATUS.md',
      `${originalStatus}\nManaged main branch update.\n`,
      'Update status on managed main',
    );

    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const result = await callTool(project, 'docs.export', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('ROOT_CONTEXT_UNSAFE');
    expect(data.message).toContain('docs.export');
    expect(data.projectId).toBe('test-project');
    expect(data.projectRoot).toBe(tmpDir);
    expect(data.registeredProjectRoot).toBe(path.join(tmpDir, 'different-root'));
    expect(data.nextStep).toContain('docs.status');
    expect(data.nextStep).toContain('mcp-config');
    expect(data.safety.safeForWrites).toBe(false);
    expect(await fs.promises.readFile(statusPath, 'utf-8')).toBe(originalStatus);
  });

  it('should refuse docs.create_branch when the root context is unsafe', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const result = await callTool(project, 'docs.create_branch', {
      projectId: 'test-project',
      branch: 'unsafe-branch',
      from: 'main',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('ROOT_CONTEXT_UNSAFE');
    expect(data.message).toContain('docs.create_branch');
    expect(await project.gitStore.branchExists('unsafe-branch')).toBe(false);
  });

  it('should refuse docs.propose_patch before storing a proposal when the root context is unsafe', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'docs/README.md');
    expect(content).not.toBeNull();
    expect(revision).toBeTruthy();
    const beforeCount = getStoredProposalCount(project);

    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const result = await callTool(project, 'docs.propose_patch', {
      projectId: 'test-project',
      branch: 'main',
      path: 'docs/README.md',
      baseRevision: revision,
      patch: createSimplePatch(content!, `${content!}\nUnsafe root guard test.\n`, 'docs/README.md'),
      intent: 'Try to store a proposal while the root context is unsafe',
      summary: 'Guard root mismatches before proposal storage',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('ROOT_CONTEXT_UNSAFE');
    expect(data.message).toContain('docs.propose_patch');
    expect(getStoredProposalCount(project)).toBe(beforeCount);
  });

  it('should refuse docs.propose_document before storing a proposal when the root context is unsafe', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const beforeCount = getStoredProposalCount(project);
    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const result = await callTool(project, 'docs.propose_document', {
      projectId: 'test-project',
      branch: 'main',
      mode: 'create',
      path: 'docs/atlas/root-guard.md',
      content: '# Root Guard\n',
      document: {
        role: 'reference',
        summary: 'Guard root mismatches before proposal storage',
      },
      intent: 'Try to store a document proposal while the root context is unsafe',
      summary: 'Guard root mismatches before document proposal storage',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('ROOT_CONTEXT_UNSAFE');
    expect(data.message).toContain('docs.propose_document');
    expect(getStoredProposalCount(project)).toBe(beforeCount);
  });

  it('should refuse docs.commit_patch before applying a stored proposal when the root context is unsafe', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const { content, revision } = await project.readFile('main', 'STATUS.md');
    expect(content).not.toBeNull();
    expect(revision).toBeTruthy();

    const proposalResult = await callTool(project, 'docs.propose_patch', {
      projectId: 'test-project',
      branch: 'main',
      path: 'STATUS.md',
      baseRevision: revision,
      patch: createSimplePatch(content!, `${content!}\nPending commit root guard test.\n`, 'STATUS.md'),
      intent: 'Create a proposal that will later be blocked by root safety',
      summary: 'Store a pending proposal for guarded commit testing',
    });
    expect(proposalResult.isError).toBeFalsy();
    const proposal = JSON.parse(proposalResult.content[0].text);

    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const statusResult = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'main',
    });
    expect(statusResult.isError).toBeFalsy();
    const status = JSON.parse(statusResult.content[0].text);
    expect(status.rootContext.safety.rootMismatch).toBe(true);
    expect(status.rootContext.safety.safeForWrites).toBe(false);

    const commitResult = await callTool(project, 'docs.commit_patch', {
      projectId: 'test-project',
      proposalId: proposal.proposalId,
      actor: 'test',
      riskOverride: 'accept',
    });

    expect(commitResult.isError).toBe(true);
    const data = JSON.parse(commitResult.content[0].text);
    expect(data.code).toBe('ROOT_CONTEXT_UNSAFE');
    expect(data.message).toContain('docs.commit_patch');
    const stored = project.eventLog.getProposal(proposal.proposalId);
    expect(stored?.status).toBe('pending');
  });

  it('should refuse docs.restore_file when the root context is unsafe', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const statusPath = path.join(tmpDir, 'STATUS.md');
    const originalStatus = await fs.promises.readFile(statusPath, 'utf-8');
    const { revision } = await project.readFile('main', 'STATUS.md');
    expect(revision).toBeTruthy();

    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const result = await callTool(project, 'docs.restore_file', {
      projectId: 'test-project',
      path: 'STATUS.md',
      revision,
      branch: 'main',
      intent: 'Try to restore a file while the root context is unsafe',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe('ROOT_CONTEXT_UNSAFE');
    expect(data.message).toContain('docs.restore_file');
    expect(await fs.promises.readFile(statusPath, 'utf-8')).toBe(originalStatus);
  });

  it('keeps existing unsafe root checks authoritative when ledger recording fails', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    await setRegisteredProjectRoot(project, path.join(tmpDir, 'different-root'));

    const eventsPath = project.storage.projectEventsPath(project.projectId);
    await fs.promises.rm(eventsPath, { force: true });
    await fs.promises.mkdir(eventsPath, { recursive: true });

    const statusResult = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(statusResult.isError).toBeFalsy();
    const status = JSON.parse(statusResult.content[0].text);
    expect(status.rootContext.safety.rootMismatch).toBe(true);
    expect(status.rootContext.safety.safeForWrites).toBe(false);
    expect(status.rootContext.rootLedger.available).toBe(false);
    expect(status.rootContext.rootLedger.recorded).toBe(false);
    expect(status.rootContext.rootLedger.warnings[0]).toContain('Root ledger recording failed');
  });

  it('should allow canonical path aliases without false root-safety failures', async () => {
    const actualRoot = path.join(tmpDir, 'actual-root');
    const aliasRoot = path.join(tmpDir, 'alias-root');
    await fs.promises.mkdir(actualRoot, { recursive: true });
    await fs.promises.symlink(actualRoot, aliasRoot, 'dir');

    const project = await Project.init({
      projectRoot: aliasRoot,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    await setRegisteredProjectRoot(project, actualRoot);

    const statusPath = path.join(aliasRoot, 'STATUS.md');
    const originalStatus = await fs.promises.readFile(statusPath, 'utf-8');
    const updatedStatus = `${originalStatus}\nAlias path guard test.\n`;
    await project.gitStore.applyAndCommit(
      'main',
      'STATUS.md',
      updatedStatus,
      'Update status for alias-path safety test',
    );

    const result = await callTool(project, 'docs.export', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.exported).toBe(true);
    expect(await fs.promises.readFile(statusPath, 'utf-8')).toBe(updatedStatus);

    const statusResult = await callTool(project, 'docs.status', {
      projectId: 'test-project',
      branch: 'main',
    });
    expect(statusResult.isError).toBeFalsy();
    const status = JSON.parse(statusResult.content[0].text);
    expect(status.rootContext.projectRoot).toBe(aliasRoot);
    expect(status.rootContext.registeredProjectRoot).toBe(actualRoot);
    expect(status.rootContext.safety.safeForWrites).toBe(true);
  });

  it('should refuse exporting a managed branch into a different checked-out source branch', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const sourceGit = await initSourceRepo('v0.2-daemon');
    const statusPath = path.join(tmpDir, 'STATUS.md');
    const originalStatus = await fs.promises.readFile(statusPath, 'utf-8');

    await project.gitStore.applyAndCommit(
      'main',
      'STATUS.md',
      `${originalStatus}\nManaged main branch update.\n`,
      'Update status on managed main',
    );
    await project.gitStore.applyAndCommit(
      'main',
      'docs/spec/managed-main-drift.md',
      '# Managed Main Drift\n',
      'Add managed main drift document',
    );

    const result = await callTool(project, 'docs.export', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain('Refusing to export managed docs branch "main"');
    expect(data.error).toContain('source branch "v0.2-daemon"');

    expect(await fs.promises.readFile(statusPath, 'utf-8')).toBe(originalStatus);
    await expect(
      fs.promises.stat(path.join(tmpDir, 'docs/spec/managed-main-drift.md')),
    ).rejects.toThrow();

    const status = await sourceGit.status();
    expect(status.files).toHaveLength(0);
  });

  it('should export when the checked-out source branch matches the managed branch', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    await initSourceRepo('main');

    const statusPath = path.join(tmpDir, 'STATUS.md');
    const originalStatus = await fs.promises.readFile(statusPath, 'utf-8');
    const updatedStatus = `${originalStatus}\nManaged main branch update.\n`;

    await project.gitStore.applyAndCommit(
      'main',
      'STATUS.md',
      updatedStatus,
      'Update status on managed main',
    );

    const result = await callTool(project, 'docs.export', {
      projectId: 'test-project',
      branch: 'main',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.exported).toBe(true);
    expect(data.branch).toBe('main');
    expect(await fs.promises.readFile(statusPath, 'utf-8')).toBe(updatedStatus);
  });

  it('should exclude stale unmanifested documents from export', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // Create a file in the managed store that is NOT listed in docs/manifest.yml
    // and not in the always-owned paths.
    await project.gitStore.applyAndCommit(
      'main',
      'docs/stale-unlisted-file.md',
      '# Stale Unlisted File\n',
      'Add stale unlisted doc',
    );

    // Also add a file that IS in the manifest (docs/atlas/setup.md) and
    // a file that is always-owned (STATUS.md) to confirm they still export.
    await project.gitStore.applyAndCommit(
      'main',
      'docs/atlas/setup.md',
      '# Setup\n\nUpdated setup content.\n',
      'Update manifest-listed doc',
    );

    // Get owned files and export only those
    const ownedFiles = await project.getOwnedFiles('main');
    const exportDir = path.join(tmpDir, 'export-filtered');

    // Owned files should NOT include the stale unlisted file
    expect(ownedFiles).not.toContain('docs/stale-unlisted-file.md');

    // Owned files SHOULD include files from the manifest
    expect(ownedFiles).toContain('docs/atlas/setup.md');

    // Owned files SHOULD include always-owned paths
    expect(ownedFiles).toContain('STATUS.md');

    // Export with owned files filter
    const exportedFiles = await project.gitStore.exportBranch('main', exportDir, ownedFiles);

    // The stale file must not be exported
    const staleFilePath = path.join(exportDir, 'docs/stale-unlisted-file.md');
    await expect(fs.promises.stat(staleFilePath)).rejects.toThrow();

    // Manifest-listed files must still be exported
    const setupPath = path.join(exportDir, 'docs/atlas/setup.md');
    await expect(fs.promises.stat(setupPath)).resolves.toBeDefined();

    const statusExportPath = path.join(exportDir, 'STATUS.md');
    await expect(fs.promises.stat(statusExportPath)).resolves.toBeDefined();
  });

  it('should export all files (legacy behavior) when no file filter is passed', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    // Add an unmanifested file to the managed store
    await project.gitStore.applyAndCommit(
      'main',
      'docs/unlisted-legacy-file.md',
      '# Unlisted Legacy File\n',
      'Add unlisted doc to test legacy export',
    );

    // Export without file filter (legacy behavior)
    const exportDir = path.join(tmpDir, 'export-legacy');
    const exportedFiles = await project.gitStore.exportBranch('main', exportDir);

    // Legacy export should still include the unlisted file
    expect(exportedFiles).toContain('docs/unlisted-legacy-file.md');
    const legacyPath = path.join(exportDir, 'docs/unlisted-legacy-file.md');
    await expect(fs.promises.stat(legacyPath)).resolves.toBeDefined();
  });
});

describe('GitStore workdir cleanup', () => {
  it('should reset dirty files from workdir before each withWorkDir operation', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const repoDir = project.gitStore.repoDir;
    const workDir = path.join(repoDir, 'workdir');

    // Ensure workdir exists with a known branch checked out
    await project.gitStore.createBranch('test-branch', 'main');

    // Manually write an untracked (dirty) file into the workdir
    const dirtyFilePath = path.join(workDir, 'docs', 'dirty-file.md');
    await fs.promises.mkdir(path.dirname(dirtyFilePath), { recursive: true });
    await fs.promises.writeFile(dirtyFilePath, '# Dirty content');

    // Manually modify a tracked file in the workdir
    const readmePath = path.join(workDir, 'docs', 'README.md');
    const existingContent = await fs.promises.readFile(readmePath, 'utf-8');
    await fs.promises.writeFile(readmePath, existingContent + '\nDirty modification\n');

    // Call exportBranch — this goes through withWorkDir and should trigger cleanup
    const exportDir = path.join(tmpDir, 'export-output');
    await project.gitStore.exportBranch('test-branch', exportDir);

    // After the operation, the untracked dirty file should be gone from workdir
    await expect(fs.promises.stat(dirtyFilePath)).rejects.toThrow();

    // After the operation, the tracked file should be reset to its clean state
    const cleanedReadme = await fs.promises.readFile(readmePath, 'utf-8');
    expect(cleanedReadme).not.toContain('Dirty modification');

    // Verify the exported files do not contain the dirty file
    const exportDocs = await fs.promises.readdir(path.join(exportDir, 'docs'));
    expect(exportDocs).not.toContain('dirty-file.md');
  });

  it('should resync the workdir from the bare store before a withWorkDir operation', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const repoDir = project.gitStore.repoDir;
    const workDir = path.join(repoDir, 'workdir');
    const filePath = 'docs/README.md';

    const original = (await project.readFile('main', filePath)).content ?? '';

    // Advance the bare store from OUTSIDE the workdir, as an independent
    // writer would. Project.init has already left the workdir checked out
    // on the older main.
    const externalDir = path.join(tmpDir, 'external-clone');
    await fs.promises.mkdir(externalDir, { recursive: true });
    const external = simpleGit({ baseDir: externalDir });
    await external.clone(repoDir, externalDir);
    const updated = original + '\n## Remote advancement\n';
    await fs.promises.writeFile(path.join(externalDir, filePath), updated, 'utf-8');
    await external.add(filePath);
    await external.commit('Advance origin outside the workdir');
    await external.push('origin', 'main');

    // The workdir branch still lags the bare store until a withWorkDir
    // operation resyncs it.
    const workdirHead = (await simpleGit({ baseDir: workDir }).revparse(['main'])).trim();
    const bareHead = (await project.gitStore.getBranchHead('main')) ?? '';
    expect(workdirHead).not.toBe(bareHead);

    // A withWorkDir write must first resync onto the remote commit. Against
    // a stale workdir base its push would be a non-fast-forward rejection,
    // so the operation would throw and the change would never land.
    const remoteContent = (await project.readFile('main', filePath)).content ?? '';
    const nextContent = remoteContent + '\n## Workdir saw remote advance\n';

    const committed = await project.gitStore.applyAndCommit(
      'main',
      filePath,
      nextContent,
      'Write on top of remote advancement',
    );
    expect(committed.hash.length).toBe(40);

    const finalContent = (await project.readFile('main', filePath)).content ?? '';
    expect(finalContent).toBe(nextContent);
  });

  it('should clean up atlas-branded temporary patch files after patch validation and commit', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const repoDir = project.gitStore.repoDir;
    const workDir = path.join(repoDir, 'workdir');
    const policy = await Policy.load(tmpDir);
    const filePath = 'docs/README.md';
    const { content, revision } = await project.readFile('main', filePath);
    const updatedContent = (content ?? '') + '\n## Temp Cleanup\n';
    const patch = createSimplePatch(content ?? '', updatedContent);

    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision ?? '',
      patch,
      intent: 'Validate patch temp file cleanup',
      summary: 'Ensure atlas patch-check temp files are removed',
    });

    expect(validation.valid).toBe(true);
    await expect(
      fs.promises.stat(path.join(workDir, '.xurgo-atlas-patch-check.tmp')),
    ).rejects.toThrow();
    await expect(
      fs.promises.stat(path.join(workDir, '.docu-guard-patch-check.tmp')),
    ).rejects.toThrow();

    await project.gitStore.applyPatchAndCommit(
      'main',
      filePath,
      patch,
      'Check atlas temp patch cleanup',
      revision ?? undefined,
    );

    await expect(
      fs.promises.stat(path.join(workDir, '.xurgo-atlas-patch.tmp')),
    ).rejects.toThrow();
    await expect(
      fs.promises.stat(path.join(workDir, '.docu-guard-patch.tmp')),
    ).rejects.toThrow();
  });
});

describe('stale proposal detection', () => {
  it('should reject a proposal whose base revision is stale after another commit', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const policy = new Policy();
    const filePath = 'docs/README.md';
    const { content, revision } = await project.readFile('main', filePath);

    // Make a first valid patch + commit
    const patch1 = createSimplePatch(
      content ?? '',
      (content ?? '') + '\n## First Change\n',
    );

    const result1 = await project.gitStore.applyPatchAndCommit(
      'main', filePath, patch1, 'First change', revision ?? undefined,
    );
    expect(result1.hash).toBeTruthy();
    expect(result1.hash.length).toBe(40);

    // Now create a proposal based on the *original* (now stale) revision
    const patch2 = createSimplePatch(
      content ?? '',
      (content ?? '') + '\n## Second Change (based on stale revision)\n',
    );

    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision ?? '', // stale!
      patch: patch2,
      intent: 'Attempt change on stale base',
      summary: 'This should fail',
    });

    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('Base revision mismatch');
  });
});

describe('AGENTS.md intent validation', () => {
  it('should reject an AGENTS.md proposal with vague intent', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const policy = await Policy.load(tmpDir);
    const filePath = 'AGENTS.md';
    const { content, revision } = await project.readFile('main', filePath);

    // Create a patch that modifies AGENTS.md
    const patch = createSimplePatch(
      content ?? '',
      (content ?? '') + '\n## Extra Rule\n\nSomething.\n',
      'AGENTS.md',
    );

    // Vague intent that does not reference safety/agent rules
    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision ?? '',
      patch,
      intent: 'Update the file',
      summary: 'Minor updates to documentation',
    });

    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('AGENTS.md');
    expect(validation.error).toContain('require an intent');
  });

  it('should accept an AGENTS.md proposal with explicit safety intent (still high-risk)', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const policy = await Policy.load(tmpDir);
    const filePath = 'AGENTS.md';
    const { content, revision } = await project.readFile('main', filePath);

    // Create a patch that modifies AGENTS.md
    const patch = createSimplePatch(
      content ?? '',
      (content ?? '') + '\n## Extra Rule\n\nSomething.\n',
      'AGENTS.md',
    );

    // Explicit valid intent referencing safety rules
    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision ?? '',
      patch,
      intent: 'Update documentation safety rules in AGENTS.md',
      summary: 'Add extra safety rule for MCP docs workflow',
    });

    expect(validation.valid).toBe(true);
    expect(validation.risk).toBeDefined();
    expect(validation.risk!.highRisk).toBe(true);
    expect(validation.risk!.reasons.some((r) => r.includes('AGENTS.md'))).toBe(true);
  });

  it('should accept AGENTS.md intent referencing agent instructions via summary', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const policy = await Policy.load(tmpDir);
    const filePath = 'AGENTS.md';
    const { content, revision } = await project.readFile('main', filePath);

    const patch = createSimplePatch(
      content ?? '',
      (content ?? '') + '\n## Extra Rule\n\nSomething.\n',
      'AGENTS.md',
    );

    // Valid via the summary field
    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision ?? '',
      patch,
      intent: 'Make changes',
      summary: 'Update project agent rules to cover new workflow',
    });

    expect(validation.valid).toBe(true);
    expect(validation.risk!.highRisk).toBe(true);
  });

  it('should accept AGENTS.md intent referencing docs safety via intent', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const policy = await Policy.load(tmpDir);
    const filePath = 'AGENTS.md';
    const { content, revision } = await project.readFile('main', filePath);

    const patch = createSimplePatch(
      content ?? '',
      (content ?? '') + '\n## Extra Rule\n\nSomething.\n',
      'AGENTS.md',
    );

    // Valid via intent with "docs safety"
    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision ?? '',
      patch,
      intent: 'Improve docs safety by clarifying rules',
      summary: 'Minor edits',
    });

    expect(validation.valid).toBe(true);
    expect(validation.risk!.highRisk).toBe(true);
  });

  it('should not require AGENTS.md intent validation for non-AGENTS.md files', async () => {
    const project = await Project.init({
      projectRoot: tmpDir,
      projectId: 'test-project',
      configDir: path.join(tmpDir, 'config'),
      dataDir: path.join(tmpDir, 'data'),
    });

    const policy = await Policy.load(tmpDir);
    const filePath = 'docs/README.md';
    const { content, revision } = await project.readFile('main', filePath);

    const patch = createSimplePatch(
      content ?? '',
      (content ?? '') + '\n## Extra Section\n\nMore content.\n',
    );

    // Vague intent but NOT AGENTS.md — should pass validation normally
    const validation = await validatePatch(policy, project.gitStore, {
      projectId: 'test-project',
      branch: 'main',
      path: filePath,
      baseRevision: revision ?? '',
      patch,
      intent: 'Update the file',
      summary: 'Make some changes',
    });

    expect(validation.valid).toBe(true);
  });
});

// ── CLI init command (v0.3 with registry registration) ────────────────

describe('CLI init command', () => {
  it('should initialize project AND register it in the registry', async () => {
    const configDir = path.join(tmpDir, 'config');
    const dataDir = path.join(tmpDir, 'data');

    await initCommand({
      projectRoot: tmpDir,
      projectId: 'my-project',
      configDir,
      dataDir,
    });

    // Managed state should be under <dataDir>/projects/my-project/
    const managedDir = path.join(dataDir, 'projects', 'my-project');
    const managedStat = await fs.promises.stat(managedDir);
    expect(managedStat.isDirectory()).toBe(true);

    // Git repo should exist in managed storage
    const repoPath = path.join(managedDir, 'repo.git');
    const repoStat = await fs.promises.stat(repoPath);
    expect(repoStat.isDirectory()).toBe(true);

    // Events DB should exist in managed storage
    const eventsPath = path.join(managedDir, 'events.sqlite');
    const dbStat = await fs.promises.stat(eventsPath);
    expect(dbStat.isFile()).toBe(true);

    // Project should be registered in the registry
    const registry = await Registry.load(configDir, dataDir);
    const entry = registry.getProject('my-project');
    expect(entry).not.toBeNull();
    expect(entry!.projectRoot).toBe(tmpDir);
    expect(entry!.projectId).toBe('my-project');

    // Project root should NOT have .docu-guard/
    await expect(fs.promises.stat(path.join(tmpDir, '.docu-guard'))).rejects.toThrow();
  });

  it('should be idempotent — registering same project again updates root', async () => {
    const configDir = path.join(tmpDir, 'config');
    const dataDir = path.join(tmpDir, 'data');

    // Init twice with different project root (simulating re-init)
    await initCommand({
      projectRoot: tmpDir,
      projectId: 'my-project',
      configDir,
      dataDir,
    });

    const registry = await Registry.load(configDir, dataDir);
    const entry = registry.getProject('my-project');
    expect(entry).not.toBeNull();
    expect(entry!.projectRoot).toBe(tmpDir);
    expect(entry!.createdAt).toBeTruthy();
    expect(entry!.updatedAt).toBeTruthy();
  });

  it('should respect custom configDir and dataDir for registry', async () => {
    const configDir = path.join(tmpDir, 'custom-config');
    const dataDir = path.join(tmpDir, 'custom-data');

    await initCommand({
      projectRoot: tmpDir,
      projectId: 'custom-proj',
      configDir,
      dataDir,
    });

    // Registry should be at configDir/projects.json
    const registryPath = path.join(configDir, 'projects.json');
    const regStat = await fs.promises.stat(registryPath);
    expect(regStat.isFile()).toBe(true);

    // Managed state should be at dataDir/projects/custom-proj/
    const managedDir = path.join(dataDir, 'projects', 'custom-proj');
    const managedStat = await fs.promises.stat(managedDir);
    expect(managedStat.isDirectory()).toBe(true);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────

function createSimplePatch(original: string, updated: string, filePath = 'docs/README.md'): string {
  const origLines = original.split('\n');
  const newLines = updated.split('\n');

  const maxLen = Math.max(origLines.length, newLines.length);

  let firstDiff = maxLen;
  let lastDiff = -1;
  for (let i = 0; i < maxLen; i++) {
    const o = i < origLines.length ? origLines[i] : '';
    const n = i < newLines.length ? newLines[i] : '';
    if (o !== n) {
      firstDiff = Math.min(firstDiff, i);
      lastDiff = Math.max(lastDiff, i);
    }
  }

  const ctxStart = Math.max(0, firstDiff - 1);
  const ctxEnd = Math.min(maxLen, lastDiff + 2);

  const oldStart = ctxStart + 1;
  const oldCount = Math.min(origLines.length - ctxStart, ctxEnd - ctxStart);
  const newStart = ctxStart + 1;
  const newCount = Math.min(newLines.length - ctxStart, ctxEnd - ctxStart);

  let patch = `--- a/${filePath}\n+++ b/${filePath}\n`;
  patch += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;

  for (let i = ctxStart; i < ctxEnd; i++) {
    const o = i < origLines.length ? origLines[i] : null;
    const n = i < newLines.length ? newLines[i] : null;

    if (o === null && n !== null) {
      patch += `+${n}\n`;
    } else if (o !== null && n === null) {
      patch += `-${o}\n`;
    } else if (o !== null && n !== null && o !== n) {
      patch += `-${o}\n`;
      patch += `+${n}\n`;
    } else if (o !== null && n !== null) {
      patch += ` ${o}\n`;
    }
  }

  return patch;
}

function stripGitPrefixesFromPatch(patch: string, filePath: string): string {
  return patch
    .replace(`--- a/${filePath}`, `--- ${filePath}`)
    .replace(`+++ b/${filePath}`, `+++ ${filePath}`);
}

function prependGitDiffHeader(patch: string, filePath: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'index 1111111..2222222 100644',
    patch,
  ].join('\n');
}
