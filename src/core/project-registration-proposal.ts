import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectGitIdentity, normalizeExistingPath, type GitIdentity } from './git-identity.js';
import { getProjectMarkerPath } from './project-resolution.js';
import { Registry, type ProjectEntry } from './registry.js';
import { StoragePaths, resolveStorageRoots, type ResolvedStorageRoots } from './storage.js';
import { computeRootMismatch, type RootSafetySummary } from './root-safety.js';

export type ProposalEvidenceClassification =
  | 'observed'
  | 'absent'
  | 'unavailable'
  | 'inferred'
  | 'not_applicable'
  | 'conflicting';

type ProjectIdentitySource = 'explicit' | 'marker' | 'unavailable';

interface EvidenceItem {
  id: string;
  source: string;
  path: string | null;
  classification: ProposalEvidenceClassification;
  summary: string;
  errorCategory: string | null;
  supportingEvidenceIds: string[];
}

interface ClassifiedPathState {
  path: string;
  classification: ProposalEvidenceClassification;
  exists: boolean | null;
  kind: 'file' | 'directory' | 'other' | null;
  readStatus: 'observed' | 'absent' | 'unavailable';
}

interface RegistrationProposalOptions {
  projectRoot?: string;
  projectId?: string;
  configDir?: string;
  dataDir?: string;
  cwd?: string;
}

interface MarkerObservation {
  path: string | null;
  presence: ProposalEvidenceClassification;
  parsedSchemaVersion: number | null;
  projectId: string | null;
  readStatus: 'observed' | 'absent' | 'unavailable' | 'not_applicable';
  agreesWithProposedProjectId: boolean | null;
}

interface RegistryObservation {
  path: string;
  readStatus: 'observed' | 'absent' | 'unavailable';
  entryByProjectId: ProjectEntry | null;
  entryByCanonicalRoot: ProjectEntry | null;
  defaultProjectId: string | null;
  collisionStatus: 'none_observed' | 'project_id_collision' | 'root_collision' | 'conflicting' | 'unavailable';
}

interface DaemonObservation {
  pidFilePath: string;
  readStatus: 'observed' | 'absent' | 'unavailable';
  status: 'running' | 'stale' | 'absent' | 'unavailable';
  pid: number | null;
  boundProjectId: string | null;
  boundProjectRoot: string | null;
  mismatchStatus: 'none_observed' | 'project_id_mismatch' | 'root_mismatch' | 'conflicting' | 'not_applicable' | 'unavailable';
}

export interface ProjectRegistrationProposal {
  schemaVersion: 1;
  kind: 'atlas.project-registration.proposal';
  diagnosticOnly: {
    readOnly: true;
    mutating: false;
    authorizationEstablished: false;
    operationalEligibilityEstablished: false;
    safeForWritesEstablished: false;
    daemonReadinessEstablished: false;
    registrationReserved: false;
    statement: string;
  };
  observedAt: string;
  requested: {
    cwd: string;
    rootInput: string | null;
    cwdFallbackUsed: boolean;
    projectId: string | null;
    selectedConfigDir: string;
    selectedDataDir: string;
    configRootSource: ResolvedStorageRoots['configSource'];
    dataRootSource: ResolvedStorageRoots['dataSource'];
  };
  projectIdentity: {
    projectId: string | null;
    source: ProjectIdentitySource;
    validationStatus: 'valid' | 'invalid' | 'unavailable';
    conflictStatus: 'none_observed' | 'explicit_marker_conflict' | 'registry_conflict' | 'unavailable';
  };
  root: {
    requestedRoot: string;
    resolvedRoot: string | null;
    canonicalRoot: string | null;
    exists: boolean | null;
    kind: 'directory' | 'file' | 'other' | null;
    requestedPathIsCheckoutRoot: boolean | null;
  };
  marker: MarkerObservation;
  registry: RegistryObservation;
  daemon: DaemonObservation;
  git: GitIdentity & {
    linkedWorktree: boolean | null;
    unavailableErrorStatus: 'none' | 'not_git_worktree' | 'unavailable';
  };
  managedState: {
    managedProjectDirectory: ClassifiedPathState;
    managedGitStore: ClassifiedPathState;
    eventDatabase: ClassifiedPathState;
    searchDatabase: ClassifiedPathState;
    statement: string;
  };
  safety: RootSafetySummary & {
    safeForWritesStatement: string;
    singleCheckoutApplicable: boolean;
    ineligibleRootReasons: string[];
  };
  evidence: EvidenceItem[];
  prohibitedImplications: string[];
  nextRequiredAction: string;
}

const PROHIBITED_IMPLICATIONS = [
  'automatic registration',
  'registry mutation',
  'marker mutation',
  'daemon start/stop/readiness',
  'daemon binding',
  'managed-document mutation',
  'managed-state mutation',
  'project-administration mutation',
  'safe-for-writes status beyond the reported current observation',
  'export eligibility',
  'managed-write eligibility',
  'initialization recommendation as authority',
  'repair recommendation as authority',
  'adoption/rebind eligibility',
  'lock acquisition',
  'identity reservation',
  'registration conversion',
  'operational eligibility',
  'branch, worktree, Git, release, package, provider, Studio, or network readiness',
];

export async function buildProjectRegistrationProposal(
  options: RegistrationProposalOptions = {},
): Promise<ProjectRegistrationProposal> {
  const observedAt = new Date().toISOString();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const rootInput = options.projectRoot ?? null;
  const requestedRoot = path.resolve(options.projectRoot ?? cwd);
  const cwdFallbackUsed = options.projectRoot == null;
  const storageRoots = resolveStorageRoots({
    configDir: options.configDir,
    dataDir: options.dataDir,
  });
  const storage = new StoragePaths({
    configDir: options.configDir,
    dataDir: options.dataDir,
  });
  const evidence: EvidenceItem[] = [];

  const rootState = await inspectRoot(requestedRoot, evidence);
  const canonicalRoot = rootState.kind === 'directory'
    ? normalizeExistingPath(requestedRoot)
    : null;
  if (canonicalRoot) {
    evidence.push({
      id: 'root.canonical',
      source: 'filesystem.realpath',
      path: canonicalRoot,
      classification: 'observed',
      summary: 'canonical root observed for the requested checkout context',
      errorCategory: null,
      supportingEvidenceIds: ['root.requested'],
    });
  } else {
    evidence.push({
      id: 'root.canonical',
      source: 'filesystem.realpath',
      path: requestedRoot,
      classification: rootState.classification === 'unavailable' ? 'unavailable' : 'not_applicable',
      summary: 'canonical root was not available because the requested root is not an inspectable directory',
      errorCategory: rootState.errorCategory,
      supportingEvidenceIds: ['root.requested'],
    });
  }

  const marker = await inspectMarker(canonicalRoot, evidence);
  const explicitProjectId = options.projectId?.trim() || null;
  const projectIdentity = deriveProjectIdentity(explicitProjectId, marker, evidence);
  const projectId = projectIdentity.projectId;
  const registry = await inspectRegistry(storage, projectId, canonicalRoot, evidence);
  const daemon = await inspectDaemon(storage, projectId, canonicalRoot, evidence);
  const git = await inspectGit(requestedRoot, canonicalRoot, evidence);
  const managedState = await inspectManagedState(storage, projectId, evidence);
  const safety = deriveSafety({
    canonicalRoot,
    marker,
    registry,
    daemon,
    git,
    projectId,
    rootKind: rootState.kind,
  });

  if (projectIdentity.conflictStatus !== 'none_observed' && projectIdentity.conflictStatus !== 'unavailable') {
    evidence.push({
      id: 'projectIdentity.conflict',
      source: 'proposal.inference',
      path: null,
      classification: 'conflicting',
      summary: 'requested and observed project identity signals disagree',
      errorCategory: null,
      supportingEvidenceIds: ['projectIdentity.selected', 'marker.file'],
    });
  }

  return {
    schemaVersion: 1,
    kind: 'atlas.project-registration.proposal',
    diagnosticOnly: {
      readOnly: true,
      mutating: false,
      authorizationEstablished: false,
      operationalEligibilityEstablished: false,
      safeForWritesEstablished: false,
      daemonReadinessEstablished: false,
      registrationReserved: false,
      statement:
        'This point-in-time proposal is diagnostic output only. It does not establish authorization, operational eligibility, registration reservation, daemon readiness, or safeForWrites authority beyond the current observation.',
    },
    observedAt,
    requested: {
      cwd,
      rootInput,
      cwdFallbackUsed,
      projectId: explicitProjectId,
      selectedConfigDir: storageRoots.configDir,
      selectedDataDir: storageRoots.dataDir,
      configRootSource: storageRoots.configSource,
      dataRootSource: storageRoots.dataSource,
    },
    projectIdentity,
    root: {
      requestedRoot,
      resolvedRoot: rootState.kind === 'directory' ? requestedRoot : null,
      canonicalRoot,
      exists: rootState.exists,
      kind: rootState.kind,
      requestedPathIsCheckoutRoot: git.insideWorkTree && canonicalRoot
        ? samePath(git.worktreeRoot, canonicalRoot)
        : git.insideWorkTree ? false : null,
    },
    marker,
    registry,
    daemon,
    git,
    managedState,
    safety,
    evidence,
    prohibitedImplications: PROHIBITED_IMPLICATIONS,
    nextRequiredAction:
      'Any later mutating registration, adoption, initialization, daemon, managed-document, or managed-state action requires a future explicit command or tool call, fresh re-observation, independent validation, and explicit human authorization at that later time.',
  };
}

async function inspectRoot(
  requestedRoot: string,
  evidence: EvidenceItem[],
): Promise<ClassifiedPathState & { errorCategory: string | null }> {
  try {
    const stat = await fs.promises.stat(requestedRoot);
    const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    evidence.push({
      id: 'root.requested',
      source: 'filesystem.stat',
      path: requestedRoot,
      classification: kind === 'directory' ? 'observed' : 'unavailable',
      summary: kind === 'directory'
        ? 'requested root exists as a directory'
        : 'requested root exists but is not a directory checkout root',
      errorCategory: kind === 'directory' ? null : 'unsupported',
      supportingEvidenceIds: [],
    });
    return {
      path: requestedRoot,
      classification: kind === 'directory' ? 'observed' : 'unavailable',
      exists: true,
      kind,
      readStatus: kind === 'directory' ? 'observed' : 'unavailable',
      errorCategory: kind === 'directory' ? null : 'unsupported',
    };
  } catch (error) {
    const code = nodeErrorCode(error);
    const absent = code === 'ENOENT' || code === 'ENOTDIR';
    evidence.push({
      id: 'root.requested',
      source: 'filesystem.stat',
      path: requestedRoot,
      classification: absent ? 'absent' : 'unavailable',
      summary: absent
        ? 'requested root was safely inspected and not found'
        : 'requested root could not be inspected safely',
      errorCategory: absent ? null : categoryFromNodeError(error),
      supportingEvidenceIds: [],
    });
    return {
      path: requestedRoot,
      classification: absent ? 'absent' : 'unavailable',
      exists: absent ? false : null,
      kind: null,
      readStatus: absent ? 'absent' : 'unavailable',
      errorCategory: absent ? null : categoryFromNodeError(error),
    };
  }
}

async function inspectMarker(
  canonicalRoot: string | null,
  evidence: EvidenceItem[],
): Promise<MarkerObservation> {
  if (!canonicalRoot) {
    evidence.push({
      id: 'marker.file',
      source: 'filesystem.readFile',
      path: null,
      classification: 'not_applicable',
      summary: 'project marker does not apply because no canonical root is available',
      errorCategory: null,
      supportingEvidenceIds: ['root.canonical'],
    });
    return {
      path: null,
      presence: 'not_applicable',
      parsedSchemaVersion: null,
      projectId: null,
      readStatus: 'not_applicable',
      agreesWithProposedProjectId: null,
    };
  }

  const markerPath = getProjectMarkerPath(canonicalRoot);
  try {
    const raw = await fs.promises.readFile(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.projectId !== 'string' || parsed.projectId.trim().length === 0) {
      throw new Error('projectId missing or invalid');
    }
    const schemaVersion = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : null;
    evidence.push({
      id: 'marker.file',
      source: 'filesystem.readFile',
      path: markerPath,
      classification: 'observed',
      summary: 'project marker was read and parsed',
      errorCategory: null,
      supportingEvidenceIds: ['root.canonical'],
    });
    return {
      path: markerPath,
      presence: 'observed',
      parsedSchemaVersion: schemaVersion,
      projectId: parsed.projectId,
      readStatus: 'observed',
      agreesWithProposedProjectId: null,
    };
  } catch (error) {
    const code = nodeErrorCode(error);
    const absent = code === 'ENOENT' || code === 'ENOTDIR';
    evidence.push({
      id: 'marker.file',
      source: 'filesystem.readFile',
      path: markerPath,
      classification: absent ? 'absent' : 'unavailable',
      summary: absent
        ? 'project marker was safely inspected and not found'
        : 'project marker could not be read or parsed safely',
      errorCategory: absent ? null : 'malformed_or_unreadable',
      supportingEvidenceIds: ['root.canonical'],
    });
    return {
      path: markerPath,
      presence: absent ? 'absent' : 'unavailable',
      parsedSchemaVersion: null,
      projectId: null,
      readStatus: absent ? 'absent' : 'unavailable',
      agreesWithProposedProjectId: null,
    };
  }
}

function deriveProjectIdentity(
  explicitProjectId: string | null,
  marker: MarkerObservation,
  evidence: EvidenceItem[],
): ProjectRegistrationProposal['projectIdentity'] {
  const projectId = explicitProjectId ?? marker.projectId;
  const source: ProjectIdentitySource = explicitProjectId ? 'explicit' : marker.projectId ? 'marker' : 'unavailable';
  const validationStatus = projectId == null
    ? 'unavailable'
    : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId) ? 'valid' : 'invalid';
  const conflictStatus = explicitProjectId && marker.projectId && explicitProjectId !== marker.projectId
    ? 'explicit_marker_conflict'
    : marker.readStatus === 'unavailable' ? 'unavailable' : 'none_observed';

  if (marker.readStatus === 'observed') {
    marker.agreesWithProposedProjectId = projectId != null && marker.projectId === projectId;
  }

  evidence.push({
    id: 'projectIdentity.selected',
    source: 'proposal.inference',
    path: null,
    classification: conflictStatus === 'explicit_marker_conflict'
      ? 'conflicting'
      : projectId == null ? 'unavailable' : 'inferred',
    summary: projectId == null
      ? 'project identity could not be selected from explicit input or marker evidence'
      : `project identity selected from ${source} evidence`,
    errorCategory: validationStatus === 'invalid' ? 'invalid_project_id' : null,
    supportingEvidenceIds: explicitProjectId ? ['marker.file'] : ['marker.file'],
  });

  return {
    projectId,
    source,
    validationStatus,
    conflictStatus,
  };
}

async function inspectRegistry(
  storage: StoragePaths,
  projectId: string | null,
  canonicalRoot: string | null,
  evidence: EvidenceItem[],
): Promise<RegistryObservation> {
  const registryPath = storage.registryPath();
  try {
    const registry = await Registry.load(storage.configDir, storage.dataDir);
    const entryByProjectId = projectId ? registry.getProject(projectId) : null;
    const projects = registry.listProjects();
    const entryByCanonicalRoot = canonicalRoot
      ? projects.find((entry) => samePath(entry.projectRoot, canonicalRoot)) ?? null
      : null;
    const defaultProjectId = registry.getDefault()?.projectId ?? null;
    const pathExists = await fileExists(registryPath);
    const collisionStatus = deriveRegistryCollision(projectId, canonicalRoot, entryByProjectId, entryByCanonicalRoot);

    evidence.push({
      id: 'registry.file',
      source: 'registry.load',
      path: registryPath,
      classification: pathExists ? 'observed' : 'absent',
      summary: pathExists
        ? 'registry was loaded for read-only inspection'
        : 'registry file was safely inspected and not found; default in-memory registry was used for observation',
      errorCategory: null,
      supportingEvidenceIds: [],
    });
    if (collisionStatus !== 'none_observed') {
      evidence.push({
        id: 'registry.collision',
        source: 'proposal.inference',
        path: registryPath,
        classification: 'conflicting',
        summary: 'registry identity or root evidence conflicts with the requested proposal context',
        errorCategory: null,
        supportingEvidenceIds: ['registry.file', 'projectIdentity.selected', 'root.canonical'],
      });
    }

    return {
      path: registryPath,
      readStatus: pathExists ? 'observed' : 'absent',
      entryByProjectId,
      entryByCanonicalRoot,
      defaultProjectId,
      collisionStatus,
    };
  } catch {
    evidence.push({
      id: 'registry.file',
      source: 'registry.load',
      path: registryPath,
      classification: 'unavailable',
      summary: 'registry could not be loaded safely',
      errorCategory: 'malformed_or_unreadable',
      supportingEvidenceIds: [],
    });
    return {
      path: registryPath,
      readStatus: 'unavailable',
      entryByProjectId: null,
      entryByCanonicalRoot: null,
      defaultProjectId: null,
      collisionStatus: 'unavailable',
    };
  }
}

async function inspectDaemon(
  storage: StoragePaths,
  projectId: string | null,
  canonicalRoot: string | null,
  evidence: EvidenceItem[],
): Promise<DaemonObservation> {
  const pidFilePath = storage.daemonPidFilePath();
  try {
    const raw = await fs.promises.readFile(pidFilePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null;
    const boundProjectId = typeof parsed.projectId === 'string' ? parsed.projectId : null;
    const boundProjectRoot = typeof parsed.projectRoot === 'string' ? parsed.projectRoot : null;
    const status = pid && isProcessRunning(pid) ? 'running' : 'stale';
    const mismatchStatus = deriveDaemonMismatch(projectId, canonicalRoot, boundProjectId, boundProjectRoot);

    evidence.push({
      id: 'daemon.pidFile',
      source: 'filesystem.readFile',
      path: pidFilePath,
      classification: 'observed',
      summary: `daemon pid file observed with ${status} process status`,
      errorCategory: null,
      supportingEvidenceIds: [],
    });
    if (mismatchStatus !== 'none_observed' && mismatchStatus !== 'not_applicable') {
      evidence.push({
        id: 'daemon.mismatch',
        source: 'proposal.inference',
        path: pidFilePath,
        classification: 'conflicting',
        summary: 'daemon binding evidence does not match the requested proposal context',
        errorCategory: null,
        supportingEvidenceIds: ['daemon.pidFile', 'projectIdentity.selected', 'root.canonical'],
      });
    }

    return {
      pidFilePath,
      readStatus: 'observed',
      status,
      pid,
      boundProjectId,
      boundProjectRoot,
      mismatchStatus,
    };
  } catch (error) {
    const code = nodeErrorCode(error);
    const absent = code === 'ENOENT' || code === 'ENOTDIR';
    evidence.push({
      id: 'daemon.pidFile',
      source: 'filesystem.readFile',
      path: pidFilePath,
      classification: absent ? 'absent' : 'unavailable',
      summary: absent
        ? 'daemon pid file was safely inspected and not found'
        : 'daemon pid file could not be read or parsed safely',
      errorCategory: absent ? null : 'malformed_or_unreadable',
      supportingEvidenceIds: [],
    });
    return {
      pidFilePath,
      readStatus: absent ? 'absent' : 'unavailable',
      status: absent ? 'absent' : 'unavailable',
      pid: null,
      boundProjectId: null,
      boundProjectRoot: null,
      mismatchStatus: absent ? 'not_applicable' : 'unavailable',
    };
  }
}

async function inspectGit(
  requestedRoot: string,
  canonicalRoot: string | null,
  evidence: EvidenceItem[],
): Promise<ProjectRegistrationProposal['git']> {
  const git = await inspectGitIdentity(canonicalRoot ?? requestedRoot);
  const linkedWorktree = git.insideWorkTree && git.worktreeRoot
    ? !samePath(git.commonDir, path.join(git.worktreeRoot, '.git'))
    : null;
  const classification: ProposalEvidenceClassification = git.insideWorkTree ? 'observed' : 'absent';
  evidence.push({
    id: 'git.identity',
    source: 'git.rev-parse',
    path: canonicalRoot ?? requestedRoot,
    classification,
    summary: git.insideWorkTree
      ? 'git worktree identity was observed'
      : 'requested root is not inside an observed git worktree',
    errorCategory: null,
    supportingEvidenceIds: ['root.canonical'],
  });
  if (git.insideWorkTree && canonicalRoot && !samePath(git.worktreeRoot, canonicalRoot)) {
    evidence.push({
      id: 'git.rootMismatch',
      source: 'proposal.inference',
      path: canonicalRoot,
      classification: 'conflicting',
      summary: 'git worktree root differs from the requested canonical root',
      errorCategory: null,
      supportingEvidenceIds: ['git.identity', 'root.canonical'],
    });
  }
  if (linkedWorktree) {
    evidence.push({
      id: 'git.linkedWorktree',
      source: 'proposal.inference',
      path: git.commonDir,
      classification: 'conflicting',
      summary: 'git common directory indicates a linked worktree or non-primary checkout',
      errorCategory: null,
      supportingEvidenceIds: ['git.identity'],
    });
  }
  return {
    ...git,
    linkedWorktree,
    unavailableErrorStatus: git.insideWorkTree ? 'none' : 'not_git_worktree',
  };
}

async function inspectManagedState(
  storage: StoragePaths,
  projectId: string | null,
  evidence: EvidenceItem[],
): Promise<ProjectRegistrationProposal['managedState']> {
  if (!projectId) {
    const unavailable = (name: string, statePath: string): ClassifiedPathState => {
      evidence.push({
        id: `managedState.${name}`,
        source: 'filesystem.stat',
        path: statePath,
        classification: 'not_applicable',
        summary: 'managed-state path does not apply because project identity is unavailable',
        errorCategory: null,
        supportingEvidenceIds: ['projectIdentity.selected'],
      });
      return {
        path: statePath,
        classification: 'not_applicable',
        exists: null,
        kind: null,
        readStatus: 'unavailable',
      };
    };
    return {
      managedProjectDirectory: unavailable('managedProjectDirectory', path.join(storage.dataDir, 'projects')),
      managedGitStore: unavailable('managedGitStore', path.join(storage.dataDir, 'projects')),
      eventDatabase: unavailable('eventDatabase', path.join(storage.dataDir, 'projects')),
      searchDatabase: unavailable('searchDatabase', path.join(storage.dataDir, 'projects')),
      statement: 'Managed-state evidence is descriptive only and does not authorize managed-state mutation.',
    };
  }

  return {
    managedProjectDirectory: await inspectManagedPath('managedProjectDirectory', storage.projectDataDir(projectId), 'directory', evidence),
    managedGitStore: await inspectManagedPath('managedGitStore', storage.projectRepoPath(projectId), 'directory', evidence),
    eventDatabase: await inspectManagedPath('eventDatabase', storage.projectEventsPath(projectId), 'file', evidence),
    searchDatabase: await inspectManagedPath('searchDatabase', storage.projectSearchPath(projectId), 'file', evidence),
    statement: 'Managed-state evidence is descriptive only and does not authorize managed-state mutation.',
  };
}

async function inspectManagedPath(
  id: string,
  targetPath: string,
  expectedKind: 'file' | 'directory',
  evidence: EvidenceItem[],
): Promise<ClassifiedPathState> {
  try {
    const stat = await fs.promises.stat(targetPath);
    const actualKind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    const matches = actualKind === expectedKind;
    evidence.push({
      id: `managedState.${id}`,
      source: 'filesystem.stat',
      path: targetPath,
      classification: matches ? 'observed' : 'unavailable',
      summary: matches
        ? `${id} was observed`
        : `${id} exists but is not the expected ${expectedKind}`,
      errorCategory: matches ? null : 'unsupported',
      supportingEvidenceIds: ['projectIdentity.selected'],
    });
    return {
      path: targetPath,
      classification: matches ? 'observed' : 'unavailable',
      exists: true,
      kind: actualKind,
      readStatus: matches ? 'observed' : 'unavailable',
    };
  } catch (error) {
    const code = nodeErrorCode(error);
    const absent = code === 'ENOENT' || code === 'ENOTDIR';
    evidence.push({
      id: `managedState.${id}`,
      source: 'filesystem.stat',
      path: targetPath,
      classification: absent ? 'absent' : 'unavailable',
      summary: absent
        ? `${id} was safely inspected and not found`
        : `${id} could not be inspected safely`,
      errorCategory: absent ? null : categoryFromNodeError(error),
      supportingEvidenceIds: ['projectIdentity.selected'],
    });
    return {
      path: targetPath,
      classification: absent ? 'absent' : 'unavailable',
      exists: absent ? false : null,
      kind: null,
      readStatus: absent ? 'absent' : 'unavailable',
    };
  }
}

function deriveSafety(args: {
  canonicalRoot: string | null;
  marker: MarkerObservation;
  registry: RegistryObservation;
  daemon: DaemonObservation;
  git: ProjectRegistrationProposal['git'];
  projectId: string | null;
  rootKind: ClassifiedPathState['kind'];
}): ProjectRegistrationProposal['safety'] {
  const markerMissing = args.marker.presence === 'absent' || args.marker.presence === 'not_applicable';
  const markerMismatch = Boolean(args.projectId && args.marker.projectId && args.marker.projectId !== args.projectId);
  const registeredProjectRootMissing = args.projectId != null && !args.registry.entryByProjectId;
  const registeredProjectRootMismatch = Boolean(
    args.registry.entryByProjectId &&
    args.canonicalRoot &&
    !samePath(args.registry.entryByProjectId.projectRoot, args.canonicalRoot),
  );
  const daemonProjectRootMismatch = args.daemon.mismatchStatus === 'root_mismatch' || args.daemon.mismatchStatus === 'conflicting';
  const gitUnavailable = !args.git.insideWorkTree;
  const gitMismatch = Boolean(args.git.insideWorkTree && args.canonicalRoot && !samePath(args.git.worktreeRoot, args.canonicalRoot));
  const rootMismatch = computeRootMismatch({
    markerMismatch,
    registeredProjectRootMismatch,
    daemonProjectRootMismatch,
    gitMismatch,
  });
  const ineligibleRootReasons: string[] = [];
  if (args.rootKind !== 'directory') ineligibleRootReasons.push('requested root is not an inspectable directory');
  if (gitUnavailable) ineligibleRootReasons.push('git worktree identity unavailable');
  if (gitMismatch) ineligibleRootReasons.push('requested root is not the git checkout root');
  if (args.git.linkedWorktree) ineligibleRootReasons.push('linked worktree or non-primary checkout evidence observed');
  if (markerMismatch) ineligibleRootReasons.push('marker project id mismatch');
  if (registeredProjectRootMismatch) ineligibleRootReasons.push('registry root mismatch');
  if (daemonProjectRootMismatch) ineligibleRootReasons.push('daemon root mismatch');
  if (args.registry.collisionStatus !== 'none_observed' && args.registry.collisionStatus !== 'unavailable') {
    ineligibleRootReasons.push('registry collision evidence observed');
  }

  const ambiguous =
    markerMissing ||
    markerMismatch ||
    registeredProjectRootMissing ||
    registeredProjectRootMismatch ||
    daemonProjectRootMismatch ||
    gitMismatch ||
    gitUnavailable ||
    args.git.linkedWorktree === true ||
    args.registry.collisionStatus !== 'none_observed';
  const safeForWrites =
    !ambiguous &&
    args.projectId != null &&
    args.canonicalRoot != null &&
    args.rootKind === 'directory';
  const warnings = buildSafetyWarnings({
    markerMissing,
    markerMismatch,
    registeredProjectRootMissing,
    registeredProjectRootMismatch,
    daemonProjectRootMismatch,
    gitMismatch,
    gitUnavailable,
    linkedWorktree: args.git.linkedWorktree === true,
    registryCollision: args.registry.collisionStatus !== 'none_observed' && args.registry.collisionStatus !== 'unavailable',
  });

  return {
    safeForWrites,
    ambiguous,
    rootMismatch,
    markerMismatch,
    markerMissing,
    registeredProjectRootMissing,
    registeredProjectRootMismatch,
    daemonProjectRootMismatch,
    gitMismatch,
    gitUnavailable,
    warnings,
    safeForWritesStatement:
      'safeForWrites is a descriptive current-observation signal only; this proposal does not establish write-safety authority for any later action.',
    singleCheckoutApplicable: ineligibleRootReasons.length === 0 && args.git.linkedWorktree !== true,
    ineligibleRootReasons,
  };
}

function deriveRegistryCollision(
  projectId: string | null,
  canonicalRoot: string | null,
  entryByProjectId: ProjectEntry | null,
  entryByCanonicalRoot: ProjectEntry | null,
): RegistryObservation['collisionStatus'] {
  const projectIdCollision = Boolean(
    entryByProjectId &&
    canonicalRoot &&
    !samePath(entryByProjectId.projectRoot, canonicalRoot),
  );
  const rootCollision = Boolean(
    entryByCanonicalRoot &&
    projectId &&
    entryByCanonicalRoot.projectId !== projectId,
  );
  if (projectIdCollision && rootCollision) return 'conflicting';
  if (projectIdCollision) return 'project_id_collision';
  if (rootCollision) return 'root_collision';
  return 'none_observed';
}

function deriveDaemonMismatch(
  projectId: string | null,
  canonicalRoot: string | null,
  boundProjectId: string | null,
  boundProjectRoot: string | null,
): DaemonObservation['mismatchStatus'] {
  if (!boundProjectId && !boundProjectRoot) return 'not_applicable';
  const projectMismatch = Boolean(projectId && boundProjectId && projectId !== boundProjectId);
  const rootMismatch = Boolean(canonicalRoot && boundProjectRoot && !samePath(canonicalRoot, boundProjectRoot));
  if (projectMismatch && rootMismatch) return 'conflicting';
  if (projectMismatch) return 'project_id_mismatch';
  if (rootMismatch) return 'root_mismatch';
  return 'none_observed';
}

function buildSafetyWarnings(signals: {
  markerMissing: boolean;
  markerMismatch: boolean;
  registeredProjectRootMissing: boolean;
  registeredProjectRootMismatch: boolean;
  daemonProjectRootMismatch: boolean;
  gitMismatch: boolean;
  gitUnavailable: boolean;
  linkedWorktree: boolean;
  registryCollision: boolean;
}): string[] {
  const warnings: string[] = [];
  if (signals.markerMissing) warnings.push('missing local project marker');
  if (signals.markerMismatch) warnings.push('marker project id mismatch');
  if (signals.registeredProjectRootMissing) warnings.push('registered project root missing');
  if (signals.registeredProjectRootMismatch) warnings.push('registered project root mismatch');
  if (signals.daemonProjectRootMismatch) warnings.push('daemon project root mismatch');
  if (signals.gitMismatch) warnings.push('git worktree mismatch');
  if (signals.gitUnavailable) warnings.push('git identity unavailable');
  if (signals.linkedWorktree) warnings.push('linked worktree evidence observed');
  if (signals.registryCollision) warnings.push('registry collision evidence observed');
  return warnings;
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeExistingPath(a) === normalizeExistingPath(b);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return nodeErrorCode(error) === 'EPERM';
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function categoryFromNodeError(error: unknown): string {
  const code = nodeErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM') return 'inaccessible';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not_found';
  return 'unexpected';
}
