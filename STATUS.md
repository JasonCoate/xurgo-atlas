---
docuGuard.type: status
statusVersion: 1
priority: high
currentFocus: "Atlas now needs a credible release baseline preserved on the live `xurgo-atlas` repository state; private RC readiness is historical context, while current work is routine baseline-safe hardening, read-only diagnostics/provenance accuracy, and governed-doc correctness"
nextActions:
  - "Keep the Atlas release baseline routine and credible on `main`: preserve accurate current-facing docs, green focused validation, and non-breaking CLI/MCP behavior while recent read-only identity and diagnostic surfaces settle"
  - "Treat the June private RC readiness pass and storage-migration readiness as completed checkpoints; reopen them only for concrete regressions instead of carrying them as the standing current focus"
  - "Leave broader publication polish, roadmap expansion, and deeper migration work for separate slices after the baseline remains stable through normal Atlas workflows"
blockers:
doNotDo:
  - "Do not edit STATUS.md, manifest.yml, or .docs-policy.yml directly"
  - "Do not tag, publish, or release without explicit approval"
  - "Do not implement docs.merge_branch or proposal/diff/approval UI unless explicitly requested"
relatedDocs:
  - docs/manifest.yml
  - docs/atlas/setup.md
  - docs/atlas/daemon-mcp.md
  - docs/atlas/storage-migration.md
  - docs/atlas/release-checklist.md
lastUpdated: "2026-06-22"
---

# Project Status

## Project
Xurgo Atlas is the project-context and documentation-safety MCP. Package metadata now uses `xurgo-atlas`, published npm contents are explicitly allowlisted, daemon lifecycle commands and curated Atlas document ownership are implemented, and guarded document proposals remain the required path for managed docs. Managed storage now defaults to Atlas XDG roots while preserving legacy `docu-guard` fallback discovery for compatibility, and the CLI now supports both read-only storage inspection and a conservative copy-only legacy-to-Atlas apply path.

## Current Focus
The current focus is no longer another private RC gate. Treat live Git inspection as the authority for the exact checkout identity on `main` and `origin/main`; the current repository baseline is the Atlas-branded `xurgo-atlas` v0.2.1 line with recent release-baseline-preserving slices landed on top of the earlier private RC checkpoint.

That current release baseline includes the human-first public docs recovery, release-toolchain contract hardening, the read-only `xurgo-atlas doctor` snapshot, the `atlas.managed_state_provenance` / project-identity provenance work, internal client conformance checks, and the Atlas-managed lexical `docs.search` tool. Those are current repository facts; the June private RC readiness pass remains useful historical evidence, but it is no longer the present delivery headline.

The active priority now is to preserve that baseline through ordinary Atlas workflows: keep current-facing documentation accurate, keep governed-doc export and safety rules trustworthy, and keep newer read-only identity/diagnostic surfaces aligned with the repository without reopening broader release, migration, or roadmap work. Storage migration remains intentionally conservative and copy-only, and protected-doc validation remains intact.

## Recently Completed
- Historical checkpoint: `79f41f5 docs: document diagnostic and provenance context` aligned README guidance with the current diagnostic and provenance surfaces.
- `b52d2c4 test: add internal client conformance contract checks`, `6466794 feat: add read-only managed-state provenance snapshot`, and `481f1a3 feat: add read-only doctor snapshot` extended the baseline with read-only verification and project-identity/provenance support instead of new write-path behavior.
- `9b4c392 feat: add managed docs search tool` landed Atlas-managed lexical search, and the checklist already records that capability as complete.
- `690b185 chore: harden release toolchain contract`, `500a776 chore(release): prepare v0.2.1`, and `50ee275 docs: recover human-first public documentation` established the current Atlas release baseline around the live `xurgo-atlas` package.
- The June private RC readiness pass, managed-doc resync, storage migration apply copy, Git metadata repair, and Atlas-first naming cleanup remain completed historical checkpoints rather than current-next-work items.

## Next Actions
- Keep `STATUS.md` and other current-facing Atlas docs aligned with the live `xurgo-atlas` repository state rather than reusing the older private RC framing as if it were still current
- Preserve the release baseline with routine focused validation and small hardening slices, especially around governed-doc safety, export correctness, and read-only diagnostic/provenance surfaces
- Leave broader publication polish, migration expansion, and larger roadmap work for separately authorized slices after the baseline continues to hold through normal use

## Blockers
- None for routine release-baseline maintenance; public tag, publish, or release actions still require explicit approval

## Do Not Do
- Do not edit STATUS.md, manifest.yml, or .docs-policy.yml directly — always use docs.propose_patch
- Do not tag, publish, or release without explicit approval
- Do not implement `docs.merge_branch` unless explicitly asked
- Do not implement proposal/diff/approval UI unless explicitly asked

## Related Documents
- [Documentation Overview](docs/README.md)
- [Setup](docs/atlas/setup.md)
- [Daemon & MCP Configuration](docs/atlas/daemon-mcp.md)
- [Storage Migration](docs/atlas/storage-migration.md)
- [Release Checklist](docs/atlas/release-checklist.md)
- [Implementation Checklist](docs/implementation-checklist.md)
