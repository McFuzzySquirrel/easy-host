# Feature: App Registry and Config

## 1. Feature Overview

**Feature Name:** App Registry and Config
**Parent Document:** [PRD](../PRD.md)
**Status:** Draft
**Summary:** Defines what an app is on disk: a validated TOML spec, a safe name, a per-app directory, a rebuildable state cache, an env/secret merge rule, and the locks and port checks that keep two operations from corrupting each other.
**Scope:** Config schema and parsing, name derivation, registry layout and atomic writes, state cache, locking, port-conflict detection, and environment/secret merging. Nothing in this feature starts a container.
**Dependencies:** [Prerequisites and Doctor](01-prerequisites-and-doctor.md).

---

## 2. Context: Existing System State

Greenfield feature. Feature 01 provides the state root, typed errors, and the CLI surface. This feature fills in the `apps/` tree that [Add and Lifecycle](04-add-and-lifecycle.md) will populate.

---

## 3. Feature Goals and Non-Goals

### 3.1 Goals

- Make configuration readable and repairable by hand: TOML with comments, strict validation, and errors that point at the offending key.
- Make destructive mistakes hard: bad names, bad ports, unknown keys, and path traversal are rejected before anything runs.
- Make state disposable: deleting the cache never loses an app.
- Make concurrency boring: one mutating operation per app, and no two apps on one host port.

### 3.2 Non-Goals

- No container or image operations.
- No config migration from a previous schema; v1 starts at schema version 1.
- No nested or multi-service app definitions.
- No remote registry or database; the filesystem is the registry.

---

## 4. User Stories

| ID | Canonical Source | Ownership | Priority |
|----|------------------|-----------|----------|
| REG-US-01 | [REG-US-01](#REG-US-01) | Owns | Must |
| REG-US-02 | [REG-US-02](#REG-US-02) | Owns | Must |
| REG-US-03 | [REG-US-03](#REG-US-03) | Owns | Should |

```forge-requirement
{"id":"REG-US-01","kind":"story","text":"As an occasional maintainer, I want to read and edit an app's configuration by hand so that I can fix a mistake without learning an internal format."}
```

```forge-requirement
{"id":"REG-US-02","kind":"story","text":"As a homelab operator, I want two apps to never fight over the same port so that the second add fails instead of silently breaking the first."}
```

```forge-requirement
{"id":"REG-US-03","kind":"story","text":"As a VPS tinkerer, I want to delete the cache file and lose nothing so that state corruption is never a disaster."}
```

---

## 5. Technical Approach

### 5.1 Impact on Existing Architecture

Adds `src/config/` and `src/registry/`. Uses `src/platform/paths.ts` for the root and `src/cli/errors.ts` for validation failures (exit code 1) and conflicts (exit code 6). No existing module changes except imports.

### 5.2 New Components

| Path | Responsibility |
|---|---|
| `src/config/schema.ts` | Zod schema for `AppSpec` and `AppState` |
| `src/config/parse.ts` | TOML read/write, unknown-key rejection, defaults |
| `src/config/name.ts` | Derivation, sanitization, validation, collision |
| `src/config/env.ts` | `[env]` plus secrets-file merge with redaction awareness |
| `src/registry/store.ts` | Directory scan, read, write, delete, atomic replace |
| `src/registry/state.ts` | Per-app cache read/write and rebuild |
| `src/registry/ports.ts` | Cross-app port conflict checks |
| `src/platform/lock.ts` | Per-app and name-allocation locks with stale detection |

### 5.3 Technology Additions

`smol-toml` 1.9.1 and `zod` 4.6.7, both already declared in the stack. No new runtime services.

---

## 6. Functional Requirements

| ID | Canonical Source | Affects Existing | Priority |
|----|------------------|------------------|----------|
| REG-FR-01 | [REG-FR-01](#REG-FR-01) | No — creates `config/schema.ts` | Must |
| REG-FR-02 | [REG-FR-02](#REG-FR-02) | No — creates `config/name.ts` | Must |
| REG-FR-03 | [REG-FR-03](#REG-FR-03) | No — creates `registry/store.ts` | Must |
| REG-FR-04 | [REG-FR-04](#REG-FR-04) | No — creates `registry/state.ts` | Must |
| REG-FR-05 | [REG-FR-05](#REG-FR-05) | No — creates `lock.ts`, `ports.ts` | Must |
| REG-FR-06 | [REG-FR-06](#REG-FR-06) | No — creates `config/env.ts` | Must |

```forge-requirement
{"id":"REG-FR-01","kind":"requirement","text":"Parse config.toml into a typed AppSpec. Require exactly one of repo or local_path and require port. Apply documented defaults for ref, container_port, bind, probe, health_path, and probe timings. Reject unknown keys, wrong types, ports outside 1024-65535, bind addresses outside {0.0.0.0, 127.0.0.1, ::}, and local paths or env_file values that escape the app directory, each with the offending key named."}
```

```forge-requirement
{"id":"REG-FR-02","kind":"requirement","text":"Derive an app name from the repository basename, lowercased, with runs of non-alphanumeric characters collapsed to a hyphen, trimmed at the ends, and truncated to 32 characters. Accept an explicit --name override subject to the same pattern ^[a-z0-9][a-z0-9-]{0,31}$. An existing app with the same name is a conflict error, never an overwrite."}
```

```forge-requirement
{"id":"REG-FR-03","kind":"requirement","text":"Store each app at <root>/apps/<name>/ containing config.toml, secrets.env, workspace/, and state.json. The directory is the authoritative list of apps; listing scans directories and reads configs, and a directory without a valid config is reported as broken rather than skipped silently."}
```

```forge-requirement
{"id":"REG-FR-04","kind":"requirement","text":"Write config.toml with mode 0644 and secrets.env with mode 0600 using a temporary file in the same directory followed by rename. state.json is a cache holding schemaVersion, image references, the last health result, and timestamps; when it is missing or invalid it is rebuilt from the directory and the runtime, and the app remains usable."}
```

```forge-requirement
{"id":"REG-FR-05","kind":"requirement","text":"Take an exclusive per-app lock before any mutating lifecycle operation and a short-lived allocation lock while creating a new app directory. A held lock makes the second operation exit with code 6 and name the holding process. Reject a new app whose port is already declared by another app, regardless of bind address, before any container action."}
```

```forge-requirement
{"id":"REG-FR-06","kind":"requirement","text":"Merge environment for a container from the inline [env] table first and the optional secrets file second, with the secrets file winning on duplicate keys. Parse KEY=VALUE lines with comments and single or double quotes, reject invalid variable names, and never include values in errors, logs, or JSON output."}
```

```forge-requirement
{"id":"REG-NF-01","kind":"constraint","text":"Listing and validating 100 apps on a warm filesystem must complete in under 300 milliseconds."}
```

```forge-requirement
{"id":"REG-NF-02","kind":"constraint","text":"A crash mid-write must leave either the previous complete file or the new complete file, never a partial config."}
```

---

## 7. Non-Functional Requirements

| ID | Canonical Source | Priority |
|----|------------------|----------|
| REG-NF-01 | [REG-NF-01](#REG-NF-01) | Should |
| REG-NF-02 | [REG-NF-02](#REG-NF-02) | Must |

---

## 8. Agent Impact Assessment

Greenfield feature. Planned owners: `cli-engineer` for schema, parsing, naming, environment merging, and the registry store; `platform-engineer` for locks and port conflict checks. No coordinator ownership.

---

## 9. Implementation Phases

### Phase 1: Configuration and Registry

```forge-task
{
  "id": "REG-1.1",
  "title": "Parse and validate AppSpec from TOML",
  "description": "Implement the zod AppSpec schema and the TOML parser. Cover the repo-or-local_path exclusivity, required port, defaults for ref, container_port, bind, probe, health_path, health_interval_ms, health_timeout_ms, health_startup_ms, and the volumes table. Reject unknown keys, invalid types, privileged or out-of-range ports, unsupported bind addresses, and path traversal in local_path or env_file. Produce errors that name the key and the received value without echoing secret content. Tests cover a minimal valid config, every default, each rejection class, and a config with comments preserved on round-trip.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["PRE-1.3"],
  "expectedOutputs": ["src/config/schema.ts", "src/config/parse.ts", "tests/unit/config-parse.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/config-parse.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/03-app-registry-and-config.md#REG-FR-01"],
    "acceptanceCriteria": ["Exactly one of repo and local_path is required", "Every default is asserted by a test", "Unknown keys and traversal attempts fail with the key named", "Ports below 1024 and above 65535 are rejected"],
    "constraints": ["Validation happens before any filesystem or process mutation", "Error text never includes env values"],
    "constraintRefs": ["docs/PRD.md#PRD-NF-03", "docs/PRD.md#PRD-SP-05"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces", "docs/PRD.md#7.2 Project structure"]
  }
}
```

```forge-task
{
  "id": "REG-1.2",
  "title": "Derive and validate app names",
  "description": "Implement name derivation and validation. Lowercase the repository basename, replace runs of characters outside a-z0-9 with a single hyphen, trim hyphens, truncate to 32 characters, and reject an empty result or a result starting with a digit-only segment when it would be ambiguous. Accept an override and validate it against the same pattern. Detect an existing app directory and return a conflict error. Tests cover GitHub and GitLab URLs with .git suffixes, scp-style SSH URLs, local paths, unicode, reserved-looking names, over-long names, and collisions.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["PRE-1.2"],
  "expectedOutputs": ["src/config/name.ts", "tests/unit/config-name.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/config-name.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/03-app-registry-and-config.md#REG-FR-02"],
    "acceptanceCriteria": ["Every derived name matches the documented pattern", "Collisions return a conflict error rather than overwriting", "URL, scp-style, and local-path inputs are supported"],
    "constraints": ["Names are never derived from user input without sanitization"],
    "constraintRefs": ["docs/PRD.md#PRD-SP-05"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces"]
  }
}
```

```forge-task
{
  "id": "REG-1.3",
  "title": "Implement the on-disk registry and state cache",
  "description": "Implement store.ts and state.ts. Listing scans apps/, reads each config, and reports broken entries with the parse error instead of hiding them. Writing config.toml and secrets.env uses a same-directory temporary file plus rename with the documented modes. state.json is read leniently, rebuilt when missing or invalid, and written atomically. Deleting an app removes its directory only after the caller has confirmed. Tests use a temporary root to cover list, read, write, broken entry, missing state rebuild, corrupt state rebuild, atomic replace under a simulated write failure, and mode bits.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["REG-1.1", "REG-1.2", "PRE-1.2"],
  "expectedOutputs": ["src/registry/store.ts", "src/registry/state.ts", "tests/unit/registry-store.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/registry-store.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/03-app-registry-and-config.md#REG-FR-03", "docs/features/03-app-registry-and-config.md#REG-FR-04"],
    "acceptanceCriteria": ["A broken config is listed with its error rather than skipped", "Deleting state.json and re-listing does not lose the app", "A simulated write failure leaves the previous file intact", "config.toml is 0644 and secrets.env is 0600"],
    "constraints": ["No writes outside the app directory", "The directory, not the cache, determines which apps exist"],
    "constraintRefs": ["docs/features/03-app-registry-and-config.md#REG-NF-02", "docs/PRD.md#PRD-NF-06"],
    "references": ["docs/PRD.md#7.2 Project structure", "docs/PRD.md#13. System States / Lifecycle"]
  }
}
```

```forge-task
{
  "id": "REG-1.4",
  "title": "Add per-app locks and port conflict checks",
  "description": "Implement lock.ts with an exclusive lock file inside the app directory that records pid and start time, fails immediately with exit code 6 when held by a live process, and reclaims a lock whose process no longer exists. Implement ports.ts to reject a declared port already used by another app and to reject privileged ports. Tests cover acquire, release, contention, stale reclamation, lock release on error, and port conflicts across apps with different bind addresses.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["REG-1.3"],
  "expectedOutputs": ["src/platform/lock.ts", "src/registry/ports.ts", "tests/unit/lock.test.ts", "tests/unit/ports.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/lock.test.ts", "npm test -- tests/unit/ports.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/03-app-registry-and-config.md#REG-FR-05"],
    "acceptanceCriteria": ["A second mutation on the same app exits 6 and names the holder", "A stale lock from a dead pid is reclaimed", "A duplicate port is rejected before any container action", "The lock is released when the operation throws"],
    "constraints": ["No global lock around read-only commands", "Port equality alone is the conflict rule"],
    "constraintRefs": ["docs/PRD.md#PRD-NF-03"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces", "docs/PRD.md#12.2 Interaction rules"]
  }
}
```

```forge-task
{
  "id": "REG-1.5",
  "title": "Merge inline environment with the secrets file",
  "description": "Implement env.ts to read the optional secrets file, parse KEY=VALUE lines with comments and quoted values, validate variable names, and merge inline [env] with the file so the file wins on duplicates. Reject invalid names with the line number and never include the value. Expose a redacted view for diagnostics. Tests cover comments, quotes, blank lines, duplicate keys, invalid names, a missing file when one is declared, and redaction in error paths.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["REG-1.1", "REG-1.3"],
  "expectedOutputs": ["src/config/env.ts", "tests/unit/config-env.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/config-env.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/03-app-registry-and-config.md#REG-FR-06"],
    "acceptanceCriteria": ["File values override inline values on duplicate keys", "An invalid variable name reports the line, not the value", "A declared but missing secrets file is a usage error", "The redacted view never contains a value"],
    "constraints": ["Secrets are never written to config.toml", "Secrets are never logged"],
    "constraintRefs": ["docs/PRD.md#PRD-SP-01", "docs/PRD.md#PRD-NF-10"],
    "references": ["docs/PRD.md#10. Security and Privacy", "docs/PRD.md#7.3 Key APIs / interfaces"]
  }
}
```

---

## 10. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit Tests | Schema, defaults, naming, store, state cache, locks, ports, env merge | Vitest with temporary roots and injected clocks/process checks |
| Integration Tests | Real filesystem behavior under the state root | Covered indirectly by lifecycle integration tests in feature 04 |
| Regression Tests | Unknown-key rejection, traversal rejection, atomic write failure | Table-driven cases that fail on any silent acceptance |

Key test scenarios:

1. Minimal config parses and every default is asserted.
2. Unknown key and path traversal are rejected with the key named.
3. Names derived from HTTPS, SSH, scp-style, and local-path inputs.
4. Broken config appears in `list` with its error.
5. Deleting `state.json` does not lose the app.
6. A duplicate port is rejected before mutation.
7. A stale lock is reclaimed; a live lock exits 6.
8. Secrets-file values override inline values and never appear in errors.

---

## 11. Rollback Considerations

Reverting removes `src/config/`, `src/registry/`, and their tests. Any app directories created by later features remain valid TOML but become unreadable to the reverted binary; the operations guide must state that downgrading requires deleting or manually archiving `apps/`. No data outside the state root is touched.

---

## 12. Acceptance Criteria

1. A minimal config parses with documented defaults and a fully specified config round-trips with comments intact.
2. Unknown keys, invalid types, privileged ports, and traversal attempts are rejected with the offending key named.
3. App names match the pattern for URL, SSH, scp-style, and local-path inputs.
4. Listing reports broken apps instead of hiding them.
5. `state.json` is rebuildable and never authoritative.
6. Writes are atomic and file modes match the documented values.
7. Two apps cannot declare the same port.
8. A concurrent mutation on one app exits with code 6 and names the holder.
9. Secrets-file values override inline values and never appear in output.

---

## 13. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should `bind = "::"` be allowed for IPv6-only hosts? | Yes, but it conflicts with any same-port app just like `0.0.0.0`. |
| 2 | Is the secrets file path relative to the app directory or absolute? | Relative to the app directory, with no traversal; absolute paths are rejected in v1. |
| 3 | Should the config support a `[build]` table for Railpack variables? | Not in v1; environment variables cover the common case, and a build table is a future addition. |
| 4 | Does a broken config block `list`? | No; it appears as `broken` with the parse error, and other apps still list. |
