---
name: easy-host-build-layer
description: "Pins and verifies Railpack, manages the rootless buildkitd lifecycle, builds a workspace into a timestamped image, streams output, and classifies unsupported-source, build, and infrastructure failures."
---

# Skill: Work on the easy-host Build Layer

Use this skill for `src/platform/versions.ts`, `railpack.ts`, `buildkit.ts`, `build.ts`, the build-doctor group, or the build fixtures. The build layer is pre-1.0, digest-pinned, rootless-sensitive, and the product's top technical risk: a floating version or an unverified binary either breaks every build or executes untrusted code.

Pins live in exactly one module. Build failures are classified so the operator knows whether to fix the repo or the host.

## Invariants

- `versions.ts` is the only place declaring `RAILPACK_VERSION`, per-architecture SHA-256 values, `BUILDKIT_IMAGE`, and `BUILDKIT_DIGEST`.
- Railpack is pinned at `0.43.0`; BuildKit is the `0.34.1-rootless` image pinned by digest.
- Verify the SHA-256 before extraction and before execution; never execute a partial or mismatched download.
- `EASY_HOST_RAILPACK_BIN` bypasses the download and must point at an executable file.
- The managed buildkitd is rootless, named distinctly, labelled `io.easy-host.role=buildkit`, and never listed as an app.
- `BUILDKIT_HOST` points at the managed unix socket for every build.
- Image tag: `localhost/easy-host-<app>:<UTC yyyymmddThhmmssZ>`. No mutable `:current` tag.
- Build output streams line by line to stderr within one second; never buffer until completion.
- One build at a time per host in v1.
- No Dockerfile is required in the target repository.

## Process

### Step 1: Confirm the current build contract before changing behavior

Read the pinned values in `src/platform/versions.ts`, the build adapter code, and the build tests. The [architecture note](../../../docs/ARCHITECTURE.md#build-layer) records the current pins and the loader prerequisite.

If the build layer cannot be exercised on the available host, then do not change build behavior on an unproven assumption; record the blocker and re-plan with `support-lead`.

### Step 2: Change pins in one module and acquisition in one path

Update `versions.ts` first: version string, per-architecture download URL, SHA-256, image reference, digest. Then update `railpack.ts` to resolve, download once into `<root>/tools`, verify, extract, and cache.

Cache rules:

- Verified cached binary → reuse without downloading.
- Cache miss → download to a temp path, hash, reject mismatch without executing, then move into place.
- Override → validate executable and skip download.
- Unsupported architecture → exit `2` with the detected architecture named.

**Output:** one source of pins, one verified acquisition path, and explicit failure for each acquisition branch.

### Step 3: Ensure buildkitd as infrastructure

`ensure()` returns a healthy existing daemon when the socket accepts a connection; otherwise start the pinned image with the exact flags recorded by the spike and wait for the socket with a finite readiness timeout. `stop()` and `status()` complete the lifecycle.

Use the shared runtime adapter for every Podman call. Mount the state root for socket and cache. Export `BUILDKIT_HOST=unix://<socket>` to Railpack.

If a second daemon would be started, then reuse the healthy one instead; two daemons fight over the socket and cache.

### Step 4: Build, stream, and classify

Invoke the pinned Railpack binary with the workspace as context and the timestamped tag. Validate the app name before it enters the tag. Stream stdout and stderr to stderr line by line.

Classify failures:

| Class | Signal | Exit | Remediation |
|---|---|---|---|
| `unsupported-source` | Railpack found no provider | 3 | Add a supported stack or check repo layout |
| `build-failure` | A provider ran and failed | 3 | Inspect the streamed build output |
| `infrastructure-failure` | Socket unreachable, readiness timeout, image pull error | 2 | Run `easy-host doctor`; check buildkitd and registry access |

Never retry an infrastructure failure silently in a loop; report it with the underlying error.

**Output:** image reference on success, one classified error with a distinct remediation on failure.

### Step 5: Prove the layer with unit tests and the gated suite

```bash
npm run typecheck
npm test -- tests/unit/railpack.test.ts
npm test -- tests/unit/buildkit.test.ts
npm test -- tests/unit/build.test.ts
EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/build.test.ts
```

Use an injected fetcher, temp directory, fake child process, and recording runner. Cover cache hit, cache miss, digest mismatch, override path, non-executable override, unsupported architecture, daemon reuse, cold start timeout, streaming order, and each failure class.

By default, run the gated suite only on the Linux host with the supported Podman range. If it is absent, report not run; never convert it to a pass.

## Gotchas

- **A digest mismatch must abort before extraction.** Extracting first can execute a tampered binary during a later version check.
- **`BUILDKIT_HOST` must be exported to the child, not set on the parent shell.** A missing env produces a misleading "cannot connect" build failure.
- **A rootless buildkitd needs its socket and cache under the state root.** Writing to `/run` or `/var/lib` fails or requires elevation.
- **Image pull failures are infrastructure, not source.** Classifying them as build failures sends the operator to the wrong repo.
- **Railpack is pre-1.0.** A floating version breaks builds without a code change; upgrade only as a deliberate task with fixtures.
- **The buildkitd container is not an app.** It must carry `role=buildkit` and be filtered out of `list`.
- **Buffering hides a long build.** Flush each line; a multi-minute build that prints nothing looks like a hang.
- **The same-second timestamp can collide.** Two builds in one second would share a tag; serialize builds per host and never overwrite a tag.
- **A Dockerfile path is not the contract.** Detection is Railpack's job; do not add a Dockerfile fallback as a first-class path.

## Validation

Self-check the build contract:

- [ ] `tests/unit/railpack.test.ts` proves a digest mismatch aborts before any execution.
- [ ] A second build reuses the cached binary and performs no download.
- [ ] `tests/unit/build.test.ts` asserts line-by-line streaming order, not just final output.
- [ ] `EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/build.test.ts` produces three distinct timestamped images and cleans them up.
- [ ] `grep -R "0.43.0\|BUILDKIT" src/platform/versions.ts` is the only pin declaration site.

If a check fails, fix the pin, acquisition, or classification path before wiring a new caller. Load [references/build-pipeline.md](./references/build-pipeline.md) when you need the acquisition branches, daemon flags, tag format, or failure-class table.
