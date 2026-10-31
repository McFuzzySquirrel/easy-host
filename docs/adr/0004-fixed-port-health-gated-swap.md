---
id: ADR-0004
applies_to:
  - "src/lifecycle/swap.ts"
  - "src/lifecycle/update.ts"
  - "src/lifecycle/rollback.ts"
  - "src/health/probe.ts"
status: Accepted
---

# ADR-0004: Replace the single container behind a health gate on a fixed port

- **Deciders:** mcfuzzysquirrel (maintainer)
- **Date:** 2026-10-31

**Technical Story:** `UPD-FR-02`, `UPD-FR-03`, `UPD-NF-01`, `PRD-C-03`

## Agent Rules

- **MUST:** stop and remove the current container, start the candidate with the same app, bind, host port, container port, environment, and volumes, then probe it before recording success.
- **MUST:** on any candidate failure after the old container stopped, stop and remove the candidate and restart the previously serving image before returning.
- **MUST:** write `images.current` and `images.previous` only after the candidate is healthy, and never rewrite an image tag during a swap.
- **MUST NOT:** run the old and candidate containers at the same time on the same app port.
- **MUST NOT:** treat an unhealthy candidate as success, even if recovery succeeded.
- **SHOULD:** keep the swap in one shared module used by both `update` and `rollback`.

## Verify

- **Check:** `npm test -- tests/unit/swap.test.ts tests/unit/update.test.ts tests/unit/rollback.test.ts tests/unit/probe.test.ts`
- **Expected:** start failure, probe failure, and hung probe all reach the revert path; the previous image is restarted and state keeps both image references; `update` exits `4`; `rollback` exits `4` when the restored image cannot serve.

## Context and Problem Statement

An app owns exactly one host port, so a replacement container cannot listen while the old one is still bound. The update path is the riskiest transition in the product: a bad build or a bad start must not leave the operator with no serving app. How should the old container be replaced without a proxy or a second port?

## Decision Drivers

- One explicit host port per app, with no bundled reverse proxy.
- A failed update must leave a serving version whenever the old image can still start.
- Readiness, not process liveness, decides success.
- The same transition must serve `update` and `rollback`.

## Considered Options

- Blue/green: start the candidate on a second port and switch a proxy.
- Stop the old container, start the candidate, probe, and revert on failure.
- Restart the existing container in place.

## Decision Outcome

Chosen option: "Stop the old container, start the candidate, probe, and revert on failure", because it preserves the single-port contract and keeps the tool free of a proxy. The cost is a short outage per swap, which is acceptable for a single-host self-hosting tool and is stated in the README.

### Positive Consequences

- No proxy, no second port, and no load-balancer configuration to reason about.
- A failed start, failed probe, or hung probe always restarts the previously serving image.
- State records the pair only after a healthy result, so rollback targets are trustworthy.

### Negative Consequences

- Every swap briefly stops serving; there is no zero-downtime update.
- A failure between stopping the old container and starting the candidate depends on the revert path, not on the old container still running.
- Running containers cannot be drained; in-flight requests are cut when the old container stops.

## Pros and Cons of the Options

### Blue/green with a proxy

- Good, because it gives zero-downtime swaps and easy traffic shifting.
- Bad, because it requires a second port, a proxy, and a routing state machine that the product deliberately excludes.

### Stop, start, probe, revert

- Good, because it is one code path with an explicit recovery branch and no extra infrastructure.
- Bad, because it accepts downtime and relies on the old image being restartable.

### In-place restart

- Good, because it is the smallest possible operation.
- Bad, because a failed restart leaves nothing running and there is no candidate isolation before health is known.

## Links

- Implemented by `src/lifecycle/swap.ts`, called by `update.ts` and `rollback.ts`.
- Documented in [README success scenarios](../../README.md#success-scenarios) and the [CLI reference](../reference/cli.md#update).
- Related: [ADR-0001](0001-rootless-podman-runtime.md), [ADR-0005](0005-two-image-retention.md).
