import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { daemonCommand } from '../src/cli/daemon.js';
import { initCommand, listCommand } from '../src/cli/init.js';
import { Registry } from '../src/core/registry.js';
import { resolveProjectContext } from '../src/core/project-resolution.js';

afterEach(() => {
  vi.restoreAllMocks();
});

async function withTempProject(
  run: (ctx: { root: string; configDir: string; dataDir: string }) => Promise<void>,
): Promise<void> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-proj-res-'));
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');

  try {
    await run({ root, configDir, dataDir });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(prev);
  }
}

function mockProcessExit() {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
  return { exitSpy };
}

async function readMarker(root: string): Promise<{ schemaVersion: number; projectId: string } & Record<string, unknown>> {
  return JSON.parse(
    await fs.promises.readFile(path.join(root, '.xurgo-atlas', 'project.json'), 'utf-8'),
  ) as { schemaVersion: number; projectId: string } & Record<string, unknown>;
}

async function writeDaemonPidFile(
  pidFile: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(pidFile), { recursive: true });
  await fs.promises.writeFile(pidFile, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function realPath(value: string): string {
  return fs.realpathSync.native(value);
}

describe('project markers', () => {
  it('init writes a local project marker with the project id only', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      await initCommand({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      const marker = await readMarker(root);
      expect(marker.schemaVersion).toBe(1);
      expect(marker.projectId).toBe('alpha');
      expect(JSON.stringify(marker)).not.toContain(root);
      expect(Object.keys(marker)).not.toContain('projectRoot');
    });
  });

  it('preserves an existing matching project marker', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const markerPath = path.join(root, '.xurgo-atlas', 'project.json');
      await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.promises.writeFile(
        markerPath,
        JSON.stringify({ schemaVersion: 1, projectId: 'alpha' }, null, 2) + '\n',
        'utf-8',
      );
      const original = await fs.promises.readFile(markerPath, 'utf-8');

      await initCommand({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      expect(await fs.promises.readFile(markerPath, 'utf-8')).toBe(original);
    });
  });

  it('fails clearly when the marker belongs to a different project', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const markerPath = path.join(root, '.xurgo-atlas', 'project.json');
      await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.promises.writeFile(
        markerPath,
        JSON.stringify({ schemaVersion: 1, projectId: 'alpha' }, null, 2) + '\n',
        'utf-8',
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { exitSpy } = mockProcessExit();

      try {
        await expect(
          initCommand({
            projectRoot: root,
            projectId: 'beta',
            configDir,
            dataDir,
          }),
        ).rejects.toThrow('process.exit(1)');

        const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(output).toContain('Project marker already exists');
        expect(output).toContain('alpha');
        expect(output).not.toContain('beta');
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  it('rejects a project id that is already registered to a different root', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const alphaRoot = path.join(root, 'alpha');
      const betaRoot = path.join(root, 'beta');
      await fs.promises.mkdir(alphaRoot, { recursive: true });
      await fs.promises.mkdir(betaRoot, { recursive: true });

      await initCommand({
        projectRoot: alphaRoot,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { exitSpy } = mockProcessExit();
      const registryBefore = await Registry.load(configDir, dataDir);
      const markerPath = path.join(betaRoot, '.xurgo-atlas', 'project.json');

      try {
        await expect(
          initCommand({
            projectRoot: betaRoot,
            projectId: 'alpha',
            configDir,
            dataDir,
          }),
        ).rejects.toThrow('process.exit(1)');

        const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(output).toContain('already registered');
        expect(output).toContain(alphaRoot);
        expect(exitSpy).toHaveBeenCalledWith(1);

        const registryAfter = await Registry.load(configDir, dataDir);
        expect(registryAfter.getProject('alpha')?.projectRoot).toBe(alphaRoot);
        expect(registryBefore.getProject('alpha')?.projectRoot).toBe(alphaRoot);
        expect(await fs.promises.stat(path.dirname(markerPath)).catch(() => null)).toBeNull();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  it('does not modify the marker or registry after a conflicting init fails', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const alphaRoot = path.join(root, 'alpha');
      const betaRoot = path.join(root, 'beta');
      await fs.promises.mkdir(alphaRoot, { recursive: true });
      await fs.promises.mkdir(betaRoot, { recursive: true });

      await initCommand({
        projectRoot: alphaRoot,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      const markerPath = path.join(alphaRoot, '.xurgo-atlas', 'project.json');
      const markerBefore = await fs.promises.readFile(markerPath, 'utf-8');
      const registryBefore = await Registry.load(configDir, dataDir);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { exitSpy } = mockProcessExit();

      try {
        await expect(
          initCommand({
            projectRoot: alphaRoot,
            projectId: 'beta',
            configDir,
            dataDir,
          }),
        ).rejects.toThrow('process.exit(1)');

        expect(await fs.promises.readFile(markerPath, 'utf-8')).toBe(markerBefore);
        const registryAfter = await Registry.load(configDir, dataDir);
        expect(registryAfter.getProject('alpha')?.projectRoot).toBe(alphaRoot);
        expect(registryAfter.getProject('beta')).toBeNull();
        expect(registryBefore.getProject('alpha')?.projectRoot).toBe(alphaRoot);
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});

describe('project resolution', () => {
  it('can discover a valid marker and registry binding without managed operational state', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const markerPath = path.join(root, '.xurgo-atlas', 'project.json');
      await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
      await fs.promises.writeFile(path.join(root, '.docs-policy.yml'), 'version: 1\n', 'utf-8');
      await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.promises.writeFile(
        markerPath,
        JSON.stringify({ schemaVersion: 1, projectId: 'alpha' }, null, 2) + '\n',
        'utf-8',
      );
      const registry = await Registry.load(configDir, dataDir);
      await registry.addProject('alpha', root);

      const resolved = await resolveProjectContext({
        cwd: root,
        configDir,
        dataDir,
        requireOperationalState: false,
      });

      expect(resolved).toMatchObject({
        projectId: 'alpha',
        projectRoot: root,
        source: 'cwd-marker',
      });
      expect(fs.existsSync(path.join(dataDir, 'projects', 'alpha'))).toBe(false);
    });
  });

  it('resolves the nearest ancestor marker from a nested subdirectory', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      await initCommand({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      const nested = path.join(root, 'docs', 'nested');
      await fs.promises.mkdir(nested, { recursive: true });

      const resolved = await resolveProjectContext({
        cwd: nested,
        configDir,
        dataDir,
      });

      expect(resolved.projectId).toBe('alpha');
      expect(resolved.projectRoot).toBe(root);
      expect(resolved.source).toBe('ancestor-marker');
    });
  });

  it('falls back to the registry when the marker is absent', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      await initCommand({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      await fs.promises.rm(path.join(root, '.xurgo-atlas'), { recursive: true, force: true });
      const nested = path.join(root, 'docs', 'nested');
      await fs.promises.mkdir(nested, { recursive: true });

      const resolved = await resolveProjectContext({
        cwd: nested,
        configDir,
        dataDir,
      });

      expect(resolved.projectId).toBe('alpha');
      expect(resolved.projectRoot).toBe(root);
      expect(resolved.source).toBe('registry-ancestor-root');
    });
  });

  it('fails when an explicit project id conflicts with the current marker', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const alphaRoot = path.join(root, 'alpha');
      const betaRoot = path.join(root, 'beta');
      await fs.promises.mkdir(alphaRoot, { recursive: true });
      await fs.promises.mkdir(betaRoot, { recursive: true });

      await initCommand({
        projectRoot: alphaRoot,
        projectId: 'alpha',
        configDir,
        dataDir,
      });
      await initCommand({
        projectRoot: betaRoot,
        projectId: 'beta',
        configDir,
        dataDir,
      });

      await expect(
        resolveProjectContext({
          cwd: alphaRoot,
          projectId: 'beta',
          configDir,
          dataDir,
        }),
      ).rejects.toThrow(/resolves to project "alpha"/);
    });
  });
});

describe('daemon start auto-resolution', () => {
  it('rejects an unhydrated but recognized project before inspecting daemon state', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const markerPath = path.join(root, '.xurgo-atlas', 'project.json');
      const pidFile = path.join(root, 'runtime', 'daemon.json');
      await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
      await fs.promises.writeFile(path.join(root, '.docs-policy.yml'), 'version: 1\n', 'utf-8');
      await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.promises.writeFile(
        markerPath,
        JSON.stringify({ schemaVersion: 1, projectId: 'alpha' }, null, 2) + '\n',
        'utf-8',
      );
      const registry = await Registry.load(configDir, dataDir);
      await registry.addProject('alpha', root);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { exitSpy } = mockProcessExit();

      try {
        await withCwd(root, async () => {
          await expect(
            daemonCommand({ action: 'start', configDir, dataDir, pidFile }),
          ).rejects.toThrow('process.exit(1)');
        });

        const output = errorSpy.mock.calls.flat().join('\n');
        expect(output).toContain('Project "alpha" is recognized');
        expect(output).toContain('managed operational state is unavailable');
        expect(output).toContain(path.join(dataDir, 'projects', 'alpha'));
        expect(fs.existsSync(path.join(dataDir, 'projects', 'alpha'))).toBe(false);
        expect(fs.existsSync(pidFile)).toBe(false);
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  it('returns success when the daemon is already running for the same project', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      await initCommand({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      const pidFile = path.join(root, 'runtime', 'daemon.json');
      await writeDaemonPidFile(pidFile, {
        pid: 4242,
        host: '127.0.0.1',
        port: 3737,
        configDir,
        dataDir,
        projectId: 'alpha',
        projectRoot: root,
        startedAt: new Date().toISOString(),
      });

      await withCwd(root, async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const spawnProcess = vi.fn();

        try {
          await daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              pidFile,
            },
            {
              spawnProcess,
              isProcessRunning: (pid) => pid === 4242,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          );

          expect(spawnProcess).not.toHaveBeenCalled();
          const output = logSpy.mock.calls.flat().join('\n');
          expect(output).toContain('already running for project "alpha"');
          expect(output).toContain(root);
        } finally {
          logSpy.mockRestore();
        }
      });
    });
  });

  it('fails when the running daemon is bound to a different current project', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const alphaRoot = path.join(root, 'alpha');
      const betaRoot = path.join(root, 'beta');
      await fs.promises.mkdir(alphaRoot, { recursive: true });
      await fs.promises.mkdir(betaRoot, { recursive: true });

      await initCommand({
        projectRoot: alphaRoot,
        projectId: 'alpha',
        configDir,
        dataDir,
      });
      await initCommand({
        projectRoot: betaRoot,
        projectId: 'beta',
        configDir,
        dataDir,
      });

      const pidFile = path.join(root, 'runtime', 'daemon.json');
      await writeDaemonPidFile(pidFile, {
        pid: 4242,
        host: '127.0.0.1',
        port: 3737,
        configDir,
        dataDir,
        projectId: 'alpha',
        projectRoot: alphaRoot,
        startedAt: new Date().toISOString(),
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { exitSpy } = mockProcessExit();

      await withCwd(betaRoot, async () => {
        await expect(
          daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              pidFile,
            },
            {
              spawnProcess: vi.fn(),
              isProcessRunning: (pid) => pid === 4242,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          ),
        ).rejects.toThrow('process.exit(1)');
      });

      const output = errorSpy.mock.calls.flat().join('\n');
      expect(output).toContain('bound to project "alpha"');
      expect(output).toContain(alphaRoot);
      expect(output).toContain('current command resolved project "beta"');
      expect(output).toContain(betaRoot);
      expect(output).toContain('Stop the existing daemon');
      expect(exitSpy).toHaveBeenCalledWith(1);
      errorSpy.mockRestore();
    });
  });

  it('fails for explicit project id when the running daemon is bound to another project', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const alphaRoot = path.join(root, 'alpha');
      const betaRoot = path.join(root, 'beta');
      const wrongDir = path.join(root, 'wrong-place');
      await fs.promises.mkdir(alphaRoot, { recursive: true });
      await fs.promises.mkdir(betaRoot, { recursive: true });
      await fs.promises.mkdir(wrongDir, { recursive: true });

      await initCommand({
        projectRoot: alphaRoot,
        projectId: 'alpha',
        configDir,
        dataDir,
      });
      await initCommand({
        projectRoot: betaRoot,
        projectId: 'beta',
        configDir,
        dataDir,
      });

      const pidFile = path.join(root, 'runtime', 'daemon.json');
      await writeDaemonPidFile(pidFile, {
        pid: 5252,
        host: '127.0.0.1',
        port: 3737,
        configDir,
        dataDir,
        projectId: 'alpha',
        projectRoot: alphaRoot,
        startedAt: new Date().toISOString(),
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { exitSpy } = mockProcessExit();

      await withCwd(wrongDir, async () => {
        await expect(
          daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectId: 'beta',
              pidFile,
            },
            {
              spawnProcess: vi.fn(),
              isProcessRunning: (pid) => pid === 5252,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          ),
        ).rejects.toThrow('process.exit(1)');
      });

      const output = errorSpy.mock.calls.flat().join('\n');
      expect(output).toContain('bound to project "alpha"');
      expect(output).toContain('current command resolved project "beta"');
      expect(output).toContain('Stop the existing daemon');
      expect(exitSpy).toHaveBeenCalledWith(1);
      errorSpy.mockRestore();
    });
  });

  it('starts from the current project root without explicit flags', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      await initCommand({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      await withCwd(root, async () => {
        const pidFile = path.join(root, 'runtime', 'daemon.json');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const unref = vi.fn();
        const spawnProcess = vi.fn((_command, args: string[]) => {
          const pidIndex = args.indexOf('--pid-file');
          const pidPath = args[pidIndex + 1];
          fs.mkdirSync(path.dirname(pidPath), { recursive: true });
          fs.writeFileSync(
            pidPath,
            JSON.stringify({
              pid: 4242,
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectId: 'alpha',
              projectRoot: root,
              startedAt: new Date().toISOString(),
            }, null, 2) + '\n',
            'utf-8',
          );
          return { pid: 4242, unref };
        });

        try {
          await daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              pidFile,
            },
            {
              spawnProcess,
              isProcessRunning: (pid) => pid === 4242,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          );

          const [, childArgs] = spawnProcess.mock.calls[0];
          const projectIdIndex = childArgs.indexOf('--project-id');
          const projectRootIndex = childArgs.indexOf('--project-root');
          expect(projectIdIndex).toBeGreaterThan(-1);
          expect(childArgs[projectIdIndex + 1]).toBe('alpha');
          expect(projectRootIndex).toBeGreaterThan(-1);
          expect(realPath(childArgs[projectRootIndex + 1])).toBe(realPath(root));
          expect(logSpy.mock.calls.flat().join('\n')).toContain('project "alpha"');
          expect(logSpy.mock.calls.flat().join('\n')).toContain('local marker');
          expect(unref).toHaveBeenCalledTimes(1);
        } finally {
          logSpy.mockRestore();
          errorSpy.mockRestore();
        }
      });
    });
  });

  it('still starts when given only an explicit project id', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const alphaRoot = path.join(root, 'alpha');
      const betaRoot = path.join(root, 'beta');
      await fs.promises.mkdir(alphaRoot, { recursive: true });
      await fs.promises.mkdir(betaRoot, { recursive: true });

      await initCommand({
        projectRoot: alphaRoot,
        projectId: 'alpha',
        configDir,
        dataDir,
      });
      await initCommand({
        projectRoot: betaRoot,
        projectId: 'beta',
        configDir,
        dataDir,
      });

      const wrongDir = path.join(root, 'wrong');
      await fs.promises.mkdir(wrongDir, { recursive: true });

      await withCwd(wrongDir, async () => {
        const pidFile = path.join(root, 'runtime', 'daemon.json');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const spawnProcess = vi.fn((_command, args: string[]) => {
          const pidIndex = args.indexOf('--pid-file');
          const pidPath = args[pidIndex + 1];
          fs.mkdirSync(path.dirname(pidPath), { recursive: true });
          fs.writeFileSync(
            pidPath,
            JSON.stringify({
              pid: 6262,
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectId: 'beta',
              projectRoot: betaRoot,
              startedAt: new Date().toISOString(),
            }, null, 2) + '\n',
            'utf-8',
          );
          return { pid: 6262, unref: vi.fn() };
        });

        try {
          await daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectId: 'beta',
              pidFile: path.join(root, 'runtime', 'daemon.json'),
            },
            {
              spawnProcess,
              isProcessRunning: (pid) => pid === 6262,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          );

          const [, childArgs] = spawnProcess.mock.calls[0];
          const projectIdIndex = childArgs.indexOf('--project-id');
          const projectRootIndex = childArgs.indexOf('--project-root');
          expect(projectIdIndex).toBeGreaterThan(-1);
          expect(childArgs[projectIdIndex + 1]).toBe('beta');
          expect(projectRootIndex).toBeGreaterThan(-1);
          expect(realPath(childArgs[projectRootIndex + 1])).toBe(realPath(betaRoot));
          expect(logSpy.mock.calls.flat().join('\n')).toContain('explicit flags');
        } finally {
          logSpy.mockRestore();
        }
      });
    });
  });

  it('starts when the explicit project id matches the current marker', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      await initCommand({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      await withCwd(root, async () => {
        const pidFile = path.join(root, 'runtime', 'daemon.json');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const spawnProcess = vi.fn((_command, args: string[]) => {
          const pidIndex = args.indexOf('--pid-file');
          const pidPath = args[pidIndex + 1];
          fs.mkdirSync(path.dirname(pidPath), { recursive: true });
          fs.writeFileSync(
            pidPath,
            JSON.stringify({
              pid: 4343,
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectId: 'alpha',
              projectRoot: root,
              startedAt: new Date().toISOString(),
            }, null, 2) + '\n',
            'utf-8',
          );
          return { pid: 4343, unref: vi.fn() };
        });

        try {
          await daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectId: 'alpha',
              pidFile,
            },
            {
              spawnProcess,
              isProcessRunning: (pid) => pid === 4343,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          );

          expect(logSpy.mock.calls.flat().join('\n')).toContain('explicit flags');
        } finally {
          logSpy.mockRestore();
        }
      });
    });
  });

  it('fails when an explicit project id conflicts with the current project marker', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const alphaRoot = path.join(root, 'alpha');
      const betaRoot = path.join(root, 'beta');
      await fs.promises.mkdir(alphaRoot, { recursive: true });
      await fs.promises.mkdir(betaRoot, { recursive: true });

      await initCommand({
        projectRoot: alphaRoot,
        projectId: 'alpha',
        configDir,
        dataDir,
      });
      await initCommand({
        projectRoot: betaRoot,
        projectId: 'beta',
        configDir,
        dataDir,
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { exitSpy } = mockProcessExit();

      await withCwd(alphaRoot, async () => {
        await expect(
          daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectId: 'beta',
              pidFile: path.join(root, 'runtime', 'daemon.json'),
            },
            {
              spawnProcess: vi.fn(),
              isProcessRunning: () => false,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          ),
        ).rejects.toThrow('process.exit(1)');
      });

      const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('resolves to project "alpha"');
      expect(output).toContain('Explicit --project-id was "beta"');
      expect(output).toContain('matching --project-root');
      expect(exitSpy).toHaveBeenCalledWith(1);
      errorSpy.mockRestore();
    });
  });

  it('starts when given only an explicit project root', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      await initCommand({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      const nested = path.join(root, 'docs', 'nested');
      await fs.promises.mkdir(nested, { recursive: true });
      const wrongDir = path.join(root, 'wrong');
      await fs.promises.mkdir(wrongDir, { recursive: true });

      await withCwd(wrongDir, async () => {
        const pidFile = path.join(root, 'runtime', 'daemon.json');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const spawnProcess = vi.fn((_command, args: string[]) => {
          const pidIndex = args.indexOf('--pid-file');
          const pidPath = args[pidIndex + 1];
          fs.mkdirSync(path.dirname(pidPath), { recursive: true });
          fs.writeFileSync(
            pidPath,
            JSON.stringify({
              pid: 6363,
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectId: 'alpha',
              projectRoot: root,
              startedAt: new Date().toISOString(),
            }, null, 2) + '\n',
            'utf-8',
          );
          return { pid: 6363, unref: vi.fn() };
        });

        try {
          await daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectRoot: nested,
              pidFile,
            },
            {
              spawnProcess,
              isProcessRunning: (pid) => pid === 6363,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          );

          const [, childArgs] = spawnProcess.mock.calls[0];
          const projectIdIndex = childArgs.indexOf('--project-id');
          const projectRootIndex = childArgs.indexOf('--project-root');
          expect(projectIdIndex).toBeGreaterThan(-1);
          expect(childArgs[projectIdIndex + 1]).toBe('alpha');
          expect(projectRootIndex).toBeGreaterThan(-1);
          expect(realPath(childArgs[projectRootIndex + 1])).toBe(realPath(root));
          expect(logSpy.mock.calls.flat().join('\n')).toContain('ancestor marker');
        } finally {
          logSpy.mockRestore();
        }
      });
    });
  });

  it('fails when explicit project id and explicit project root point at different projects', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const alphaRoot = path.join(root, 'alpha');
      const betaRoot = path.join(root, 'beta');
      await fs.promises.mkdir(alphaRoot, { recursive: true });
      await fs.promises.mkdir(betaRoot, { recursive: true });

      await initCommand({
        projectRoot: alphaRoot,
        projectId: 'alpha',
        configDir,
        dataDir,
      });
      await initCommand({
        projectRoot: betaRoot,
        projectId: 'beta',
        configDir,
        dataDir,
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { exitSpy } = mockProcessExit();

      await withCwd(root, async () => {
        await expect(
          daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectId: 'alpha',
              projectRoot: betaRoot,
              pidFile: path.join(root, 'runtime', 'daemon.json'),
            },
            {
              spawnProcess: vi.fn(),
              isProcessRunning: () => false,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          ),
        ).rejects.toThrow('process.exit(1)');
      });

      const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain(`The path "${betaRoot}"`);
      expect(output).toContain('resolves to project "beta"');
      expect(output).toContain('Explicit --project-id was "alpha"');
      expect(exitSpy).toHaveBeenCalledWith(1);
      errorSpy.mockRestore();
    });
  });

  it('resolves a nested subdirectory to the nearest ancestor project', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      await initCommand({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      const nested = path.join(root, 'docs', 'nested');
      await fs.promises.mkdir(nested, { recursive: true });

      await withCwd(nested, async () => {
        const pidFile = path.join(root, 'runtime', 'daemon.json');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const spawnProcess = vi.fn((_command, args: string[]) => {
          const pidIndex = args.indexOf('--pid-file');
          const pidPath = args[pidIndex + 1];
          fs.mkdirSync(path.dirname(pidPath), { recursive: true });
          fs.writeFileSync(
            pidPath,
            JSON.stringify({
              pid: 5252,
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              projectId: 'alpha',
              projectRoot: root,
              startedAt: new Date().toISOString(),
            }, null, 2) + '\n',
            'utf-8',
          );
          return { pid: 5252, unref: vi.fn() };
        });

        try {
          await daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              pidFile,
            },
            {
              spawnProcess,
              isProcessRunning: (pid) => pid === 5252,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          );

          expect(logSpy.mock.calls.flat().join('\n')).toContain('ancestor marker');
        } finally {
          logSpy.mockRestore();
        }
      });
    });
  });

  it('fails clearly from a non-project directory with no safe default', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const cwd = path.join(root, 'wrong-place');
      await fs.promises.mkdir(cwd, { recursive: true });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { exitSpy } = mockProcessExit();

      await withCwd(cwd, async () => {
        await expect(
          daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              pidFile: path.join(root, 'runtime', 'daemon.json'),
            },
            {
              spawnProcess: vi.fn(),
              isProcessRunning: () => false,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          ),
        ).rejects.toThrow('process.exit(1)');
      });

      const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('No Xurgo Atlas project could be resolved from the current directory');
      expect(output).toContain('Run the daemon from an initialized project root');
      expect(output).toContain('xurgo-atlas init --project-id <id>');
      expect(output).toContain('--project-id <id>');
      expect(output).not.toContain('has not been initialized');
      expect(output).not.toContain('Unhandled');
      expect(exitSpy).toHaveBeenCalledWith(1);
      errorSpy.mockRestore();
    });
  });

  it('does not silently fall back to the registry default from a non-project directory', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      const projectRoot = path.join(root, 'project');
      const wrongDir = path.join(root, 'wrong-place');
      await fs.promises.mkdir(projectRoot, { recursive: true });
      await fs.promises.mkdir(wrongDir, { recursive: true });

      await initCommand({
        projectRoot,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      const registry = await Registry.load(configDir, dataDir);
      await registry.setDefault('alpha');

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { exitSpy } = mockProcessExit();

      await withCwd(wrongDir, async () => {
        await expect(
          daemonCommand(
            {
              action: 'start',
              host: '127.0.0.1',
              port: 3737,
              configDir,
              dataDir,
              pidFile: path.join(root, 'runtime', 'daemon.json'),
            },
            {
              spawnProcess: vi.fn(),
              isProcessRunning: () => false,
              signalProcess: vi.fn(),
              sleep: async () => undefined,
            },
          ),
        ).rejects.toThrow('process.exit(1)');
      });

      const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('No Xurgo Atlas project could be resolved from the current directory');
      expect(output).not.toContain('registry default');
      expect(exitSpy).toHaveBeenCalledWith(1);
      errorSpy.mockRestore();
    });
  });

  it('lets list resolve a project from a nested subdirectory', async () => {
    await withTempProject(async ({ root, configDir, dataDir }) => {
      await initCommand({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      });

      const nested = path.join(root, 'docs', 'nested');
      await fs.promises.mkdir(nested, { recursive: true });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        await listCommand(nested, configDir, dataDir);
        const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(output).toContain('"projectId": "alpha"');
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
