import * as fs from 'node:fs';
import * as path from 'node:path';
import { Registry } from './registry.js';
import { StoragePaths } from './storage.js';

export const PROJECT_MARKER_DIR = '.xurgo-atlas';
export const PROJECT_MARKER_FILE = 'project.json';

export type ProjectResolutionSource =
  | 'explicit'
  | 'cwd-marker'
  | 'ancestor-marker'
  | 'registry-exact-root'
  | 'registry-ancestor-root'
  | 'registry-default';

export interface ProjectResolution {
  projectId: string;
  projectRoot: string;
  source: ProjectResolutionSource;
  markerPath?: string;
}

export interface ResolveProjectOptions {
  projectId?: string;
  projectRoot?: string;
  configDir?: string;
  dataDir?: string;
  cwd?: string;
  allowRegistryDefault?: boolean;
  /**
   * Discovery surfaces can identify an adopted checkout before its local
   * managed store exists. Operational callers keep the default fail-closed
   * validation so they cannot serve or write an unhydrated project.
   */
  requireOperationalState?: boolean;
}

export interface ProjectMarker {
  schemaVersion: number;
  projectId: string;
}

export class ProjectResolutionError extends Error {
  constructor(
    message: string,
    public readonly code: ProjectResolutionErrorCode = 'unknown',
  ) {
    super(message);
    this.name = 'ProjectResolutionError';
  }
}

export type ProjectResolutionErrorCode =
  | 'identity-unresolved'
  | 'identity-conflict'
  | 'project-root-missing'
  | 'project-structure-missing'
  | 'managed-store-missing'
  | 'marker-invalid'
  | 'unknown';

export type ProjectOperationalState =
  | {
      available: true;
      blocker: null;
      managedProjectDir: string;
    }
  | {
      available: false;
      blocker: 'project-structure-missing' | 'managed-store-missing';
      managedProjectDir: string;
    };

export interface MarkerWriteResult {
  path: string;
  created: boolean;
}

export interface ProjectMarkerResolution {
  projectId: string;
  projectRoot: string;
  source: 'cwd-marker' | 'ancestor-marker';
  markerPath: string;
}

export function getProjectMarkerPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), PROJECT_MARKER_DIR, PROJECT_MARKER_FILE);
}

export async function ensureProjectMarker(
  projectRoot: string,
  projectId: string,
): Promise<MarkerWriteResult> {
  const markerPath = getProjectMarkerPath(projectRoot);
  const markerDir = path.dirname(markerPath);
  const existing = await readProjectMarker(markerPath);

  if (existing) {
    if (existing.projectId !== projectId) {
      throw new ProjectResolutionError(
        `Project marker already exists at ${markerPath} for project "${existing.projectId}". ` +
          `This project root is already bound to a different project. Remove the marker or use a different project root.`,
      );
    }

    return { path: markerPath, created: false };
  }

  await fs.promises.mkdir(markerDir, { recursive: true });
  await fs.promises.writeFile(
    markerPath,
    JSON.stringify({ schemaVersion: 1, projectId }, null, 2) + '\n',
    'utf-8',
  );

  return { path: markerPath, created: true };
}

export async function resolveProjectMarkerContext(
  startPath: string,
): Promise<ProjectMarkerResolution | null> {
  let current = path.resolve(startPath);
  while (true) {
    const markerPath = getProjectMarkerPath(current);
    const marker = await readProjectMarker(markerPath);
    if (marker) {
      return {
        projectId: marker.projectId,
        projectRoot: path.resolve(current),
        source: path.resolve(current) === path.resolve(startPath)
          ? 'cwd-marker'
          : 'ancestor-marker',
        markerPath,
      };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

export async function resolveProjectContext(
  options: ResolveProjectOptions = {},
): Promise<ProjectResolution> {
  const resolvedBase = path.resolve(options.projectRoot ?? options.cwd ?? process.cwd());
  if (options.projectRoot && !(await isDirectory(resolvedBase))) {
    throw new ProjectResolutionError(
      `Project root "${resolvedBase}" does not exist or is not a directory.`,
      'project-root-missing',
    );
  }
  const registry = await Registry.load(options.configDir, options.dataDir);
  const markerResolution = await resolveProjectMarkerContext(resolvedBase);
  const registryResolution = await resolveFromRegistryRoots(registry, resolvedBase);

  if (options.projectId && options.projectId.trim().length > 0) {
    const resolved = await registry.resolve(options.projectId.trim());
    await validateResolvedProject(resolved.projectRoot, resolved.projectId, options.configDir, options.dataDir);
    const localIdentity = markerResolution ?? registryResolution;

    if (localIdentity && localIdentity.projectId !== resolved.projectId) {
      const target = options.projectRoot ? `The path "${resolvedBase}"` : `The current directory "${resolvedBase}"`;
      throw new ProjectResolutionError(
        `${target} resolves to project "${localIdentity.projectId}" at ${localIdentity.projectRoot} ` +
          `(${formatProjectResolutionSource(localIdentity.source)}). Explicit --project-id was "${resolved.projectId}". ` +
          'Run the command from the correct project root, or pass both --project-id and a matching ' +
          '--project-root if that is the intended advanced workflow.',
        'identity-conflict',
      );
    }

    if (options.projectRoot && !localIdentity) {
      throw new ProjectResolutionError(
        `Could not resolve project identity from explicit project root "${resolvedBase}". ` +
          'Pass a project root or nested path inside the intended initialized project, or omit ' +
          '--project-root and use only --project-id from outside a project.',
        'identity-unresolved',
      );
    }

    return { ...resolved, source: 'explicit' };
  }

  if (markerResolution) {
    await validateResolvedProject(
      markerResolution.projectRoot,
      markerResolution.projectId,
      options.configDir,
      options.dataDir,
      options.requireOperationalState !== false,
    );
    return markerResolution;
  }

  if (registryResolution) {
    await validateResolvedProject(
      registryResolution.projectRoot,
      registryResolution.projectId,
      options.configDir,
      options.dataDir,
      options.requireOperationalState !== false,
    );
    return registryResolution;
  }

  if (options.allowRegistryDefault) {
    const defaultProject = registry.getDefault();
    if (defaultProject) {
      const resolved = await registry.resolve(defaultProject.projectId);
      return {
        ...resolved,
        source: 'registry-default',
      };
    }
  }

  const hasDocsPolicy = await fileExists(path.join(resolvedBase, '.docs-policy.yml'));
  const hasDocsDir = await isDirectory(path.join(resolvedBase, 'docs'));
  const looksInitialized = hasDocsPolicy || hasDocsDir;

  throw new ProjectResolutionError(
    `Could not resolve a project from "${resolvedBase}". ` +
      (looksInitialized
        ? `Project at "${resolvedBase}" is not registered. ` +
            'Run "xurgo-atlas init --project-root . --project-id <id>" in the project root, ' +
            'or provide --project-id / --project-root explicitly.'
        : `Project at "${resolvedBase}" has not been initialized. ` +
            'Run "xurgo-atlas init --project-root . --project-id <id>" in the project root, ' +
            'or provide --project-id / --project-root explicitly.'),
    'identity-unresolved',
  );
}

export async function inspectProjectOperationalState(
  projectRoot: string,
  projectId: string,
  configDir?: string,
  dataDir?: string,
): Promise<ProjectOperationalState> {
  const resolvedRoot = path.resolve(projectRoot);
  const storage = new StoragePaths({ configDir, dataDir });
  const managedProjectDir = storage.projectDataDir(projectId);

  const hasPolicy = await fileExists(path.join(resolvedRoot, '.docs-policy.yml'));
  const hasDocs = await isDirectory(path.join(resolvedRoot, 'docs'));
  if (!hasPolicy && !hasDocs) {
    return {
      available: false,
      blocker: 'project-structure-missing',
      managedProjectDir,
    };
  }

  if (!(await isDirectory(managedProjectDir))) {
    return {
      available: false,
      blocker: 'managed-store-missing',
      managedProjectDir,
    };
  }

  return { available: true, blocker: null, managedProjectDir };
}

export function formatProjectResolutionSource(source: ProjectResolutionSource): string {
  switch (source) {
    case 'explicit':
      return 'explicit flags';
    case 'cwd-marker':
      return 'local marker';
    case 'ancestor-marker':
      return 'ancestor marker';
    case 'registry-exact-root':
      return 'registry exact root';
    case 'registry-ancestor-root':
      return 'registry ancestor root';
    case 'registry-default':
      return 'registry default';
  }
}

async function resolveFromRegistryRoots(
  registry: Registry,
  candidatePath: string,
): Promise<ProjectResolution | null> {
  const projects = registry.listProjects();
  const resolvedCandidate = path.resolve(candidatePath);

  const matches = projects
    .map((project) => {
      const projectRoot = path.resolve(project.projectRoot);
      const isExact = samePath(projectRoot, resolvedCandidate);
      const isAncestor = isPathAncestor(projectRoot, resolvedCandidate);
      if (!isExact && !isAncestor) {
        return null;
      }

      return {
        projectId: project.projectId,
        projectRoot,
        source: (isExact ? 'registry-exact-root' : 'registry-ancestor-root') as ProjectResolutionSource,
        depth: isExact ? 0 : path.relative(projectRoot, resolvedCandidate).split(path.sep).length,
      };
    })
    .filter((value): value is {
      projectId: string;
      projectRoot: string;
      source: ProjectResolutionSource;
      depth: number;
    } => value !== null)
    .sort((a, b) => {
      if (a.source === 'registry-exact-root' && b.source !== 'registry-exact-root') {
        return -1;
      }
      if (b.source === 'registry-exact-root' && a.source !== 'registry-exact-root') {
        return 1;
      }

      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }

      return a.projectId.localeCompare(b.projectId);
    });

  const match = matches[0];
  if (!match) {
    return null;
  }

  return {
    projectId: match.projectId,
    projectRoot: match.projectRoot,
    source: match.source,
  };
}

async function validateResolvedProject(
  projectRoot: string,
  projectId: string,
  configDir?: string,
  dataDir?: string,
  requireOperationalState = true,
): Promise<void> {
  const resolvedRoot = path.resolve(projectRoot);

  if (!(await isDirectory(resolvedRoot))) {
    throw new ProjectResolutionError(
      `Project root for "${projectId}" does not exist at ${resolvedRoot}. ` +
        'Run "xurgo-atlas init" in the project root or update the registered path.',
      'project-root-missing',
    );
  }

  if (!requireOperationalState) {
    return;
  }

  const operational = await inspectProjectOperationalState(
    resolvedRoot,
    projectId,
    configDir,
    dataDir,
  );
  if (operational.blocker === 'project-structure-missing') {
    throw new ProjectResolutionError(
      `Project at ${resolvedRoot} has not been initialized. ` +
        `Run "xurgo-atlas init --project-root ${resolvedRoot} --project-id ${projectId}" first.`,
      'project-structure-missing',
    );
  }

  if (operational.blocker === 'managed-store-missing') {
    throw new ProjectResolutionError(
      `Project "${projectId}" is recognized at ${resolvedRoot}, but managed operational state is unavailable ` +
        `because ${operational.managedProjectDir} does not exist. ` +
        `Daemon startup requires this managed state. Run "xurgo-atlas init --project-root ${resolvedRoot} ` +
        `--project-id ${projectId}" only if you intend to create it.`,
      'managed-store-missing',
    );
  }
}

export async function readProjectMarker(markerPath: string): Promise<ProjectMarker | null> {
  try {
    const raw = await fs.promises.readFile(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ProjectMarker> | null;

    if (!parsed || typeof parsed !== 'object') {
      throw new ProjectResolutionError(
        `Invalid project marker at ${markerPath}: expected a JSON object.`,
        'marker-invalid',
      );
    }

    if (parsed.schemaVersion !== 1) {
      throw new ProjectResolutionError(
        `Unsupported project marker schema at ${markerPath}: ${String(parsed.schemaVersion)}.`,
        'marker-invalid',
      );
    }

    if (typeof parsed.projectId !== 'string' || parsed.projectId.trim().length === 0) {
      throw new ProjectResolutionError(
        `Invalid project marker at ${markerPath}: projectId is missing or empty.`,
        'marker-invalid',
      );
    }

    return {
      schemaVersion: 1,
      projectId: parsed.projectId,
    };
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) {
      return null;
    }

    if (error instanceof ProjectResolutionError) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new ProjectResolutionError(
        `Invalid project marker at ${markerPath}: ${error.message}`,
        'marker-invalid',
      );
    }

    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function isPathAncestor(ancestor: string, child: string): boolean {
  const relative = path.relative(path.resolve(ancestor), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
