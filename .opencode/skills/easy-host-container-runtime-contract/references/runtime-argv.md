# Runtime Adapter Detail

Load this file when writing or reviewing the exact Podman, git, Railpack, or BuildKit invocation.

## App container run

```text
podman run -d
  --name easy-host-<app>
  --restart=always
  -p <bind>:<hostPort>:<containerPort>
  -e PORT=<containerPort>
  -e <KEY>=<VALUE>            # merged env; never printed
  -v easy-host-<app>-<volume>:<containerPath>
  --label io.easy-host.app=<app>
  --label io.easy-host.role=app
  --label io.easy-host.image=<imageRef>
  <imageRef>
```

Rules:

- `--restart=always` is required for reboot survival; lingering is the doctor prerequisite.
- `PORT` equals the container port, not the host port.
- One named volume per declared mount; the volume name is `easy-host-<app>-<volume>`.
- No `--privileged`, `--network host`, `--cap-add`, or `--security-opt` overrides.
- Bind defaults to `0.0.0.0`; `127.0.0.1` and `::` are allowed by config.
- Host port must be `>= 1024`.

## Other operations

| Operation | Shape | Timeout guidance |
|---|---|---|
| `inspect` | `podman inspect --format json <name>` | 10s |
| `stop` | `podman stop --time 10 <name>` | 15s |
| `rm` | `podman rm --force <name>` | 15s |
| `logs` | `podman logs [--tail <n>] [-f] <name>` | Interactive follow has no timeout; non-follow 15s |
| `volume create` | `podman volume create --label io.easy-host.app=<app> <name>` | 10s |
| `volume ls` | `podman volume ls --filter label=io.easy-host.app=<app> --format json` | 10s |
| `volume rm` | `podman volume rm <name>` after label check | 10s |
| `image ls` | `podman images --filter label=io.easy-host.app=<app> --format json` | 15s |
| `image rm` | `podman image rm <ref>` after in-use check | 30s |

Every non-interactive call receives a finite timeout. A timeout maps to exit `2` for prerequisite/environment failures unless a more specific class applies.

## Git

```text
git clone --branch <ref> --single-branch <repo> <appDir>/workspace
git fetch --all --prune
git checkout <ref>
git reset --hard <ref>
```

- Clone target is confined to `apps/<name>/workspace`.
- Use the operator's SSH agent or credential helper; store no credentials.
- Distinct failures: missing repository, authentication failure, unknown ref.
- Redact URL userinfo in every message.

## BuildKit daemon

```text
podman run -d
  --name easy-host-buildkit
  --restart=unless-stopped
  -v <root>/buildkit:/var/lib/buildkit
  -v <root>/buildkit/socket:/run/buildkit
  --label io.easy-host.role=buildkit
  <pinned rootless buildkit image by digest>
```

- Listen on a unix socket under the state root; export `BUILDKIT_HOST=unix://<socket>` to Railpack.
- Reuse a healthy daemon; never start a second one.
- The exact flags are recorded in `docs/ARCHITECTURE.md#build-layer`; any elevated option is documented and justified.
- `doctor` reports reachability without starting the daemon.
- Never list it as an app; `list` filters `io.easy-host.role=app`.

## Redaction rules

| Input | Rendered |
|---|---|
| `https://user:token@git.example/repo.git` | `https://***@git.example/repo.git` |
| `ssh://git@host/repo.git` | unchanged (no secret) |
| `DATABASE_URL=postgres://u:p@h/db` | key name only, or `DATABASE_URL=***` |
| Key matching `secret`, `token`, `password`, `key` | value replaced with `***` |

Apply redaction to thrown errors, rendered diagnostics, and JSON. Do not rely on the caller to redact.

## Failure mapping

| Condition | Exit |
|---|---|
| Git auth failure, unknown ref, missing repo | 1 for invalid input; otherwise 2 when the environment prevents access |
| Podman missing, socket unreachable, daemon timeout | 2 |
| Container start fails for a config reason | 1 |
| Probe fails after a successful start | 4 |
| App or container not found | 5 |
| Name, port, or lock conflict | 6 |
| Unexpected adapter exception | 7 |
