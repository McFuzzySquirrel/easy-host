---
id: ADR-0006
applies_to:
  - "src/lifecycle/remove.ts"
  - "src/config/schema.ts"
  - "src/lifecycle/add.ts"
status: Accepted
---

# ADR-0006: Delete only explicitly requested, label-scoped named volumes

- **Deciders:** mcfuzzysquirrel (maintainer)
- **Date:** 2026-10-31

**Technical Story:** `RBK-FR-03`, `PRD-SP-07`

## Agent Rules

- **MUST:** keep every named volume on `remove` unless `--volumes` is passed.
- **MUST:** delete a volume only when its `io.easy-host.app` label equals the app being removed.
- **MUST:** refuse a volume whose name merely matches the app pattern but whose label is missing or names another app.
- **MUST:** never delete a bind mount or any host filesystem path.
- **MUST NOT:** make `--force` imply `--volumes`.
- **MUST:** create or reuse a volume only when it carries this app's label; a same-named volume owned by another app is a conflict (`6`).
- **SHOULD:** print the exact `podman volume rm` command for every retained volume.

## Verify

- **Check:** `npm test -- tests/unit/remove.test.ts tests/unit/config-parse.test.ts tests/unit/add.test.ts`
- **Expected:** a default `remove` keeps volumes and prints their deletion commands; `--volumes` refuses a foreign or unlabelled volume; `--force` alone still keeps them; a volume name conflict exits `6`.

## Context and Problem Statement

Application data is the one thing a hosting tool cannot rebuild. Deleting an app is routine; deleting its database by accident is not. The tool must offer cleanup without making data loss the default. Which resources may `remove` delete, and when?

## Decision Drivers

- Data loss must require an explicit, app-scoped request.
- Podman volumes are global namespace objects, so name matching alone is unsafe.
- Named volumes are the only storage easy-host creates; host paths are operator-owned by definition.
- Cleanup should be possible in one command when it is actually intended.

## Considered Options

- Cascade-delete everything the app used.
- Never delete volumes; make the operator remove them.
- Keep volumes by default; delete them only with `--volumes` and a matching label.

## Decision Outcome

Chosen option: "Keep volumes by default; delete them only with `--volumes` and a matching label", because it makes the destructive action explicit and scopes it to resources the tool can prove it owns. Name equality is not proof: labels are.

### Positive Consequences

- An accidental `remove` cannot destroy persistent data.
- A volume shared with another app, or created by hand, is never touched.
- The printed `podman volume rm` command gives an operator a deliberate cleanup path.

### Negative Consequences

- Decommissioned apps can leave volumes behind if the operator forgets `--volumes` or the printed command.
- The safety rule depends on labels being written correctly at creation time; a mislabelled volume is refused rather than cleaned.
- Restoring a volume still requires operator tooling; easy-host has no backup or restore command.

## Pros and Cons of the Options

### Cascade delete

- Good, because cleanup is complete in one command.
- Bad, because a typo or a stale app name destroys data with no second chance.

### Never delete volumes

- Good, because it is maximally safe.
- Bad, because the tool then has no cleanup story and disk fills with orphaned data.

### Opt-in, label-scoped deletion

- Good, because intent is explicit and ownership is verifiable.
- Bad, because it requires an extra flag and a label discipline that must not regress.

## Links

- Implemented by `src/lifecycle/remove.ts` and volume naming in `src/lifecycle/add.ts`.
- Documented in [README volume safety](../../README.md#volume-safety) and the [configuration reference](../reference/config.md#volumes).
- Related: [ADR-0001](0001-rootless-podman-runtime.md), [ADR-0002](0002-filesystem-registry-derived-state.md).
