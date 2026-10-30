# Feature: Update and Health Gate

## 1. Feature Overview

**Feature Name:** Update and Health Gate
**Parent Document:** [PRD](../PRD.md)
**Status:** Draft
**Summary:** Makes an existing app move forward safely: decide whether a change needs a rebuild or only a container recreate, build the candidate, swap it in behind a health probe, and automatically return to the previous version when the candidate fails.
**Scope:** Diff classification, the stop/start/probe/revert sequence, previous-image recording, no-op and unhealthy-app handling, and config-only updates. Image pruning and user-invoked rollback belong to [Rollback and Remove](06-rollback-and-remove.md).
**Dependencies:** [Add and Lifecycle](04-add-and-lifecycle.md).

---

## 2. Context: Existing System State

Greenfield feature. Feature 04 provides `add`, the builder, the container runtime, the probe, and the registry. This feature adds the first operation that replaces a serving container, so it owns the riskiest state transition in the product.

---

## 3. Feature Goals and Non-Goals

### 3.1 Goals

- Never trade a working version for a broken one without a way back.
- Make the common change (an env var or a health path) cheap: no rebuild.
- Make the swap sequence legible in the output: what is being built, stopped, started, probed, and reverted.
- Make a failed update safe to retry.

### 3.2 Non-Goals

- No zero-downtime swap; the fixed port means the old container stops first.
- No user-invoked rollback; that is feature 06.
- No automatic update scheduling, webhook, or git polling.
- No migration of app data between versions.

---

## 4. User Stories

| ID | Canonical Source | Ownership | Priority |
|----|------------------|-----------|----------|
| UPD-US-01 | [UPD-US-01](#UPD-US-01) | Owns | Must |
| UPD-US-02 | [UPD-US-02](#UPD-US-02) | Owns | Must |
| UPD-US-03 | [UPD-US-03](#UPD-US-03) | Owns | Should |

```forge-requirement
{"id":"UPD-US-01","kind":"story","text":"As a homelab operator, I want a broken commit to leave the previous version serving so that pushing a mistake is not an outage."}
```

```forge-requirement
{"id":"UPD-US-02","kind":"story","text":"As an occasional maintainer, I want an environment change to apply without a multi-minute rebuild so that small fixes stay small."}
```

```forge-requirement
{"id":"UPD-US-03","kind":"story","text":"As a VPS tinkerer, I want update to say exactly what it changed and what it skipped so that I can trust it in a timer."}
```

---

## 5. Technical Approach

### 5.1 Impact on Existing Architecture

Adds `src/lifecycle/diff.ts`, `swap.ts`, `update.ts`, and `src/cli/commands/update.ts`. Reuses the builder, runtime, probe, registry, and error taxonomy. Adds a state transition writer for the `swapping`, `reverted`, and `healthy` states defined in the PRD lifecycle.

### 5.2 New Components

| Path | Responsibility |
|---|---|
| `src/lifecycle/diff.ts` | Classify a change as none, config-only, or rebuild |
| `src/lifecycle/swap.ts` | Stop, start, probe, keep or revert; shared with rollback |
| `src/lifecycle/update.ts` | Update orchestration and reporting |
| `src/cli/commands/update.ts` | Flag parsing and output |

### 5.3 Technology Additions

No new dependencies. Reuses feature 04's probe and runtime.

---

## 6. Functional Requirements

| ID | Canonical Source | Affects Existing | Priority |
|----|------------------|------------------|----------|
| UPD-FR-01 | [UPD-FR-01](#UPD-FR-01) | No — creates `diff.ts` | Must |
| UPD-FR-02 | [UPD-FR-02](#UPD-FR-02) | No — creates `swap.ts` | Must |
| UPD-FR-03 | [UPD-FR-03](#UPD-FR-03) | Yes — extends state | Must |
| UPD-FR-04 | [UPD-FR-04](#UPD-FR-04) | No — `update.ts` | Should |
| UPD-FR-05 | [UPD-FR-05](#UPD-FR-05) | No — `update.ts` | Must |

```forge-requirement
{"id":"UPD-FR-01","kind":"requirement","text":"Classify each update as no-op, config-only, or rebuild. Repo URL, ref, or local path changes and an explicit --rebuild always require a rebuild. Changes limited to env, secrets, bind, host port, container port, health settings, or volumes are config-only. Everything else that is unknown is treated as a rebuild."}
```

```forge-requirement
{"id":"UPD-FR-02","kind":"requirement","text":"Swap by stopping the current container, starting the candidate on the same host port, and probing it. On probe success, keep the candidate and record it as current. On failure, stop and remove the candidate, restart the previous container from its recorded image and config, probe it once, report whether it is serving again, and exit 4."}
```

```forge-requirement
{"id":"UPD-FR-03","kind":"requirement","text":"Never overwrite an image tag. Record the candidate reference and the previous reference in state only after the candidate is healthy; on revert, leave current and previous unchanged."}
```

```forge-requirement
{"id":"UPD-FR-04","kind":"requirement","text":"Allow update on an app whose current state is unhealthy or whose container is missing, treating the update as an attempt to restore service. Report an explicit no-op with exit code 0 when the diff classifies as none and the container is running and healthy."}
```

```forge-requirement
{"id":"UPD-FR-05","kind":"requirement","text":"Apply config-only updates by recreating the container with the same image and the new settings, creating any newly declared volumes, and health-gating the result. Do not invoke Railpack or BuildKit for a config-only update."}
```

```forge-requirement
{"id":"UPD-NF-01","kind":"constraint","text":"An update must never leave the app with no container: the revert path restarts the previous container before exiting."}
```

```forge-requirement
{"id":"UPD-NF-02","kind":"constraint","text":"Every swap reports each phase start and outcome so an operator can tell a slow build from a stuck probe."}
```

---

## 7. Non-Functional Requirements

| ID | Canonical Source | Priority |
|----|------------------|----------|
| UPD-NF-01 | [UPD-NF-01](#UPD-NF-01) | Must |
| UPD-NF-02 | [UPD-NF-02](#UPD-NF-02) | Must |

---

## 8. Agent Impact Assessment

Greenfield feature. Planned owners: `lifecycle-engineer` for diff, swap, update, and the command; `qa-engineer` for the broken-update integration test. The swap module is shared with feature 06, so its interface is fixed here before rollback consumes it.

---

## 9. Implementation Phases

### Phase 1: Diff and Swap

```forge-task
{
  "id": "UPD-1.1",
  "title": "Classify an update as no-op, config-only, or rebuild",
  "description": "Implement diff.ts comparing the persisted config and state with the desired config. Return no-op when nothing changed and the container is running and healthy; config-only for env, secrets, bind, host port, container port, health settings, and volume changes; rebuild for repo, ref, local-path changes and for --rebuild. Treat unknown differences as rebuild. Tests cover each field, a combined config-only change, a combined rebuild change, the force flag, a missing state file, and an app whose container is missing.",
  "ownerAgent": "lifecycle-engineer",
  "dependencies": ["REG-1.1", "ADD-1.4"],
  "expectedOutputs": ["src/lifecycle/diff.ts", "tests/unit/diff.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/diff.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/05-update-and-health-gate.md#UPD-FR-01"],
    "acceptanceCriteria": ["Every config-only field is covered by a test", "Repo, ref, and local-path changes force a rebuild", "Unknown differences default to rebuild", "A missing state file does not produce a false no-op"],
    "constraints": ["The diff never mutates state", "The diff is pure and testable without Podman"],
    "constraintRefs": ["docs/PRD.md#PRD-NF-06"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces", "docs/PRD.md#13. System States / Lifecycle"]
  }
}
```

```forge-task
{
  "id": "UPD-1.2",
  "title": "Swap a container with auto-revert",
  "description": "Implement swap.ts. Stop the current container, start the candidate with the same port and settings, and probe. On success return kept with the candidate image. On failure stop and remove the candidate, restart the previous container from its recorded image, probe it once, and return reverted with the failure and recovery results. Emit phase events (stopping, starting, probing, keeping, reverting, reverted) through an injected reporter. Tests use fake runtime and probe to cover keep, revert with a healthy old version, revert with an unhealthy old version, candidate start failure, and a probe that hangs until the budget expires.",
  "ownerAgent": "lifecycle-engineer",
  "dependencies": ["UPD-1.1", "ADD-1.2", "ADD-1.3"],
  "expectedOutputs": ["src/lifecycle/swap.ts", "tests/unit/swap.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/swap.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/05-update-and-health-gate.md#UPD-FR-02", "docs/features/05-update-and-health-gate.md#UPD-FR-03"],
    "acceptanceCriteria": ["A failed candidate always triggers a restart of the previous container", "The previous image reference is unchanged after a revert", "Phase events are emitted in order", "A hung probe is bounded by the startup budget"],
    "constraints": ["No two app containers run on the same host port", "Never delete the previous image during a swap"],
    "constraintRefs": ["docs/features/05-update-and-health-gate.md#UPD-NF-01", "docs/PRD.md#PRD-C-03"],
    "references": ["docs/PRD.md#12.3 Error shape", "docs/PRD.md#13. System States / Lifecycle"]
  }
}
```

### Phase 2: Update Command and Proof

```forge-task
{
  "id": "UPD-1.3",
  "title": "Wire the update command",
  "description": "Implement update.ts and the update command. Load the app, acquire the lock, compute the diff, and execute the matching path: no-op, config-only recreate, or fetch plus rebuild plus swap. Apply config changes to the working config only after the operation succeeds, except for the candidate image reference which is recorded on success by the swap. Report what changed, what was skipped, and the final health. Exit 0 on success or no-op, 3 on build failure, 4 on a failed candidate, and 6 when the lock is held. Tests cover each diff class, build failure before any stop, lock contention, and reporting.",
  "ownerAgent": "lifecycle-engineer",
  "dependencies": ["UPD-1.2", "BLD-1.3", "REG-1.4"],
  "expectedOutputs": ["src/lifecycle/update.ts", "src/cli/commands/update.ts", "tests/unit/update.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/update.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/05-update-and-health-gate.md#UPD-FR-04", "docs/features/05-update-and-health-gate.md#UPD-FR-05"],
    "acceptanceCriteria": ["A config-only update never calls the builder", "A rebuild failure stops before the old container is touched", "A no-op exits 0 and says nothing changed", "An unhealthy app is still updateable"],
    "constraints": ["Hold the app lock for the whole operation", "Do not prune images here"],
    "constraintRefs": ["docs/features/05-update-and-health-gate.md#UPD-NF-02", "docs/PRD.md#PRD-NF-03"],
    "references": ["docs/PRD.md#6.1 Core loop / workflow", "docs/PRD.md#12.2 Interaction rules"]
  }
}
```

```forge-task
{
  "id": "UPD-1.4",
  "title": "Prove a broken update keeps the old version",
  "description": "Add the gated integration test for update. Add an app from a local fixture copy, serve version one, push a syntactically broken commit, run update, and assert exit code 4, that the old container is running from the old image, that the app still answers with the version-one response, and that state still records the old image as current. Then fix the commit, run update, and assert the new version serves. Also assert a config-only update completes without a build by checking the builder was not invoked.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["UPD-1.3", "ADD-1.6"],
  "expectedOutputs": ["tests/integration/update.test.ts"],
  "validationCommands": ["npm run typecheck", "EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/update.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/05-update-and-health-gate.md#UPD-FR-02", "docs/features/05-update-and-health-gate.md#UPD-FR-05"],
    "acceptanceCriteria": ["A broken commit leaves the old version serving", "The exit code is 4 and the failure reason is reported", "A fixed commit then serves the new version", "A config-only update performs no build"],
    "constraints": ["Use a local git fixture copy so the test controls commits", "Clean up containers, images, and the temporary root"],
    "constraintRefs": ["docs/PRD.md#PRD-NF-07", "docs/PRD.md#PRD-C-10"],
    "references": ["docs/PRD.md#15. Testing Strategy", "docs/PRD.md#6.2 Success / completion criteria"]
  }
}
```

---

## 10. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit Tests | Diff classification, swap phases, revert, command exit codes | Vitest with fake runtime, probe, and reporter |
| Integration Tests | Broken update, fixed update, config-only update | Gated suite with a local git fixture copy |
| Regression Tests | Never leave zero containers; never overwrite a tag | Assertions after every failure path |

Key test scenarios:

1. Env-only change is config-only; ref change is rebuild.
2. Unknown difference defaults to rebuild rather than a silent no-op.
3. Candidate fails the probe: previous restarts and serves.
4. Candidate fails to start: same revert path.
5. Old version is unhealthy during revert: report both failures without pretending recovery.
6. A no-op update exits 0.
7. A broken commit keeps version one serving; a fixed commit serves version two.
8. A config-only update performs no build.

---

## 11. Rollback Considerations

Reverting removes `src/lifecycle/{diff,swap,update}.ts` and the update command. Apps updated while the feature was present keep their recorded image references, so the reverted binary can still start them; the swap behavior disappears, so a future update must be done by hand. No data migration is required.

---

## 12. Acceptance Criteria

1. A broken commit leaves the previous version serving and exits 4.
2. The previous image and config are unchanged after a revert.
3. A config-only update applies without invoking Railpack or BuildKit.
4. A no-op update is reported and exits 0.
5. An unhealthy or missing container can be repaired by update.
6. A build failure occurs before the serving container is touched.
7. Lock contention exits 6 without side effects.

---

## 13. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should a config-only update that changes the host port be allowed while the old container is stopped? | Yes; stop old, recreate on the new port, probe, revert on failure. |
| 2 | Should the old container be restarted if the candidate fails before it starts? | Yes; the revert path runs for any candidate failure after the old container stops. |
| 3 | Should update pull the newest base images? | Only through a rebuild; config-only updates reuse the existing image. |
