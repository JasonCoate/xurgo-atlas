function splitPreserveLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hasTrailingNewline) {
    lines.pop();
  }
  return lines;
}

export interface NormalizedUnifiedDiff {
  normalizedPatch: string;
  changedFiles: string[];
}

const NO_NEWLINE_MARKER = '\\ No newline at end of file';

export function normalizeUnifiedDiffPatch(
  patchContent: string,
): NormalizedUnifiedDiff {
  const lines = patchContent.split('\n');
  const normalizedLines: string[] = [];
  const changedFiles: string[] = [];
  let index = 0;
  let sawHunk = false;

  while (index < lines.length) {
    while (index < lines.length && !lines[index].startsWith('--- ')) {
      index += 1;
    }

    if (index >= lines.length) {
      break;
    }

    const oldHeaderLine = index + 1;
    const oldHeader = lines[index];
    const newHeader = lines[index + 1];

    if (!newHeader?.startsWith('+++ ')) {
      throw new Error(
        `Corrupt unified diff: expected a +++ file header after line ${oldHeaderLine}.`,
      );
    }

    const oldPath = normalizeDiffHeaderPath(oldHeader.slice(4), oldHeaderLine);
    const newPath = normalizeDiffHeaderPath(newHeader.slice(4), oldHeaderLine + 1);
    const changedPath = resolveChangedPath(oldPath, newPath, oldHeaderLine);

    changedFiles.push(changedPath);
    normalizedLines.push(formatOldHeader(oldPath));
    normalizedLines.push(formatNewHeader(newPath));

    index += 2;

    let sawFileHunk = false;
    while (index < lines.length) {
      const line = lines[index];

      if (line.startsWith('@@ ')) {
        const parsedHunk = parseAndNormalizeHunk(lines, index, changedPath);
        normalizedLines.push(...parsedHunk.lines);
        index = parsedHunk.nextIndex;
        sawHunk = true;
        sawFileHunk = true;
        continue;
      }

      if (line.startsWith('--- ')) {
        break;
      }

      if (line.length === 0 && index === lines.length - 1) {
        index += 1;
        break;
      }

      if (line.length === 0) {
        index += 1;
        continue;
      }

      throw new Error(
        `Corrupt unified diff for "${changedPath}": expected an @@ hunk header after the file headers near line ${index + 1}.`,
      );
    }

    if (!sawFileHunk) {
      throw new Error(
        `Corrupt unified diff for "${changedPath}": missing @@ hunk body after the file headers.`,
      );
    }
  }

  if (!sawHunk) {
    throw new Error(
      'No unified diff patch found. Accepted formats: full git-style unified diffs from git diff, or complete unified diffs with ---/+++ file headers and at least one @@ hunk. Unsupported formats: prose-only text, OpenAI apply_patch envelopes, and truncated or corrupt hunks.',
    );
  }

  let normalizedPatch = normalizedLines.join('\n');
  if (!normalizedPatch.endsWith('\n')) {
    normalizedPatch += '\n';
  }

  return {
    normalizedPatch,
    changedFiles,
  };
}

export function createUnifiedDiffForNewFile(
  filePath: string,
  newContent: string,
): string {
  const newLines = splitPreserveLines(newContent);
  let diff = `--- /dev/null\n+++ b/${filePath}\n`;
  diff += `@@ -0,0 +1,${newLines.length} @@\n`;

  for (const line of newLines) {
    diff += `+${line}\n`;
  }

  return diff;
}

function parseAndNormalizeHunk(
  lines: string[],
  startIndex: number,
  changedPath: string,
): { lines: string[]; nextIndex: number } {
  const header = lines[startIndex];
  const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/);

  if (!match) {
    throw new Error(
      `Corrupt unified diff hunk for "${changedPath}" at line ${startIndex + 1}.`,
    );
  }

  const expectedOldLines = parseHunkCount(match[2]);
  const expectedNewLines = parseHunkCount(match[4]);
  const normalizedLines = [header];
  let seenOldLines = 0;
  let seenNewLines = 0;
  let sawBodyLine = false;
  let index = startIndex + 1;

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith('@@ ') || line.startsWith('--- ')) {
      break;
    }

    if (
      line.length === 0 &&
      (index === lines.length - 1 || (lines[index + 1] ?? '').startsWith('--- '))
    ) {
      break;
    }

    if (line === NO_NEWLINE_MARKER) {
      normalizedLines.push(line);
      index += 1;
      continue;
    }

    const prefix = line[0];
    if (prefix === ' ') {
      normalizedLines.push(line);
      seenOldLines += 1;
      seenNewLines += 1;
      sawBodyLine = true;
      index += 1;
      continue;
    }

    if (prefix === '-') {
      normalizedLines.push(line);
      seenOldLines += 1;
      sawBodyLine = true;
      index += 1;
      continue;
    }

    if (prefix === '+') {
      normalizedLines.push(line);
      seenNewLines += 1;
      sawBodyLine = true;
      index += 1;
      continue;
    }

    throw new Error(
      `Corrupt unified diff hunk for "${changedPath}" at line ${index + 1}: expected lines starting with " ", "+", "-", or "${NO_NEWLINE_MARKER}".`,
    );
  }

  if (!sawBodyLine) {
    throw new Error(
      `Corrupt unified diff hunk for "${changedPath}" at line ${startIndex + 1}: the hunk body is missing.`,
    );
  }

  if (seenOldLines !== expectedOldLines || seenNewLines !== expectedNewLines) {
    throw new Error(
      `Corrupt unified diff hunk for "${changedPath}" at line ${startIndex + 1}: header expects ${expectedOldLines} old line(s) and ${expectedNewLines} new line(s), but the hunk body contains ${seenOldLines} and ${seenNewLines}.`,
    );
  }

  return {
    lines: normalizedLines,
    nextIndex: index,
  };
}

function parseHunkCount(value: string | undefined): number {
  return value ? parseInt(value, 10) : 1;
}

function normalizeDiffHeaderPath(rawPath: string, lineNumber: number): string {
  const pathWithMetadataTrimmed = rawPath.split('\t', 1)[0]?.trim() ?? '';

  if (pathWithMetadataTrimmed.length === 0) {
    throw new Error(
      `Corrupt unified diff: missing file path in header at line ${lineNumber}.`,
    );
  }

  if (pathWithMetadataTrimmed === '/dev/null') {
    return pathWithMetadataTrimmed;
  }

  const normalizedPath =
    pathWithMetadataTrimmed.startsWith('a/') ||
    pathWithMetadataTrimmed.startsWith('b/')
      ? pathWithMetadataTrimmed.slice(2)
      : pathWithMetadataTrimmed;

  if (normalizedPath.length === 0) {
    throw new Error(
      `Corrupt unified diff: missing file path in header at line ${lineNumber}.`,
    );
  }

  if (isUnsafeDiffPath(normalizedPath)) {
    throw new Error(
      `Unsupported patch path "${pathWithMetadataTrimmed}" at line ${lineNumber}: absolute paths and parent traversal are not allowed.`,
    );
  }

  return normalizedPath;
}

function resolveChangedPath(
  oldPath: string,
  newPath: string,
  lineNumber: number,
): string {
  if (oldPath === '/dev/null' && newPath === '/dev/null') {
    throw new Error(
      `Corrupt unified diff: both file headers point at /dev/null near line ${lineNumber}.`,
    );
  }

  if (oldPath === '/dev/null') {
    return newPath;
  }

  if (newPath === '/dev/null') {
    return oldPath;
  }

  if (oldPath !== newPath) {
    throw new Error(
      `Rename-style unified diffs are not supported: old path "${oldPath}" and new path "${newPath}" must match.`,
    );
  }

  return oldPath;
}

function formatOldHeader(oldPath: string): string {
  return oldPath === '/dev/null' ? '--- /dev/null' : `--- a/${oldPath}`;
}

function formatNewHeader(newPath: string): string {
  return newPath === '/dev/null' ? '+++ /dev/null' : `+++ b/${newPath}`;
}

function isUnsafeDiffPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');

  if (normalized.startsWith('/')) {
    return true;
  }

  if (normalized.includes('//') || normalized.includes('/./')) {
    return true;
  }

  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '..') {
      return true;
    }
  }

  return false;
}

export function createUnifiedDiffForReplacement(
  filePath: string,
  oldContent: string,
  newContent: string,
): string {
  const oldLines = splitPreserveLines(oldContent);
  const newLines = splitPreserveLines(newContent);
  let diff = `--- a/${filePath}\n+++ b/${filePath}\n`;
  diff += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;

  for (const line of oldLines) {
    diff += `-${line}\n`;
  }

  for (const line of newLines) {
    diff += `+${line}\n`;
  }

  return diff;
}

/** Generate the only deletion shape accepted by guarded orphan removal. */
export function createUnifiedDiffForDeletion(filePath: string, oldContent: string): string {
  const oldLines = splitPreserveLines(oldContent);
  let diff = `--- a/${filePath}\n+++ /dev/null\n`;
  diff += `@@ -1,${oldLines.length} +0,0 @@\n`;
  for (const line of oldLines) diff += `-${line}\n`;
  return diff;
}

/** Keep guarded deletion verification bound to the same canonical diff generator. */
export function isExactUnifiedDiffForDeletion(filePath: string, oldContent: string, candidate: string): boolean {
  return candidate === createUnifiedDiffForDeletion(filePath, oldContent);
}
