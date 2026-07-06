import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { Project } from './project.js';
import * as harnessDiscovery from './harness-discovery.js';
import type {
  ArtifactCapabilityTier,
  ArtifactClass,
  HarnessDiscoveryDescriptor,
  ToolNativeRootIdentity,
} from './harness-discovery.js';
import { normalizeExistingPath } from './git-identity.js';
import { createUnifiedDiffForReplacement } from './unified-diff.js';
import type {
  ArtifactRegistrationProposalPayload,
  StoredArtifactRegistrationProposal,
} from './events.js';

export const ARTIFACT_MANIFEST_PATH = 'docs/manifest.yml';

export type HarnessArtifactManifestEntry = {
  id: string;
  kind: 'harness';
  adapterId: string;
  toolNativeRootId: ToolNativeRootIdentity;
  path: string;
  role: 'harness';
  artifactClass: ArtifactClass;
  capabilityTier: ArtifactCapabilityTier;
};

export const ARTIFACT_REGISTRATION_PROHIBITED_IMPLICATIONS = [
  'approval',
  'manifest write',
  'artifact activation',
  'artifact execution',
  'artifact import',
  'artifact installation',
  'artifact trust',
  'artifact content inspection',
  'adapter activation',
  'derived-index refresh',
  'commit authority',
  'generic manifest-write authority',
];

export class ArtifactRegistrationProposalError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNKNOWN_DESCRIPTOR'
      | 'AMBIGUOUS_DESCRIPTOR'
      | 'ABSENT_DESCRIPTOR'
      | 'UNSAFE_DESCRIPTOR'
      | 'MANIFEST_INVALID'
      | 'ARTIFACT_CONFLICT'
      | 'STALE_BASE',
  ) {
    super(message);
    this.name = 'ArtifactRegistrationProposalError';
  }
}

interface ManifestState {
  content: string;
  revision: string;
  parsed: Record<string, unknown>;
  artifacts: HarnessArtifactManifestEntry[];
}

export async function createArtifactRegistrationProposal(
  project: Project,
  options: {
    adapterId: string;
    branch?: string;
  },
): Promise<ArtifactRegistrationProposalPayload> {
  const branch = options.branch ?? 'main';
  const descriptor = await resolvePresentHarnessDescriptor(
    project.root,
    options.adapterId,
  );
  const binding = await bindDescriptorToProjectRoot(project.root, descriptor);
  const manifestState = await readArtifactManifestState(project, branch);
  const proposedArtifactEntry = buildHarnessArtifactEntry(descriptor);

  rejectArtifactConflict(manifestState.artifacts, proposedArtifactEntry);

  const updatedManifest = buildManifestWithArtifactEntry(
    manifestState.content,
    manifestState.parsed,
    manifestState.artifacts,
    proposedArtifactEntry,
  );
  const patch = createUnifiedDiffForReplacement(
    ARTIFACT_MANIFEST_PATH,
    manifestState.content,
    updatedManifest,
  );
  const changedFiles = [ARTIFACT_MANIFEST_PATH];
  const currentRevision = await project.gitStore.getFileRevision(
    branch,
    ARTIFACT_MANIFEST_PATH,
  );

  if (currentRevision !== manifestState.revision) {
    throw new ArtifactRegistrationProposalError(
      `Stale manifest base for "${ARTIFACT_MANIFEST_PATH}" on branch "${branch}": expected ${manifestState.revision}, but current revision is ${currentRevision ?? 'missing'}. Re-read the manifest and create a new artifact-registration proposal.`,
      'STALE_BASE',
    );
  }

  const stored = project.eventLog.storeArtifactRegistrationProposal({
    project_id: project.projectId,
    branch,
    adapter_id: descriptor.adapterId,
    tool_native_root_id: descriptor.toolNativeRootId,
    canonical_project_root: binding.canonicalProjectRoot,
    project_relative_path: binding.projectRelativePath,
    manifest_path: ARTIFACT_MANIFEST_PATH,
    manifest_base_revision: manifestState.revision,
    proposed_entry: proposedArtifactEntry,
    changed_files: changedFiles,
    patch,
    prohibited_implications: ARTIFACT_REGISTRATION_PROHIBITED_IMPLICATIONS,
    payload: {
      kind: 'artifact_registration',
      schemaVersion: 1,
      projectId: project.projectId,
      branch,
      descriptor: {
        adapterId: descriptor.adapterId,
        discoveryStatus: 'present',
        present: true,
        projectRelativePath: descriptor.projectRelativePath,
        toolNativeRootId: descriptor.toolNativeRootId,
        artifactClass: descriptor.artifactClass,
        capabilityTier: descriptor.capabilityTier,
        source: 'harness_discovery_catalog',
      },
      canonicalProjectRoot: binding.canonicalProjectRoot,
      projectRelativePath: binding.projectRelativePath,
      manifestPath: ARTIFACT_MANIFEST_PATH,
      manifestBaseRevision: manifestState.revision,
      proposedArtifactEntry,
      changedFiles,
      patch,
      status: 'pending',
      staleBase: false,
      approvalEstablished: false,
      commitAuthorized: false,
      prohibitedImplications: ARTIFACT_REGISTRATION_PROHIBITED_IMPLICATIONS,
      preview: {
        status: 'review_only',
        diff: patch,
        manifestBaseRevision: manifestState.revision,
        staleBase: false,
      },
      nextStep:
        'Review this proposal and its manifest diff. Proposal generation is not approval, not a manifest write, not artifact activation, and not commit authority; any later guarded commit must independently revalidate the bound manifest base revision.',
    },
  });

  return stored.payload;
}

export function isStoredArtifactRegistrationProposal(
  proposal: StoredArtifactRegistrationProposal,
): boolean {
  return proposal.kind === 'artifact_registration' && proposal.schema_version === 1;
}

export function buildHarnessArtifactEntry(
  descriptor: HarnessDiscoveryDescriptor,
): HarnessArtifactManifestEntry {
  return {
    id: buildHarnessArtifactId(descriptor),
    kind: 'harness',
    adapterId: descriptor.adapterId,
    toolNativeRootId: descriptor.toolNativeRootId,
    path: descriptor.projectRelativePath,
    role: 'harness',
    artifactClass: descriptor.artifactClass,
    capabilityTier: descriptor.capabilityTier,
  };
}

export function buildHarnessArtifactId(
  descriptor: Pick<
    HarnessDiscoveryDescriptor,
    | 'adapterId'
    | 'toolNativeRootId'
    | 'projectRelativePath'
    | 'artifactClass'
    | 'capabilityTier'
  >,
): string {
  const identity = [
    descriptor.adapterId,
    descriptor.toolNativeRootId,
    descriptor.projectRelativePath,
    descriptor.artifactClass,
    descriptor.capabilityTier,
  ].join('\0');
  return `harness_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

export function parseArtifactManifestEntries(
  rawArtifacts: unknown,
): HarnessArtifactManifestEntry[] {
  if (rawArtifacts === undefined) {
    return [];
  }

  if (!Array.isArray(rawArtifacts)) {
    throw new ArtifactRegistrationProposalError(
      `${ARTIFACT_MANIFEST_PATH} artifacts must be an array when present`,
      'MANIFEST_INVALID',
    );
  }

  const entries = rawArtifacts.map(parseArtifactManifestEntry);
  const identities = new Set<string>();
  const ids = new Set<string>();

  for (const entry of entries) {
    const identity = artifactIdentityKey(entry);
    if (ids.has(entry.id) || identities.has(identity)) {
      throw new ArtifactRegistrationProposalError(
        `${ARTIFACT_MANIFEST_PATH} contains duplicate artifacts[] identity "${identity}"`,
        'MANIFEST_INVALID',
      );
    }
    ids.add(entry.id);
    identities.add(identity);
  }

  return entries;
}

async function resolvePresentHarnessDescriptor(
  projectRoot: string,
  adapterId: string,
): Promise<HarnessDiscoveryDescriptor> {
  const snapshot = await harnessDiscovery.snapshotHarnessDiscovery(
    projectRoot,
    harnessDiscovery.buildSafeDirectoryPresenceChecker({
      async assertProjectRootDirectory(resolvedRoot) {
        let stat: fs.Stats;
        try {
          stat = await fs.promises.lstat(resolvedRoot);
        } catch {
          throw harnessDiscovery.createInvalidProjectRootError(resolvedRoot);
        }
        if (!stat.isDirectory()) {
          throw harnessDiscovery.createInvalidProjectRootError(resolvedRoot);
        }
      },
      async pathExists(absolutePath) {
        try {
          await fs.promises.lstat(absolutePath);
          return true;
        } catch {
          return false;
        }
      },
    }),
  );
  const matches = snapshot.descriptors.filter(
    (descriptor) => descriptor.adapterId === adapterId,
  );

  if (matches.length === 0) {
    throw new ArtifactRegistrationProposalError(
      `Unknown harness descriptor adapterId "${adapterId}"`,
      'UNKNOWN_DESCRIPTOR',
    );
  }

  if (matches.length > 1) {
    throw new ArtifactRegistrationProposalError(
      `Ambiguous harness descriptor adapterId "${adapterId}"`,
      'AMBIGUOUS_DESCRIPTOR',
    );
  }

  const descriptor = matches[0];
  if (!descriptor.present || descriptor.discoveryStatus !== 'present') {
    throw new ArtifactRegistrationProposalError(
      `Harness descriptor adapterId "${adapterId}" is absent and cannot be proposed for registration`,
      'ABSENT_DESCRIPTOR',
    );
  }

  return descriptor;
}

async function bindDescriptorToProjectRoot(
  projectRoot: string,
  descriptor: HarnessDiscoveryDescriptor,
): Promise<{
  canonicalProjectRoot: string;
  projectRelativePath: string;
}> {
  assertSafeProjectRelativePath(descriptor.projectRelativePath);
  const canonicalProjectRoot = normalizeExistingPath(projectRoot) ?? path.resolve(projectRoot);
  const absoluteDescriptorPath = path.resolve(
    canonicalProjectRoot,
    descriptor.projectRelativePath,
  );
  const relative = path.relative(canonicalProjectRoot, absoluteDescriptorPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ArtifactRegistrationProposalError(
      `Harness descriptor path "${descriptor.projectRelativePath}" escapes the project root`,
      'UNSAFE_DESCRIPTOR',
    );
  }

  let realDescriptorPath: string;
  try {
    realDescriptorPath = await fs.promises.realpath(absoluteDescriptorPath);
  } catch {
    throw new ArtifactRegistrationProposalError(
      `Harness descriptor path "${descriptor.projectRelativePath}" is unavailable`,
      'ABSENT_DESCRIPTOR',
    );
  }

  const realRelative = path.relative(canonicalProjectRoot, realDescriptorPath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new ArtifactRegistrationProposalError(
      `Harness descriptor path "${descriptor.projectRelativePath}" resolves outside the project root`,
      'UNSAFE_DESCRIPTOR',
    );
  }

  return {
    canonicalProjectRoot,
    projectRelativePath: descriptor.projectRelativePath,
  };
}

async function readArtifactManifestState(
  project: Project,
  branch: string,
): Promise<ManifestState> {
  const { content, revision } = await project.readFile(branch, ARTIFACT_MANIFEST_PATH);

  if (content === null) {
    throw new ArtifactRegistrationProposalError(
      `${ARTIFACT_MANIFEST_PATH} not found on branch "${branch}"`,
      'MANIFEST_INVALID',
    );
  }

  if (!revision) {
    throw new ArtifactRegistrationProposalError(
      `Could not determine current revision for ${ARTIFACT_MANIFEST_PATH} on branch "${branch}"`,
      'MANIFEST_INVALID',
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(content) as Record<string, unknown>;
  } catch (error) {
    throw new ArtifactRegistrationProposalError(
      `Invalid YAML in ${ARTIFACT_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      'MANIFEST_INVALID',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArtifactRegistrationProposalError(
      `${ARTIFACT_MANIFEST_PATH} must contain a top-level mapping`,
      'MANIFEST_INVALID',
    );
  }

  if (!Array.isArray(parsed.documents)) {
    throw new ArtifactRegistrationProposalError(
      `${ARTIFACT_MANIFEST_PATH} is missing a valid documents[] array`,
      'MANIFEST_INVALID',
    );
  }

  return {
    content,
    revision,
    parsed,
    artifacts: parseArtifactManifestEntries(parsed.artifacts),
  };
}

function buildManifestWithArtifactEntry(
  originalContent: string,
  parsed: Record<string, unknown>,
  artifacts: HarnessArtifactManifestEntry[],
  proposedArtifactEntry: HarnessArtifactManifestEntry,
): string {
  const updated = {
    ...parsed,
    artifacts: [
      ...artifacts,
      proposedArtifactEntry,
    ],
  };
  const headerComment = extractLeadingYamlComment(originalContent);
  const serialized = YAML.stringify(updated).trimEnd() + '\n';
  return headerComment ? `${headerComment}${serialized}` : serialized;
}

function parseArtifactManifestEntry(rawEntry: unknown): HarnessArtifactManifestEntry {
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    throw new ArtifactRegistrationProposalError(
      `${ARTIFACT_MANIFEST_PATH} artifacts[] entries must be mappings`,
      'MANIFEST_INVALID',
    );
  }

  const entry = rawEntry as Record<string, unknown>;
  const allowedKeys = new Set([
    'id',
    'kind',
    'adapterId',
    'toolNativeRootId',
    'path',
    'role',
    'artifactClass',
    'capabilityTier',
  ]);
  const unexpectedKey = Object.keys(entry).find((key) => !allowedKeys.has(key));
  if (unexpectedKey) {
    throw new ArtifactRegistrationProposalError(
      `${ARTIFACT_MANIFEST_PATH} artifacts[] entry contains unsupported field "${unexpectedKey}"`,
      'MANIFEST_INVALID',
    );
  }

  const parsed = {
    id: requireString(entry.id, 'id'),
    kind: requireLiteral(entry.kind, 'kind', 'harness'),
    adapterId: requireString(entry.adapterId, 'adapterId'),
    toolNativeRootId: requireToolNativeRootId(entry.toolNativeRootId),
    path: requireString(entry.path, 'path'),
    role: requireLiteral(entry.role, 'role', 'harness'),
    artifactClass: requireArtifactClass(entry.artifactClass),
    capabilityTier: requireArtifactCapabilityTier(entry.capabilityTier),
  };

  assertSafeProjectRelativePath(parsed.path);
  const expectedId = buildHarnessArtifactId({
    adapterId: parsed.adapterId,
    toolNativeRootId: parsed.toolNativeRootId,
    projectRelativePath: parsed.path,
    artifactClass: parsed.artifactClass,
    capabilityTier: parsed.capabilityTier,
  });
  if (parsed.id !== expectedId) {
    throw new ArtifactRegistrationProposalError(
      `${ARTIFACT_MANIFEST_PATH} artifacts[] entry id does not match its descriptor identity`,
      'MANIFEST_INVALID',
    );
  }

  return parsed;
}

function rejectArtifactConflict(
  existingArtifacts: HarnessArtifactManifestEntry[],
  proposedArtifactEntry: HarnessArtifactManifestEntry,
): void {
  const proposedIdentity = artifactIdentityKey(proposedArtifactEntry);
  const conflict = existingArtifacts.find(
    (entry) =>
      entry.id === proposedArtifactEntry.id ||
      artifactIdentityKey(entry) === proposedIdentity ||
      entry.adapterId === proposedArtifactEntry.adapterId,
  );

  if (conflict) {
    throw new ArtifactRegistrationProposalError(
      `${ARTIFACT_MANIFEST_PATH} already contains an artifacts[] entry that conflicts with adapterId "${proposedArtifactEntry.adapterId}"`,
      'ARTIFACT_CONFLICT',
    );
  }
}

function artifactIdentityKey(entry: HarnessArtifactManifestEntry): string {
  return [
    entry.kind,
    entry.adapterId,
    entry.toolNativeRootId,
    entry.path,
    entry.role,
    entry.artifactClass,
    entry.capabilityTier,
  ].join('\0');
}

function assertSafeProjectRelativePath(projectRelativePath: string): void {
  if (
    projectRelativePath.length === 0 ||
    path.isAbsolute(projectRelativePath) ||
    projectRelativePath.split(/[\\/]+/).includes('..')
  ) {
    throw new ArtifactRegistrationProposalError(
      `Unsafe artifact path "${projectRelativePath}"`,
      'UNSAFE_DESCRIPTOR',
    );
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ArtifactRegistrationProposalError(
      `${ARTIFACT_MANIFEST_PATH} artifacts[] entry requires non-empty ${field}`,
      'MANIFEST_INVALID',
    );
  }
  return value;
}

function requireLiteral<T extends string>(
  value: unknown,
  field: string,
  expected: T,
): T {
  if (value !== expected) {
    throw new ArtifactRegistrationProposalError(
      `${ARTIFACT_MANIFEST_PATH} artifacts[] entry requires ${field}: "${expected}"`,
      'MANIFEST_INVALID',
    );
  }
  return expected;
}

function requireToolNativeRootId(value: unknown): ToolNativeRootIdentity {
  const parsed = requireString(value, 'toolNativeRootId');
  const valid: ToolNativeRootIdentity[] = [
    'agents_md_interoperability',
    'claude_code_root',
    'cursor_root',
    'gemini_cli_root',
    'windsurf_root',
    'kiro_root',
    'cline_root',
    'roo_code_root',
    'opencode_root',
    'kilo_code_root',
  ];
  if (valid.includes(parsed as ToolNativeRootIdentity)) {
    return parsed as ToolNativeRootIdentity;
  }
  throw new ArtifactRegistrationProposalError(
    `${ARTIFACT_MANIFEST_PATH} artifacts[] entry has unsupported toolNativeRootId "${parsed}"`,
    'MANIFEST_INVALID',
  );
}

function requireArtifactClass(value: unknown): ArtifactClass {
  const parsed = requireString(value, 'artifactClass');
  const valid: ArtifactClass[] = [
    'instruction_only',
    'declarative_configuration',
    'executable_package',
    'tool_native_root_namespace',
  ];
  if (valid.includes(parsed as ArtifactClass)) {
    return parsed as ArtifactClass;
  }
  throw new ArtifactRegistrationProposalError(
    `${ARTIFACT_MANIFEST_PATH} artifacts[] entry has unsupported artifactClass "${parsed}"`,
    'MANIFEST_INVALID',
  );
}

function requireArtifactCapabilityTier(value: unknown): ArtifactCapabilityTier {
  const parsed = requireString(value, 'capabilityTier');
  const valid: ArtifactCapabilityTier[] = [
    'discover_only',
    'register_and_index',
    'validate',
    'proposal_export',
    'first_class_supported',
    'deferred_or_unsafe',
  ];
  if (valid.includes(parsed as ArtifactCapabilityTier)) {
    return parsed as ArtifactCapabilityTier;
  }
  throw new ArtifactRegistrationProposalError(
    `${ARTIFACT_MANIFEST_PATH} artifacts[] entry has unsupported capabilityTier "${parsed}"`,
    'MANIFEST_INVALID',
  );
}

function extractLeadingYamlComment(content: string): string {
  const match = content.match(/^((?:#.*\n)+)/);
  return match?.[1] ?? '';
}
