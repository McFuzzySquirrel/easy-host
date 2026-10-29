# easy-host

## 1. Overview

**Product Name:** easy-host
**Summary:** A Linux CLI that turns a git repository into a long-running, self-hosted HTTP service on one machine. It clones the repo, builds an image with Railpack (no per-repo Dockerfile), runs it under rootless Podman with a restart policy on a port the operator declares, health-gates every update, keeps the last two images for rollback, and removes apps without ever deleting data by accident.
**Target Platform:** Linux only (x86_64 and arm64), rootless Podman 6.1 or newer, Node.js 24 or newer, system git 2.40 or newer.
**Key Constraints:** Single host; CLI only; one explicit host port per app bound on the LAN by default; no TLS, no bundled reverse proxy, no database, no daemon, no scheduler; secrets are plain `0600` files; observability is `podman logs` passthrough only.

This document is the authoritative product definition. Feature-level requirements, task contracts, and acceptance details live in [docs/features/](features/). Source material for this version: [IDEA.md](IDEA.md).

---

## 2. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-10-29 | forge-build-prd | Initial PRD from the sharpened idea; settles Podman floor 6.1, TOML config, npm-from-repo install, ten-command surface, named volumes, eight-feature decomposition. |

---

## 3. Goals and Non-Goals

### 3.1 Goals

- Make the path from "I have a repo" to "it is a service that survives reboot" a single command with no container authoring.
- Guarantee that a bad deploy does not take the service down: the previous version keeps or regains serving.
- Make rollback a one-command operation with a predictable two-image window.
- Keep the operator's data safe: no command deletes a declared volume unless explicitly asked.
- Stay small enough for one person to operate and reason about: a plain on-disk registry, no database, no control plane.
- Be honest about support: only stacks exercised by the integration suite are claimed.

```forge-requirement
{"id":"PRD-C-01","kind":"constraint","text":"The product surface is a command-line interface only. No web UI, dashboard, HTTP API, or desktop application ships in v1."}
```

```forge-requirement
{"id":"PRD-C-02","kind":"constraint","text":"Run on a single Linux host with rootless Podman 6.1 or newer. No multi-node operation, scheduling, clustering, or orchestrator integration."}
```

```forge-requirement
{"id":"PRD-C-03","kind":"constraint","text":"Expose exactly one explicit host port per app, bound to the LAN (0.0.0.0) by default. The tool ships no TLS termination and no reverse proxy; internet exposure and HTTPS are the operator's responsibility."}
```

```forge-requirement
{"id":"PRD-C-04","kind":"constraint","text":"Ship no daemon, scheduler, webhook receiver, or git polling. Recurring updates are the operator's own systemd timer calling the CLI."}
```

```forge-requirement
{"id":"PRD-C-05","kind":"constraint","text":"Store secrets as plain files with 0600 permissions. Provide no secret manager, no encryption at rest, and no vault integration."}
```

```forge-requirement
{"id":"PRD-C-06","kind":"constraint","text":"Never provision databases or sidecar services. Apps reach external services through environment variables supplied by the operator."}
```

```forge-requirement
{"id":"PRD-C-07","kind":"constraint","text":"Build one image per app and run it as a container. Do not support long-lived pet containers or exec-into-the-container install workflows."}
```

```forge-requirement
{"id":"PRD-C-08","kind":"constraint","text":"Never delete a declared volume during remove unless the operator passes --volumes explicitly, and never delete a host path."}
```

```forge-requirement
{"id":"PRD-C-09","kind":"constraint","text":"Observability is podman logs passthrough only. Store no logs, collect no metrics, and send no alerts."}
```

```forge-requirement
{"id":"PRD-C-10","kind":"constraint","text":"Claim support only for the stacks the integration suite actually builds and probes: Vite/React static SPA, Node/Express, and Python/FastAPI in v1."}
```

```forge-requirement
{"id":"PRD-C-11","kind":"constraint","text":"Send no telemetry, usage data, or crash reports anywhere. The tool must work with no outbound network access beyond git, image pulls, and the pinned Railpack download."}
```

```forge-requirement
{"id":"PRD-C-12","kind":"constraint","text":"Distribute as an npm package installed globally from the repository, since v1 is not published to the npm registry. Require Node.js 24 or newer on the host and provide no single-binary build in v1."}
```

### 3.2 Non-Goals

- Multi-service or compose-style stacks; one repo produces one service.
- Auto-detecting which paths an app needs to persist; the operator declares volumes.
- Zero-downtime deploys; a swap briefly stops the old container because the port is fixed and no proxy exists.
- Version history beyond the last two images.
- Metrics, alerting, log storage, or log rotation.
- Multi-tenant hosting, per-user isolation, or billing.
- Non-Linux hosts, including macOS and Windows through Podman machine.
- Kubernetes, Nomad, or any orchestrator integration.
- CI/CD platform behavior such as build triggers, previews, or pipeline definition.
- Publishing to npm or shipping a Node SEA binary in v1.

---

## 4. User Stories / Personas

### 4.1 Personas

| Persona | Description | Key Needs |
|---------|-------------|-----------|
| Homelab operator | Runs a handful of personal apps 24/7 on a home server or mini PC. Comfortable with a terminal, not with container authoring. | Add a repo and get a URL; survive reboots; undo a bad deploy without SSH archaeology. |
| VPS tinkerer | Runs side projects and small client apps on one cheap VPS, often behind their own proxy later. | Predictable ports, clean removal, no vendor platform, no surprise data loss. |
| Occasional maintainer | Pushes infrequently, returns months later to update or debug. | Readable on-disk config, discoverable commands, honest error messages, logs one command away. |

### 4.2 User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| PRD-US-01 | homelab operator | add a git repo and get a reachable URL without writing a Dockerfile | I can host an app in minutes | Must |
| PRD-US-02 | homelab operator | have apps come back after a reboot | my services are not down until I log in | Must |
| PRD-US-03 | VPS tinkerer | update an app and keep the old version if the new one is broken | a bad commit does not become an outage | Must |
| PRD-US-04 | occasional maintainer | roll back to the previous image with one command | I can recover during an incident | Must |
| PRD-US-05 | VPS tinkerer | remove an app without losing its data unless I ask | a cleanup mistake is not destructive | Must |
| PRD-US-06 | homelab operator | see whether an app is actually serving, not just running | I stop guessing from `podman ps` | Must |
| PRD-US-07 | homelab operator | check prerequisites before my first add | I do not discover a missing dependency mid-build | Should |
| PRD-US-08 | occasional maintainer | script list/status/doctor output | monitoring and timers do not scrape tables | Should |
| PRD-US-09 | homelab operator | install the tool from the repo without a registry | I can run the current version on my host | Must |
| PRD-US-10 | homelab operator | declare persistent data once and have it survive updates | app state is not lost on redeploy | Must |

---

## 5. Research Findings

### 5.1 Prior art and the gap

| Approach | What it does well | Why it is not the answer here |
|---|---|---|
| Hand-written Dockerfile + `podman run` | Total control, no extra tooling | Per-repo authoring and remembered run flags are exactly the pain being removed |
| Docker Compose | Declarative multi-service stacks | Requires authoring YAML per app and has no lifecycle, health gate, or rollback semantics |
| Dokku | Git-push deploys with buildpacks on one host | A platform with its own daemon, proxy, and plugin ecosystem; heavier than the stated need |
| Coolify | Web UI, many integrations | Web UI, database, and control plane are explicit non-goals |
| Kamal | Reproducible container deploys | Aimed at multi-host/proxy setups and expects container knowledge and a proxy |
| Nixpacks / Railpack alone | Detect and build without a Dockerfile | Builds an image but owns no hosting lifecycle: no restart policy, port, health gate, rollback, or removal |

The gap is the hosting and lifecycle layer around the build: clone, build, swap, probe, roll back, remove. That layer is this product. Build detection is delegated.

### 5.2 Technology decisions

- **Railpack over Nixpacks.** Nixpacks is in maintenance mode and its README points at Railpack. Railpack is MIT, actively released, and production-proven at Railway. It is still pre-1.0, so the version is pinned and upgraded deliberately.
- **Podman over Docker.** Rootless by design, daemonless, systemd-friendly, and already the operator's runtime. `--restart=always` under rootless Podman needs lingering enabled, which becomes a documented prerequisite.
- **TOML over YAML/JSON.** Operator-edited files benefit from comments and the absence of indentation traps; JSON has no comments.
- **TypeScript CLI over a shell script.** Argument parsing, schema validation, and testability matter more than startup milliseconds; a Node runtime on the host is an accepted cost.
- **Named volumes over bind mounts.** Rootless UID mapping makes bind mounts a support burden, and a named volume gives `remove --volumes` a safe, scoped deletion target.

### 5.3 Verified versions (checked 2026-10-29)

| Component | Version | Notes |
|---|---|---|
| Railpack | 0.43.0 (2026-10-19) | Pre-1.0; pin exactly. Requires BuildKit. |
| Podman | 6.1.4 (2026-10-12); 6.2.0-rc1 | 5.8 security support ended 2026-09-26; 4.9.3 is EOL. Minimum is 6.1. |
| BuildKit | 0.34.1 (2026-10-20) | Use the `-rootless` image, pinned by digest. |
| Node.js | 26.13.0 LTS (2026-10-28) | Active LTS; 24.x is maintenance. Minimum is 24. |
| TypeScript | 7.0.2 (2026-07-08) | Native compiler; no programmatic API until 7.1. |
| Vitest | 5.0.5 | Node `^22.12 \|\| ^24 \|\| >=26`. |
| Biome | 2.6.4 | Lint and format in one tool; no TypeScript API dependency. |
| commander | 15.0.0 | Node `>=22.12`. |
| zod | 4.6.7 | Config and state validation. |
| smol-toml | 1.9.1 | TOML parse/serialize, Node `>=18`. |
| execa | 10.2.1 | Process execution, Node `>=22`. |
| @clack/prompts | 1.8.1 | Interactive prompts, Node `>=20.12`. |
| picocolors / ora | 1.1.1 / 9.4.1 | Terminal output and progress. |
| system git | >= 2.40 | Repo access uses the operator's credentials. |

### 5.4 Platform finding that shaped the scope

The reference host runs Podman 4.9.3, which is out of security support and also what stock Ubuntu 24.04 and Debian 12 ship. Supporting it would mean owning rootless BuildKit bugs on an unmaintained runtime, so v1 requires Podman 6.1+ and treats upgrading the host as a prerequisite. This is a deliberate trade: a smaller support matrix in exchange for a build layer that can actually work.

### 5.5 Design principles

- **One observable outcome per command.** No command silently does two jobs.
- **Fail before mutating.** Validate config, ports, names, and prerequisites before touching a container.
- **Never destroy data implicitly.** Volumes and host paths require an explicit flag.
- **Say what happened and what to run next.** Every failure names the failed check and a remediation command.
- **Prefer plain files over opaque state.** The operator can read, copy, and repair the registry.

---

## 6. Concept

### 6.1 Core loop / workflow

```text
easy-host add <git-url> --port 8080
        │
        ├─ 1. validate: name, port free, prerequisites, config
        ├─ 2. clone repo at ref into <root>/apps/<app>/workspace
        ├─ 3. ensure buildkitd (rootless, pinned image, unix socket)
        ├─ 4. railpack build  ->  localhost/easy-host-<app>:<timestamp>
        ├─ 5. create volumes, run container (restart=always, published port)
        ├─ 6. probe http://127.0.0.1:<port><health_path> until healthy or 90s
        └─ 7. record state (current image, previous, last health)

easy-host update <app>
        │
        ├─ diff: repo/ref changed?  -> fetch + rebuild + swap
        ├─ diff: config only?       -> recreate container, no build
        ├─ diff: nothing changed?   -> report no-op
        └─ swap: stop old -> start new -> probe -> keep, or stop new -> restart old

easy-host rollback <app>
        └─ swap current/previous, probe, auto-revert on failure

easy-host remove <app> [--volumes]
        └─ container, workspace, images, app dir; volumes only with --volumes
```

### 6.2 Success / completion criteria

Version 0.1.0 is done when this scenario passes on a fresh Linux host with rootless Podman 6.1+, lingering enabled, and an empty easy-host root:

1. `add <git-url>` results in the app reachable at `http://<host>:<port>` from another machine on the LAN.
2. Rebooting the host brings the app back without a manual command.
3. Pushing a broken commit and running `update` leaves the previous version serving.
4. `rollback` restores the previous image and it serves again.
5. `remove` deletes the app and its images but leaves its named volume until `remove --volumes` is run.

### 6.3 What the operator must provide

- A Linux host with rootless Podman 6.1+, `loginctl enable-linger` for the owning user, system git 2.40+, and Node.js 24+.
- One free TCP port per app, at or above 1024 (rootless Podman cannot bind privileged ports without a host sysctl change).
- Credentials for private repos through the existing SSH agent or git credential helper.
- Any external service the app needs (database, object storage) and the environment variables to reach it.

---

## 7. Technical Architecture

### 7.1 Technology stack

| Layer | Choice | Version | Rationale |
|---|---|---|---|
| Runtime | Node.js | >= 24 (26.13.0 LTS verified) | Accepted host cost; native fetch, test runner, modern APIs |
| Language | TypeScript | 7.0.2 | Type safety with the native compiler |
| Build | `tsc` (TypeScript 7) | 7.0.2 | Emit ESM to `dist/`; no bundler needed for a CLI |
| CLI parsing | commander | 15.0.0 | Mature, typed, subcommand support |
| Prompts | @clack/prompts | 1.8.1 | Interactive `add` with flag parity |
| Config | smol-toml + zod | 1.9.1 / 4.6.7 | Comment-friendly TOML, strict schema validation |
| Process I/O | execa | 10.2.1 | Promise API, streaming, exit-code handling |
| Output | picocolors + ora | 1.1.1 / 9.4.1 | TTY-aware color and progress |
| Tests | Vitest | 5.0.5 | Fast unit tests; gated integration suite |
| Lint/format | Biome | 2.6.4 | One tool, one config, no TS API dependency |
| Container engine | rootless Podman | >= 6.1 (6.1.4 verified) | Rootless, daemonless, restart policy |
| Image builder | Railpack | 0.43.0 pinned | Zero-Dockerfile detection and build |
| BuildKit | moby/buildkit rootless | 0.34.1 pinned by digest | Build backend for Railpack |
| Repo access | system git | >= 2.40 | Operator's existing credentials |

### 7.2 Project structure

```text
easy-host/
├── package.json                # bin: easy-host -> dist/cli/index.js, engines >=24
├── tsconfig.json               # strict, NodeNext, ESM
├── tsconfig.build.json
├── biome.json
├── vitest.config.ts
├── src/
│   ├── cli/
│   │   ├── index.ts            # shebang entry, exit-code mapping
│   │   ├── program.ts          # ten commands, global --json
│   │   ├── commands/           # add, list, status, logs, update, rollback,
│   │   │                       # remove, config, doctor, version
│   │   ├── prompts.ts          # interactive add
│   │   ├── output.ts / json.ts / format.ts
│   │   └── errors.ts           # error taxonomy
│   ├── config/
│   │   ├── schema.ts           # zod AppSpec
│   │   ├── parse.ts            # TOML -> AppSpec, unknown keys rejected
│   │   ├── env.ts              # [env] + secrets file merge
│   │   └── name.ts             # derivation and validation
│   ├── registry/
│   │   ├── store.ts            # directory-as-truth
│   │   ├── state.ts            # rebuildable per-app cache
│   │   ├── ports.ts            # cross-app conflict checks
│   │   └── drift.ts            # state vs podman reality
│   ├── lifecycle/
│   │   ├── add.ts / update.ts / rollback.ts / remove.ts
│   │   ├── diff.ts             # config-only vs rebuild
│   │   ├── swap.ts             # stop/start/probe/revert
│   │   └── retain.ts           # keep two images
│   ├── platform/
│   │   ├── paths.ts            # XDG root resolution
│   │   ├── podman.ts           # container/image/volume operations
│   │   ├── git.ts              # clone/fetch/checkout
│   │   ├── railpack.ts         # pinned download + build invocation
│   │   ├── buildkit.ts         # rootless buildkitd lifecycle
│   │   ├── versions.ts         # single source of pinned versions
│   │   └── lock.ts             # per-app and name-allocation locks
│   ├── health/
│   │   └── probe.ts            # HTTP GET (TCP opt-in)
│   └── doctor/
│       ├── index.ts            # check composition
│       ├── checks.ts           # host/core checks
│       ├── build-checks.ts     # railpack/buildkit checks
│       └── disk-checks.ts      # space reporting
├── tests/
│   ├── unit/
│   ├── integration/            # gated by EASY_HOST_INTEGRATION=1
│   ├── packaging/              # clean-prefix install smoke
│   └── docs/                   # link and section checks
├── fixtures/
│   ├── vite-spa/  express-api/  fastapi-app/
├── docs/
│   ├── PRD.md  features/  operations/  reference/  reviews/
└── README.md
```

### 7.3 Key APIs / interfaces

| Interface | Responsibility | Decided behavior |
|---|---|---|
| `Paths` | Resolve the state root | `EASY_HOST_HOME`, else `XDG_DATA_HOME/easy-host`, else `~/.local/share/easy-host`; create `apps/`, `tools/`, `buildkit/` with `0700` |
| `AppSpec` | Typed per-app config | TOML; required `repo` or `local_path`, `port`; defaults `ref=main`, `container_port=3000`, `bind=0.0.0.0`, `health_path=/`, 2s/5s/90s probe timings |
| `Registry` | List/read/write apps | `apps/<name>/` is truth; `state.json` is a rebuildable cache; writes are temp+rename |
| `ContainerRuntime` | Podman operations | `run --restart=always`, `stop`, `rm`, `inspect`, `logs`, image/volume list; labels `io.easy-host.*` |
| `Builder` | Railpack build | Pinned binary, `BUILDKIT_HOST` exported, tag `localhost/easy-host-<app>:<timestamp>`, streamed output |
| `HealthProbe` | Decide "serving" | HTTP GET on `127.0.0.1:<port><path>`; 2xx/3xx healthy; TCP when `probe="tcp"` |
| `Swapper` | Update/rollback swap | Stop old, start candidate, probe, auto-revert on failure |
| `CommandResult` | Exit contract | 0 ok; 1 usage; 2 prerequisite/environment; 3 build; 4 health; 5 not found; 6 conflict/lock |

---

## 8. Functional Requirements

Feature-level requirements are defined once in the owning feature document and referenced here. Priorities are MoSCoW.

| ID | Requirement | Feature | Priority |
|----|-------------|---------|----------|
| [PRE-FR-01](features/01-prerequisites-and-doctor.md#PRE-FR-01) | Resolve and create the state root | 01 | Must |
| [PRE-FR-02](features/01-prerequisites-and-doctor.md#PRE-FR-02) | Doctor verifies Podman 6.1+ rootless | 01 | Must |
| [PRE-FR-03](features/01-prerequisites-and-doctor.md#PRE-FR-03) | Doctor verifies lingering | 01 | Must |
| [PRE-FR-04](features/01-prerequisites-and-doctor.md#PRE-FR-04) | Doctor verifies git 2.40+ | 01 | Must |
| [PRE-FR-05](features/01-prerequisites-and-doctor.md#PRE-FR-05) | Unified error taxonomy and exit codes | 01 | Must |
| [PRE-FR-06](features/01-prerequisites-and-doctor.md#PRE-FR-06) | Ten-command CLI skeleton | 01 | Must |
| [PRE-FR-07](features/01-prerequisites-and-doctor.md#PRE-FR-07) | Doctor human and JSON report | 01 | Must |
| [BLD-FR-01](features/02-buildkit-and-railpack.md#BLD-FR-01) | Pinned, checksum-verified Railpack | 02 | Must |
| [BLD-FR-02](features/02-buildkit-and-railpack.md#BLD-FR-02) | Managed rootless buildkitd | 02 | Must |
| [BLD-FR-03](features/02-buildkit-and-railpack.md#BLD-FR-03) | Build workspace into a tagged image | 02 | Must |
| [BLD-FR-04](features/02-buildkit-and-railpack.md#BLD-FR-04) | Build failure classification | 02 | Must |
| [BLD-FR-05](features/02-buildkit-and-railpack.md#BLD-FR-05) | Build prerequisites in doctor | 02 | Must |
| [REG-FR-01](features/03-app-registry-and-config.md#REG-FR-01) | Strict TOML config schema | 03 | Must |
| [REG-FR-02](features/03-app-registry-and-config.md#REG-FR-02) | App naming and collision rules | 03 | Must |
| [REG-FR-03](features/03-app-registry-and-config.md#REG-FR-03) | On-disk registry layout | 03 | Must |
| [REG-FR-04](features/03-app-registry-and-config.md#REG-FR-04) | Atomic writes and permissions | 03 | Must |
| [REG-FR-05](features/03-app-registry-and-config.md#REG-FR-05) | Locking and port conflicts | 03 | Must |
| [REG-FR-06](features/03-app-registry-and-config.md#REG-FR-06) | Environment and secret merging | 03 | Must |
| [ADD-FR-01](features/04-add-and-lifecycle.md#ADD-FR-01) | Interactive add with flag parity | 04 | Must |
| [ADD-FR-02](features/04-add-and-lifecycle.md#ADD-FR-02) | Git and local workspace modes | 04 | Must |
| [ADD-FR-03](features/04-add-and-lifecycle.md#ADD-FR-03) | Run with restart, port, env, volumes | 04 | Must |
| [ADD-FR-04](features/04-add-and-lifecycle.md#ADD-FR-04) | Health probe contract | 04 | Must |
| [ADD-FR-05](features/04-add-and-lifecycle.md#ADD-FR-05) | Failed-add cleanup | 04 | Must |
| [ADD-FR-06](features/04-add-and-lifecycle.md#ADD-FR-06) | list, status, logs, config | 04 | Must |
| [ADD-FR-07](features/04-add-and-lifecycle.md#ADD-FR-07) | Preflight before mutation | 04 | Must |
| [UPD-FR-01](features/05-update-and-health-gate.md#UPD-FR-01) | Diff-aware update planning | 05 | Must |
| [UPD-FR-02](features/05-update-and-health-gate.md#UPD-FR-02) | Health-gated swap with auto-revert | 05 | Must |
| [UPD-FR-03](features/05-update-and-health-gate.md#UPD-FR-03) | Image retention during update | 05 | Must |
| [UPD-FR-04](features/05-update-and-health-gate.md#UPD-FR-04) | Unhealthy and no-op updates | 05 | Should |
| [UPD-FR-05](features/05-update-and-health-gate.md#UPD-FR-05) | Config-only updates without rebuild | 05 | Must |
| [RBK-FR-01](features/06-rollback-and-remove.md#RBK-FR-01) | Health-gated rollback | 06 | Must |
| [RBK-FR-02](features/06-rollback-and-remove.md#RBK-FR-02) | Keep exactly two images | 06 | Must |
| [RBK-FR-03](features/06-rollback-and-remove.md#RBK-FR-03) | Remove app artifacts | 06 | Must |
| [RBK-FR-04](features/06-rollback-and-remove.md#RBK-FR-04) | Scoped volume deletion | 06 | Must |
| [RBK-FR-05](features/06-rollback-and-remove.md#RBK-FR-05) | Refuse concurrent mutation | 06 | Must |
| [RBK-FR-06](features/06-rollback-and-remove.md#RBK-FR-06) | v1 release scenario gate | 06 | Must |
| [OBS-FR-01](features/07-observability-and-output.md#OBS-FR-01) | JSON output for read-only commands | 07 | Should |
| [OBS-FR-02](features/07-observability-and-output.md#OBS-FR-02) | TTY, NO_COLOR, plain tables | 07 | Must |
| [OBS-FR-03](features/07-observability-and-output.md#OBS-FR-03) | Drift detection | 07 | Should |
| [OBS-FR-04](features/07-observability-and-output.md#OBS-FR-04) | Disk usage reporting | 07 | Should |
| [DOC-FR-01](features/08-docs-and-packaging.md#DOC-FR-01) | README rewrite | 08 | Must |
| [DOC-FR-02](features/08-docs-and-packaging.md#DOC-FR-02) | Prerequisite and upgrade guide | 08 | Must |
| [DOC-FR-03](features/08-docs-and-packaging.md#DOC-FR-03) | systemd timer example | 08 | Should |
| [DOC-FR-04](features/08-docs-and-packaging.md#DOC-FR-04) | CLI and config reference | 08 | Should |
| [DOC-FR-05](features/08-docs-and-packaging.md#DOC-FR-05) | Shell completions | 08 | Could |
| [DOC-FR-06](features/08-docs-and-packaging.md#DOC-FR-06) | Install from the repository | 08 | Must |
| [DOC-FR-07](features/08-docs-and-packaging.md#DOC-FR-07) | Rename and migration note | 08 | Should |

---

## 9. Non-Functional Requirements

| ID | Canonical Source | Priority |
|----|------------------|----------|
| PRD-NF-01 | [PRD-NF-01](#PRD-NF-01) | Should |
| PRD-NF-02 | [PRD-NF-02](#PRD-NF-02) | Must |
| PRD-NF-03 | [PRD-NF-03](#PRD-NF-03) | Must |
| PRD-NF-04 | [PRD-NF-04](#PRD-NF-04) | Must |
| PRD-NF-05 | [PRD-NF-05](#PRD-NF-05) | Must |
| PRD-NF-06 | [PRD-NF-06](#PRD-NF-06) | Must |
| PRD-NF-07 | [PRD-NF-07](#PRD-NF-07) | Must |
| PRD-NF-08 | [PRD-NF-08](#PRD-NF-08) | Must |

```forge-requirement
{"id":"PRD-NF-01","kind":"constraint","text":"Any read-only command (list, status, doctor, config, version) returns in under 2 seconds on a healthy host when the container engine answers promptly."}
```

```forge-requirement
{"id":"PRD-NF-02","kind":"constraint","text":"Every failure message names the failed check, the reason, and a concrete remediation command; no bare stack traces appear in normal operation."}
```

```forge-requirement
{"id":"PRD-NF-03","kind":"constraint","text":"Mutating commands validate all inputs and preflight conditions before creating, stopping, or deleting anything."}
```

```forge-requirement
{"id":"PRD-NF-04","kind":"constraint","text":"The tool works offline except for git access, container image pulls, and the one-time pinned Railpack download."}
```

```forge-requirement
{"id":"PRD-NF-05","kind":"constraint","text":"No command blocks indefinitely: every external call to git, podman, railpack, BuildKit, or a health probe has a finite timeout."}
```

```forge-requirement
{"id":"PRD-NF-06","kind":"constraint","text":"State is recoverable: deleting state.json never loses the app, only its cached image history."}
```

```forge-requirement
{"id":"PRD-NF-07","kind":"constraint","text":"Unit tests run with no Podman, no network, and no root; the gated integration suite runs real builds on the host."}
```

```forge-requirement
{"id":"PRD-NF-08","kind":"constraint","text":"The package installs globally from a git checkout and from a packed tarball with no registry publish."}
```

```forge-requirement
{"id":"PRD-NF-09","kind":"constraint","text":"All external process calls (git, podman, railpack, buildkitd) must have explicit timeouts and must never be invoked through a shell string assembled from user input."}
```

```forge-requirement
{"id":"PRD-NF-10","kind":"constraint","text":"Diagnostic output must never print secret values; secrets are redacted in logs, errors, and JSON output."}
```

---

## 10. Security and Privacy

The tool handles repository URLs, app configuration, environment variables, and secret files. It does not collect analytics, and it transmits nothing except git traffic, container image pulls, and the pinned Railpack download.

| ID | Canonical Source | Priority |
|----|------------------|----------|
| PRD-SP-01 | [PRD-SP-01](#PRD-SP-01) | Must |
| PRD-SP-02 | [PRD-SP-02](#PRD-SP-02) | Must |
| PRD-SP-03 | [PRD-SP-03](#PRD-SP-03) | Must |
| PRD-SP-04 | [PRD-SP-04](#PRD-SP-04) | Must |
| PRD-SP-05 | [PRD-SP-05](#PRD-SP-05) | Must |
| PRD-SP-06 | [PRD-SP-06](#PRD-SP-06) | Must |
| PRD-SP-07 | [PRD-SP-07](#PRD-SP-07) | Must |
| PRD-SP-08 | [PRD-SP-08](#PRD-SP-08) | Should |

```forge-requirement
{"id":"PRD-SP-01","kind":"constraint","text":"Secret files are created with mode 0600 and directories with 0700; the tool never writes a secret into config.toml, logs, or JSON output."}
```

```forge-requirement
{"id":"PRD-SP-02","kind":"constraint","text":"Credentials are never stored by easy-host; private repository access uses the operator's existing SSH agent or git credential helper."}
```

```forge-requirement
{"id":"PRD-SP-03","kind":"constraint","text":"App containers run as the rootless user and never request --privileged, host networking, or additional capabilities. The dedicated buildkitd container may use only the options its pinned rootless image documents; any elevated option must be recorded in the operations guide and justified by the Phase 0 spike outcome."}
```

```forge-requirement
{"id":"PRD-SP-04","kind":"constraint","text":"User input is passed as argument arrays to git, podman, and railpack, never interpolated into a shell string."}
```

```forge-requirement
{"id":"PRD-SP-05","kind":"constraint","text":"App names, ports, refs, paths, and volume names are validated against allowlists before use in any command."}
```

```forge-requirement
{"id":"PRD-SP-06","kind":"constraint","text":"The tool does not weaken host security to make builds work: it never disables SELinux, overrides security options, or chmods host paths."}
```

```forge-requirement
{"id":"PRD-SP-07","kind":"constraint","text":"Removal deletes only resources labelled for the named app; a mislabelled or foreign container or volume is reported, not deleted."}
```

```forge-requirement
{"id":"PRD-SP-08","kind":"constraint","text":"Document the threat model plainly: a hosted app is fully trusted code running as the operator, and the operator is responsible for network exposure."}
```

```forge-requirement
{"id":"PRD-SP-09","kind":"constraint","text":"v1 stores no personal data beyond what the operator puts in app configuration and secret files; there is no account system, no telemetry, and no third-party analytics."}
```

---

## 11. Accessibility

easy-host is a terminal product. Accessibility means output that works with screen readers, high-contrast terminals, and no-color environments, and prompts that can be bypassed entirely by flags.

| ID | Canonical Source | Priority |
|----|------------------|----------|
| PRD-ACC-01 | [PRD-ACC-01](#PRD-ACC-01) | Must |
| PRD-ACC-02 | [PRD-ACC-02](#PRD-ACC-02) | Must |
| PRD-ACC-03 | [PRD-ACC-03](#PRD-ACC-03) | Should |
| PRD-ACC-04 | [PRD-ACC-04](#PRD-ACC-04) | Must |
| PRD-ACC-05 | [PRD-ACC-05](#PRD-ACC-05) | Should |
| PRD-ACC-06 | [PRD-ACC-06](#PRD-ACC-06) | Must |

```forge-requirement
{"id":"PRD-ACC-01","kind":"constraint","text":"Never rely on color alone to convey status; pair color with a text label such as healthy, unhealthy, or stopped."}
```

```forge-requirement
{"id":"PRD-ACC-02","kind":"constraint","text":"Honor NO_COLOR and non-TTY output by emitting plain text with no ANSI escapes."}
```

```forge-requirement
{"id":"PRD-ACC-03","kind":"constraint","text":"Keep table output narrow enough for an 80-column terminal; long values wrap or move to status output."}
```

```forge-requirement
{"id":"PRD-ACC-04","kind":"constraint","text":"Interactive prompts have a non-interactive flag equivalent for every question, so screen-reader users and scripts are not forced through a prompt."}
```

```forge-requirement
{"id":"PRD-ACC-05","kind":"constraint","text":"Error messages are complete sentences with the remediation command on its own line, not glyph-only indicators."}
```

```forge-requirement
{"id":"PRD-ACC-06","kind":"constraint","text":"Documentation is plain Markdown with real headings and no text embedded in images."}
```

```forge-requirement
{"id":"PRD-ACC-07","kind":"constraint","text":"Shell completions and help text must be generated from the same command definitions as the CLI so they cannot drift."}
```

---

## 12. User Interface / Interaction Design

### 12.1 Command surface

```text
easy-host add <git-url | --local <path>> [--name <app>] [--ref <ref>]
              [--port <port>] [--container-port <port>] [--bind <addr>]
              [--env-file <path>] [--health-path <path>] [--probe http|tcp]
              [--volume <name:container-path>] [--yes]
easy-host list [--json]
easy-host status [<app>] [--json]
easy-host logs <app> [-f] [--tail <n>]
easy-host update <app> [--rebuild]
easy-host rollback <app>
easy-host remove <app> [--volumes] [--force]
easy-host config <app> [--path | --edit | --json]
easy-host doctor [--json]
easy-host version [--json]
```

### 12.2 Interaction rules

- `add` prompts only for values not supplied as flags; in a non-TTY it requires flags and fails fast with the missing one named.
- Destructive commands print the exact resources they will delete and require `--yes` when stdin is not a TTY.
- `remove` without `--volumes` prints the retained volumes and how to delete them.
- Progress output goes to stderr; machine-readable results go to stdout so `--json` can be piped.
- Human tables use the shape below; `--json` mirrors the same fields.

```text
NAME    STATUS     PORT   REF     UPDATED              IMAGE
blog    healthy    8080   main    2026-10-29 21:14     a1b2c3d
api     unhealthy  8081   main    2026-10-28 09:02     e4f5g6h
```

### 12.3 Error shape

```text
easy-host: health check failed for "api"
  probe:    GET http://127.0.0.1:8081/ (90s budget, 2s interval)
  reason:   connection refused after 45 attempts
  previous: easy-host-api:20261028T090200Z is serving again
  next:     easy-host logs api --tail 200
```

---

## 13. System States / Lifecycle

Each app has a container state and a health state. The registry cache records both, but readiness is always re-derived from Podman and the probe.

```text
                 add
                  │
             ┌────▼─────┐   build fails    ┌───────────┐
   absent ──►│ building │─────────────────►│  failed   │
             └────┬─────┘                  └─────┬─────┘
                  │ image built                  │ update
             ┌────▼─────┐   probe fails   ┌─────▼─────┐
             │ starting │────────────────►│ unhealthy │
             └────┬─────┘                 └─────┬─────┘
                  │ probe ok                    │ update / rollback
             ┌────▼─────┐                       │
             │ healthy  │◄──────────────────────┘
             └────┬─────┘
                  │ update (rebuild or recreate)
             ┌────▼─────┐  probe fails   ┌──────────────┐
             │ swapping │───────────────►│ reverted     │
             └────┬─────┘                └──────────────┘
                  │ probe ok
             ┌────▼─────┐
             │ healthy  │
             └──────────┘
```

| State | Meaning | Allowed transitions |
|---|---|---|
| `absent` | No registry entry and no container | `building` on add |
| `building` | Clone and/or image build in progress | `starting`, `failed` |
| `starting` | Container created, probe running within the 90s budget | `healthy`, `unhealthy` |
| `healthy` | Container up and probe succeeding | `swapping`, `unhealthy`, `absent` |
| `unhealthy` | Container up but probe failing, or container missing while state says healthy | `healthy`, `swapping`, `absent` |
| `swapping` | Old stopped, candidate starting | `healthy`, `reverted`, `unhealthy` |
| `reverted` | Candidate failed; previous container restarted | `healthy`, `unhealthy` |
| `failed` | Build or clone failed; no candidate existed | `building` on retry, `absent` on remove |

Rules: a state change is written only after the Podman action succeeds; `remove` is allowed from any state; `rollback` requires two recorded images.

---

## 14. Features

| # | Feature | File | Depends on |
|---|---------|------|------------|
| 1 | Prerequisites and Doctor | [01-prerequisites-and-doctor.md](features/01-prerequisites-and-doctor.md) | None |
| 2 | BuildKit and Railpack | [02-buildkit-and-railpack.md](features/02-buildkit-and-railpack.md) | Prerequisites and Doctor |
| 3 | App Registry and Config | [03-app-registry-and-config.md](features/03-app-registry-and-config.md) | Prerequisites and Doctor |
| 4 | Add and Lifecycle | [04-add-and-lifecycle.md](features/04-add-and-lifecycle.md) | BuildKit and Railpack, App Registry and Config |
| 5 | Update and Health Gate | [05-update-and-health-gate.md](features/05-update-and-health-gate.md) | Add and Lifecycle |
| 6 | Rollback and Remove | [06-rollback-and-remove.md](features/06-rollback-and-remove.md) | Update and Health Gate |
| 7 | Observability and Output | [07-observability-and-output.md](features/07-observability-and-output.md) | Add and Lifecycle |
| 8 | Docs and Packaging | [08-docs-and-packaging.md](features/08-docs-and-packaging.md) | Rollback and Remove, Observability and Output |

Execution order is the dependency order above. Features 2 and 3 are independent after feature 1 and may proceed in parallel; features 5 and 6 are strictly sequential because rollback reuses the swap and retention logic.

---

## 15. Testing Strategy

| Level | Scope | Tools / Approach |
|-------|-------|------------------|
| Unit | Config parsing, naming, paths, locks, diffing, command construction, formatting, JSON shapes, error mapping | Vitest 5.0.5 with injected fake runners; no Podman, no network |
| Contract | Exact `podman`, `git`, and `railpack` argument arrays and exit-code mapping | Vitest with a recording fake process runner |
| Integration (gated) | Real clone, build, run, probe, update, rollback, remove against rootless Podman 6.1 | `EASY_HOST_INTEGRATION=1 npm run test:integration` on the Linux host; three fixture apps |
| Packaging | Global install from a packed tarball into a clean prefix, then `easy-host version` | `npm run test:packaging` |
| Docs | Relative links resolve, required sections exist, examples match the command surface | Vitest link checker |
| Manual / exploratory | The four success scenarios on a fresh host, including a real reboot | Recorded in `docs/reviews/v1-success-scenarios.json` |

Key test scenarios:

1. Invalid TOML, unknown keys, and out-of-range ports are rejected before any mutation.
2. Two apps cannot claim the same host port, and an app cannot claim a port outside 1024–65535.
3. A failed first health probe removes the container but keeps the image and a recoverable app entry.
4. A broken commit during `update` leaves the previous image serving and exits with code 4.
5. `rollback` twice returns to the original image and serves both times.
6. `remove` without `--volumes` leaves the named volume; `remove --volumes` deletes only that app's volumes.
7. Concurrent `update` and `remove` on the same app: one proceeds, the other exits with code 6.
8. `--json` output contains no ANSI escapes, no secret values, and a stable `schemaVersion`.
9. A missing `state.json` is rebuilt from the directory without losing the app.
10. Installing the packed tarball into a clean prefix produces a working `easy-host` binary.

---

## 16. Analytics / Success Metrics

No telemetry is collected. Success is evaluated by the operator and by the release gate.

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Time from `add` to a reachable URL for a supported fixture | <= 10 minutes on a warm BuildKit cache, <= 20 minutes cold | Stopwatch during the release gate |
| Reboot survival | 100% of added apps return without manual intervention | Real reboot during the release gate |
| Failed-update protection | 100% of injected broken updates keep the old version serving | Integration test plus release gate |
| Rollback recovery | <= 60 seconds from command to healthy previous version | Release gate timing |
| Accidental data loss | Zero across all tests and release scenarios | Integration assertions on volume presence |
| Command discoverability | An operator who has not read the source can complete add/list/update/remove using `--help` alone | Manual walkthrough with a second person |

---

## 17. Acceptance Criteria

1. `easy-host doctor` reports Podman, lingering, git, Railpack, BuildKit, and disk status with actionable remediation on a clean host.
2. `easy-host add <git-url> --port <port>` builds a Vite/React SPA, an Express API, and a FastAPI app from the fixtures and each is reachable on the LAN.
3. The app survives a host reboot with no manual command, given lingering is enabled.
4. `easy-host update` on a broken commit leaves the previous version serving and exits non-zero with the failure reason.
5. `easy-host rollback` restores the previous image, serves again, and a second rollback returns to the newer image.
6. `easy-host remove` deletes the container, workspace, images, and app directory, and reports any retained volume.
7. `easy-host remove --volumes` deletes only that app's named volumes and nothing on the host filesystem.
8. Configuration-only changes (env, port, health path, volume) apply without a rebuild.
9. Two apps with the same declared port are rejected before any container is created.
10. Concurrent mutations on one app are serialized by a lock and the loser exits with code 6.
11. `--json` output for `list`, `status`, and `doctor` is valid JSON on stdout with no ANSI escapes and no secret values.
12. `npm install -g .` from a fresh clone and `npm install -g <packed-tarball>` both produce a working `easy-host` binary with Node.js 24+.
13. The documented prerequisite guide covers upgrading from Podman 4.9 to 6.1 and enabling lingering.
14. No command deletes data without `--volumes`, and no command sends telemetry.

---

## 18. Dependencies and Risks

### 18.1 Dependencies

| Dependency | Type | Risk if Unavailable | Mitigation |
|------------|------|---------------------|------------|
| Railpack 0.43.0 | External binary (pinned download) | No zero-Dockerfile build | Pinned, SHA-256 verified, `EASY_HOST_RAILPACK_BIN` override, documented upgrade procedure |
| rootless Podman >= 6.1 | Host runtime | Nothing runs | `doctor` fails early with upgrade instructions; minimum is enforced, not assumed |
| moby/buildkit 0.34.1-rootless | Container image | Railpack cannot build | Pinned by digest; `doctor` reports reachability; Phase 0 spike gates the build layer |
| BuildKit rootless compatibility | Platform behavior | The "any repo" premise collapses | Phase 0 hard gate; if it fails, the build layer is re-planned before Phase 1 |
| system git >= 2.40 | Host tool | Cannot clone private or public repos | `doctor` check; SSH agent and credential helper documented |
| Node.js >= 24 | Host runtime | CLI cannot start | `engines` field plus `doctor` check |
| git hosting provider | Network service | Cannot fetch repos or updates | Operator's responsibility; failures classified as clone errors |
| Docker Hub / base image registries | Network service | Builds cannot pull bases | Railpack failure surfaced with registry hint; no silent retry loop |

### 18.2 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Railpack cannot drive BuildKit under rootless Podman 6.1 | Medium | High — core premise | Phase 0 spike is a hard gate; stop and re-plan if it fails |
| Railpack pre-1.0 breaking changes | High over time | Medium — build breakage | Exact version pin, checksum, explicit upgrade task, fixtures detect regressions |
| Podman 4.9 hosts (Ubuntu/Debian stock) cannot run v1 | High | Medium — install friction | Documented upgrade path; `doctor` explains the minimum and the fix |
| Rootless port <1024 cannot bind | Medium | Low — confusing failure | Validate ports >= 1024 with a specific message |
| Builds are slow (minutes) | High | Medium — operator frustration | Honest docs, streamed output, config-only updates skip builds, BuildKit cache guidance |
| Disk growth from images and cache | Medium | Medium — host fills up | Keep two images, `doctor` reports sizes and warns, manual prune documented |
| Secret leakage through logs or JSON | Low | High | Redaction tests, `0600`, never echo env values, threat model documented |
| Swap window causes brief downtime | High | Low — accepted | Documented explicitly; no proxy in v1 |
| Single maintainer and thin real-world testing | Medium | Medium | Release-gate scenarios, fixtures, integration suite on the real host |
| `--restart=always` silently ineffective without lingering | High | High — apps die on reboot | `doctor` check plus release-gate reboot scenario |

---

## 19. Future Considerations

| Item | Description | Potential Version |
|------|-------------|-------------------|
| Built-in scheduler | Native periodic update instead of an operator-written systemd timer | v2 |
| Webhook or git-poll update trigger | Push-to-deploy without a timer | v2 |
| Bundled reverse proxy and TLS | Caddy/Traefik-style front door with automatic certificates | v2 |
| More tested stacks | Go, Next.js, Rails, PHP once fixtures exist | v2 |
| Image history beyond two | Configurable retention and `rollback --to` | v2 |
| Zero-downtime deploys | Two containers plus a proxy switch | v2 |
| Single-binary distribution | Node SEA builds per architecture | v2 |
| Metrics and alerting | Opt-in local metrics endpoint | v3 |
| Multi-host | Remote Podman over SSH | v3 |
| Compose-style multi-service apps | One repo, several services | v3 |
| Bind mounts with UID mapping | Explicit host path mounts and ownership rules | v3 |

---

## 20. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Which license? | MIT, declared in `LICENSE` and `package.json`. |
| 2 | Should `config --edit` open `$EDITOR` and re-validate on save? | Yes: open `$EDITOR`, then validate and print errors without applying anything. |
| 3 | Should `add` accept repeatable `--env KEY=VALUE` flags in addition to `[env]` and the secret file? | Yes, for scripting; values land in the secret file, not in `config.toml`. |
| 4 | Exact image tag format? | `localhost/easy-host-<app>:<UTC yyyymmddThhmmssZ>`; state records the two refs, no mutable `:current` tag. |
| 5 | Should `status` exit non-zero when any app is unhealthy? | Yes, exit 4, so timers and monitors can act on it. |
| 6 | Should `list` hide apps whose containers are missing? | No: show them as `missing` so drift is visible. |
| 7 | Should the tool enforce a minimum free disk threshold before building? | Warn below 5 GiB, fail below 2 GiB, both configurable in `doctor` output only (no config key in v1). |
| 8 | Should `update --rebuild` force a build even when the diff says config-only? | Yes; the flag exists for cache and Railpack-version changes. |
| 9 | Should `remove` offer to keep images for faster re-add? | No in v1; `remove` deletes images, `remove --keep-images` is a future consideration. |
| 10 | What is the exact `--json` schema version field? | `"schemaVersion": 1` on every JSON payload; bump only for breaking field changes. |
| 11 | Is a `restart` command needed despite the settled ten-command surface? | No; `update` without changes and `rollback` cover recovery, and Podman restart is the operator's tool. |
| 12 | Does v1 need shell completion generation at install time? | No; `easy-host completion <shell>` prints the script and docs explain where to place it. |

---

## 21. Glossary

| Term | Definition |
|------|------------|
| App | One repository (or local path) turned into one container and one host port, tracked under a unique name. |
| AppSpec | The typed contents of an app's `config.toml`. |
| BuildKit | The builder Railpack drives to produce OCI images. |
| Current image | The image the running container was created from. |
| Drift | A difference between recorded state and Podman reality (missing container, wrong image, unhealthy probe). |
| Health gate | The rule that a candidate version must pass its probe before it replaces the serving version. |
| Lingering | The systemd setting that keeps a user's services (and rootless Podman containers) alive after logout and across reboot. |
| Previous image | The last image that served before the current one; the rollback target. |
| Railpack | The MIT build-detection tool that turns a repo into an image without a Dockerfile. |
| Registry | The on-disk `apps/` directory tree; the authoritative list of configured apps. |
| Rootless Podman | Podman running entirely in a user namespace without root privileges. |
| State cache | Per-app `state.json` holding image refs, last health result, and timestamps; rebuildable. |
| Swap | The update/rollback sequence that stops the old container, starts the candidate, and probes it. |
| Volume | A named Podman volume declared in config and mounted into the container at a declared path. |
