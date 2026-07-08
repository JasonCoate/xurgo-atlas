#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooksPath = path.join(repoRoot, '.githooks');

function runGit(args) {
  execFileSync('git', args, {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

async function main() {
  const hooksDir = await fs.stat(hooksPath).catch(() => null);
  if (!hooksDir?.isDirectory()) {
    console.error(`Atlas git hooks directory not found: ${hooksPath}`);
    process.exit(1);
  }

  runGit(['rev-parse', '--is-inside-work-tree']);
  runGit(['config', '--local', 'core.hooksPath', '.githooks']);

  console.log(`Configured local git hooks for this checkout: ${path.relative(repoRoot, hooksPath)}`);
}

await main();
