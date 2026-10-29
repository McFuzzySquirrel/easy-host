# Feature: BuildKit and Railpack

## 1. Feature Overview

**Feature Name:** BuildKit and Railpack
**Parent Document:** [PRD](../PRD.md)
**Status:** Draft
**Summary:** Turns a directory of source code into a tagged OCI image using a pinned Railpack binary and a tool-managed rootless BuildKit daemon, with no Dockerfile in the target repository and with failures classified so the caller knows whether detection, compilation, or infrastructure broke.
**Scope:** The Phase 0 compatibility spike, pinned version declarations, Railpack acquisition and checksum verification, buildkitd lifecycle, the build invocation, and the build-related doctor checks. Container creation, ports, and health belong to [Add and Lifecycle](04-add-and-lifecycle.md).
**Dependencies:** [Prerequisites and Doctor](01-prerequisites-and-doctor.md).

---

## 2. Context: Existing System State

Greenfield feature. Feature 01 provides the state root (`tools/`, `buildkit/`), the error taxonomy with exit codes 2 and 3, and the doctor check composition. This feature adds the first code that touches the network and the container engine.

---

## 3. Feature Goals and Non-Goals

### 3.1 Goals

- Settle the top technical risk with evidence rather than assumption: can Railpack drive BuildKit on rootless Podman 5.7.0–5.8.x on the target host?
- Make builds reproducible: one place declares the Railpack version, the buildkit image tag, and its digest.
- Make infrastructure failures distinguishable from source failures.
- Keep build output streaming so a multi-minute build is not a silent black box.

### 3.2 Non-Goals

- No running containers, ports, volumes, or health checks.
- No build caching policy beyond what BuildKit does by default.
- No support for a repository-provided Dockerfile as a first-class path; Railpack's detection is the contract.
- No build concurrency: one build at a time per host in v1.

---

## 4. User Stories

| ID | Canonical Source | Ownership | Priority |
|----|------------------|-----------|----------|
| BLD-US-01 | [BLD-US-01](#BLD-US-01) | Owns | Must |
| BLD-US-02 | [BLD-US-02](#BLD-US-02) | Owns | Must |
| BLD-US-03 | [BLD-US-03](#BLD-US-03) | Owns | Should |

```forge-requirement
{"id":"BLD-US-01","kind":"story","text":"As a homelab operator, I want to add a repo without writing a Dockerfile so that container authoring is not my job."}
```

```forge-requirement
{"id":"BLD-US-02","kind":"story","text":"As an occasional maintainer, I want a build failure to tell me whether the repo is unsupported or the build infrastructure is broken so that I fix the right thing."}
```

```forge-requirement
{"id":"BLD-US-03","kind":"story","text":"As a VPS tinkerer, I want to see build progress while it runs so that a long build does not look like a hang."}
```

---

## 5. Technical Approach

### 5.1 Impact on Existing Architecture

Adds `src/platform/versions.ts`, `railpack.ts`, `buildkit.ts`, and `build.ts`. Modifies `src/doctor/index.ts` to include a build-check group created in `src/doctor/build-checks.ts`. Uses the error classes from feature 01; no changes to the error taxonomy.

### 5.2 New Components

| Path | Responsibility |
|---|---|
| `src/platform/versions.ts` | Single source for `RAILPACK_VERSION`, `RAILPACK_SHA256` per architecture, `BUILDKIT_IMAGE`, `BUILDKIT_DIGEST` |
| `src/platform/railpack.ts` | Resolve, download, verify, and cache the Railpack binary; honor `EASY_HOST_RAILPACK_BIN` |
| `src/platform/buildkit.ts` | Start, reuse, health-check, and stop the dedicated buildkitd container; expose the socket path |
| `src/platform/build.ts` | Invoke Railpack against a workspace and return an image reference or a classified error |
| `src/doctor/build-checks.ts` | Doctor group for Railpack binary and BuildKit reachability |
| `fixtures/vite-spa`, `fixtures/express-api`, `fixtures/fastapi-app` | The three supported stacks, used by build and lifecycle integration tests |

### 5.3 Technology Additions

Railpack 0.43.0 (pinned download) and moby/buildkit 0.34.1-rootless (pinned image digest). Both are external binaries/images, not npm packages. Railpack is pre-1.0, so upgrades are a deliberate task, never a floating range.

---

## 6. Functional Requirements

| ID | Canonical Source | Affects Existing | Priority |
|----|------------------|------------------|----------|
| BLD-FR-01 | [BLD-FR-01](#BLD-FR-01) | No — creates `railpack.ts` | Must |
| BLD-FR-02 | [BLD-FR-02](#BLD-FR-02) | No — creates `buildkit.ts` | Must |
| BLD-FR-03 | [BLD-FR-03](#BLD-FR-03) | No — creates `build.ts` | Must |
| BLD-FR-04 | [BLD-FR-04](#BLD-FR-04) | No — uses feature 01 errors | Must |
| BLD-FR-05 | [BLD-FR-05](#BLD-FR-05) | Yes — extends doctor | Must |

```forge-requirement
{"id":"BLD-FR-01","kind":"requirement","text":"Acquire Railpack from a pinned release: resolve the version and per-architecture SHA-256 from one module, download once into <root>/tools, verify the digest before use, and reuse the cached binary on later builds. EASY_HOST_RAILPACK_BIN overrides the download entirely and must be an executable file."}
```

```forge-requirement
{"id":"BLD-FR-02","kind":"requirement","text":"Provide a buildkitd managed by easy-host: start the pinned rootless buildkit image when no healthy daemon is reachable, reuse a healthy one, wait for its unix socket to accept connections, and record the exact runtime flags in the operations guide. The daemon is infrastructure and is never listed as an app."}
```

```forge-requirement
{"id":"BLD-FR-03","kind":"requirement","text":"Build a workspace directory into the image localhost/easy-host-<app>:<UTC yyyymmddThhmmssZ>, stream Railpack output to stderr as it arrives, and return the image reference. The target repository must not be required to contain a Dockerfile."}
```

```forge-requirement
{"id":"BLD-FR-04","kind":"requirement","text":"Classify build failures into unsupported-source (Railpack found no provider), build-failure (a provider ran and failed), and infrastructure-failure (buildkitd unreachable, socket timeout, or image pull error). Each class uses the documented exit code and a distinct remediation hint."}
```

```forge-requirement
{"id":"BLD-FR-05","kind":"requirement","text":"Extend doctor with checks for the Railpack binary (present, executable, expected version) and BuildKit (daemon reachable over the socket), and fail doctor when either is required but unavailable."}
```

```forge-requirement
{"id":"BLD-NF-01","kind":"constraint","text":"Never buffer build output until completion; every line must reach stderr within one second of being produced."}
```

```forge-requirement
{"id":"BLD-NF-02","kind":"constraint","text":"No floating versions: the Railpack version, its checksums, the BuildKit image tag, and its digest are declared in one module and referenced everywhere else."}
```

---

## 7. Non-Functional Requirements

| ID | Canonical Source | Priority |
|----|------------------|----------|
| BLD-NF-01 | [BLD-NF-01](#BLD-NF-01) | Must |
| BLD-NF-02 | [BLD-NF-02](#BLD-NF-02) | Must |

---

## 8. Agent Impact Assessment

Greenfield feature. Planned owners: `build-engineer` for the resolver, daemon manager, build runner, fixtures, and integration test; `cli-engineer` for the doctor integration because it edits the doctor composition created in feature 01.

---

## 9. Implementation Phases

### Phase 1: Compatibility Spike

```forge-task
{
  "id": "BLD-0.1",
  "title": "Verify Railpack and BuildKit on rootless Podman 5.7.0",
  "description": "Run the Phase 0 compatibility spike by hand on the target Linux host with rootless Podman 5.7.0. Install or run the pinned railpack 0.43.0 and a buildkitd reachable over a unix socket, then build the Vite fixture with no Dockerfile. Record in the review file: the exact podman run and railpack commands used, the flags required for rootless operation, whether privileged mode or unconfined seccomp was necessary, build wall-clock time warm and cold, the resulting image reference, and the observed failure modes. Do not implement product code in this task. If the build cannot succeed, record that outcome and the blocking error verbatim; the build layer is then re-planned before Phase 2 starts.",
  "dependencies": [],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/02-buildkit-and-railpack.md#BLD-FR-02", "docs/features/02-buildkit-and-railpack.md#BLD-FR-03"],
    "acceptanceCriteria": ["A Vite repository builds into an image on rootless Podman 5.7.0 without a Dockerfile", "The exact buildkitd flags, including any elevated option, are recorded with their justification", "Warm and cold build durations are recorded", "A failing outcome records the verbatim error and the re-plan decision"],
    "constraints": ["Do not use privileged mode for app containers", "Record what actually ran rather than what was expected"],
    "constraintRefs": ["docs/PRD.md#PRD-SP-03", "docs/PRD.md#PRD-C-02"],
    "references": ["docs/PRD.md#18.2 Risks", "docs/PRD.md#6.2 Success / completion criteria"],
    "reviewFile": "docs/reviews/buildkit-spike.json"
  }
}
```

### Phase 2: Build Layer

```forge-task
{
  "id": "BLD-1.1",
  "title": "Resolve, verify, and cache the Railpack binary",
  "description": "Implement versions.ts with the pinned Railpack 0.43.0 version string, per-architecture download URLs, and SHA-256 digests, plus the pinned BuildKit image reference and digest. Implement railpack.ts to honor EASY_HOST_RAILPACK_BIN, otherwise download the archive once into <root>/tools, verify the SHA-256 before extraction, reject a digest mismatch without executing the binary, and reuse an already verified binary. Tests use an injected fetch and a temporary directory to cover cache hit, cache miss, digest mismatch, override path, non-executable override, and unsupported architecture.",
  "ownerAgent": "build-engineer",
  "dependencies": ["BLD-0.1", "PRE-1.2"],
  "expectedOutputs": ["src/platform/versions.ts", "src/platform/railpack.ts", "tests/unit/railpack.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/railpack.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/02-buildkit-and-railpack.md#BLD-FR-01"],
    "acceptanceCriteria": ["A digest mismatch aborts before the binary is executed", "A verified cached binary is reused without a second download", "EASY_HOST_RAILPACK_BIN bypasses the download and is validated as executable", "All pinned values live in versions.ts"],
    "constraints": ["No floating or latest version resolution", "Never execute a partially downloaded file"],
    "constraintRefs": ["docs/features/02-buildkit-and-railpack.md#BLD-NF-02", "docs/PRD.md#PRD-SP-04"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces", "docs/PRD.md#18.1 Dependencies"]
  }
}
```

```forge-task
{
  "id": "BLD-1.2",
  "title": "Manage the rootless buildkitd lifecycle",
  "description": "Implement buildkit.ts using the flags recorded by the spike. Provide ensure(): return an existing healthy daemon if its socket accepts a connection, otherwise start the pinned image with a named container, the state root mounted for socket and cache, and a finite readiness timeout. Provide stop() and status(). All podman calls go through the shared process runner with argument arrays. Tests use a recording fake runner and a temporary unix socket to cover reuse, cold start, readiness timeout, port or socket collision, and a failed start.",
  "ownerAgent": "build-engineer",
  "dependencies": ["BLD-0.1", "BLD-1.1"],
  "expectedOutputs": ["src/platform/buildkit.ts", "tests/unit/buildkit.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/buildkit.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/02-buildkit-and-railpack.md#BLD-FR-02"],
    "acceptanceCriteria": ["A healthy existing daemon is reused without starting another", "A cold start waits for the socket and fails with exit code 2 after the timeout", "The daemon is named distinctly from app containers and is never listed as an app", "Runtime flags match the spike record exactly"],
    "constraints": ["Do not run app containers privileged", "Do not run the daemon inside the app namespace"],
    "constraintRefs": ["docs/PRD.md#PRD-SP-03", "docs/PRD.md#PRD-C-07"],
    "references": ["docs/PRD.md#7.1 Technology stack", "docs/PRD.md#7.3 Key APIs / interfaces"]
  }
}
```

```forge-task
{
  "id": "BLD-1.3",
  "title": "Build a workspace into a tagged image",
  "description": "Implement build.ts. Invoke the pinned Railpack binary with BUILDKIT_HOST pointed at the managed socket, the workspace as the build context, and an image tag of localhost/easy-host-<app>:<UTC timestamp>. Stream stdout and stderr line by line to stderr. Return the image reference on success. Classify failures into unsupported-source, build-failure, and infrastructure-failure, each with its exit code and remediation. Tests use a fake child process to cover success, no-provider detection, provider failure, socket unreachable, registry pull failure, and output streaming order.",
  "ownerAgent": "build-engineer",
  "dependencies": ["BLD-1.1", "BLD-1.2"],
  "expectedOutputs": ["src/platform/build.ts", "tests/unit/build.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/build.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/02-buildkit-and-railpack.md#BLD-FR-03", "docs/features/02-buildkit-and-railpack.md#BLD-FR-04"],
    "acceptanceCriteria": ["A successful build returns the timestamped image reference", "Each failure class maps to a distinct message and exit code", "Output lines are forwarded within the streaming contract", "No Dockerfile is required in the workspace"],
    "constraints": ["App name and timestamp are validated before use in the tag", "No shell interpolation of user values"],
    "constraintRefs": ["docs/features/02-buildkit-and-railpack.md#BLD-NF-01", "docs/PRD.md#PRD-SP-05"],
    "references": ["docs/PRD.md#6.1 Core loop / workflow", "docs/PRD.md#7.3 Key APIs / interfaces"]
  }
}
```

```forge-task
{
  "id": "BLD-1.4",
  "title": "Create the three supported stack fixtures",
  "description": "Add three minimal, buildable fixture applications that the integration suite will own: a Vite/React static SPA that builds to static assets, an Express API that reads PORT and serves a JSON health response at /, and a FastAPI app that reads PORT and serves the same shape. Each fixture must be small, dependency-light, and pinned enough to build repeatedly. Add a unit test that asserts each fixture has its required entry files and that the Express and FastAPI fixtures read the PORT environment variable.",
  "ownerAgent": "build-engineer",
  "dependencies": ["BLD-0.1"],
  "expectedOutputs": ["fixtures/vite-spa/package.json", "fixtures/vite-spa/index.html", "fixtures/vite-spa/vite.config.ts", "fixtures/vite-spa/src/main.tsx", "fixtures/express-api/package.json", "fixtures/express-api/server.js", "fixtures/fastapi-app/requirements.txt", "fixtures/fastapi-app/main.py", "tests/unit/fixtures.test.ts"],
  "validationCommands": ["npm test -- tests/unit/fixtures.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/02-buildkit-and-railpack.md#BLD-FR-03"],
    "acceptanceCriteria": ["Each fixture contains the files Railpack needs to detect its provider", "Server fixtures read PORT rather than hard-coding a port", "The unit test fails if a required fixture file is removed"],
    "constraints": ["Fixtures are test assets, not examples of production configuration", "No Dockerfile in any fixture"],
    "constraintRefs": ["docs/PRD.md#PRD-C-10"],
    "references": ["docs/PRD.md#5.4 Platform finding that shaped the scope", "docs/PRD.md#15. Testing Strategy"]
  }
}
```

```forge-task
{
  "id": "BLD-1.5",
  "title": "Add build prerequisites to doctor",
  "description": "Create the doctor build-check group: Railpack binary present and executable with the expected pinned version, and BuildKit reachable over the managed socket. Wire the group into the doctor composition and ensure doctor stays under its time budget by using connection timeouts rather than retries. Tests cover missing Railpack, wrong Railpack version, unreachable BuildKit, and the all-pass case, and assert that the check order stays stable.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["BLD-1.1", "BLD-1.2", "PRE-1.5"],
  "expectedOutputs": ["src/doctor/build-checks.ts", "src/doctor/index.ts", "tests/unit/doctor-build.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/doctor-build.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/02-buildkit-and-railpack.md#BLD-FR-05"],
    "acceptanceCriteria": ["Missing or mismatched Railpack fails doctor with exit code 2", "Unreachable BuildKit fails doctor with the start remediation", "Doctor output for build checks is present in both human and JSON modes"],
    "constraints": ["Doctor does not start the daemon or download Railpack", "Doctor does not exceed its time budget"],
    "constraintRefs": ["docs/features/01-prerequisites-and-doctor.md#PRE-NF-01", "docs/PRD.md#PRD-NF-01"],
    "references": ["docs/features/01-prerequisites-and-doctor.md#6. Functional Requirements", "docs/PRD.md#7.3 Key APIs / interfaces"]
  }
}
```

```forge-task
{
  "id": "BLD-1.6",
  "title": "Prove the build layer on the real host",
  "description": "Add the gated integration test that builds all three fixtures through the real managed buildkitd and Railpack, asserts a distinct timestamped image exists for each, and records build duration. The suite must skip nothing silently: it fails fast with a clear message when EASY_HOST_INTEGRATION is not set, and it cleans up the images and daemon it created. Also assert that the second build of the same fixture reuses the cached Railpack binary.",
  "ownerAgent": "build-engineer",
  "dependencies": ["BLD-1.3", "BLD-1.4"],
  "expectedOutputs": ["tests/integration/build.test.ts"],
  "validationCommands": ["npm run typecheck", "EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/build.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/02-buildkit-and-railpack.md#BLD-FR-03", "docs/features/02-buildkit-and-railpack.md#BLD-FR-04"],
    "acceptanceCriteria": ["All three fixtures build into distinct image references", "The test fails when the integration environment variable is absent rather than passing vacuously", "Created images and the daemon are cleaned up after the run"],
    "constraints": ["Runs only on the Linux host with Podman >= 5.7.0, < 6.0.0", "No network assumption beyond image pulls and the Railpack download"],
    "constraintRefs": ["docs/PRD.md#PRD-NF-07", "docs/PRD.md#PRD-C-10"],
    "references": ["docs/PRD.md#15. Testing Strategy", "docs/PRD.md#6.2 Success / completion criteria"]
  }
}
```

---

## 10. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit Tests | Version pinning, download verification, daemon reuse, build classification, streaming | Vitest with injected fetchers and a recording process runner |
| Integration Tests | Real Railpack and BuildKit builds of the three fixtures | `EASY_HOST_INTEGRATION=1` on the target host, after the spike passes |
| Regression Tests | Failure classification and no-Dockerfile builds | Fixtures plus a deliberate no-provider fixture directory in unit tests |

Key test scenarios:

1. Digest mismatch aborts before the binary runs.
2. Healthy daemon reused; cold start times out with a prerequisite error.
3. Unsupported source, provider failure, and unreachable daemon produce three distinct messages and exit codes.
4. Build output streams in order rather than arriving at completion.
5. All three fixtures build into distinct tags on the real host.
6. The second build reuses the cached Railpack binary.

---

## 11. Rollback Considerations

Reverting removes `src/platform/{versions,railpack,buildkit,build}.ts`, the doctor build-check group, the fixtures, and the integration test. The cached Railpack binary under `<root>/tools` and the buildkitd container remain on the host and must be cleaned up manually; document their names in the operations guide. No app state exists yet, so no data migration is required.

---

## 12. Acceptance Criteria

1. The Phase 0 spike is recorded in `docs/reviews/buildkit-spike.json` with commands, flags, timings, and an explicit pass or fail outcome.
2. A digest mismatch prevents execution and reports a build-infrastructure error.
3. A healthy buildkitd is reused; a cold start is bounded by an explicit timeout.
4. All three fixtures build into distinct timestamped images on rootless Podman 5.7.0–5.8.x.
5. Unsupported source, provider failure, and infrastructure failure are distinguishable by message and exit code.
6. Doctor reports Railpack and BuildKit status without starting or downloading anything.
7. No app image is built with a privileged container.

---

## 13. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Does the pinned rootless BuildKit image require an elevated option on the target host? | Unknown until the spike runs; the spike records the answer and the build layer follows it. |
| 2 | Should the buildkitd container show up in `easy-host list`? | No; it is infrastructure, labelled `io.easy-host.role=buildkit` and excluded. |
| 3 | Should the tool keep the buildkitd running between builds? | Yes; it uses `--restart=unless-stopped` so cold starts are rare, and `doctor` reports it. |
| 4 | Are base image pulls authenticated? | No registry credentials in v1; pulls use anonymous access. |
