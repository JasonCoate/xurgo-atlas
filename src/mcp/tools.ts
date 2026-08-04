import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from '../utils.js';
import { Project } from '../core/project.js';
import {
  ProposalMetadata,
  RecoveryObservationMetadata,
  StoredProposal,
} from '../core/events.js';
import { ProjectResolver } from './types.js';
import { validatePatch, PatchProposal, PatchValidation } from '../core/patch.js';
import { isPathTraversal } from '../core/patch.js';
import { assessPatchRisk } from '../core/risk.js';
import {
  createUnifiedDiffForNewFile,
  createUnifiedDiffForReplacement,
} from '../core/unified-diff.js';
import {
  guardManagedWriteSafety,
  inspectRootSafetyContext,
  inspectRootSafetyContextReadOnly,
  type RootSafetyContext,
} from '../core/root-safety.js';
import { inspectGitIdentity, normalizeExistingPath } from '../core/git-identity.js';
import {
  readRecoveryEvidence,
} from '../core/read-only-managed-state.js';
import { Registry } from '../core/registry.js';
import { buildRootLedgerIdentityKey } from '../core/root-ledger.js';
import YAML from 'yaml';
import { collectMarkdownHeadings, findMarkdownSection } from '../core/markdown.js';
import { DocsSearchIndex } from '../core/docs-search.js';
import { buildProjectRegistrationProposal } from '../core/project-registration-proposal.js';
import {
  commitArtifactRegistrationProposal,
  createArtifactRegistrationProposal,
  parseArtifactManifestEntries,
  type HarnessArtifactManifestEntry,
} from '../core/artifact-registration-proposal.js';
import {
  ORPHAN_REMOVAL_APPROVAL, proposeOrphanRemoval, previewOrphanRemoval,
  commitOrphanRemoval, orphanRemovalStatus, OrphanRemovalError,
} from '../core/orphan-removal-proposal.js';

// ── Schemas ───────────────────────────────────────────────────────────

const ProjectIdSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
});

const ListDocsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().optional().default('main'),
});

const ReadDocSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  path: z.string().min(1, 'path is required'),
  branch: z.string().optional().default('main'),
  maxChars: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional().default(0),
});

const ReadSectionSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  path: z.string().min(1, 'path is required'),
  branch: z.string().optional().default('main'),
  revision: z.string().optional(),
  heading: z.string().min(1, 'heading is required'),
  level: z.number().int().min(1).max(6).optional(),
  occurrence: z.number().int().positive().optional().default(1),
  includeHeading: z.boolean().optional().default(true),
  maxChars: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional().default(0),
});

const CreateBranchSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().min(1, 'branch name is required'),
  from: z.string().optional().default('main'),
});

const ProposePatchSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().min(1, 'branch is required'),
  path: z.string().min(1, 'path is required'),
  baseRevision: z.string().min(1, 'baseRevision is required'),
  patch: z
    .string()
    .min(1, 'patch is required')
    .describe(
      'Standard unified diff patch text only. Required format uses ---/+++ file headers and @@ hunks. Do not send apply_patch blocks such as *** Begin Patch or prose-only patch summaries.',
    ),
  intent: z.string().min(1, 'intent is required'),
  summary: z.string().min(1, 'summary is required'),
});

const ProposeDocumentSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().optional().default('main'),
  mode: z.enum(['create']),
  path: z.string().min(1, 'path is required'),
  content: z.string().refine((value) => value.trim().length > 0, {
    message: 'content is required',
  }),
  document: z.object({
    role: z.string().refine((value) => value.trim().length > 0, {
      message: 'document.role is required',
    }),
    summary: z.string().refine((value) => value.trim().length > 0, {
      message: 'document.summary is required',
    }),
    priority: z.string().optional(),
  }),
  intent: z.string().refine((value) => value.trim().length > 0, {
    message: 'intent is required',
  }),
  summary: z.string().refine((value) => value.trim().length > 0, {
    message: 'summary is required',
  }),
});

const PreviewDiffSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  proposalId: z.string().min(1, 'proposalId is required'),
});

const ListProposalsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().optional(),
  status: z.enum(['pending', 'committed', 'discarded', 'all']).optional().default('pending'),
});

const DiscardProposalSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  proposalId: z.string().min(1, 'proposalId is required'),
});

const CommitPatchSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  proposalId: z.string().min(1, 'proposalId is required'),
  actor: z.string().optional().default('unknown'),
  riskOverride: z.string().optional(),
});

const HistorySchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  path: z.string().min(1, 'path is required'),
  branch: z.string().optional(),
  limit: z.number().int().positive().optional().default(50),
});

const RestoreFileSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  path: z.string().min(1, 'path is required'),
  revision: z.string().min(1, 'revision is required'),
  branch: z.string().optional().default('main'),
  intent: z.string().min(1, 'intent is required'),
});

const ExportSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().optional().default('main'),
  targetDir: z.string().optional(),
});

const PreviewExportSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().optional().default('main'),
  targetDir: z.string().optional(),
});

const StatusSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().optional().default('main'),
  maxChars: z.number().int().positive().optional().default(4000),
});

const ManifestSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().optional().default('main'),
  maxDocuments: z.number().int().positive().optional().default(100),
  includeRaw: z.boolean().optional().default(false),
  validatePaths: z.boolean().optional().default(true),
});

const ContextPackSectionSchema = z.object({
  path: z.string().min(1, 'path is required'),
  heading: z.string().min(1, 'heading is required'),
  level: z.number().int().min(1).max(6).optional(),
  occurrence: z.number().int().positive().optional().default(1),
  includeHeading: z.boolean().optional().default(true),
  maxChars: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional().default(0),
});

const ContextPackSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().optional().default('main'),
  revision: z.string().optional(),
  maxChars: z.number().int().positive().optional(),
  includeStatus: z.boolean().optional().default(true),
  includeAgents: z.boolean().optional().default(true),
  includeManifest: z.boolean().optional().default(true),
  paths: z.array(z.string().min(1)).optional().default([]),
  sections: z.array(ContextPackSectionSchema).optional().default([]),
  maxDocuments: z.number().int().positive().optional(),
});

const SearchSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  branch: z.string().optional().default('main'),
  query: z.string(),
  limit: z.number().int().min(1).max(25).optional().default(10),
});

const CapabilitiesSchema = z.object({});

const AtlasProjectIdentitySchema = z.object({
  projectId: z.string().min(1, 'projectId is required').optional(),
});

const AtlasProjectRegistrationProposalSchema = z.object({
  projectId: z.string().min(1, 'projectId is required').optional(),
  projectRoot: z.string().min(1, 'projectRoot is required').optional(),
  cwd: z.string().min(1, 'cwd is required').optional(),
  configDir: z.string().min(1, 'configDir is required').optional(),
  dataDir: z.string().min(1, 'dataDir is required').optional(),
});

const AtlasProposeArtifactRegistrationSchema = z.object({
  adapterId: z.string().min(1, 'adapterId is required'),
}).strict();

const AtlasArtifactRegistrationStatusSchema = z.object({
  projectId: z.string().min(1, 'projectId is required').optional(),
  branch: z.string().optional().default('main'),
  artifactId: z.string().min(1, 'artifactId is required').optional(),
  adapterId: z.string().min(1, 'adapterId is required').optional(),
  path: z.string().min(1, 'path is required').optional(),
}).strict();

const AtlasArtifactRegistrationStatusInputSchema = {
  type: 'object',
  properties: {
    projectId: { type: 'string' },
    branch: { type: 'string' },
    artifactId: { type: 'string' },
    adapterId: { type: 'string' },
    path: { type: 'string' },
  },
  additionalProperties: false,
};

const ProposeOrphanRemovalSchema = z.object({ projectId: z.string().min(1), path: z.string().min(1), baseRevision: z.string().min(1), reason: z.string().min(1) }).strict();
const PreviewOrphanRemovalSchema = z.object({ projectId: z.string().min(1), proposalId: z.string().min(1) }).strict();
const CommitOrphanRemovalSchema = z.object({ projectId: z.string().min(1), proposalId: z.string().min(1), approval: z.literal(ORPHAN_REMOVAL_APPROVAL), reviewDigest: z.string().regex(/^[0-9a-f]{64}$/), actor: z.string().trim().min(1) }).strict();
const OrphanRemovalStatusSchema = PreviewOrphanRemovalSchema;

const GovernanceSearchSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  query: z.string().min(1, 'query is required'),
  category: z.string().optional(),
  limit: z.number().int().positive().optional().default(10),
});

const GovernanceContextSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  taskDescription: z.string().min(1, 'taskDescription is required'),
  maxChars: z.number().int().positive().optional().default(10000),
});

const GovernanceLookupSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  documentId: z.string().min(1, 'documentId is required'),
});

const GovernanceListSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  category: z.string().optional(),
});

const GovernanceLifecycleSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  documentId: z.string().min(1, 'documentId is required'),
});

const AtlasCommitArtifactRegistrationSchema = z.object({
  proposalId: z.string().min(1),
  approval: z.literal('APPROVE_ARTIFACT_REGISTRATION_COMMIT'),
  actor: z.string().trim().min(1),
  projectId: z.string().min(1),
}).strict();

const AtlasCommitArtifactRegistrationInputSchema = {
  type: 'object',
  properties: {
    proposalId: { type: 'string' },
    approval: {
      type: 'string',
      enum: ['APPROVE_ARTIFACT_REGISTRATION_COMMIT'],
    },
    actor: { type: 'string' },
    projectId: { type: 'string' },
  },
  required: ['proposalId', 'approval', 'actor', 'projectId'],
  additionalProperties: false,
};

const ARTIFACT_REGISTRATION_READ_ONLY_GUARANTEES = [
  'does_not_create_proposals',
  'does_not_commit_proposals',
  'does_not_write_manifest',
  'does_not_append_artifacts',
  'does_not_modify_documents',
  'does_not_infer_approval',
  'does_not_create_audit_records',
  'does_not_auto_discover_artifacts',
  'does_not_export_docs',
] as const;

const ARTIFACT_REGISTRATION_CAPABILITIES = {
  proposalToolName: 'atlas.propose_artifact_registration',
  commitToolName: 'atlas.commit_artifact_registration',
  proposalOnlyAvailable: true,
  guardedCommitAvailable: true,
} as const;

// ── Tool Registration ────────────────────────────────────────────────

/**
 * Register all MCP tools on the server.
 *
 * Accepts either a single Project (stdio mode) or a ProjectResolver
 * function (daemon mode). In daemon mode, the project is resolved
 * per-request based on the `projectId` argument.
 */
export function registerTools(
  server: Server,
  projectOrResolver: Project | ProjectResolver,
): void {
  // Determine if we're in resolver mode (daemon) or single-project mode (stdio)
  const isResolver = typeof projectOrResolver === 'function';

  // List tools — returns the same tools regardless of mode
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'docs.list',
          description: 'List all Atlas-owned managed documentation files in a branch',
          inputSchema: zodToJsonSchema(ListDocsSchema),
        },
        {
          name: 'docs.read',
          description: 'Read a documentation file from a specific branch. Supports bounded reads with maxChars and offset for token-efficient access. Returns content, revision, truncation status, and character counts.',
          inputSchema: zodToJsonSchema(ReadDocSchema),
        },
        {
          name: 'docs.read_section',
          description: 'Read one Markdown section from a documentation file by ATX heading. Ignores headings in fenced code blocks, includes child subsections, and supports maxChars/offset bounded reads.',
          inputSchema: zodToJsonSchema(ReadSectionSchema),
        },
        {
          name: 'docs.create_branch',
          description:
            'Create a new branch for making documentation changes',
          inputSchema: zodToJsonSchema(CreateBranchSchema),
        },
        {
          name: 'docs.propose_patch',
          description:
            'Propose a patch to a documentation file. The patch field must be a standard unified diff with ---/+++ file headers and @@ hunks; apply_patch blocks such as "*** Begin Patch" are rejected. Validates the patch against policy and checks for risks. Does not apply the change — use docs.commit_patch to finalize.',
          inputSchema: zodToJsonSchema(ProposePatchSchema),
        },
        {
          name: 'docs.propose_document',
          description:
            'Propose creation of a new governed Markdown document under approved docs-managed paths such as docs/atlas/** or docs/spec/**, or repair a manifest-listed document that is missing on disk. Stores a previewable proposal that is committed through docs.commit_patch.',
          inputSchema: zodToJsonSchema(ProposeDocumentSchema),
        },
        {
          name: 'docs.preview_diff',
          description:
            'Preview the diff for a previously proposed patch by proposalId. Returns the diff, risk level, and approval requirements without committing.',
          inputSchema: zodToJsonSchema(PreviewDiffSchema),
        },
        {
          name: 'docs.list_proposals',
          description:
            'List Atlas proposal records for a project, optionally filtered by branch and lifecycle status. Defaults to pending proposals so stale internal drafts can be discovered before they linger indefinitely.',
          inputSchema: zodToJsonSchema(ListProposalsSchema),
        },
        {
          name: 'docs.discard_proposal',
          description:
            'Discard a pending or otherwise uncommitted proposal by exact proposalId while preserving audit history. Discarded proposals remain queryable but no longer count as active work.',
          inputSchema: zodToJsonSchema(DiscardProposalSchema),
        },
        {
          name: 'docs.commit_patch',
          description:
            'Commit a previously proposed patch by proposalId. Re-validates the base revision before applying. Requires riskOverride: "accept" for high-risk patches.',
          inputSchema: zodToJsonSchema(CommitPatchSchema),
        },
        {
          name: 'docs.history',
          description:
            'View the Git history for a documentation file',
          inputSchema: zodToJsonSchema(HistorySchema),
        },
        {
          name: 'docs.restore_file',
          description:
            'Restore a file to a previous revision from history',
          inputSchema: zodToJsonSchema(RestoreFileSchema),
        },
        {
          name: 'docs.export',
          description:
            'Export documentation from a branch to a target directory',
          inputSchema: zodToJsonSchema(ExportSchema),
        },
        {
          name: 'docs.preview_export',
          description:
            'Preview what docs.export would change without writing to disk. Reports drift, overwrite risk, root-safety visibility, and guidance for the next step.',
          inputSchema: zodToJsonSchema(PreviewExportSchema),
        },
        {
          name: 'docs.status',
          description:
            'Read the STATUS.md project front page. Returns compact orientation: front matter, body excerpt, revision, and truncation status. Use this instead of docs.read for STATUS.md to get structured front matter. Respects maxChars to limit response size.',
          inputSchema: zodToJsonSchema(StatusSchema),
        },
        {
          name: 'docs.manifest',
          description:
            'Read docs/manifest.yml as a compact machine-readable project document map. Returns parsed YAML (JSON), revision, optional path validation, and optional raw YAML. Does not read full document bodies. Use this for project orientation instead of docs.list + multiple docs.read calls.',
          inputSchema: zodToJsonSchema(ManifestSchema),
        },
        {
          name: 'docs.context_pack',
          description:
            'Assemble a token-efficient project orientation pack from STATUS.md, AGENTS.md, docs/manifest.yml, requested sections, requested paths, and a small manifest-guided document set. Supports a total maxChars budget and structured missing-item reporting.',
          inputSchema: zodToJsonSchema(ContextPackSchema),
        },
        {
          name: 'docs.search',
          description:
            'Search Atlas-managed documentation and context lexically with local SQLite FTS. Returns scoped matches with path, heading, snippet, score, and line metadata. Searches only Atlas-managed docs and does not use semantic retrieval.',
          inputSchema: zodToJsonSchema(SearchSchema),
        },
        {
          name: 'docs.capabilities',
          description:
            'Return a read-only Atlas capability summary for MCP clients. Reports managed-docs scope, currently available context tools, guarded-write support, and retrieval/search status without requiring any project-specific assumptions.',
          inputSchema: zodToJsonSchema(CapabilitiesSchema),
        },
        {
          name: 'atlas.project_identity',
          description:
            'Return a compact read-only runtime identity and root-safety snapshot for the resolved Atlas project. Reports the active project/root binding, marker and Git identity, authoritative write safety, descriptive root-ledger/recovery warnings, and the recommended next step. Does not replace xurgo-atlas mcp-config --json.',
          inputSchema: zodToJsonSchema(AtlasProjectIdentitySchema),
        },
        {
          name: 'atlas.project_registration_proposal',
          description:
            'Emit an ephemeral diagnostic-only project-registration proposal for exactly one requested checkout/root context. Read-only and non-mutating: it does not register, reserve, initialize, adopt, bind a daemon, establish safeForWrites authority, or create stored proposal state.',
          inputSchema: zodToJsonSchema(AtlasProjectRegistrationProposalSchema),
        },
        {
          name: 'atlas.propose_artifact_registration',
          description:
            'Create a stored review-only artifact_registration proposal for one present cataloged harness descriptor selected only by adapterId. Returns the proposed docs/manifest.yml artifacts[] diff and preview; does not approve, commit, write the manifest, activate artifacts, or authorize follow-on changes.',
          inputSchema: zodToJsonSchema(AtlasProposeArtifactRegistrationSchema),
        },
        {
          name: 'atlas.artifact_registration_status',
          description:
            'Read-only advisory status for artifact registration. Reports proposal-only and guarded-commit availability, current docs/manifest.yml artifacts[], optional explicit lookup against existing entries only, root/write-safety posture, and the next safe action; does not create proposals, commit proposals, write the manifest, discover artifacts, audit, or export docs.',
          inputSchema: AtlasArtifactRegistrationStatusInputSchema,
        },
        {
          name: 'atlas.commit_artifact_registration',
          description:
            'Commit exactly one pending stored artifact_registration proposal to docs/manifest.yml artifacts[] after explicit approval, project/root safety, stale-base, manifest, patch, and durable audit gates. Accepts only proposalId, approval literal, nonempty actor, and projectId; it does not accept caller-supplied branch, manifest path, patch, entry, artifact details, status, or risk override.',
          inputSchema: AtlasCommitArtifactRegistrationInputSchema,
        },
        { name: 'docs.propose_orphan_removal', description: 'Create a high-risk review-only proposal to locally remove exactly one demonstrably orphaned managed Markdown file. Atlas fixes branch main and generates the one-file /dev/null deletion diff; callers cannot provide a patch, branch, remote, or push option.', inputSchema: zodToJsonSchema(ProposeOrphanRemovalSchema) },
        { name: 'docs.preview_orphan_removal', description: 'Read the immutable stored orphan-removal proposal, including its exact deletion diff, evidence, and review digest.', inputSchema: zodToJsonSchema(PreviewOrphanRemovalSchema) },
        { name: 'docs.commit_orphan_removal', description: 'Commit one reviewed orphan-removal proposal locally on managed main after exact proposal-bound approval and digest binding. actor is an asserted label, not an authentication claim.', inputSchema: zodToJsonSchema(CommitOrphanRemovalSchema) },
        { name: 'docs.orphan_removal_status', description: 'Read-only orphan-removal proposal and audit observation. It classifies the observation as not_applied, matching_commit, diverged, or unavailable; it never retries Git or finalizes recovery automatically.', inputSchema: zodToJsonSchema(OrphanRemovalStatusSchema) },
        {
          name: 'governance.search',
          description: 'Search governance corpus documents by query with optional category filtering. Returns ranked results with metadata, snippets, and scores.',
          inputSchema: zodToJsonSchema(GovernanceSearchSchema),
        },
        {
          name: 'governance.context',
          description: 'Assemble bounded governance context package for a task description. Returns primary and supporting documents, applicable rules, and source references within character limit.',
          inputSchema: zodToJsonSchema(GovernanceContextSchema),
        },
        {
          name: 'governance.lookup',
          description: 'Look up a specific governance document by ID. Returns full document metadata including title, type, status, dependencies, and content.',
          inputSchema: zodToJsonSchema(GovernanceLookupSchema),
        },
        {
          name: 'governance.list',
          description: 'List all governance documents with optional category filtering. Returns document metadata without full content for efficient browsing.',
          inputSchema: zodToJsonSchema(GovernanceListSchema),
        },
        {
          name: 'governance.lifecycle',
          description: 'Get document lifecycle information including status, dependencies, tags, and modification history.',
          inputSchema: zodToJsonSchema(GovernanceLifecycleSchema),
        },
      ],
    };
  });

  // Call tool handler — resolve project per-request in daemon mode
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawParams } = request.params;
    const rawArgs = (rawParams as Record<string, unknown>) || {};

    try {
      if (name === 'docs.capabilities') {
        return handleCapabilities();
      }

      if (name === 'atlas.project_registration_proposal') {
        return await handleAtlasProjectRegistrationProposal(rawArgs);
      }

      if (name === 'atlas.propose_artifact_registration') {
        AtlasProposeArtifactRegistrationSchema.parse(rawArgs);
      }

      if (name === 'atlas.artifact_registration_status') {
        AtlasArtifactRegistrationStatusSchema.parse(rawArgs);
      }

      if (name === 'atlas.commit_artifact_registration') {
        AtlasCommitArtifactRegistrationSchema.parse(rawArgs);
      }
      if (name === 'docs.propose_orphan_removal') ProposeOrphanRemovalSchema.parse(rawArgs);
      if (name === 'docs.preview_orphan_removal') PreviewOrphanRemovalSchema.parse(rawArgs);
      if (name === 'docs.commit_orphan_removal') CommitOrphanRemovalSchema.parse(rawArgs);
      if (name === 'docs.orphan_removal_status') OrphanRemovalStatusSchema.parse(rawArgs);

      // Resolve the project for this request
      const project = await resolveProjectForRequest(
        rawArgs,
        isResolver,
        projectOrResolver,
      );

      if (name === 'atlas.propose_artifact_registration') {
        return await handleAtlasProposeArtifactRegistration(project, rawArgs);
      }

      if (name === 'atlas.artifact_registration_status') {
        return await handleAtlasArtifactRegistrationStatus(project, rawArgs);
      }

      if (name === 'atlas.commit_artifact_registration') {
        return await handleAtlasCommitArtifactRegistration(project, rawArgs);
      }
      if (name === 'docs.propose_orphan_removal') return await handleOrphanRemoval(project, 'propose', rawArgs);
      if (name === 'docs.preview_orphan_removal') return await handleOrphanRemoval(project, 'preview', rawArgs);
      if (name === 'docs.commit_orphan_removal') return await handleOrphanRemoval(project, 'commit', rawArgs);
      if (name === 'docs.orphan_removal_status') return await handleOrphanRemoval(project, 'status', rawArgs);

      // Inject the resolved projectId into args if not present
      // (e.g., when a default project was resolved in daemon mode)
      if (!rawArgs['projectId']) {
        rawArgs['projectId'] = project.projectId;
      }

      switch (name) {
        case 'docs.list':
          return await handleList(project, rawArgs);
        case 'docs.read':
          return await handleRead(project, rawArgs);
        case 'docs.read_section':
          return await handleReadSection(project, rawArgs);
        case 'docs.create_branch':
          return await handleCreateBranch(project, rawArgs);
        case 'docs.propose_patch':
          return await handleProposePatch(project, rawArgs);
        case 'docs.propose_document':
          return await handleProposeDocument(project, rawArgs);
        case 'docs.preview_diff':
          return await handlePreviewDiff(project, rawArgs);
        case 'docs.list_proposals':
          return await handleListProposals(project, rawArgs);
        case 'docs.discard_proposal':
          return await handleDiscardProposal(project, rawArgs);
        case 'docs.commit_patch':
          return await handleCommitPatch(project, rawArgs);
        case 'docs.history':
          return await handleHistory(project, rawArgs);
        case 'docs.restore_file':
          return await handleRestoreFile(project, rawArgs);
        case 'docs.export':
          return await handleExport(project, rawArgs);
        case 'docs.preview_export':
          return await handlePreviewExport(project, rawArgs);
        case 'docs.status':
          return await handleStatus(project, rawArgs);
        case 'docs.manifest':
          return await handleManifest(project, rawArgs);
        case 'docs.context_pack':
          return await handleContextPack(project, rawArgs);
        case 'docs.search':
          return await handleSearch(project, rawArgs);
        case 'atlas.project_identity':
          return await handleAtlasProjectIdentity(project, rawArgs);
        case 'governance.search':
          return await handleGovernanceSearch(project, rawArgs);
        case 'governance.context':
          return await handleGovernanceContext(project, rawArgs);
        case 'governance.lookup':
          return await handleGovernanceLookup(project, rawArgs);
        case 'governance.list':
          return await handleGovernanceList(project, rawArgs);
        case 'governance.lifecycle':
          return await handleGovernanceLifecycle(project, rawArgs);
        default:
          return {
            content: [
              { type: 'text', text: `Unknown tool: ${name}` },
            ],
            isError: true,
          };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });
}

/**
 * Resolve a Project for the given request arguments.
 *
 * In resolver mode (daemon): calls the resolver with the projectId from args
 *   (or empty string to trigger default resolution).
 * In single-project mode (stdio): returns the pre-loaded project directly.
 */
async function resolveProjectForRequest(
  rawArgs: Record<string, unknown>,
  isResolver: boolean,
  projectOrResolver: Project | ProjectResolver,
): Promise<Project> {
  if (isResolver) {
    const resolver = projectOrResolver as ProjectResolver;
    const projectId = (rawArgs['projectId'] as string) || '';
    return resolver(projectId);
  }

  // Single-project mode: use the pre-loaded project directly
  return projectOrResolver as Project;
}

// ── Tool Handlers ─────────────────────────────────────────────────────

async function handleList(project: Project, rawArgs: Record<string, unknown>) {
  const args = ListDocsSchema.parse(rawArgs);
  const missingBranch = await managedBranchMissingError(project, args.branch);
  if (missingBranch) {
    return missingBranch;
  }
  const filePaths = await project.getOwnedFiles(args.branch);
  const branchRevision = await project.gitStore.getBranchHead(args.branch);

  // Enrich each file with revision and protected status
  const files = await Promise.all(
    filePaths.map(async (filePath) => ({
      path: filePath,
      revision: await project.gitStore.getFileRevision(args.branch, filePath),
      protected: project.policy.isPathProtected(filePath),
    })),
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            projectId: project.projectId,
            branch: args.branch,
            revision: branchRevision,
            files,
          },
          null,
          2,
        ),
      },
    ],
  };
}

export async function handleRead(project: Project, rawArgs: Record<string, unknown>) {
  const args = ReadDocSchema.parse(rawArgs);
  const missingBranch = await managedBranchMissingError(project, args.branch);
  if (missingBranch) {
    return missingBranch;
  }

  // Validate path
  if (isPathTraversal(args.path)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Path traversal detected: "${args.path}" is outside the project scope`,
          }),
        },
      ],
      isError: true,
    };
  }

  if (!(await project.isPathOwned(args.branch, args.path))) {
    return ownedPathError(project.projectId, args.path, args.branch);
  }

  const { content, revision } = await project.readFile(
    args.branch,
    args.path,
  );

  if (content === null) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `File "${args.path}" not found on branch "${args.branch}"`,
            projectId: project.projectId,
            path: args.path,
            branch: args.branch,
          }),
        },
      ],
      isError: true,
    };
  }

  // Apply bounded read (offset/maxChars)
  const totalChars = content.length;
  const offset = args.offset ?? 0;
  let sliced = content;
  let truncated = false;

  if (offset > 0) {
    sliced = sliced.slice(offset);
  }

  if (args.maxChars !== undefined && sliced.length > args.maxChars) {
    sliced = sliced.slice(0, args.maxChars);
    truncated = true;
  }

  const returnedChars = sliced.length;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            projectId: project.projectId,
            path: args.path,
            branch: args.branch,
            revision,
            content: sliced,
            truncated,
            maxChars: args.maxChars ?? null,
            offset,
            returnedChars,
            totalChars,
          },
          null,
          2,
        ),
      },
    ],
  };
}

export async function handleReadSection(project: Project, rawArgs: Record<string, unknown>) {
  const args = ReadSectionSchema.parse(rawArgs);
  const missingBranch = await managedBranchMissingError(project, args.branch);
  if (missingBranch) {
    return missingBranch;
  }

  if (isPathTraversal(args.path)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Path traversal detected: "${args.path}" is outside the project scope`,
          }),
        },
      ],
      isError: true,
    };
  }

  if (!(await project.isPathOwned(args.branch, args.path))) {
    return ownedPathError(project.projectId, args.path, args.branch);
  }

  const readResult = args.revision
    ? {
        content: await project.gitStore.readFileAtRevision(args.revision, args.path),
        revision: args.revision,
      }
    : await project.readFile(args.branch, args.path);

  const { content, revision } = readResult;

  if (content === null) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: args.revision
              ? `File "${args.path}" not found at revision "${args.revision}"`
              : `File "${args.path}" not found on branch "${args.branch}"`,
            projectId: project.projectId,
            path: args.path,
            branch: args.branch,
            revision: args.revision ?? null,
          }),
        },
      ],
      isError: true,
    };
  }

  const section = findMarkdownSection(content, {
    heading: args.heading,
    level: args.level,
    occurrence: args.occurrence,
    includeHeading: args.includeHeading,
  });

  if (!section) {
    const availableHeadings = collectMarkdownHeadings(content)
      .filter((heading) => args.level === undefined || heading.level === args.level)
      .slice(0, 10)
      .map((heading) => ({
        heading: heading.text,
        level: heading.level,
        line: heading.line,
      }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: `Heading "${args.heading}" not found in "${args.path}"`,
              projectId: project.projectId,
              path: args.path,
              branch: args.branch,
              revision,
              heading: args.heading,
              level: args.level ?? null,
              occurrence: args.occurrence,
              availableHeadings,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const totalChars = section.content.length;
  const offset = args.offset ?? 0;
  let sliced = section.content;
  let truncated = false;

  if (offset > 0) {
    sliced = sliced.slice(offset);
  }

  if (args.maxChars !== undefined && sliced.length > args.maxChars) {
    sliced = sliced.slice(0, args.maxChars);
    truncated = true;
  }

  const returnedChars = sliced.length;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            projectId: project.projectId,
            path: args.path,
            branch: args.branch,
            revision,
            heading: args.heading,
            matchedHeading: section.matchedHeading,
            level: section.level,
            occurrence: args.occurrence,
            startLine: section.startLine,
            endLine: section.endLine,
            content: sliced,
            truncated,
            maxChars: args.maxChars ?? null,
            offset,
            returnedChars,
            totalChars,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleCreateBranch(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = CreateBranchSchema.parse(rawArgs);
  const rootSafety = await guardManagedWriteSafety(project, {
    operation: 'docs.create_branch',
  });
  if (rootSafety) {
    return rootSafety;
  }

  // Check if branch already exists
  const exists = await project.gitStore.branchExists(args.branch);
  if (exists) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Branch "${args.branch}" already exists`,
            projectId: project.projectId,
            branch: args.branch,
          }),
        },
      ],
      isError: true,
    };
  }

  // Check source branch exists
  const sourceExists = await project.gitStore.branchExists(args.from);
  if (!sourceExists) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Source branch "${args.from}" does not exist`,
            projectId: project.projectId,
            branch: args.branch,
            from: args.from,
          }),
        },
      ],
      isError: true,
    };
  }

  await project.gitStore.createBranch(args.branch, args.from);
  const branchHead = await project.gitStore.getBranchHead(args.branch);

  project.eventLog.logEvent({
    project_id: project.projectId,
    branch: args.branch,
    path: '.branch',
    tool_name: 'create_branch',
    intent: `Create branch "${args.branch}" from "${args.from}"`,
    summary: `Created branch "${args.branch}" from "${args.from}"`,
    result_revision: branchHead ?? undefined,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            projectId: project.projectId,
            branch: args.branch,
            from: args.from,
            created: true,
            revision: branchHead,
          },
          null,
          2,
        ),
      },
    ],
  };
}

const MANIFEST_PATH = 'docs/manifest.yml';
const ATLAS_DOCS_PREFIX = 'docs/atlas/';
const SPEC_DOCS_PREFIX = 'docs/spec/';
const RESERVED_CREATE_PATHS = new Set([
  'STATUS.md',
  'AGENTS.md',
  '.docs-policy.yml',
  'docs/manifest.yml',
]);

interface DocumentCreateProposalMetadata {
  role: string;
  summary: string;
  priority?: string;
}

interface ManifestState {
  content: string;
  revision: string;
  parsed: Record<string, unknown>;
  documents: Array<Record<string, unknown>>;
}

interface DocumentCreatePreparation {
  path: string;
  patch: string;
  manifestRevision: string;
  riskLevel: 'high' | 'low';
  requiresApproval: boolean;
  riskReasons: string[];
  changedFiles: string[];
}

interface RecoveryObservationSummary {
  observedAt: string;
  branch: string;
  path: string;
  rootIdentityKey: string;
  canonicalProjectRoot: string;
  gitWorktreeRoot: string | null;
  gitCommonDir: string | null;
  rootUnsafe: boolean;
  safeForWrites: boolean;
  rootMismatch: boolean;
  exportRequired: boolean;
  exportBlocked: boolean;
  currentRoot: boolean;
  warnings: string[];
}

interface RecoveryObservationFallback {
  branch: string;
  path: string;
  createdAt: string;
  metadata: RecoveryObservationMetadata;
}

interface RootRecoverySummary {
  available: boolean;
  recoveryRequired: boolean | null;
  proposalRecoveryRequired: boolean | null;
  exportRecoveryRequired: boolean | null;
  pendingProposalCount: number | null;
  currentRootProposalCount: number | null;
  foreignRootProposalCount: number | null;
  unknownRootProposalCount: number | null;
  recommendedCleanupTool: 'docs.discard_proposal' | null;
  nextStep: string | null;
  lastPreviewObservation: RecoveryObservationSummary | null;
  lastExportObservation: RecoveryObservationSummary | null;
  warnings: string[];
}

type DocsStatusRootContext = RootSafetyContext & {
  cwd: string;
  recovery: RootRecoverySummary;
};

export async function handleProposeDocument(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = ProposeDocumentSchema.parse(rawArgs);
  const rootSafety = await guardManagedWriteSafety(project, {
    operation: 'docs.propose_document',
  });
  if (rootSafety) {
    return rootSafety;
  }

  if (args.document.priority !== undefined && args.document.priority.trim().length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              valid: false,
              error: 'document.priority must not be empty',
              projectId: project.projectId,
              path: normalizeManagedPath(args.path),
              branch: args.branch,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const normalizedDocument = {
    role: args.document.role.trim(),
    summary: args.document.summary.trim(),
    priority: args.document.priority?.trim() || undefined,
  };

  const prepared = await prepareDocumentCreateProposal(
    project,
    args.branch,
    args.path,
    args.content,
    normalizedDocument,
  );

  if (!prepared.valid) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              valid: false,
              error: prepared.error,
              projectId: project.projectId,
              path: normalizeManagedPath(args.path),
              branch: args.branch,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const recoveryMetadata = await buildCurrentProjectProposalRecoveryMetadata(project);
  const metadata: ProposalMetadata = {
    kind: 'document_create',
    mode: 'create',
    changedFiles: prepared.changedFiles,
    baseRevisions: {
      [MANIFEST_PATH]: prepared.manifestRevision,
    },
    riskReasons: prepared.riskReasons,
    recovery: recoveryMetadata,
  };

  const stored = project.eventLog.storeProposal({
    project_id: project.projectId,
    branch: args.branch,
    path: prepared.path,
    base_revision: prepared.manifestRevision,
    patch: prepared.patch,
    intent: args.intent,
    summary: args.summary,
    risk_level: prepared.riskLevel,
    requires_approval: prepared.requiresApproval,
    metadata,
  });

  project.eventLog.logEvent({
    project_id: project.projectId,
    branch: args.branch,
    path: prepared.path,
    tool_name: 'propose_document',
    intent: args.intent,
    summary: args.summary,
    base_revision: prepared.manifestRevision,
    risk_level: prepared.riskLevel,
    diff: prepared.patch,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            proposalId: stored.id,
            valid: true,
            riskLevel: prepared.riskLevel,
            requiresApproval: prepared.requiresApproval,
            summary: args.summary,
            changedFiles: prepared.changedFiles,
            projectId: project.projectId,
            branch: args.branch,
            message: 'Document proposal stored. Use docs.preview_diff to review or docs.commit_patch to apply.',
          },
          null,
          2,
        ),
      },
    ],
  };
}

export async function handleAtlasProposeArtifactRegistration(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = AtlasProposeArtifactRegistrationSchema.parse(rawArgs);
  const rootSafety = await guardManagedWriteSafety(project, {
    operation: 'atlas.propose_artifact_registration',
  });
  if (rootSafety) {
    return rootSafety;
  }

  const proposal = await createArtifactRegistrationProposal(project, {
    adapterId: args.adapterId,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(proposal, null, 2),
      },
    ],
  };
}

export async function handleAtlasArtifactRegistrationStatus(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = AtlasArtifactRegistrationStatusSchema.parse(rawArgs);
  const branch = args.branch;
  const manifestPath = 'docs/manifest.yml';
  const rootContext = await inspectRootSafetyContextReadOnly(project);
  const branchHead = await project.gitStore.getBranchHead(branch);
  const { content, revision } = await project.readFile(branch, manifestPath);
  const lookupHints = {
    artifactId: args.artifactId ?? null,
    adapterId: args.adapterId ?? null,
    path: args.path ?? null,
  };
  const lookupRequested = Boolean(args.artifactId || args.adapterId || args.path);
  const baseResponse = {
    kind: 'artifact_registration_status' as const,
    schemaVersion: 1,
    project: {
      projectId: project.projectId,
      projectRoot: project.root,
      canonicalProjectRoot: rootContext.canonicalProjectRoot,
    },
    branch: {
      name: branch,
      head: branchHead,
      manifestPath,
      manifestRevision: revision,
    },
    advisoryOnly: true,
    proposalCapability: {
      toolName: ARTIFACT_REGISTRATION_CAPABILITIES.proposalToolName,
      available: ARTIFACT_REGISTRATION_CAPABILITIES.proposalOnlyAvailable,
      mode: 'proposal_only',
      requiresExplicitUserAction: true,
    },
    guardedCommitCapability: {
      toolName: ARTIFACT_REGISTRATION_CAPABILITIES.commitToolName,
      available: ARTIFACT_REGISTRATION_CAPABILITIES.guardedCommitAvailable,
      requiresExplicitApproval: true,
      approvalLiteral: 'APPROVE_ARTIFACT_REGISTRATION_COMMIT',
    },
    rootContext: {
      requestedCwd: rootContext.requestedCwd,
      safeForWrites: rootContext.safety.safeForWrites,
      ambiguous: rootContext.safety.ambiguous,
      warnings: rootContext.safety.warnings,
      marker: {
        path: rootContext.markerPath,
        projectId: rootContext.markerProjectId,
        present: !rootContext.safety.markerMissing,
      },
      git: {
        available: rootContext.git.insideWorkTree,
        worktreeRoot: rootContext.git.worktreeRoot,
        branch: rootContext.git.branch,
        head: rootContext.git.head,
      },
      rootLedger: rootContext.rootLedger,
    },
    readOnlyGuarantees: [...ARTIFACT_REGISTRATION_READ_ONLY_GUARANTEES],
  };

  if (content === null || revision === null) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ...baseResponse,
              status: 'manifest_unavailable',
              manifest: {
                path: manifestPath,
                available: false,
                artifactCount: 0,
                artifacts: [],
              },
              lookup: buildArtifactRegistrationLookup([], lookupHints, lookupRequested),
              nextStep: {
                code: 'repair_manifest_before_registration',
                message: `Repair or create ${manifestPath} on branch "${branch}" before artifact registration.`,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(content) as Record<string, unknown>;
  } catch (err) {
    return artifactRegistrationStatusInvalidManifestResponse(baseResponse, {
      manifestPath,
      branch,
      details: err instanceof Error ? err.message : String(err),
      lookupHints,
      lookupRequested,
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return artifactRegistrationStatusInvalidManifestResponse(baseResponse, {
      manifestPath,
      branch,
      details: `${manifestPath} must contain a top-level mapping`,
      lookupHints,
      lookupRequested,
    });
  }

  let artifacts: HarnessArtifactManifestEntry[];
  try {
    artifacts = parseArtifactManifestEntries(parsed.artifacts);
  } catch (err) {
    return artifactRegistrationStatusInvalidManifestResponse(baseResponse, {
      manifestPath,
      branch,
      details: err instanceof Error ? err.message : String(err),
      lookupHints,
      lookupRequested,
    });
  }

  const lookup = buildArtifactRegistrationLookup(artifacts, lookupHints, lookupRequested);
  const status = rootContext.safety.safeForWrites
    ? 'available'
    : 'read_only_available_root_unsafe';
  const nextStep = buildArtifactRegistrationStatusNextStep({
    status,
    lookupStatus: lookup.status,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ...baseResponse,
            status,
            manifest: {
              path: manifestPath,
              available: true,
              valid: true,
              artifactCount: artifacts.length,
              artifacts,
            },
            lookup,
            nextStep,
          },
          null,
          2,
        ),
      },
    ],
  };
}

type ArtifactRegistrationLookupStatus =
  | 'not_requested'
  | 'registered'
  | 'not_registered'
  | 'ambiguous';

function buildArtifactRegistrationLookup(
  artifacts: HarnessArtifactManifestEntry[],
  hints: {
    artifactId: string | null;
    adapterId: string | null;
    path: string | null;
  },
  requested: boolean,
): {
  status: ArtifactRegistrationLookupStatus;
  requested: boolean;
  hints: {
    artifactId: string | null;
    adapterId: string | null;
    path: string | null;
  };
  matchCount: number;
  artifacts: HarnessArtifactManifestEntry[];
} {
  if (!requested) {
    return {
      status: 'not_requested',
      requested: false,
      hints,
      matchCount: 0,
      artifacts: [],
    };
  }

  const matches = artifacts.filter((artifact) =>
    (hints.artifactId === null || artifact.id === hints.artifactId) &&
    (hints.adapterId === null || artifact.adapterId === hints.adapterId) &&
    (hints.path === null || artifact.path === hints.path),
  );

  return {
    status: matches.length === 0
      ? 'not_registered'
      : matches.length === 1
        ? 'registered'
        : 'ambiguous',
    requested: true,
    hints,
    matchCount: matches.length,
    artifacts: matches,
  };
}

function artifactRegistrationStatusInvalidManifestResponse(
  baseResponse: Record<string, unknown>,
  options: {
    manifestPath: string;
    branch: string;
    details: string;
    lookupHints: {
      artifactId: string | null;
      adapterId: string | null;
      path: string | null;
    };
    lookupRequested: boolean;
  },
) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ...baseResponse,
            status: 'manifest_invalid',
            manifest: {
              path: options.manifestPath,
              available: true,
              valid: false,
              artifactCount: 0,
              artifacts: [],
              details: options.details,
            },
            lookup: buildArtifactRegistrationLookup(
              [],
              options.lookupHints,
              options.lookupRequested,
            ),
            nextStep: {
              code: 'repair_manifest_before_registration',
              message: `Repair ${options.manifestPath} on branch "${options.branch}" before artifact registration.`,
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

function buildArtifactRegistrationStatusNextStep(options: {
  status: 'available' | 'read_only_available_root_unsafe';
  lookupStatus: ArtifactRegistrationLookupStatus;
}): { code: string; message: string } {
  if (options.status === 'read_only_available_root_unsafe') {
    return {
      code: 'stay_read_only_resolve_root_safety',
      message:
        'Artifact-registration status is available read-only, but root safety is not safe for guarded writes; resolve root safety before proposing or committing registration changes.',
    };
  }

  if (options.lookupStatus === 'registered' || options.lookupStatus === 'ambiguous') {
    return {
      code: 'review_existing_registration',
      message:
        'Review the existing manifest registration before creating any new artifact-registration proposal.',
    };
  }

  return {
    code: 'propose_registration_first',
    message:
      'Create a proposal-only artifact-registration request before any guarded commit, approval, or manifest write.',
  };
}

export async function handleAtlasCommitArtifactRegistration(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = AtlasCommitArtifactRegistrationSchema.parse(rawArgs);
  const stored = project.eventLog.getArtifactRegistrationProposal(args.proposalId);

  if (!stored) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Artifact-registration proposal "${args.proposalId}" not found`,
            projectId: project.projectId,
            proposalId: args.proposalId,
          }),
        },
      ],
      isError: true,
    };
  }

  if (args.projectId !== stored.project_id || args.projectId !== project.projectId) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Project routing mismatch for artifact-registration proposal "${args.proposalId}"`,
            proposalId: stored.id,
            requestedProjectId: args.projectId,
            storedProjectId: stored.project_id,
            resolvedProjectId: project.projectId,
          }),
        },
      ],
      isError: true,
    };
  }

  const rootSafety = await guardManagedWriteSafety(project, {
    operation: 'atlas.commit_artifact_registration',
  });
  if (rootSafety) {
    return rootSafety;
  }

  const result = await commitArtifactRegistrationProposal(project, args);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
    isError: result.idempotency === 'audit_reconciliation_required' ? true : undefined,
  };
}

async function handleOrphanRemoval(
  project: Project,
  action: 'propose' | 'preview' | 'commit' | 'status',
  rawArgs: Record<string, unknown>,
) {
  try {
    let result: unknown;
    if (action === 'propose') {
      const args = ProposeOrphanRemovalSchema.parse(rawArgs);
      const rootSafety = await guardManagedWriteSafety(project, { operation: 'docs.propose_orphan_removal' });
      if (rootSafety) return rootSafety;
      result = await proposeOrphanRemoval(project, args);
    } else if (action === 'preview') {
      const args = PreviewOrphanRemovalSchema.parse(rawArgs);
      result = previewOrphanRemoval(project, args.proposalId);
    } else if (action === 'commit') {
      const args = CommitOrphanRemovalSchema.parse(rawArgs);
      const rootSafety = await guardManagedWriteSafety(project, { operation: 'docs.commit_orphan_removal' });
      if (rootSafety) return rootSafety;
      result = await commitOrphanRemoval(project, args);
    } else {
      const args = OrphanRemovalStatusSchema.parse(rawArgs);
      result = await orphanRemovalStatus(project, args.proposalId);
    }
    const failed = typeof result === 'object' && result !== null && ['git_failed', 'audit_reconciliation_required'].includes((result as { status?: string }).status ?? '');
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: failed || undefined };
  } catch (error) {
    const known = error instanceof OrphanRemovalError;
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: known ? error.code : 'evidence_unavailable', error: error instanceof Error ? error.message : String(error) }) }], isError: true };
  }
}

async function prepareDocumentCreateProposal(
  project: Project,
  branch: string,
  requestedPath: string,
  requestedContent: string,
  document: DocumentCreateProposalMetadata,
): Promise<
  | ({ valid: true } & DocumentCreatePreparation)
  | { valid: false; error: string }
> {
  const normalizedPath = normalizeManagedPath(requestedPath);
  const content = ensureTrailingNewline(requestedContent);

  const pathError = validateCreateDocumentPath(normalizedPath);
  if (pathError) {
    return { valid: false, error: pathError };
  }

  const branchExists = await project.gitStore.branchExists(branch);
  if (!branchExists) {
    return {
      valid: false,
      error: `Branch "${branch}" does not exist. Create it with docs.create_branch first.`,
    };
  }

  if (await project.gitStore.fileExists(branch, normalizedPath)) {
    return {
      valid: false,
      error: `File "${normalizedPath}" already exists on branch "${branch}"`,
    };
  }

  const manifestState = await readManifestState(project, branch);
  if (!manifestState.valid) {
    return manifestState;
  }

  const manifestPaths = new Set(
    manifestState.documents.flatMap((entry) => {
      const filePath = entry.path;
      return typeof filePath === 'string' ? [filePath] : [];
    }),
  );

  const scopeError = validateCreateDocumentScope(normalizedPath, manifestPaths);
  if (scopeError) {
    return { valid: false, error: scopeError };
  }

  const hasManifestPath = manifestState.documents.some(
    (entry) => entry.path === normalizedPath,
  );
  if (hasManifestPath) {
    const documentPatch = createNewFilePatch(content, normalizedPath);
    const documentRisk = assessPatchRisk(
      project.policy,
      normalizedPath,
      '',
      content,
      documentPatch,
    );
    const riskReasons = Array.from(new Set(documentRisk.reasons));
    const requiresApproval = documentRisk.highRisk;

    return {
      valid: true,
      path: normalizedPath,
      patch: documentPatch,
      manifestRevision: manifestState.revision,
      riskLevel: requiresApproval ? 'high' : 'low',
      requiresApproval,
      riskReasons,
      changedFiles: [normalizedPath],
    };
  }

  const updatedManifest = buildManifestWithDocumentEntry(
    manifestState.content,
    manifestState.parsed,
    manifestState.documents,
    normalizedPath,
    document,
  );
  const documentPatch = createNewFilePatch(content, normalizedPath);
  const manifestPatch = createSimplePatch(
    manifestState.content,
    updatedManifest,
    MANIFEST_PATH,
  );
  const patch = `${documentPatch}\n${manifestPatch}`;

  const documentRisk = assessPatchRisk(
    project.policy,
    normalizedPath,
    '',
    content,
    documentPatch,
  );
  const manifestRisk = assessPatchRisk(
    project.policy,
    MANIFEST_PATH,
    manifestState.content,
    updatedManifest,
    manifestPatch,
  );
  const riskReasons = Array.from(
    new Set([...documentRisk.reasons, ...manifestRisk.reasons]),
  );
  const requiresApproval = documentRisk.highRisk || manifestRisk.highRisk;

  return {
    valid: true,
    path: normalizedPath,
    patch,
    manifestRevision: manifestState.revision,
    riskLevel: requiresApproval ? 'high' : 'low',
    requiresApproval,
    riskReasons,
    changedFiles: [normalizedPath, MANIFEST_PATH],
  };
}

function validateCreateDocumentPath(filePath: string): string | null {
  if (isPathTraversal(filePath)) {
    return `Path traversal detected: "${filePath}" is outside the project scope`;
  }

  if (RESERVED_CREATE_PATHS.has(filePath)) {
    return `Path "${filePath}" is reserved and cannot be created with docs.propose_document`;
  }

  if (!filePath.toLowerCase().endsWith('.md')) {
    return `Path "${filePath}" must be a Markdown document`;
  }

  return null;
}

function validateCreateDocumentScope(
  filePath: string,
  manifestPaths: Set<string>,
): string | null {
  if (
    filePath.startsWith(ATLAS_DOCS_PREFIX) ||
    filePath.startsWith(SPEC_DOCS_PREFIX)
  ) {
    return null;
  }

  if (manifestPaths.has(filePath)) {
    return null;
  }

  return `Path "${filePath}" must be under ${ATLAS_DOCS_PREFIX} or ${SPEC_DOCS_PREFIX}, or already listed in ${MANIFEST_PATH}`;
}

async function readManifestState(
  project: Project,
  branch: string,
): Promise<
  | ({ valid: true } & ManifestState)
  | { valid: false; error: string }
> {
  const { content, revision } = await project.readFile(branch, MANIFEST_PATH);

  if (content === null) {
    return {
      valid: false,
      error: `${MANIFEST_PATH} not found on branch "${branch}"`,
    };
  }

  if (!revision) {
    return {
      valid: false,
      error: `Could not determine the current revision for ${MANIFEST_PATH} on branch "${branch}"`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(content) as Record<string, unknown>;
  } catch (err) {
    return {
      valid: false,
      error: `Invalid YAML in ${MANIFEST_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      valid: false,
      error: `${MANIFEST_PATH} must contain a top-level mapping`,
    };
  }

  if (!Array.isArray(parsed.documents)) {
    return {
      valid: false,
      error: `${MANIFEST_PATH} is missing a valid documents[] array`,
    };
  }

  const documents = parsed.documents.map((entry) =>
    ((entry && typeof entry === 'object' && !Array.isArray(entry))
      ? { ...(entry as Record<string, unknown>) }
      : {}) as Record<string, unknown>,
  );

  return {
    valid: true,
    content,
    revision,
    parsed,
    documents,
  };
}

function buildManifestWithDocumentEntry(
  originalContent: string,
  parsed: Record<string, unknown>,
  documents: Array<Record<string, unknown>>,
  filePath: string,
  document: DocumentCreateProposalMetadata,
): string {
  const updated = {
    ...parsed,
    documents: [
      ...documents,
      {
        path: filePath,
        role: document.role,
        ...(document.priority ? { priority: document.priority } : {}),
        summary: document.summary,
      },
    ],
  };

  const headerComment = extractLeadingYamlComment(originalContent);
  const serialized = YAML.stringify(updated).trimEnd() + '\n';
  return headerComment ? `${headerComment}${serialized}` : serialized;
}

function extractLeadingYamlComment(content: string): string {
  const match = content.match(/^((?:#.*\n)+)/);
  return match?.[1] ?? '';
}

function createNewFilePatch(content: string, filePath: string): string {
  return createUnifiedDiffForNewFile(filePath, content);
}

function createSimplePatch(
  original: string,
  updated: string,
  filePath: string,
): string {
  return createUnifiedDiffForReplacement(filePath, original, updated);
}

function normalizeManagedPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function getProposalValidationStatus(validation: {
  valid: boolean;
  failureType?: 'stale' | 'invalid';
}) {
  return validation.failureType === 'stale' ? 'stale' : 'rejected';
}

export async function handleProposePatch(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = ProposePatchSchema.parse(rawArgs);
  const rootSafety = await guardManagedWriteSafety(project, {
    operation: 'docs.propose_patch',
  });
  if (rootSafety) {
    return rootSafety;
  }

  const patchProposal: PatchProposal = {
    projectId: args.projectId,
    branch: args.branch,
    path: args.path,
    baseRevision: args.baseRevision,
    patch: args.patch,
    intent: args.intent,
    summary: args.summary,
  };

  const validation = await validatePatch(
    project.policy,
    project.gitStore,
    patchProposal,
  );

  if (!validation.valid) {
    const formatErrorFields = validation.formatError
      ? {
          errorCode: validation.formatError.code,
          expectedFormat: validation.formatError.expectedFormat,
          receivedFormat: validation.formatError.receivedFormat,
          hint: validation.formatError.hint,
        }
      : {};

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              valid: false,
              error: validation.error,
              ...formatErrorFields,
              projectId: project.projectId,
              path: args.path,
              branch: args.branch,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const riskLevel = validation.risk?.highRisk ? 'high' : 'low';
  const requiresApproval = !!validation.risk?.highRisk;
  const recoveryMetadata = await buildCurrentProjectProposalRecoveryMetadata(project);

  // Store the proposal
  const stored = project.eventLog.storeProposal({
    project_id: project.projectId,
    branch: args.branch,
    path: args.path,
    base_revision: args.baseRevision,
    patch: args.patch,
    intent: args.intent,
    summary: args.summary,
    risk_level: riskLevel,
    requires_approval: requiresApproval,
    metadata: {
      recovery: recoveryMetadata,
    },
  });

  // Log the proposal event
  project.eventLog.logEvent({
    project_id: project.projectId,
    branch: args.branch,
    path: args.path,
    tool_name: 'propose_patch',
    intent: args.intent,
    summary: args.summary,
    base_revision: args.baseRevision,
    risk_level: riskLevel,
    diff: args.patch,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            proposalId: stored.id,
            valid: true,
            riskLevel,
            requiresApproval,
            summary: args.summary,
            changedFiles: [args.path],
            projectId: project.projectId,
            branch: args.branch,
            message: 'Patch proposal stored. Use docs.preview_diff to review or docs.commit_patch to apply.',
          },
          null,
          2,
        ),
      },
    ],
  };
}

export async function handlePreviewDiff(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = PreviewDiffSchema.parse(rawArgs);

  // Look up the stored proposal
  const stored = project.eventLog.getProposal(args.proposalId);
  if (!stored) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Proposal "${args.proposalId}" not found`,
            projectId: project.projectId,
          }),
        },
      ],
      isError: true,
    };
  }

  if (stored.status !== 'pending') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Proposal "${args.proposalId}" has status "${stored.status}" and cannot be previewed`,
            proposalId: stored.id,
            status: stored.status,
          }),
        },
      ],
      isError: true,
    };
  }

  const validation = isDocumentCreateProposal(stored)
    ? await validateStoredDocumentCreateProposal(project, stored)
    : await validateStoredPatchProposal(project, stored);

  if (!validation.valid) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              valid: false,
              applyable: validation.applyable ?? false,
              error: validation.error,
              proposalId: stored.id,
              status: stored.status,
              validationStatus: validation.failureType ?? 'invalid',
              projectId: project.projectId,
              path: stored.path,
              branch: stored.branch,
              changedFiles: getProposalChangedFiles(stored),
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            proposalId: stored.id,
            diff: stored.patch,
            riskLevel: stored.risk_level,
            requiresApproval: stored.requires_approval,
            projectId: project.projectId,
            path: stored.path,
            branch: stored.branch,
            summary: stored.summary,
            changedFiles: getProposalChangedFiles(stored),
            valid: true,
            applyable: validation.applyable ?? true,
            validationStatus: 'valid',
          },
          null,
          2,
        ),
      },
    ],
  };
}

export async function handleListProposals(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = ListProposalsSchema.parse(rawArgs);
  const proposals = project.eventLog
    .listProposals({
      projectId: project.projectId,
      branch: args.branch,
      status: args.status,
    })
    .map((stored) => formatProposalListItem(stored));

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            projectId: project.projectId,
            branch: args.branch ?? null,
            status: args.status,
            proposalCount: proposals.length,
            proposals,
          },
          null,
          2,
        ),
      },
    ],
  };
}

export async function handleDiscardProposal(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = DiscardProposalSchema.parse(rawArgs);

  // Proposal discard is recovery-only cleanup. It must stay available even
  // when the managed write/export root context is unsafe.
  const stored = project.eventLog.getProposal(args.proposalId);
  if (!stored) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Proposal "${args.proposalId}" not found`,
            projectId: project.projectId,
            proposalId: args.proposalId,
          }),
        },
      ],
      isError: true,
    };
  }

  if (stored.status === 'committed') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Proposal "${args.proposalId}" has status "committed" and cannot be discarded`,
            proposalId: stored.id,
            previousStatus: stored.status,
            status: stored.status,
            projectId: project.projectId,
          }),
        },
      ],
      isError: true,
    };
  }

  if (stored.status === 'discarded') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              proposalId: stored.id,
              projectId: project.projectId,
              previousStatus: stored.status,
              status: stored.status,
              targetPath: stored.path,
              branch: stored.branch,
              diskTouched: false,
              manifestTouched: false,
              noOp: true,
              message: 'Proposal is already discarded. No changes were made.',
              nextStep:
                'Use docs.list_proposals with status "all" if you want to inspect historical discarded proposals.',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const discardedAt = new Date().toISOString();
  project.eventLog.updateProposalStatus(stored.id, 'discarded');
  project.eventLog.logEvent({
    project_id: project.projectId,
    branch: stored.branch,
    path: stored.path,
    tool_name: 'discard_proposal',
    intent: stored.intent,
    summary: `Discarded proposal "${stored.id}" for ${stored.path}`,
    base_revision: stored.base_revision,
    risk_level: stored.risk_level,
  });

  const updated = project.eventLog.getProposal(stored.id);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            proposalId: stored.id,
            projectId: project.projectId,
            previousStatus: stored.status,
            status: updated?.status ?? 'discarded',
            targetPath: stored.path,
            branch: stored.branch,
            createdAt: stored.created_at,
            updatedAt: updated?.discarded_at ?? discardedAt,
            diskTouched: false,
            manifestTouched: false,
            exportRelevant: false,
            noOp: false,
            message: 'Proposal discarded without touching disk or manifest state.',
            nextStep:
              'Use docs.list_proposals to confirm the proposal is no longer active. Discarded proposals remain in audit history.',
          },
          null,
          2,
        ),
      },
    ],
  };
}

export async function handleCommitPatch(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = CommitPatchSchema.parse(rawArgs);
  const rootSafety = await guardManagedWriteSafety(project, {
    operation: 'docs.commit_patch',
  });
  if (rootSafety) {
    return rootSafety;
  }

  // Look up the stored proposal
  const stored = project.eventLog.getProposal(args.proposalId);
  if (!stored) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Proposal "${args.proposalId}" not found`,
            projectId: project.projectId,
          }),
        },
      ],
      isError: true,
    };
  }

  if (stored.status !== 'pending') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Proposal "${args.proposalId}" has status "${stored.status}" and cannot be committed`,
            proposalId: stored.id,
            status: stored.status,
          }),
        },
      ],
      isError: true,
    };
  }

  const changedFiles = getProposalChangedFiles(stored);
  const validation = isDocumentCreateProposal(stored)
    ? await validateStoredDocumentCreateProposal(project, stored)
    : await validateStoredPatchProposal(project, stored);

  if (!validation.valid) {
    project.eventLog.updateProposalStatus(
      stored.id,
      getProposalValidationStatus(validation),
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              valid: false,
              error: validation.error,
              proposalId: stored.id,
              projectId: project.projectId,
              path: stored.path,
              branch: stored.branch,
              status: getProposalValidationStatus(validation),
              validationStatus: validation.failureType ?? 'invalid',
              message:
                validation.failureType === 'stale'
                  ? 'Proposal marked as stale. Re-read the file and create a new proposal.'
                  : 'Proposal marked as rejected because the stored patch is invalid. Re-create the proposal with a valid patch.',
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const isHighRisk = validation.risk?.highRisk ?? false;
  if (isHighRisk && args.riskOverride !== 'accept') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              valid: false,
              error: 'High-risk patch requires riskOverride: "accept" to proceed',
              proposalId: stored.id,
              projectId: project.projectId,
              path: stored.path,
              branch: stored.branch,
              riskLevel: 'high',
              reasons: validation.risk?.reasons ?? [],
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const commitResult = isDocumentCreateProposal(stored)
    ? await project.gitStore.applyMultiFilePatchAndCommit(
        stored.branch,
        stored.patch,
        stored.summary,
        changedFiles,
        stored.metadata?.baseRevisions,
      )
    : await project.gitStore.applyPatchAndCommit(
        stored.branch,
        stored.path,
        stored.patch,
        stored.summary,
        stored.base_revision,
      );

  // Mark proposal as committed
  project.eventLog.updateProposalStatus(stored.id, 'committed');

  // Log the commit event
  project.eventLog.logEvent({
    project_id: project.projectId,
    branch: stored.branch,
    path: stored.path,
    actor: args.actor,
    tool_name: 'commit_patch',
    intent: stored.intent,
    summary: stored.summary,
    base_revision: stored.base_revision,
    result_revision: commitResult.hash,
    risk_level: isHighRisk ? 'high' : 'low',
    diff: stored.patch,
  });

  const syncState = await getManagedWorkingTreeSyncState(project, stored.branch);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            proposalId: stored.id,
            commit: commitResult.hash,
            changedFiles,
            projectId: project.projectId,
            branch: stored.branch,
            message:
              'Patch committed successfully. Run docs.export before disk reads or Git commits.',
            exportRequired: syncState.exportRequired,
            workingTreeOutOfSync: syncState.workingTreeOutOfSync,
            outOfSyncPaths: syncState.outOfSyncPaths,
            nextStep: syncState.exportRequired
              ? 'Run docs.export before disk reads or Git commits.'
              : 'Working tree already matches the managed branch snapshot.',
          },
          null,
          2,
        ),
      },
    ],
  };
}

function formatProposalListItem(stored: StoredProposal) {
  return {
    proposalId: stored.id,
    projectId: stored.project_id,
    branch: stored.branch,
    targetPath: stored.path,
    kind: stored.metadata?.kind ?? 'patch',
    status: stored.status,
    committed: stored.status === 'committed',
    discarded: stored.status === 'discarded',
    exportRelevant: stored.status === 'committed',
    exportRequired:
      stored.status === 'committed'
        ? null
        : false,
    createdAt: stored.created_at,
    updatedAt:
      stored.discarded_at ??
      stored.committed_at ??
      stored.created_at,
    committedAt: stored.committed_at,
    discardedAt: stored.discarded_at,
    summary: stored.summary,
    intent: stored.intent,
    requiresApproval: stored.requires_approval,
    changedFiles: getProposalChangedFiles(stored),
  };
}

async function validateStoredPatchProposal(
  project: Project,
  stored: StoredProposal,
): Promise<PatchValidation> {
  const patchProposal: PatchProposal = {
    projectId: stored.project_id,
    branch: stored.branch,
    path: stored.path,
    baseRevision: stored.base_revision,
    patch: stored.patch,
    intent: stored.intent,
    summary: stored.summary,
  };

  return validatePatch(
    project.policy,
    project.gitStore,
    patchProposal,
  );
}

async function validateStoredDocumentCreateProposal(
  project: Project,
  stored: StoredProposal,
): Promise<PatchValidation> {
  if (!stored.metadata) {
    return {
      valid: false,
      failureType: 'invalid',
      applyable: false,
      error: 'Stored proposal metadata is missing for docs.propose_document',
    };
  }

  const pathError = validateCreateDocumentPath(stored.path);
  if (pathError) {
    return {
      valid: false,
      failureType: 'invalid',
      applyable: false,
      error: pathError,
    };
  }

  const branchExists = await project.gitStore.branchExists(stored.branch);
  if (!branchExists) {
    return {
      valid: false,
      failureType: 'invalid',
      applyable: false,
      error: `Branch "${stored.branch}" does not exist. Create it with docs.create_branch first.`,
    };
  }

  if (await project.gitStore.fileExists(stored.branch, stored.path)) {
    return {
      valid: false,
      failureType: 'invalid',
      applyable: false,
      error: `File "${stored.path}" already exists on branch "${stored.branch}"`,
    };
  }

  const expectedManifestRevision = stored.metadata.baseRevisions?.[MANIFEST_PATH];
  if (typeof expectedManifestRevision !== 'string' || expectedManifestRevision.length === 0) {
    return {
      valid: false,
      failureType: 'invalid',
      applyable: false,
      error: 'Stored proposal metadata is missing the manifest base revision for docs.propose_document',
    };
  }
  const currentManifestRevision = await project.gitStore.getFileRevision(
    stored.branch,
    MANIFEST_PATH,
  );

  if (!currentManifestRevision || currentManifestRevision !== expectedManifestRevision) {
    return {
      valid: false,
      failureType: 'stale',
      applyable: false,
      error: `Base revision mismatch for "${MANIFEST_PATH}" on branch "${stored.branch}": expected ${expectedManifestRevision}, but current revision is ${currentManifestRevision ?? 'missing'}. The file has been modified since you created the proposal. Re-read the manifest and create a new proposal.`,
    };
  }

  const manifestState = await readManifestState(project, stored.branch);
  if (!manifestState.valid) {
    return {
      valid: false,
      failureType: 'invalid',
      applyable: false,
      error: manifestState.error,
    };
  }

  const manifestPaths = new Set(
    manifestState.documents.flatMap((entry) => {
      const filePath = entry.path;
      return typeof filePath === 'string' ? [filePath] : [];
    }),
  );

  const scopeError = validateCreateDocumentScope(stored.path, manifestPaths);
  if (scopeError) {
    return {
      valid: false,
      failureType: 'invalid',
      applyable: false,
      error: scopeError,
    };
  }

  const proposalTouchesManifest = getProposalChangedFiles(stored).includes(MANIFEST_PATH);
  const manifestIncludesPath = manifestState.documents.some((entry) => entry.path === stored.path);

  if (proposalTouchesManifest) {
    if (manifestIncludesPath) {
      return {
        valid: false,
        failureType: 'invalid',
        applyable: false,
        error: `${MANIFEST_PATH} already contains a documents[] entry for "${stored.path}"`,
      };
    }
  } else if (!manifestIncludesPath) {
    return {
      valid: false,
      failureType: 'invalid',
      applyable: false,
      error: `${MANIFEST_PATH} no longer contains a documents[] entry for "${stored.path}". Re-read the manifest and create a new repair proposal if the document should still exist.`,
    };
  }

  const applyCheck = await project.gitStore.validatePatchApplyability(
    stored.branch,
    stored.patch,
    getProposalChangedFiles(stored),
  );
  if (!applyCheck.applyable) {
    return {
      valid: false,
      failureType: 'invalid',
      applyable: false,
      error: `Patch does not apply cleanly: ${applyCheck.error ?? 'Unknown git apply error'}`,
    };
  }

  return {
    valid: true,
    applyable: true,
    risk: {
      highRisk: stored.risk_level === 'high',
      reasons: stored.metadata.riskReasons ?? [],
    },
  };
}

function isDocumentCreateProposal(
  stored: StoredProposal,
): stored is StoredProposal & { metadata: ProposalMetadata } {
  return (
    stored.metadata?.kind === 'document_create' &&
    stored.metadata.mode === 'create' &&
    Array.isArray(stored.metadata.changedFiles) &&
    !!stored.metadata.baseRevisions
  );
}

function getProposalChangedFiles(stored: StoredProposal): string[] {
  if (stored.metadata?.changedFiles?.length) {
    return stored.metadata.changedFiles;
  }

  return [stored.path];
}

async function readWorkingTreeFile(
  baseDir: string,
  filePath: string,
): Promise<string | null> {
  try {
    return await fs.promises.readFile(path.join(baseDir, filePath), 'utf-8');
  } catch {
    return null;
  }
}

async function getManagedWorkingTreeSyncState(
  project: Project,
  branch: string,
  targetDir = project.root,
): Promise<{
  exportRequired: boolean;
  workingTreeOutOfSync: boolean;
  outOfSyncPaths: string[];
}> {
  const ownedFiles = await project.getOwnedFiles(branch);
  const comparisons = await Promise.all(
    ownedFiles.map(async (filePath) => ({
      filePath,
      managedContent: await project.gitStore.readFile(branch, filePath),
      workingTreeContent: await readWorkingTreeFile(targetDir, filePath),
    })),
  );

  const outOfSyncPaths = comparisons
    .filter(
      ({ managedContent, workingTreeContent }) =>
        (managedContent ?? null) !== (workingTreeContent ?? null),
    )
    .map(({ filePath }) => filePath);

  return {
    exportRequired: outOfSyncPaths.length > 0,
    workingTreeOutOfSync: outOfSyncPaths.length > 0,
    outOfSyncPaths,
  };
}

interface ExportPreviewState {
  targetDir: string;
  managedRevision: string | null;
  sourceRevision: string | null;
  exportRequired: boolean;
  workingTreeOutOfSync: boolean;
  outOfSyncPaths: string[];
  changedPaths: string[];
  addedPaths: string[];
  modifiedPaths: string[];
  deletedPaths: string[];
  overwriteExistingPaths: string[];
  diskContentDiffersFromManagedPaths: string[];
  riskyPaths: string[];
  targetBranchInfo: {
    repoRoot: string | null;
    branch: string | null;
    revision: string | null;
  };
  summary: Record<string, number>;
  nextStep: string;
  exportBlocked: boolean;
  exportBlockReason: string | null;
}

async function getExportPreviewState(
  project: Project,
  branch: string,
  targetDir = project.root,
): Promise<
  | { branchMissing: { content: Array<{ type: 'text'; text: string }>; isError: true } }
  | ExportPreviewState
> {
  const missingBranch = await managedBranchMissingError(project, branch);
  if (missingBranch) {
    return {
      branchMissing: missingBranch,
    };
  }

  const managedRevision = await project.gitStore.getBranchHead(branch);
  const targetBranchInfo = await project.gitStore.getExportTargetBranchInfo(targetDir);
  const sourceRevision = targetBranchInfo.revision;
  const exportBlocked = Boolean(
    targetBranchInfo.branch && targetBranchInfo.branch !== branch,
  );
  const exportBlockReason = exportBlocked
    ? `Refusing to preview export of managed docs branch "${branch}" into source branch "${targetBranchInfo.branch}" at "${targetBranchInfo.repoRoot ?? targetDir}".`
    : null;

  const ownedFiles = await project.getOwnedFiles(branch);
  const comparisons = await Promise.all(
    ownedFiles.map(async (filePath) => {
      const managedContent = await project.gitStore.readFile(branch, filePath);
      const workingTreeContent = await readWorkingTreeFile(targetDir, filePath);
      const existsOnDisk = workingTreeContent !== null;
      const differs = (managedContent ?? null) !== (workingTreeContent ?? null);

      return {
        filePath,
        existsOnDisk,
        differs,
      };
    }),
  );

  const addedPaths = comparisons
    .filter((entry) => !entry.existsOnDisk)
    .map((entry) => entry.filePath);
  const modifiedPaths = comparisons
    .filter((entry) => entry.existsOnDisk && entry.differs)
    .map((entry) => entry.filePath);
  const changedPaths = [...addedPaths, ...modifiedPaths];
  const deletedPaths: string[] = [];
  const overwriteExistingPaths = [...modifiedPaths];
  const diskContentDiffersFromManagedPaths = [...modifiedPaths];
  const riskyPaths = exportBlocked || modifiedPaths.length > 0 ? [...changedPaths] : [];

  const exportRequired = changedPaths.length > 0;
  const summary = {
    totalPaths: ownedFiles.length,
    existingPaths: comparisons.filter((entry) => entry.existsOnDisk).length,
    missingPaths: addedPaths.length,
    changedCount: changedPaths.length,
    addedCount: addedPaths.length,
    modifiedCount: modifiedPaths.length,
    deletedCount: deletedPaths.length,
    overwriteCount: overwriteExistingPaths.length,
    differingCount: diskContentDiffersFromManagedPaths.length,
    riskyCount: riskyPaths.length,
  };

  const nextStep = exportBlocked
    ? 'Check out the matching source branch or export the matching managed branch before retrying.'
    : exportRequired
      ? 'Run docs.export to write the previewed managed changes to disk.'
      : 'No export is required. The working tree already matches the managed snapshot.';

  return {
    targetDir,
    managedRevision,
    sourceRevision,
    exportRequired,
    workingTreeOutOfSync: exportRequired,
    outOfSyncPaths: changedPaths,
    changedPaths,
    addedPaths,
    modifiedPaths,
    deletedPaths,
    overwriteExistingPaths,
    diskContentDiffersFromManagedPaths,
    riskyPaths,
    targetBranchInfo,
    summary,
    nextStep,
    exportBlocked,
    exportBlockReason,
  };
}

async function handlePreviewExport(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = PreviewExportSchema.parse(rawArgs);
  const preview = await getExportPreviewState(
    project,
    args.branch,
    args.targetDir ?? project.root,
  );

  if ('branchMissing' in preview) {
    return preview.branchMissing;
  }

  const rootContext = await buildDocsStatusRootContext(project, {
    branch: args.branch,
    exportState: {
      exportRequired: preview.exportRequired,
      exportBlocked: preview.exportBlocked,
    },
    observation: 'preview_export',
  });
  const rootWarnings = dedupeStrings([
    ...rootContext.safety.warnings,
    ...rootContext.rootLedger.warnings,
  ]);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            previewed: true,
            projectId: project.projectId,
            branch: args.branch,
            targetDir: preview.targetDir,
            rootUnsafe: !rootContext.safety.safeForWrites,
            rootContext,
            rootWarnings,
            managedRevision: preview.managedRevision,
            sourceRevision: preview.sourceRevision,
            exportRequired: preview.exportRequired,
            exportable: !preview.exportBlocked,
            exportBlocked: preview.exportBlocked,
            exportBlockReason: preview.exportBlockReason,
            targetBranchInfo: preview.targetBranchInfo,
            changedPaths: preview.changedPaths,
            addedPaths: preview.addedPaths,
            modifiedPaths: preview.modifiedPaths,
            deletedPaths: preview.deletedPaths,
            overwriteExistingPaths: preview.overwriteExistingPaths,
            diskContentDiffersFromManagedPaths: preview.diskContentDiffersFromManagedPaths,
            riskyPaths: preview.riskyPaths,
            summary: preview.summary,
            nextStep: preview.nextStep,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleHistory(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = HistorySchema.parse(rawArgs);

  // Get history from both Git and event log
  const gitHistory = await project.gitStore.getHistory(args.path, args.limit);
  const eventHistory = project.eventLog.getHistoryForPath(
    project.projectId,
    args.path,
    args.limit,
  );

  // Merge into a unified history array matching the PRD spec format
  const history = mergeHistory(gitHistory, eventHistory);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            projectId: project.projectId,
            path: args.path,
            history,
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Merge Git history and event log entries into a unified, deduplicated,
 * sorted history array. Deduplication is by revision hash (preferring
 * the more descriptive source). Entries are sorted newest-first.
 */
/** Entry shape accepted by mergeHistory from the Git store. */
export interface GitHistoryEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

/** Entry shape accepted by mergeHistory from the event log. */
export interface EventHistoryEntry {
  id?: string;
  result_revision?: string;
  created_at?: string;
  actor?: string;
  summary?: string;
  tool_name?: string;
}

export function mergeHistory(
  gitHistory: GitHistoryEntry[],
  eventHistory: EventHistoryEntry[],
): Array<{
  revision: string;
  timestamp: string;
  actor: string;
  summary: string;
}> {
  const seen = new Set<string>();
  const merged: Array<{
    revision: string;
    timestamp: string;
    actor: string;
    summary: string;
  }> = [];

  // Git entries first (preferred source)
  for (const entry of gitHistory) {
    const revision = entry.hash;
    if (!seen.has(revision)) {
      seen.add(revision);
      merged.push({
        revision,
        timestamp: entry.date,
        actor: entry.author,
        summary: entry.message,
      });
    }
  }

  // Event log entries (add any not already covered by git)
  for (const entry of eventHistory) {
    const revision = entry.result_revision ?? entry.id ?? '';
    if (revision && !seen.has(revision)) {
      seen.add(revision);
      merged.push({
        revision,
        timestamp: entry.created_at ?? '',
        actor: entry.actor ?? entry.tool_name ?? 'unknown',
        summary: entry.summary ?? '',
      });
    }
  }

  // Sort newest-first by timestamp
  merged.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return merged;
}

async function handleRestoreFile(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = RestoreFileSchema.parse(rawArgs);
  const rootSafety = await guardManagedWriteSafety(project, {
    operation: 'docs.restore_file',
  });
  if (rootSafety) {
    return rootSafety;
  }

  // Validate path
  if (isPathTraversal(args.path)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Path traversal detected: "${args.path}" is outside the project scope`,
          }),
        },
      ],
      isError: true,
    };
  }

  // Validate the revision exists
  const content = await project.gitStore.readFileAtRevision(
    args.revision,
    args.path,
  );
  if (content === null) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Revision "${args.revision}" not found for file "${args.path}"`,
            projectId: project.projectId,
            path: args.path,
            revision: args.revision,
          }),
        },
      ],
      isError: true,
    };
  }

  const result = await project.gitStore.restoreFile(
    args.branch,
    args.path,
    args.revision,
  );

  project.eventLog.logEvent({
    project_id: project.projectId,
    branch: args.branch,
    path: args.path,
    tool_name: 'restore_file',
    intent: args.intent,
    summary: `Restored "${args.path}" to revision ${args.revision.slice(0, 8)}`,
    result_revision: result.hash,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            restored: true,
            path: args.path,
            branch: args.branch,
            commit: result.hash,
            projectId: project.projectId,
            revision: args.revision,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleExport(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = ExportSchema.parse(rawArgs);
  const rootSafety = await guardManagedWriteSafety(project, {
    operation: 'docs.export',
  });
  if (rootSafety) {
    return rootSafety;
  }
  const missingBranch = await managedBranchMissingError(project, args.branch);
  if (missingBranch) {
    return missingBranch;
  }

  const targetDir = args.targetDir ?? project.root;
  let exportedFiles: string[];
  try {
    // Export only current owned/tracked docs to prevent stale or
    // unmanifested files from leaking into the working tree.
    const ownedFiles = await project.getOwnedFiles(args.branch);
    exportedFiles = await project.gitStore.exportBranch(
      args.branch,
      targetDir,
      ownedFiles,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: message,
            projectId: project.projectId,
            branch: args.branch,
            targetDir,
          }),
        },
      ],
      isError: true,
    };
  }

  const revision = await project.gitStore.getBranchHead(args.branch);
  const syncState = await getManagedWorkingTreeSyncState(
    project,
    args.branch,
    targetDir,
  );

  project.eventLog.logEvent({
    project_id: project.projectId,
    branch: args.branch,
    path: '.export',
    tool_name: 'export',
    intent: `Export documentation from branch "${args.branch}"`,
    summary: `Exported ${exportedFiles.length} files from "${args.branch}" to "${targetDir}"`,
    result_revision: revision ?? undefined,
  });

  try {
    const recoveryObservation = await buildCurrentProjectRecoveryObservationMetadata(
      project,
      'export',
      {
        exportRequired: syncState.exportRequired,
        exportBlocked: false,
      },
    );
    logRecoveryObservationEvent(project, args.branch, 'export', recoveryObservation);
  } catch {
    // Export success remains authoritative; recovery breadcrumbs are best-effort only.
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            exported: true,
            branch: args.branch,
            files: exportedFiles,
            projectId: project.projectId,
            targetDir,
            revision,
            exportRequired: syncState.exportRequired,
            workingTreeOutOfSync: syncState.workingTreeOutOfSync,
            outOfSyncPaths: syncState.outOfSyncPaths,
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ── docs.status handler ────────────────────────────────────────────────

export async function handleStatus(project: Project, rawArgs: Record<string, unknown>) {
  const args = StatusSchema.parse(rawArgs);
  const missingBranch = await managedBranchMissingError(project, args.branch);
  if (missingBranch) {
    return missingBranch;
  }

  // Read STATUS.md
  const { content, revision } = await project.readFile(args.branch, 'STATUS.md');

  if (content === null) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'STATUS.md not found',
              projectId: project.projectId,
              branch: args.branch,
              path: 'STATUS.md',
              hint: 'Run xurgo-atlas init to create project front page (STATUS.md)',
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  // Parse front matter
  const { frontMatter, rawFrontMatter, body } = parseFrontMatter(content);

  // Truncate body to maxChars
  let truncatedBody = body;
  let truncated = false;
  if (args.maxChars && body.length > args.maxChars) {
    truncatedBody = body.slice(0, args.maxChars);
    truncated = true;
  }

  // Build summary from front matter
  const summary: Record<string, unknown> = {};
  if (frontMatter) {
    if (frontMatter.currentFocus) summary.currentFocus = frontMatter.currentFocus;
    if (frontMatter.nextActions) summary.nextActions = frontMatter.nextActions;
    if (frontMatter.blockers) summary.blockers = frontMatter.blockers;
    if (frontMatter.doNotDo) summary.doNotDo = frontMatter.doNotDo;
    if (frontMatter.relatedDocs) summary.relatedDocs = frontMatter.relatedDocs;
  }

  const syncState = await getManagedWorkingTreeSyncState(project, args.branch);
  const rootContext = await buildDocsStatusRootContext(project, {
    branch: args.branch,
    exportState: {
      exportRequired: syncState.exportRequired,
      exportBlocked: false,
    },
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            projectId: project.projectId,
            path: 'STATUS.md',
            branch: args.branch,
            revision,
            frontMatter: frontMatter ?? null,
            rawFrontMatter: rawFrontMatter ?? null,
            summary,
            body: truncatedBody,
            truncated,
            maxChars: args.maxChars,
            rootContext,
            exportRequired: syncState.exportRequired,
            workingTreeOutOfSync: syncState.workingTreeOutOfSync,
            outOfSyncPaths: syncState.outOfSyncPaths,
            nextStep: syncState.exportRequired
              ? 'Run docs.export before disk reads or Git commits.'
              : 'Working tree already matches the managed branch snapshot.',
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function buildDocsStatusRootContext(
  project: Project,
  options: {
    branch?: string;
    exportState?: {
      exportRequired: boolean;
      exportBlocked: boolean;
    };
    observation?: RecoveryObservationMetadata['operation'];
    readOnly?: boolean;
  } = {},
): Promise<DocsStatusRootContext> {
  const context = options.readOnly
    ? await inspectRootSafetyContextReadOnly(project, {
        requestedCwd: process.cwd(),
      })
    : await inspectRootSafetyContext(project, {
        requestedCwd: process.cwd(),
      });
  let recoveryWarnings: string[] = [];
  let previewObservationFallback: RecoveryObservationFallback | null = null;
  let observationMetadata: RecoveryObservationMetadata | null = null;

  if (options.branch && options.exportState && options.observation) {
    observationMetadata = buildRecoveryObservationMetadataFromRootContext(
      context,
      options.exportState,
      options.observation,
    );

    if (options.observation === 'preview_export') {
      previewObservationFallback = {
        branch: options.branch,
        path: '.preview-export',
        createdAt: new Date().toISOString(),
        metadata: observationMetadata,
      };
    }
  }

  let recovery = await buildRootRecoverySummary(project, context, {
    exportRequired: options.exportState?.exportRequired ?? null,
    previewObservationFallback,
    warnings: recoveryWarnings,
  });

  if (
    observationMetadata &&
    options.branch &&
    options.observation &&
    recovery.available
  ) {
    try {
      logRecoveryObservationEvent(project, options.branch, options.observation, observationMetadata);
    } catch {
      recoveryWarnings = dedupeStrings([
        ...recovery.warnings,
        'Recovery observation recording failed.',
      ]);
      recovery = {
        ...recovery,
        warnings: recoveryWarnings,
      };
    }
  }

  return {
    ...context,
    cwd: context.requestedCwd,
    recovery,
  };
}

async function buildCurrentProjectProposalRecoveryMetadata(
  project: Project,
): Promise<NonNullable<ProposalMetadata['recovery']>> {
  const identity = await loadCurrentProjectRecoveryIdentity(project);
  return {
    rootIdentityKey: identity.rootIdentityKey,
    canonicalProjectRoot: identity.canonicalProjectRoot,
    gitWorktreeRoot: identity.gitWorktreeRoot,
    gitCommonDir: identity.gitCommonDir,
    observedAt: identity.observedAt,
  };
}

async function buildCurrentProjectRecoveryObservationMetadata(
  project: Project,
  operation: RecoveryObservationMetadata['operation'],
  exportState: {
    exportRequired: boolean;
    exportBlocked: boolean;
  },
): Promise<RecoveryObservationMetadata> {
  const identity = await loadCurrentProjectRecoveryIdentity(project);
  return {
    kind: 'recovery_observation',
    operation,
    rootIdentityKey: identity.rootIdentityKey,
    canonicalProjectRoot: identity.canonicalProjectRoot,
    gitWorktreeRoot: identity.gitWorktreeRoot,
    gitCommonDir: identity.gitCommonDir,
    rootUnsafe: false,
    safeForWrites: true,
    rootMismatch: false,
    exportRequired: exportState.exportRequired,
    exportBlocked: exportState.exportBlocked,
    warnings: [],
  };
}

async function loadCurrentProjectRecoveryIdentity(project: Project): Promise<{
  rootIdentityKey: string;
  canonicalProjectRoot: string;
  gitWorktreeRoot: string | null;
  gitCommonDir: string | null;
  observedAt: string;
}> {
  const registry = await Registry.load(project.storage.configDir, project.storage.dataDir);
  const registeredProjectRoot = registry.getProject(project.projectId)?.projectRoot ?? project.root;
  const canonicalProjectRoot = normalizeExistingPath(project.root) ?? path.resolve(project.root);
  const git = await inspectGitIdentity(project.root);
  const markerRootPath = project.root;

  return {
    rootIdentityKey: buildRootLedgerIdentityKey({
      projectId: project.projectId,
      canonicalProjectRoot,
      registeredProjectRoot,
      daemonProjectRoot: null,
      markerProjectId: project.projectId,
      markerRootPath,
      gitWorktreeRoot: git.worktreeRoot,
      gitCommonDir: git.commonDir,
    }),
    canonicalProjectRoot,
    gitWorktreeRoot: git.worktreeRoot,
    gitCommonDir: git.commonDir,
    observedAt: new Date().toISOString(),
  };
}

function buildRecoveryObservationMetadataFromRootContext(
  context: RootSafetyContext,
  exportState: {
    exportRequired: boolean;
    exportBlocked: boolean;
  },
  operation: RecoveryObservationMetadata['operation'],
): RecoveryObservationMetadata {
  return {
    kind: 'recovery_observation',
    operation,
    rootIdentityKey: buildCurrentRootIdentityKey(context),
    canonicalProjectRoot: context.canonicalProjectRoot,
    gitWorktreeRoot: context.git.worktreeRoot,
    gitCommonDir: context.git.commonDir,
    rootUnsafe: !context.safety.safeForWrites,
    safeForWrites: context.safety.safeForWrites,
    rootMismatch: context.safety.rootMismatch,
    exportRequired: exportState.exportRequired,
    exportBlocked: exportState.exportBlocked,
    warnings: dedupeStrings([
      ...context.safety.warnings,
      ...context.rootLedger.warnings,
    ]),
  };
}

function buildCurrentRootIdentityKey(context: RootSafetyContext): string {
  return buildRootLedgerIdentityKey({
    projectId: context.projectId,
    canonicalProjectRoot: context.canonicalProjectRoot,
    registeredProjectRoot: context.registeredProjectRoot,
    daemonProjectRoot: context.daemonProjectRoot,
    markerProjectId: context.markerProjectId,
    markerRootPath: context.safety.markerMissing ? null : path.dirname(path.dirname(context.markerPath)),
    gitWorktreeRoot: context.git.worktreeRoot,
    gitCommonDir: context.git.commonDir,
  });
}

function logRecoveryObservationEvent(
  project: Project,
  branch: string,
  operation: RecoveryObservationMetadata['operation'],
  metadata: RecoveryObservationMetadata,
): void {
  // Recovery observations are descriptive breadcrumbs for coordinators. They
  // never relax the authoritative write/export guard in root-safety.
  project.eventLog.logEvent({
    project_id: project.projectId,
    branch,
    path: operation === 'preview_export' ? '.preview-export' : '.export',
    tool_name: operation,
    summary:
      operation === 'preview_export'
        ? `Observed preview export recovery state for branch "${branch}"`
        : `Observed export recovery state for branch "${branch}"`,
    metadata,
  });
}

async function buildRootRecoverySummary(
  project: Project,
  context: RootSafetyContext,
  options: {
    exportRequired: boolean | null;
    previewObservationFallback?: RecoveryObservationFallback | null;
    warnings?: string[];
  },
): Promise<RootRecoverySummary> {
  try {
    const currentRootIdentityKey = buildCurrentRootIdentityKey(context);
    const recoveryEvidence = await readRecoveryEvidence(
      project.storage.projectEventsPath(project.projectId),
      {
        projectId: project.projectId,
        canonicalProjectRoot: context.canonicalProjectRoot,
        registeredProjectRoot: context.registeredProjectRoot,
        daemonProjectRoot: context.daemonProjectRoot,
        markerProjectId: context.markerProjectId,
        markerRootPath: context.safety.markerMissing ? null : path.dirname(path.dirname(context.markerPath)),
        gitWorktreeRoot: context.git.worktreeRoot,
        gitCommonDir: context.git.commonDir,
      },
    );
    if (!recoveryEvidence.available) {
      return unavailableRootRecoverySummary(
        ...(options.warnings ?? []),
        'Recovery summary is currently unavailable.',
      );
    }

    const lastPreviewObservation = toRecoveryObservationSummary(
      recoveryEvidence.lastPreviewObservation?.metadata ?? options.previewObservationFallback?.metadata ?? null,
      recoveryEvidence.lastPreviewObservation?.createdAt ?? options.previewObservationFallback?.createdAt ?? null,
      recoveryEvidence.lastPreviewObservation?.branch ?? options.previewObservationFallback?.branch ?? null,
      recoveryEvidence.lastPreviewObservation?.path ?? options.previewObservationFallback?.path ?? null,
      currentRootIdentityKey,
    );
    const lastExportObservation = toRecoveryObservationSummary(
      recoveryEvidence.lastExportObservation?.metadata ?? null,
      recoveryEvidence.lastExportObservation?.createdAt ?? null,
      recoveryEvidence.lastExportObservation?.branch ?? null,
      recoveryEvidence.lastExportObservation?.path ?? null,
      currentRootIdentityKey,
    );
    const pendingProposalCount = recoveryEvidence.pendingProposalCount ?? 0;
    const currentRootProposalCount = recoveryEvidence.pendingCurrentRootProposalCount ?? 0;
    const foreignRootProposalCount = recoveryEvidence.pendingForeignRootProposalCount ?? 0;
    const unknownRootProposalCount = recoveryEvidence.pendingUnknownRootProposalCount ?? 0;

    const proposalRecoveryRequired =
      pendingProposalCount > 0 &&
      (foreignRootProposalCount > 0 || !context.safety.safeForWrites);
    const exportRecoveryRequired =
      !context.safety.safeForWrites &&
      Boolean(
        options.exportRequired ??
          lastPreviewObservation?.exportRequired ??
          lastExportObservation?.exportRequired ??
          false,
      );
    const warnings = dedupeStrings([
      ...(options.warnings ?? []),
      ...buildRecoveryWarnings({
        safeForWrites: context.safety.safeForWrites,
        pendingProposalCount,
        foreignRootProposalCount,
        unknownRootProposalCount,
        exportRecoveryRequired,
        lastPreviewObservation,
        lastExportObservation,
      }),
    ]);
    const recoveryRequired = proposalRecoveryRequired || exportRecoveryRequired;

    return {
      available: true,
      recoveryRequired,
      proposalRecoveryRequired,
      exportRecoveryRequired,
      pendingProposalCount,
      currentRootProposalCount,
      foreignRootProposalCount,
      unknownRootProposalCount,
      recommendedCleanupTool: proposalRecoveryRequired ? 'docs.discard_proposal' : null,
      nextStep: buildRecoveryNextStep({
        proposalRecoveryRequired,
        exportRecoveryRequired,
        safeForWrites: context.safety.safeForWrites,
      }),
      lastPreviewObservation,
      lastExportObservation,
      warnings,
    };
  } catch (error) {
    return unavailableRootRecoverySummary(
      ...(options.warnings ?? []),
      'Recovery summary is currently unavailable.',
    );
  }
}

function buildRecoveryWarnings(options: {
  safeForWrites: boolean;
  pendingProposalCount: number;
  foreignRootProposalCount: number;
  unknownRootProposalCount: number;
  exportRecoveryRequired: boolean;
  lastPreviewObservation: RecoveryObservationSummary | null;
  lastExportObservation: RecoveryObservationSummary | null;
}): string[] {
  const warnings: string[] = [];

  if (options.foreignRootProposalCount > 0) {
    warnings.push(
      `${options.foreignRootProposalCount} pending proposal(s) were created from a different root/worktree identity.`,
    );
  }
  if (options.unknownRootProposalCount > 0) {
    warnings.push(
      `${options.unknownRootProposalCount} pending proposal(s) do not include root recovery metadata and cannot be attributed to the current checkout.`,
    );
  }
  if (!options.safeForWrites && options.pendingProposalCount > 0) {
    warnings.push(
      'Managed writes are currently blocked; use docs.discard_proposal to retire stale pending proposals if they no longer belong to this checkout.',
    );
  }
  if (options.lastPreviewObservation?.rootUnsafe) {
    warnings.push(
      `The latest docs.preview_export observation for branch "${options.lastPreviewObservation.branch}" was recorded under an unsafe root context.`,
    );
  }
  if (options.lastExportObservation && !options.lastExportObservation.currentRoot) {
    warnings.push(
      'The latest docs.export recovery observation was recorded from a different root/worktree identity.',
    );
  }
  if (options.exportRecoveryRequired) {
    warnings.push(
      'Export drift is visible while the root context is unsafe. Use docs.preview_export for read-only inspection until write safety is restored.',
    );
  }

  return warnings;
}

function buildRecoveryNextStep(options: {
  proposalRecoveryRequired: boolean;
  exportRecoveryRequired: boolean;
  safeForWrites: boolean;
}): string | null {
  if (options.proposalRecoveryRequired) {
    return 'Use docs.list_proposals to inspect pending work and docs.discard_proposal to clean up stale proposals.';
  }
  if (options.exportRecoveryRequired) {
    return options.safeForWrites
      ? 'Run docs.export once you are ready to reconcile managed changes to disk.'
      : 'Use docs.preview_export for read-only inspection, then restore root safety before running docs.export.';
  }

  return null;
}

function unavailableRootRecoverySummary(...warnings: string[]): RootRecoverySummary {
  return {
    available: false,
    recoveryRequired: null,
    proposalRecoveryRequired: null,
    exportRecoveryRequired: null,
    pendingProposalCount: null,
    currentRootProposalCount: null,
    foreignRootProposalCount: null,
    unknownRootProposalCount: null,
    recommendedCleanupTool: null,
    nextStep: null,
    lastPreviewObservation: null,
    lastExportObservation: null,
    warnings: dedupeStrings(warnings),
  };
}

function toRecoveryObservationSummary(
  metadata: RecoveryObservationMetadata | null,
  observedAt: string | null,
  branch: string | null,
  observedPath: string | null,
  currentRootIdentityKey: string,
): RecoveryObservationSummary | null {
  if (!metadata || !observedAt || !branch || !observedPath) {
    return null;
  }

  return {
    observedAt,
    branch,
    path: observedPath,
    rootIdentityKey: metadata.rootIdentityKey,
    canonicalProjectRoot: metadata.canonicalProjectRoot,
    gitWorktreeRoot: metadata.gitWorktreeRoot,
    gitCommonDir: metadata.gitCommonDir,
    rootUnsafe: metadata.rootUnsafe,
    safeForWrites: metadata.safeForWrites,
    rootMismatch: metadata.rootMismatch,
    exportRequired: metadata.exportRequired,
    exportBlocked: metadata.exportBlocked,
    currentRoot: metadata.rootIdentityKey === currentRootIdentityKey,
    warnings: metadata.warnings,
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildProjectIdentityNextStep(context: DocsStatusRootContext): string {
  if (!context.safety.safeForWrites) {
    const nextSteps = [
      'Run docs.status to inspect rootContext.',
      'Run xurgo-atlas mcp-config --json from the intended project root.',
      'Restore the expected root/worktree binding before running managed-doc writes or exports.',
    ];

    if (context.recovery.nextStep) {
      nextSteps.push(context.recovery.nextStep);
    }

    return nextSteps.join(' ');
  }

  if (context.recovery.nextStep) {
    return context.recovery.nextStep;
  }

  return 'Root identity is currently safe for managed writes and exports.';
}

async function buildManagedStateProvenance(
  project: Project,
  rootContext: DocsStatusRootContext,
): Promise<Record<string, unknown>> {
  const observedAt = new Date().toISOString();
  const sourceBranch = rootContext.git.branch;
  const sourceHead = rootContext.git.head;
  const managedBranch = sourceBranch;
  const managedRevision = managedBranch
    ? await project.gitStore.getBranchHead(managedBranch)
    : null;
  const syncState = managedBranch && managedRevision !== null
    ? await getManagedWorkingTreeSyncState(project, managedBranch)
    : null;

  return {
    observation: {
      observedAt,
      lifecycle: 'atlas.project_identity.read-only',
      currentState: true,
      durableHistory: false,
    },
    project: {
      projectId: rootContext.projectId,
      projectRoot: rootContext.projectRoot,
      canonicalProjectRoot: rootContext.canonicalProjectRoot,
    },
    checkout: {
      canonicalProjectRoot: rootContext.canonicalProjectRoot,
      gitWorktreeRoot: rootContext.git.worktreeRoot,
      gitCommonDir: rootContext.git.commonDir,
    },
    source: {
      branch: sourceBranch,
      head: sourceHead,
    },
    managed: {
      branch: managedBranch,
      revision: managedRevision,
      availability:
        managedBranch === null
          ? 'unknown'
          : managedRevision === null
            ? 'missing'
            : 'available',
    },
    synchronization: {
      status:
        syncState === null
          ? 'unknown'
          : syncState.exportRequired
            ? 'out_of_sync'
            : 'in_sync',
      exportRequired: syncState?.exportRequired ?? null,
      workingTreeOutOfSync: syncState?.workingTreeOutOfSync ?? null,
      outOfSyncPaths: syncState?.outOfSyncPaths ?? null,
    },
    safety: rootContext.safety,
    rootLedger: rootContext.rootLedger,
    recovery: rootContext.recovery,
    pendingProposals: {
      available: rootContext.recovery.available,
      pendingProposalCount: rootContext.recovery.pendingProposalCount,
      currentRootProposalCount: rootContext.recovery.currentRootProposalCount,
      foreignRootProposalCount: rootContext.recovery.foreignRootProposalCount,
      unknownRootProposalCount: rootContext.recovery.unknownRootProposalCount,
    },
  };
}

// ── docs.manifest handler ──────────────────────────────────────────────

export async function handleManifest(project: Project, rawArgs: Record<string, unknown>) {
  const args = ManifestSchema.parse(rawArgs);
  const missingBranch = await managedBranchMissingError(project, args.branch);
  if (missingBranch) {
    return missingBranch;
  }
  const manifestPath = 'docs/manifest.yml';

  // Read docs/manifest.yml from the managed store
  const { content, revision } = await project.readFile(args.branch, manifestPath);

  if (content === null) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'docs/manifest.yml not found',
              projectId: project.projectId,
              branch: args.branch,
              path: manifestPath,
              hint: 'Run xurgo-atlas init to create project documentation structure (docs/manifest.yml)',
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  // Parse YAML
  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(content) as Record<string, unknown>;
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'Invalid YAML in docs/manifest.yml',
              projectId: project.projectId,
              branch: args.branch,
              path: manifestPath,
              details: err instanceof Error ? err.message : String(err),
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  // Extract documents and entrypoints (gracefully handle missing/malformed data)
  const documents: unknown[] = Array.isArray(parsed?.documents) ? parsed.documents as unknown[] : [];
  const entrypoints: unknown[] = Array.isArray(parsed?.entrypoints) ? parsed.entrypoints as unknown[] : [];
  let artifacts: unknown[];
  try {
    artifacts = parseArtifactManifestEntries(parsed?.artifacts);
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'Invalid artifacts[] in docs/manifest.yml',
              projectId: project.projectId,
              branch: args.branch,
              path: manifestPath,
              details: err instanceof Error ? err.message : String(err),
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  // Apply maxDocuments truncation
  let truncated = false;
  let processedDocuments = documents;
  if (args.maxDocuments && documents.length > args.maxDocuments) {
    processedDocuments = documents.slice(0, args.maxDocuments);
    truncated = true;
  }

  // Collect all paths for validation (from both entrypoints and documents)
  const allReferencedPaths: string[] = [];
  for (const ep of entrypoints) {
    const p = (ep as Record<string, unknown>)?.path;
    if (typeof p === 'string' && p) allReferencedPaths.push(p);
  }
  for (const doc of processedDocuments) {
    const p = (doc as Record<string, unknown>)?.path;
    if (typeof p === 'string' && p) allReferencedPaths.push(p);
  }
  for (const artifact of artifacts) {
    const p = (artifact as Record<string, unknown>)?.path;
    if (typeof p === 'string' && p) allReferencedPaths.push(p);
  }

  // Path validation (lightweight: use git ls-tree to list all tracked files)
  let missingPaths: string[] = [];
  let valid = true;
  const warnings: string[] = [];
  if (args.validatePaths) {
    const trackedFiles = await project.gitStore.listFiles(args.branch);
    const trackedSet = new Set(trackedFiles);
    missingPaths = allReferencedPaths.filter((p) => !trackedSet.has(p));
    valid = missingPaths.length === 0;
  }

  // Build the response
  const response: Record<string, unknown> = {
    projectId: project.projectId,
    path: manifestPath,
    branch: args.branch,
    revision,
    version: parsed?.version ?? null,
    entrypoints,
    documents: processedDocuments,
    artifacts,
    documentCount: processedDocuments.length,
    totalDocumentCount: documents.length,
    artifactCount: artifacts.length,
    truncated,
  };

  // Optionally include raw YAML
  if (args.includeRaw) {
    response.raw = content;
  }

  // Optionally include path validation result
  if (args.validatePaths) {
    response.validation = {
      valid,
      missingPaths,
    };
    if (warnings.length > 0) {
      (response.validation as Record<string, unknown>).warnings = warnings;
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(response, null, 2),
      },
    ],
  };
}

// ── docs.context_pack handler ─────────────────────────────────────────

type ContextPackItemKind = 'status' | 'agents' | 'manifest' | 'section' | 'document';

interface ContextPackItem {
  kind: ContextPackItemKind;
  path: string;
  heading?: string;
  matchedHeading?: string;
  level?: number;
  occurrence?: number;
  startLine?: number;
  endLine?: number;
  content: string;
  returnedChars: number;
  totalChars: number;
  truncated: boolean;
  revision: string | null;
  missing?: boolean;
  error?: string;
  manifest?: Record<string, unknown>;
}

interface ContextReadResult {
  content: string | null;
  revision: string | null;
}

export async function handleContextPack(project: Project, rawArgs: Record<string, unknown>) {
  const args = ContextPackSchema.parse(rawArgs);
  const missingBranch = await managedBranchMissingError(project, args.branch);
  if (missingBranch) {
    return missingBranch;
  }

  const validationError = await validateContextPackPaths(
    project,
    args.branch,
    args.paths,
    args.sections,
  );
  if (validationError) {
    return validationError;
  }

  const items: ContextPackItem[] = [];
  const seenDocuments = new Set<string>();
  const packRevision = args.revision ?? await project.gitStore.getBranchHead(args.branch);
  let returnedChars = 0;
  let truncated = false;
  let manifestData: Record<string, unknown> | null = null;

  const addItem = (item: Omit<ContextPackItem, 'content' | 'returnedChars' | 'truncated'> & { content?: string; maxChars?: number }): void => {
    const content = item.content ?? '';
    const bounded = sliceForContextPack(content, args.maxChars, returnedChars, item.maxChars);
    const { maxChars: _itemMaxChars, ...packItem } = item;
    returnedChars += bounded.returnedChars;
    truncated = truncated || bounded.truncated;

    items.push({
      ...packItem,
      content: bounded.content,
      returnedChars: bounded.returnedChars,
      truncated: bounded.truncated,
    });
  };

  if (args.includeStatus) {
    const status = await readContextFile(project, args.branch, args.revision, 'STATUS.md');
    if (status.content === null) {
      addItem(missingContextItem('status', 'STATUS.md', status.revision, 'STATUS.md not found'));
    } else {
      addItem({
        kind: 'status',
        path: 'STATUS.md',
        revision: status.revision,
        content: status.content,
        totalChars: status.content.length,
      });
    }
  }

  if (args.includeAgents) {
    const agents = await readContextFile(project, args.branch, args.revision, 'AGENTS.md');
    if (agents.content === null) {
      addItem(missingContextItem('agents', 'AGENTS.md', agents.revision, 'AGENTS.md not found'));
    } else {
      addItem({
        kind: 'agents',
        path: 'AGENTS.md',
        revision: agents.revision,
        content: agents.content,
        totalChars: agents.content.length,
      });
    }
  }

  if (args.includeManifest) {
    const manifest = await readContextFile(project, args.branch, args.revision, 'docs/manifest.yml');
    if (manifest.content === null) {
      addItem(missingContextItem('manifest', 'docs/manifest.yml', manifest.revision, 'docs/manifest.yml not found'));
    } else {
      try {
        manifestData = parseManifestForContextPack(manifest.content, args.maxDocuments);
        addItem({
          kind: 'manifest',
          path: 'docs/manifest.yml',
          revision: manifest.revision,
          content: manifest.content,
          totalChars: manifest.content.length,
          manifest: manifestData,
        });
      } catch (err) {
        addItem({
          kind: 'manifest',
          path: 'docs/manifest.yml',
          revision: manifest.revision,
          content: manifest.content,
          totalChars: manifest.content.length,
          missing: true,
          error: `Invalid YAML in docs/manifest.yml: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } else {
    const manifest = await readContextFile(project, args.branch, args.revision, 'docs/manifest.yml');
    if (manifest.content !== null) {
      try {
        manifestData = parseManifestForContextPack(manifest.content, args.maxDocuments);
      } catch {
        manifestData = null;
      }
    }
  }

  for (const sectionRequest of args.sections) {
    const sectionFile = await readContextFile(project, args.branch, args.revision, sectionRequest.path);
    if (sectionFile.content === null) {
      addItem(missingContextItem('section', sectionRequest.path, sectionFile.revision, `File "${sectionRequest.path}" not found`, sectionRequest.heading));
      continue;
    }

    const section = findMarkdownSection(sectionFile.content, {
      heading: sectionRequest.heading,
      level: sectionRequest.level,
      occurrence: sectionRequest.occurrence,
      includeHeading: sectionRequest.includeHeading,
    });

    if (!section) {
      addItem(missingContextItem('section', sectionRequest.path, sectionFile.revision, `Heading "${sectionRequest.heading}" not found in "${sectionRequest.path}"`, sectionRequest.heading));
      continue;
    }

    addItem({
      kind: 'section',
      path: sectionRequest.path,
      heading: sectionRequest.heading,
      matchedHeading: section.matchedHeading,
      level: section.level,
      occurrence: sectionRequest.occurrence,
      startLine: section.startLine,
      endLine: section.endLine,
      revision: sectionFile.revision,
      content: applyOffset(section.content, sectionRequest.offset),
      totalChars: section.content.length,
      maxChars: sectionRequest.maxChars,
    });
  }

  const hasExplicitContent = args.paths.length > 0 || args.sections.length > 0;
  const documentPaths = args.paths.length > 0
    ? args.paths
    : hasExplicitContent
      ? []
      : getManifestGuidedContextPaths(manifestData);
  const boundedDocumentPaths = args.maxDocuments
    ? documentPaths.slice(0, args.maxDocuments)
    : documentPaths;
  if (documentPaths.length > boundedDocumentPaths.length) {
    truncated = true;
  }

  for (const documentPath of boundedDocumentPaths) {
    if (seenDocuments.has(documentPath)) {
      continue;
    }
    seenDocuments.add(documentPath);

    const document = await readContextFile(project, args.branch, args.revision, documentPath);
    if (document.content === null) {
      addItem(missingContextItem('document', documentPath, document.revision, `File "${documentPath}" not found`));
      continue;
    }

    addItem({
      kind: 'document',
      path: documentPath,
      revision: document.revision,
      content: document.content,
      totalChars: document.content.length,
    });
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            projectId: project.projectId,
            branch: args.branch,
            revision: packRevision,
            maxChars: args.maxChars ?? null,
            returnedChars,
            truncated,
            items,
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function handleCapabilities() {
  const corpusDiscovery = new GovernanceCorpusDiscovery();
  const corpus = corpusDiscovery.discover();

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            service: 'xurgo-atlas',
            capabilitiesVersion: 1,
            scope: {
              managedDocsOnly: true,
              projectContextOnly: true,
            },
            tools: {
              status: true,
              manifest: true,
              read: true,
              readSection: true,
              contextPack: true,
              projectIdentity: true,
              guardedWrites: true,
              exportPreview: true,
              proposalCleanup: true,
              search: true,
              semanticSearch: false,
            },
            retrieval: {
              lexical: {
                available: true,
                plannedTool: 'docs.search',
                plannedBackend: 'sqlite-fts',
                scope: 'atlas-managed-docs',
              },
              semantic: {
                available: false,
                plannedTool: 'docs.semantic_search',
                plannedBackend: 'optional-local-sqlite-vector-extension',
                required: false,
              },
              externalVectorDatabaseDefault: false,
            },
            governance: {
              corpusAvailable: corpus !== null,
              documentCount: corpus?.metadata.totalDocuments || 0,
              categories: corpus?.metadata.categories || [],
              tools: [
                'governance.search',
                'governance.context',
                'governance.lookup',
                'governance.list',
                'governance.lifecycle',
              ],
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleAtlasProjectIdentity(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  AtlasProjectIdentitySchema.parse(rawArgs);

  const rootContext = await buildDocsStatusRootContext(project, { readOnly: true });
  const managedStateProvenance = await buildManagedStateProvenance(project, rootContext);
  const warnings = dedupeStrings([
    ...rootContext.safety.warnings,
    ...rootContext.rootLedger.warnings,
    ...rootContext.recovery.warnings,
  ]);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            projectId: project.projectId,
            requestedCwd: rootContext.requestedCwd,
            projectRoot: rootContext.projectRoot,
            canonicalProjectRoot: rootContext.canonicalProjectRoot,
            registeredProjectRoot: rootContext.registeredProjectRoot,
            daemonProjectRoot: rootContext.daemonProjectRoot,
            marker: {
              path: rootContext.markerPath,
              projectId: rootContext.markerProjectId,
              present: !rootContext.safety.markerMissing,
              matchesProject:
                !rootContext.safety.markerMissing && !rootContext.safety.markerMismatch,
            },
            git: {
              available: rootContext.git.insideWorkTree,
              insideWorkTree: rootContext.git.insideWorkTree,
              worktreeRoot: rootContext.git.worktreeRoot,
              commonDir: rootContext.git.commonDir,
              branch: rootContext.git.branch,
              head: rootContext.git.head,
            },
            safety: rootContext.safety,
            rootLedger: rootContext.rootLedger,
            recovery: rootContext.recovery,
            managedStateProvenance,
            warnings,
            nextStep: buildProjectIdentityNextStep(rootContext),
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleAtlasProjectRegistrationProposal(rawArgs: Record<string, unknown>) {
  const args = AtlasProjectRegistrationProposalSchema.parse(rawArgs);
  const proposal = await buildProjectRegistrationProposal({
    projectId: args.projectId,
    projectRoot: args.projectRoot,
    cwd: args.cwd,
    configDir: args.configDir,
    dataDir: args.dataDir,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(proposal, null, 2),
      },
    ],
  };
}

async function handleSearch(project: Project, rawArgs: Record<string, unknown>) {
  const args = SearchSchema.parse(rawArgs);
  const searchIndex = new DocsSearchIndex(project.storage.projectSearchPath(project.projectId));
  try {
    const result = await searchIndex.search(project, args.branch, args.query, args.limit);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } finally {
    searchIndex.close();
  }
}

function validateContextPackPaths(
  project: Project,
  branch: string,
  paths: string[],
  sections: Array<z.infer<typeof ContextPackSectionSchema>>,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} | null> {
  const explicitPaths = [
    ...paths,
    ...sections.map((section) => section.path),
  ];

  return validateContextPackPathsAsync(project, branch, explicitPaths);
}

async function validateContextPackPathsAsync(
  project: Project,
  branch: string,
  explicitPaths: string[],
) {
  for (const filePath of explicitPaths) {
    if (isPathTraversal(filePath)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `Path traversal detected: "${filePath}" is outside the project scope`,
              path: filePath,
            }),
          },
        ],
        isError: true,
      };
    }

    if (!(await project.isPathOwned(branch, filePath))) {
      return ownedPathError(project.projectId, filePath, branch);
    }
  }

  return null;
}

function ownedPathError(projectId: string, filePath: string, branch: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: `Path "${filePath}" is not in the list of Atlas-owned managed documents`,
          projectId,
          path: filePath,
          branch,
        }),
      },
    ],
    isError: true,
  };
}

async function managedBranchMissingError(
  project: Project,
  branch: string,
): Promise<
  | {
      content: Array<{ type: 'text'; text: string }>;
      isError: true;
    }
  | null
> {
  const branchExists = await project.gitStore.branchExists(branch);
  if (branchExists) {
    return null;
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: `Managed docs branch "${branch}" does not exist`,
          projectId: project.projectId,
          branch,
          hint: `Managed docs branches are separate from the source repo branch. Create "${branch}" with docs.create_branch or use an existing managed branch.`,
        }),
      },
    ],
    isError: true,
  };
}

async function readContextFile(
  project: Project,
  branch: string,
  revision: string | undefined,
  filePath: string,
): Promise<ContextReadResult> {
  if (revision) {
    return {
      content: await project.gitStore.readFileAtRevision(revision, filePath),
      revision,
    };
  }

  return project.readFile(branch, filePath);
}

function sliceForContextPack(
  content: string,
  maxChars: number | undefined,
  usedChars: number,
  itemMaxChars?: number,
): { content: string; returnedChars: number; truncated: boolean } {
  const packRemaining = maxChars === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, maxChars - usedChars);
  const itemLimit = itemMaxChars ?? Number.POSITIVE_INFINITY;
  const limit = Math.min(packRemaining, itemLimit);

  if (content.length > limit) {
    const sliced = content.slice(0, limit);
    return {
      content: sliced,
      returnedChars: sliced.length,
      truncated: true,
    };
  }

  return {
    content,
    returnedChars: content.length,
    truncated: false,
  };
}

function applyOffset(content: string, offset: number): string {
  if (offset <= 0) {
    return content;
  }
  return content.slice(offset);
}

function missingContextItem(
  kind: ContextPackItemKind,
  path: string,
  revision: string | null,
  error: string,
  heading?: string,
): Omit<ContextPackItem, 'content' | 'returnedChars' | 'truncated'> & { content?: string } {
  return {
    kind,
    path,
    heading,
    revision,
    content: '',
    totalChars: 0,
    missing: true,
    error,
  };
}

function parseManifestForContextPack(content: string, maxDocuments?: number): Record<string, unknown> {
  const parsed = YAML.parse(content) as Record<string, unknown>;
  const documents = Array.isArray(parsed?.documents)
    ? parsed.documents as unknown[]
    : [];
  const processedDocuments = maxDocuments
    ? documents.slice(0, maxDocuments)
    : documents;

  return {
    version: parsed?.version ?? null,
    entrypoints: Array.isArray(parsed?.entrypoints) ? parsed.entrypoints : [],
    documents: processedDocuments,
    documentCount: processedDocuments.length,
    totalDocumentCount: documents.length,
    truncated: processedDocuments.length < documents.length,
  };
}

function getManifestGuidedContextPaths(manifestData: Record<string, unknown> | null): string[] {
  if (!manifestData || !Array.isArray(manifestData.documents)) {
    return [];
  }

  const skip = new Set(['STATUS.md', 'AGENTS.md', 'docs/manifest.yml']);
  const paths: string[] = [];
  for (const document of manifestData.documents) {
    const filePath = (document as Record<string, unknown>)?.path;
    if (typeof filePath !== 'string' || skip.has(filePath)) {
      continue;
    }
    paths.push(filePath);
  }

  return paths;
}

// ── Governance Tool Handlers ───────────────────────────────────────────

import { GovernanceSearchIndex } from '../core/governance-search.js';
import { GovernanceContextAssembler } from '../core/governance-context.js';
import { GovernanceLifecycleTracker } from '../core/governance-lifecycle.js';
import { GovernanceCorpusDiscovery } from '../core/governance-corpus.js';

async function handleGovernanceSearch(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = GovernanceSearchSchema.parse(rawArgs);
  const searchIndex = new GovernanceSearchIndex();

  try {
    await searchIndex.index();
    const results = searchIndex.search(args.query, args.category, args.limit);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  } finally {
    searchIndex.close();
  }
}

async function handleGovernanceContext(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = GovernanceContextSchema.parse(rawArgs);
  const assembler = new GovernanceContextAssembler();

  try {
    const context = await assembler.assembleContext(args.taskDescription, args.maxChars);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(context, null, 2),
        },
      ],
    };
  } finally {
    assembler.close();
  }
}

async function handleGovernanceLookup(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = GovernanceLookupSchema.parse(rawArgs);
  const corpusDiscovery = new GovernanceCorpusDiscovery();
  const document = corpusDiscovery.getDocumentById(args.documentId);

  if (!document) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Governance document not found: ${args.documentId}`,
          }),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(document, null, 2),
      },
    ],
  };
}

async function handleGovernanceList(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = GovernanceListSchema.parse(rawArgs);
  const corpusDiscovery = new GovernanceCorpusDiscovery();
  const corpus = corpusDiscovery.discover();

  if (!corpus) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'Governance corpus not available',
          }),
        },
      ],
      isError: true,
    };
  }

  let documents = corpus.documents;
  if (args.category) {
    documents = documents.filter(doc => doc.type === args.category);
  }

  const documentList = documents.map(doc => ({
    id: doc.id,
    title: doc.title,
    path: doc.path,
    type: doc.type,
    status: doc.status,
    tags: doc.tags,
    wordCount: doc.wordCount,
    lastModified: doc.lastModified,
  }));

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          totalDocuments: documentList.length,
          category: args.category || 'all',
          documents: documentList,
        }, null, 2),
      },
    ],
  };
}

async function handleGovernanceLifecycle(
  project: Project,
  rawArgs: Record<string, unknown>,
) {
  const args = GovernanceLifecycleSchema.parse(rawArgs);
  const lifecycleTracker = new GovernanceLifecycleTracker();
  const lifecycle = lifecycleTracker.getDocumentLifecycle(args.documentId);

  if (!lifecycle) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Governance document not found: ${args.documentId}`,
          }),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(lifecycle, null, 2),
      },
    ],
  };
}

// ── Front matter parser ────────────────────────────────────────────────

/**
 * Parse YAML front matter from a Markdown file.
 *
 * Expects content in the format:
 *   ---
 *   key: value
 *   ---
 *   body text
 *
 * Returns the parsed front matter object, raw YAML text, and body.
 * If no valid front matter is found, returns null values and the full content as body.
 */
export function parseFrontMatter(content: string): {
  frontMatter: Record<string, unknown> | null;
  rawFrontMatter: string | null;
  body: string;
} {
  const lines = content.split('\n');
  if (lines.length < 3 || lines[0].trim() !== '---') {
    return { frontMatter: null, rawFrontMatter: null, body: content };
  }

  // Find closing ---
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return { frontMatter: null, rawFrontMatter: null, body: content };
  }

  const rawYaml = lines.slice(1, endIdx).join('\n');
  const body = lines.slice(endIdx + 1).join('\n');

  try {
    const parsed = YAML.parse(rawYaml);
    return {
      frontMatter: (parsed as Record<string, unknown>) ?? null,
      rawFrontMatter: rawYaml,
      body,
    };
  } catch {
    return { frontMatter: null, rawFrontMatter: rawYaml, body };
  }
}
