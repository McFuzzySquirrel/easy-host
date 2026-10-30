---
name: easy-host-destructive-operation-safety
description: "Guards remove and rollback with confirmation, per-app locks, label-scoped deletion, default volume retention, foreign-resource refusal, and two-image retention."
---

# Skill: Guard easy-host Destructive Operations

Use this skill for `remove`, `rollback` confirmation, volume deletion, image pruning, retention, or any code path that stops, deletes, or replaces a resource. Accidental data loss is the product's strongest prohibition: a mistake here destroys an operator's data and cannot be undone.

Every delete resolves its target by the app label and requires the operator's explicit intent. Host paths are never deleted.

## Invariants

- `remove` without `--volumes` leaves named volumes in place and prints their names plus the exact command to delete them.
- `remove --volumes` deletes only volumes whose `io.easy-host.app` label equals the app being removed.
- A volume with missing, foreign, or mismatched labels is reported, never deleted.
- Never delete a host path, a bind mount, or a resource outside the state root and Podman's labelled volumes.
- A non-TTY `remove` without `--yes` exits `1` before deleting anything.
- `--force` skips confirmation only; it never implies `--volumes`.
- `rollback` and `remove` refuse while another mutation holds the app lock: exit `6`, naming the holding operation.
- Retention keeps exactly the current and previous image per app, and only after a successful update or rollback.
- Never remove an image used by a running container or referenced by another app.
- `remove` is allowed from any lifecycle state and is idempotent toward an already-absent container.

## Process

### Step 1: Resolve the app and enumerate what will change

Read the current rollback and removal code. Load the app from `apps/<name>/config.toml`; an unknown app is exit `5`.

Before any mutation, enumerate the exact resources: container `easy-host-<app>`, workspace, app directory, retained images, and labelled volumes. Print that list.

If the app has a broken config, then stop and report the parse error; removing based on a guessed identity risks the wrong resources.

### Step 2: Enforce intent before the first delete

- Interactive TTY: ask for confirmation and show the enumerated resources.
- Non-TTY without `--yes`: exit `1`, delete nothing.
- `--force`: skip the confirmation prompt only.
- `--volumes`: the only flag that authorizes volume deletion; print the retained volumes when it is absent.

Acquire the app lock before Step 3. If it is held, exit `6` and name the holder.

**Output:** a confirmed, enumerated plan and a held lock.

### Step 3: Delete in dependency order, label-scoped

```text
stop and rm container easy-host-<app>
delete workspace/
delete app directory (config, secrets, state)
delete retained app images (label-scoped; skip in-use and shared)
if --volumes: list volumes by io.easy-host.app=<app>, verify each label, delete only matches
report any refused foreign volume
```

Never delete by name pattern alone. A container or volume named `easy-host-<app>` with the wrong or missing label is foreign and must be reported.

**Output:** the removed resources and the retained resources with their delete instructions.

### Step 4: Apply retention only on success

After a successful update or rollback, keep current and previous and remove older images labelled for this app. Skip images in use or referenced elsewhere. On a failed update or rollback, retain both images untouched.

Rollback itself never deletes images and never builds; it swaps references through the health-gated primitive.

### Step 5: Prove the destructive path with assertions on what remains

```bash
npm run typecheck
npm test -- tests/unit/remove.test.ts
npm test -- tests/unit/retain.test.ts
npm test -- tests/unit/rollback.test.ts
EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/remove.test.ts
```

Unit tests use a fake runtime and registry. The gated removal test writes data into a volume, removes without `--volumes`, reads the data back, then re-adds and removes with `--volumes`.

By default, verify retention by reading the data back rather than trusting a listing. If reading back is impossible, the test is inconclusive, not passed.

## Gotchas

- **`podman volume rm` accepts an unlabelled volume by name.** Always inspect the label first; the name is not proof of ownership.
- **`--force` is not `--volumes`.** Conflating them deletes data the operator expected to keep.
- **Printing retained volumes is a requirement, not a courtesy.** Without the exact delete command, the operator cannot clean up deliberately.
- **A failed update must not prune.** Retention after a failed swap can delete the only serving image.
- **Images can be shared.** A tag removal can break another app or a running container; check references first.
- **Removing the app directory before the container loses the config needed to clean up.** Stop and remove the container first.
- **A non-TTY without `--yes` must fail before the enumeration has side effects.** Enumeration is read-only; keep it that way.
- **Removal of an already-absent container must still clean the directory and images.** Idempotence means finishing the job, not skipping it.

## Validation

Self-check against observable resources:

- [ ] `tests/unit/remove.test.ts` asserts that no volume delete occurs without `--volumes`.
- [ ] A planted foreign volume is reported and still exists after `remove --volumes`.
- [ ] `EASY_HOST_INTEGRATION=1 npm run test:integration -- tests/integration/remove.test.ts` reads volume data back after a default remove.
- [ ] After a successful update, `podman images --filter label=io.easy-host.app=<app>` shows exactly two images.
- [ ] A non-TTY `remove` without `--yes` exits `1` and leaves the container, volumes, and directory intact.

If a check fails, stop and fix the delete scope before shipping; there is no acceptable partial-removal result. Load [references/destructive-paths.md](./references/destructive-paths.md) when you need the removal matrix, confirmation branches, or retention rules.
