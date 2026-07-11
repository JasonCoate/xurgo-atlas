#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..');
export const EXPECTED_ORIGIN = 'https://github.com/xurgo/xurgo-atlas.git';
export const EXPECTED_PACKAGE_NAME = 'xurgo-atlas';
export const RELEASE_OWNER = 'xurgo';
export const RELEASE_REPO = 'xurgo-atlas';

/** Accept only the canonical GitHub HTTPS repository identity, ignoring case in GitHub owner/name spelling. */
export function isExpectedOrigin(originRemote) {
  try {
    const origin = new URL(originRemote);
    return origin.protocol === 'https:'
      && origin.hostname.toLowerCase() === 'github.com'
      && origin.port === ''
      && origin.username === ''
      && origin.password === ''
      && origin.search === ''
      && origin.hash === ''
      && origin.pathname.toLowerCase() === `/${RELEASE_OWNER}/${RELEASE_REPO}.git`;
  } catch {
    return false;
  }
}

export const BANNED_COMMAND_FAMILIES = [
  ['npm', 'publish'],
  ['npm', 'version'],
  ['git', 'commit'],
  ['git', 'tag'],
  ['git', 'push'],
  ['git', 'reset'],
  ['git', 'clean'],
  ['git', 'checkout'],
  ['gh', 'release', 'create'],
];

function basename(command) {
  return path.basename(command).replace(/\.(cmd|exe)$/i, '');
}

export function assertReadOnlyCommand(command, args = []) {
  const candidate = [basename(command), ...args].map(String);
  const banned = BANNED_COMMAND_FAMILIES.find((family) => (
    family.every((part, index) => candidate[index] === part)
  ));

  if (banned) {
    throw new Error(`Blocked mutating command path: ${banned.join(' ')}`);
  }
}

export function createRunner({ cwd = REPO_ROOT, env = process.env, spawn = spawnSync } = {}) {
  return {
    run(command, args = [], options = {}) {
      assertReadOnlyCommand(command, args);
      const result = spawn(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: options.timeout ?? 30_000,
        maxBuffer: 1024 * 1024,
      });

      if (result.error) {
        throw result.error;
      }

      const status = result.status ?? 0;
      if (status !== 0 && !options.allowFailure) {
        throw new Error(`${command} ${args.join(' ')} failed with exit ${status}: ${(result.stderr || result.stdout || '').trim()}`);
      }

      return {
        status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
  };
}

export function resolveOnPath(name, env = process.env) {
  const pathValue = env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function readTrimmed(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseJsonValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.replace(/^"|"$/g, '');
  }
}

function commandError(result) {
  return (result.stderr || result.stdout || `exit ${result.status}`).trim();
}

function isNpmNotFound(result) {
  const text = `${result.stderr}\n${result.stdout}`;
  return result.status !== 0 && /E404|404 Not Found|not found/i.test(text);
}

async function readGithubReleaseState(fetcher, version) {
  const tagName = `v${version}`;
  const url = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/tags/${encodeURIComponent(tagName)}`;
  const response = await fetcher(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'xurgo-atlas-release-preflight',
    },
  });

  if (response.status === 404) {
    return { present: false, url, status: response.status };
  }

  if (response.ok) {
    return { present: true, url, status: response.status };
  }

  return {
    present: null,
    url,
    status: response.status,
    error: `GitHub release lookup returned HTTP ${response.status}`,
  };
}

export async function collectPreflightFacts({
  cwd = REPO_ROOT,
  env = process.env,
  runner = createRunner({ cwd, env }),
  fetcher = globalThis.fetch,
  nodeVersion = process.version,
  nodePath = process.execPath,
  npmPath = resolveOnPath('npm', env),
} = {}) {
  if (!fetcher) {
    throw new Error('No fetch implementation available for GitHub release lookup');
  }

  const packageJsonPath = path.join(REPO_ROOT, 'package.json');
  const packageJson = readJson(packageJsonPath);
  const packageName = packageJson.name;
  const packageVersion = packageJson.version;
  const nvmrcVersion = readTrimmed(path.join(REPO_ROOT, '.nvmrc'));
  const intendedTag = `v${packageVersion}`;
  const npmCommand = npmPath ?? 'npm';

  const repoRoot = runner.run('git', ['rev-parse', '--show-toplevel']).stdout.trim();
  const originRemote = runner.run('git', ['remote', 'get-url', 'origin']).stdout.trim();
  const worktreeStatus = runner.run('git', ['status', '--porcelain=v1']).stdout;
  const currentBranch = runner.run('git', ['branch', '--show-current']).stdout.trim();
  const localMain = runner.run('git', ['rev-parse', 'refs/heads/main']).stdout.trim();
  const originMain = runner.run('git', ['rev-parse', 'refs/remotes/origin/main']).stdout.trim();
  const remoteMainLine = runner.run('git', ['ls-remote', 'origin', 'refs/heads/main']).stdout.trim();
  const remoteMain = remoteMainLine.split(/\s+/)[0] ?? '';
  const localTag = runner.run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${intendedTag}`], { allowFailure: true });
  const remoteTag = runner.run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${intendedTag}`]).stdout.trim();
  const npmVersion = runner.run(npmCommand, ['--version']).stdout.trim();

  const npmPackageVersionResult = runner.run(
    npmCommand,
    ['view', `${packageName}@${packageVersion}`, 'version', '--json'],
    { allowFailure: true, timeout: 45_000 },
  );
  const npmLatestResult = runner.run(
    npmCommand,
    ['view', packageName, 'dist-tags.latest', '--json'],
    { allowFailure: true, timeout: 45_000 },
  );
  const githubRelease = await readGithubReleaseState(fetcher, packageVersion);

  return {
    expectedRoot: REPO_ROOT,
    expectedOrigin: EXPECTED_ORIGIN,
    expectedPackageName: EXPECTED_PACKAGE_NAME,
    repoRoot,
    originRemote,
    packageName,
    packageVersion,
    nvmrcVersion,
    expectedNodeVersion: `v${nvmrcVersion}`,
    nodeVersion,
    nodePath,
    npmVersion,
    npmPath: npmPath ?? '(not found on PATH)',
    worktreeStatus,
    worktreeClean: worktreeStatus.trim() === '',
    currentBranch,
    localMain,
    originMain,
    remoteMain,
    intendedTag,
    localTagPresent: localTag.status === 0,
    localTagActual: localTag.status === 0 ? localTag.stdout.trim() : 'absent',
    remoteTagPresent: remoteTag !== '',
    remoteTagActual: remoteTag || 'absent',
    npmPackageVersionPublished: npmPackageVersionResult.status === 0,
    npmPackageVersionActual: npmPackageVersionResult.status === 0
      ? parseJsonValue(npmPackageVersionResult.stdout)
      : (isNpmNotFound(npmPackageVersionResult) ? 'unpublished' : commandError(npmPackageVersionResult)),
    npmPackageVersionLookupOk: npmPackageVersionResult.status === 0 || isNpmNotFound(npmPackageVersionResult),
    npmLatestActual: npmLatestResult.status === 0
      ? parseJsonValue(npmLatestResult.stdout)
      : (isNpmNotFound(npmLatestResult) ? 'package unavailable' : commandError(npmLatestResult)),
    npmLatestLookupOk: npmLatestResult.status === 0 || isNpmNotFound(npmLatestResult),
    githubReleasePresent: githubRelease.present,
    githubReleaseActual: githubRelease.present === null
      ? githubRelease.error
      : (githubRelease.present ? `present (${githubRelease.url})` : 'absent'),
  };
}

function check(label, expected, actual, passed, remediation) {
  return { label, expected, actual, passed: Boolean(passed), remediation };
}

export function evaluatePreflight(stage, facts) {
  const checks = [
    check(
      'repository root identity',
      facts.expectedRoot,
      facts.repoRoot,
      facts.repoRoot === facts.expectedRoot,
      `Run from ${facts.expectedRoot}.`,
    ),
    check(
      'origin remote identity',
      facts.expectedOrigin,
      facts.originRemote,
      isExpectedOrigin(facts.originRemote),
      `Set origin to ${facts.expectedOrigin} in the confirmed checkout.`,
    ),
    check(
      'package-name identity',
      facts.expectedPackageName,
      facts.packageName,
      facts.packageName === facts.expectedPackageName,
      'Use the confirmed xurgo-atlas package checkout.',
    ),
    check(
      '.nvmrc internal runtime pin',
      '22.17.0',
      facts.nvmrcVersion,
      facts.nvmrcVersion === '22.17.0',
      'Restore .nvmrc to exactly 22.17.0.',
    ),
    check(
      'active Node version',
      facts.expectedNodeVersion,
      facts.nodeVersion,
      facts.nodeVersion === facts.expectedNodeVersion,
      `Run nvm use --silent ${facts.nvmrcVersion} before preflight.`,
    ),
    check(
      'resolved node path',
      'reported command path',
      facts.nodePath,
      Boolean(facts.nodePath),
      'Activate the pinned Node toolchain and retry.',
    ),
    check(
      'resolved npm version and path',
      'npm command available',
      `${facts.npmVersion} at ${facts.npmPath}`,
      Boolean(facts.npmVersion) && facts.npmPath !== '(not found on PATH)',
      'Activate the pinned Node toolchain so npm is on PATH.',
    ),
    check(
      'clean worktree',
      'no tracked or untracked changes',
      facts.worktreeClean ? 'clean' : facts.worktreeStatus.trim(),
      facts.worktreeClean,
      'Commit, stash, or remove local changes before release preflight.',
    ),
    check(
      'current branch',
      'reported current branch',
      facts.currentBranch || '(detached HEAD)',
      Boolean(facts.currentBranch),
      'Check out the intended release branch before preflight.',
    ),
    check(
      'local main matches origin/main',
      facts.localMain,
      facts.originMain,
      facts.localMain === facts.originMain,
      'Update local refs outside this preflight, then retry.',
    ),
    check(
      'origin/main matches direct remote main',
      facts.originMain,
      facts.remoteMain,
      facts.originMain === facts.remoteMain,
      'Resolve stale or divergent main refs outside this preflight.',
    ),
    check(
      'package version',
      'reported package version',
      facts.packageVersion,
      Boolean(facts.packageVersion),
      'Restore a valid package.json version.',
    ),
    check(
      'npm intended version lookup',
      'lookup succeeds or confirms unpublished',
      facts.npmPackageVersionActual,
      facts.npmPackageVersionLookupOk,
      'Retry when public npm registry lookup is available.',
    ),
    check(
      'npm latest dist-tag lookup',
      'lookup succeeds or confirms package unavailable',
      facts.npmLatestActual,
      facts.npmLatestLookupOk,
      'Retry when public npm registry lookup is available.',
    ),
    check(
      'local version tag state',
      'absent',
      facts.localTagActual,
      !facts.localTagPresent,
      `Remove or choose a version without local tag ${facts.intendedTag}.`,
    ),
    check(
      'remote version tag state',
      'absent',
      facts.remoteTagActual,
      !facts.remoteTagPresent,
      `Resolve remote tag ${facts.intendedTag} before this stage.`,
    ),
    check(
      'GitHub release state',
      'absent',
      facts.githubReleaseActual,
      facts.githubReleasePresent === false,
      `Resolve GitHub release ${facts.intendedTag} before this stage.`,
    ),
  ];

  if (stage === 'prepare') {
    checks.push(
      check(
        'prepare npm publication state',
        'intended version unpublished',
        facts.npmPackageVersionActual,
        facts.npmPackageVersionLookupOk && !facts.npmPackageVersionPublished,
        'Choose an unpublished package version before prepare.',
      ),
    );
  } else if (stage === 'finalize') {
    checks.push(
      check(
        'finalize npm publication state',
        'intended version published',
        facts.npmPackageVersionActual,
        facts.npmPackageVersionLookupOk && facts.npmPackageVersionPublished,
        'Complete the user-operated npm publication before finalize.',
      ),
      check(
        'finalize npm latest dist-tag',
        facts.packageVersion,
        facts.npmLatestActual,
        facts.npmLatestLookupOk && facts.npmLatestActual === facts.packageVersion,
        'Correct the public npm latest dist-tag outside this read-only preflight, then retry.',
      ),
    );
  } else {
    checks.push(
      check(
        'stage',
        'prepare or finalize',
        stage,
        false,
        'Pass --stage=prepare or --stage=finalize.',
      ),
    );
  }

  return {
    checks,
    passed: checks.every((item) => item.passed),
  };
}

export function formatReport(stage, facts, result) {
  const lines = [
    `Xurgo Atlas release preflight (${stage})`,
    '',
    `Repository: ${facts.repoRoot}`,
    `Branch: ${facts.currentBranch || '(detached HEAD)'}`,
    `Package: ${facts.packageName}@${facts.packageVersion}`,
    `Node: ${facts.nodeVersion} at ${facts.nodePath}`,
    `npm: ${facts.npmVersion} at ${facts.npmPath}`,
    `Tag: ${facts.intendedTag}`,
    '',
  ];

  for (const item of result.checks) {
    lines.push(`[${item.passed ? 'pass' : 'fail'}] ${item.label}`);
    lines.push(`  expected: ${item.expected}`);
    lines.push(`  actual:   ${item.actual}`);
    if (!item.passed) lines.push(`  remediate: ${item.remediation}`);
  }

  lines.push('');
  lines.push(result.passed ? 'Preflight passed.' : 'Preflight failed.');
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv) {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) {
    return { help: true, stage: null };
  }

  let stage = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--stage=')) {
      stage = arg.slice('--stage='.length);
    } else if (arg === '--stage') {
      stage = args[index + 1] ?? null;
      index += 1;
    } else {
      return { help: false, stage, error: `Unknown argument: ${arg}` };
    }
  }

  if (!stage) {
    return { help: false, stage, error: 'Missing required --stage argument.' };
  }

  return { help: false, stage };
}

export function usage() {
  return [
    'Usage:',
    '  npm run release:preflight -- --stage=prepare',
    '  npm run release:preflight -- --stage=finalize',
    '',
    'Stages:',
    '  prepare   Requires the package version to be unpublished and tag/release state absent.',
    '  finalize  Requires the package version to be published and tag/release state absent.',
    '',
    'The preflight is read-only: it validates repository, runtime, npm, tag, and GitHub release state without remediation.',
    '',
  ].join('\n');
}

export async function runCli(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    io.stdout.write(usage());
    return 0;
  }

  if (parsed.error) {
    io.stderr.write(`${parsed.error}\n\n${usage()}`);
    return 2;
  }

  const facts = await collectPreflightFacts();
  const result = evaluatePreflight(parsed.stage, facts);
  const report = formatReport(parsed.stage, facts, result);
  (result.passed ? io.stdout : io.stderr).write(report);
  return result.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().then((status) => {
    process.exitCode = status;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
