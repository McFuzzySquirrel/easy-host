# easy-host

easy-host is a Linux CLI that turns a git repository into a long-running, self-hosted HTTP service on a single machine. It clones the repository, builds an image with Railpack (no per-repo Dockerfile), runs it under rootless Podman with `--restart=always` on one host port you declare, health-gates every update, keeps the last two images for rollback, and never deletes a named volume unless you explicitly ask. It is a hosting tool, not a local development loop: there is no web UI, daemon, scheduler, webhook receiver, TLS terminator, database, or bundled reverse proxy, and a swap briefly stops the old container because the port is fixed.

## Supported stacks

Support is claimed only for the stacks the integration suite builds and probes. Railpack may detect other projects, but that is not a support promise.

| Stack | Verified fixture |
| --- | --- |
| Vite/React static SPA | `fixtures/vite-spa` |
| Node/Express | `fixtures/express-api` |
| Python/FastAPI | `fixtures/fastapi-app` |

One repository produces one service. Multi-service and compose-style stacks are out of scope.

## Prerequisites

easy-host targets Linux on x86_64 or arm64 and expects all of the following on the host:

| Requirement | Minimum | Verify |
| --- | --- | --- |
| Rootless Podman | `>= 5.7.0, < 6.0.0` | `podman --version` and `podman info --format '{{.Host.Security.Rootless}}'` (expect `true`) |
| Lingering for the owning user | enabled | `loginctl show-user "$USER" -p Linger` (expect `Linger=yes`) |
| git | 2.40 or newer | `git --version` |
| Node.js | 24 or newer | `node --version` |
| One free host port per app | 1024 or above | choose a free port and pass it with `--port` |

Three points are easy to miss:

- **Podman 6.x is not supported.** The supported range is `>= 5.7.0, < 6.0.0`; the 6.x major line is excluded while it is unstable. The `doctor` check fails on a version outside that range and names the supported range.
- **Lingering is mandatory.** Without lingering, the user's systemd manager does not start at boot, so `--restart=always` containers do not come back after a reboot. Enable it with `sudo loginctl enable-linger "$USER"`. easy-host enables `podman-restart.service` on `add`, but that user unit can only replay containers once lingering has started the user manager.
- **Privileged ports are unsupported.** Rootless Podman cannot bind a port below 1024 without a host-wide sysctl change, which easy-host does not make. Use port 1024 or above.

Run `easy-host doctor` after installing. It checks Podman, rootless mode, a Docker-compatible image loader, lingering, reboot recovery, git, Node.js, Railpack, BuildKit, and disk, and every failing check prints a remediation command. Railpack exports images through a Docker-compatible loader; on the Ubuntu host used for the v0.1.0 release gate, the `podman-docker` package provided that loader. The step-by-step guide, including the Podman 4.9 upgrade path and a verification command for each requirement, is [Host prerequisites](docs/operations/prerequisites.md). The normative requirements and every check are in [Prerequisites and Doctor](docs/features/01-prerequisites-and-doctor.md); the verified host evidence is in the [v0.1.0 release-gate record](docs/reviews/v1-success-scenarios-evidence.md).

## Install

Install Node.js 24 or newer first. easy-host is not published to the npm registry; install it globally from a checkout by one of the three supported paths. Replace `<repository-url>` with the clone URL you use for this repository.

**From a clone (current revision):**

```sh
git clone <repository-url> easy-host
cd easy-host
npm install
npm install -g .
```

**From a release tag (`v0.1.0`):**

```sh
git clone --branch v0.1.0 <repository-url> easy-host
cd easy-host
npm install
npm install -g .
```

**From a packed tarball:**

```sh
npm install
npm pack
npm install -g ./easy-host-0.1.0.tgz
```

`npm install` installs the build dependencies, and the package's `prepare` script builds `dist/` before `npm pack` and when installing from a clone. The package is marked `private`, so there is no registry publish path.

Do not use `npm install -g git+<repository-url>#v0.1.0` as the tag path. npm prepares a git dependency before its devDependencies are available, so that form fails to build; clone the tag and install from the checkout instead.

easy-host keeps its state under `$EASY_HOST_HOME` when set, otherwise `$XDG_DATA_HOME/easy-host`, otherwise `~/.local/share/easy-host`, created with mode `0700`. Each app gets `apps/<name>/config.toml` and its own workspace; there is no database.

Confirm the install with:

```sh
easy-host version
easy-host doctor
```

## Quickstart

These five commands take a repository from clone to a healthy, self-hosted service. The example app name is `blog` and the host port is `8080`; choose a free port at or above 1024.

```sh
easy-host doctor
easy-host add https://github.com/your-org/your-app.git --name blog --port 8080 --yes
easy-host status blog
easy-host logs blog --tail 100
easy-host update blog
```

`doctor` fails before the first `add` if the host is not ready. `add` clones the repository at the configured ref, builds the image, creates the container on `0.0.0.0:8080` by default, and waits for the readiness probe. The success summary prints the URL, image, previous image, and health result. `status` reports the container state, drift, port, and image; `logs` is a `podman logs` passthrough; `update` fetches the ref, rebuilds only when needed, and health-gates the swap.

The app is reachable from another machine on the LAN at `http://<host-lan-address>:8080/`. easy-host publishes the port on the LAN; it does not terminate TLS or act as a reverse proxy, so internet exposure and HTTPS are the operator's responsibility.

easy-host ships no scheduler. To repeat `update` on a schedule, write a systemd user timer that calls it; the [scheduled updates guide](docs/operations/systemd-timer.md) has complete unit files, enable commands, log location, and the lock behavior when runs overlap.

## Success scenarios

The v0.1.0 release gate exercises the four outcomes below on a fresh Linux host with rootless Podman `>= 5.7.0, < 6.0.0`, lingering enabled, and an empty state root. The [release-gate record](docs/reviews/v1-success-scenarios-evidence.md) contains the commands, exit codes, and observed output.

### 1. The app is reachable from another machine

```sh
easy-host add https://github.com/your-org/your-app.git --name blog --port 8080 --yes
curl -fsS http://<host-lan-address>:8080/
```

The `add` exits `0` and the app answers on the published port from a second machine on the LAN. A request to the host's own loopback from that second machine is not expected to answer; use the host's LAN address.

### 2. The app returns after a reboot

Reboot the host and wait for it to come back. With lingering enabled, easy-host has enabled `podman-restart.service`, which replays `--restart=always` containers at boot. No easy-host command is required, and the app answers on the same port.

### 3. A broken update keeps the previous version serving

```sh
git push origin main
easy-host update blog
```

If the candidate image fails to build, `update` exits `3` and the old container is untouched. If the candidate starts but fails the readiness probe, `update` exits `4`, stops the candidate, restarts the previous image, and reports `state: reverted`. In both cases the previous version keeps serving and `status` records the failure.

### 4. Rollback restores the previous image

```sh
easy-host rollback blog
easy-host rollback blog
```

The first rollback swaps the current and previous images, probes the restored image, and exits `0` when it serves. The second rollback returns to the newer image. easy-host retains exactly two images per app; a failed rollback stops the candidate and restarts the image it was trying to leave.

## Volume safety

Declare persistent data as a named volume when you add the app, for example `--volume blog-data:/data`. The same declaration can live in the app's `[volumes]` table. Named volumes survive `update` and `rollback`.

`easy-host remove blog` deletes the container, workspace, app directory, and images, but keeps every named volume and prints the exact command to delete each one, for example:

```sh
podman volume rm easy-host-blog-blog-data
```

`easy-host remove blog --volumes` deletes only the named volumes labelled for that app. It never deletes a host filesystem path, and it refuses a volume whose name merely matches the app pattern but whose `io.easy-host.app` label is missing or different. `--force` skips confirmation prompts but does not imply `--volumes`; without `--force`, a non-interactive `remove` requires `--yes`.

## Documentation

| Document | Contents |
| --- | --- |
| [Product definition](docs/PRD.md) | Scope, success criteria, constraints |
| [CLI command surface](docs/PRD.md#121-command-surface) | Every command and flag |
| [CLI reference](docs/reference/cli.md) | Every command, flag, argument, exit code, and example |
| [Configuration reference](docs/reference/config.md) | Every `config.toml` key, type, default, validation rule, volume, and env precedence |
| [Error shape](docs/PRD.md#123-error-shape) | Operator-facing failure block |
| [Exit codes](docs/features/01-prerequisites-and-doctor.md) | Exit-code taxonomy |
| [Operator-supplied services and ports](docs/PRD.md#63-what-the-operator-must-provide) | What the host and operator must provide |
| [Host prerequisites and doctor checks](docs/features/01-prerequisites-and-doctor.md) | Host checks, exit codes, state root |
| [Host prerequisites and upgrade](docs/operations/prerequisites.md) | Podman support window, the 4.9 upgrade, lingering, git, Node, ports |
| [Scheduled updates with a systemd timer](docs/operations/systemd-timer.md) | User units that call `update`, enable commands, logs, and lock behavior |
| [BuildKit and Railpack](docs/features/02-buildkit-and-railpack.md) | Pinned build tooling and the build lifecycle |
| [Configuration keys and validation](docs/features/03-app-registry-and-config.md) | `config.toml` keys, defaults, and validation |
| [Add and lifecycle](docs/features/04-add-and-lifecycle.md) | `add`, `list`, `status`, `logs`, and `config` behavior |
| [Update and health gate](docs/features/05-update-and-health-gate.md) | Diff classification, rebuild, and swap |
| [Rollback and remove](docs/features/06-rollback-and-remove.md) | Two-image retention, removal, and volume rules |
| [Observability and output](docs/features/07-observability-and-output.md) | JSON documents, exit codes, TTY and color behavior |
| [Docs and packaging](docs/features/08-docs-and-packaging.md) | Install paths, completions, and the documentation plan |
| [v0.1.0 release-gate record](docs/reviews/v1-success-scenarios-evidence.md) | Verified host, commands, and observed results |
| [Project idea and decisions](docs/IDEA.md) | Background and settled design choices |

Shell completions are shipped as generated files: [bash](completions/easy-host.bash), [zsh](completions/easy-host.zsh), and [fish](completions/easy-host.fish). Each file's header names its install location. There is no completion subcommand.
