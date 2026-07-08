# Changelog


## 0.4.0 - 2026-07-07

### Added

- Added the guarded artifact-registration commit flow for approved artifact registration proposals.
- Added durable audit coverage and validation around artifact registration commits.
- Expanded MCP metadata coverage for guarded artifact registration behavior.

## v0.2.1 (2026-06-20)

**README and release-facing documentation recovery.**

- Restored the packaged README and related release-facing documentation guidance so the published `0.2.1` package reflects the current public instructions accurately.

## v0.2.0 (2026-06-19)

**Release prep for root-safe workflows, project identity, and validation hardening.**

### Features

- Added stable `xurgo-atlas -v` and `xurgo-atlas --version` output for clean consumer CLI version checks.
- Added optional `atlas.project_identity`, a read-only MCP tool for project/root binding, Git identity, and root-safety visibility.
- Added `docs.preview_export`, a read-only preview of managed-doc export drift, overwrite risk, and next-step guidance.
- Added proposal cleanup surfaces with `docs.list_proposals` and `docs.discard_proposal` for stale uncommitted work.

### Workflow

- Expanded `xurgo-atlas mcp-config --json` and `docs.status` with root/worktree context, `safeForWrites`, and recovery guidance for safer managed-doc lifecycle decisions.
- Hardened guarded write/export behavior so ambiguous or unsafe root contexts fail closed while supported safe-root workflows stay compatible.
- Clarified install, first-run, daemon/MCP, and contributor workflow guidance, including live discovery and managed-doc drift handling.
- Hardened Node 22 clean-checkout validation so `validate:full` builds before tests and release-style checks exercise real built CLI artifacts.

### Notes

- Remediated the transitive Hono advisory in the published dependency set without changing intended package behavior.
- This release remains backward-compatible for normal initialized Atlas workflows; the new root/worktree guardrails mainly affect ambiguous or mismatched checkouts.

## v0.1.2 (2026-06-16)

**Public release prep for Atlas docs lifecycle and search updates.**

### Features

- Added the `docs.capabilities` MCP tool for capability discovery.
- Added `docs.search`, a lexical local SQLite FTS search tool scoped to Atlas-managed docs and related context only.
- Kept semantic search unavailable and reported as `false`.
- Kept external vector, cloud, Docker, embedding daemon, and other remote search backends unnecessary.
- Allowed guarded `docs.propose_document` creation for `docs/spec/*.md` alongside `docs/atlas/*.md`.

### Workflow

- Clarified the Node 22 validation workflow, including `nvm use --silent 22`.
- Improved guarded docs lifecycle guidance so `docs.commit_patch` is understood to update Atlas-managed state while working-tree files may remain stale until `docs.export`.
- Documented lifecycle signals such as `exportRequired`, `workingTreeOutOfSync`, `outOfSyncPaths`, and `nextStep`.
- Clarified that `docs.export` should run before disk reads, Git commits, release prep, or publishing when managed state and the working tree are out of sync.

### Notes

- Public-facing docs stay generic and avoid overstating Agent or Studio integration.
- This release does not require Qdrant, sqlite-vec, cloud vector search, Docker, embedding daemons, or any external network service.

## v0.1.1 (2026-06-11)

**Docs/package-page correction release.**

- Updated the public README to lead with npm installation instead of private RC tarball testing.
- Removed stale private RC and "public npm future" wording from the primary quick start.
- Clarified the README install guidance so global CLI install is the primary path and `npx` / project-local usage are secondary options.
- Clarified `mcp-config --json` as the machine-readable MCP integration contract.
- Fixed managed-document repair so `docs.propose_document` can recreate a missing managed file when the manifest entry already exists.
- Kept private RC bundle guidance only as maintainer-oriented release context.

## v0.1.0 (2026-05-30)

**MVP release — safe, versioned, auditable documentation management for AI-assisted projects.**

### Features

- **`docu-guard init`** — Initializes a project with Git-backed store, SQLite event log, policy file, starter docs, and AGENTS.md safety rules.
- **`docu-guard server`** — Starts an MCP server on stdio exposing all tools and resources.
- **`docs.list`** — Lists tracked documentation files with per-file revision and protected status.
- **`docs.read`** — Reads a documentation file and returns its content with a stable revision hash.
- **`docs.create_branch`** — Creates an agent branch from any source branch.
- **`docs.propose_patch`** — Validates and stores a patch proposal; returns a `proposalId` for review and commit.
- **`docs.preview_diff`** — Previews the stored diff, risk level, and approval requirements for a proposal.
- **`docs.commit_patch`** — Commits a stored proposal; re-validates the base revision; requires `riskOverride: "accept"` for high-risk patches.
- **`docs.history`** — Returns unified history (Git + event log merged) for a documentation file.
- **`docs.restore_file`** — Restores a file to a previous revision from history.
- **`docs.export`** — Exports documentation from a branch to the project working tree.
- **CLI commands** — `list`, `history`, `export` with enriched output formats.
- **5 MCP resources** — `manifest`, `HEAD/{path}`, `branch/{branch}/{path}`, `history/{path}`, `policy`.

### Safety & Validation

- Base revision matching — rejects stale patches.
- Path traversal prevention — blocks `../`, absolute paths, empty segments.
- Risk detection — large deletions (>25%), heading removal, full-file replacement, patch-only deletions.
- Protected file flagging — AGENTS.md and `.docs-policy.yml` modifications require special approval.
- **AGENTS.md intent validation** — intent or summary must reference safety/agent rule keywords.
- Forbidden operations — silent delete, whole-file replace without base revision, overwrite without diff.
- Uninitialized project detection — clear error on all CLI commands.

### Proposal Storage

- `doc_proposals` SQLite table with full CRUD and lifecycle (`pending` → `committed` / `rejected` / `stale`).
- Stale base revision auto-marks proposals as stale.
- Multi-step workflow: propose → preview → commit.

### Testing

- 25 tests covering all tools, validation rules, risk detection, proposal lifecycle, and AGENTS.md intent checks.
- All tests pass; TypeScript compiles cleanly.

### Dogfooding

- docu-guard-mcp successfully managed its own documentation via the MCP protocol.
- Full workflow verified: `list` → `read` → `create_branch` → `propose_patch` → `preview_diff` → `commit_patch`.
- Stale proposal rejection, file restore from history, and working-tree export all verified against the server.
- 10 events logged across all operations.

### Known Limitations

- Single-file patches only.
- No web review UI.
- No merge tool — branches must be merged manually.
- No file watcher for direct writes.
- Node.js 22+ required (uses built-in `node:sqlite`).
