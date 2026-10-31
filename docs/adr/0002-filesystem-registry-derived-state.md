---
id: ADR-0002
applies_to:
  - "src/registry/**"
  - "src/config/**"
status: Accepted
---

# ADR-0002: Use app directories as the registry and a rebuildable state cache

- **Deciders:** mcfuzzysquirrel (maintainer)
- **Date:** 2026-10-31

**Technical Story:** `REG-FR-04`, `REG-NF-02`, `PRD-NF-06`

## Agent Rules

- **MUST:** treat `<state-root>/apps/<app>/config.toml` as the authoritative app definition and `state.json` as a cache that can be deleted and rebuilt.
- **MUST:** validate a whole app spec before any filesystem, Podman, or git mutation.
- **MUST:** replace `config.toml`, `secrets.env`, and `state.json` atomically through a same-directory temporary file, fsync, and rename.
- **MUST:** create the state root and app directories with mode `0700`, `config.toml` and `state.json` with `0644`, and `secrets.env` with `0600`.
- **MUST NOT:** add a database, a single shared registry file, or any code path that requires `state.json` to be correct.
- **MUST NOT:** change the state-root resolution order: `EASY_HOST_HOME`, then `$XDG_DATA_HOME/easy-host`, then `~/.local/share/easy-host`.

## Verify

- **Check:** `npm test -- tests/unit/registry-store.test.ts tests/unit/drift.test.ts tests/unit/config-parse.test.ts`
- **Expected:** deleting or corrupting `state.json` still yields the app definition; a simulated crash before rename leaves the previous complete file; permissions match the table in the configuration reference.

## Context and Problem Statement

The tool must record each app's source, port, volumes, and environment across reboots, and survive a crash or a partially written file. It also has to stay inspectable by an operator with `cat`, `cp`, and a text editor. Which storage model gives crash safety and a usable recovery story without introducing a service?

## Decision Drivers

- Crash safety on a single host with no transaction manager.
- Human-editable configuration and a backup story that needs only file copies.
- Independent app directories, so one broken app does not block the others.
- No long-running process of our own.

## Considered Options

- SQLite database.
- One JSON registry document for all apps.
- One directory per app with TOML configuration plus a derived JSON cache.

## Decision Outcome

Chosen option: "One directory per app with TOML configuration plus a derived JSON cache", because the filesystem supplies isolation and atomic rename supplies crash safety. Keeping `state.json` disposable means a corrupted cache is an inconvenience, not a data-loss event, and an operator can repair `config.toml` by hand.

### Positive Consequences

- Apps are independent: a malformed `config.toml` or corrupt cache affects one app.
- Backup is a directory copy; inspection is `cat`; repair is a text editor.
- Atomic replacement guarantees an old or new complete document, never a partial one.

### Negative Consequences

- There is no cross-app transaction; an operation that spans apps (for example renaming) would need its own coordination.
- Directory permissions carry the security model, so a mis-set mode is a real exposure.
- Every read validates TOML and rebuilds missing state, which is more work than a database lookup.

## Pros and Cons of the Options

### SQLite database

- Good, because it gives transactions, indexes, and a single file to copy.
- Bad, because it is opaque to `cat`, conflicts with hand editing, and adds a schema migration burden for a tool with a handful of rows.

### One JSON registry document

- Good, because it is simple to parse and one file to back up.
- Bad, because every write rewrites every app, a single corruption loses all apps, and concurrent edits are harder to isolate.

### Per-app directory with TOML and a cache

- Good, because it keeps blast radius to one app and makes atomic replacement natural.
- Bad, because drift between the file tree and runtime state must be detected explicitly rather than prevented by a database.

## Links

- Implemented by `src/registry/store.ts`, `src/registry/state.ts`, `src/config/schema.ts`.
- Storage contract in the [configuration reference](../reference/config.md).
- Related: [ADR-0005](0005-two-image-retention.md), [ADR-0008](0008-exit-codes-and-json-contract.md).
