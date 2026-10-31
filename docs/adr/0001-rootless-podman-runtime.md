---
id: ADR-0001
applies_to:
  - "src/platform/podman.ts"
  - "src/doctor/checks.ts"
  - "src/config/schema.ts"
status: Accepted
---

# ADR-0001: Run apps as rootless Podman containers with one published port

- **Deciders:** mcfuzzysquirrel (maintainer)
- **Date:** 2026-10-31

**Technical Story:** `ADD-FR-03`, `PRD-SP-01`, `PRD-C-03`

## Agent Rules

- **MUST:** start every app container through `runContainer` with `--restart=always`, the `io.easy-host.app` label, the app's named volumes, and exactly one `--publish <bind>:<port>:<container-port>`.
- **MUST:** set `PORT` to the app's `container_port` and pass environment entries as an argument array, never through a shell string.
- **MUST:** reject a host port below `1024` before any Podman call.
- **MUST NOT:** use `--privileged`, `--network host`, `--cap-add`, or publish a second port for an app.
- **SHOULD:** derive the container name with `containerName(app)` so status, logs, and remove can find it without inspecting labels.

## Verify

- **Check:** `npm test -- tests/unit/podman.test.ts tests/unit/ports.test.ts tests/unit/doctor.test.ts tests/unit/config-parse.test.ts`
- **Expected:** the recorded Podman invocation contains exactly one `--publish` and none of the prohibited flags; a port below `1024` fails with `INVALID_PORT`; `doctor --json` reports the `podman-rootless` check.

## Context and Problem Statement

easy-host runs long-lived HTTP services for one operator on one Linux host. The runtime must survive a reboot, must not require a root daemon, and must expose each app on a port the operator can predict and put behind their own ingress. Which runtime and network shape satisfy those constraints without adding a control plane?

## Decision Drivers

- No root daemon and no privileged container: the blast radius of a compromised app must stay inside one rootless user namespace.
- Predictable reachability: one declared host port per app that an operator can proxy, firewall, or tunnel.
- Reboot survival without a scheduler or daemon of our own.
- A small implementation surface that one maintainer can audit.

## Considered Options

- Rootful Docker with a Dockerfile per repository.
- Rootless Docker.
- Rootless Podman with one published port per app.
- Rootless Podman with host networking.

## Decision Outcome

Chosen option: "Rootless Podman with one published port per app", because it removes the root daemon and the Dockerfile requirement while keeping the port explicit and firewallable. `--restart=always` plus lingering covers reboot survival; host networking would have removed the one explicit port that port-conflict checks and ingress configuration depend on.

### Positive Consequences

- Each app is isolated in its own user namespace and cannot bind privileged ports.
- One published port per app makes conflicts detectable before Podman runs and makes LAN or tailnet exposure a simple operator decision.
- `podman-restart.service` and `--restart=always` provide reboot recovery with no easy-host daemon.

### Negative Consequences

- Privileged ports are impossible without a host-wide sysctl that easy-host does not change.
- Multi-port apps are out of scope; the app must serve everything on `container_port`.
- Rootless networking adds a userspace port forwarder, so high-throughput networking is not the target.
- Podman 6.x is excluded while that major line is unstable, which pins the host to a version window.

## Pros and Cons of the Options

### Rootful Docker

- Good, because it is the most familiar runtime and supports every port and capability.
- Bad, because it requires a root daemon and a Dockerfile per repository, both of which widen the attack surface and the per-repo contract.

### Rootless Docker

- Good, because it keeps the isolation properties of rootless Podman.
- Bad, because it still expects Dockerfiles and a Docker daemon, and the project targets Podman as the supported host baseline.

### Rootless Podman with one published port

- Good, because isolation, explicit ports, and reboot recovery all come from the runtime rather than from easy-host code.
- Bad, because the port is fixed for the app's lifetime and a swap cannot keep the old container serving on the same port.

### Rootless Podman with host networking

- Good, because it avoids the port forwarder and lets the app bind whatever it wants.
- Bad, because it removes the declared-port contract, allows accidental extra listeners, and makes two apps able to fight over a port without easy-host noticing.

## Links

- Implemented by `src/platform/podman.ts`.
- Prerequisite evidence in [Host prerequisites](../operations/prerequisites.md).
- Related: [ADR-0004](0004-fixed-port-health-gated-swap.md), [ADR-0006](0006-label-scoped-volume-deletion.md).
