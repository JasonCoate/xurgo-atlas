# Xurgo Atlas

Xurgo Atlas is a standalone, local-first documentation and project-context service for AI-assisted development. It gives developers and MCP-capable AI clients a governed way to read project docs, find context, and propose documentation changes with an audit trail.

Atlas complements your repository. It does not replace Git, your source tree, your issue tracker, or your AI client.

## Quick Start

Install Xurgo Atlas globally for the normal CLI workflow:

```bash
npm install -g xurgo-atlas
```

Verify the CLI, initialize a project, start the local daemon, and print JSON config for MCP clients:

```bash
xurgo-atlas --version
xurgo-atlas --help
xurgo-atlas init --project-id my-project
xurgo-atlas daemon start
xurgo-atlas mcp-config --json
```

If you want to try Atlas without installing it first, use `npx xurgo-atlas ...`. For project-local automation, install it as a dev dependency with `npm install -D xurgo-atlas`.

`init` creates or preserves a local `.xurgo-atlas/project.json` marker for the project folder. After that, normal commands can run from the project root or a nested subdirectory without repeating `--project-id` or `--project-root`.

`xurgo-atlas doctor` provides a bounded, read-only diagnostic snapshot of the current Atlas setup.

Optional init templates can create missing starter docs for common project types:

```bash
xurgo-atlas init --templates
xurgo-atlas init --template mcp-server --project-id my-project
```

Templates are documentation templates, not application scaffolds, and existing docs are preserved.

## What Atlas Helps With

Atlas helps an AI client or developer:

- discover the docs and artifacts Atlas manages for a project
- read focused sections or context packs instead of opening every file
- search Atlas-managed docs with local lexical search
- inspect which project folder Atlas is currently bound to before writing
- propose, preview, commit, and export governed documentation changes
- register approved project artifacts through guarded proposal and commit flows
- keep a documented history of managed-doc and artifact-registration changes

Atlas is optional. Use it when a project wants governed docs and durable project context through a CLI or MCP server.

## What Atlas Is Not

Atlas is not:

- an agent runtime
- a required dependency for another product
- a workspace manager
- a session or run store
- a general memory database
- a semantic or vector retrieval service today
- a lock server today
- a replacement for Git or repository truth

## MCP Client Setup

The current preferred MCP workflow is the local daemon HTTP endpoint:

```bash
xurgo-atlas daemon start
xurgo-atlas mcp-config --json
```

The JSON output tells MCP clients how to connect to `http://127.0.0.1:3737/mcp` by default and includes safety information about the project folder Atlas is bound to. For humans, `xurgo-atlas mcp-config` prints a readable setup summary.

After connecting, trust the tools available from the connected Atlas server through live MCP discovery, especially `tools/list`. Static docs and local source can drift from an already-running daemon.

`xurgo-atlas server` remains available for legacy or direct stdio integrations, but HTTP daemon mode is the normal path for MCP clients.

## How It Works

Atlas keeps its stored documentation and audit history outside your project tree, using configurable local data directories. Your repository remains the source of truth for code and normal Git history.

Managed documentation changes follow a guarded lifecycle:

```text
read -> propose -> preview -> commit -> export
```

That means a client reads the current document revision, proposes a standard diff, previews the stored proposal, commits it through Atlas, and exports the managed snapshot back to disk when the working tree needs to be updated. `docs.preview_export` lets clients inspect what export would change before writing files.

Artifact registration uses a separate guarded proposal and commit flow. Atlas can record approved project artifacts in managed metadata with audit evidence, while still avoiding a general-purpose file-write surface.

Atlas also reports project identity and write-safety information through `xurgo-atlas mcp-config --json`, `docs.status`, and the current `atlas.project_identity` MCP helper. `atlas.project_identity` also adds descriptive managed-state provenance context. In plain terms, these surfaces help clients confirm they are operating on the intended project folder before running guarded write or export operations.

## Documentation

- [Setup](docs/atlas/setup.md) — install options, first run, initialization, templates, and contributor setup
- [Daemon, CLI & MCP Reference](docs/atlas/daemon-mcp.md) — daemon workflow, MCP endpoint setup, live tool discovery, read/search/context tools, guarded proposals, `docs.preview_export`, and `atlas.project_identity`
- [Documentation Overview](docs/README.md) — navigation for user, contributor, release, advanced, and historical docs
- [Storage Migration](docs/atlas/storage-migration.md) — advanced local storage inspection and legacy migration
- [Root / Worktree Safety Model](docs/atlas/root-worktree-safety.md) — project identity, worktree safety, and export boundaries
- [Development Workflow](docs/atlas/development-workflow.md) — validation tiers, smoke tests, and local package checks
- [Release Checklist](docs/atlas/release-checklist.md) — release gates and ongoing release maintenance workflow

## Feedback

Xurgo Atlas is an early public package. Feedback is welcome, especially bug reports, setup issues, MCP client compatibility notes, and docs corrections.

If something is confusing, broken, or does not work in your environment, please open an issue.

## Contributing

Small docs fixes and targeted test improvements are welcome.

For larger or behavior-changing work, please open an issue first, especially for MCP tool changes, storage changes, root/worktree safety changes, managed-doc write/export changes, release-related changes, or security-sensitive filesystem behavior.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the short contribution policy.

## Security

Please do not report security issues in public issues. See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE) for the full text.
