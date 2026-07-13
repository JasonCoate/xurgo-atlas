import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { Project } from './project.js';
import { normalizeExistingPath, inspectGitIdentity } from './git-identity.js';
import type { TreeEntry, TreeFileEntry } from './git-store.js';
import { createUnifiedDiffForDeletion, isExactUnifiedDiffForDeletion } from './unified-diff.js';
import type { OrphanRemovalCommitAudit, OrphanRemovalObservationClassification, OrphanRemovalStatus, StoredOrphanRemovalProposal } from './events.js';

export const ORPHAN_REMOVAL_APPROVAL = 'APPROVE_ORPHAN_REMOVAL' as const;
const TEXTUAL_REFERENCE_POLICY = 'branch-tree-utf8-text-v1';
const MAX_TEXTUAL_BLOB_BYTES = 4 * 1024 * 1024;

type TextClassification = 'safely_textual' | 'binary' | 'unsupported';

interface ReferenceEvidence {
  policyVersion: typeof TEXTUAL_REFERENCE_POLICY;
  complete: true;
  enumeratedPaths: string[];
  entries: Array<Pick<TreeEntry, 'path' | 'mode' | 'type' | 'revision'>>;
  inspectedTextualPaths: string[];
  excluded: Array<{ path: string; classification: Exclude<TextClassification, 'safely_textual'> }>;
  references: string[];
}

interface RemovalEvidence {
  manifest: { valid: true; registered: false; revision: string; canonicalPaths: string[] };
  source: { canonicalRoot: string; samePathAbsent: true };
  references: ReferenceEvidence;
  target: { mode: string; regular: true; revision: string };
}

export class OrphanRemovalError extends Error {
  constructor(message: string, readonly code: OrphanRemovalStatus) { super(message); this.name = 'OrphanRemovalError'; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * This is intentionally shared by target and manifest evidence: malformed
 * manifest strings are rejected rather than normalized into registrations that
 * could conceal an alias for the removal target.
 */
function normalizeManagedDocumentPath(input: string): string {
  if (!input || input.includes('\\') || path.posix.isAbsolute(input) || input.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new OrphanRemovalError('Managed document path is not canonical', 'evidence_unavailable');
  }
  const regularDocument = /^docs\/(?:atlas|spec)\/(?:[^/]+\/)*[^/]+\.md$/.test(input);
  const fixedManagedDocument = new Set([
    'STATUS.md', 'AGENTS.md', '.docs-policy.yml', 'docs/manifest.yml', 'docs/README.md', 'docs/implementation-checklist.md',
  ]).has(input);
  if (!regularDocument && !fixedManagedDocument) {
    throw new OrphanRemovalError('Managed document path is outside approved roots or has an invalid extension', 'evidence_unavailable');
  }
  return input;
}

function normalizeTarget(input: string): string {
  const normalized = normalizeManagedDocumentPath(input);
  if (!/^docs\/(?:atlas|spec)\/.+\.md$/.test(normalized)) {
    throw new OrphanRemovalError('Target must be a Markdown file under docs/atlas/** or docs/spec/**', 'rejected');
  }
  if (/(^|\/)(README|INDEX|AGENTS|STATUS|CONTRIBUTING)\.md$/i.test(normalized)) {
    throw new OrphanRemovalError('Governance and reserved documents cannot be orphan-removed', 'rejected');
  }
  return normalized;
}

async function manifest(project: Project) {
  const { content, revision } = await project.readFile('main', 'docs/manifest.yml');
  if (!content || !revision) throw new OrphanRemovalError('Manifest evidence is unavailable', 'evidence_unavailable');
  let parsed: unknown;
  try { parsed = YAML.parse(content); } catch { throw new OrphanRemovalError('Manifest is invalid', 'evidence_unavailable'); }
  if (!isRecord(parsed) || !Array.isArray(parsed.documents)) {
    throw new OrphanRemovalError('Manifest documents[] evidence is invalid', 'evidence_unavailable');
  }

  const rawPaths = new Set<string>();
  const canonicalPaths = new Set<string>();
  for (const entry of parsed.documents) {
    if (!isRecord(entry) || typeof entry.path !== 'string') {
      throw new OrphanRemovalError('Manifest contains incomplete document metadata', 'evidence_unavailable');
    }
    const canonical = normalizeManagedDocumentPath(entry.path);
    if (entry.path !== canonical || rawPaths.has(entry.path) || canonicalPaths.has(canonical)) {
      throw new OrphanRemovalError('Manifest contains ambiguous or noncanonical document paths', 'evidence_unavailable');
    }
    rawPaths.add(entry.path);
    canonicalPaths.add(canonical);
  }
  return { revision, canonicalPaths: [...canonicalPaths].sort() };
}

function classifyText(blob: Buffer): { classification: TextClassification; content?: string } {
  if (blob.byteLength > MAX_TEXTUAL_BLOB_BYTES) return { classification: 'unsupported' };
  if (blob.some((byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) {
    return { classification: 'binary' };
  }
  try {
    return { classification: 'safely_textual', content: new TextDecoder('utf-8', { fatal: true }).decode(blob) };
  } catch {
    return { classification: 'binary' };
  }
}

async function collectReferenceEvidence(project: Project, target: string): Promise<{ evidence: ReferenceEvidence; targetContent: string }> {
  const entries = await project.gitStore.observeTreeEntries('main');
  if (!entries) throw new OrphanRemovalError('Complete managed reference scan is unavailable', 'evidence_unavailable');

  const inspectedTextualPaths: string[] = [];
  const excluded: ReferenceEvidence['excluded'] = [];
  const references: string[] = [];
  let targetContent: string | undefined;
  for (const entry of entries) {
    // A tree that contains a symlink, submodule, or unexpected mode cannot make
    // a complete textual evidence claim, so this boundary intentionally fails closed.
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      throw new OrphanRemovalError('Complete managed reference scan has a non-regular or ambiguous entry', 'evidence_unavailable');
    }
    const blob = await project.gitStore.readBlob(entry.revision);
    if (blob === null) throw new OrphanRemovalError('Complete managed reference scan cannot read a branch blob', 'evidence_unavailable');
    const classified = classifyText(blob);
    if (classified.classification !== 'safely_textual') {
      excluded.push({ path: entry.path, classification: classified.classification });
      continue;
    }
    inspectedTextualPaths.push(entry.path);
    if (entry.path === target) {
      targetContent = classified.content;
    } else if (classified.content!.includes(target)) {
      references.push(entry.path);
    }
  }
  if (excluded.length) {
    const details = excluded.map(({ path: excludedPath, classification }) => `${excludedPath} (${classification})`).join(', ');
    throw new OrphanRemovalError(`Complete managed reference scan excludes unsearchable branch blobs: ${details}`, 'evidence_unavailable');
  }
  if (targetContent === undefined) throw new OrphanRemovalError('Target content is not safely textual', 'evidence_unavailable');
  const evidence: ReferenceEvidence = {
    policyVersion: TEXTUAL_REFERENCE_POLICY,
    complete: true,
    enumeratedPaths: entries.map((entry) => entry.path),
    entries: entries.map(({ path: entryPath, mode, type, revision }) => ({ path: entryPath, mode, type, revision })),
    inspectedTextualPaths,
    excluded,
    references,
  };
  return { evidence, targetContent };
}

async function evidence(project: Project, target: string, baseRevision: string) {
  const canonicalRoot = normalizeExistingPath(project.root);
  const identity = await inspectGitIdentity(project.root);
  if (!canonicalRoot || !identity.insideWorkTree || identity.worktreeRoot !== canonicalRoot) {
    throw new OrphanRemovalError('Canonical source worktree identity is unavailable', 'evidence_unavailable');
  }
  const sourcePath = path.resolve(canonicalRoot, target);
  if (!sourcePath.startsWith(`${canonicalRoot}${path.sep}`)) throw new OrphanRemovalError('Target escapes canonical source root', 'rejected');
  try {
    await fs.promises.lstat(sourcePath);
    throw new OrphanRemovalError('Source contains the same path and requires reconciliation', 'source_reconciliation_required');
  } catch (error) {
    if (error instanceof OrphanRemovalError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new OrphanRemovalError('Source same-path absence cannot be established', 'evidence_unavailable');
  }
  const head = await project.gitStore.getBranchHead('main');
  const entry = await project.gitStore.getTreeFileEntry('main', target);
  if (!head || !entry) throw new OrphanRemovalError('Managed target evidence is unavailable', 'evidence_unavailable');
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new OrphanRemovalError('Target is not a regular managed file', 'rejected');
  if (entry.revision !== baseRevision) throw new OrphanRemovalError('Target base revision does not match', 'stale');

  const manifestState = await manifest(project);
  if (manifestState.canonicalPaths.includes(target)) throw new OrphanRemovalError('Target is registered by the manifest', 'not_orphan');
  const references = await collectReferenceEvidence(project, target);
  if (references.evidence.references.length) {
    throw new OrphanRemovalError(`Managed references prevent removal: ${references.evidence.references.join(', ')}`, 'reference_conflict');
  }
  const immutableEvidence: RemovalEvidence = {
    manifest: { valid: true, registered: false, revision: manifestState.revision, canonicalPaths: manifestState.canonicalPaths },
    source: { canonicalRoot, samePathAbsent: true },
    references: references.evidence,
    target: { mode: entry.mode, regular: true, revision: entry.revision },
  };
  return { canonicalRoot, head, entry, manifestRevision: manifestState.revision, content: references.targetContent, evidence: immutableEvidence };
}

function hasStoredEvidence(value: unknown): value is RemovalEvidence {
  if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.source) || !isRecord(value.references) || !isRecord(value.target)) return false;
  const references = value.references;
  return value.manifest.valid === true && value.manifest.registered === false && typeof value.manifest.revision === 'string' &&
    Array.isArray(value.manifest.canonicalPaths) && value.source.samePathAbsent === true && typeof value.source.canonicalRoot === 'string' &&
    references.policyVersion === TEXTUAL_REFERENCE_POLICY && references.complete === true && Array.isArray(references.enumeratedPaths) &&
    Array.isArray(references.entries) && Array.isArray(references.inspectedTextualPaths) && Array.isArray(references.excluded) && Array.isArray(references.references) &&
    value.target.regular === true && typeof value.target.mode === 'string' && typeof value.target.revision === 'string';
}

function sameEvidence(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function proposeOrphanRemoval(project: Project, input: { path: string; baseRevision: string; reason: string }) {
  const target = normalizeTarget(input.path);
  if (!input.reason.trim()) throw new OrphanRemovalError('A removal reason is required', 'rejected');
  const found = await evidence(project, target, input.baseRevision);
  const diff = createUnifiedDiffForDeletion(target, found.content);
  const reviewDigest = crypto.createHash('sha256').update(JSON.stringify({ target, head: found.head, base: input.baseRevision, manifest: found.manifestRevision, root: found.canonicalRoot, evidence: found.evidence, diff, reason: input.reason })).digest('hex');
  return project.eventLog.storeOrphanRemovalProposal({ project_id: project.projectId, branch: 'main', target_path: target, target_mode: found.entry.mode, branch_head: found.head, base_revision: input.baseRevision, manifest_revision: found.manifestRevision, canonical_project_root: found.canonicalRoot, evidence: found.evidence as unknown as Record<string, unknown>, diff, reason: input.reason, review_digest: reviewDigest, status: 'pending_review' });
}

export function previewOrphanRemoval(project: Project, proposalId: string) {
  const proposal = project.eventLog.getOrphanRemovalProposal(proposalId);
  if (!proposal || proposal.project_id !== project.projectId) throw new OrphanRemovalError('Orphan-removal proposal was not found', 'rejected');
  return proposal.payload;
}

export async function commitOrphanRemoval(project: Project, input: { proposalId: string; approval: typeof ORPHAN_REMOVAL_APPROVAL; reviewDigest: string; actor: string }) {
  const proposal = project.eventLog.getOrphanRemovalProposal(input.proposalId);
  if (!proposal || proposal.project_id !== project.projectId) throw new OrphanRemovalError('Orphan-removal proposal was not found', 'rejected');
  if (proposal.status !== 'pending_review') throw new OrphanRemovalError(`Proposal is ${proposal.status}`, proposal.status);
  if (input.approval !== ORPHAN_REMOVAL_APPROVAL || input.reviewDigest !== proposal.review_digest) throw new OrphanRemovalError('Approval must bind the exact proposal review digest', 'rejected');
  if (!input.actor.trim()) throw new OrphanRemovalError('An asserted actor label is required', 'rejected');
  if (project.eventLog.getOrphanRemovalCommitAudit(proposal.id)) throw new OrphanRemovalError('Proposal approval has already been used', 'audit_reconciliation_required');
  if (!hasStoredEvidence(proposal.evidence)) throw new OrphanRemovalError('Stored orphan-removal evidence is unavailable', 'evidence_unavailable');
  try {
    const checked = await evidence(project, proposal.target_path, proposal.base_revision);
    if (checked.head !== proposal.branch_head || checked.manifestRevision !== proposal.manifest_revision || checked.canonicalRoot !== proposal.canonical_project_root || checked.entry.mode !== proposal.target_mode || !sameEvidence(checked.evidence, proposal.evidence)) {
      throw new OrphanRemovalError('Reviewed orphan evidence is stale', 'stale');
    }
  } catch (error) {
    const code = error instanceof OrphanRemovalError ? error.code : 'evidence_unavailable';
    project.eventLog.updateOrphanRemovalStatus(proposal.id, code);
    throw error;
  }
  const fingerprint = crypto.createHash('sha256').update(proposal.diff).digest('hex');
  project.eventLog.prepareOrphanRemovalCommitAudit({ proposal_id: proposal.id, approval_digest: proposal.review_digest, actor: input.actor, canonical_project_root: proposal.canonical_project_root, target_path: proposal.target_path, target_mode: proposal.target_mode, manifest_revision: proposal.manifest_revision, branch_head: proposal.branch_head, deletion_fingerprint: fingerprint });
  const deletion = await project.gitStore.commitOneFileDeletionLocal('main', proposal.target_path, proposal.branch_head, proposal.base_revision, `Remove orphaned document ${proposal.target_path}`);
  if (deletion.state === 'not_applied') {
    project.eventLog.updateOrphanRemovalStatus(proposal.id, 'git_failed');
    return { status: 'git_failed' as const, proposalId: proposal.id, error: deletion.error };
  }
  if (deletion.state === 'reconciliation_required') {
    if (deletion.commit) {
      try {
        project.eventLog.recordOrphanRemovalGeneratedCommit(proposal.id, deletion.commit.hash);
      } catch {
        project.eventLog.updateOrphanRemovalStatus(proposal.id, 'audit_reconciliation_required');
        return { status: 'audit_reconciliation_required' as const, proposalId: proposal.id, commit: deletion.commit.hash };
      }
    }
    project.eventLog.updateOrphanRemovalStatus(proposal.id, 'audit_reconciliation_required');
    return { status: 'audit_reconciliation_required' as const, proposalId: proposal.id, ...(deletion.commit ? { commit: deletion.commit.hash } : {}), observation: deletion.observation };
  }
  const commit = deletion.commit.hash;
  try {
    project.eventLog.recordOrphanRemovalGeneratedCommit(proposal.id, commit);
  } catch {
    project.eventLog.updateOrphanRemovalStatus(proposal.id, 'audit_reconciliation_required');
    return { status: 'audit_reconciliation_required' as const, proposalId: proposal.id, commit };
  }
  try {
    project.eventLog.finalizeOrphanRemovalCommitAudit(proposal.id, commit);
    return { status: 'committed' as const, proposalId: proposal.id, commit, actor: input.actor, actorSemantics: 'asserted_label' };
  } catch {
    project.eventLog.updateOrphanRemovalStatus(proposal.id, 'audit_reconciliation_required');
    return { status: 'audit_reconciliation_required' as const, proposalId: proposal.id, commit };
  }
}

function auditMatchesProposal(audit: OrphanRemovalCommitAudit, proposal: StoredOrphanRemovalProposal): boolean {
  return typeof audit.commit_sha === 'string' && audit.approval_digest === proposal.review_digest &&
    audit.canonical_project_root === proposal.canonical_project_root && audit.target_path === proposal.target_path && audit.target_mode === proposal.target_mode &&
    audit.manifest_revision === proposal.manifest_revision && audit.branch_head === proposal.branch_head &&
    audit.deletion_fingerprint === crypto.createHash('sha256').update(proposal.diff).digest('hex');
}

async function matchingCommit(project: Project, proposal: StoredOrphanRemovalProposal, audit: OrphanRemovalCommitAudit, head: string): Promise<boolean | null> {
  if (!auditMatchesProposal(audit, proposal) || audit.commit_sha !== head || !['committed', 'audit_reconciliation_required'].includes(proposal.status)) return false;
  const evidence = proposal.evidence as unknown as RemovalEvidence;
  const parent = await project.gitStore.observeSingleCommitParent(head);
  if (parent === null) return null;
  if (parent !== proposal.branch_head) return false;
  const changes = await project.gitStore.observeCommitFileChanges(head);
  if (changes === null) return null;
  const parentEntry = await project.gitStore.observeTreeFileEntry(parent, proposal.target_path);
  const resultingEntry = await project.gitStore.observeTreeFileEntry(head, proposal.target_path);
  if (parentEntry === null || resultingEntry === null) return null;
  if (parentEntry === undefined) return false;
  const parentBlob = await project.gitStore.readBlob(parentEntry.revision);
  if (parentBlob === null) return null;
  const parentText = classifyText(parentBlob);
  if (parentText.classification !== 'safely_textual') return null;
  const exactDeletion = changes.length === 1 && changes[0].path === proposal.target_path && changes[0].status === 'D' &&
    changes[0].oldMode === proposal.target_mode && changes[0].newMode === '000000' && changes[0].oldRevision === proposal.base_revision && /^0+$/.test(changes[0].newRevision);
  return exactDeletion && isExactUnifiedDiffForDeletion(proposal.target_path, parentText.content!, proposal.diff) &&
    parentEntry.type === 'blob' && parentEntry.mode === evidence.target.mode && parentEntry.revision === evidence.target.revision && resultingEntry === undefined;
}

export async function orphanRemovalStatus(project: Project, proposalId: string) {
  const proposal = previewOrphanRemoval(project, proposalId);
  const stored = project.eventLog.getOrphanRemovalProposal(proposalId)!;
  const audit = project.eventLog.getOrphanRemovalCommitAudit(proposalId);
  let classification: OrphanRemovalObservationClassification = 'unavailable';
  let branchHead: string | null = null;
  let targetPresent: boolean | null = null;
  try {
    if (!hasStoredEvidence(stored.evidence)) throw new Error('malformed stored evidence');
    const evidence = stored.evidence;
    if (stored.branch !== 'main' || stored.target_mode !== evidence.target.mode || stored.base_revision !== evidence.target.revision || stored.manifest_revision !== evidence.manifest.revision || stored.canonical_project_root !== evidence.source.canonicalRoot) {
      classification = 'diverged';
    } else {
      branchHead = await project.gitStore.getBranchHead('main');
      if (!branchHead) throw new Error('branch head unavailable');
      const target = await project.gitStore.observeTreeFileEntry(branchHead, stored.target_path);
      if (target === null) throw new Error('target observation unavailable');
      targetPresent = target !== undefined;
      const exactReviewedTarget = target !== undefined && target.type === 'blob' && target.mode === evidence.target.mode && target.revision === evidence.target.revision;
      if (branchHead === stored.branch_head && exactReviewedTarget && audit === null) {
        classification = 'not_applied';
      } else if (audit === null) {
        classification = 'diverged';
      } else {
        const match = await matchingCommit(project, stored, audit, branchHead);
        classification = match === null ? 'unavailable' : match ? 'matching_commit' : 'diverged';
      }
    }
  } catch {
    classification = 'unavailable';
  }
  // This path is observational by contract: no retry, audit repair, proposal
  // update, evidence refresh, or repository mutation is permitted here.
  return { ...proposal, status: stored.status, audit, observation: { classification, branchHead, targetPresent, readOnly: true, retriesPerformed: false } };
}
