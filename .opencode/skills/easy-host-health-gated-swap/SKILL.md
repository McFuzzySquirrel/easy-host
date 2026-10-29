---
name: easy-host-health-gated-swap
description: "Implements the stop, start, probe, keep or revert sequence shared by update and rollback, including phase reporting, bounded probes, previous-image restart, and state recording only after health."
---

# Skill: Implement the Health-Gated Swap

Use this skill for `update`, `rollback`, the shared `swap.ts` primitive, diff classification, or any change to how a candidate image replaces a serving container. This is the highest-risk state transition in easy-host: a bug here turns a bad deploy into an outage or leaves the app with no container.

The rule is absolute: the candidate must pass its probe before state records it, and a failed candidate must leave the previous version serving.

## Invariants

- Sequence: stop current → start candidate on the same host port → probe → keep or revert.
- State records the candidate only after the probe succeeds; current and previous are unchanged on revert.
- On failure, stop and remove the candidate, restart the previous container from its recorded image and config, probe once, report whether it is serving, and exit `4`.
- Never leave zero containers after the revert path, including when the candidate fails to start.
- Never overwrite or delete an image tag during a swap; tags are immutable timestamped references.
- Diff classes: `no-op`, `config-only`, `rebuild`. Repo/ref/local-path changes and `--rebuild` force rebuild; env, secrets, bind, host port, container port, health settings, and volumes are config-only; anything unknown is rebuild.
- A build failure stops before the serving container is touched (exit `3`).
- Config-only updates never invoke Railpack or BuildKit.
- Rollback never builds; it requires two recorded images (exit `5` with one).
- Every swap emits ordered phase events so a slow build is distinguishable from a stuck probe.

## Process

### Step 1: Classify the change before acquiring the lock

Read `docs/features/05-update-and-health-gate.md`, and `06-rollback-and-remove.md` for rollback. Implement `diff.ts` as a pure function comparing persisted config plus state with the desired config.

- Nothing changed and the container is running and healthy → `no-op`, exit `0`, say nothing changed.
- Only config-only fields changed → `config-only`.
- Repo, ref, local path, or `--rebuild` → `rebuild`.
- Missing or unreadable state, or a missing container → never a false no-op; treat as rebuild and record the reason.

If the diff cannot classify a field, then it is `rebuild`; silently skipping a change is worse than a slow update.

**Output:** a diff class plus a human-readable list of changed and skipped fields.

### Step 2: Prepare the candidate without touching the serving container

For a rebuild, fetch and build the candidate first. If the build fails, exit `3` with the classified build error and leave the current container running and state untouched.

For config-only, create any newly declared volumes and prepare the new container spec with the same image. Do not invoke the builder.

**Output:** a candidate image reference or a prepared container spec, and no change to the serving container yet.

### Step 3: Run the swap phases with an injected reporter

Acquire the app lock for the whole operation. Emit phase events in order: `stopping`, `starting`, `probing`, then `keeping` or `reverting` and `reverted`.

```text
stop current
start candidate on the same host port
probe candidate with the app's timing (default 2s interval, 5s attempt, 90s budget)
on success: record candidate, keep, report healthy
on failure: stop and remove candidate
            restart previous container from its recorded image and config
            probe previous once
            record the failure, leave current/previous unchanged
            exit 4
```

If the probe hangs, then the per-attempt timeout and total budget bound it; never wait indefinitely on a half-open connection.

### Step 4: Record state only at the boundary

Write `state.json` after the Podman action and the probe outcome are known. On keep: candidate becomes current, former current becomes previous. On revert: both references stay as they were. After a successful update or rollback, invoke retention to keep exactly two images; after a failed update, retain both untouched.

**Output:** state reflecting exactly what is running and what the rollback target is.

### Step 5: Prove both directions with unit and gated tests

```bash
npm run typecheck
npm test -- tests/unit/diff.test.ts
npm test -- tests/unit/swap.test.ts
npm test -- tests/unit/update.test.ts
npm test -- tests/unit/rollback.test.ts
EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/update.test.ts
```

Cover: each diff field, combined config-only and rebuild changes, `--rebuild`, missing state, keep, revert with a healthy old version, revert with an unhealthy old version, candidate start failure, budget exhaustion, lock contention, one-image rollback, and a second rollback returning to the newer image.

By default, assert with fake runtime and probe objects for unit tests; use a local git fixture copy for the gated suite. If the gated host is unavailable, report the suite as not run rather than passing vacuously.

## Gotchas

- **Recording the candidate before the probe loses the rollback target.** If the new image is current and the old is deleted or demoted, a failure has nothing to revert to.
- **Revert must also run when the candidate fails to start.** A start failure is a candidate failure, not a no-op.
- **A failed update must not prune.** Retention after a failed swap can delete the only working image.
- **Two containers cannot share the fixed host port.** Stop the old container before starting the candidate; zero-downtime is an explicit non-goal.
- **`rollback` twice must return to the original.** Swap current and previous on success; do not copy current into previous.
- **An unhealthy old version is still a real outcome.** Report both failures; do not claim recovery that did not happen.
- **A config-only update that changes the host port still swaps.** Stop old, recreate on the new port, probe, revert on failure.
- **A no-op update on an unhealthy app is not a no-op.** Update is a recovery action; attempt restoration.

## Validation

Self-check the state machine:

- [ ] `tests/unit/swap.test.ts` asserts the phase order and that a failed candidate restarts the previous container.
- [ ] After a simulated revert, `state.json` still records the same current and previous references.
- [ ] After a successful update, exactly two images remain and the candidate is current.
- [ ] A failed build exits `3` and the old container is still running with its original image.
- [ ] `EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/update.test.ts` shows version one serving after a broken commit.

If any check fails, do not ship the swap change; the rollback path is the product's core safety promise. Load [references/swap-state-machine.md](./references/swap-state-machine.md) when you need the phase table, revert branches, or state and retention rules.
