import { DatabaseSync } from 'node:sqlite';
import * as crypto from 'node:crypto';

export interface DocEvent {
  id?: string;
  project_id: string;
  branch: string;
  path: string;
  actor?: string;
  tool_name: string;
  intent?: string;
  summary?: string;
  base_revision?: string;
  result_revision?: string;
  risk_level?: string;
  diff?: string;
  created_at?: string;
  metadata?: DocEventMetadata;
}

export interface StoredProposal {
  id: string;
  project_id: string;
  branch: string;
  path: string;
  base_revision: string;
  patch: string;
  intent: string;
  summary: string;
  risk_level: string;
  requires_approval: boolean;
  status: 'pending' | 'committed' | 'rejected' | 'stale' | 'discarded';
  created_at: string;
  committed_at: string | null;
  discarded_at: string | null;
  metadata: ProposalMetadata | null;
}

export interface ArtifactRegistrationDescriptorProvenance {
  adapterId: string;
  discoveryStatus: 'present';
  present: true;
  projectRelativePath: string;
  toolNativeRootId: string;
  artifactClass: string;
  capabilityTier: string;
  source: 'harness_discovery_catalog';
}

export interface ArtifactRegistrationProposalPayload {
  proposalId: string;
  kind: 'artifact_registration';
  schemaVersion: 1;
  projectId: string;
  branch: string;
  descriptor: ArtifactRegistrationDescriptorProvenance;
  canonicalProjectRoot: string;
  projectRelativePath: string;
  manifestPath: 'docs/manifest.yml';
  manifestBaseRevision: string;
  proposedArtifactEntry: Record<string, unknown>;
  changedFiles: string[];
  patch: string;
  status: 'pending';
  staleBase: false;
  approvalEstablished: false;
  commitAuthorized: false;
  prohibitedImplications: string[];
  preview: {
    status: 'review_only';
    diff: string;
    manifestBaseRevision: string;
    staleBase: false;
  };
  nextStep: string;
  createdAt: string;
}

export interface StoredArtifactRegistrationProposal {
  id: string;
  project_id: string;
  branch: string;
  kind: 'artifact_registration';
  schema_version: 1;
  adapter_id: string;
  tool_native_root_id: string;
  canonical_project_root: string;
  project_relative_path: string;
  manifest_path: 'docs/manifest.yml';
  manifest_base_revision: string;
  proposed_entry: Record<string, unknown>;
  changed_files: string[];
  patch: string;
  status: 'pending' | 'committed' | 'rejected' | 'stale' | 'discarded';
  approval_established: false;
  commit_authorized: false;
  prohibited_implications: string[];
  created_at: string;
  payload: ArtifactRegistrationProposalPayload;
}

export interface ArtifactRegistrationCommitAudit {
  proposal_id: string;
  state: 'prepared' | 'finalized';
  binding_fingerprint: string;
  approval: 'APPROVE_ARTIFACT_REGISTRATION_COMMIT';
  actor: string;
  approved_at: string;
  project_id: string;
  canonical_project_root: string;
  branch: string;
  manifest_path: 'docs/manifest.yml';
  prior_manifest_revision: string;
  changed_files: string[];
  artifact_identity: Record<string, unknown>;
  committed_at: string | null;
  commit_sha: string | null;
  resulting_manifest_revision: string | null;
  idempotency_state:
    | 'prepared'
    | 'applied_new'
    | 'audit_reconciliation_required';
}

export type OrphanRemovalStatus = 'pending_review' | 'committed' | 'stale' | 'rejected' | 'git_failed' | 'audit_reconciliation_required' | 'not_orphan' | 'reference_conflict' | 'source_reconciliation_required' | 'evidence_unavailable';
/** Read-only Git observation; unlike proposal status, this never authorizes recovery or mutation. */
export type OrphanRemovalObservationClassification = 'not_applied' | 'matching_commit' | 'diverged' | 'unavailable';
export interface OrphanRemovalProposalPayload {
  proposalId: string; kind: 'orphan_removal'; schemaVersion: 1; projectId: string;
  branch: 'main'; targetPath: string; targetMode: string; branchHead: string;
  baseRevision: string; manifestRevision: string; canonicalProjectRoot: string;
  evidence: Record<string, unknown>; diff: string; reason: string; reviewDigest: string;
  status: OrphanRemovalStatus; createdAt: string; updatedAt: string;
}
export interface StoredOrphanRemovalProposal {
  id: string; project_id: string; branch: 'main'; target_path: string; target_mode: string;
  branch_head: string; base_revision: string; manifest_revision: string; canonical_project_root: string;
  evidence: Record<string, unknown>; diff: string; reason: string; review_digest: string;
  status: OrphanRemovalStatus; created_at: string; updated_at: string; payload: OrphanRemovalProposalPayload;
}
export interface OrphanRemovalCommitAudit {
  proposal_id: string; state: 'prepared' | 'finalized'; approval_digest: string; actor: string;
  canonical_project_root: string; target_path: string; target_mode: string; manifest_revision: string;
  branch_head: string; deletion_fingerprint: string; prepared_at: string; commit_sha: string | null;
  finalized_at: string | null;
}

export interface ProposalRecoveryMetadata {
  rootIdentityKey: string;
  canonicalProjectRoot: string;
  gitWorktreeRoot: string | null;
  gitCommonDir: string | null;
  observedAt: string;
}

export interface ProposalMetadata {
  kind?: 'document_create';
  mode?: 'create';
  changedFiles?: string[];
  baseRevisions?: Record<string, string>;
  riskReasons?: string[];
  recovery?: ProposalRecoveryMetadata;
}

export interface RecoveryObservationMetadata {
  kind: 'recovery_observation';
  operation: 'preview_export' | 'export';
  rootIdentityKey: string;
  canonicalProjectRoot: string;
  gitWorktreeRoot: string | null;
  gitCommonDir: string | null;
  rootUnsafe: boolean;
  safeForWrites: boolean;
  rootMismatch: boolean;
  exportRequired: boolean;
  exportBlocked: boolean;
  warnings: string[];
}

export type DocEventMetadata = RecoveryObservationMetadata;

export interface StoredRecoveryObservation {
  branch: string;
  path: string;
  createdAt: string;
  metadata: RecoveryObservationMetadata;
}

export class EventLog {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        path TEXT NOT NULL,
        actor TEXT,
        tool_name TEXT NOT NULL,
        intent TEXT,
        summary TEXT,
        base_revision TEXT,
        result_revision TEXT,
        risk_level TEXT,
        diff TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_events_project ON doc_events(project_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_events_path ON doc_events(path)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_events_branch ON doc_events(branch)
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        path TEXT NOT NULL,
        base_revision TEXT NOT NULL,
        patch TEXT NOT NULL,
        intent TEXT NOT NULL,
        summary TEXT NOT NULL,
        risk_level TEXT NOT NULL DEFAULT 'low',
        requires_approval INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        committed_at TEXT,
        discarded_at TEXT,
        metadata_json TEXT
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_registration_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        adapter_id TEXT NOT NULL,
        tool_native_root_id TEXT NOT NULL,
        canonical_project_root TEXT NOT NULL,
        project_relative_path TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        manifest_base_revision TEXT NOT NULL,
        proposed_entry_json TEXT NOT NULL,
        changed_files_json TEXT NOT NULL,
        patch TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        approval_established INTEGER NOT NULL DEFAULT 0,
        commit_authorized INTEGER NOT NULL DEFAULT 0,
        prohibited_implications_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_registration_commit_audits (
        proposal_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        binding_fingerprint TEXT NOT NULL,
        approval TEXT NOT NULL,
        actor TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        project_id TEXT NOT NULL,
        canonical_project_root TEXT NOT NULL,
        branch TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        prior_manifest_revision TEXT NOT NULL,
        changed_files_json TEXT NOT NULL,
        artifact_identity_json TEXT NOT NULL,
        committed_at TEXT,
        commit_sha TEXT,
        resulting_manifest_revision TEXT,
        idempotency_state TEXT NOT NULL
      )
    `);
    this.db.exec(`CREATE TABLE IF NOT EXISTS orphan_removal_proposals (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL, target_path TEXT NOT NULL,
      target_mode TEXT NOT NULL, branch_head TEXT NOT NULL, base_revision TEXT NOT NULL,
      manifest_revision TEXT NOT NULL, canonical_project_root TEXT NOT NULL, evidence_json TEXT NOT NULL,
      diff TEXT NOT NULL, reason TEXT NOT NULL, review_digest TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS orphan_removal_commit_audits (
      proposal_id TEXT PRIMARY KEY, state TEXT NOT NULL, approval_digest TEXT NOT NULL, actor TEXT NOT NULL,
      canonical_project_root TEXT NOT NULL, target_path TEXT NOT NULL, target_mode TEXT NOT NULL,
      manifest_revision TEXT NOT NULL, branch_head TEXT NOT NULL, deletion_fingerprint TEXT NOT NULL,
      prepared_at TEXT NOT NULL, commit_sha TEXT, finalized_at TEXT
    )`);
    this.ensureEventColumns();
    this.ensureProposalColumns();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_proposals_status ON doc_proposals(status)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_proposals_project ON doc_proposals(project_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifact_registration_proposals_project
      ON artifact_registration_proposals(project_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifact_registration_proposals_status
      ON artifact_registration_proposals(status)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifact_registration_commit_audits_state
      ON artifact_registration_commit_audits(state)
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_orphan_removal_proposals_project ON orphan_removal_proposals(project_id)');
  }

  private ensureProposalColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(doc_proposals)').all() as Array<{
      name: string;
    }>;

    if (!columns.some((column) => column.name === 'metadata_json')) {
      this.db.exec('ALTER TABLE doc_proposals ADD COLUMN metadata_json TEXT');
    }

    if (!columns.some((column) => column.name === 'discarded_at')) {
      this.db.exec('ALTER TABLE doc_proposals ADD COLUMN discarded_at TEXT');
    }

    const orphanAuditColumns = this.db.prepare('PRAGMA table_info(orphan_removal_commit_audits)').all() as Array<{ name: string }>;
    if (!orphanAuditColumns.some((column) => column.name === 'commit_sha')) {
      this.db.exec('ALTER TABLE orphan_removal_commit_audits ADD COLUMN commit_sha TEXT');
    }
  }

  private ensureEventColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(doc_events)').all() as Array<{
      name: string;
    }>;

    if (!columns.some((column) => column.name === 'metadata_json')) {
      this.db.exec('ALTER TABLE doc_events ADD COLUMN metadata_json TEXT');
    }
  }

  logEvent(event: DocEvent): DocEvent {
    const id = event.id ?? crypto.randomUUID();
    const createdAt = event.created_at ?? new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO doc_events (id, project_id, branch, path, actor, tool_name, intent, summary, base_revision, result_revision, risk_level, diff, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      event.project_id,
      event.branch,
      event.path,
      event.actor ?? null,
      event.tool_name,
      event.intent ?? null,
      event.summary ?? null,
      event.base_revision ?? null,
      event.result_revision ?? null,
      event.risk_level ?? null,
      event.diff ?? null,
      createdAt,
      event.metadata ? JSON.stringify(event.metadata) : null,
    );

    return { ...event, id, created_at: createdAt };
  }

  getHistory(path?: string, limit = 50): DocEvent[] {
    if (path) {
      const stmt = this.db.prepare(
        'SELECT * FROM doc_events WHERE path = ? ORDER BY created_at DESC LIMIT ?',
      );
      return stmt.all(path, limit) as unknown as DocEvent[];
    }
    const stmt = this.db.prepare(
      'SELECT * FROM doc_events ORDER BY created_at DESC LIMIT ?',
    );
    return stmt.all(limit) as unknown as DocEvent[];
  }

  getHistoryForPath(projectId: string, path: string, limit = 50): DocEvent[] {
    const stmt = this.db.prepare(
      'SELECT * FROM doc_events WHERE project_id = ? AND path = ? ORDER BY created_at DESC LIMIT ?',
    );
    return stmt.all(projectId, path, limit) as unknown as DocEvent[];
  }

  // ── Proposal Storage ─────────────────────────────────────────────────

  /**
   * Store a validated proposal and return it with a generated id and timestamp.
   */
  storeProposal(proposal: {
    project_id: string;
    branch: string;
    path: string;
    base_revision: string;
    patch: string;
    intent: string;
    summary: string;
    risk_level: string;
    requires_approval: boolean;
    metadata?: ProposalMetadata;
  }): StoredProposal {
    const id = `prop_${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO doc_proposals (id, project_id, branch, path, base_revision, patch, intent, summary, risk_level, requires_approval, status, created_at, committed_at, discarded_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?)
    `);

    stmt.run(
      id,
      proposal.project_id,
      proposal.branch,
      proposal.path,
      proposal.base_revision,
      proposal.patch,
      proposal.intent,
      proposal.summary,
      proposal.risk_level,
      proposal.requires_approval ? 1 : 0,
      createdAt,
      proposal.metadata ? JSON.stringify(proposal.metadata) : null,
    );

    return {
      id,
      ...proposal,
      requires_approval: proposal.requires_approval,
      status: 'pending',
      created_at: createdAt,
      committed_at: null,
      discarded_at: null,
      metadata: proposal.metadata ?? null,
    };
  }

  /**
   * Retrieve a stored proposal by its id.
   */
  getProposal(id: string): StoredProposal | null {
    const stmt = this.db.prepare('SELECT * FROM doc_proposals WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return mapStoredProposalRow(row);
  }

  /**
   * List proposals for a project, optionally filtered by branch and status.
   */
  listProposals(filters: {
    projectId: string;
    branch?: string;
    status?: 'pending' | 'committed' | 'rejected' | 'stale' | 'discarded' | 'all';
  }): StoredProposal[] {
    const conditions: string[] = ['project_id = ?'];
    const params: Array<string> = [filters.projectId];

    if (filters.branch) {
      conditions.push('branch = ?');
      params.push(filters.branch);
    }

    if (filters.status && filters.status !== 'all') {
      conditions.push('status = ?');
      params.push(filters.status);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = this.db.prepare(
      `SELECT * FROM doc_proposals ${whereClause} ORDER BY created_at DESC`,
    );

    const rows = stmt.all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => mapStoredProposalRow(row));
  }

  storeArtifactRegistrationProposal(proposal: {
    project_id: string;
    branch: string;
    adapter_id: string;
    tool_native_root_id: string;
    canonical_project_root: string;
    project_relative_path: string;
    manifest_path: 'docs/manifest.yml';
    manifest_base_revision: string;
    proposed_entry: Record<string, unknown>;
    changed_files: string[];
    patch: string;
    prohibited_implications: string[];
    payload: Omit<ArtifactRegistrationProposalPayload, 'proposalId' | 'createdAt'>;
  }): StoredArtifactRegistrationProposal {
    const id = `artreg_${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    const payload: ArtifactRegistrationProposalPayload = {
      ...proposal.payload,
      proposalId: id,
      createdAt,
    };

    const stmt = this.db.prepare(`
      INSERT INTO artifact_registration_proposals (
        id, project_id, branch, kind, schema_version, adapter_id,
        tool_native_root_id, canonical_project_root, project_relative_path,
        manifest_path, manifest_base_revision, proposed_entry_json,
        changed_files_json, patch, status, approval_established,
        commit_authorized, prohibited_implications_json, payload_json,
        created_at
      )
      VALUES (?, ?, ?, 'artifact_registration', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?)
    `);

    stmt.run(
      id,
      proposal.project_id,
      proposal.branch,
      proposal.adapter_id,
      proposal.tool_native_root_id,
      proposal.canonical_project_root,
      proposal.project_relative_path,
      proposal.manifest_path,
      proposal.manifest_base_revision,
      JSON.stringify(proposal.proposed_entry),
      JSON.stringify(proposal.changed_files),
      proposal.patch,
      JSON.stringify(proposal.prohibited_implications),
      JSON.stringify(payload),
      createdAt,
    );

    return {
      id,
      project_id: proposal.project_id,
      branch: proposal.branch,
      kind: 'artifact_registration',
      schema_version: 1,
      adapter_id: proposal.adapter_id,
      tool_native_root_id: proposal.tool_native_root_id,
      canonical_project_root: proposal.canonical_project_root,
      project_relative_path: proposal.project_relative_path,
      manifest_path: proposal.manifest_path,
      manifest_base_revision: proposal.manifest_base_revision,
      proposed_entry: proposal.proposed_entry,
      changed_files: proposal.changed_files,
      patch: proposal.patch,
      status: 'pending',
      approval_established: false,
      commit_authorized: false,
      prohibited_implications: proposal.prohibited_implications,
      created_at: createdAt,
      payload,
    };
  }

  getArtifactRegistrationProposal(
    id: string,
  ): StoredArtifactRegistrationProposal | null {
    const stmt = this.db.prepare(
      'SELECT * FROM artifact_registration_proposals WHERE id = ?',
    );
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return mapStoredArtifactRegistrationProposalRow(row);
  }

  listArtifactRegistrationProposals(filters: {
    projectId: string;
    status?: StoredArtifactRegistrationProposal['status'] | 'all';
  }): StoredArtifactRegistrationProposal[] {
    const conditions: string[] = ['project_id = ?'];
    const params: string[] = [filters.projectId];

    if (filters.status && filters.status !== 'all') {
      conditions.push('status = ?');
      params.push(filters.status);
    }

    const stmt = this.db.prepare(
      `SELECT * FROM artifact_registration_proposals WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    );

    return (stmt.all(...params) as Array<Record<string, unknown>>)
      .map((row) => mapStoredArtifactRegistrationProposalRow(row));
  }

  getArtifactRegistrationCommitAudit(
    proposalId: string,
  ): ArtifactRegistrationCommitAudit | null {
    const row = this.db.prepare(
      'SELECT * FROM artifact_registration_commit_audits WHERE proposal_id = ?',
    ).get(proposalId) as Record<string, unknown> | undefined;

    return row ? mapArtifactRegistrationCommitAuditRow(row) : null;
  }

  /**
   * Persist the proposal-bound commit intent before touching managed Git state.
   *
   * The prepared row is intentionally not replaced. If a previous attempt made
   * it this far, that row becomes the reconciliation anchor rather than a retry
   * signal.
   */
  prepareArtifactRegistrationCommitAudit(audit: Omit<
    ArtifactRegistrationCommitAudit,
    'state' | 'committed_at' | 'commit_sha' | 'resulting_manifest_revision' | 'idempotency_state'
  >): ArtifactRegistrationCommitAudit {
    const prepared: ArtifactRegistrationCommitAudit = {
      ...audit,
      state: 'prepared',
      committed_at: null,
      commit_sha: null,
      resulting_manifest_revision: null,
      idempotency_state: 'prepared',
    };

    const stmt = this.db.prepare(`
      INSERT INTO artifact_registration_commit_audits (
        proposal_id, state, binding_fingerprint, approval, actor,
        approved_at, project_id, canonical_project_root, branch,
        manifest_path, prior_manifest_revision, changed_files_json,
        artifact_identity_json, committed_at, commit_sha,
        resulting_manifest_revision, idempotency_state
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
    `);

    stmt.run(
      prepared.proposal_id,
      prepared.state,
      prepared.binding_fingerprint,
      prepared.approval,
      prepared.actor,
      prepared.approved_at,
      prepared.project_id,
      prepared.canonical_project_root,
      prepared.branch,
      prepared.manifest_path,
      prepared.prior_manifest_revision,
      JSON.stringify(prepared.changed_files),
      JSON.stringify(prepared.artifact_identity),
      prepared.idempotency_state,
    );

    return prepared;
  }

  finalizeArtifactRegistrationCommitAudit(input: {
    proposalId: string;
    bindingFingerprint: string;
    commitSha: string;
    resultingManifestRevision: string;
    committedAt?: string;
  }): ArtifactRegistrationCommitAudit {
    const committedAt = input.committedAt ?? new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getArtifactRegistrationCommitAudit(input.proposalId);
      if (!existing) {
        throw new Error(
          `Artifact-registration commit audit for proposal "${input.proposalId}" is missing`,
        );
      }
      if (existing.state !== 'prepared') {
        throw new Error(
          `Artifact-registration commit audit for proposal "${input.proposalId}" is already ${existing.state}`,
        );
      }
      if (existing.binding_fingerprint !== input.bindingFingerprint) {
        throw new Error(
          `Artifact-registration commit audit binding mismatch for proposal "${input.proposalId}"`,
        );
      }

      this.db.prepare(`
        UPDATE artifact_registration_commit_audits
        SET state = 'finalized',
            committed_at = ?,
            commit_sha = ?,
            resulting_manifest_revision = ?,
            idempotency_state = 'applied_new'
        WHERE proposal_id = ?
      `).run(
        committedAt,
        input.commitSha,
        input.resultingManifestRevision,
        input.proposalId,
      );

      this.db.prepare(`
        UPDATE artifact_registration_proposals
        SET status = 'committed'
        WHERE id = ? AND status = 'pending'
      `).run(input.proposalId);

      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch { /* ignore rollback failures */ }
      throw error;
    }

    const finalized = this.getArtifactRegistrationCommitAudit(input.proposalId);
    if (!finalized) {
      throw new Error(
        `Artifact-registration commit audit for proposal "${input.proposalId}" disappeared after finalization`,
      );
    }
    return finalized;
  }

  getLatestRecoveryObservation(
    projectId: string,
    operation: RecoveryObservationMetadata['operation'],
  ): StoredRecoveryObservation | null {
    const row = this.db.prepare(
      `
      SELECT branch, path, created_at, metadata_json
      FROM doc_events
      WHERE project_id = ? AND tool_name = ? AND metadata_json IS NOT NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
      `,
    ).get(projectId, operation) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const metadata = parseDocEventMetadata(row.metadata_json);
    if (!metadata || metadata.kind !== 'recovery_observation' || metadata.operation !== operation) {
      return null;
    }

    return {
      branch: row.branch as string,
      path: row.path as string,
      createdAt: row.created_at as string,
      metadata,
    };
  }

  /**
   * Update the status of a stored proposal (e.g. 'committed', 'rejected', 'stale').
   */
  updateProposalStatus(
    id: string,
    status: StoredProposal['status'],
  ): void {
    const committedAt = status === 'committed' ? new Date().toISOString() : null;
    const discardedAt = status === 'discarded' ? new Date().toISOString() : null;
    const stmt = this.db.prepare(
      'UPDATE doc_proposals SET status = ?, committed_at = ?, discarded_at = ? WHERE id = ?',
    );
    stmt.run(status, committedAt, discardedAt, id);
  }

  /**
   * Mark a proposal as discarded while preserving the stored record.
   */
  discardProposal(id: string): StoredProposal | null {
    const existing = this.getProposal(id);
    if (!existing) {
      return null;
    }

    if (existing.status === 'committed') {
      throw new Error(`Proposal "${id}" has status "committed" and cannot be discarded`);
    }

    if (existing.status === 'discarded') {
      return existing;
    }

    this.updateProposalStatus(id, 'discarded');
    return this.getProposal(id);
  }

  storeOrphanRemovalProposal(input: Omit<StoredOrphanRemovalProposal, 'id' | 'created_at' | 'updated_at' | 'payload'>): StoredOrphanRemovalProposal {
    const id = `orphan_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const payload: OrphanRemovalProposalPayload = {
      proposalId: id, kind: 'orphan_removal', schemaVersion: 1, projectId: input.project_id,
      branch: input.branch, targetPath: input.target_path, targetMode: input.target_mode,
      branchHead: input.branch_head, baseRevision: input.base_revision, manifestRevision: input.manifest_revision,
      canonicalProjectRoot: input.canonical_project_root, evidence: input.evidence, diff: input.diff,
      reason: input.reason, reviewDigest: input.review_digest, status: input.status, createdAt: now, updatedAt: now,
    };
    this.db.prepare(`INSERT INTO orphan_removal_proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.project_id, input.branch, input.target_path, input.target_mode, input.branch_head,
        input.base_revision, input.manifest_revision, input.canonical_project_root, JSON.stringify(input.evidence),
        input.diff, input.reason, input.review_digest, input.status, now, now, JSON.stringify(payload));
    return { ...input, id, created_at: now, updated_at: now, payload };
  }

  getOrphanRemovalProposal(id: string): StoredOrphanRemovalProposal | null {
    const row = this.db.prepare('SELECT * FROM orphan_removal_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    try { return { ...row, branch: row.branch as 'main', status: row.status as OrphanRemovalStatus,
      evidence: JSON.parse(row.evidence_json as string), payload: JSON.parse(row.payload_json as string),
    } as StoredOrphanRemovalProposal; } catch { return null; }
  }

  updateOrphanRemovalStatus(id: string, status: OrphanRemovalStatus): void {
    this.db.prepare('UPDATE orphan_removal_proposals SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  getOrphanRemovalCommitAudit(proposalId: string): OrphanRemovalCommitAudit | null {
    const row = this.db.prepare('SELECT * FROM orphan_removal_commit_audits WHERE proposal_id = ?').get(proposalId) as Record<string, unknown> | undefined;
    return row ? row as unknown as OrphanRemovalCommitAudit : null;
  }

  prepareOrphanRemovalCommitAudit(audit: Omit<OrphanRemovalCommitAudit, 'state' | 'prepared_at' | 'commit_sha' | 'finalized_at'>): OrphanRemovalCommitAudit {
    const preparedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO orphan_removal_commit_audits VALUES (?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run(audit.proposal_id, audit.approval_digest, audit.actor, audit.canonical_project_root,
        audit.target_path, audit.target_mode, audit.manifest_revision, audit.branch_head,
        audit.deletion_fingerprint, preparedAt);
    return { ...audit, state: 'prepared', prepared_at: preparedAt, commit_sha: null, finalized_at: null };
  }

  finalizeOrphanRemovalCommitAudit(proposalId: string, commitSha: string): OrphanRemovalCommitAudit {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE orphan_removal_commit_audits SET state='finalized', commit_sha=?, finalized_at=? WHERE proposal_id=? AND state='prepared'`).run(commitSha, now, proposalId);
    if (result.changes !== 1) throw new Error('Unable to finalize orphan-removal audit');
    this.updateOrphanRemovalStatus(proposalId, 'committed');
    const audit = this.getOrphanRemovalCommitAudit(proposalId);
    if (!audit) throw new Error('Orphan-removal audit disappeared');
    return audit;
  }

  /** Persist a known generated deletion commit without claiming final audit completion. */
  recordOrphanRemovalGeneratedCommit(proposalId: string, commitSha: string): void {
    const result = this.db.prepare(`UPDATE orphan_removal_commit_audits SET commit_sha=? WHERE proposal_id=? AND state='prepared'`).run(commitSha, proposalId);
    if (result.changes !== 1) throw new Error('Unable to record orphan-removal generated commit');
  }

  close(): void {
    this.db.close();
  }
}

function parseProposalMetadata(raw: unknown): ProposalMetadata | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as ProposalMetadata;
    const recovery = parseProposalRecoveryMetadata(parsed.recovery);
    const documentCreate =
      parsed.kind === 'document_create' &&
      parsed.mode === 'create' &&
      Array.isArray(parsed.changedFiles) &&
      parsed.changedFiles.every((filePath) => typeof filePath === 'string') &&
      parsed.baseRevisions &&
      typeof parsed.baseRevisions === 'object';

    if (documentCreate) {
      return {
        kind: 'document_create',
        mode: 'create',
        changedFiles: parsed.changedFiles,
        baseRevisions: parsed.baseRevisions,
        riskReasons:
          Array.isArray(parsed.riskReasons) && parsed.riskReasons.every((reason) => typeof reason === 'string')
            ? parsed.riskReasons
            : undefined,
        recovery,
      };
    }

    if (recovery) {
      return { recovery };
    }
  } catch {
    // Ignore malformed metadata from older or partial rows.
  }

  return null;
}

function parseProposalRecoveryMetadata(raw: unknown): ProposalRecoveryMetadata | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const parsed = raw as Record<string, unknown>;
  if (
    typeof parsed.rootIdentityKey === 'string' &&
    typeof parsed.canonicalProjectRoot === 'string' &&
    typeof parsed.observedAt === 'string' &&
    (parsed.gitWorktreeRoot === null || typeof parsed.gitWorktreeRoot === 'string') &&
    (parsed.gitCommonDir === null || typeof parsed.gitCommonDir === 'string')
  ) {
    return {
      rootIdentityKey: parsed.rootIdentityKey,
      canonicalProjectRoot: parsed.canonicalProjectRoot,
      gitWorktreeRoot: (parsed.gitWorktreeRoot as string | null) ?? null,
      gitCommonDir: (parsed.gitCommonDir as string | null) ?? null,
      observedAt: parsed.observedAt,
    };
  }

  return undefined;
}

function parseDocEventMetadata(raw: unknown): DocEventMetadata | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.kind === 'recovery_observation' &&
      (parsed.operation === 'preview_export' || parsed.operation === 'export') &&
      typeof parsed.rootIdentityKey === 'string' &&
      typeof parsed.canonicalProjectRoot === 'string' &&
      typeof parsed.rootUnsafe === 'boolean' &&
      typeof parsed.safeForWrites === 'boolean' &&
      typeof parsed.rootMismatch === 'boolean' &&
      typeof parsed.exportRequired === 'boolean' &&
      typeof parsed.exportBlocked === 'boolean' &&
      Array.isArray(parsed.warnings) &&
      parsed.warnings.every((warning) => typeof warning === 'string') &&
      (parsed.gitWorktreeRoot === null || typeof parsed.gitWorktreeRoot === 'string') &&
      (parsed.gitCommonDir === null || typeof parsed.gitCommonDir === 'string')
    ) {
      return {
        kind: 'recovery_observation',
        operation: parsed.operation,
        rootIdentityKey: parsed.rootIdentityKey,
        canonicalProjectRoot: parsed.canonicalProjectRoot,
        gitWorktreeRoot: (parsed.gitWorktreeRoot as string | null) ?? null,
        gitCommonDir: (parsed.gitCommonDir as string | null) ?? null,
        rootUnsafe: parsed.rootUnsafe,
        safeForWrites: parsed.safeForWrites,
        rootMismatch: parsed.rootMismatch,
        exportRequired: parsed.exportRequired,
        exportBlocked: parsed.exportBlocked,
        warnings: parsed.warnings as string[],
      };
    }
  } catch {
    // Ignore malformed metadata from older or partial rows.
  }

  return null;
}

function mapStoredProposalRow(row: Record<string, unknown>): StoredProposal {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    branch: row.branch as string,
    path: row.path as string,
    base_revision: row.base_revision as string,
    patch: row.patch as string,
    intent: row.intent as string,
    summary: row.summary as string,
    risk_level: row.risk_level as string,
    requires_approval: (row.requires_approval as number) === 1,
    status: row.status as StoredProposal['status'],
    created_at: row.created_at as string,
    committed_at: (row.committed_at as string) ?? null,
    discarded_at: (row.discarded_at as string) ?? null,
    metadata: parseProposalMetadata(row.metadata_json),
  };
}

function mapStoredArtifactRegistrationProposalRow(
  row: Record<string, unknown>,
): StoredArtifactRegistrationProposal {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    branch: row.branch as string,
    kind: row.kind as 'artifact_registration',
    schema_version: row.schema_version as 1,
    adapter_id: row.adapter_id as string,
    tool_native_root_id: row.tool_native_root_id as string,
    canonical_project_root: row.canonical_project_root as string,
    project_relative_path: row.project_relative_path as string,
    manifest_path: row.manifest_path as 'docs/manifest.yml',
    manifest_base_revision: row.manifest_base_revision as string,
    proposed_entry: parseJsonObject(row.proposed_entry_json),
    changed_files: parseJsonStringArray(row.changed_files_json),
    patch: row.patch as string,
    status: row.status as StoredArtifactRegistrationProposal['status'],
    approval_established: false,
    commit_authorized: false,
    prohibited_implications: parseJsonStringArray(row.prohibited_implications_json),
    created_at: row.created_at as string,
    payload: parseArtifactRegistrationPayload(row.payload_json),
  };
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function parseArtifactRegistrationPayload(
  raw: unknown,
): ArtifactRegistrationProposalPayload {
  const parsed = parseJsonObject(raw);
  return parsed as unknown as ArtifactRegistrationProposalPayload;
}

function mapArtifactRegistrationCommitAuditRow(
  row: Record<string, unknown>,
): ArtifactRegistrationCommitAudit {
  return {
    proposal_id: row.proposal_id as string,
    state: row.state as ArtifactRegistrationCommitAudit['state'],
    binding_fingerprint: row.binding_fingerprint as string,
    approval: row.approval as ArtifactRegistrationCommitAudit['approval'],
    actor: row.actor as string,
    approved_at: row.approved_at as string,
    project_id: row.project_id as string,
    canonical_project_root: row.canonical_project_root as string,
    branch: row.branch as string,
    manifest_path: row.manifest_path as 'docs/manifest.yml',
    prior_manifest_revision: row.prior_manifest_revision as string,
    changed_files: parseJsonStringArray(row.changed_files_json),
    artifact_identity: parseJsonObject(row.artifact_identity_json),
    committed_at: (row.committed_at as string) ?? null,
    commit_sha: (row.commit_sha as string) ?? null,
    resulting_manifest_revision: (row.resulting_manifest_revision as string) ?? null,
    idempotency_state:
      row.idempotency_state as ArtifactRegistrationCommitAudit['idempotency_state'],
  };
}
