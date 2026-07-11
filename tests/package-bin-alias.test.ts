import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('package bin aliases', () => {
  it('exposes xurgo-atlas CLI alias on the package manifest and lockfile', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const packageLockJson = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));

    expect(packageJson.name).toBe('xurgo-atlas');
    expect(packageJson.description).toContain('Xurgo Atlas');
    expect(packageJson.keywords).toEqual(expect.arrayContaining(['xurgo-atlas', 'project-context']));
    expect(packageJson.bin).toEqual({
      'xurgo-atlas': './dist/index.js',
    });
    expect(packageLockJson.packages[''].name).toBe('xurgo-atlas');
    expect(packageLockJson.packages[''].bin).toEqual({
      'xurgo-atlas': 'dist/index.js',
    });
  });

  it('keeps every hooks:install asset in the package allowlist', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const hookAssets = [
      'scripts/install-git-hooks.mjs',
      'scripts/commit-message-contract.mjs',
      '.githooks/commit-msg',
    ];

    expect(packageJson.scripts['hooks:install']).toBe('node scripts/install-git-hooks.mjs');
    expect(packageJson.files).toEqual(expect.arrayContaining(hookAssets));
    await Promise.all(hookAssets.map(async (asset) => {
      await expect(fs.access(path.join(root, asset))).resolves.toBeUndefined();
    }));
  });
});
