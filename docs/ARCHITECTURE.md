# Architecture

easy-host is a small CLI that hosts git repositories as rootless Podman services
on one machine. This document describes the modules as they exist in `src/` and
the contracts that hold them together. It is the maintainer's map, not a
specification of future work. The durable decisions behind these boundaries are
recorded in the [ADR index](adr/README.md).

## Command surface

`src/cli/program.ts` registers exactly ten commands:

```
add  list  status  logs  update  rollback  remove  config  doctor  version
```

There is no daemon, scheduler, or completion subcommand. `scripts/generate-completions.ts`
writes the shell completion files in `completions/`.

## Module map

| Module | Responsibility | Owner |
|---|---|---|
| `src/cli` | command registration, argument parsing, prompts, error mapping, output rendering | `cli-engineer` |
| `src/config` | TOML `AppSpec` schema, parsing, name derivation, environment merging | `cli-engineer` |
| `src/registry` | app directory store, disposable `state.json` cache, drift detection, port conflicts | `cli-engineer` |
| `src/doctor` | host prerequisite checks and their ordered report | `cli-engineer` |
| `src/platform` | git, Podman, lock, path, boot-recovery, image-label, and build adapters | `platform-engineer` (build files: `build-engineer`) |
| `src/health` | HTTP and TCP readiness probes | `platform-engineer` |
| `src/lifecycle` | add, diff, swap, update, rollback, retention, remove orchestration | `lifecycle-engineer` |
| `fixtures` | Vite/React, Node/Express, and Python/FastAPI build fixtures | `build-engineer` |
| `tests` | unit, docs, packaging, and gated integration suites | `qa-engineer` |

## On-disk state

The filesystem is the registry. `apps/<name>/config.toml` is the truth;
`state.json` beside it is a disposable cache that is rebuilt when missing,
corrupt, or partial.

The state root resolves in this order:

1. `$EASY_HOST_HOME`
2. `$XDG_DATA_HOME/easy-host`
3. `~/.local/share/easy-host`

Each app directory contains `config.toml` (`0644`), `secrets.env` (`0600`),
`workspace/`, and `state.json`. Directories are created `0700`. Writes go to a
temporary file in the same directory followed by a rename, so a crash leaves
either the old complete file or the new complete file.

`config.toml` requires exactly one of `repo` or `local_path`, plus `port`.
Defaults are `ref=main`, `container_port=3000`, `bind=0.0.0.0`, `probe=http`,
`health_path=/`, `health_interval_ms=2000`, `health_timeout_ms=5000`, and
`health_startup_ms=90000`. Host ports are `1024–65535`.

## Build layer

`src/platform/versions.ts` pins Railpack `0.43.0` with per-architecture SHA-256
values, and the rootless BuildKit image
`docker.io/moby/buildkit:v0.34.1-rootless` by digest. Nothing resolves "latest"
at runtime.

`railpack.ts` downloads and verifies the binary before executing it.
`buildkit.ts` starts, reuses, and stops the daemon container, labelled
`io.easy-host.role=buildkit`. `build.ts` turns a workspace into a tagged image,
streams output, and classifies failures as unsupported source, build failure, or
infrastructure failure. The buildkitd container is infrastructure and never
appears as an app.

Railpack exports images through a Docker-compatible loader; without one, builds
stall at the export step. On the supported Ubuntu host the `podman-docker`
package supplies it, and `doctor` reports a `docker-loader` check.

## Lifecycle

A mutating command runs in this order: preflight, lock, prepare, build or reuse,
mutate, probe, persist, report.

- `add` validates config, allocates a name, checks ports and prerequisites, and
  only then creates anything. A failed first probe removes the container, keeps
  the image and app entry, records `unhealthy`, and exits `4`.
- `update` classifies the change as no-op, config-only, or rebuild, and
  health-gates the swap. A candidate that fails after the old container stopped
  restarts the previous image.
- `rollback` swaps current and previous images and probes the restored one. It
  never invokes Railpack or BuildKit.
- `remove` keeps named volumes unless `--volumes` is passed, deletes only
  volumes labelled `io.easy-host.app=<name>`, and never deletes a host path.

Exactly two images are retained per app: current and previous. An in-use or
shared image is never removed.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | usage |
| `2` | prerequisite or environment |
| `3` | build failure |
| `4` | health failure |
| `5` | not found |
| `6` | conflict or lock held |
| `7` | internal or unexpected error |

These are a public contract: scripts and systemd timers branch on them.

## Output

Every command supports `--json`, which writes exactly one document to stdout
with `schemaVersion: 1`, no ANSI escapes, stable field names, and empty arrays
present. Human output uses `NO_COLOR` and TTY detection; no meaning is carried
by colour alone. Secrets, environment values, and credentials embedded in
repository URLs are never printed.

## Concurrency

A per-app advisory lock file records the holder's pid and start time. A second
mutation exits `6` and names the holder; a lock whose pid is gone is reclaimed.
Read-only commands never take the global lock. Ports are compared by equality
regardless of bind address, so two apps cannot declare the same port.

## Testing

Unit tests run with no Podman, no network, and no root, using injected runners,
clocks, and sockets. Docs tests compare the README, references, and migration
note against the code. Packaging tests install the packed tarball. Integration
tests are gated behind `EASY_HOST_INTEGRATION=1` and run against a real rootless
host with guaranteed cleanup; they fail loudly when the gate is absent rather
than passing vacuously.
