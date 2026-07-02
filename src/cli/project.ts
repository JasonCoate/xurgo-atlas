import * as path from 'node:path';
import * as fs from 'node:fs';
import { Registry } from '../core/registry.js';
import { adoptProject, ProjectAdoptionError } from '../core/project-adoption.js';
import { StoragePaths } from '../core/storage.js';
import { inspectGitIdentity } from '../core/git-identity.js';
import {
  buildProjectRegistrationProposal,
  type ProjectRegistrationProposal,
} from '../core/project-registration-proposal.js';

/**
 * Parse command-line args for `xurgo-atlas project <subcommand> [options]`.
 * Returns { subcommand, kwargs }.
 */
export function parseProjectArgs(argv: string[]): {
  subcommand: string;
  kwargs: Record<string, string>;
} {
  const subcommand = argv[3] || '';
  const kwargs: Record<string, string> = {};

  for (let i = 4; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-id' && i + 1 < argv.length) {
      kwargs['project-id'] = argv[++i];
    } else if (arg === '--project-root' && i + 1 < argv.length) {
      kwargs['project-root'] = argv[++i];
    } else if (arg === '--config-dir' && i + 1 < argv.length) {
      kwargs['config-dir'] = argv[++i];
    } else if (arg === '--data-dir' && i + 1 < argv.length) {
      kwargs['data-dir'] = argv[++i];
    } else if (arg === '--json') {
      kwargs['json'] = 'true';
    } else if (arg.startsWith('--')) {
      // Skip unknown flags
    }
  }

  return { subcommand, kwargs };
}

/**
 * Print usage for `xurgo-atlas project` subcommands.
 */
export function getProjectUsageText(): string {
  return `
Manage registered Xurgo Atlas projects.

USAGE:
  xurgo-atlas project <subcommand> [options]

SUBCOMMANDS:
  add       Register a new project
    --project-id <id>     Unique identifier for the project
    --project-root <path> Path to the project root
    --config-dir <path>   Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>     Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)

  adopt     Register an existing checkout locally without initializing managed docs
    --project-root <path> Checkout root to adopt (default: .)
    --project-id <id>     Required when no marker exists; must match a marker if present
    --config-dir <path>   Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>     Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)
    Adoption is registry-only. It does not initialize managed docs, create a managed store, or touch tracked files.

  remove    Remove a project from the registry
    --project-id <id>     Project identifier
    --config-dir <path>   Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>     Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)

  list      List all registered projects
    --config-dir <path>   Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>     Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)

  show      Show details for a registered project
    --project-id <id>     Project identifier
    --config-dir <path>   Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>     Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)

  default   Set the default project (used when projectId is omitted)
    --project-id <id>     Project identifier
    --config-dir <path>   Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>     Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)

  inspect-lifecycle
            Inspect local project lifecycle evidence (diagnostic-only, read-only)
    --project-id <id>     Project identifier
    --project-root <path> Optional project root to inspect; defaults to current working directory
    --json                Print output as machine-readable JSON only
    --config-dir <path>   Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>     Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)

  propose-registration
            Emit an ephemeral project-registration proposal (diagnostic-only, read-only)
    --project-root <path> Checkout/root context to observe; defaults to current working directory
    --project-id <id>     Optional requested project identifier
    --json                Print output as machine-readable JSON only
    --config-dir <path>   Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>     Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)
    The proposal is non-durable and cannot authorize registration, adoption, initialization, daemon binding, or writes.

EXAMPLES:
  xurgo-atlas project add --project-id my-app --project-root /path/to/my-app
  xurgo-atlas project adopt --project-root /path/to/my-app --project-id my-app
  xurgo-atlas project remove --project-id my-app
  xurgo-atlas project list
  xurgo-atlas project show --project-id my-app
  xurgo-atlas project default --project-id my-app
  xurgo-atlas project inspect-lifecycle --project-id my-app --project-root /path/to/my-app --json
  xurgo-atlas project propose-registration --project-root /path/to/my-app --project-id my-app --json

`;
}

export function printProjectUsage(): void {
  console.log(getProjectUsageText());
}

// ── Subcommand handlers ────────────────────────────────────────────────

export async function projectAddCommand(
  projectId: string,
  projectRoot: string,
  configDir?: string,
  dataDir?: string,
): Promise<void> {
  const resolvedRoot = path.resolve(projectRoot);
  const registry = await Registry.load(configDir, dataDir);
  const entry = await registry.addProject(projectId, resolvedRoot);
  console.log(`✅ Project "${projectId}" registered at ${resolvedRoot}`);
  console.log(`   Created: ${entry.createdAt}`);
}

export async function projectAdoptCommand(
  projectRoot?: string,
  projectId?: string,
  configDir?: string,
  dataDir?: string,
): Promise<void> {
  try {
    const result = await adoptProject({
      projectRoot,
      projectId,
      configDir,
      dataDir,
    });

    if (result.alreadyAdopted) {
      console.log(`✅ Project "${result.projectId}" is already adopted at ${result.projectRoot}.`);
      console.log('   No registry changes were required.');
    } else {
      console.log(`✅ Project "${result.projectId}" adopted at ${result.projectRoot}.`);
      console.log('   No managed store, marker, or tracked-document changes were made.');
    }
  } catch (error: unknown) {
    if (error instanceof ProjectAdoptionError || error instanceof Error) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

export async function projectRemoveCommand(projectId: string, configDir?: string, dataDir?: string): Promise<void> {
  const registry = await Registry.load(configDir, dataDir);
  const removed = await registry.removeProject(projectId);
  if (removed) {
    console.log(`✅ Project "${projectId}" removed from registry.`);
  } else {
    console.error(`❌ Project "${projectId}" not found in registry.`);
    process.exit(1);
  }
}

export async function projectListCommand(configDir?: string, dataDir?: string): Promise<void> {
  const registry = await Registry.load(configDir, dataDir);
  const projects = registry.listProjects();
  const defaultEntry = registry.getDefault();

  if (projects.length === 0) {
    console.log('No projects registered.');
    console.log('Use "xurgo-atlas project add --project-id <id> --project-root <path>" to add one.');
    return;
  }

  console.log('Registered projects:');
  for (const p of projects) {
    const isDefault = defaultEntry && p.projectId === defaultEntry.projectId;
    console.log(`  ${isDefault ? '*' : ' '} ${p.projectId} -> ${p.projectRoot}${isDefault ? ' (default)' : ''}`);
  }
}

export async function projectShowCommand(projectId: string, configDir?: string, dataDir?: string): Promise<void> {
  const registry = await Registry.load(configDir, dataDir);
  const entry = registry.getProject(projectId);
  if (!entry) {
    console.error(`❌ Project "${projectId}" not found in registry.`);
    process.exit(1);
  }
  console.log(JSON.stringify(entry, null, 2));
}

export async function projectDefaultCommand(projectId: string, configDir?: string, dataDir?: string): Promise<void> {
  const registry = await Registry.load(configDir, dataDir);
  try {
    await registry.setDefault(projectId);
    console.log(`✅ Default project set to "${projectId}".`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${message}`);
    process.exit(1);
  }
}

export async function projectProposeRegistrationCommand(options: {
  projectRoot?: string;
  projectId?: string;
  configDir?: string;
  dataDir?: string;
  json?: boolean;
  cwd?: string;
}): Promise<ProjectRegistrationProposal> {
  const proposal = await buildProjectRegistrationProposal(options);

  if (options.json) {
    console.log(JSON.stringify(proposal, null, 2));
  } else {
    printRegistrationProposal(proposal);
  }

  return proposal;
}

function printRegistrationProposal(proposal: ProjectRegistrationProposal): void {
  console.log('Xurgo Atlas project-registration proposal (diagnostic-only)');
  console.log(`  observed at: ${proposal.observedAt}`);
  console.log(`  project id: ${proposal.projectIdentity.projectId ?? 'unavailable'} (${proposal.projectIdentity.source})`);
  console.log(`  requested root: ${proposal.root.requestedRoot}`);
  console.log(`  canonical root: ${proposal.root.canonicalRoot ?? 'unavailable'}`);
  console.log(`  git checkout root: ${proposal.git.worktreeRoot ?? 'unavailable'}`);
  console.log(`  marker: ${proposal.marker.projectId ?? proposal.marker.readStatus}`);
  console.log(`  registry: ${proposal.registry.collisionStatus}`);
  console.log(`  daemon: ${proposal.daemon.status}`);
  console.log(`  single checkout applicable: ${proposal.safety.singleCheckoutApplicable ? 'yes' : 'no'}`);
  console.log(`  safe for writes observation: ${proposal.safety.safeForWrites ? 'yes' : 'no'}`);
  if (proposal.safety.warnings.length > 0) {
    console.log('  warnings:');
    for (const warning of proposal.safety.warnings) {
      console.log(`    - ${warning}`);
    }
  }
  console.log('');
  console.log(proposal.diagnosticOnly.statement);
  console.log(proposal.nextRequiredAction);
}

type RawObservation = 'present' | 'absent' | 'unavailable_or_unreadable' | 'not_applicable';
type Interpretation = 'direct' | 'inferred' | 'conflicting';
type ErrorCategory = 'malformed' | 'inaccessible' | 'unsupported' | 'unresolved' | 'unreadable' | 'unexpected';
type PrimaryStatus =
  | 'binding_conflict_observed'
  | 'root_unavailable'
  | 'evidence_unavailable'
  | 'recovery_attention_observed'
  | 'aligned_local_managed_state_observed'
  | 'managed_state_without_complete_binding'
  | 'registered_binding_observed'
  | 'no_local_binding_observed';

interface LifecycleWitness {
  id: string;
  rawObservation: RawObservation;
  interpretation: Interpretation;
  path: string | null;
  identifier: string | null;
  value: unknown;
  summary: string;
  errorCategory: ErrorCategory | null;
  supportingWitnesses: string[];
}

interface LifecycleFinding {
  code: string;
  severity: 'conflict' | 'unavailable' | 'attention' | 'observed';
  message: string;
  supportingWitnesses: string[];
  observedFact: {
    summary: string;
    witnesses: string[];
  };
  boundedInference: null;
  recommendation: null;
}

interface LifecycleDiagnostic {
  command: 'project.inspect-lifecycle';
  schemaVersion: 1;
  projectId: string;
  requestedProjectRoot: string | null;
  usedCurrentWorkingDirectory: boolean;
  primaryStatus: PrimaryStatus;
  primaryStatusWitnesses: string[];
  witnesses: Record<string, LifecycleWitness>;
  findings: LifecycleFinding[];
  diagnosticOnly: {
    readOnly: true;
    operationalEligibilityEstablished: false;
    unsupportedImplications: string[];
  };
  exitCode: 0;
}

interface ProjectInspectLifecycleOptions {
  projectId: string;
  projectRoot?: string;
  configDir?: string;
  dataDir?: string;
  json?: boolean;
}

const MANDATORY_WITNESS_IDS = [
  'registry',
  'marker',
  'requestedProjectRoot',
  'resolvedProjectRoot',
  'canonicalProjectRoot',
  'managedProjectDirectory',
  'managedGitStore',
  'eventsDatabase',
  'searchDatabase',
  'gitContext',
  'daemonRuntimeArtifact',
  'rootLedger',
  'recoveryEvidence',
] as const;

export async function projectInspectLifecycleCommand(
  options: ProjectInspectLifecycleOptions,
): Promise<LifecycleDiagnostic> {
  const diagnostic = await inspectProjectLifecycle(options);

  if (options.json) {
    console.log(JSON.stringify(diagnostic, null, 2));
  } else {
    printLifecycleDiagnostic(diagnostic);
  }

  return diagnostic;
}

async function inspectProjectLifecycle(
  options: ProjectInspectLifecycleOptions,
): Promise<LifecycleDiagnostic> {
  const storage = new StoragePaths({
    configDir: options.configDir,
    dataDir: options.dataDir,
  });
  const projectId = options.projectId;
  const suppliedRoot = options.projectRoot;
  const effectiveRoot = suppliedRoot ?? process.cwd();
  const usedCurrentWorkingDirectory = suppliedRoot == null;
  const witnesses: Record<string, LifecycleWitness> = {};

  witnesses.registry = await inspectRegistryWitness(projectId, options.configDir, options.dataDir);
  witnesses.requestedProjectRoot = await inspectRequestedRootWitness(suppliedRoot);
  witnesses.resolvedProjectRoot = await inspectResolvedRootWitness(effectiveRoot, witnesses.requestedProjectRoot, usedCurrentWorkingDirectory);
  witnesses.canonicalProjectRoot = await inspectCanonicalRootWitness(effectiveRoot, witnesses.resolvedProjectRoot);
  witnesses.marker = await inspectMarkerWitness(projectId, witnesses.canonicalProjectRoot);
  witnesses.managedProjectDirectory = await inspectPathWitness({
    id: 'managedProjectDirectory',
    targetPath: storage.projectDataDir(projectId),
    identifier: projectId,
    expectedKind: 'directory',
    presentSummary: 'managed project directory observed',
    absentSummary: 'managed project directory not observed',
    unavailableSummary: 'managed project directory could not be inspected safely',
    support: [],
  });
  witnesses.managedGitStore = await inspectManagedChildWitness({
    id: 'managedGitStore',
    projectId,
    targetPath: storage.projectRepoPath(projectId),
    expectedKind: 'directory',
    presentSummary: 'managed git store observed',
    absentSummary: 'managed git store not observed',
    unavailableSummary: 'managed git store could not be inspected',
    blockedSummary: 'managed git store could not be inspected because the managed project directory was unavailable',
    parent: witnesses.managedProjectDirectory,
  });
  witnesses.eventsDatabase = await inspectManagedChildWitness({
    id: 'eventsDatabase',
    projectId,
    targetPath: storage.projectEventsPath(projectId),
    expectedKind: 'file',
    presentSummary: 'events database observed',
    absentSummary: 'events database not observed',
    unavailableSummary: 'events database could not be inspected',
    blockedSummary: 'events database could not be inspected because the managed project directory was unavailable',
    parent: witnesses.managedProjectDirectory,
  });
  witnesses.searchDatabase = await inspectManagedChildWitness({
    id: 'searchDatabase',
    projectId,
    targetPath: storage.projectSearchPath(projectId),
    expectedKind: 'file',
    presentSummary: 'search database observed',
    absentSummary: 'search database not observed',
    unavailableSummary: 'search database could not be inspected',
    blockedSummary: 'search database could not be inspected because the managed project directory was unavailable',
    parent: witnesses.managedProjectDirectory,
  });
  witnesses.gitContext = await inspectGitContextWitness(effectiveRoot, witnesses.canonicalProjectRoot);
  witnesses.daemonRuntimeArtifact = await inspectDaemonRuntimeWitness(storage.runtimeDir());
  witnesses.rootLedger = await inspectManagedChildWitness({
    id: 'rootLedger',
    projectId,
    targetPath: storage.projectEventsPath(projectId),
    expectedKind: 'file',
    presentSummary: 'root ledger storage observed',
    absentSummary: 'root ledger storage not observed',
    unavailableSummary: 'root ledger could not be inspected',
    blockedSummary: 'root ledger could not be inspected because the managed project directory was unavailable',
    parent: witnesses.managedProjectDirectory,
  });
  witnesses.recoveryEvidence = await inspectManagedChildWitness({
    id: 'recoveryEvidence',
    projectId,
    targetPath: storage.projectEventsPath(projectId),
    expectedKind: 'file',
    presentSummary: 'recovery evidence storage observed',
    absentSummary: 'recovery evidence storage not observed',
    unavailableSummary: 'recovery evidence could not be inspected',
    blockedSummary: 'recovery evidence could not be inspected because the managed project directory was unavailable',
    parent: witnesses.managedProjectDirectory,
  });

  for (const id of MANDATORY_WITNESS_IDS) {
    if (!witnesses[id]) {
      throw new Error(`Lifecycle diagnostic witness missing: ${id}`);
    }
  }

  const { primaryStatus, primaryStatusWitnesses, findings } = deriveLifecycleStatus(projectId, witnesses);

  return {
    command: 'project.inspect-lifecycle',
    schemaVersion: 1,
    projectId,
    requestedProjectRoot: suppliedRoot ?? null,
    usedCurrentWorkingDirectory,
    primaryStatus,
    primaryStatusWitnesses,
    witnesses,
    findings,
    diagnosticOnly: {
      readOnly: true,
      operationalEligibilityEstablished: false,
      unsupportedImplications: [
        'safeForWrites',
        'managedWriteEligible',
        'exportEligible',
        'mcpEligible',
        'daemonReady',
        'initializationRecommended',
        'repairRecommended',
        'authoritativeMutationRoot',
      ],
    },
    exitCode: 0,
  };
}

async function inspectRegistryWitness(
  projectId: string,
  configDir?: string,
  dataDir?: string,
): Promise<LifecycleWitness> {
  const storage = new StoragePaths({ configDir, dataDir });

  try {
    const registry = await Registry.load(configDir, dataDir);
    const entry = registry.getProject(projectId);

    if (!entry) {
      return witness({
        id: 'registry',
        rawObservation: 'absent',
        path: storage.registryPath(),
        identifier: projectId,
        value: null,
        summary: 'registry entry not observed for requested project id',
      });
    }

    return witness({
      id: 'registry',
      rawObservation: 'present',
      path: storage.registryPath(),
      identifier: projectId,
      value: {
        projectId: entry.projectId,
        projectRoot: entry.projectRoot,
      },
      summary: 'registry entry observed for requested project id',
    });
  } catch {
    return witness({
      id: 'registry',
      rawObservation: 'unavailable_or_unreadable',
      path: storage.registryPath(),
      identifier: projectId,
      value: null,
      summary: 'registry could not be inspected safely',
      errorCategory: 'malformed',
    });
  }
}

async function inspectRequestedRootWitness(projectRoot: string | undefined): Promise<LifecycleWitness> {
  if (projectRoot == null) {
    return witness({
      id: 'requestedProjectRoot',
      rawObservation: 'not_applicable',
      path: null,
      value: null,
      summary: 'project root was omitted; current working directory fallback applies',
    });
  }

  const resolved = path.resolve(projectRoot);

  try {
    const stat = await fs.promises.stat(resolved);
    return witness({
      id: 'requestedProjectRoot',
      rawObservation: 'present',
      path: resolved,
      value: {
        inputKind: 'supplied',
        exists: true,
        isDirectory: stat.isDirectory(),
      },
      summary: stat.isDirectory()
        ? 'supplied project root exists and is a directory'
        : 'supplied project root exists but is not a directory',
      errorCategory: stat.isDirectory() ? null : 'unsupported',
    });
  } catch (error) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return witness({
        id: 'requestedProjectRoot',
        rawObservation: 'absent',
        path: resolved,
        value: {
          inputKind: 'supplied',
          exists: false,
          isDirectory: false,
        },
        summary: 'supplied project root was directly absent',
      });
    }

    return witness({
      id: 'requestedProjectRoot',
      rawObservation: 'unavailable_or_unreadable',
      path: resolved,
      value: null,
      summary: 'supplied project root could not be inspected safely',
      errorCategory: categoryFromNodeError(error),
    });
  }
}

async function inspectResolvedRootWitness(
  effectiveRoot: string,
  requestedRoot: LifecycleWitness,
  usedCurrentWorkingDirectory: boolean,
): Promise<LifecycleWitness> {
  if (
    requestedRoot.rawObservation === 'absent' ||
    (
      requestedRoot.rawObservation === 'present' &&
      requestedRoot.errorCategory === 'unsupported'
    )
  ) {
    return witness({
      id: 'resolvedProjectRoot',
      rawObservation: 'not_applicable',
      path: null,
      value: null,
      summary: 'no filesystem project root was available to resolve',
      supportingWitnesses: ['requestedProjectRoot'],
    });
  }

  if (requestedRoot.rawObservation === 'unavailable_or_unreadable') {
    return blockedWitness({
      id: 'resolvedProjectRoot',
      targetPath: path.resolve(effectiveRoot),
      summary: 'project root could not be resolved because requested root evidence was unavailable',
      dependency: 'requestedProjectRoot',
      category: requestedRoot.errorCategory ?? 'unexpected',
    });
  }

  const resolved = path.resolve(effectiveRoot);

  try {
    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) {
      return witness({
        id: 'resolvedProjectRoot',
        rawObservation: 'not_applicable',
        path: null,
        value: null,
        summary: 'resolved path cannot serve as a project root',
        supportingWitnesses: ['requestedProjectRoot'],
      });
    }

    return witness({
      id: 'resolvedProjectRoot',
      rawObservation: 'present',
      path: resolved,
      value: {
        source: usedCurrentWorkingDirectory ? 'currentWorkingDirectory' : 'supplied',
      },
      summary: usedCurrentWorkingDirectory
        ? 'current working directory was resolved for inspection'
        : 'supplied project root was resolved for inspection',
      supportingWitnesses: ['requestedProjectRoot'],
    });
  } catch (error) {
    return witness({
      id: 'resolvedProjectRoot',
      rawObservation: 'unavailable_or_unreadable',
      path: resolved,
      value: null,
      summary: 'project root could not be resolved safely',
      errorCategory: categoryFromNodeError(error),
      supportingWitnesses: ['requestedProjectRoot'],
    });
  }
}

async function inspectCanonicalRootWitness(
  effectiveRoot: string,
  resolvedRoot: LifecycleWitness,
): Promise<LifecycleWitness> {
  if (resolvedRoot.rawObservation === 'not_applicable') {
    return witness({
      id: 'canonicalProjectRoot',
      rawObservation: 'not_applicable',
      path: null,
      value: null,
      summary: 'no resolved project root was available to canonicalize',
      supportingWitnesses: ['resolvedProjectRoot'],
    });
  }

  if (resolvedRoot.rawObservation === 'unavailable_or_unreadable') {
    return blockedWitness({
      id: 'canonicalProjectRoot',
      targetPath: resolvedRoot.path ?? path.resolve(effectiveRoot),
      summary: 'project root could not be canonicalized because resolved root evidence was unavailable',
      dependency: 'resolvedProjectRoot',
      category: resolvedRoot.errorCategory ?? 'unexpected',
    });
  }

  try {
    const real = await fs.promises.realpath(path.resolve(effectiveRoot));
    return witness({
      id: 'canonicalProjectRoot',
      rawObservation: 'present',
      path: real,
      value: {
        canonicalized: true,
      },
      summary: 'project root was canonicalized for inspection',
      supportingWitnesses: ['resolvedProjectRoot'],
    });
  } catch (error) {
    return witness({
      id: 'canonicalProjectRoot',
      rawObservation: 'unavailable_or_unreadable',
      path: path.resolve(effectiveRoot),
      value: null,
      summary: 'project root could not be canonicalized safely',
      errorCategory: categoryFromNodeError(error),
      supportingWitnesses: ['resolvedProjectRoot'],
    });
  }
}

async function inspectMarkerWitness(
  projectId: string,
  canonicalRoot: LifecycleWitness,
): Promise<LifecycleWitness> {
  if (canonicalRoot.rawObservation === 'not_applicable') {
    return witness({
      id: 'marker',
      rawObservation: 'not_applicable',
      path: null,
      identifier: null,
      value: null,
      summary: 'project marker does not apply because no canonical project root is available',
      supportingWitnesses: ['canonicalProjectRoot'],
    });
  }

  if (canonicalRoot.rawObservation === 'unavailable_or_unreadable') {
    return blockedWitness({
      id: 'marker',
      targetPath: null,
      summary: 'project marker could not be inspected because canonical project root evidence was unavailable',
      dependency: 'canonicalProjectRoot',
      category: canonicalRoot.errorCategory ?? 'unexpected',
    });
  }

  const markerPath = path.join(canonicalRoot.path!, '.xurgo-atlas', 'project.json');

  try {
    const raw = await fs.promises.readFile(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.projectId !== 'string' || parsed.projectId.trim() === '') {
      return witness({
        id: 'marker',
        rawObservation: 'unavailable_or_unreadable',
        path: markerPath,
        identifier: null,
        value: null,
        summary: 'project marker could not be interpreted safely',
        errorCategory: 'malformed',
        supportingWitnesses: ['canonicalProjectRoot'],
      });
    }

    return witness({
      id: 'marker',
      rawObservation: 'present',
      interpretation: parsed.projectId === projectId ? 'direct' : 'direct',
      path: markerPath,
      identifier: parsed.projectId,
      value: {
        schemaVersion: parsed.schemaVersion,
        projectId: parsed.projectId,
      },
      summary: parsed.projectId === projectId
        ? 'project marker observed for requested project id'
        : 'marker project id differs from requested project id',
      supportingWitnesses: ['canonicalProjectRoot'],
    });
  } catch (error) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return witness({
        id: 'marker',
        rawObservation: 'absent',
        path: markerPath,
        identifier: null,
        value: null,
        summary: 'project marker not observed at canonical project root',
        supportingWitnesses: ['canonicalProjectRoot'],
      });
    }

    return witness({
      id: 'marker',
      rawObservation: 'unavailable_or_unreadable',
      path: markerPath,
      identifier: null,
      value: null,
      summary: 'project marker could not be inspected safely',
      errorCategory: categoryFromNodeError(error),
      supportingWitnesses: ['canonicalProjectRoot'],
    });
  }
}

async function inspectPathWitness(args: {
  id: string;
  targetPath: string;
  identifier?: string | null;
  expectedKind: 'file' | 'directory';
  presentSummary: string;
  absentSummary: string;
  unavailableSummary: string;
  support: string[];
}): Promise<LifecycleWitness> {
  try {
    const stat = await fs.promises.stat(args.targetPath);
    const kindMatches = args.expectedKind === 'directory' ? stat.isDirectory() : stat.isFile();

    return witness({
      id: args.id,
      rawObservation: kindMatches ? 'present' : 'unavailable_or_unreadable',
      path: args.targetPath,
      identifier: args.identifier ?? null,
      value: kindMatches
        ? { kind: args.expectedKind }
        : null,
      summary: kindMatches ? args.presentSummary : args.unavailableSummary,
      errorCategory: kindMatches ? null : 'unsupported',
      supportingWitnesses: args.support,
    });
  } catch (error) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return witness({
        id: args.id,
        rawObservation: 'absent',
        path: args.targetPath,
        identifier: args.identifier ?? null,
        value: null,
        summary: args.absentSummary,
        supportingWitnesses: args.support,
      });
    }

    return witness({
      id: args.id,
      rawObservation: 'unavailable_or_unreadable',
      path: args.targetPath,
      identifier: args.identifier ?? null,
      value: null,
      summary: args.unavailableSummary,
      errorCategory: categoryFromNodeError(error),
      supportingWitnesses: args.support,
    });
  }
}

async function inspectManagedChildWitness(args: {
  id: string;
  projectId: string;
  targetPath: string;
  expectedKind: 'file' | 'directory';
  presentSummary: string;
  absentSummary: string;
  unavailableSummary: string;
  blockedSummary: string;
  parent: LifecycleWitness;
}): Promise<LifecycleWitness> {
  if (args.parent.rawObservation === 'unavailable_or_unreadable') {
    return blockedWitness({
      id: args.id,
      targetPath: args.targetPath,
      identifier: args.projectId,
      summary: args.blockedSummary,
      dependency: 'managedProjectDirectory',
      category: args.parent.errorCategory ?? 'unexpected',
    });
  }

  if (args.parent.rawObservation === 'not_applicable') {
    return witness({
      id: args.id,
      rawObservation: 'not_applicable',
      path: args.targetPath,
      identifier: args.projectId,
      value: null,
      summary: `${args.id} does not apply because managed project directory evidence does not apply`,
      supportingWitnesses: ['managedProjectDirectory'],
    });
  }

  return inspectPathWitness({
    id: args.id,
    targetPath: args.targetPath,
    identifier: args.projectId,
    expectedKind: args.expectedKind,
    presentSummary: args.presentSummary,
    absentSummary: args.absentSummary,
    unavailableSummary: args.unavailableSummary,
    support: ['managedProjectDirectory'],
  });
}

async function inspectGitContextWitness(
  effectiveRoot: string,
  canonicalRoot: LifecycleWitness,
): Promise<LifecycleWitness> {
  if (canonicalRoot.rawObservation === 'not_applicable') {
    return witness({
      id: 'gitContext',
      rawObservation: 'not_applicable',
      path: null,
      value: null,
      summary: 'git context does not apply because no canonical project root is available',
      supportingWitnesses: ['canonicalProjectRoot'],
    });
  }

  if (canonicalRoot.rawObservation === 'unavailable_or_unreadable') {
    return blockedWitness({
      id: 'gitContext',
      targetPath: canonicalRoot.path ?? path.resolve(effectiveRoot),
      summary: 'git context could not be inspected because canonical project root evidence was unavailable',
      dependency: 'canonicalProjectRoot',
      category: canonicalRoot.errorCategory ?? 'unexpected',
    });
  }

  const git = await inspectGitIdentity(canonicalRoot.path ?? effectiveRoot);
  return witness({
    id: 'gitContext',
    rawObservation: git.insideWorkTree ? 'present' : 'absent',
    path: canonicalRoot.path,
    identifier: git.branch,
    value: git,
    summary: git.insideWorkTree
      ? 'git context observed for project root'
      : 'git worktree context not observed for project root',
    supportingWitnesses: ['canonicalProjectRoot'],
  });
}

async function inspectDaemonRuntimeWitness(runtimeDir: string): Promise<LifecycleWitness> {
  const pidPath = path.join(runtimeDir, 'xurgo-atlas-daemon.json');
  const logPath = path.join(runtimeDir, 'xurgo-atlas-daemon.log');
  const [pidFileFound, logFileFound] = await Promise.all([
    fileExists(pidPath),
    fileExists(logPath),
  ]);

  return witness({
    id: 'daemonRuntimeArtifact',
    rawObservation: pidFileFound || logFileFound ? 'present' : 'absent',
    path: runtimeDir,
    value: {
      pidFileFound,
      logFileFound,
    },
    summary: pidFileFound || logFileFound
      ? 'daemon runtime artifacts observed'
      : 'daemon runtime artifacts not observed',
  });
}

function deriveLifecycleStatus(
  projectId: string,
  witnesses: Record<string, LifecycleWitness>,
): {
  primaryStatus: PrimaryStatus;
  primaryStatusWitnesses: string[];
  findings: LifecycleFinding[];
} {
  const findings: LifecycleFinding[] = [];
  const bindingConflictWitnesses = getBindingConflictWitnesses(projectId, witnesses);
  const unavailableWitnesses = Object.values(witnesses)
    .filter((item) => item.rawObservation === 'unavailable_or_unreadable')
    .map((item) => item.id);

  if (bindingConflictWitnesses.length >= 2) {
    findings.push(finding({
      code: 'binding_conflict',
      severity: 'conflict',
      message: 'Available binding witnesses disagree; unavailable managed-state evidence did not override the observed conflict.',
      witnesses: bindingConflictWitnesses,
      summary: 'available binding witnesses identify different project bindings for the inspected root',
    }));

    if (hasManagedStateUnavailable(witnesses)) {
      findings.push(managedStateUnavailableFinding(witnesses));
    }

    return {
      primaryStatus: 'binding_conflict_observed',
      primaryStatusWitnesses: bindingConflictWitnesses,
      findings,
    };
  }

  const rootUnavailableWitness = [
    'requestedProjectRoot',
    'resolvedProjectRoot',
    'canonicalProjectRoot',
  ].find((id) => {
    const item = witnesses[id];
    return item.rawObservation === 'absent' ||
      item.rawObservation === 'unavailable_or_unreadable' ||
      (item.rawObservation === 'present' && item.errorCategory === 'unsupported');
  });

  if (rootUnavailableWitness) {
    findings.push(finding({
      code: 'root_unavailable',
      severity: 'unavailable',
      message: 'Project root evidence was unavailable for lifecycle inspection.',
      witnesses: [rootUnavailableWitness],
      summary: 'project root evidence could not establish an inspectable root',
    }));

    return {
      primaryStatus: 'root_unavailable',
      primaryStatusWitnesses: [rootUnavailableWitness],
      findings,
    };
  }

  if (unavailableWitnesses.length > 0) {
    findings.push(hasManagedStateUnavailable(witnesses)
      ? managedStateUnavailableFinding(witnesses)
      : finding({
          code: 'evidence_unavailable',
          severity: 'unavailable',
          message: 'Required lifecycle evidence could not be inspected safely.',
          witnesses: unavailableWitnesses,
          summary: 'one or more required witnesses were unavailable or unreadable',
        }));

    return {
      primaryStatus: 'evidence_unavailable',
      primaryStatusWitnesses: unavailableWitnesses,
      findings,
    };
  }

  const managedPresent = [
    witnesses.managedProjectDirectory,
    witnesses.managedGitStore,
    witnesses.eventsDatabase,
    witnesses.searchDatabase,
  ].some((item) => item.rawObservation === 'present');
  const registryPresent = witnesses.registry.rawObservation === 'present';
  const markerPresent = witnesses.marker.rawObservation === 'present';
  const managedComplete = [
    witnesses.managedProjectDirectory,
    witnesses.managedGitStore,
    witnesses.eventsDatabase,
  ].every((item) => item.rawObservation === 'present');

  if (registryPresent && markerPresent && managedComplete) {
    return {
      primaryStatus: 'aligned_local_managed_state_observed',
      primaryStatusWitnesses: ['registry', 'marker', 'canonicalProjectRoot', 'managedProjectDirectory', 'managedGitStore', 'eventsDatabase'],
      findings,
    };
  }

  if (managedPresent && !(registryPresent && markerPresent)) {
    return {
      primaryStatus: 'managed_state_without_complete_binding',
      primaryStatusWitnesses: [
        'managedProjectDirectory',
        'managedGitStore',
        'eventsDatabase',
        'registry',
        'marker',
      ],
      findings,
    };
  }

  if (registryPresent) {
    return {
      primaryStatus: 'registered_binding_observed',
      primaryStatusWitnesses: ['registry'],
      findings,
    };
  }

  return {
    primaryStatus: 'no_local_binding_observed',
    primaryStatusWitnesses: ['registry', 'marker', 'managedProjectDirectory'],
    findings,
  };
}

function getBindingConflictWitnesses(
  projectId: string,
  witnesses: Record<string, LifecycleWitness>,
): string[] {
  const ids: string[] = [];
  const registryRoot = getStringValue(witnesses.registry.value, 'projectRoot');
  const markerProjectId = witnesses.marker.identifier;
  const canonicalRoot = witnesses.canonicalProjectRoot.path;

  if (
    witnesses.registry.rawObservation === 'present' &&
    witnesses.canonicalProjectRoot.rawObservation === 'present' &&
    registryRoot &&
    canonicalRoot &&
    normalizeComparablePath(registryRoot) !== normalizeComparablePath(canonicalRoot)
  ) {
    ids.push('registry', 'canonicalProjectRoot');
  }

  if (
    witnesses.marker.rawObservation === 'present' &&
    markerProjectId &&
    markerProjectId !== projectId
  ) {
    ids.push('marker', 'canonicalProjectRoot');
  }

  return [...new Set(ids)];
}

function managedStateUnavailableFinding(witnesses: Record<string, LifecycleWitness>): LifecycleFinding {
  const ids = [
    'managedProjectDirectory',
    'managedGitStore',
    'eventsDatabase',
    'searchDatabase',
    'rootLedger',
    'recoveryEvidence',
  ].filter((id) => witnesses[id]?.rawObservation === 'unavailable_or_unreadable');

  return finding({
    code: 'managed_state_unavailable',
    severity: 'unavailable',
    message: 'Managed-state dependent witnesses could not be inspected because the managed project directory was unavailable.',
    witnesses: ids,
    summary: 'managed project directory and dependent managed-state witnesses were unavailable or unreadable',
  });
}

function hasManagedStateUnavailable(witnesses: Record<string, LifecycleWitness>): boolean {
  return [
    'managedProjectDirectory',
    'managedGitStore',
    'eventsDatabase',
    'searchDatabase',
    'rootLedger',
    'recoveryEvidence',
  ].some((id) => witnesses[id]?.rawObservation === 'unavailable_or_unreadable');
}

function printLifecycleDiagnostic(diagnostic: LifecycleDiagnostic): void {
  console.log('Xurgo Atlas project lifecycle inspection');
  console.log(`Project: ${diagnostic.projectId}`);
  console.log(`Primary status: ${diagnostic.primaryStatus}`);
  console.log('Diagnostic only: read-only; no operational eligibility established.');
  console.log('Witnesses:');
  for (const id of MANDATORY_WITNESS_IDS) {
    const item = diagnostic.witnesses[id];
    console.log(`  ${id}: ${item.rawObservation} (${item.interpretation})`);
  }
}

function witness(args: {
  id: string;
  rawObservation: RawObservation;
  interpretation?: Interpretation;
  path?: string | null;
  identifier?: string | null;
  value?: unknown;
  summary: string;
  errorCategory?: ErrorCategory | null;
  supportingWitnesses?: string[];
}): LifecycleWitness {
  return {
    id: args.id,
    rawObservation: args.rawObservation,
    interpretation: args.interpretation ?? 'direct',
    path: args.path ?? null,
    identifier: args.identifier ?? null,
    value: args.value ?? null,
    summary: args.summary,
    errorCategory: args.errorCategory ?? null,
    supportingWitnesses: args.supportingWitnesses ?? [],
  };
}

function blockedWitness(args: {
  id: string;
  targetPath: string | null;
  identifier?: string | null;
  summary: string;
  dependency: string;
  category: ErrorCategory;
}): LifecycleWitness {
  return witness({
    id: args.id,
    rawObservation: 'unavailable_or_unreadable',
    path: args.targetPath,
    identifier: args.identifier ?? null,
    value: null,
    summary: args.summary,
    errorCategory: args.category,
    supportingWitnesses: [args.dependency],
  });
}

function finding(args: {
  code: string;
  severity: LifecycleFinding['severity'];
  message: string;
  witnesses: string[];
  summary: string;
}): LifecycleFinding {
  return {
    code: args.code,
    severity: args.severity,
    message: args.message,
    supportingWitnesses: args.witnesses,
    observedFact: {
      summary: args.summary,
      witnesses: args.witnesses,
    },
    boundedInference: null,
    recommendation: null,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function categoryFromNodeError(error: unknown): ErrorCategory {
  const code = getNodeErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM') {
    return 'inaccessible';
  }
  if (code === 'ELOOP') {
    return 'unresolved';
  }
  if (code === 'ENOTDIR') {
    return 'unsupported';
  }
  if (code === 'ENOENT') {
    return 'unresolved';
  }
  return 'unreadable';
}

function getNodeErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringValue(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : null;
}

function normalizeComparablePath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
