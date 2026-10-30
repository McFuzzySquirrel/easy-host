---
name: easy-host-registry-config
description: "Creates or changes AppSpec TOML schema, defaults, name derivation, atomic registry writes, rebuildable state cache, env and secret merging, and key-named validation errors."
---

# Skill: Change the easy-host Registry and Config Safely

Use this skill for any change to `config.toml`, the zod `AppSpec` schema, app naming, the `apps/` registry layout, `state.json`, locks, port conflicts, or environment and secret merging. Mistakes here cause data loss, secret leakage, path traversal, or two apps silently claiming one port.

The filesystem is the registry. `apps/<name>/config.toml` is truth; `state.json` is a disposable cache. Validation happens before any mutation.

## Invariants

- `config.toml` is TOML with comments; `AppSpec` requires exactly one of `repo` or `local_path` and requires `port`.
- Defaults: `ref=main`, `container_port=3000`, `bind=0.0.0.0`, `health_path=/`, `probe=http`, `health_interval_ms=2000`, `health_timeout_ms=5000`, `health_startup_ms=90000`.
- Ports are `1024–65535`; bind is one of `0.0.0.0`, `127.0.0.1`, `::`.
- Names match `^[a-z0-9][a-z0-9-]{0,31}$`, derived from the repo basename or accepted via `--name`.
- Layout per app: `config.toml`, `secrets.env`, `workspace/`, `state.json`.
- Modes: directories `0700`, `config.toml` `0644`, `secrets.env` `0600`.
- Writes are same-directory temp file plus rename; a crash leaves the old complete file or the new complete file.
- Env precedence: inline `[env]` first, then the optional secrets file, with the secrets file winning on duplicate keys.
- Never write a secret into `config.toml`, an error, a log, or JSON output.

## Process

### Step 1: Read the current schema

Inspect `src/config/schema.ts`, `parse.ts`, `name.ts`, `env.ts`, `src/registry/store.ts`, `state.ts`, `ports.ts`, and `src/platform/lock.ts` with their tests. The [architecture note](../../../docs/ARCHITECTURE.md#on-disk-state) describes the storage contract.

If the schema change is not additive, then treat it as a v1 schema break: there is no migration path, so it needs an explicit decision from `support-lead` before coding.

### Step 2: Change the schema in one place

Update the zod `AppSpec` and `AppState` definitions first, then the TOML parser, then consumers. Every new key needs a type, a default (or required status), a validation rule, and a test that asserts the default.

Validate these rejection classes together: unknown key, wrong type, port below 1024 or above 65535, bind outside the allowlist, and `local_path` or `env_file` that is absolute or escapes the app directory. Each error names the offending key and the received value, never a secret.

**Output:** schema, parser, defaults, and a key-named error for every rejection.

### Step 3: Preserve naming, storage, and cache semantics

Derive names by lowercasing the basename, collapsing runs of non-`[a-z0-9]` to one hyphen, trimming, and truncating to 32 characters. Support HTTPS, SSH, scp-style, and local-path inputs. An existing directory is a conflict (`6`), never an overwrite.

Write with `writeFile` to a temp path in the same directory, `chmod` to the required mode, then `rename`. Rebuild `state.json` leniently when missing, invalid, or partial, and keep the app usable. Listing scans directories and reports a broken config with its parse error rather than skipping it.

If a lock is held by a live pid, then exit `6` and name the holding process. Reclaim a lock whose pid no longer exists. Compare ports by equality alone, regardless of bind address.

### Step 4: Merge environment without leaking it

Parse `KEY=VALUE` lines with comments and single or double quotes. Reject an invalid variable name with the line number only. Merge inline `[env]` and the secrets file with the file winning, and expose a redacted view for diagnostics.

A declared but missing secrets file is a usage error (`1`). An absolute `env_file` path is rejected in v1.

### Step 5: Prove the change with tests and documentation

Unit tests use a temporary root; no Podman and no network.

```bash
npm run typecheck
npm test -- tests/unit/config-parse.test.ts
npm test -- tests/unit/config-name.test.ts
npm test -- tests/unit/registry-store.test.ts
npm test -- tests/unit/config-env.test.ts
npm test -- tests/unit/lock.test.ts tests/unit/ports.test.ts
```

Update the config reference and the docs drift test in the same change. By default, hand the documentation update to `docs-engineer`; if that is not possible, update `docs/reference/config.md` here and note it.

**Output:** changed schema, tests, and a reference update or an explicit handoff.

## Gotchas

- **`state.json` is not the app list.** Deleting it must never remove an app; deriving the list from the cache hides drift and loses apps.
- **A duplicate port is a conflict even with different binds.** `0.0.0.0:8080` and `127.0.0.1:8080` still collide on the host.
- **`smol-toml` round-trips comments only when you preserve the document.** Parsing to an object and serializing fresh drops operator comments.
- **The secrets file wins.** Reversing precedence silently ignores the operator's real credentials.
- **A rejected key must not echo its value.** Env values and URL credentials are secret even when the key name is not.
- **Stale locks are normal after a crash.** Reclaim by pid plus start time; never require manual lock-file deletion.
- **A broken app still lists.** Hiding it makes the registry look healthy while an app cannot start.
- **Truncation happens after trimming.** Truncating first can leave a trailing hyphen that fails the name pattern.

## Validation

Self-check against observable state:

- [ ] `npm test -- tests/unit/config-parse.test.ts tests/unit/config-env.test.ts` passes, including unknown-key and traversal cases.
- [ ] A temporary write failure leaves the previous `config.toml` byte-identical and readable.
- [ ] `stat -c '%a' <root>/apps/<app>/config.toml` reports `644` and `secrets.env` reports `600`.
- [ ] Deleting `state.json`, then running `list`, still shows the app.
- [ ] A planted secret value is absent from the broken-config error, the redacted view, and `list --json`.

If a check fails, fix the write or validation path before adding any new schema surface. Load [references/config-schema.md](./references/config-schema.md) when you need the field-by-field schema, TOML example, or error-rendering rules.
