---
id: ADR-0005
applies_to:
  - "src/lifecycle/retain.ts"
status: Accepted
---

# ADR-0005: Retain exactly two labelled images per app

- **Deciders:** mcfuzzysquirrel (maintainer)
- **Date:** 2026-10-31

**Technical Story:** `RBK-FR-02`, `PRD-SP-07`

## Agent Rules

- **MUST:** retain the recorded current and previous image for an app and remove every other image that carries that app's `io.easy-host.app` label.
- **MUST:** keep an image that any running container uses, whichever app owns it.
- **MUST:** keep an image referenced by another app's recorded pair or by a running container.
- **MUST NOT:** remove an image whose labels do not name the app, even when its tag matches `localhost/easy-host-<app>:<stamp>`.
- **MUST NOT:** fail a successful update or rollback because a single image removal failed; report a warning and continue.
- **SHOULD:** treat a failed image listing as a prerequisite failure, because nothing can be proven without the image set.

## Verify

- **Check:** `npm test -- tests/unit/retain.test.ts`
- **Expected:** the recorded pair survives, an in-use or shared image survives, a foreign-label image survives, a removal failure produces a warning without failing the operation, and a listing failure raises a prerequisite error.

## Context and Problem Statement

Every build produces a new immutable image tag, so disk use grows without bound unless old images are removed. Rollback needs at least one previous image to restore. How many images should be kept, and under which safety rules may the rest be deleted?

## Decision Drivers

- Bounded disk use on a small host.
- An unambiguous rollback target: one previous image, not an arbitrary history.
- Never break a serving container or another app by deleting an image it uses.
- Retention must not turn a successful deployment into a failure.

## Considered Options

- Keep every image ever built.
- Keep the last N images, with N configurable.
- Keep exactly the current and previous images.

## Decision Outcome

Chosen option: "Keep exactly the current and previous images", because it bounds disk use and makes `rollback` a single, reversible step: swapping the pair means a second rollback returns to the newer image. Keeping a longer history would need a selection command and a pruning policy that the product does not have.

### Positive Consequences

- One rollback step in each direction, with no history to choose from.
- Disk use is bounded by two app images plus shared layers.
- The safety rules make accidental deletion of an in-use or shared image impossible.

### Negative Consequences

- There is no rollback to a version older than the previous one.
- Retention runs after the app is already serving, so a stuck removal leaves an extra image until the next run.
- An operator who wants an archive must copy the image out before the next successful update.

## Pros and Cons of the Options

### Keep every image

- Good, because any historical version remains available.
- Bad, because disk fills silently and rollback has no defined meaning.

### Keep N images

- Good, because it is flexible.
- Bad, because it needs a configurable history, a selection rule for rollback, and more state to keep consistent.

### Keep two images

- Good, because it defines rollback precisely and bounds disk use.
- Bad, because it limits recovery depth and forces external archiving for older versions.

## Links

- Implemented by `src/lifecycle/retain.ts`.
- Rollback behaviour in the [CLI reference](../reference/cli.md#rollback).
- Related: [ADR-0003](0003-pinned-railpack-buildkit-build-layer.md), [ADR-0004](0004-fixed-port-health-gated-swap.md).
