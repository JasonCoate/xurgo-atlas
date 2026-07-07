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
  ArtifactRegistrationCommitAudit,
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
      | 'STALE_BASE'
      | 'INVALID_COMMIT_REQUEST'
      | 'AUDIT_INTEGRITY',
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

export interface ArtifactRegistrationCommitResult {
  proposalId: string;
  projectId: string;
  branch: string;
  manifestPath: 'docs/manifest.yml';
  changedFiles: ['docs/manifest.yml'];
  artifact: HarnessArtifactManifestEntry;
  priorManifestRevision: string;
  resultingManifestRevision: string | null;
  commit: string | null;
  actor: string;
  approvedAt: string | null;
  committedAt: string | null;
  idempotency:
    | 'applied_new'
    | 'already_committed'
    | 'already_applied_without_commit_record'
    | 'audit_reconciliation_required';
}

export async function commitArtifactRegistrationProposal(
  project: Project,
  options: {
    proposalId: string;
    approval: 'APPROVE_ARTIFACT_REGISTRATION_COMMIT';
    actor: string;
    projectId: string;
  },
): Promise<ArtifactRegistrationCommitResult> {
  const stored = project.eventLog.getArtifactRegistrationProposal(options.proposalId);
  if (!stored) {
    throw new ArtifactRegistrationProposalError(
      `Artifact-registration proposal "${options.proposalId}" not found`,
      'INVALID_COMMIT_REQUEST',
    );
  }

  const binding = validateStoredCommitBinding(project, stored, options.projectId);
  const existingAudit = project.eventLog.getArtifactRegistrationCommitAudit(stored.id);

  if (stored.status === 'committed') {
    if (!existingAudit || existingAudit.state !== 'finalized') {
      throw new ArtifactRegistrationProposalError(
        `Committed artifact-registration proposal "${stored.id}" is missing finalized audit metadata`,
        'AUDIT_INTEGRITY',
      );
    }
    assertAuditMatchesBinding(existingAudit, binding.fingerprint, stored);
    return formatCommitResult(stored, binding.entry, existingAudit, 'already_committed');
  }

  if (stored.status !== 'pending') {
    throw new ArtifactRegistrationProposalError(
      `Artifact-registration proposal "${stored.id}" has status "${stored.status}" and cannot be committed`,
      'INVALID_COMMIT_REQUEST',
    );
  }

  if (existingAudit) {
    return formatReconciliationRequired(stored, binding.entry, existingAudit);
  }

  const manifestState = await readArtifactManifestState(project, stored.branch);
  if (manifestState.revision !== stored.manifest_base_revision) {
    throw new ArtifactRegistrationProposalError(
      `Stale manifest base for "${ARTIFACT_MANIFEST_PATH}" on branch "${stored.branch}": expected ${stored.manifest_base_revision}, but current revision is ${manifestState.revision}. Re-read the manifest and create a new artifact-registration proposal.`,
      'STALE_BASE',
    );
  }

  const exactExistingEntry = manifestState.artifacts.find((entry) =>
    sameJson(entry, binding.entry),
  );
  if (exactExistingEntry) {
    return {
      proposalId: stored.id,
      projectId: stored.project_id,
      branch: stored.branch,
      manifestPath: ARTIFACT_MANIFEST_PATH,
      changedFiles: [ARTIFACT_MANIFEST_PATH],
      artifact: binding.entry,
      priorManifestRevision: stored.manifest_base_revision,
      resultingManifestRevision: manifestState.revision,
      commit: null,
      actor: options.actor,
      approvedAt: null,
      committedAt: null,
      idempotency: 'already_applied_without_commit_record',
    };
  }

  rejectArtifactConflict(manifestState.artifacts, binding.entry);

  const updatedManifest = buildManifestWithArtifactEntry(
    manifestState.content,
    manifestState.parsed,
    manifestState.artifacts,
    binding.entry,
  );
  const expectedPatch = createUnifiedDiffForReplacement(
    ARTIFACT_MANIFEST_PATH,
    manifestState.content,
    updatedManifest,
  );
  if (stored.patch !== expectedPatch || stored.payload.patch !== expectedPatch) {
    throw new ArtifactRegistrationProposalError(
      `Stored artifact-registration proposal "${stored.id}" patch does not match the exact reviewed artifacts[] append`,
      'INVALID_COMMIT_REQUEST',
    );
  }

  const approvedAt = new Date().toISOString();
  let preparedAudit: ArtifactRegistrationCommitAudit;
  try {
    preparedAudit = project.eventLog.prepareArtifactRegistrationCommitAudit({
      proposal_id: stored.id,
      binding_fingerprint: binding.fingerprint,
      approval: options.approval,
      actor: options.actor,
      approved_at: approvedAt,
      project_id: stored.project_id,
      canonical_project_root: binding.canonicalProjectRoot,
      branch: stored.branch,
      manifest_path: ARTIFACT_MANIFEST_PATH,
      prior_manifest_revision: stored.manifest_base_revision,
      changed_files: [ARTIFACT_MANIFEST_PATH],
      artifact_identity: buildArtifactIdentity(binding.entry),
    });
  } catch (error) {
    const audit = project.eventLog.getArtifactRegistrationCommitAudit(stored.id);
    if (audit) {
      return formatReconciliationRequired(stored, binding.entry, audit);
    }
    throw error;
  }

  let commitHash: string;
  try {
    const commit = await project.gitStore.applyPatchAndCommit(
      stored.branch,
      ARTIFACT_MANIFEST_PATH,
      stored.patch,
      `Register artifact ${binding.entry.id}`,
      stored.manifest_base_revision,
    );
    commitHash = commit.hash;
  } catch {
    return formatReconciliationRequired(stored, binding.entry, preparedAudit);
  }

  const resultingManifestRevision = await project.gitStore.getFileRevision(
    stored.branch,
    ARTIFACT_MANIFEST_PATH,
  );
  if (!resultingManifestRevision) {
    return formatReconciliationRequired(stored, binding.entry, preparedAudit);
  }

  try {
    const finalizedAudit = project.eventLog.finalizeArtifactRegistrationCommitAudit({
      proposalId: stored.id,
      bindingFingerprint: binding.fingerprint,
      commitSha: commitHash,
      resultingManifestRevision,
    });
    return formatCommitResult(stored, binding.entry, finalizedAudit, 'applied_new');
  } catch {
    return formatReconciliationRequired(stored, binding.entry, preparedAudit);
  }
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

function validateStoredCommitBinding(
  project: Project,
  stored: StoredArtifactRegistrationProposal,
  requestedProjectId: string,
): {
  entry: HarnessArtifactManifestEntry;
  fingerprint: string;
  canonicalProjectRoot: string;
} {
  const payload = stored.payload as ArtifactRegistrationProposalPayload;
  const entry = parseArtifactManifestEntries([stored.proposed_entry])[0];
  const canonicalProjectRoot = normalizeExistingPath(project.root) ?? path.resolve(project.root);

  assertCommitInvariant(stored.kind === 'artifact_registration', stored.id, 'stored kind must be artifact_registration');
  assertCommitInvariant(stored.schema_version === 1, stored.id, 'stored schema version must be 1');
  assertCommitInvariant(payload?.kind === 'artifact_registration', stored.id, 'payload kind must be artifact_registration');
  assertCommitInvariant(payload?.schemaVersion === 1, stored.id, 'payload schema version must be 1');
  assertCommitInvariant(payload?.proposalId === stored.id, stored.id, 'payload proposalId must match stored proposal id');
  assertCommitInvariant(requestedProjectId === stored.project_id, stored.id, 'request projectId must match stored proposal projectId');
  assertCommitInvariant(stored.project_id === project.projectId, stored.id, 'stored proposal projectId must match resolved projectId');
  assertCommitInvariant(payload.projectId === stored.project_id, stored.id, 'payload projectId must match stored proposal projectId');
  assertCommitInvariant(stored.branch === 'main', stored.id, 'artifact-registration proposals must target fixed branch "main"');
  assertCommitInvariant(payload.branch === stored.branch, stored.id, 'payload branch must match stored branch');
  assertCommitInvariant(stored.canonical_project_root === canonicalProjectRoot, stored.id, 'stored canonical root must match resolved project root');
  assertCommitInvariant(payload.canonicalProjectRoot === stored.canonical_project_root, stored.id, 'payload canonical root must match stored canonical root');
  assertCommitInvariant(stored.project_relative_path === entry.path, stored.id, 'stored project-relative path must match proposed entry path');
  assertCommitInvariant(payload.projectRelativePath === stored.project_relative_path, stored.id, 'payload project-relative path must match stored path');
  assertCommitInvariant(stored.manifest_path === ARTIFACT_MANIFEST_PATH, stored.id, 'manifest target must be docs/manifest.yml');
  assertCommitInvariant(payload.manifestPath === ARTIFACT_MANIFEST_PATH, stored.id, 'payload manifest target must be docs/manifest.yml');
  assertCommitInvariant(stored.manifest_base_revision === payload.manifestBaseRevision, stored.id, 'manifest base revision must match payload');
  assertCommitInvariant(sameStringArray(stored.changed_files, [ARTIFACT_MANIFEST_PATH]), stored.id, 'changed files must be exactly docs/manifest.yml');
  assertCommitInvariant(sameStringArray(payload.changedFiles, [ARTIFACT_MANIFEST_PATH]), stored.id, 'payload changed files must be exactly docs/manifest.yml');
  assertCommitInvariant(sameJson(payload.proposedArtifactEntry, stored.proposed_entry), stored.id, 'payload proposed entry must match stored proposed entry');
  assertCommitInvariant(payload.patch === stored.patch, stored.id, 'payload patch must match stored patch');
  assertCommitInvariant(sameStringArray(stored.prohibited_implications, ARTIFACT_REGISTRATION_PROHIBITED_IMPLICATIONS), stored.id, 'stored prohibited implications must match artifact-registration contract');
  assertCommitInvariant(sameStringArray(payload.prohibitedImplications, ARTIFACT_REGISTRATION_PROHIBITED_IMPLICATIONS), stored.id, 'payload prohibited implications must match artifact-registration contract');
  assertCommitInvariant(payload.status === 'pending', stored.id, 'payload status must remain pending review evidence');
  assertCommitInvariant(payload.approvalEstablished === false, stored.id, 'payload must not establish approval');
  assertCommitInvariant(payload.commitAuthorized === false, stored.id, 'payload must not authorize commit');
  assertCommitInvariant(payload.staleBase === false, stored.id, 'payload staleBase must be false');
  assertCommitInvariant(payload.preview?.status === 'review_only', stored.id, 'payload preview must be review_only');
  assertCommitInvariant(payload.preview?.diff === stored.patch, stored.id, 'payload preview diff must match stored patch');
  assertCommitInvariant(payload.preview?.manifestBaseRevision === stored.manifest_base_revision, stored.id, 'payload preview base revision must match stored base');
  assertCommitInvariant(payload.preview?.staleBase === false, stored.id, 'payload preview staleBase must be false');
  assertCommitInvariant(stored.approval_established === false, stored.id, 'stored proposal must not establish approval');
  assertCommitInvariant(stored.commit_authorized === false, stored.id, 'stored proposal must not authorize commit');
  assertCommitInvariant(stored.adapter_id === entry.adapterId, stored.id, 'stored adapter id must match proposed entry');
  assertCommitInvariant(stored.tool_native_root_id === entry.toolNativeRootId, stored.id, 'stored descriptor identity must match proposed entry');
  assertCommitInvariant(payload.descriptor?.adapterId === entry.adapterId, stored.id, 'payload descriptor adapter id must match proposed entry');
  assertCommitInvariant(payload.descriptor?.toolNativeRootId === entry.toolNativeRootId, stored.id, 'payload descriptor tool-native root id must match proposed entry');
  assertCommitInvariant(payload.descriptor?.projectRelativePath === entry.path, stored.id, 'payload descriptor path must match proposed entry');
  assertCommitInvariant(payload.descriptor?.artifactClass === entry.artifactClass, stored.id, 'payload descriptor artifact class must match proposed entry');
  assertCommitInvariant(payload.descriptor?.capabilityTier === entry.capabilityTier, stored.id, 'payload descriptor capability tier must match proposed entry');
  assertCommitInvariant(payload.descriptor?.discoveryStatus === 'present', stored.id, 'payload descriptor must bind a present descriptor');
  assertCommitInvariant(payload.descriptor?.present === true, stored.id, 'payload descriptor must be present');
  assertCommitInvariant(payload.descriptor?.source === 'harness_discovery_catalog', stored.id, 'payload descriptor source must remain catalog-bound');

  const fingerprint = crypto
    .createHash('sha256')
    .update(stableJson({
      proposalId: stored.id,
      projectId: stored.project_id,
      branch: stored.branch,
      canonicalProjectRoot,
      manifestPath: ARTIFACT_MANIFEST_PATH,
      manifestBaseRevision: stored.manifest_base_revision,
      changedFiles: stored.changed_files,
      entry,
      patch: stored.patch,
      prohibitedImplications: stored.prohibited_implications,
    }))
    .digest('hex');

  return {
    entry,
    fingerprint,
    canonicalProjectRoot,
  };
}

function assertCommitInvariant(
  condition: boolean,
  proposalId: string,
  detail: string,
): void {
  if (!condition) {
    throw new ArtifactRegistrationProposalError(
      `Invalid artifact-registration proposal "${proposalId}": ${detail}`,
      'INVALID_COMMIT_REQUEST',
    );
  }
}

function assertAuditMatchesBinding(
  audit: ArtifactRegistrationCommitAudit,
  fingerprint: string,
  stored: StoredArtifactRegistrationProposal,
): void {
  if (
    audit.binding_fingerprint !== fingerprint ||
    audit.project_id !== stored.project_id ||
    audit.branch !== stored.branch ||
    audit.manifest_path !== ARTIFACT_MANIFEST_PATH ||
    audit.prior_manifest_revision !== stored.manifest_base_revision ||
    !sameStringArray(audit.changed_files, [ARTIFACT_MANIFEST_PATH]) ||
    !audit.commit_sha ||
    !audit.resulting_manifest_revision ||
    !audit.committed_at
  ) {
    throw new ArtifactRegistrationProposalError(
      `Finalized audit metadata for artifact-registration proposal "${stored.id}" does not match the stored proposal binding`,
      'AUDIT_INTEGRITY',
    );
  }
}

function formatCommitResult(
  stored: StoredArtifactRegistrationProposal,
  entry: HarnessArtifactManifestEntry,
  audit: ArtifactRegistrationCommitAudit,
  idempotency: 'applied_new' | 'already_committed',
): ArtifactRegistrationCommitResult {
  return {
    proposalId: stored.id,
    projectId: stored.project_id,
    branch: stored.branch,
    manifestPath: ARTIFACT_MANIFEST_PATH,
    changedFiles: [ARTIFACT_MANIFEST_PATH],
    artifact: entry,
    priorManifestRevision: audit.prior_manifest_revision,
    resultingManifestRevision: audit.resulting_manifest_revision,
    commit: audit.commit_sha,
    actor: audit.actor,
    approvedAt: audit.approved_at,
    committedAt: audit.committed_at,
    idempotency,
  };
}

function formatReconciliationRequired(
  stored: StoredArtifactRegistrationProposal,
  entry: HarnessArtifactManifestEntry,
  audit: ArtifactRegistrationCommitAudit,
): ArtifactRegistrationCommitResult {
  return {
    proposalId: stored.id,
    projectId: stored.project_id,
    branch: stored.branch,
    manifestPath: ARTIFACT_MANIFEST_PATH,
    changedFiles: [ARTIFACT_MANIFEST_PATH],
    artifact: entry,
    priorManifestRevision: stored.manifest_base_revision,
    resultingManifestRevision: audit.resulting_manifest_revision,
    commit: audit.commit_sha,
    actor: audit.actor,
    approvedAt: audit.approved_at,
    committedAt: audit.committed_at,
    idempotency: 'audit_reconciliation_required',
  };
}

function buildArtifactIdentity(
  entry: HarnessArtifactManifestEntry,
): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    adapterId: entry.adapterId,
    toolNativeRootId: entry.toolNativeRootId,
    path: entry.path,
    role: entry.role,
    artifactClass: entry.artifactClass,
    capabilityTier: entry.capabilityTier,
  };
}

function sameStringArray(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
