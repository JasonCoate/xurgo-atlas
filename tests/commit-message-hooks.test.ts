import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import {
  formatCommitMessageError,
  validateCommitMessage,
} from '../scripts/commit-message-contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooksPath = path.join(repoRoot, '.githooks');

const validBodyMessage = `feat(commit-hooks): enforce local Conventional Commits

Explain the hook behavior because contributors need to know why the guardrail exists and how to keep commits compliant.

Validation:
- npm test
- npm run build`;

const validBreakingMessage = `feat(commit-hooks)!: tighten the hook contract

Explain the incompatible hook behavior because the commit workflow needs a clearer delivery contract.

Validation:
- npm test

BREAKING CHANGE: The local hook now requires a body and Validation section for delivery commits.`;

const validPassthroughMessages = [
  'Merge branch "main" into chore/branch',
  'Revert "feat: add hook"',
  'fixup! feat: add hook',
];

describe('commit message contract', () => {
  it('accepts conventional commit messages with validation evidence', () => {
    expect(validateCommitMessage(validBodyMessage)).toEqual({ valid: true });
    expect(validateCommitMessage(validBreakingMessage)).toEqual({ valid: true });
    expect(validateCommitMessage('docs: refresh current-state surface accuracy')).toEqual({ valid: true });
    expect(validateCommitMessage(`fix(core): tighten validation

Explain the validation change because the previous rule was too permissive for delivery commits.

Validation:
- npm test`)).toEqual({ valid: true });
  });

  it('allows merge, revert, and autosquash messages through unchanged', () => {
    for (const message of validPassthroughMessages) {
      expect(validateCommitMessage(message)).toEqual({ valid: true });
    }
  });

  it('rejects malformed headers, unsupported types, missing bodies, and missing validation sections', () => {
    expect(formatCommitMessageError('fix project lifecycle dependent witnesses'))
      .toContain('Use Conventional Commits: type(scope)!: subject.');
    expect(formatCommitMessageError('wip: work in progress'))
      .toContain('Unsupported commit type "wip"');
    expect(formatCommitMessageError('feat(CONTRACTS): add local hooks'))
      .toContain('Scope "CONTRACTS" must use lowercase');
    expect(formatCommitMessageError('feat(commit-hooks): enforce local Conventional Commits.'))
      .toContain('Subject should not end with a period.');
    expect(formatCommitMessageError('feat(commit-hooks): enforce local Conventional Commits'))
      .toContain('must include a body');
    expect(formatCommitMessageError(`feat(commit-hooks): enforce local Conventional Commits

Explain the hook behavior because contributors need to know why the guardrail exists and how to keep commits compliant.`))
      .toContain('Validation: section');
    expect(formatCommitMessageError(`feat(commit-hooks): enforce local Conventional Commits

Validation:
- npm test`))
      .toContain('needs a short body');
    expect(formatCommitMessageError(`feat(commit-hooks)!: tighten the hook contract

Explain the incompatible hook behavior because the commit workflow needs a clearer delivery contract.

Validation:
- npm test`))
      .toContain('BREAKING CHANGE: footer');
    expect(formatCommitMessageError(validBreakingMessage))
      .toBeNull();
  });
});

describe('git hook integration', () => {
  async function createHookRepo() {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xurgo-atlas-commit-hook-'));
    const git = simpleGit({ baseDir: root });
    await git.init();

    await fs.promises.writeFile(path.join(root, 'README.md'), '# hook fixture\n', 'utf8');
    await git.add('README.md');
    await git.commit('chore: initial commit');

    execFileSync('git', ['config', 'core.hooksPath', hooksPath], {
      cwd: root,
      stdio: 'pipe',
    });

    return { root, git };
  }

  it('blocks invalid commit messages before the commit is created', async () => {
    const { root, git } = await createHookRepo();

    await fs.promises.writeFile(path.join(root, 'README.md'), '# hook fixture\n\nchange\n', 'utf8');
    await git.add('README.md');

    await expect(git.commit('feat(commit-hooks): enforce local Conventional Commits')).rejects.toThrow(
      'Commit message rejected by Atlas commit-message hook',
    );
  });

  it('permits valid delivery commits with body, validation evidence, and breaking-change footers', async () => {
    const { root, git } = await createHookRepo();

    await fs.promises.writeFile(path.join(root, 'README.md'), '# hook fixture\n\nchange\n', 'utf8');
    await git.add('README.md');
    await expect(git.commit(validBodyMessage)).resolves.toBeTruthy();

    await fs.promises.writeFile(path.join(root, 'README.md'), '# hook fixture\n\nanother change\n', 'utf8');
    await git.add('README.md');
    await expect(git.commit(validBreakingMessage)).resolves.toBeTruthy();
  });
});
