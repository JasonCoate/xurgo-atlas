import { describe, expect, it } from 'vitest';
import {
  BANNED_COMMAND_FAMILIES,
  assertReadOnlyCommand,
  collectPreflightFacts,
  createRunner,
  evaluatePreflight,
  isExpectedOrigin,
  parseArgs,
} from '../scripts/release-preflight.mjs';

const baseFacts = {
  expectedRoot: '/repo/xurgo-atlas',
  expectedOrigin: 'https://github.com/xurgo/xurgo-atlas.git',
  expectedPackageName: 'xurgo-atlas',
  repoRoot: '/repo/xurgo-atlas',
  originRemote: 'https://github.com/xurgo/xurgo-atlas.git',
  packageName: 'xurgo-atlas',
  packageVersion: '0.3.0',
  nvmrcVersion: '22.17.0',
  expectedNodeVersion: 'v22.17.0',
  nodeVersion: 'v22.17.0',
  nodePath: '/Users/jasoncoate/.nvm/versions/node/v22.17.0/bin/node',
  npmVersion: '10.9.2',
  npmPath: '/Users/jasoncoate/.nvm/versions/node/v22.17.0/bin/npm',
  worktreeStatus: '',
  worktreeClean: true,
  currentBranch: 'chore/release-toolchain-contract',
  localMain: '500a77695416520d3a907016ef864b2c106d097a',
  originMain: '500a77695416520d3a907016ef864b2c106d097a',
  remoteMain: '500a77695416520d3a907016ef864b2c106d097a',
  intendedTag: 'v0.3.0',
  localTagPresent: false,
  localTagActual: 'absent',
  remoteTagPresent: false,
  remoteTagActual: 'absent',
  npmPackageVersionPublished: false,
  npmPackageVersionActual: 'unpublished',
  npmPackageVersionLookupOk: true,
  npmLatestActual: '0.2.0',
  npmLatestLookupOk: true,
  githubReleasePresent: false,
  githubReleaseActual: 'absent',
};

function evaluate(stage: 'prepare' | 'finalize', overrides = {}) {
  return evaluatePreflight(stage, { ...baseFacts, ...overrides });
}

function failedLabels(result: ReturnType<typeof evaluatePreflight>) {
  return result.checks.filter((check) => !check.passed).map((check) => check.label);
}

describe('release preflight argument parsing', () => {
  it('supports the authorized package script interface', () => {
    expect(parseArgs(['--stage=prepare'])).toEqual({ help: false, stage: 'prepare' });
    expect(parseArgs(['--stage', 'finalize'])).toEqual({ help: false, stage: 'finalize' });
    expect(parseArgs(['--help'])).toEqual({ help: true, stage: null });
  });
});

describe('release preflight fail-closed checks', () => {
  it('accepts only the expected GitHub HTTPS origin identity with case-insensitive owner/name', () => {
    expect(isExpectedOrigin('https://github.com/xurgo/xurgo-atlas.git')).toBe(true);
    expect(isExpectedOrigin('https://github.com/Xurgo/xurgo-atlas.git')).toBe(true);
    expect(isExpectedOrigin('https://github.com/other/xurgo-atlas.git')).toBe(false);
    expect(isExpectedOrigin('https://github.com/xurgo/other.git')).toBe(false);
    expect(isExpectedOrigin('https://git.example.com/xurgo/xurgo-atlas.git')).toBe(false);
    expect(isExpectedOrigin('not a URL')).toBe(false);
  });

  it('requires the exact .nvmrc runtime match', () => {
    const result = evaluate('prepare', { nodeVersion: 'v24.4.1' });

    expect(result.passed).toBe(false);
    expect(failedLabels(result)).toContain('active Node version');
  });

  it('fails closed on checkout, package, and remote identity mismatch', () => {
    const result = evaluate('prepare', {
      repoRoot: '/tmp/not-atlas',
      packageName: 'not-atlas',
      originRemote: 'https://github.com/example/not-atlas.git',
    });

    expect(result.passed).toBe(false);
    expect(failedLabels(result)).toEqual(expect.arrayContaining([
      'repository root identity',
      'origin remote identity',
      'package-name identity',
    ]));
  });

  it('fails on a dirty worktree', () => {
    const result = evaluate('prepare', {
      worktreeClean: false,
      worktreeStatus: ' M package.json\n',
    });

    expect(result.passed).toBe(false);
    expect(failedLabels(result)).toContain('clean worktree');
  });
});

describe('release preflight stage policy', () => {
  it('prepare accepts only unpublished package version with absent tag and release state', () => {
    expect(evaluate('prepare').passed).toBe(true);

    expect(evaluate('prepare', {
      npmPackageVersionPublished: true,
      npmPackageVersionActual: '0.3.0',
    }).passed).toBe(false);

    expect(evaluate('prepare', {
      localTagPresent: true,
      localTagActual: 'abc123',
    }).passed).toBe(false);

    expect(evaluate('prepare', {
      remoteTagPresent: true,
      remoteTagActual: 'abc123\trefs/tags/v0.3.0',
    }).passed).toBe(false);

    expect(evaluate('prepare', {
      githubReleasePresent: true,
      githubReleaseActual: 'present',
    }).passed).toBe(false);
  });

  it('finalize accepts only published package version with absent tag and release state', () => {
    expect(evaluate('finalize', {
      npmPackageVersionPublished: true,
      npmPackageVersionActual: '0.3.0',
      npmLatestActual: '0.3.0',
    }).passed).toBe(true);

    expect(evaluate('finalize').passed).toBe(false);

    expect(evaluate('finalize', {
      npmPackageVersionPublished: true,
      npmPackageVersionActual: '0.3.0',
      npmLatestActual: '0.2.0',
    }).passed).toBe(false);

    expect(evaluate('finalize', {
      npmPackageVersionPublished: true,
      npmPackageVersionActual: '0.3.0',
      npmLatestActual: '0.3.0',
      remoteTagPresent: true,
      remoteTagActual: 'abc123\trefs/tags/v0.3.0',
    }).passed).toBe(false);

    expect(evaluate('finalize', {
      npmPackageVersionPublished: true,
      npmPackageVersionActual: '0.3.0',
      npmLatestActual: '0.3.0',
      githubReleasePresent: true,
      githubReleaseActual: 'present',
    }).passed).toBe(false);
  });

  it('fails conflicting npm, tag, and release states with explicit labels', () => {
    const result = evaluate('finalize', {
      npmPackageVersionPublished: false,
      npmPackageVersionActual: 'unpublished',
      localTagPresent: true,
      localTagActual: 'abc123',
      githubReleasePresent: true,
      githubReleaseActual: 'present',
    });

    expect(result.passed).toBe(false);
    expect(failedLabels(result)).toEqual(expect.arrayContaining([
      'local version tag state',
      'GitHub release state',
      'finalize npm publication state',
    ]));
  });
});

describe('release preflight command safety', () => {
  it('blocks every banned mutating command family in the centralized runner', () => {
    for (const family of BANNED_COMMAND_FAMILIES) {
      expect(() => assertReadOnlyCommand(family[0], family.slice(1))).toThrow('Blocked mutating command path');
    }
  });

  it('uses direct remote inspection without fetch during fact collection', async () => {
    const commands: string[] = [];
    const responses = new Map([
      ['git rev-parse --show-toplevel', '/repo/xurgo-atlas\n'],
      ['git remote get-url origin', 'https://github.com/xurgo/xurgo-atlas.git\n'],
      ['git status --porcelain=v1', ''],
      ['git branch --show-current', 'chore/release-toolchain-contract\n'],
      ['git rev-parse refs/heads/main', '500a77695416520d3a907016ef864b2c106d097a\n'],
      ['git rev-parse refs/remotes/origin/main', '500a77695416520d3a907016ef864b2c106d097a\n'],
      ['git ls-remote origin refs/heads/main', '500a77695416520d3a907016ef864b2c106d097a\trefs/heads/main\n'],
      ['git ls-remote --tags origin refs/tags/v0.3.0', ''],
      ['npm --version', '10.9.2\n'],
      ['npm view xurgo-atlas@0.3.0 version --json', ''],
      ['npm view xurgo-atlas dist-tags.latest --json', '"0.2.0"\n'],
      ['git ls-remote --tags origin refs/tags/v0.5.0', ''],
]);

    const runner = {
      run(command: string, args: string[], options = {}) {
        const key = [command, ...args].join(' ');
        commands.push(key);
        if (key === 'git rev-parse --verify --quiet refs/tags/v0.3.0') {
          return { status: 1, stdout: '', stderr: '' };
        }
        if (key === 'npm view xurgo-atlas@0.3.0 version --json') {
          return { status: 1, stdout: '', stderr: 'npm ERR! code E404\n' };
        }
        const stdout = responses.get(key);
        if (stdout === undefined && !(options as { allowFailure?: boolean }).allowFailure) {
          throw new Error(`unexpected command ${key}`);
        }
        return { status: 0, stdout: stdout ?? '', stderr: '' };
      },
    };

    await collectPreflightFacts({
      runner,
      fetcher: async () => ({ status: 404, ok: false }),
      nodeVersion: 'v22.17.0',
      nodePath: '/Users/jasoncoate/.nvm/versions/node/v22.17.0/bin/node',
      npmPath: 'npm',
    });

    expect(commands).toContain('git ls-remote origin refs/heads/main');
    expect(commands).toContain('git ls-remote --tags origin refs/tags/v0.5.0');
    expect(commands.some((command) => command.startsWith('git fetch'))).toBe(false);
  });

  it('keeps runner execution argument-based and guarded', () => {
    const runner = createRunner({
      spawn(command, args) {
        expect(command).toBe('git');
        expect(args).toEqual(['status', '--porcelain=v1']);
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(runner.run('git', ['status', '--porcelain=v1']).stdout).toBe('');
  });
});
