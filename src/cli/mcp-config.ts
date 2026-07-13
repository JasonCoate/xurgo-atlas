import * as path from 'node:path';
import {
  inspectProjectOperationalState,
  resolveProjectContext,
  ProjectResolutionError,
  type ProjectOperationalState,
} from '../core/project-resolution.js';
import { inspectGitIdentity } from '../core/git-identity.js';
import {
  inspectResolvedRootSafetyContext,
  type RootSafetySummary,
} from '../core/root-safety.js';
import {
  unavailableRootLedgerSummary,
  type RootLedgerSummary,
} from '../core/root-ledger.js';

// ── MCP config guidance (read-only) ──────────────────────────────────────

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3737;
const SERVER_NAME = 'xurgo-atlas';
const DISPLAY_NAME = 'Xurgo Atlas';
const TRANSPORT = 'streamable-http';

export interface McpConfigOptions {
  host?: string;
  port?: number;
  json?: boolean;
  projectRoot?: string;
  configDir?: string;
  dataDir?: string;
  cwd?: string;
}

export function getMcpConfigUsageText(): string {
  return `
Print MCP client connection guidance for Xurgo Atlas.

USAGE:
  xurgo-atlas mcp-config [options]

OPTIONS:
  --host <host>    MCP server host (default: 127.0.0.1)
  --port <port>    MCP server port (default: 3737)
  --json           Print output as machine-readable JSON only

This is a read-only command with respect to project files.
It may refresh Atlas internal root observation metadata when a project is resolved.
It does not start or stop the daemon.
It does not require a project to be initialized.

EXAMPLES:
  xurgo-atlas mcp-config
  xurgo-atlas mcp-config --host 0.0.0.0 --port 3737
  xurgo-atlas mcp-config --json
`;
}

export function printMcpConfigUsage(): void {
  console.log(getMcpConfigUsageText());
}

interface McpProjectContext {
  projectId: string | null;
  projectRoot: string | null;
  projectSource: string | null;
  registeredProjectRoot: string | null;
  cwd: string;
  git: Awaited<ReturnType<typeof inspectGitIdentity>>;
  safety: RootSafetySummary;
  operational: McpOperationalStatus;
  rootLedger: RootLedgerSummary;
}

interface McpOperationalStatus {
  available: boolean;
  blocker: ProjectOperationalState['blocker'] | 'identity-unresolved' | 'marker-invalid' | 'unknown';
  managedProjectDir: string | null;
}

interface McpJsonConfig {
  serverName: string;
  displayName: string;
  transport: string;
  url: string;
  projectId: string | null;
  projectRoot: string | null;
  projectSource: string | null;
  requestedCwd: string;
  registeredProjectRoot: string | null;
  git: Awaited<ReturnType<typeof inspectGitIdentity>>;
  // Authoritative safety snapshot for mutating boundaries.
  safety: RootSafetySummary;
  // Operational eligibility is distinct from a project identity binding. A
  // discovered checkout may be readable but still lack its managed local store.
  operational: McpOperationalStatus;
  // Descriptive root/worktree history for consumers and coordinators; it does
  // not override `safety.safeForWrites`.
  rootLedger: RootLedgerSummary;
  startCommand: {
    command: string;
    args: string[];
  };
  mcpServers: {
    'xurgo-atlas': {
      url: string;
    };
  };
}

async function resolveMcpProjectContext(
  options: McpConfigOptions,
): Promise<McpProjectContext> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const git = await inspectGitIdentity(cwd);

  try {
    const resolved = await resolveProjectContext({
      projectRoot: options.projectRoot,
      configDir: options.configDir,
      dataDir: options.dataDir,
      cwd: options.cwd,
      requireOperationalState: false,
    });
    const operational = await inspectProjectOperationalState(
      resolved.projectRoot,
      resolved.projectId,
      options.configDir,
      options.dataDir,
    );
    const rootContext = await inspectResolvedRootSafetyContext({
      projectId: resolved.projectId,
      projectRoot: resolved.projectRoot,
      configDir: options.configDir,
      dataDir: options.dataDir,
      requestedCwd: cwd,
    });

    return {
      projectId: resolved.projectId,
      projectRoot: resolved.projectRoot,
      projectSource: resolved.source,
      registeredProjectRoot: rootContext.registeredProjectRoot,
      cwd,
      git: rootContext.git,
      safety: applyOperationalSafety(rootContext.safety, operational),
      operational,
      rootLedger: rootContext.rootLedger,
    };
  } catch (error: unknown) {
    if (error instanceof ProjectResolutionError) {
      return {
        projectId: null,
        projectRoot: null,
        projectSource: null,
        registeredProjectRoot: null,
        cwd,
        git,
        safety: {
          safeForWrites: false,
          rootMismatch: false,
          ambiguous: true,
          markerMissing: error.code === 'identity-unresolved',
          markerMismatch: false,
          registeredProjectRootMissing: error.code === 'identity-unresolved',
          registeredProjectRootMismatch: false,
          daemonProjectRootMismatch: false,
          gitMismatch: false,
          gitUnavailable: !git.insideWorkTree,
          warnings: buildUnresolvedSafetyWarnings(error, !git.insideWorkTree),
        },
        operational: unavailableOperationalStatus(error),
        rootLedger: unavailableRootLedgerSummary(),
      };
    }
    throw error;
  }
}

function buildMcpJsonConfig(
  endpoint: string,
  project: McpProjectContext,
): McpJsonConfig {
  return {
    serverName: SERVER_NAME,
    displayName: DISPLAY_NAME,
    transport: TRANSPORT,
    url: endpoint,
    projectId: project.projectId,
    projectRoot: project.projectRoot,
    projectSource: project.projectSource,
    requestedCwd: project.cwd,
    registeredProjectRoot: project.registeredProjectRoot,
    git: project.git,
    safety: project.safety,
    operational: project.operational,
    rootLedger: project.rootLedger,
    startCommand: {
      command: 'xurgo-atlas',
      args: ['daemon', 'start'],
    },
    mcpServers: {
      'xurgo-atlas': {
        url: endpoint,
      },
    },
  };
}

export async function getMcpConfigOutput(options: McpConfigOptions): Promise<string> {
  const host = options.host || DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const endpoint = `http://${host}:${port}/mcp`;
  const project = await resolveMcpProjectContext(options);
  const jsonConfig = buildMcpJsonConfig(endpoint, project);

  if (options.json) {
    return JSON.stringify(jsonConfig, null, 2);
  }

  return [
    `Xurgo Atlas MCP client configuration`,
    '',
    `Endpoint:`,
      `  ${endpoint}`,
    '',
    `Project binding:`,
    `  cwd: ${project.cwd}`,
    `  project: ${project.projectId ?? 'unresolved'}${project.projectRoot ? ` -> ${project.projectRoot}` : ''}`,
    `  source: ${project.projectSource ?? 'unresolved'}`,
    `  registered root: ${project.registeredProjectRoot ?? 'unresolved'}`,
    `  git worktree: ${project.git.worktreeRoot ?? 'unavailable'}`,
    `  git common dir: ${project.git.commonDir ?? 'unavailable'}`,
    `  git branch: ${project.git.branch ?? 'detached or unavailable'}`,
    `  git HEAD: ${project.git.head ?? 'unavailable'}`,
    `  safe for writes: ${project.safety.safeForWrites ? 'yes' : 'no'}`,
    `  operational state: ${project.operational.available ? 'available' : project.operational.blocker}`,
    '',
    `Generic MCP client JSON:`,
    JSON.stringify(jsonConfig, null, 2),
    '',
    `Notes:`,
    `- Start the daemon first with: xurgo-atlas daemon start`,
    `- For machine-readable setup, prefer: xurgo-atlas mcp-config --json`,
    `- This command is read-only for project files and does not write client config files.`,
  ].join('\n');
}

export async function mcpConfigCommand(options: McpConfigOptions = {}): Promise<void> {
  console.log(await getMcpConfigOutput(options));
}

function applyOperationalSafety(
  safety: RootSafetySummary,
  operational: ProjectOperationalState,
): RootSafetySummary {
  if (operational.available) {
    return safety;
  }

  const warning = operational.blocker === 'managed-store-missing'
    ? `managed project data directory unavailable: ${operational.managedProjectDir}`
    : 'project documents or policy are unavailable for managed operations';

  return {
    ...safety,
    // Identity remains authoritative, but no write-capable client may treat an
    // unhydrated managed store as operationally safe.
    safeForWrites: false,
    warnings: [...safety.warnings, warning],
  };
}

function unavailableOperationalStatus(error: ProjectResolutionError): McpOperationalStatus {
  switch (error.code) {
    case 'identity-unresolved':
      return { available: false, blocker: 'identity-unresolved', managedProjectDir: null };
    case 'marker-invalid':
      return { available: false, blocker: 'marker-invalid', managedProjectDir: null };
    default:
      return { available: false, blocker: 'unknown', managedProjectDir: null };
  }
}

function buildUnresolvedSafetyWarnings(
  error: ProjectResolutionError,
  gitUnavailable: boolean,
): string[] {
  const warnings: string[] = [];
  if (error.code === 'identity-unresolved') {
    warnings.push('missing local project marker');
    warnings.push('registered project root missing');
  } else {
    warnings.push(`project discovery failed: ${error.message}`);
  }
  if (gitUnavailable) {
    warnings.push('git identity unavailable');
  }
  return warnings;
}
