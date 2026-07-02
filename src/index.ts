#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVersionLine } from './version.js';

export function getUsageText(): string {
  return `
xurgo-atlas — Xurgo Atlas, safe, versioned, auditable documentation management for AI-assisted projects

USAGE:
  xurgo-atlas <command> [options]

COMMANDS:
  init       Initialize a Xurgo Atlas project
    --project-root <path>   Path to the project root (default: .)
    --project-id <id>       Unique identifier for the project
    --config-dir <path>     Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>       Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)
    --template <name>       Documentation template (default: "default"); use --templates to list
    -t <name>               Short form of --template
    --templates             List available templates without initializing

  server     Start the MCP server
    --project-root <path>   Path to the project root (default: .)
    --project-id <id>       Project identifier (optional, defaults to dir name)
    --config-dir <path>     Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>       Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)

  daemon     Manage the daemon (HTTP MCP server)
    start                   Start the daemon in the background
    stop                    Stop the background daemon
    status                  Show background daemon status
    --host <host>           Host to bind to (default: 127.0.0.1)
    --port <port>           Port to listen on (default: 3737)
    --config-dir <path>     Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>       Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)
    --project-id <id>       Optional: resolve a specific project on startup
    --project-root <path>   Optional: project root or nested path used for auto-resolution
    Without a subcommand, starts the foreground daemon exactly as before.

  status     Show the current setup status (read-only)
    --config-dir <path>     Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>       Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)

  doctor     Show a bounded diagnostic snapshot (read-only)
    --json                  Print output as machine-readable JSON only
    --config-dir <path>     Config directory (default: ~/.config/xurgo-atlas; overrides XURGO_ATLAS_CONFIG_DIR; legacy roots auto-discovered)
    --data-dir <path>       Data directory (default: ~/.local/share/xurgo-atlas; overrides XURGO_ATLAS_DATA_DIR; legacy roots auto-discovered)

  storage    Inspect Atlas-vs-legacy managed storage (read-only)
    inspect                 Show selected roots, candidates, registry state, and runtime artifacts
    migrate --dry-run       Plan a future legacy-to-Atlas migration without making changes
    migrate --apply         Copy legacy managed storage into empty Atlas roots
    --config-dir <path>     Inspect with an explicit config directory override
    --data-dir <path>       Inspect with an explicit data directory override

  project    Manage registered projects
    add --project-id <id> --project-root <path>
    adopt --project-root <path> [--project-id <id>]
    remove --project-id <id>
    list
    show --project-id <id>
    default --project-id <id>
    inspect-lifecycle --project-id <id> [--project-root <path>] [--json]
    propose-registration [--project-root <path>] [--project-id <id>] [--json]

  mcp-config Print MCP client connection guidance (read-only)
    --host <host>           MCP server host (default: 127.0.0.1)
    --port <port>           MCP server port (default: 3737)
    --json                  Print output as machine-readable JSON only

  list       List tracked documentation files
    --project-root <path>   Path to the project root (default: .)

  history <path>
             View the history of a documentation file
    --project-root <path>   Path to the project root (default: .)

  export     Export documentation from a branch to the project root
    --branch <name>         Branch to export (default: main)
    --target-dir <path>     Target directory (default: project root)
    --project-root <path>   Path to the project root (default: .)

EXAMPLES:
  xurgo-atlas init --project-root . --project-id my-project
  xurgo-atlas init --template saas --project-id clientpulse
  xurgo-atlas init --templates
  xurgo-atlas server --project-root .
  xurgo-atlas daemon
  xurgo-atlas daemon start
  xurgo-atlas daemon status
  xurgo-atlas status
  xurgo-atlas doctor
  xurgo-atlas doctor --json
  xurgo-atlas storage inspect
  xurgo-atlas storage migrate --dry-run
  xurgo-atlas storage migrate --apply
  xurgo-atlas project add --project-id my-app --project-root /path/to/my-app
  xurgo-atlas project adopt --project-root /path/to/my-app --project-id my-app
  xurgo-atlas project list
  xurgo-atlas project propose-registration --project-root . --project-id my-app --json
  xurgo-atlas mcp-config
  xurgo-atlas mcp-config --json
  xurgo-atlas list
  xurgo-atlas history docs/README.md
  xurgo-atlas export --branch main
`;
}

function printUsage(): void {
  console.log(getUsageText());
}

function printVersion(): void {
  console.log(getVersionLine());
}

function hasHelpFlag(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

function parseArgv(argv: string[]): Record<string, string | string[]> {
  const args: Record<string, string | string[]> = { _: [] };
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--project-root' && i + 1 < argv.length) {
      args['project-root'] = argv[i + 1];
      i += 2;
    } else if (arg === '--project-id' && i + 1 < argv.length) {
      args['project-id'] = argv[i + 1];
      i += 2;
    } else if (arg === '--branch' && i + 1 < argv.length) {
      args['branch'] = argv[i + 1];
      i += 2;
    } else if (arg === '--target-dir' && i + 1 < argv.length) {
      args['target-dir'] = argv[i + 1];
      i += 2;
    } else if (arg === '--host' && i + 1 < argv.length) {
      args['host'] = argv[i + 1];
      i += 2;
    } else if (arg === '--port' && i + 1 < argv.length) {
      args['port'] = argv[i + 1];
      i += 2;
    } else if (arg === '--config-dir' && i + 1 < argv.length) {
      args['config-dir'] = argv[i + 1];
      i += 2;
    } else if (arg === '--data-dir' && i + 1 < argv.length) {
      args['data-dir'] = argv[i + 1];
      i += 2;
    } else if (arg === '--dry-run') {
      args['dry-run'] = 'true';
      i++;
    } else if (arg === '--apply') {
      args['apply'] = 'true';
      i++;
    } else if (arg === '--pid-file' && i + 1 < argv.length) {
      args['pid-file'] = argv[i + 1];
      i += 2;
    } else if (arg === '--template' && i + 1 < argv.length) {
      args['template'] = argv[i + 1];
      i += 2;
    } else if (arg === '-t' && i + 1 < argv.length) {
      args['template'] = argv[i + 1];
      i += 2;
    } else if (arg === '--templates') {
      args['templates'] = 'true';
      i++;
    } else if (arg === '--json') {
      args['json'] = 'true';
      i++;
    } else if (arg.startsWith('--')) {
      i++;
    } else {
      (args._ as string[]).push(arg);
      i++;
    }
  }

  return args;
}

export async function main(): Promise<void> {
  // Parse the command
  const command = process.argv[2];
  const rawArgs = process.argv.slice(3);

  if (command === '--version' || command === '-v') {
    printVersion();
    process.exit(0);
  }

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  const [
    { initCommand, printInitUsage, printServerUsage, printTemplateList, serverCommand, listCommand, historyCommand, exportCommand },
    { parseProjectArgs, printProjectUsage, projectAddCommand, projectAdoptCommand, projectRemoveCommand, projectListCommand, projectShowCommand, projectDefaultCommand, projectInspectLifecycleCommand, projectProposeRegistrationCommand },
    { daemonCommand, getDaemonUsageText },
    { getStorageMigrationNotImplementedMessage, printStorageUsage, storageInspectCommand, storageMigrateCommand },
    { statusCommand, printStatusUsage },
    { doctorCommand, printDoctorUsage },
    { mcpConfigCommand, printMcpConfigUsage },
    { emitStorageDiagnostics, resolveStorageRoots },
  ] = await Promise.all([
    import('./cli/init.js'),
    import('./cli/project.js'),
    import('./cli/daemon.js'),
    import('./cli/storage.js'),
    import('./cli/status.js'),
    import('./cli/doctor.js'),
    import('./cli/mcp-config.js'),
    import('./core/storage.js'),
  ]);

  const args = parseArgv(rawArgs);
  const positionals = (args._ as string[]) ?? [];
  const projectRoot = (args['project-root'] as string | undefined) || process.cwd();
  const projectId = (args['project-id'] as string | undefined) || '';
  const branch = (args['branch'] as string | undefined) || 'main';
  const targetDir = args['target-dir'] as string | undefined;
  const configDir = args['config-dir'] as string | undefined;
  const dataDir = args['data-dir'] as string | undefined;

  switch (command) {
    case 'init': {
      if (hasHelpFlag(rawArgs)) {
        printInitUsage();
        process.exit(0);
      }
      if (args['templates'] === 'true') {
        printTemplateList();
        process.exit(0);
      }
      emitStorageDiagnostics(resolveStorageRoots({ configDir, dataDir }));
      if (!projectId) {
        console.error('Error: --project-id is required for init');
        process.exit(1);
      }
      const template = args['template'] as string | undefined;
      await initCommand({ projectRoot, projectId, configDir, dataDir, template });
      break;
    }

    case 'server': {
      if (hasHelpFlag(rawArgs)) {
        printServerUsage();
        process.exit(0);
      }
      emitStorageDiagnostics(resolveStorageRoots({ configDir, dataDir }));
      await serverCommand({
        projectRoot,
        projectId: projectId || requireProjectId(projectRoot),
        configDir,
        dataDir,
      });
      break;
    }

    case 'daemon': {
      if (hasHelpFlag(rawArgs)) {
        console.log(getDaemonUsageText());
        process.exit(0);
      }
      emitStorageDiagnostics(resolveStorageRoots({ configDir, dataDir }));
      await daemonCommand({
        action: positionals[0],
        host: (args['host'] as string | undefined) || '127.0.0.1',
        port: parseInt((args['port'] as string | undefined) || '3737', 10),
        configDir,
        dataDir,
        projectId: args['project-id'] as string | undefined,
        projectRoot: args['project-root'] as string | undefined,
        pidFile: args['pid-file'] as string | undefined,
      });
      break;
    }

    case 'project': {
      const { subcommand, kwargs } = parseProjectArgs(process.argv);
      const projectConfigDir = kwargs['config-dir'] || configDir;
      const projectDataDir = kwargs['data-dir'] || dataDir;

      if (!subcommand || subcommand === '--help' || subcommand === '-h') {
        printProjectUsage();
        process.exit(0);
      }

      if (subcommand !== 'inspect-lifecycle' && subcommand !== 'propose-registration') {
        emitStorageDiagnostics(
          resolveStorageRoots({
            configDir: projectConfigDir,
            dataDir: projectDataDir,
          }),
        );
      }

      switch (subcommand) {
        case 'add': {
          const pid = kwargs['project-id'];
          const proot = kwargs['project-root'];
          if (!pid || !proot) {
            console.error('Error: --project-id and --project-root are required for project add');
            process.exit(1);
          }
          await projectAddCommand(
            pid,
            proot,
            projectConfigDir,
            projectDataDir,
          );
          break;
        }
        case 'adopt': {
          await projectAdoptCommand(
            kwargs['project-root'],
            kwargs['project-id'],
            projectConfigDir,
            projectDataDir,
          );
          break;
        }
        case 'remove': {
          const pid = kwargs['project-id'];
          if (!pid) {
            console.error('Error: --project-id is required for project remove');
            process.exit(1);
          }
          await projectRemoveCommand(
            pid,
            projectConfigDir,
            projectDataDir,
          );
          break;
        }
        case 'list': {
          await projectListCommand(
            projectConfigDir,
            projectDataDir,
          );
          break;
        }
        case 'show': {
          const pid = kwargs['project-id'];
          if (!pid) {
            console.error('Error: --project-id is required for project show');
            process.exit(1);
          }
          await projectShowCommand(
            pid,
            projectConfigDir,
            projectDataDir,
          );
          break;
        }
        case 'default': {
          const pid = kwargs['project-id'];
          if (!pid) {
            console.error('Error: --project-id is required for project default');
            process.exit(1);
          }
          await projectDefaultCommand(
            pid,
            projectConfigDir,
            projectDataDir,
          );
          break;
        }
        case 'inspect-lifecycle': {
          const pid = kwargs['project-id'];
          if (!pid) {
            console.error('Error: --project-id is required for project inspect-lifecycle');
            process.exit(1);
          }
          await projectInspectLifecycleCommand({
            projectId: pid,
            projectRoot: kwargs['project-root'],
            configDir: projectConfigDir,
            dataDir: projectDataDir,
            json: kwargs['json'] === 'true',
          });
          break;
        }
        case 'propose-registration': {
          await projectProposeRegistrationCommand({
            projectId: kwargs['project-id'],
            projectRoot: kwargs['project-root'],
            configDir: projectConfigDir,
            dataDir: projectDataDir,
            json: kwargs['json'] === 'true',
            cwd: process.cwd(),
          });
          break;
        }
        default: {
          console.error(`Unknown project subcommand: "${subcommand}"`);
          printProjectUsage();
          process.exit(1);
        }
      }
      break;
    }

    case 'storage': {
      const subcommand = positionals[0];

      if (!subcommand || subcommand === '--help' || subcommand === '-h') {
        printStorageUsage();
        process.exit(0);
      }

      if (subcommand !== 'inspect' && subcommand !== 'migrate') {
        console.error(`Unknown storage subcommand: "${subcommand}"`);
        printStorageUsage();
        process.exit(1);
      }

      // --help on a subcommand must print help and exit 0 without running
      if (hasHelpFlag(rawArgs)) {
        printStorageUsage();
        process.exit(0);
      }

      if (subcommand === 'inspect') {
        await storageInspectCommand({ configDir, dataDir });
        break;
      }

      try {
        await storageMigrateCommand(
          { configDir, dataDir },
          args['dry-run'] === 'true',
          args['apply'] === 'true',
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (
            error.message === getStorageMigrationNotImplementedMessage() ||
            error.name === 'StorageMigrationCommandError'
          )
        ) {
          console.error(error.message);
          process.exit(1);
        }
        throw error;
      }
      break;
    }

    case 'status': {
      if (hasHelpFlag(rawArgs)) {
        printStatusUsage();
        process.exit(0);
      }
      await statusCommand({ configDir, dataDir });
      break;
    }

    case 'doctor': {
      if (hasHelpFlag(rawArgs)) {
        printDoctorUsage();
        process.exit(0);
      }
      await doctorCommand({
        configDir,
        dataDir,
        json: args['json'] === 'true',
      });
      break;
    }

    case 'mcp-config': {
      if (hasHelpFlag(rawArgs)) {
        printMcpConfigUsage();
        process.exit(0);
      }
      await mcpConfigCommand({
        host: args['host'] as string | undefined,
        port: args['port'] ? parseInt(args['port'] as string, 10) : undefined,
        json: rawArgs.includes('--json'),
        projectRoot: args['project-root'] as string | undefined,
        configDir,
        dataDir,
        cwd: process.cwd(),
      });
      break;
    }

    case 'list': {
      emitStorageDiagnostics(resolveStorageRoots({ configDir, dataDir }));
      await listCommand(projectRoot, configDir, dataDir);
      break;
    }

    case 'history': {
      emitStorageDiagnostics(resolveStorageRoots({ configDir, dataDir }));
      const filePath = positionals[0];
      if (!filePath) {
        console.error('Error: path argument is required for history');
        console.log('Usage: xurgo-atlas history <path>');
        process.exit(1);
      }
      await historyCommand(projectRoot, filePath, configDir, dataDir);
      break;
    }

    case 'export': {
      emitStorageDiagnostics(resolveStorageRoots({ configDir, dataDir }));
      await exportCommand(projectRoot, branch, configDir, dataDir, targetDir);
      break;
    }

    default: {
      console.error(`Unknown command: "${command}"`);
      printUsage();
      process.exit(1);
    }
  }
}

function requireProjectId(projectRoot: string): string {
  const parts = projectRoot.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'unnamed-project';
}

const entryPath = fs.realpathSync.native(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1]
  ? fs.realpathSync.native(path.resolve(process.argv[1]))
  : null;

if (invokedPath === entryPath) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
