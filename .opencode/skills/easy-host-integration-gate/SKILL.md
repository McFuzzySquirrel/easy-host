---
name: easy-host-integration-gate
description: "Adds gated Podman integration or release evidence with EASY_HOST_INTEGRATION enforcement, unique resources, local git fixtures, bounded waits, guaranteed cleanup, and non-vacuous assertions."
---

# Skill: Write an easy-host Integration Gate

Use this skill for `tests/integration/**`, the packaging test, or any release-evidence test. The unit suite runs with no Podman and no network; the gated suite is the only proof that real builds, containers, probes, swaps, and removals work. A test that skips silently or asserts nothing certifies a broken release.

Gating is explicit, resources are isolated, waits are bounded, cleanup is guaranteed, and every assertion is about observed behavior.

## Invariants

- Integration tests run only with `EASY_HOST_INTEGRATION=1`.
- Missing the variable is a **failure** with a clear message, not a skip.
- Each run uses a temporary state root and unique app, container, and volume names.
- Git fixtures are local copies the test controls; no test depends on a public remote or a push.
- Every wait has a finite timeout; no unbounded poll or `sleep` loop.
- Cleanup runs in `finally` and removes containers, volumes, images, buildkitd, and the temp root.
- Assertions are non-vacuous: read data back, assert exit codes, assert state fields, and confirm the negative case.
- Evidence is recorded separately from the package; the human release gate is never automated.
- Tests never touch the operator's real state root.

## Process

### Step 1: Name the behavior and its failure mode

Read the owning feature's testing section and acceptance criteria: `docs/features/02-buildkit-and-railpack.md`, `04-add-and-lifecycle.md`, `05-update-and-health-gate.md`, `06-rollback-and-remove.md`, or the packaging section of `08-docs-and-packaging.md`.

State the behavior as a claim you can falsify: "a broken commit leaves version one serving" is testable; "update works" is not.

If the claim needs a human to observe a reboot or LAN reachability, then keep it in the release gate and do not fake it in the suite.

### Step 2: Build an isolated harness

```text
1. Fail fast when EASY_HOST_INTEGRATION is not "1".
2. Create a temp root under /tmp or the OS temp dir; set EASY_HOST_HOME to it.
3. Derive a unique suffix (pid + timestamp) for app and volume names.
4. Copy the fixture into a temp git repo; commit version one.
5. Register cleanup before the first resource is created.
```

Never use the default `~/.local/share/easy-host` root in a test. Never reuse a container name across suites; a leftover container makes the next run fail for the wrong reason.

### Step 3: Drive the real command or module and bound every wait

Prefer invoking the built CLI or the orchestration module with real adapters over re-implementing the flow. Wait for health with the documented probe budget, and wait for container state with a short bounded poll.

```text
deadline = now + budget
while now < deadline:
  result = probe()
  if result healthy: break
  sleep(interval)
assert result healthy
```

A timeout is a test failure with the last probe error, not a retry that ignores the budget.

### Step 4: Assert the positive and the negative

At minimum:

- Assert the returned exit code, not only the printed text.
- Assert the observed resource exists and has the required property (restart policy, published port, label, image reference).
- For failure paths, assert what must **not** exist (no candidate container, volume retained, old image still current).
- Read persisted data back instead of trusting a directory or volume listing.
- Assert drift, state, or JSON fields where the feature claims them.

If the negative assertion is expensive, then use an injected recorder to prove the call did not happen and a real inspection to prove the resource survived.

### Step 5: Clean up and record evidence

Cleanup is unconditional: stop and remove containers, remove labelled volumes, remove images, stop buildkitd if the suite started it, and delete the temp root. A cleanup failure is reported, not swallowed.

```bash
npm run typecheck
EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/build.test.ts
EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/add.test.ts
EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/update.test.ts
EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/rollback.test.ts
EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/remove.test.ts
npm run test:packaging
```

By default, run only the suite you changed on a supported host, then the full gated suite before release. If the host is unsupported, report the suite as not run with the Podman version; do not mark it passed.

## Gotchas

- **A skipped suite is a green light.** `describe.skip` or a conditional `return` when `EASY_HOST_INTEGRATION` is absent falsely certifies the release; fail fast instead.
- **Cleanup in `afterAll` does not run when setup throws.** Register cleanup immediately after each resource is created, or use `try/finally`.
- **A volume listing is not data proof.** Write a sentinel, remove, re-attach, and read the sentinel back.
- **Shared names collide across parallel suites.** Use a unique suffix and per-app names.
- **`sleep 5` is not a wait.** Poll the actual condition with a deadline and report the last failure.
- **A test that only asserts exit 0 can pass on a no-op.** Assert the resource state and the changed behavior.
- **The real state root can be destroyed by a cleanup bug.** Always set `EASY_HOST_HOME` to a temp root before the first command.
- **Image pulls and Railpack downloads need network.** Document the assumption; do not silently retry forever.
- **The reboot and LAN checks are human gates.** Automating the decision contradicts the PRD; collect evidence instead.

## Validation

Self-check the gate itself:

- [ ] Running the suite without `EASY_HOST_INTEGRATION=1` fails with a message naming the variable.
- [ ] `EASY_HOST_HOME` is a temp root for every test, and the real root is never touched.
- [ ] A forced failure mid-test still leaves no container, volume, image, or temp directory behind.
- [ ] The removal test reads volume data back after a default remove.
- [ ] The broken-update test asserts exit `4`, the old image remains current, and version one still answers.

If a check fails, fix the harness before adding assertions; an unreliable gate hides regressions. Load [references/integration-matrix.md](./references/integration-matrix.md) when you need the suite matrix, cleanup order, or evidence shape.
