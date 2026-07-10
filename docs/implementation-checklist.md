# Xurgo Atlas — Implementation Checklist

> Last updated: 2026-06-22 (current-state alignment for Atlas release-baseline work)
> Status: **The live repository is an Atlas-branded `xurgo-atlas` v0.4.0 baseline; current priority is to preserve that baseline, while older private-RC and naming-migration checkpoints remain below as historical implementation record**
>
> Current state:
> - Product name and package metadata now point to **Xurgo Atlas** / `xurgo-atlas`.
> - Current delivery priority is to keep a credible Atlas release baseline intact with accurate governed docs, stable CLI/MCP behavior, and recent read-only diagnostic/provenance surfaces.
> - Historical references to `docu-guard` or older milestone plans are preserved below when they describe the implementation history at the time rather than the current headline.

---

## Current Release Baseline

| Area | Current state | Notes |
|------|---------------|-------|
| Product identity | ✅ Current | User-facing product name is **Xurgo Atlas**; package metadata is `xurgo-atlas` |
| Package baseline | ✅ Current | `package.json` reports version `0.4.0`; verify the exact live checkout identity from Git instead of freezing a SHA in this checklist |
| Release posture | ✅ Current | Focus is preserving a credible baseline first, not reopening the June private RC checkpoint as the standing current focus |
| Recent baseline-preserving additions | ✅ Current | Read-only `doctor`, managed-state/provenance reporting, internal client conformance checks, and `docs.search` are already landed on `main` |
| Historical checkpoints | ℹ️ Historical | Private RC readiness, storage migration readiness, and naming-migration planning remain useful record but are not the primary current work queue |

## PRD Acceptance Criteria

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | User can `docu-guard init` | ✅ Complete | Creates `.docu-guard/`, Git bare repo, SQLite DB, policy, docs, AGENTS.md |
| 2 | Server starts with `docu-guard server` | ✅ Complete | MCP server on stdio with all tools registered |
| 3 | MCP client can call `docs.read` | ✅ Complete | Returns content + revision hash |
| 4 | `docs.read` returns content + stable revision | ✅ Complete | Revision is the Git commit hash for the file |
| 5 | Client can create an agent branch | ✅ Complete | `docs.create_branch` with `from` parameter |
| 6 | Client can propose a patch with `baseRevision` | ✅ Complete | `docs.propose_patch` validates and stores proposal |
| 7 | Server rejects stale `baseRevision` | ✅ Complete | Returns clear "Base revision mismatch" error |
| 8 | Server rejects path traversal | ✅ Complete | Detects `../`, absolute paths, empty segments |
| 9 | Server detects large deletions as high risk | ✅ Complete | Threshold: 25% (configurable in policy) |
| 10 | Server commits valid patches | ✅ Complete | Applies patch, creates Git commit |
| 11 | Every commit creates an event log record | ✅ Complete | SQLite `doc_events` table |
| 12 | User can view file history | ✅ Complete | Unified `history` array (git + event log merged) |
| 13 | User can restore file from old revision | ✅ Complete | `docs.restore_file` with `intent` required |
| 14 | User can export docs to working tree | ✅ Complete | `docs.export` with `exported: true` + `files` |
| 15 | AGENTS.md contains safety rules | ✅ Complete | Appended or created during `init` |

---

## MCP Tools

| Tool | Status | Notes |
|------|--------|-------|
| `docs.list` | ✅ Complete | Returns Atlas-owned docs only using curated ownership, separate from policy `protected_paths` |
| `docs.read` | ✅ Complete | Content + revision hash; bounded reads with `maxChars`/`offset`; `truncated`, `returnedChars`, `totalChars`; owned-scope reads use curated Atlas ownership |
| `docs.read_section` | ✅ Complete | Reads one Markdown section by heading; supports `level`, `occurrence`, `includeHeading`, `maxChars`, and `offset` |
| `docs.context_pack` | ✅ Complete | Assembles STATUS.md, AGENTS.md, manifest data, requested sections/paths, and manifest-guided owned docs within a total `maxChars` budget |
| `docs.create_branch` | ✅ Complete | `from` parameter, returns `created: true` |
| `docs.propose_patch` | ✅ Complete | Stores proposal, returns `proposalId` |
| `docs.propose_document` | ✅ Complete | Create-only mode (`"create"`) for new Markdown docs under `docs/atlas/**`; proposal also updates `docs/manifest.yml` |
| `docs.preview_diff` | ✅ Complete | Looks up by `proposalId`, returns diff + risk |
| `docs.list_proposals` | ✅ Complete | Lists pending proposals by default and can broaden to historical proposal states for audit and cleanup workflows |
| `docs.discard_proposal` | ✅ Complete | Retires uncommitted proposals by exact proposal id while preserving audit history |
| `docs.commit_patch` | ✅ Complete | Commits by `proposalId`, accepts `actor`, `riskOverride` |
| `docs.preview_export` | ✅ Complete | Read-only reconciliation preview for managed-to-source export drift before running `docs.export` |
| `docs.history` | ✅ Complete | Unified history array (git + events) |
| `docs.restore_file` | ✅ Complete | Requires `intent`, returns `restored: true` |
| `docs.export` | ✅ Complete | Returns `exported: true` + `files` |
| `docs.search` | ✅ Complete | Local SQLite FTS search over Atlas-managed docs/context with scoped lexical matches, snippets, and line metadata |
| `docs.capabilities` | ✅ Complete | Read-only capability summary with `search: true` and `semanticSearch: false` |

---

## MCP Resources

| Resource URI | Status | Notes |
|-------------|--------|-------|
| `docs://project/{id}/manifest` | ✅ Complete | JSON list of tracked files |
| `docs://project/{id}/HEAD/{path}` | ✅ Complete | Current file on main branch |
| `docs://project/{id}/branch/{branch}/{path}` | ✅ Complete | File on specific branch |
| `docs://project/{id}/history/{path}` | ✅ Complete | Git history for a file |
| `docs://project/{id}/policy` | ✅ Complete | Current policy config |
| `docs://project/{id}/commit/{revision}/{path}` | ⏳ Post-MVP | Listed in PRD example URIs, not required for MVP |

---

## CLI Commands

| Command | Status | Notes |
|---------|--------|-------|
| `docu-guard init` | ✅ Complete | Creates full project structure |
| `docu-guard server` | ✅ Complete | Stdio MCP server |
| `docu-guard list` | ✅ Complete | Enriched output (per-file revision + protected) |
| `docu-guard history <path>` | ✅ Complete | Unified history output |
| `docu-guard export` | ✅ Complete | Exports to working tree |

---

## Proposal Storage

| Feature | Status | Notes |
|---------|--------|-------|
| `doc_proposals` SQLite table | ✅ Complete | `id`, `project_id`, `branch`, `path`, `base_revision`, `patch`, `intent`, `summary`, `risk_level`, `requires_approval`, `status`, `created_at`, `committed_at` |
| Proposal CRUD | ✅ Complete | `storeProposal`, `getProposal`, `updateProposalStatus` |
| Proposal lifecycle | ✅ Complete | `pending` → `committed` / `rejected` / `stale` |
| Stale base revision → stale proposal | ✅ Complete | Auto-marked when `commit_patch` re-validation fails |

---

## Safety & Validation

| Feature | Status | Notes |
|---------|--------|-------|
| Path traversal prevention | ✅ Complete | `../`, absolute paths, empty segments |
| Base revision matching | ✅ Complete | Reject on mismatch |
| Forbidden operations | ✅ Complete | Silent delete, whole-file replace without base revision, overwrite without diff, delete protected doc |
| Large deletion detection | ✅ Complete | >25% threshold (configurable) |
| Heading removal detection | ✅ Complete | All heading levels (# through ######) |
| Full file replacement detection | ✅ Complete | Common prefix/suffix <10% |
| AGENTS.md modification flagging | ✅ Complete | High risk + special approval messaging |
| AGENTS.md intent validation | ✅ Complete | Intent/summary must reference safety/agent rules keywords |
| `.docs-policy.yml` modification flagging | ✅ Complete | High risk + special approval messaging |
| STATUS.md guarded update workflow | ✅ Complete | Canonical root protected paths are merged into loaded policy; `docs.propose_patch`/`docs.commit_patch` can update STATUS.md with approval |
| Patch-only-deletions detection | ✅ Complete | No additions in patch = high risk |
| Protected file change flagging | ✅ Complete | Configurable via policy |
| Risk override for high-risk patches | ✅ Complete | `riskOverride: "accept"` on `commit_patch` |
| Uninitialized project detection | ✅ Complete | Clear error message on all CLI commands |

---

## Event Log

| Feature | Status | Notes |
|---------|--------|-------|
| `doc_events` SQLite table | ✅ Complete | Matches PRD schema exactly |
| Event logging on all mutations | ✅ Complete | `init`, `propose_patch`, `commit_patch`, `restore_file`, `export`, `create_branch` |
| Event retrieval by path | ✅ Complete | `getHistoryForPath` |
| Actor recording | ✅ Complete | Via `commit_patch` `actor` parameter |

---

## Tests

| Test Area | Status | Count |
|-----------|--------|-------|
| Project initialization | ✅ Complete | 1 test |
| Reading docs | ✅ Complete | 2 tests (exists + not found) |
| Creating branches | ✅ Complete | 1 test |
| Proposing a valid patch | ✅ Complete | 1 test |
| Rejecting stale base revision | ✅ Complete | 1 test |
| Rejecting path traversal | ✅ Complete | 2 tests (detect + accept) |
| Detecting large deletion risk | ✅ Complete | 2 tests (flag + no flag) |
| Detecting heading removal risk | ✅ Complete | 2 tests (flag + no flag) |
| Detecting full file replacement | ✅ Complete | 1 test |
| Committing a patch | ✅ Complete | 1 test |
| Writing event log row | ✅ Complete | 1 test |
| Restoring file from history | ✅ Complete | 1 test |
| Proposal storage round-trip | ✅ Complete | 2 tests (CRUD + not found) |
| Export documentation | ✅ Complete | 1 test |
| Stale proposal detection | ✅ Complete | 1 test |
| AGENTS.md intent validation | ✅ Complete | 5 tests (vague intent rejected, valid intent passes ×3, non-AGENTS.md not affected) |
| AGENTS.md safety-rule content in init | ✅ Complete | 5 content assertions in init test |
| Storage paths (expandTilde, derivation) | ✅ Complete | 4 tests |
| Registry CRUD + resolution + schema v2 | ✅ Complete | 5 tests (add, remove, list, show, default) |
| Registry v1 backward compat | ✅ Complete | 2 tests (load v1, upgrade on write) |
| Registry managed-dir validation | ✅ Complete | 2 tests (resolve using dataDir, missing) |
| CLI init command registration | ✅ Complete | 3 tests (registers, idempotent, custom dirs) |
| v0.4 project context files (STATUS.md, manifest) | ✅ Complete | 8 tests (create, idempotent ×2, no .docu-guard/, policy protection, legacy policy merge, STATUS.md propose/commit, untracked rejection) |
| docs.status front matter parsing | ✅ Complete | 7 tests (parse STATUS.md, read via project, truncation, missing file, no front matter, empty, partial delimiter) |
| HTTP server with managed storage, read-only REST context API, and web UI | ✅ Complete | 22 tests (health, MCP dispatch, managed storage, REST context API, UI shell/assets/no write routes) |
| Daemon lifecycle helpers and commands | ✅ Complete | 5 tests (action parsing, detached args, background start, stale PID cleanup, stop via SIGTERM) |
| Curated Atlas-owned document scope | ✅ Complete | 4 tests (ownership resolution, docs.list exclusion, docs.read rejection, default context-pack exclusion) |
| Daemon with managed storage | ✅ Complete | 4 tests (isolated temp paths) |
| Bounded `docs.read` via handler | ✅ Complete | 9 tests: backward-compatible, truncation, maxChars>content, offset, offset+maxChars, revision preserved, missing file, offset beyond end, path traversal |
| `docs.read_section` via handler | ✅ Complete | 10 tests: section reads, child subsections, includeHeading=false, maxChars, offset, duplicate occurrence, level filter, fenced code blocks, missing heading, docs.read compatibility |
| `docs.context_pack` via handler | ✅ Complete | 6 tests: default orientation pack, total maxChars budget, explicit paths, explicit sections, missing paths, unsafe/untracked rejection |
| **Current suite** | ✅ Current | Coverage includes client conformance, doctor, metadata, project, CLI, daemon, HTTP, and managed-doc workflow tests; use current local runner output when an exact count matters |

---

## Known Gaps / Post-MVP

| Item | Priority | Notes |
|------|----------|-------|
| `commit/{revision}/{path}` resource URI | Low | Listed in PRD example URIs but not in Required MVP Resources |
| `search.ts` module | Low | Post-MVP search entry point for Atlas-managed docs/context; SQLite FTS first, optional sqlite-vec later, no Qdrant/default external vector service |
| Web review UI | Post-MVP | Future enhancement |
| Cloud sync / team approvals | Post-MVP | Future enhancement |
| GitHub PR integration | Post-MVP | Future enhancement |
| VS Code extension | Post-MVP | Future enhancement |
| File watcher for direct writes | Post-MVP | Future enhancement |
| Multi-file patches | Post-MVP | Currently single-file only |
| Semantic merge resolution | Post-MVP | Explicitly non-goal for MVP |
| CI/pre-commit integration | Post-MVP | Secondary goal |
| Historical full-text search | ✅ Complete | Local lexical FTS search implemented as `docs.search`; semantic/vector retrieval remains future work |
| Agent activity dashboard | Post-MVP | Future enhancement |
| Managed branch promotion / merge (`docs.merge_branch`) | Unimplemented | Policy defines `branching.merge_to_main_requires` but no tool or workflow exists. De facto sync model: feature branch → `docs.export` → working tree → `git add/commit` → source repo. Does not block v0.4 — STATUS.md and manifest can be edited directly on `main` via `propose_patch` → `commit_patch`, or synced via export from feature branches. |
| `better-sqlite3` vs `node:sqlite` | ✅ Resolved | Using built-in `node:sqlite` (Node 22+) — intentional improvement |

---

## v0.2 — Multi-Project Daemon with Streamable HTTP

> **Status:** Complete (multi-project daemon, registry, and Streamable HTTP implemented)
> **Spec:** [`docs/spec/docu-guard-mcp-v0.2-daemon-prd.md`](./spec/docu-guard-mcp-v0.2-daemon-prd.md)
> **Plan:** [`docs/spec/docu-guard-mcp-v0.2-implementation-plan.md`](./spec/docu-guard-mcp-v0.2-implementation-plan.md)

### CLI Commands

| Command | Status | Notes |
|---------|--------|-------|
| `docu-guard daemon` | ✅ Complete | Foreground mode preserved; `xurgo-atlas daemon start|stop|status` manage background lifecycle; PID file stored under managed runtime data outside the repo working tree |
| `docu-guard project add` | ⏳ Planned | Register a project in the local registry |
| `docu-guard project remove` | ⏳ Planned | Remove a project from registry |
| `docu-guard project list` | ⏳ Planned | List all registered projects |
| `docu-guard project show` | ⏳ Planned | Show details for a registered project |
| `docu-guard project default` | ⏳ Planned | Set the default project for daemon mode |
| `docu-guard server` | ✅ Unchanged | Stdio mode preserved from v0.1 |

### Architecture Components

| Component | Status | Notes |
|-----------|--------|-------|
| `src/mcp/create-server.ts` | ⏳ Planned | Shared MCP server factory (extracted from `server.ts`) |
| `src/mcp/stdio.ts` | ⏳ Planned | Stdio transport wrapper (refactored from `server.ts`) |
| `src/mcp/http.ts` | ⏳ Planned | Streamable HTTP transport using Node.js built-in `http` |
| `src/cli/daemon.ts` | ⏳ Planned | Daemon CLI command handler |
| `src/cli/project.ts` | ⏳ Planned | Project registry CLI handlers |
| `src/core/registry.ts` | ⏳ Planned | Registry class for `~/.config/docu-guard/projects.json` |

### MCP Transport

| Feature | Status | Notes |
|---------|--------|-------|
| Stdio transport | ✅ Unchanged | Preserved from v0.1 |
| Streamable HTTP transport | ⏳ Planned | `POST /mcp` endpoint |
| Health check endpoint | ⏳ Planned | `GET /health` |
| CORS support | ⏳ Planned | ACAO, ACAM, ACAH headers |
| Origin validation | ⏳ Planned | Localhost origins by default |
| Graceful shutdown | ✅ Complete | Foreground daemon handles SIGINT/SIGTERM; background lifecycle stop uses PID tracking + SIGTERM |

### Project Registry

| Feature | Status | Notes |
|---------|--------|-------|
| Registry CRUD | ⏳ Planned | add, remove, list, show |
| Default project | ⏳ Planned | Fallback when `projectId` omitted |
| Project resolution | ⏳ Planned | `projectId` → `projectRoot` |
| Validation: unknown project | ⏳ Planned | Clear error + suggested command |
| Validation: missing root | ⏳ Planned | Clear error |
| Validation: uninitialized | ⏳ Planned | Clear error suggesting `docu-guard init` |
| Validation: no default | ⏳ Planned | Clear error |
| Config path | ⏳ Planned | `~/.config/docu-guard/projects.json` (respects `XDG_CONFIG_HOME`) |

### Multi-Project Tool Dispatch

| Feature | Status | Notes |
|---------|--------|-------|
| Tools resolve `projectId` per-request | ⏳ Planned | Resolver pattern in daemon mode |
| Stdio uses pre-loaded project | ✅ Unchanged | No resolver needed |
| Default project fallback | ⏳ Planned | When `projectId` omitted in daemon mode |

### Testing

| Test Area | Status | Count |
|-----------|--------|-------|
| Registry unit tests | ✅ Complete | 22 tests |
| HTTP server tests | ✅ Complete | 9 tests |
| Daemon integration tests | ✅ Complete | 4 tests |
| v0.1 regression | ✅ Required | All pre-v0.3 tests must pass unchanged |

### README Documentation

| Section | Status | Notes |
|---------|--------|-------|
| Daemon mode | ✅ Complete | How to start and use the daemon |
| Project registry commands | ✅ Complete | add, remove, list, show, default |
| HTTP MCP client config | ✅ Complete | Example for clients supporting Streamable HTTP |
| Security notes | ✅ Complete | Default localhost, warning about `0.0.0.0` |

### Implementation Phases

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | Extract shared MCP server registration | ✅ Complete |
| Phase 2 | Add project registry | ✅ Complete |
| Phase 3 | Add project CLI commands | ✅ Complete |
| Phase 4 | Add Streamable HTTP daemon | ✅ Complete |
| Phase 5 | Add multi-project resolution in tools | ✅ Complete |
| Phase 6 | Add docs, tests, dogfooding | ✅ Complete |

---

## v0.3 — Storage Model Audit & Implementation

> **Status:** Configurable managed storage implemented (commit `2979ee2`); external dogfooding complete
> **Spec:** [`docs/spec/docu-guard-mcp-v0.3-storage-model.md`](./spec/docu-guard-mcp-v0.3-storage-model.md)

| Item | Status | Notes |
|------|--------|-------|
| Storage model audit completed | ✅ Complete | Evaluated project-local, global-only, and managed-with-configurable-dirs models |
| Recommended model chosen | ✅ Complete | Managed storage with configurable `--config-dir` and `--data-dir`; project-local mode removed |
| Registry schema v2 designed | ✅ Complete | `configDir` and `dataDir` at top level; no `storeType` field |
| `--config-dir` / `--data-dir` flags for daemon | ✅ Complete | Replaces `--store` flag; separates config from data |
| Path resolution using configurable dirs | ✅ Complete | `<dataDir>/projects/<projectId>/` for managed state |
| Project-local `.docu-guard/` removal | ✅ Complete | `init` no longer creates `.docu-guard/`; no auto-detection or fallback |
| Existing `.docu-guard/` migration helper | ⏳ Pending | One-time copy from `.docu-guard/` to `<dataDir>/projects/<id>/` |
| Registry backward compatibility | ✅ Complete | v1 loaded and upgraded silently; saved as v2 |
| External dogfooding (disposable project) | ✅ Complete | Init + registry + daemon + full MCP patch workflow + export verified; no `.docu-guard/` created |
| Daemon path validation | ⏳ Pending | Validate configDir/dataDir existence at startup (currently prints paths but does not validate) |
| Desktop/VPS/Docker path defaults | ⏳ Pending | Defaults use XDG conventions; `/etc`/`/var/lib` defaults not auto-detected |
| Self-dogfood on docu-guard-mcp itself | ✅ Complete | Self-dogfood validated: init + daemon + full MCP patch cycle on this repo |
| Tests for new storage model | ✅ Complete | 22 registry tests (v2 schema, v1 compat, CRUD, resolution), 4 daemon tests, 9 HTTP server tests, tilde expansion, CLI init registration |

### Known Follow-Up Items

| Issue | Priority | Notes |
|-------|----------|-------|
| GitStore `withWorkDir` should reset/clean workdir before each operation | ✅ Complete | `git reset --hard HEAD && git clean -fd` added at start of every `withWorkDir` call; regression test added (`GitStore workdir cleanup`). Fix in `src/core/git-store.ts` line 146-151 |
| Initial long-patch failure with `git apply` "corrupt patch" | Low | A patch with a `Date:` field line was rejected as corrupt by git; shorter simpler patch applied cleanly. Pre-existing patch-format fragility, not storage-model specific |
| Self-dogfood on docu-guard-mcp itself | Medium | Completed end-to-end (init → daemon → create_branch → propose_patch → preview_diff → commit_patch → history → export). Branch promoted to source repo via export + manual git commit. Managed `main` does not yet contain feature branch commits — see "Managed branch promotion" gap in Known Gaps above. |

---

## v0.4 — Project Context, STATUS.md, Manifest & Token-Efficient Access

> **Product name:** Xurgo Atlas
> **Current implementation:** docu-guard-mcp (transitional package/CLI)
> **Status:** Stabilized — v0.4 context tools, read-only REST context API, and hardened read-only web UI implemented as a private milestone
> **Integration:** [`docs/vision/xurgo-integration.md`](./vision/xurgo-integration.md)
> **Vision:** [`docs/vision/project-context-mcp.md`](./vision/project-context-mcp.md)
> **Spec:** [`docs/spec/docu-guard-mcp-v0.4-status-manifest-context.md`](./spec/docu-guard-mcp-v0.4-status-manifest-context.md)

| Item | Status | Notes |
|------|--------|-------|
| Define project-context vision | ✅ Complete | Vision doc created and updated for Xurgo Atlas naming |
| Plan STATUS.md, manifest, token-efficient access | ✅ Complete | Spec doc created and updated for Xurgo Atlas naming |
| Define Xurgo Atlas ↔ Xurgo integration boundary | ✅ Complete | Integration alignment doc created in `docs/vision/xurgo-integration.md` |
| Xurgo Atlas naming / transition status documented | ✅ Complete | Naming transition captured in vision doc, spec, and checklist |
| STATUS.md template and front matter schema | ✅ Complete | YAML front matter + Markdown body; created by `init`; short by design |
| docs/manifest.yml schema and validation | ✅ Complete | Machine-readable project map with roles, priorities, summaries; created by `init` |
| Update `init` to create STATUS.md and manifest | ✅ Complete | Both files created during `init`; existing files not overwritten |
| Add STATUS.md and manifest to default protected paths | ✅ Complete | `STATUS.md` added to `DEFAULT_POLICY.protected_paths`; `docs/manifest.yml` already covered by `docs/**` |
| Implement `docs.status` tool | ✅ Complete | Returns STATUS.md front matter + body; `parseFrontMatter` exported; truncation via `maxChars` |
| Implement `docs.manifest` tool | ✅ Complete | Returns parsed manifest YAML as JSON; supports `includeRaw`, `validatePaths`, `maxDocuments` |
| Implement `docs.read_section` tool | ✅ Complete | Read one Markdown section by ATX heading; supports bounded reads and disambiguation |
| Add `maxChars`/`maxBytes` options to `docs.read` | ✅ Complete | `maxChars` and `offset` implemented; `truncated`, `returnedChars`, `totalChars` in response |
| Add `compact` and `role` options to `docs.list` | ⏳ Planned | Compact metadata responses |
| Implement `docs.context_pack` tool | ✅ Complete | Curated document set within token budget; supports explicit paths and sections |
| Update `.docs-policy.yml` default template | ✅ Complete | Includes canonical guarded root paths (`STATUS.md`, `AGENTS.md`, `.docs-policy.yml`); `docs/manifest.yml` remains covered by `docs/**` |
| Tests for v0.4 foundation (init) | ✅ Complete | 5 tests for STATUS.md + manifest creation, idempotency, .docu-guard/ absence, policy protection |
| Tests for `docs.status` tool | ✅ Complete | 7 tests: full parse, read via project, truncation, missing file, no front matter, empty, partial delimiter |
| Tests for `docs.manifest` tool | ✅ Complete | 11 tests: parsed JSON + revision, no raw by default, raw when requested, path validation (valid + missing), missing manifest, invalid YAML, maxDocuments truncation, validatePaths=false, entrypoints |
| Xurgo ↔ Xurgo Atlas MCP integration fixture | ⏳ Planned | Shared test fixtures for integration testing |
| Self-dogfood / integration dogfood | ✅ Complete | Orientation workflow dogfooded with `docs.status`, `docs.manifest`, bounded `docs.read`, `docs.read_section`, and `docs.context_pack` |
| Minimal read-only REST API | ✅ Complete | REST facade mirrors read-only MCP context tools; no write/proposal/approval/export endpoints |
| Minimal read-only web UI | ✅ Complete | Served at `/` and `/ui`; opens to STATUS.md, uses manifest navigation, reads docs via REST, and exposes copy actions only |
| Focused v0.4 stabilization audit | ✅ Complete | Confirmed docs/policy coherence, MCP/REST/UI read-only alignment, package dependency manifest, and private milestone readiness |
| Curated Atlas-owned document scope for read surfaces | ✅ Complete | Ownership is now separate from `.docs-policy.yml` `protected_paths`; default owned docs are canonical Atlas docs, `docs/atlas/**`, and explicit manifest `documents[].path` entries; write scope remains conservatively policy-protected |
| Mechanical rename/internal migration planning | ✅ Planning complete | Phased post-v0.4 plan added to the v0.4 spec; implementation remains deferred |

---

## Historical Naming Migration Planning (Post-v0.4)

> **Status:** Historical planning record; implementation not started in this checklist.
> **Plan:** [Xurgo Atlas Naming Migration Plan](./spec/docu-guard-mcp-v0.4-status-manifest-context.md#14-xurgo-atlas-naming-migration-plan-post-v04)
> These rows stay as historical planning context. They do not override the current Atlas-branded repository state summarized at the top of this document.

| Item | Status | Notes |
|------|--------|-------|
| Inventory legacy naming references | ✅ Complete | Identified package/lockfile, CLI text, MCP server metadata, `docs.*` namespace, generated templates, config/data defaults, event paths, docs, and tests |
| Define compatibility posture | ✅ Complete | Keep existing package/CLI/config/storage/MCP namespace behavior until implementation is separately approved |
| Plan package/internal rename phase | ✅ Complete | Package identity decision deferred; lockfile/import/bin risks documented |
| Plan CLI/server compatibility | ✅ Complete | Candidate new CLI alias can be introduced while retaining `docu-guard` for at least one transition period |
| Plan config/storage compatibility | ✅ Complete | Prefer non-destructive legacy discovery/aliasing before any explicit copy/move; rollback required |
| Plan MCP namespace compatibility | ✅ Complete | Keep `docs.*` initially; any future namespace requires aliases and deprecation docs |
| Plan test/validation scope | ✅ Complete | Future implementation must cover package metadata, CLI aliases, server metadata, storage migration, namespace stability, build/test/pack/runtime smoke checks |
| Implement rename changes | ⏳ Deferred | No runtime, package, CLI, config, storage, source-module, or MCP namespace rename is included in planning or readiness-audit tasks |

---

## Historical Naming Migration Readiness Audit

> **Status:** Historical implementation inventory; migration not started.
> **Inventory:** [Migration Implementation Readiness Inventory](./spec/docu-guard-mcp-v0.4-status-manifest-context.md#15-migration-implementation-readiness-inventory-phase-b-audit)
> Keep this section as historical scoping context rather than the current delivery headline.

| Area | Status | Implementation candidates | First-slice guidance |
|------|--------|---------------------------|----------------------|
| Package metadata | ✅ Inventoried | `package.json` name/bin/description/keywords; `package-lock.json` root metadata | Additive bin alias is safe; package rename waits |
| CLI compatibility | ✅ Inventoried | `src/index.ts`, `src/cli/init.ts`, `src/cli/project.ts`, `src/cli/daemon.ts` | Keep `docu-guard` working; add `xurgo-atlas` only as an alias in first slice |
| Runtime/server naming | ✅ Inventoried | `src/mcp/create-server.ts`, daemon logs, startup text, help text, error hints | Display metadata can change separately from tool names |
| Config/storage compatibility | ✅ Inventoried | `src/core/storage.ts`, `src/core/registry.ts`, `src/core/project.ts`, storage tests | Exclude from first slice; requires legacy discovery/rollback plan |
| MCP namespace | ✅ Decision confirmed | `src/mcp/tools.ts`, resources, generated AGENTS.md, docs, tests, client prompts | Keep `docs.*` unchanged unless separately approved |
| Documentation references | ✅ Classified | Current-facing docs vs historical specs/changelog/compat notes | Brand current-facing docs carefully; preserve true legacy references |
| Recommended Phase B slice | ✅ Defined | Add `xurgo-atlas` bin alias while retaining `docu-guard`; focused tests and pack/build smoke | Do not include package rename, storage migration, namespace migration, or runtime feature work |
