import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as childProcess from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { simpleGit } from 'simple-git';
import { Project } from '../src/core/project.js';
import { adoptProject } from '../src/core/project-adoption.js';
import { buildDoctorSnapshot } from '../src/cli/doctor.js';
import { getMcpConfigOutput } from '../src/cli/mcp-config.js';
import { projectInspectLifecycleCommand } from '../src/cli/project.js';
import { StoragePaths } from '../src/core/storage.js';

let tmpDir = '';

afterEach(async () => {
  vi.restoreAllMocks();
  if (tmpDir) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

async function createRepoFixture(): Promise<{
  root: string;
  configDir: string;
  dataDir: string;
  git: ReturnType<typeof simpleGit>;
}> {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-adopt-'));
  return createRepoInDirectory(tmpDir, 'repo');
}

async function createRepoInDirectory(
  baseDir: string,
  dirName: string,
): Promise<{
  root: string;
  configDir: string;
  dataDir: string;
  git: ReturnType<typeof simpleGit>;
}> {
  const root = path.join(baseDir, dirName);
  const configDir = path.join(baseDir, 'config');
  const dataDir = path.join(baseDir, 'data');

  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'adoption-fixture',
      version: '1.0.0',
      engines: { node: '>=22' },
    }, null, 2) + '\n',
    'utf-8',
  );
  await fs.promises.writeFile(
    path.join(root, '.gitignore'),
    '.xurgo-atlas/\n',
    'utf-8',
  );

  const git = simpleGit({ baseDir: root });
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  await git.add('.');
  await git.commit('Initial commit');
  await git.raw(['branch', '-M', 'main']);

  return { root, configDir, dataDir, git };
}

async function readRegistry(configDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.promises.readFile(path.join(configDir, 'projects.json'), 'utf-8')) as Record<string, unknown>;
}

async function sha256File(filePath: string): Promise<string> {
  const content = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function realPath(value: string): string {
  return fs.realpathSync.native(value);
}

async function writeMarker(root: string, projectId: string): Promise<void> {
  const markerPath = path.join(root, '.xurgo-atlas', 'project.json');
  await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.promises.writeFile(
    markerPath,
    JSON.stringify({ schemaVersion: 1, projectId }, null, 2) + '\n',
    'utf-8',
  );
}

describe('project adoption', () => {
  it('adopts a clean clone with explicit identity and leaves the repository clean', async () => {
    const { root, configDir, dataDir, git } = await createRepoFixture();

    const result = await adoptProject({
      projectRoot: root,
      projectId: 'adoption-fixture',
      configDir,
      dataDir,
    });

    expect(result.created).toBe(true);
    expect(result.alreadyAdopted).toBe(false);
    expect(result.projectId).toBe('adoption-fixture');
    expect(result.projectRoot).toBe(realPath(root));
    expect(await readRegistry(configDir)).toMatchObject({
      projects: {
        'adoption-fixture': {
          projectId: 'adoption-fixture',
          projectRoot: realPath(root),
        },
      },
    });
    expect(fs.existsSync(path.join(dataDir, 'projects', 'adoption-fixture'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.xurgo-atlas'))).toBe(false);
    expect((await git.status()).files).toHaveLength(0);
  });

  it('adopts a legacy marker without hydrating a managed store', async () => {
    const { root, configDir, dataDir, git } = await createRepoFixture();
    await writeMarker(root, 'legacy-adoption');

    const first = await adoptProject({
      projectRoot: root,
      configDir,
      dataDir,
    });
    const second = await adoptProject({
      projectRoot: root,
      configDir,
      dataDir,
    });

    expect(first.created).toBe(true);
    expect(first.projectId).toBe('legacy-adoption');
    expect(second.alreadyAdopted).toBe(true);
    expect(await readRegistry(configDir)).toMatchObject({
      projects: {
        'legacy-adoption': {
          projectId: 'legacy-adoption',
          projectRoot: realPath(root),
        },
      },
    });
    expect(fs.existsSync(path.join(dataDir, 'projects', 'legacy-adoption'))).toBe(false);
    expect(await fs.promises.readFile(path.join(root, '.xurgo-atlas', 'project.json'), 'utf-8')).toContain('"legacy-adoption"');
    expect((await git.status()).files).toHaveLength(0);
  });

  it('rejects a conflicting marker and explicit identity pair', async () => {
    const { root, configDir, dataDir } = await createRepoFixture();
    await writeMarker(root, 'alpha');

    await expect(
      adoptProject({
        projectRoot: root,
        projectId: 'beta',
        configDir,
        dataDir,
      }),
    ).rejects.toThrow(/Local project marker/);

    expect(fs.existsSync(path.join(configDir, 'projects.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'projects'))).toBe(false);
  });

  it('rejects an invalid explicit project identity', async () => {
    const { root, configDir, dataDir } = await createRepoFixture();

    await expect(
      adoptProject({
        projectRoot: root,
        projectId: 'not valid',
        configDir,
        dataDir,
      }),
    ).rejects.toThrow(/is invalid/);

    expect(fs.existsSync(path.join(configDir, 'projects.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'projects'))).toBe(false);
  });

  it('is idempotent for the same canonical root', async () => {
    const { root, configDir, dataDir } = await createRepoFixture();

    const first = await adoptProject({
      projectRoot: root,
      projectId: 'alpha',
      configDir,
      dataDir,
    });
    const registryAfterFirst = await readRegistry(configDir);
    const second = await adoptProject({
      projectRoot: root,
      projectId: 'alpha',
      configDir,
      dataDir,
    });
    const registryAfterSecond = await readRegistry(configDir);

    expect(first.created).toBe(true);
    expect(second.alreadyAdopted).toBe(true);
    expect(registryAfterSecond).toEqual(registryAfterFirst);
    expect(fs.existsSync(path.join(dataDir, 'projects', 'alpha'))).toBe(false);
  });

  it.each([
    ['second clone', 'same project id on a second checkout'],
    ['fork/rekey', 'same legacy marker on a forked checkout'],
  ])('rejects registry collisions for %s', async (_label, scenario) => {
    const source = await createRepoFixture();
    await adoptProject({
      projectRoot: source.root,
      projectId: 'collision-project',
      configDir: source.configDir,
      dataDir: source.dataDir,
    });

    const otherRoot = path.join(tmpDir, `${scenario.replace(/\s+/g, '-')}`);
    const cloneGit = simpleGit({ baseDir: tmpDir });
    await cloneGit.clone(source.root, otherRoot);

    if (scenario.includes('fork')) {
      await writeMarker(otherRoot, 'collision-project');
    }

    await expect(
      adoptProject({
        projectRoot: otherRoot,
        projectId: scenario.includes('fork') ? undefined : 'collision-project',
        configDir: source.configDir,
        dataDir: source.dataDir,
      }),
    ).rejects.toThrow(/Adoption will not rebind|will not overwrite/);
  });

  it('rejects a canonical root that is already registered to another project id', async () => {
    const { root, configDir, dataDir } = await createRepoFixture();
    await adoptProject({
      projectRoot: root,
      projectId: 'alpha',
      configDir,
      dataDir,
    });

    await expect(
      adoptProject({
        projectRoot: root,
        projectId: 'beta',
        configDir,
        dataDir,
      }),
    ).rejects.toThrow(/already registered as project "alpha"/);
  });

  it('rejects moved-checkout registry collisions instead of rebinding automatically', async () => {
    const { root, configDir, dataDir } = await createRepoFixture();
    const missingRoot = path.join(tmpDir, 'missing-checkout');
    await fs.promises.mkdir(path.dirname(missingRoot), { recursive: true });

    await fs.promises.mkdir(configDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(configDir, 'projects.json'),
      JSON.stringify({
        version: 2,
        configDir,
        dataDir,
        defaultProjectId: null,
        projects: {
          alpha: {
            projectId: 'alpha',
            projectRoot: missingRoot,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }, null, 2) + '\n',
      'utf-8',
    );

    await expect(
      adoptProject({
        projectRoot: root,
        projectId: 'alpha',
        configDir,
        dataDir,
      }),
    ).rejects.toThrow(/looks like a moved checkout or stale registry entry/);
  });

  it('rejects nested paths and requires the checkout root', async () => {
    const { root, configDir, dataDir } = await createRepoFixture();
    const nestedRoot = path.join(root, 'packages', 'app');
    await fs.promises.mkdir(nestedRoot, { recursive: true });

    await expect(
      adoptProject({
        projectRoot: nestedRoot,
        projectId: 'nested-project',
        configDir,
        dataDir,
      }),
    ).rejects.toThrow(/must target the checkout root/);
  });

  it('rejects symlinked checkout roots', async () => {
    const { root, configDir, dataDir } = await createRepoFixture();
    const symlinkRoot = path.join(tmpDir, 'repo-link');
    await fs.promises.symlink(root, symlinkRoot, 'dir');

    await expect(
      adoptProject({
        projectRoot: symlinkRoot,
        projectId: 'symlink-project',
        configDir,
        dataDir,
      }),
    ).rejects.toThrow(/symlinked or aliased root/);

    expect(fs.existsSync(path.join(configDir, 'projects.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'projects'))).toBe(false);
  });

  it('rejects linked worktree checkouts', async () => {
    const { root, configDir, dataDir } = await createRepoFixture();
    const worktreeRoot = path.join(tmpDir, 'repo-worktree');
    await simpleGit({ baseDir: root }).raw(['worktree', 'add', worktreeRoot, '-b', 'worktree-adoption']);

    await expect(
      adoptProject({
        projectRoot: worktreeRoot,
        projectId: 'worktree-project',
        configDir,
        dataDir,
      }),
    ).rejects.toThrow(/linked Git worktree/);

    expect(fs.existsSync(path.join(configDir, 'projects.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'projects'))).toBe(false);
  });

  it('leaves a fully initialized project unchanged during adoption', async () => {
    const { root, configDir, dataDir, git } = await createRepoFixture();
    const project = await Project.init({
      projectRoot: root,
      projectId: 'alpha',
      configDir,
      dataDir,
    });

    await git.add('.');
    await git.commit('Initialize Atlas fixture');

    const proposal = project.eventLog.storeProposal({
      project_id: 'alpha',
      branch: 'main',
      path: 'STATUS.md',
      base_revision: 'main',
      patch: '--- a/STATUS.md\n+++ b/STATUS.md\n@@\n-old\n+new\n',
      intent: 'Preserve proposal evidence',
      summary: 'Seed a pending proposal',
      risk_level: 'low',
      requires_approval: false,
    });
    const historyEvent = project.eventLog.logEvent({
      project_id: 'alpha',
      branch: 'main',
      path: 'STATUS.md',
      tool_name: 'docs.propose_patch',
      intent: 'Preserve event trail',
      summary: 'Seed a history entry',
      base_revision: 'main',
      result_revision: 'main',
    });

    const before = {
      repoDir: project.gitStore.repoDir,
      repoHead: await project.gitStore.getBranchHead('main'),
      trackedFiles: await project.getTrackedFiles('main'),
      statusHash: await sha256File(path.join(root, 'STATUS.md')),
      manifestHash: await sha256File(path.join(root, 'docs', 'manifest.yml')),
      policyHash: await sha256File(path.join(root, '.docs-policy.yml')),
      markerHash: await sha256File(path.join(root, '.xurgo-atlas', 'project.json')),
      eventLogHash: await sha256File(project.storage.projectEventsPath('alpha')),
      registryHash: await sha256File(path.join(configDir, 'projects.json')),
      proposal: project.eventLog.getProposal(proposal.id),
      proposalHistory: project.eventLog.getHistoryForPath('alpha', 'STATUS.md'),
      gitStatus: (await git.status()).files,
    };

    const result = await adoptProject({
      projectRoot: root,
      projectId: 'alpha',
      configDir,
      dataDir,
    });

    const after = {
      repoDir: project.gitStore.repoDir,
      repoHead: await project.gitStore.getBranchHead('main'),
      trackedFiles: await project.getTrackedFiles('main'),
      statusHash: await sha256File(path.join(root, 'STATUS.md')),
      manifestHash: await sha256File(path.join(root, 'docs', 'manifest.yml')),
      policyHash: await sha256File(path.join(root, '.docs-policy.yml')),
      markerHash: await sha256File(path.join(root, '.xurgo-atlas', 'project.json')),
      eventLogHash: await sha256File(project.storage.projectEventsPath('alpha')),
      registryHash: await sha256File(path.join(configDir, 'projects.json')),
      proposal: project.eventLog.getProposal(proposal.id),
      proposalHistory: project.eventLog.getHistoryForPath('alpha', 'STATUS.md'),
      gitStatus: (await git.status()).files,
    };

    expect(result.alreadyAdopted).toBe(true);
    expect(after).toEqual(before);
    expect(after.repoDir).toBe(project.gitStore.repoDir);
    expect(after.proposal?.id).toBe(proposal.id);
    expect(after.proposal?.patch).toBe(proposal.patch);
    expect(after.proposalHistory[0]?.id).toBe(historyEvent.id);
    expect(after.proposalHistory[0]?.summary).toBe(historyEvent.summary);
  });

  it('preserves an existing proposal draft and event trail without export or rewrite', async () => {
    const { root, configDir, dataDir, git } = await createRepoFixture();
    const project = await Project.init({
      projectRoot: root,
      projectId: 'alpha',
      configDir,
      dataDir,
    });

    await git.add('.');
    await git.commit('Initialize Atlas fixture');

    const proposal = project.eventLog.storeProposal({
      project_id: 'alpha',
      branch: 'main',
      path: 'docs/README.md',
      base_revision: 'main',
      patch: '--- a/docs/README.md\n+++ b/docs/README.md\n@@\n-old\n+new\n',
      intent: 'Keep proposal draft intact',
      summary: 'Seed a draft proposal',
      risk_level: 'low',
      requires_approval: false,
    });
    const event = project.eventLog.logEvent({
      project_id: 'alpha',
      branch: 'main',
      path: 'docs/README.md',
      tool_name: 'docs.propose_patch',
      intent: 'Keep proposal draft intact',
      summary: 'Seed a history entry',
      base_revision: 'main',
      result_revision: 'main',
    });

    const before = {
      proposal: project.eventLog.getProposal(proposal.id),
      history: project.eventLog.getHistoryForPath('alpha', 'docs/README.md'),
      eventLogHash: await sha256File(project.storage.projectEventsPath('alpha')),
      rootGitStatus: (await git.status()).files,
      manifestHash: await sha256File(path.join(root, 'docs', 'manifest.yml')),
    };

    const result = await adoptProject({
      projectRoot: root,
      projectId: 'alpha',
      configDir,
      dataDir,
    });

    const after = {
      proposal: project.eventLog.getProposal(proposal.id),
      history: project.eventLog.getHistoryForPath('alpha', 'docs/README.md'),
      eventLogHash: await sha256File(project.storage.projectEventsPath('alpha')),
      rootGitStatus: (await git.status()).files,
      manifestHash: await sha256File(path.join(root, 'docs', 'manifest.yml')),
    };

    expect(result.alreadyAdopted).toBe(true);
    expect(after).toEqual(before);
    expect(after.proposal?.id).toBe(proposal.id);
    expect(after.proposal?.patch).toBe(proposal.patch);
    expect(after.history[0]?.id).toBe(event.id);
    expect(after.history[0]?.summary).toBe(event.summary);
  });

  it('keeps a daemon-bound-elsewhere runtime record untouched and diagnosis truthful', async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-adopt-daemon-'));
    const { root: sourceRoot, configDir, dataDir } = await createRepoInDirectory(tmpDir, 'source');
    const { root: targetRoot, git: targetGit } = await createRepoInDirectory(tmpDir, 'target');

    await Project.init({
      projectRoot: sourceRoot,
      projectId: 'source-project',
      configDir,
      dataDir,
    });

    const storage = new StoragePaths({ configDir, dataDir });
    const daemonPidPath = storage.daemonPidFilePath();
    await fs.promises.mkdir(path.dirname(daemonPidPath), { recursive: true });
    const daemonRecord = {
      pid: 4242,
      projectId: 'source-project',
      projectRoot: sourceRoot,
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    await fs.promises.writeFile(daemonPidPath, JSON.stringify(daemonRecord, null, 2) + '\n', 'utf-8');

    const beforeRegistry = await readRegistry(configDir) as {
      projects: Record<string, { projectId: string; projectRoot: string; createdAt: string; updatedAt: string }>;
    };
    const before = {
      daemonHash: await sha256File(daemonPidPath),
      targetGitStatus: (await targetGit.status()).files,
    };

    const result = await adoptProject({
      projectRoot: targetRoot,
      projectId: 'target-project',
      configDir,
      dataDir,
    });

    const afterDoctor = await buildDoctorSnapshot({
      cwd: targetRoot,
      configDir,
      dataDir,
    });
    const afterRegistry = await readRegistry(configDir) as {
      projects: Record<string, { projectId: string; projectRoot: string; createdAt: string; updatedAt: string }>;
    };
    const after = {
      daemonHash: await sha256File(daemonPidPath),
      targetGitStatus: (await targetGit.status()).files,
    };

    expect(result.created).toBe(true);
    expect(result.alreadyAdopted).toBe(false);
    expect(after.daemonHash).toBe(before.daemonHash);
    expect(after.targetGitStatus).toEqual(before.targetGitStatus);
    expect(afterRegistry.projects['source-project']).toEqual(beforeRegistry.projects['source-project']);
    expect(afterRegistry.projects['target-project']).toMatchObject({
      projectId: 'target-project',
      projectRoot: realPath(targetRoot),
    });
    expect(afterDoctor.project.identity.daemonBound).toBe(false);
    expect(afterDoctor.project.identity.managedStoreAvailable).toBe(false);
    expect(afterDoctor.project.identity.governanceActivated).toBe(false);
    expect(afterDoctor.project.identity.readOnlyDiscoveryEligible).toBe(true);
    expect(afterDoctor.project.identity.managedWriteEligible).toBe(false);
  });

  it('blocks network and only uses local git subprocesses during adoption', async () => {
    const { root, configDir, dataDir } = await createRepoFixture();
    const tmpBin = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-adopt-bin-'));
    const realGit = childProcess.execFileSync('sh', ['-lc', 'command -v git'], { encoding: 'utf-8' }).trim();
    const gitWrapper = path.join(tmpBin, 'git');
    const gitLog = path.join(tmpBin, 'git-invocations.log');
    const originalPath = process.env.PATH ?? '';
    const originalPathValue = process.env.PATH;
    const denyNetwork = () => {
      throw new Error('network blocked by adoption evidence test');
    };

    await fs.promises.writeFile(
      gitWrapper,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${gitLog}"
case "$*" in
  *fetch*|*clone*|*ls-remote*|*push*|*remote*|*submodule* )
    echo "network git command blocked: $*" >&2
    exit 91
    ;;
esac
exec "${realGit}" "$@"
`,
      'utf-8',
    );
    await fs.promises.chmod(gitWrapper, 0o755);

    process.env.PATH = `${tmpBin}${path.delimiter}${originalPath}`;

    const networkSpies = [
      vi.spyOn(net, 'createConnection').mockImplementation(denyNetwork as never),
      vi.spyOn(net, 'connect').mockImplementation(denyNetwork as never),
      vi.spyOn(tls, 'connect').mockImplementation(denyNetwork as never),
      vi.spyOn(http, 'request').mockImplementation(denyNetwork as never),
      vi.spyOn(https, 'request').mockImplementation(denyNetwork as never),
      vi.spyOn(dns, 'lookup').mockImplementation(denyNetwork as never),
    ];

    try {
      const result = await adoptProject({
        projectRoot: root,
        projectId: 'network-project',
        configDir,
        dataDir,
      });

      expect(result.created).toBe(true);
      const gitInvocations = await fs.promises.readFile(gitLog, 'utf-8');
      expect(gitInvocations.trim().length).toBeGreaterThan(0);
      expect(gitInvocations).not.toContain('fetch');
      expect(gitInvocations).not.toContain('clone');
      expect(gitInvocations).not.toContain('ls-remote');
      expect(gitInvocations).not.toContain('push');
    } finally {
      process.env.PATH = originalPathValue;
      for (const spy of networkSpies) {
        spy.mockRestore();
      }
    }
  });

  it('preserves proposals on an already initialized project', async () => {
    const { root, configDir, dataDir, git } = await createRepoFixture();
    const project = await Project.init({
      projectRoot: root,
      projectId: 'alpha',
      configDir,
      dataDir,
    });

    await git.add('.');
    await git.commit('Initialize Atlas fixture');

    project.eventLog.storeProposal({
      project_id: 'alpha',
      branch: 'main',
      path: 'STATUS.md',
      base_revision: 'main',
      patch: '--- a/STATUS.md\n+++ b/STATUS.md\n@@\n-old\n+new\n',
      intent: 'Keep proposal for preservation test',
      summary: 'Seed a pending proposal',
      risk_level: 'low',
      requires_approval: false,
    });

    const pendingBefore = project.eventLog.listProposals({
      projectId: 'alpha',
      status: 'pending',
    });

    const result = await adoptProject({
      projectRoot: root,
      projectId: 'alpha',
      configDir,
      dataDir,
    });

    const pendingAfter = project.eventLog.listProposals({
      projectId: 'alpha',
      status: 'pending',
    });

    expect(result.alreadyAdopted).toBe(true);
    expect(pendingAfter).toHaveLength(pendingBefore.length);
    expect((await git.status()).files).toHaveLength(0);
  });

  it('keeps an adopted-but-unhydrated identity visible to lifecycle and mcp-config', async () => {
    const { root, configDir, dataDir, git } = await createRepoFixture();
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'docs', 'README.md'), '# Adopted project\n', 'utf-8');
    await fs.promises.writeFile(path.join(root, '.docs-policy.yml'), 'version: 1\n', 'utf-8');
    await git.add(['docs', '.docs-policy.yml']);
    await git.commit('Add project documents');
    await adoptProject({
      projectRoot: root,
      projectId: 'alpha',
      configDir,
      dataDir,
    });
    await writeMarker(root, 'alpha');

    const snapshot = await buildDoctorSnapshot({
      cwd: root,
      configDir,
      dataDir,
    });

    expect(snapshot.project.projectId).toBe('alpha');
    expect(snapshot.project.identity.identityKnown).toBe(true);
    expect(snapshot.project.identity.identityRegistered).toBe(true);
    expect(snapshot.project.identity.managedStoreAvailable).toBe(false);
    expect(snapshot.project.identity.governanceActivated).toBe(false);
    expect(snapshot.project.identity.readOnlyDiscoveryEligible).toBe(true);
    expect(snapshot.project.identity.managedWriteEligible).toBe(false);
    expect(snapshot.project.identity.daemonBound).toBe(false);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const lifecycle = await projectInspectLifecycleCommand({
      projectId: 'alpha',
      projectRoot: root,
      configDir,
      dataDir,
      json: false,
    });
    logSpy.mockRestore();

    expect(lifecycle.primaryStatus).toBe('registered_binding_observed');
    expect(lifecycle.witnesses.marker.rawObservation).toBe('present');
    expect(lifecycle.witnesses.managedProjectDirectory.rawObservation).toBe('absent');

    const mcpConfig = JSON.parse(
      await getMcpConfigOutput({
        json: true,
        cwd: root,
        configDir,
        dataDir,
      }),
    ) as {
      projectId: string | null;
      projectRoot: string | null;
      projectSource: string | null;
      registeredProjectRoot: string | null;
      safety: {
        safeForWrites: boolean;
        markerMissing: boolean;
        registeredProjectRootMissing: boolean;
        warnings: string[];
      };
      operational: {
        available: boolean;
        blocker: string;
        managedProjectDir: string | null;
      };
    };

    expect(mcpConfig.projectId).toBe('alpha');
    expect(mcpConfig.projectRoot).toBe(root);
    expect(mcpConfig.projectSource).toBe('cwd-marker');
    expect(mcpConfig.registeredProjectRoot).toBe(realPath(root));
    expect(mcpConfig.safety.safeForWrites).toBe(false);
    expect(mcpConfig.safety.markerMissing).toBe(false);
    expect(mcpConfig.safety.registeredProjectRootMissing).toBe(false);
    expect(mcpConfig.safety.warnings).toContain(
      `managed project data directory unavailable: ${path.join(dataDir, 'projects', 'alpha')}`,
    );
    expect(mcpConfig.operational).toEqual({
      available: false,
      blocker: 'managed-store-missing',
      managedProjectDir: path.join(dataDir, 'projects', 'alpha'),
    });
    expect(fs.existsSync(path.join(dataDir, 'projects', 'alpha'))).toBe(false);
    expect((await git.status()).files).toHaveLength(0);
  });
});
