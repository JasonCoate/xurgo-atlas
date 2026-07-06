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
    kind: 'artifact_registration',
    schema_version: 1,
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
