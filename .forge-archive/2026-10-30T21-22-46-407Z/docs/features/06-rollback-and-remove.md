# Feature: Rollback and Remove

## 1. Feature Overview

**Feature Name:** Rollback and Remove
**Parent Document:** [PRD](../PRD.md)
**Status:** Draft
**Summary:** Closes the lifecycle: a health-gated rollback between the last two images, retention that keeps exactly those two, a removal path that deletes the app without deleting data, and the release gate that proves the four success scenarios on a real host.
**Scope:** `rollback`, image retention and pruning, `remove` with and without `--volumes`, scoped volume deletion, lock refusal, the integration proof for rollback and removal, and the human-run v0.1.0 release gate.
**Dependencies:** [Update and Health Gate](05-update-and-health-gate.md).

---

## 2. Context: Existing System State

Greenfield feature. Feature 05 provides the swap primitive; this feature exposes it as `rollback`, adds the retention policy that makes two images meaningful, and implements the destructive command with the product's strongest safety rule.

---

## 3. Feature Goals and Non-Goals

### 3.1 Goals

- Make recovery a single command with the same health guarantee as an update.
- Keep exactly two images so disk use is bounded and the rollback target is unambiguous.
- Make removal complete but never surprising: everything the tool created goes, data only on request.
- Prove the product on a real host, including a reboot, before calling it v0.1.0.

### 3.2 Non-Goals

- No rollback to an arbitrary historical image; two is the window.
- No backup, export, or restore of app data.
- No `--keep-images` or partial removal in v1.
- No automatic reboot testing; the reboot scenario is a human-run release gate.

---

## 4. User Stories

| ID | Canonical Source | Ownership | Priority |
|----|------------------|-----------|----------|
| RBK-US-01 | [RBK-US-01](#RBK-US-01) | Owns | Must |
| RBK-US-02 | [RBK-US-02](#RBK-US-02) | Owns | Must |
| RBK-US-03 | [RBK-US-03](#RBK-US-03) | Owns | Must |

```forge-requirement
{"id":"RBK-US-01","kind":"story","text":"As a homelab operator, I want to roll back to the previous image with one command so that I can recover during an incident without rebuilding."}
```

```forge-requirement
{"id":"RBK-US-02","kind":"story","text":"As a VPS tinkerer, I want to remove an app and keep its data unless I ask otherwise so that cleanup is never destructive by accident."}
```

```forge-requirement
{"id":"RBK-US-03","kind":"story","text":"As an occasional maintainer, I want a documented, repeatable release gate so that version 0.1.0 means something."}
```

---

## 5. Technical Approach

### 5.1 Impact on Existing Architecture

Adds `src/lifecycle/rollback.ts`, `retain.ts`, `remove.ts`, and the `rollback` and `remove` command handlers. Reuses `swap.ts` from feature 05. Adds cleanup of leftover images and volumes after a successful update or rollback, and labels every created resource so removal can scope its deletes.

### 5.2 New Components

| Path | Responsibility |
|---|---|
| `src/lifecycle/rollback.ts` | Swap current and previous with the shared swap primitive |
| `src/lifecycle/retain.ts` | Keep the two recorded images and remove older ones |
| `src/lifecycle/remove.ts` | Stop and remove the container, workspace, images, app directory, and optionally volumes |
| `src/cli/commands/rollback.ts`, `remove.ts` | Flag parsing, confirmation, and output |

### 5.3 Technology Additions

No new dependencies. Removal relies on `io.easy-host.*` labels to scope every delete.

---

## 6. Functional Requirements

| ID | Canonical Source | Affects Existing | Priority |
|----|------------------|------------------|----------|
| RBK-FR-01 | [RBK-FR-01](#RBK-FR-01) | No — creates `rollback.ts` | Must |
| RBK-FR-02 | [RBK-FR-02](#RBK-FR-02) | Yes — extends update | Must |
| RBK-FR-03 | [RBK-FR-03](#RBK-FR-03) | No — creates `remove.ts` | Must |
| RBK-FR-04 | [RBK-FR-04](#RBK-FR-04) | No — `remove.ts` | Must |
| RBK-FR-05 | [RBK-FR-05](#RBK-FR-05) | Yes — uses the app lock | Must |
| RBK-FR-06 | [RBK-FR-06](#RBK-FR-06) | No — release evidence | Must |

```forge-requirement
{"id":"RBK-FR-01","kind":"requirement","text":"Roll back by swapping the current and previous image references through the health-gated swap. On success the previous image becomes current and the former current becomes previous, so running rollback again returns to the newer image. On failure revert to the image that was serving before the command and exit 4. Rollback requires two recorded image references and fails with exit code 5 when only one exists."}
```

```forge-requirement
{"id":"RBK-FR-02","kind":"requirement","text":"Retain exactly the current and previous image references per app. After a successful update or rollback, remove any other image labelled for that app, and never remove an image referenced by another app or by a running container."}
```

```forge-requirement
{"id":"RBK-FR-03","kind":"requirement","text":"Remove an app by stopping and deleting its container, deleting its workspace directory, deleting its retained images, and deleting its app directory. Without --volumes, leave named volumes in place and print their names and the command to delete them. With --volumes, delete only volumes labelled for that app."}
```

```forge-requirement
{"id":"RBK-FR-04","kind":"requirement","text":"Delete a volume only when its io.easy-host.app label matches the app being removed and the operator passed --volumes. Never delete a host path, and report rather than delete a volume whose labels do not match."}
```

```forge-requirement
{"id":"RBK-FR-05","kind":"requirement","text":"Refuse rollback and remove while another mutating operation holds the app lock, exit with code 6, and name the holding operation. Remove without --yes on a non-TTY fails with exit code 1 rather than proceeding."}
```

```forge-requirement
{"id":"RBK-FR-06","kind":"requirement","text":"Record the v0.1.0 release gate as human-run evidence covering: add and LAN reachability, reboot survival, broken-update protection, rollback recovery, and removal with and without volumes. The release is not complete until that evidence records each scenario as passed on a fresh host."}
```

```forge-requirement
{"id":"RBK-NF-01","kind":"constraint","text":"After a successful remove, no container, image, workspace, or app directory labelled for the app remains unless it was explicitly retained."}
```

```forge-requirement
{"id":"RBK-NF-02","kind":"constraint","text":"Rollback is bounded by one build-free swap and one probe budget; it must not rebuild an image."}
```

---

## 7. Non-Functional Requirements

| ID | Canonical Source | Priority |
|----|------------------|----------|
| RBK-NF-01 | [RBK-NF-01](#RBK-NF-01) | Must |
| RBK-NF-02 | [RBK-NF-02](#RBK-NF-02) | Must |

---

## 8. Agent Impact Assessment

Greenfield feature. Planned owners: `lifecycle-engineer` for rollback, retention, and removal; `qa-engineer` for the rollback and removal integration tests; the release gate is a human-review task with no agent owner.

---

## 9. Implementation Phases

### Phase 1: Rollback, Retention, and Remove

```forge-task
{
  "id": "RBK-1.1",
  "title": "Implement health-gated rollback",
  "description": "Implement rollback.ts and the rollback command. Require two recorded image references, acquire the lock, swap current and previous through swap.ts, and on success update state so the former current becomes previous. On failure leave the serving image unchanged and exit 4. Print the image being restored and the image that becomes the new rollback target. Tests cover success, second rollback returning to the original, only one image, lock contention, failed candidate with recovery, and no rebuild invocation.",
  "ownerAgent": "lifecycle-engineer",
  "dependencies": ["UPD-1.2", "UPD-1.3"],
  "expectedOutputs": ["src/lifecycle/rollback.ts", "src/cli/commands/rollback.ts", "tests/unit/rollback.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/rollback.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/06-rollback-and-remove.md#RBK-FR-01", "docs/features/06-rollback-and-remove.md#RBK-FR-05"],
    "acceptanceCriteria": ["Rollback twice returns to the original image", "One image produces exit code 5", "A failed rollback leaves the serving image unchanged", "Rollback never invokes the builder"],
    "constraints": ["Reuse the shared swap primitive", "Do not delete images during rollback"],
    "constraintRefs": ["docs/features/06-rollback-and-remove.md#RBK-NF-02"],
    "references": ["docs/PRD.md#6.1 Core loop / workflow", "docs/PRD.md#13. System States / Lifecycle"]
  }
}
```

```forge-task
{
  "id": "RBK-1.2",
  "title": "Retain exactly two images per app",
  "description": "Implement retain.ts. After a successful update or rollback, list images labelled for the app, keep the current and previous references, and remove every other app image. Refuse to remove an image used by a running container or referenced by another app. Report removed and retained images. Tests cover two images, three images, an image in use, a shared image, a missing image, and an already-clean app.",
  "ownerAgent": "lifecycle-engineer",
  "dependencies": ["RBK-1.1", "ADD-1.2"],
  "expectedOutputs": ["src/lifecycle/retain.ts", "tests/unit/retain.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/retain.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/06-rollback-and-remove.md#RBK-FR-02"],
    "acceptanceCriteria": ["Exactly the current and previous images survive", "An in-use image is never removed", "An image shared with another app is never removed", "Removals are reported"],
    "constraints": ["Only remove images whose labels match the app", "Never remove by tag pattern alone"],
    "constraintRefs": ["docs/PRD.md#PRD-SP-07"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces", "docs/PRD.md#19. Future Considerations"]
  }
}
```

```forge-task
{
  "id": "RBK-1.3",
  "title": "Remove an app without deleting data by accident",
  "description": "Implement remove.ts and the remove command. Acquire the lock, print the exact resources to be deleted, require --yes on a non-TTY, stop and delete the container, delete the workspace and app directory, delete retained images, and leave volumes unless --volumes is passed. With --volumes, list volumes by the app label and delete only those, reporting any unlabelled volume it refused to touch. Tests cover default removal, --volumes removal, non-TTY without --yes, lock contention, a foreign volume, and an already-absent container.",
  "ownerAgent": "lifecycle-engineer",
  "dependencies": ["RBK-1.2", "REG-1.4", "ADD-1.5"],
  "expectedOutputs": ["src/lifecycle/remove.ts", "src/cli/commands/remove.ts", "tests/unit/remove.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/remove.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/06-rollback-and-remove.md#RBK-FR-03", "docs/features/06-rollback-and-remove.md#RBK-FR-04"],
    "acceptanceCriteria": ["Volumes survive without --volumes and are listed", "Only volumes labelled for the app are deleted with --volumes", "A foreign volume is reported, not deleted", "A non-TTY without --yes exits 1 before deleting anything"],
    "constraints": ["Never delete a host path", "No partial removal on a refused confirmation"],
    "constraintRefs": ["docs/features/06-rollback-and-remove.md#RBK-NF-01", "docs/PRD.md#PRD-C-08"],
    "references": ["docs/PRD.md#12.2 Interaction rules", "docs/PRD.md#10. Security and Privacy"]
  }
}
```

### Phase 2: Proof and Release Gate

```forge-task
{
  "id": "RBK-1.4",
  "title": "Prove rollback on the host",
  "description": "Add the gated integration test for rollback. Add an app, update it to a second version, roll back, assert the first version serves, assert the images swapped in state, roll back again, and assert the second version serves. Assert that no build occurs during either rollback and that a one-image app exits 5. Clean up all resources.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["RBK-1.1", "UPD-1.4"],
  "expectedOutputs": ["tests/integration/rollback.test.ts"],
  "validationCommands": ["npm run typecheck", "EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/rollback.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/06-rollback-and-remove.md#RBK-FR-01"],
    "acceptanceCriteria": ["Rollback restores the previous serving version", "A second rollback returns to the newer version", "No build is invoked", "The test fails rather than skips without the integration variable"],
    "constraints": ["Use a local fixture copy to control versions", "Clean up containers, images, and volumes"],
    "constraintRefs": ["docs/PRD.md#PRD-NF-07"],
    "references": ["docs/PRD.md#15. Testing Strategy", "docs/PRD.md#6.2 Success / completion criteria"]
  }
}
```

```forge-task
{
  "id": "RBK-1.5",
  "title": "Prove removal leaves no orphans but keeps data",
  "description": "Add the gated integration test for removal. Add an app with a declared volume, write data into it, remove without --volumes, and assert the container, workspace, images, and app directory are gone while the volume and its data remain and are reported. Re-add the app, then remove with --volumes and assert the volume is gone. Assert an unlabelled volume with the same name pattern is not deleted.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["RBK-1.3", "ADD-1.6"],
  "expectedOutputs": ["tests/integration/remove.test.ts"],
  "validationCommands": ["npm run typecheck", "EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/remove.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/06-rollback-and-remove.md#RBK-FR-03", "docs/features/06-rollback-and-remove.md#RBK-FR-04"],
    "acceptanceCriteria": ["Default removal keeps the volume and its data", "Removal with --volumes deletes only the app volume", "No container, image, workspace, or app directory remains", "A foreign volume is untouched"],
    "constraints": ["Verify data by reading it back, not by trusting a listing", "Clean up every resource the test creates"],
    "constraintRefs": ["docs/features/06-rollback-and-remove.md#RBK-NF-01", "docs/PRD.md#PRD-C-08"],
    "references": ["docs/PRD.md#15. Testing Strategy", "docs/PRD.md#17. Acceptance Criteria"]
  }
}
```

```forge-task
{
  "id": "RBK-1.6",
  "title": "Run the v0.1.0 release gate",
  "description": "Execute the four success scenarios by hand on a fresh Linux host with rootless Podman 5.7.0–5.8.x, lingering enabled, and an empty state root. Record in the review file, for each scenario, the commands run, the observed result, and the wall-clock time: add one supported repo and reach it from another LAN machine; reboot and confirm it returns without a manual command; push a broken commit, run update, and confirm the previous version still serves; run rollback and confirm the previous image serves; then remove and confirm the data rules. Note any deviation, unsupported stack, or prerequisite surprise. This is a human gate and cannot be satisfied by unit tests.",
  "dependencies": ["RBK-1.4", "RBK-1.5", "UPD-1.4", "ADD-1.6"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/06-rollback-and-remove.md#RBK-FR-06"],
    "acceptanceCriteria": ["All four success scenarios are recorded as passed or failed with evidence", "The reboot scenario is a real reboot, not a container restart", "The removal scenarios confirm volume retention and deletion", "Any deviation is recorded with the exact command and error"],
    "constraints": ["Run on a fresh host with an empty state root", "Do not mark a scenario passed without observing it"],
    "constraintRefs": ["docs/PRD.md#PRD-C-02", "docs/PRD.md#PRD-C-08"],
    "references": ["docs/PRD.md#6.2 Success / completion criteria", "docs/features/06-rollback-and-remove.md#12. Acceptance Criteria"],
    "reviewFile": "docs/reviews/v1-success-scenarios.json"
  }
}
```

---

## 10. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit Tests | Rollback state changes, retention, removal scoping, confirmation | Vitest with fake runtime and registry |
| Integration Tests | Real rollback and real removal with data verification | Gated suite on the Linux host |
| Human Review | The four success scenarios, including reboot | Release gate recorded in `docs/reviews/v1-success-scenarios.json` |

Key test scenarios:

1. Rollback restores the previous version and a second rollback returns.
2. Rollback with one image exits 5 and changes nothing.
3. Retention keeps exactly two images and refuses in-use or shared images.
4. Remove keeps volumes and reports them.
5. `remove --volumes` deletes only labelled volumes.
6. A foreign volume is reported, not deleted.
7. Non-TTY removal without `--yes` deletes nothing.
8. Release gate: add, reboot, broken update, rollback, remove.

---

## 11. Rollback Considerations

Reverting removes the rollback, retention, and removal modules and their commands. Containers and volumes created earlier remain and must be cleaned up with Podman. Retention changes are not reversible: an image pruned by this feature cannot be restored. The release evidence remains valid only for the tested version.

---

## 12. Acceptance Criteria

1. `rollback` restores the previous image, serves, and a second rollback returns to the newer image.
2. Rollback with fewer than two images exits 5 without changing state.
3. Exactly two images per app survive a successful update or rollback.
4. `remove` deletes the container, workspace, images, and app directory.
5. `remove` without `--volumes` leaves and reports the volume.
6. `remove --volumes` deletes only volumes labelled for the app.
7. A non-TTY removal without `--yes` deletes nothing.
8. The release gate records all four scenarios on a fresh host, including a real reboot.

---

## 13. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should `remove` delete the app directory when the container is already missing? | Yes; removal is idempotent and cleans whatever remains. |
| 2 | Should retention run after a failed update? | No; a failed update leaves both images untouched. |
| 3 | Should rollback be allowed while the current container is unhealthy? | Yes; it is a recovery action and still health-gated. |
| 4 | Is `--force` needed on remove when the container is in an unknown state? | Yes; it skips confirmation only, never volume deletion. |
