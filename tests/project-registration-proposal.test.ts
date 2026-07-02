import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { main } from '../src/index.js';
import { createMcpServer } from '../src/mcp/create-server.js';
import { buildProjectRegistrationProposal } from '../src/core/project-registration-proposal.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-registration-proposal-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('project registration proposal', () => {
  it('emits matching diagnostic-only CLI and MCP proposals for one supported checkout without mutating fixtures', async () => {
    const fixture = await createCheckoutFixture('alpha');
    const before = await snapshotFixture(fixture.snapshotRoots);

    const cli = await runMainWithArgs([
      'node',
      'xurgo-atlas',
      'project',
      'propose-registration',
      '--project-root',
      fixture.root,
      '--project-id',
      'alpha',
      '--config-dir',
      fixture.configDir,
      '--data-dir',
      fixture.dataDir,
      '--json',
    ]);

    expect(cli.exitCode).toBe(-1);
    expect(cli.stderr).toBe('');
    const cliProposal = JSON.parse(cli.stdout);

    expect(cliProposal).toMatchObject({
      schemaVersion: 1,
      kind: 'atlas.project-registration.proposal',
      diagnosticOnly: {
        readOnly: true,
        mutating: false,
        authorizationEstablished: false,
        operationalEligibilityEstablished: false,
        safeForWritesEstablished: false,
        daemonReadinessEstablished: false,
        registrationReserved: false,
      },
      requested: {
        rootInput: fixture.root,
        cwdFallbackUsed: false,
        projectId: 'alpha',
        selectedConfigDir: fixture.configDir,
        selectedDataDir: fixture.dataDir,
      },
      projectIdentity: {
        projectId: 'alpha',
        source: 'explicit',
        validationStatus: 'valid',
        conflictStatus: 'none_observed',
      },
      marker: {
        readStatus: 'observed',
        projectId: 'alpha',
        agreesWithProposedProjectId: true,
      },
      registry: {
        readStatus: 'observed',
        collisionStatus: 'none_observed',
      },
      git: {
        insideWorkTree: true,
        branch: 'main',
        linkedWorktree: false,
      },
      managedState: {
        managedProjectDirectory: {
          classification: 'observed',
        },
        managedGitStore: {
          classification: 'observed',
        },
        eventDatabase: {
          classification: 'observed',
        },
        searchDatabase: {
          classification: 'observed',
        },
      },
      safety: {
        safeForWrites: true,
        singleCheckoutApplicable: true,
        ineligibleRootReasons: [],
      },
    });
    expect(cliProposal.root.canonicalRoot).toBe(await fs.promises.realpath(fixture.root));
    expect(cliProposal.git.worktreeRoot).toBe(await fs.promises.realpath(fixture.root));
    expect(cliProposal.prohibitedImplications).toContain('registration conversion');
    expect(cliProposal.nextRequiredAction).toContain('fresh re-observation');

    const mcpProposal = await callProposalTool({
      projectRoot: fixture.root,
      projectId: 'alpha',
      configDir: fixture.configDir,
      dataDir: fixture.dataDir,
    });

    expect(mcpProposal.kind).toBe(cliProposal.kind);
    expect(mcpProposal.projectIdentity).toEqual(cliProposal.projectIdentity);
    expect(mcpProposal.root).toEqual(cliProposal.root);
    expect(mcpProposal.marker).toEqual(cliProposal.marker);
    expect(mcpProposal.registry.collisionStatus).toBe('none_observed');
    expect(mcpProposal.diagnosticOnly).toEqual(cliProposal.diagnosticOnly);

    const after = await snapshotFixture(fixture.snapshotRoots);
    expect(after).toEqual(before);
  });

  it('keeps unavailable and conflicting evidence classifications distinct', async () => {
    const fixture = await createCheckoutFixture('alpha');
    const otherRoot = path.join(tmpDir, 'other-root');
    await fs.promises.mkdir(otherRoot, { recursive: true });
    await writeRegistry(fixture.configDir, fixture.dataDir, {
      alpha: fixture.root,
      beta: otherRoot,
    });
    await fs.promises.rm(path.join(fixture.dataDir, 'projects', 'alpha'), { recursive: true, force: true });
    await fs.promises.mkdir(path.join(fixture.dataDir, 'projects', 'beta'), { recursive: true });
    await fs.promises.writeFile(path.join(fixture.dataDir, 'projects', 'beta', 'repo.git'), 'not a directory', 'utf-8');

    const proposal = await buildProjectRegistrationProposal({
      projectRoot: fixture.root,
      projectId: 'beta',
      configDir: fixture.configDir,
      dataDir: fixture.dataDir,
    });

    expect(proposal.projectIdentity).toMatchObject({
      projectId: 'beta',
      source: 'explicit',
      conflictStatus: 'explicit_marker_conflict',
    });
    expect(proposal.marker).toMatchObject({
      presence: 'observed',
      projectId: 'alpha',
      agreesWithProposedProjectId: false,
    });
    expect(proposal.registry.collisionStatus).toBe('conflicting');
    expect(proposal.managedState.managedGitStore).toMatchObject({
      classification: 'unavailable',
      exists: true,
      kind: 'file',
    });
    expect(proposal.managedState.eventDatabase.classification).toBe('absent');
    expect(proposal.safety.safeForWrites).toBe(false);
    expect(proposal.safety.warnings).toContain('marker project id mismatch');
    expect(proposal.safety.warnings).toContain('registry collision evidence observed');

    const classifications = new Set(proposal.evidence.map((item) => item.classification));
    expect(classifications).toContain('observed');
    expect(classifications).toContain('absent');
    expect(classifications).toContain('unavailable');
    expect(classifications).toContain('conflicting');
    expect(proposal.evidence.find((item) => item.id === 'projectIdentity.selected')).toMatchObject({
      classification: 'conflicting',
    });
  });

  it('reports linked worktree evidence as ineligible without implying registration authority', async () => {
    const fixture = await createCheckoutFixture('alpha');
    const linkedRoot = path.join(tmpDir, 'linked-root');
    await simpleGit({ baseDir: fixture.root }).raw(['worktree', 'add', linkedRoot, '-b', 'linked-registration-proposal']);
    await writeMarker(linkedRoot, 'alpha-linked');
    await writeRegistry(fixture.configDir, fixture.dataDir, {
      'alpha-linked': linkedRoot,
    });

    const proposal = await buildProjectRegistrationProposal({
      projectRoot: linkedRoot,
      projectId: 'alpha-linked',
      configDir: fixture.configDir,
      dataDir: fixture.dataDir,
    });

    expect(proposal.root.requestedPathIsCheckoutRoot).toBe(true);
    expect(proposal.git.insideWorkTree).toBe(true);
    expect(proposal.git.linkedWorktree).toBe(true);
    expect(proposal.safety.singleCheckoutApplicable).toBe(false);
    expect(proposal.safety.safeForWrites).toBe(false);
    expect(proposal.safety.ineligibleRootReasons).toContain('linked worktree or non-primary checkout evidence observed');
    expect(proposal.prohibitedImplications).toContain('adoption/rebind eligibility');
    expect(proposal.diagnosticOnly.registrationReserved).toBe(false);
  });

  it('does not create registry, marker, daemon, managed-state, manifest, or administration files for an empty root', async () => {
    const root = path.join(tmpDir, 'empty-root');
    const configDir = path.join(tmpDir, 'config');
    const dataDir = path.join(tmpDir, 'data');
    await fs.promises.mkdir(root, { recursive: true });
    const before = await snapshotFixture([root, configDir, dataDir]);

    const proposal = await buildProjectRegistrationProposal({
      projectRoot: root,
      projectId: 'new-project',
      configDir,
      dataDir,
    });

    expect(proposal.marker.readStatus).toBe('absent');
    expect(proposal.registry.readStatus).toBe('absent');
    expect(proposal.daemon.status).toBe('absent');
    expect(proposal.managedState.managedProjectDirectory.classification).toBe('absent');
    expect(proposal.diagnosticOnly.mutating).toBe(false);
    expect(proposal.diagnosticOnly.authorizationEstablished).toBe(false);
    expect(proposal.nextRequiredAction).toContain('explicit human authorization');

    const after = await snapshotFixture([root, configDir, dataDir]);
    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(root, '.xurgo-atlas'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'projects.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'projects'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'runtime'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'docs', 'manifest.yml'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.docs-policy.yml'))).toBe(false);
  });
});

async function createCheckoutFixture(projectId: string): Promise<{
  root: string;
  configDir: string;
  dataDir: string;
  snapshotRoots: string[];
}> {
  const root = path.join(tmpDir, projectId);
  const configDir = path.join(tmpDir, 'config');
  const dataDir = path.join(tmpDir, 'data');
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.writeFile(path.join(root, 'README.md'), `# ${projectId}\n`, 'utf-8');
  const git = simpleGit({ baseDir: root });
  await git.init();
  await git.addConfig('user.email', 'atlas@example.test');
  await git.addConfig('user.name', 'Atlas Test');
  await git.checkoutLocalBranch('main');
  await git.add('.');
  await git.commit('initial');
  await writeMarker(root, projectId);
  await writeRegistry(configDir, dataDir, {
    [projectId]: root,
  });
  await fs.promises.mkdir(path.join(dataDir, 'projects', projectId, 'repo.git'), { recursive: true });
  await fs.promises.writeFile(path.join(dataDir, 'projects', projectId, 'events.sqlite'), 'events', 'utf-8');
  await fs.promises.writeFile(path.join(dataDir, 'projects', projectId, 'search.sqlite'), 'search', 'utf-8');

  return {
    root,
    configDir,
    dataDir,
    snapshotRoots: [root, configDir, dataDir],
  };
}

async function writeMarker(projectRoot: string, projectId: string): Promise<void> {
  const markerPath = path.join(projectRoot, '.xurgo-atlas', 'project.json');
  await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.promises.writeFile(
    markerPath,
    JSON.stringify({ schemaVersion: 1, projectId }, null, 2) + '\n',
    'utf-8',
  );
}

async function writeRegistry(
  configDir: string,
  dataDir: string,
  rootsByProjectId: Record<string, string>,
): Promise<void> {
  await fs.promises.mkdir(configDir, { recursive: true });
  const projects = Object.fromEntries(
    Object.entries(rootsByProjectId).map(([projectId, projectRoot]) => [
      projectId,
      {
        projectId,
        projectRoot,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
  );
  await fs.promises.writeFile(
    path.join(configDir, 'projects.json'),
    JSON.stringify({
      version: 2,
      configDir,
      dataDir,
      defaultProjectId: null,
      projects,
    }, null, 2) + '\n',
    'utf-8',
  );
}

async function callProposalTool(args: Record<string, unknown>): Promise<Record<string, any>> {
  const server = createMcpServer(async () => {
    throw new Error('proposal tool should not resolve a project');
  });
  const handlers = (server as unknown as {
    _requestHandlers: Map<string, (request: unknown) => Promise<unknown>>;
  })._requestHandlers;
  const call = handlers.get('tools/call');
  expect(call).toBeTypeOf('function');
  const result = await call!({
    method: 'tools/call',
    params: {
      name: 'atlas.project_registration_proposal',
      arguments: args,
    },
  }) as { content: Array<{ text: string }>; isError?: boolean };

  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

async function runMainWithArgs(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const originalArgv = process.argv;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitError = new Error('process.exit');
  let exitCode = -1;

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    stdoutLines.push(args.join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    stderrLines.push(args.join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw exitError;
  }) as never);

  process.argv = argv;

  try {
    await main();
  } catch (error) {
    if (error !== exitError) {
      throw error;
    }
  } finally {
    process.argv = originalArgv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    exitCode,
    stdout: stdoutLines.join('\n'),
    stderr: stderrLines.join('\n'),
  };
}

async function snapshotFixture(roots: string[]): Promise<Record<string, Record<string, string>>> {
  const entries = await Promise.all(
    roots.map(async (root) => [root, await snapshotFiles(root)] as const),
  );
  return Object.fromEntries(entries);
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
        snapshot[`${relative}/`] = 'directory';
        await walk(fullPath);
      } else if (entry.isFile()) {
        snapshot[relative] = crypto.createHash('sha256')
          .update(await fs.promises.readFile(fullPath))
          .digest('hex');
      } else {
        snapshot[relative] = 'other';
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
