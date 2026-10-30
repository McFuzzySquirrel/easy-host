# Feature: Add and Lifecycle

## 1. Feature Overview

**Feature Name:** Add and Lifecycle
**Parent Document:** [PRD](../PRD.md)
**Status:** Draft
**Summary:** The first end-to-end path: gather input, clone the repo, build the image, create volumes, run the container with a restart policy and a published port, probe it, and record the result — plus the read-only commands an operator uses every day.
**Scope:** `add` (interactive prompts and flags), git and local workspace preparation, container creation, the health probe, failed-add cleanup, preflight checks, and `list`, `status`, `logs`, and `config`.
**Dependencies:** [BuildKit and Railpack](02-buildkit-and-railpack.md), [App Registry and Config](03-app-registry-and-config.md).

---

## 2. Context: Existing System State

Greenfield feature. It composes the builder from feature 02, the config and registry from feature 03, and the paths and errors from feature 01. This is the first feature whose integration test starts a real container and probes it over HTTP.

---

## 3. Feature Goals and Non-Goals

### 3.1 Goals

- Make the origin story real: one command from a git URL to a reachable URL.
- Make `add` pleasant interactively and scriptable non-interactively without two divergent code paths.
- Leave a recoverable state when the first start is unhealthy: no mystery container restarting forever.
- Give the operator four read commands that answer "what is running, where, and why".

### 3.2 Non-Goals

- No update, rollback, or remove; those are features 05 and 06.
- No zero-downtime behavior; `add` has nothing to protect yet.
- No drift reconciliation or JSON schema stability; feature 07 owns those.
- No multi-service apps, no compose files, no sidecars.

---

## 4. User Stories

| ID | Canonical Source | Ownership | Priority |
|----|------------------|-----------|----------|
| ADD-US-01 | [ADD-US-01](#ADD-US-01) | Owns | Must |
| ADD-US-02 | [ADD-US-02](#ADD-US-02) | Owns | Must |
| ADD-US-03 | [ADD-US-03](#ADD-US-03) | Owns | Must |
| ADD-US-04 | [ADD-US-04](#ADD-US-04) | Owns | Should |

```forge-requirement
{"id":"ADD-US-01","kind":"story","text":"As a homelab operator, I want to add a repository with one command and get a URL so that hosting an app takes minutes."}
```

```forge-requirement
{"id":"ADD-US-02","kind":"story","text":"As an occasional maintainer, I want a failed first start to leave a clean, inspectable state so that I can fix the config instead of debugging a restart loop."}
```

```forge-requirement
{"id":"ADD-US-03","kind":"story","text":"As a VPS tinkerer, I want to script add with flags so that provisioning is reproducible."}
```

```forge-requirement
{"id":"ADD-US-04","kind":"story","text":"As a homelab operator, I want to see whether an app is actually serving so that I stop guessing from container status."}
```

---

## 5. Technical Approach

### 5.1 Impact on Existing Architecture

Adds `src/platform/git.ts`, `src/platform/podman.ts`, `src/health/probe.ts`, `src/lifecycle/add.ts`, `src/cli/prompts.ts`, and the command handlers for `add`, `list`, `status`, `logs`, and `config`. The `add` handler is the composition root: it validates, prepares the workspace, calls the builder, creates runtime resources, probes, and persists state.

### 5.2 New Components

| Path | Responsibility |
|---|---|
| `src/platform/git.ts` | Clone at ref, fetch, reset, and report git failures without leaking credentials in URLs |
| `src/platform/podman.ts` | Run, stop, remove, inspect, logs, and volume operations with argument arrays |
| `src/health/probe.ts` | HTTP GET and TCP probes with interval, per-attempt timeout, and total budget |
| `src/lifecycle/add.ts` | Add orchestration and failure cleanup |
| `src/cli/prompts.ts` | Interactive prompts behind an injectable interface |
| `src/cli/commands/add.ts`, `list.ts`, `status.ts`, `logs.ts`, `config.ts` | Command wiring |

### 5.3 Technology Additions

`@clack/prompts` 1.8.1 for prompts and Node's global `fetch` with `AbortSignal.timeout` for HTTP probes. No HTTP client dependency is added.

---

## 6. Functional Requirements

| ID | Canonical Source | Affects Existing | Priority |
|----|------------------|------------------|----------|
| ADD-FR-01 | [ADD-FR-01](#ADD-FR-01) | Yes — `add` command | Must |
| ADD-FR-02 | [ADD-FR-02](#ADD-FR-02) | No — creates `git.ts` | Must |
| ADD-FR-03 | [ADD-FR-03](#ADD-FR-03) | No — creates `podman.ts` | Must |
| ADD-FR-04 | [ADD-FR-04](#ADD-FR-04) | No — creates `probe.ts` | Must |
| ADD-FR-05 | [ADD-FR-05](#ADD-FR-05) | No — `add.ts` | Must |
| ADD-FR-06 | [ADD-FR-06](#ADD-FR-06) | Yes — read commands | Must |
| ADD-FR-07 | [ADD-FR-07](#ADD-FR-07) | No — preflight | Must |

```forge-requirement
{"id":"ADD-FR-01","kind":"requirement","text":"Run add interactively on a TTY, prompting only for values not supplied as flags: repository or local path, name, port, ref, container port, bind, health path, and secret file. Every prompt has a flag equivalent. In a non-TTY, require flags and fail with a usage error that names the first missing value rather than prompting."}
```

```forge-requirement
{"id":"ADD-FR-02","kind":"requirement","text":"Prepare a workspace by cloning the declared ref into apps/<name>/workspace with the system git binary, or by using the given local path in place for --local mode. Local mode is marked dev-only in output and config-derived status. Git failures distinguish missing repository, authentication failure, and unknown ref, and never print a credential embedded in a URL."}
```

```forge-requirement
{"id":"ADD-FR-03","kind":"requirement","text":"Create and start the container with --restart=always, the declared bind and host port published to the declared container port, PORT set to the container port, merged environment variables, one named volume per declared mount named easy-host-<app>-<volume>, and labels io.easy-host.app, io.easy-host.role=app, and io.easy-host.image. The container is named easy-host-<app>."}
```

```forge-requirement
{"id":"ADD-FR-04","kind":"requirement","text":"Decide health by probing 127.0.0.1 on the declared host port: HTTP GET on health_path by default, treating 2xx and 3xx as healthy, or a TCP connect when probe is tcp. Default timing is a 2-second interval, 5-second per-attempt timeout, and 90-second total budget, all overridable per app. A timeout is a failure, not a retry-forever."}
```

```forge-requirement
{"id":"ADD-FR-05","kind":"requirement","text":"When the first health probe fails during add, stop and remove the container, keep the built image and the app directory, record an unhealthy state with the probe error, exit with code 4, and print the logs and config remediation commands. Do not leave a restarting container behind."}
```

```forge-requirement
{"id":"ADD-FR-06","kind":"requirement","text":"Provide list to show name, status, port, ref, last update, and image for every app; status to show one app's full detail including probe configuration and last health result; logs to pass through podman logs with -f and --tail; and config to print the config path, validate it, or open it in the editor named by EDITOR."}
```

```forge-requirement
{"id":"ADD-FR-07","kind":"requirement","text":"Before any mutation, reject a name collision, a port already declared by another app, a missing or invalid config value, an unknown ref, an occupied container name, and an unreachable prerequisite. Each rejection names the conflicting app or the failed check and exits with the documented code."}
```

```forge-requirement
{"id":"ADD-NF-01","kind":"constraint","text":"The add command must not create a container, volume, or directory entry until config validation, name allocation, port checks, and prerequisites have all passed."}
```

```forge-requirement
{"id":"ADD-NF-02","kind":"constraint","text":"Every probe attempt is bounded by its per-attempt timeout and the whole probe by the startup budget; no probe may hang on a half-open connection."}
```

---

## 7. Non-Functional Requirements

| ID | Canonical Source | Priority |
|----|------------------|----------|
| ADD-NF-01 | [ADD-NF-01](#ADD-NF-01) | Must |
| ADD-NF-02 | [ADD-NF-02](#ADD-NF-02) | Must |

---

## 8. Agent Impact Assessment

Greenfield feature. Planned owners: `platform-engineer` for git, podman, and the probe; `lifecycle-engineer` for add orchestration and the read commands; `qa-engineer` for the gated add integration test in collaboration with the lifecycle owner.

---

## 9. Implementation Phases

### Phase 1: Building Blocks

```forge-task
{
  "id": "ADD-1.1",
  "title": "Clone and prepare a git workspace",
  "description": "Implement git.ts with clone, fetch, and checkout against the system git binary. Clone into apps/<name>/workspace at the declared ref, fail with distinct messages for missing repository, authentication failure, and unknown ref, and redact any credential embedded in the URL. Implement local mode by validating and returning the provided path without copying it. Tests use a temporary bare repository and an injected runner to cover success, unknown ref, auth failure, URL redaction, and local mode.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["REG-1.3", "PRE-1.3"],
  "expectedOutputs": ["src/platform/git.ts", "tests/unit/git.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/git.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/04-add-and-lifecycle.md#ADD-FR-02"],
    "acceptanceCriteria": ["A credential in a URL never appears in an error", "Unknown ref and auth failure produce distinct messages", "Local mode does not copy the directory", "Clone target is confined to the app workspace"],
    "constraints": ["Use the operator's existing git credentials", "No shell interpolation"],
    "constraintRefs": ["docs/PRD.md#PRD-SP-02", "docs/PRD.md#PRD-SP-04"],
    "references": ["docs/PRD.md#6.3 What the operator must provide", "docs/PRD.md#7.3 Key APIs / interfaces"]
  }
}
```

```forge-task
{
  "id": "ADD-1.2",
  "title": "Wrap Podman container and volume operations",
  "description": "Implement podman.ts with run, stop, remove, inspect, logs, and volume create/list/remove. Every call uses an argument array and a finite timeout. The run path sets --restart=always, names the container easy-host-<app>, publishes bind:port:containerPort, sets PORT, passes the merged environment without echoing it, mounts each declared named volume, and applies the io.easy-host labels. Tests use a recording runner to assert the exact argument arrays for a full run, a minimal run, a volume mount, and a log pass-through, and assert that env values never appear in diagnostics.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["REG-1.4", "REG-1.5", "PRE-1.3"],
  "expectedOutputs": ["src/platform/podman.ts", "tests/unit/podman.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/podman.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/04-add-and-lifecycle.md#ADD-FR-03"],
    "acceptanceCriteria": ["The run argument array contains restart, publish, PORT, volumes, and labels exactly once each", "Environment values are passed but never printed", "Every podman call has a timeout", "Inspect results are normalized into a typed view"],
    "constraints": ["Never use privileged mode, host networking, or extra capabilities", "Never shell-interpolate a value"],
    "constraintRefs": ["docs/PRD.md#PRD-SP-03", "docs/PRD.md#PRD-SP-04"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces", "docs/PRD.md#13. System States / Lifecycle"]
  }
}
```

```forge-task
{
  "id": "ADD-1.3",
  "title": "Probe HTTP and TCP health with a bounded budget",
  "description": "Implement probe.ts with an injectable clock and fetch. HTTP mode issues GET http://127.0.0.1:<port><health_path>, treats 2xx and 3xx as healthy, and any other status, network error, or timeout as an attempt failure. TCP mode connects to 127.0.0.1:<port>. Repeat at the declared interval until healthy or the startup budget expires, and return a structured result with attempts, last error, and elapsed time. Tests use a local HTTP server and fake clock to cover immediate success, success after retries, 500 responses, connection refused, timeout, TCP success, and budget exhaustion.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["REG-1.1"],
  "expectedOutputs": ["src/health/probe.ts", "tests/unit/probe.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/probe.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/04-add-and-lifecycle.md#ADD-FR-04"],
    "acceptanceCriteria": ["2xx and 3xx are healthy; 4xx, 5xx, refused, and timeout are failures", "The 2s/5s/90s defaults are asserted", "Every attempt is bounded by the per-attempt timeout", "The result reports attempt count and elapsed time"],
    "constraints": ["The probe never retries past the startup budget", "Probe output never includes response bodies that might contain secrets"],
    "constraintRefs": ["docs/features/04-add-and-lifecycle.md#ADD-NF-02"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces", "docs/PRD.md#12.3 Error shape"]
  }
}
```

### Phase 2: Add and Read Commands

```forge-task
{
  "id": "ADD-1.4",
  "title": "Orchestrate add with prompts and failure cleanup",
  "description": "Implement add.ts and prompts.ts. Run preflight (name, port, config, prerequisites), then clone or validate the local path, build the image through the builder interface, create volumes, run the container, probe health, and persist state. On probe failure, remove the container, keep the image and app entry, record unhealthy state, and exit 4 with logs and config remediation. Prompts ask only for missing values and never in a non-TTY. Tests inject fake builder, runtime, probe, and prompter to cover the happy path, missing flag non-TTY, each preflight rejection, build failure, probe failure cleanup, and local-mode warning.",
  "ownerAgent": "lifecycle-engineer",
  "dependencies": ["ADD-1.1", "ADD-1.2", "ADD-1.3", "BLD-1.3", "REG-1.5"],
  "expectedOutputs": ["src/lifecycle/add.ts", "src/cli/prompts.ts", "src/cli/commands/add.ts", "tests/unit/add.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/add.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/04-add-and-lifecycle.md#ADD-FR-01", "docs/features/04-add-and-lifecycle.md#ADD-FR-05", "docs/features/04-add-and-lifecycle.md#ADD-FR-07"],
    "acceptanceCriteria": ["No resource is created before preflight passes", "A non-TTY missing a flag fails with that flag named", "Probe failure removes only the container and keeps the image and app entry", "Every prompt has a flag equivalent"],
    "constraints": ["Do not implement update, rollback, or remove", "Do not auto-pick a port"],
    "constraintRefs": ["docs/features/04-add-and-lifecycle.md#ADD-NF-01", "docs/PRD.md#PRD-NF-03"],
    "references": ["docs/PRD.md#6.1 Core loop / workflow", "docs/PRD.md#13. System States / Lifecycle"]
  }
}
```

```forge-task
{
  "id": "ADD-1.5",
  "title": "Implement list, status, logs, and config",
  "description": "Implement the four read commands. list scans the registry, inspects each app container, and prints a compact table with name, status, port, ref, last update, and image; broken apps appear with their error. status takes one app and prints config, image references, probe settings, container state, and last health result. logs passes through podman logs with -f and --tail and exits with podman's code. config prints the config path, validates on request, and opens EDITOR when asked. Tests cover a mixed registry, a missing app, a stopped container, log flag forwarding, and config validation output.",
  "ownerAgent": "lifecycle-engineer",
  "dependencies": ["ADD-1.4"],
  "expectedOutputs": ["src/cli/commands/list.ts", "src/cli/commands/status.ts", "src/cli/commands/logs.ts", "src/cli/commands/config.ts", "tests/unit/read-commands.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/read-commands.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/04-add-and-lifecycle.md#ADD-FR-06"],
    "acceptanceCriteria": ["list shows every app, including broken and missing ones", "status of an unknown app exits 5", "logs forwards -f and --tail exactly", "config --path prints an existing path"],
    "constraints": ["Read-only commands never mutate state", "No ANSI escapes outside a TTY"],
    "constraintRefs": ["docs/PRD.md#PRD-ACC-02", "docs/PRD.md#PRD-NF-01"],
    "references": ["docs/PRD.md#12.1 Command surface", "docs/PRD.md#12.2 Interaction rules"]
  }
}
```

```forge-task
{
  "id": "ADD-1.6",
  "title": "Prove add end to end on the host",
  "description": "Add the gated integration test for add. For each fixture, run add with flags into a temporary state root, assert the container is running with restart=always, the port is published, the probe succeeded, and the app is reachable over HTTP. Assert the failed-add path by pointing an app at a port with no listener and confirming the container is removed, the image remains, and the exit code is 4. Clean up containers, volumes, images, and the temporary root.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["ADD-1.4", "BLD-1.6"],
  "expectedOutputs": ["tests/integration/add.test.ts"],
  "validationCommands": ["npm run typecheck", "EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/add.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/04-add-and-lifecycle.md#ADD-FR-03", "docs/features/04-add-and-lifecycle.md#ADD-FR-04", "docs/features/04-add-and-lifecycle.md#ADD-FR-05"],
    "acceptanceCriteria": ["All three fixtures are reachable after add", "The failed-add path leaves no container and keeps the image", "Cleanup removes everything the test created", "The test fails rather than skips when the integration variable is absent"],
    "constraints": ["Runs only on the Linux host with Podman >= 5.7.0, < 6.0.0", "Uses a temporary state root"],
    "constraintRefs": ["docs/PRD.md#PRD-NF-07", "docs/PRD.md#PRD-C-10"],
    "references": ["docs/PRD.md#15. Testing Strategy", "docs/PRD.md#6.2 Success / completion criteria"]
  }
}
```

---

## 10. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit Tests | Preflight, prompts, orchestration, failure cleanup, command output | Vitest with fake builder, runtime, probe, and prompter |
| Integration Tests | Real clone, build, run, probe for all three fixtures | `EASY_HOST_INTEGRATION=1` on the Linux host |
| Regression Tests | No mutation before validation, no restart loop after failed add | Assertions on the fake runtime's call log and on real container state |

Key test scenarios:

1. Interactive add asks only for missing values; non-TTY fails fast naming the missing flag.
2. Duplicate port and duplicate name are rejected before any container call.
3. Probe failure removes the container, keeps the image, exits 4.
4. All three fixtures are reachable after add.
5. Unknown app in `status` exits 5.
6. `logs -f --tail 50` forwards both flags.
7. A local-path add is marked dev-only.

---

## 11. Rollback Considerations

Reverting removes the new platform, health, and lifecycle modules and the command handlers for add/list/status/logs/config. Apps created while the feature was present remain as containers and directories; they must be removed with Podman by hand. No host paths or volumes are deleted by the revert itself.

---

## 12. Acceptance Criteria

1. `add <git-url> --port <port>` builds, runs, and probes a supported repo to healthy.
2. Interactive mode prompts only for missing values, and every prompt has a flag.
3. A non-TTY invocation without required flags fails with the missing value named.
4. Port and name collisions fail before any container is created.
5. A failed first probe removes the container, keeps the image and app entry, and exits 4.
6. `list`, `status`, `logs`, and `config` answer the operational questions they claim to.
7. All three fixtures are reachable over HTTP on the host.

---

## 13. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should `add` also accept `--env KEY=VALUE` flags? | Yes, for scripting; values are written to `secrets.env`, never to `config.toml`. |
| 2 | Does `add` print the public URL with the LAN address or `localhost`? | Print both: the LAN URL derived from the host's primary address and the loopback URL. |
| 3 | Should `config --edit` validate after the editor exits? | Yes, and it reports errors without applying anything. |
| 4 | Should `logs` default to a tail? | Yes, `--tail 200`; `-f` follows. |
