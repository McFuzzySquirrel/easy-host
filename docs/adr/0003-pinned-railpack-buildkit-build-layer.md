---
id: ADR-0003
applies_to:
  - "src/platform/build.ts"
  - "src/platform/railpack.ts"
  - "src/platform/buildkit.ts"
  - "src/platform/versions.ts"
  - "src/platform/image-label.ts"
  - "fixtures/**"
status: Accepted
---

# ADR-0003: Build with a pinned Railpack binary and a pinned rootless BuildKit

- **Deciders:** mcfuzzysquirrel (maintainer)
- **Date:** 2026-10-31

**Technical Story:** `BLD-FR-03`, `BLD-NF-02`, `PRD-SP-04`

## Agent Rules

- **MUST:** import the Railpack version, asset names, SHA-256 values, and the BuildKit image reference from `src/platform/versions.ts`; no other module may declare a build dependency version.
- **MUST:** verify the Railpack archive's SHA-256 before executing it, and run BuildKit by digest (`BUILDKIT_IMAGE_REFERENCE`), never by a floating tag.
- **MUST:** export `BUILDKIT_HOST` only to the build child process, and invoke the child with an argument array.
- **MUST NOT:** resolve `latest`, a version range, or a floating tag at runtime.
- **MUST NOT:** require the workspace to contain a Dockerfile.
- **SHOULD:** classify a failure as unsupported source (exit `3`), build failure (exit `3`), or infrastructure failure (exit `2`) so the operator fixes the right layer.

## Verify

- **Check:** `npm test -- tests/unit/railpack.test.ts tests/unit/buildkit.test.ts tests/unit/build.test.ts tests/unit/fixtures.test.ts`
- **Expected:** a tampered archive is rejected before execution; the BuildKit reference includes a digest; an unreachable BuildKit socket classifies as an infrastructure failure; the three fixtures build.

## Context and Problem Statement

Supporting arbitrary repositories without a per-repo Dockerfile requires a build front end that detects providers. The front end and its build daemon are both external moving parts, and an unpinned build chain makes "it built yesterday" unreproducible. How should the build layer be pinned and invoked?

## Decision Drivers

- Reproducibility: the same commit should select the same builder versions.
- No Docker daemon requirement on the host.
- Supply-chain safety: downloaded executables must be integrity-checked.
- Clear failure attribution between unsupported source, a broken build, and broken infrastructure.

## Considered Options

- Require a Dockerfile per repository and run `podman build`.
- Use Nixpacks.
- Use Railpack with a pinned rootless BuildKit image.
- Pull prebuilt images from a registry.

## Decision Outcome

Chosen option: "Use Railpack with a pinned rootless BuildKit image", because Railpack removes the Dockerfile requirement while BuildKit gives reproducible, daemonless builds under rootless Podman. Pinning both artifacts in one module keeps upgrades reviewable and makes the failure taxonomy meaningful.

### Positive Consequences

- Repositories with a recognisable provider build with no Dockerfile.
- Builds are reproducible against a known pair of versions.
- Rootless BuildKit raises the isolation of the build step above a root daemon.

### Negative Consequences

- Two pinned external artifacts must be upgraded deliberately, including per-architecture digests.
- The build daemon is an extra container to start, reuse, and clean up.
- A repository that needs a custom Dockerfile is not supported.
- Railpack may detect a provider outside the three supported fixtures; detection is not a support promise.

## Pros and Cons of the Options

### Dockerfile per repository

- Good, because it is explicit and universally understood.
- Bad, because it makes every repository responsible for a correct image and requires a Docker-compatible daemon.

### Nixpacks

- Good, because it is mature and widely used.
- Bad, because the project standardised on Railpack and its provider output during the build spike; supporting two front ends doubles the matrix.

### Railpack with pinned BuildKit

- Good, because provider detection is automatic and both artifacts are integrity-checked.
- Bad, because Railpack is pre-1.0, so upgrades can change detection behaviour.

### Prebuilt images

- Good, because it is the fastest deployment path.
- Bad, because it turns easy-host into a registry client and removes source-to-image from the product.

## Links

- Implemented by `src/platform/build.ts`, `railpack.ts`, `buildkit.ts`, `versions.ts`, `image-label.ts`.
- Fixture support matrix in [README](../../README.md#supported-stacks).
- Related: [ADR-0001](0001-rootless-podman-runtime.md), [ADR-0005](0005-two-image-retention.md).
