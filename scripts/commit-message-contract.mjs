#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_TYPES = new Set([
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
]);

const PASSTHROUGH_PREFIXES = ['Merge ', 'Revert ', 'fixup! ', 'squash! '];

const COMMIT_MESSAGE_PATTERN = /^(?<type>[a-z][a-z0-9-]*)(?:\((?<scope>[^()\r\n]+)\))?(?<breaking>!)?: (?<subject>.+)$/;
const VALIDATION_LABEL = 'Validation:';
const BREAKING_CHANGE_LABEL = 'BREAKING CHANGE:';
const SUBJECT_MAX_LENGTH = 72;
const DELIVERY_TYPES_REQUIRING_BODY = new Set([
  'build',
  'ci',
  'feat',
  'fix',
  'perf',
  'refactor',
]);

function splitMessageSections(message) {
  return message.split(/\n{2,}/).map((section) => section.trim()).filter(Boolean);
}

function isFooterSection(section) {
  const firstLine = section.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.startsWith(VALIDATION_LABEL) || firstLine.startsWith(BREAKING_CHANGE_LABEL);
}

function extractFooterPayload(section, label) {
  const lines = section.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  if (!firstLine.startsWith(label)) {
    return null;
  }

  const inlineValue = firstLine.slice(label.length).trim();
  const rest = lines.slice(1).map((line) => line.trim()).filter(Boolean);
  const payload = [inlineValue, ...rest].filter(Boolean);

  return payload.length > 0 ? payload.join(' ') : null;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function validateCommitMessage(message) {
  const normalized = message.replace(/\r\n/g, '\n').trim();

  if (!normalized) {
    return {
      valid: false,
      reason: 'Commit message is empty.',
    };
  }

  if (PASSTHROUGH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return { valid: true };
  }

  const sections = splitMessageSections(normalized);
  const firstLine = sections[0];
  const match = firstLine.match(COMMIT_MESSAGE_PATTERN);
  if (!match?.groups) {
    return {
      valid: false,
      reason:
        'Use Conventional Commits: type(scope)!: subject. ' +
        'Examples: feat(mcp): add commit hook, fix(core): tighten validation, chore: update tooling.',
    };
  }

  const type = match.groups.type;
  if (!ALLOWED_TYPES.has(type)) {
    return {
      valid: false,
      reason:
        `Unsupported commit type "${type}". ` +
        `Allowed types: ${Array.from(ALLOWED_TYPES).join(', ')}.`,
    };
  }

  const scope = match.groups.scope;
  if (scope && !/^[a-z0-9][a-z0-9./-]*$/.test(scope)) {
    return {
      valid: false,
      reason:
        `Scope "${scope}" must use lowercase path-like characters without spaces. ` +
        'Use kebab-case or a comparable lowercase token.',
    };
  }

  const subject = match.groups.subject.trim();
  if (subject.length > SUBJECT_MAX_LENGTH) {
    return {
      valid: false,
      reason:
        `Subject is too long (${subject.length} characters). ` +
        `Keep it at ${SUBJECT_MAX_LENGTH} characters or fewer, or add a body.`,
    };
  }

  if (!/^[a-z0-9]/.test(subject)) {
    return {
      valid: false,
      reason:
        'Subject should start with a lowercase letter or digit and read like a summary.',
    };
  }

  if (subject.endsWith('.')) {
    return {
      valid: false,
      reason: 'Subject should not end with a period.',
    };
  }

  const hasBreakingBang = Boolean(match.groups.breaking);
  const bodySections = sections.slice(1);
  const validationSection = bodySections.find((section) => section.startsWith(VALIDATION_LABEL));
  const breakingSection = bodySections.find((section) => section.startsWith(BREAKING_CHANGE_LABEL));
  const explanationSections = bodySections.filter((section) => !isFooterSection(section));
  const explanationText = explanationSections.join('\n\n').trim();
  const hasBody = explanationText.length > 0;

  if (validationSection && !hasBody) {
    return {
      valid: false,
      reason:
        'A Validation: section needs a short body that explains the change before listing validation commands.',
    };
  }

  if (DELIVERY_TYPES_REQUIRING_BODY.has(type) && !hasBody) {
    return {
      valid: false,
      reason:
        `Delivery commits of type "${type}" must include a body that explains what changed and why, ` +
        'followed by a Validation: section.',
    };
  }

  if (hasBody) {
    if (!validationSection) {
      return {
        valid: false,
        reason:
          'Delivery commits with a body must include a Validation: section listing the validation commands run.',
      };
    }

    if (countWords(explanationText) < 8 || !/(because|so that|to )/i.test(explanationText)) {
      return {
        valid: false,
        reason:
          'The body should explain what changed and why in plain language before the Validation: section.',
      };
    }
  }

  if (hasBreakingBang || breakingSection) {
    if (!hasBody) {
      return {
        valid: false,
        reason:
          'Breaking changes must include a body that explains the impact and a BREAKING CHANGE: footer.',
      };
    }

    if (!hasBreakingBang || !breakingSection) {
      return {
        valid: false,
        reason:
          'Use both the ! marker in the header and a BREAKING CHANGE: footer when declaring a breaking change.',
      };
    }

    if (!extractFooterPayload(breakingSection, BREAKING_CHANGE_LABEL)) {
      return {
        valid: false,
        reason:
          'The BREAKING CHANGE: footer must describe the incompatible change and its impact.',
      };
    }
  }

  return { valid: true };
}

export function formatCommitMessageError(message) {
  const result = validateCommitMessage(message);
  if (result.valid) {
    return null;
  }

  return `Commit message rejected by Atlas commit-message hook: ${result.reason}`;
}

export async function readCommitMessageFile(commitMessagePath) {
  return await fs.readFile(commitMessagePath, 'utf8');
}

export async function runCommitMessageHook(commitMessagePath) {
  const message = await readCommitMessageFile(commitMessagePath);
  const error = formatCommitMessageError(message);
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return false;
  }

  return true;
}

async function main() {
  const commitMessagePath = process.argv[2];
  if (!commitMessagePath) {
    const scriptName = path.basename(fileURLToPath(import.meta.url));
    console.error(`Usage: node ${scriptName} <commit-message-file>`);
    process.exit(1);
  }

  const ok = await runCommitMessageHook(commitMessagePath);
  if (!ok) {
    process.exit(1);
  }
}

const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsScript) {
  await main();
}
