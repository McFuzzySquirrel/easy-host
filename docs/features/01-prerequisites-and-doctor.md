# Feature: Prerequisites and Doctor

## 1. Feature Overview

**Feature Name:** Prerequisites and Doctor
**Parent Document:** [PRD](../PRD.md)
**Status:** Draft
**Summary:** Establishes the project skeleton, the state-root resolution rules, the shared error and exit-code contract, the ten-command CLI surface, and `doctor` — the command that tells an operator whether this host can run easy-host at all before they try to add an app.
**Scope:** Repository scaffold (package, TypeScript, Biome, Vitest), XDG state root, error taxonomy, command registration, and the host checks for Podman, lingering, git, and disk. Build-related checks (Railpack, BuildKit) belong to [BuildKit and Railpack](02-buildkit-and-railpack.md); disk reporting detail belongs to [Observability and Output](07-observability-and-output.md).
**Dependencies:** None.

---

## 2. Context: Existing System State

Greenfield feature — no existing system. See [PRD](../PRD.md) for the product definition and settled decisions. The repository currently contains only documentation; this feature creates the first executable code and the test harness every later feature depends on.

---

## 3. Feature Goals and Non-Goals

### 3.1 Goals

- Make the first hour honest: an operator runs one command and learns whether Podman, lingering, git, and disk are ready.
- Give every later command one place to resolve paths, one error shape, and one exit-code contract.
- Make the CLI navigable: ten commands, consistent flags, working help and version output.
- Make the repository testable from the first commit: typecheck, lint, and unit tests run with no Podman and no network.

### 3.2 Non-Goals

- No app lifecycle behavior: `add`, `update`, `rollback`, and `remove` are registered but return a "not implemented" usage error in this feature.
- No Railpack download or BuildKit management.
- No JSON schema for `list` or `status`; only `doctor` and `version` emit JSON here.
- No packaging, completions, or documentation beyond what the scaffold requires.

---

## 4. User Stories

| ID | Canonical Source | Ownership | Priority |
|----|------------------|-----------|----------|
| PRE-US-01 | [PRE-US-01](#PRE-US-01) | Owns | Must |
| PRE-US-02 | [PRE-US-02](#PRE-US-02) | Owns | Must |
| PRE-US-03 | [PRE-US-03](#PRE-US-03) | Owns | Should |

```forge-requirement
{"id":"PRE-US-01","kind":"story","text":"As a homelab operator, I want to check my host before adding an app so that a missing prerequisite does not surface as a confusing build failure."}
```

```forge-requirement
{"id":"PRE-US-02","kind":"story","text":"As an occasional maintainer, I want every failure to tell me what to run next so that I do not have to read the source to recover."}
```

```forge-requirement
{"id":"PRE-US-03","kind":"story","text":"As a VPS tinkerer, I want a stable exit code and a JSON doctor report so that my monitoring can tell a broken host from a broken app."}
```

---

## 5. Technical Approach

### 5.1 Impact on Existing Architecture

Creates the architecture. The only pre-existing artifacts are `docs/IDEA.md`, `docs/PRD.md`, and the MyForge harness directory. No existing code is modified.

### 5.2 New Components

| Path | Responsibility |
|---|---|
| `package.json` | ESM package, `bin.easy-host`, `engines.node >= 24`, scripts for build, typecheck, lint, test, integration, packaging |
| `tsconfig.json`, `tsconfig.build.json` | Strict TypeScript 7 configuration; `NodeNext` modules; emit to `dist/` |
| `biome.json` | Lint and format rules, 2-space indent, 100-column width |
| `vitest.config.ts` | Unit test include, coverage thresholds, integration project excluded by default |
| `src/cli/index.ts` | Shebang entry, top-level error handler, exit-code mapping |
| `src/platform/paths.ts` | State-root resolution and directory creation |
| `src/cli/errors.ts` | Error classes and the exit-code table |
| `src/cli/program.ts` | commander program with ten subcommands and global `--json` |
| `src/doctor/index.ts` | Check composition and report rendering |
| `src/doctor/checks.ts` | Podman, lingering, git, and disk checks |

### 5.3 Technology Additions

All versions are verified in [PRD §5.3](../PRD.md#5.3 Verified versions (checked 2026-10-29)). TypeScript 7.0.2, commander 15.0.0, Biome 2.6.4, Vitest 5.0.5, execa 10.2.1, picocolors 1.1.1. TypeScript 7 has no programmatic compiler API, which is why Biome replaces typescript-eslint.

---

## 6. Functional Requirements

| ID | Canonical Source | Affects Existing | Priority |
|----|------------------|------------------|----------|
| PRE-FR-01 | [PRE-FR-01](#PRE-FR-01) | No — creates `paths.ts` | Must |
| PRE-FR-02 | [PRE-FR-02](#PRE-FR-02) | No — creates `checks.ts` | Must |
| PRE-FR-03 | [PRE-FR-03](#PRE-FR-03) | No — creates `checks.ts` | Must |
| PRE-FR-04 | [PRE-FR-04](#PRE-FR-04) | No — creates `checks.ts` | Must |
| PRE-FR-05 | [PRE-FR-05](#PRE-FR-05) | No — creates `errors.ts` | Must |
| PRE-FR-06 | [PRE-FR-06](#PRE-FR-06) | No — creates `program.ts` | Must |
| PRE-FR-07 | [PRE-FR-07](#PRE-FR-07) | No — creates `doctor/` | Must |

```forge-requirement
{"id":"PRE-FR-01","kind":"requirement","text":"Resolve the state root from EASY_HOST_HOME, else XDG_DATA_HOME/easy-host, else ~/.local/share/easy-host. Create apps/, tools/, and buildkit/ beneath it with mode 0700 and refuse to run if the root resolves inside a directory the current user cannot write."}
```

```forge-requirement
{"id":"PRE-FR-02","kind":"requirement","text":"Doctor parses podman version and fails with exit code 2 when Podman is missing, below 6.1, or not running rootless. The failure names the found version, the required minimum, and a distro-specific upgrade starting point."}
```

```forge-requirement
{"id":"PRE-FR-03","kind":"requirement","text":"Doctor reads loginctl show-user <user> -p Linger and reports a failing check when lingering is disabled, explaining that --restart=always containers will not return after reboot without it."}
```

```forge-requirement
{"id":"PRE-FR-04","kind":"requirement","text":"Doctor verifies git is on PATH with version 2.40 or newer and reports the found version when the check fails."}
```

```forge-requirement
{"id":"PRE-FR-05","kind":"requirement","text":"Map every failure to one exit code: 0 success, 1 usage/validation, 2 prerequisite or environment, 3 build, 4 health, 5 app not found, 6 conflict or lock held. Unexpected exceptions exit 7 and print a short diagnostic with a bug-report hint instead of a raw stack."}
```

```forge-requirement
{"id":"PRE-FR-06","kind":"requirement","text":"Register exactly ten subcommands — add, list, status, logs, update, rollback, remove, config, doctor, version — with working --help, a global --json flag accepted by doctor and version in this feature, and a non-zero exit for unknown commands and missing required arguments."}
```

```forge-requirement
{"id":"PRE-FR-07","kind":"requirement","text":"Doctor prints a stable ordered report of pass, warn, and fail checks to stdout, with a remediation line for every non-pass check, and emits the same data as JSON with schemaVersion 1 when --json is passed."}
```

```forge-requirement
{"id":"PRE-NF-01","kind":"constraint","text":"On a healthy host, doctor must finish in under 2 seconds and must not contact the network."}
```

```forge-requirement
{"id":"PRE-NF-02","kind":"constraint","text":"A non-pass check must never be reported as a pass, and doctor must exit 2 when any check fails."}
```

---

## 7. Non-Functional Requirements

| ID | Canonical Source | Priority |
|----|------------------|----------|
| PRE-NF-01 | [PRE-NF-01](#PRE-NF-01) | Should |
| PRE-NF-02 | [PRE-NF-02](#PRE-NF-02) | Must |

---

## 8. Agent Impact Assessment

Greenfield feature — agents will be generated from all feature documents together. Planned owners in this feature: `cli-engineer` for the scaffold, paths, errors, program, and doctor; no coordinator agent may own an implementation task.

---

## 9. Implementation Phases

### Phase 1: Foundation and Host Checks

```forge-task
{
  "id": "PRE-1.1",
  "title": "Scaffold the TypeScript CLI repository",
  "description": "Create the runnable package skeleton. Set up an ESM package named easy-host with bin.easy-host pointing at dist/cli/index.js, engines.node >= 24, and scripts build, typecheck, lint, test, test:integration, test:packaging. Add strict TypeScript 7 configs that emit ESM to dist, a Biome config, and a Vitest config that excludes tests/integration from the default run. Create a minimal src/cli/index.ts with a shebang that prints the version and exits 0, plus a unit test that imports the entry module and asserts the version output. Do not implement any subcommand behavior.",
  "ownerAgent": "cli-engineer",
  "dependencies": [],
  "expectedOutputs": ["package.json", "tsconfig.json", "tsconfig.build.json", "biome.json", "vitest.config.ts", "src/cli/index.ts", "tests/unit/cli-entry.test.ts"],
  "validationCommands": ["npm run typecheck", "npm run lint", "npm test -- tests/unit/cli-entry.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/01-prerequisites-and-doctor.md#PRE-FR-06"],
    "acceptanceCriteria": ["The entry module runs under Node 24 and prints the package version", "The unit test passes with no Podman and no network", "Typecheck and lint pass on the scaffold"],
    "constraints": ["No bundler: emit with tsc to dist", "No runtime dependency on the TypeScript compiler API"],
    "constraintRefs": ["docs/PRD.md#PRD-NF-07"],
    "references": ["docs/PRD.md#7.2 Project structure", "docs/PRD.md#7.1 Technology stack"]
  }
}
```

```forge-task
{
  "id": "PRE-1.2",
  "title": "Resolve and create the state root",
  "description": "Implement the Paths module. Resolve the root from EASY_HOST_HOME, then XDG_DATA_HOME/easy-host, then ~/.local/share/easy-host. Provide typed accessors for appsDir, appDir(name), toolsDir, and buildkitDir, and an ensureLayout() that creates the tree with mode 0700. Reject a root that is not writable by the current user with exit-code class 2. Unit tests cover all three resolution orders, tilde expansion, mode bits on a temporary directory, and the unwritable-root failure.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["PRE-1.1"],
  "expectedOutputs": ["src/platform/paths.ts", "tests/unit/paths.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/paths.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/01-prerequisites-and-doctor.md#PRE-FR-01"],
    "acceptanceCriteria": ["All three resolution orders are covered by tests", "Created directories have mode 0700", "An unwritable root produces a prerequisite error, not an unhandled exception"],
    "constraints": ["Never create directories outside the resolved root"],
    "constraintRefs": ["docs/PRD.md#PRD-SP-05"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces"]
  }
}
```

```forge-task
{
  "id": "PRE-1.3",
  "title": "Define the error taxonomy and exit codes",
  "description": "Create typed errors for usage, prerequisite, build, health, not-found, conflict, and internal failures, each carrying a stable exit code, a one-line summary, an optional remediation command, and optional structured details. Add a renderer that prints the summary, details, and remediation as separate lines, and an exit-code mapper used by the CLI entry. Tests assert the code for each error class, remediation rendering, redaction of any key whose name matches secret, token, password, or key, and that unknown exceptions map to 7 without a stack trace in normal output.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["PRE-1.1"],
  "expectedOutputs": ["src/cli/errors.ts", "tests/unit/errors.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/errors.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/01-prerequisites-and-doctor.md#PRE-FR-05"],
    "acceptanceCriteria": ["Each failure class maps to the documented exit code", "Rendered output separates summary, detail, and remediation lines", "Secret-looking detail values are redacted in both human and JSON output"],
    "constraints": ["No raw stack traces unless EASY_HOST_DEBUG=1 is set"],
    "constraintRefs": ["docs/PRD.md#PRD-NF-02", "docs/PRD.md#PRD-NF-10"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces", "docs/PRD.md#12.3 Error shape"]
  }
}
```

```forge-task
{
  "id": "PRE-1.4",
  "title": "Register the ten-command CLI surface",
  "description": "Create the commander program with exactly add, list, status, logs, update, rollback, remove, config, doctor, and version. Declare the documented flags for each command, including the global --json flag, and wire each command to a handler module that currently throws a usage error for unimplemented lifecycle behavior. Add --help text with one-line command descriptions and a version command that prints the package version. Tests assert the command list, that unknown commands exit non-zero, that missing required arguments exit non-zero, and that help output contains every command.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["PRE-1.1", "PRE-1.3"],
  "expectedOutputs": ["src/cli/program.ts", "tests/unit/program.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/program.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/01-prerequisites-and-doctor.md#PRE-FR-06"],
    "acceptanceCriteria": ["Exactly ten commands are registered and listed in help", "Unknown command and missing argument paths exit with code 1", "version prints a semver-shaped string and exits 0"],
    "constraints": ["Do not implement lifecycle behavior in this task", "Do not add a start, stop, restart, or prune command"],
    "constraintRefs": ["docs/PRD.md#PRD-C-01"],
    "references": ["docs/PRD.md#12.1 Command surface", "docs/features/01-prerequisites-and-doctor.md#6. Functional Requirements"]
  }
}
```

```forge-task
{
  "id": "PRE-1.5",
  "title": "Implement doctor host checks",
  "description": "Add doctor with an ordered check list covering Podman presence and version, rootless mode, user lingering, git version, and free disk space. Each check returns pass, warn, fail, or skip with a detail line and a remediation line. Doctor exits 0 when all checks pass or warn and 2 when any check fails. Support --json with schemaVersion 1, a checks array, and an overall status. Tests inject a recording process runner and cover Podman missing, Podman 4.9.3, Podman 6.1.4 rootless, lingering disabled, git too old, low disk, all-pass output, JSON shape, and the 2-second no-network budget using a fake clock.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["PRE-1.2", "PRE-1.3", "PRE-1.4"],
  "expectedOutputs": ["src/doctor/checks.ts", "src/doctor/index.ts", "src/cli/commands/doctor.ts", "tests/unit/doctor.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/doctor.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/01-prerequisites-and-doctor.md#PRE-FR-02", "docs/features/01-prerequisites-and-doctor.md#PRE-FR-03", "docs/features/01-prerequisites-and-doctor.md#PRE-FR-04", "docs/features/01-prerequisites-and-doctor.md#PRE-FR-07"],
    "acceptanceCriteria": ["Podman below 6.1 fails with exit code 2 and names the found and required versions", "Lingering disabled is reported as a failure with the enable-linger remediation", "Git below 2.40 fails and prints the found version", "JSON mode emits schemaVersion 1 with no ANSI escapes", "A failing check is never reported as pass"],
    "constraints": ["Doctor performs no network calls", "Doctor does not install or upgrade anything"],
    "constraintRefs": ["docs/features/01-prerequisites-and-doctor.md#PRE-NF-01", "docs/features/01-prerequisites-and-doctor.md#PRE-NF-02", "docs/PRD.md#PRD-NF-01"],
    "references": ["docs/PRD.md#6.3 What the operator must provide", "docs/PRD.md#7.1 Technology stack"]
  }
}
```

---

## 10. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit Tests | Paths, errors, command registration, doctor checks | Vitest with a recording fake process runner and temporary directories |
| Integration Tests | Real host values for Podman, git, and lingering | Not in this feature; the checks are covered by injected fakes and exercised for real in the release gate |
| Regression Tests | Exit-code contract and JSON shape | Snapshot tests on rendered output and JSON payloads |

Key test scenarios:

1. All three root-resolution orders, including tilde expansion.
2. Doctor failure for Podman 4.9.3 and pass for 6.1.4 rootless.
3. Lingering disabled produces a failure with the linger remediation.
4. Git 2.39 fails; 2.40 passes.
5. Unknown command exits 1; unimplemented lifecycle command exits 1 with a "not implemented" usage message.
6. Doctor JSON parses, contains schemaVersion 1, and has no ANSI escapes.

---

## 11. Rollback Considerations

This feature creates new files only. Reverting removes `src/`, `tests/`, and the root configuration files; there is no persisted state, no container, and no migration. Any later feature that depends on the exit-code table or path layout must be reverted first.

---

## 12. Acceptance Criteria

1. The package installs dependencies, typechecks, lints, and runs unit tests with no Podman and no network.
2. `easy-host --help` lists exactly ten commands and `easy-host version` prints the package version.
3. `easy-host doctor` reports Podman, rootless mode, lingering, git, and disk, and exits 2 on a failing check.
4. `easy-host doctor --json` emits `schemaVersion: 1`, a checks array, and no ANSI escapes.
5. The state root resolves from `EASY_HOST_HOME`, `XDG_DATA_HOME`, or the home fallback, and is created with `0700`.
6. Error rendering never prints a raw stack trace unless `EASY_HOST_DEBUG=1`.

---

## 13. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should doctor also check Node.js version, given every later command needs it? | Yes, add a Node check in PRE-1.5 alongside git; it is part of the host prerequisite set. |
| 2 | Is the disk threshold a fixed constant or configurable? | Fixed constants in v1: warn below 5 GiB, fail below 2 GiB. |
| 3 | Should `doctor` run automatically before the first `add`? | No; `add` performs its own preflight and points at `doctor` on failure. |
