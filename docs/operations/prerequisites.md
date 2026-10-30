# Host prerequisites

easy-host runs on a Linux host that is already prepared for rootless containers. This guide lists every prerequisite, the command that proves it on your host, and the check that enforces it — a `doctor` check where one exists, and the `add`/`update` preflight for the per-app port rule. Run the checks before the first `add`; a missing prerequisite fails during `doctor` instead of after a long build.

The command that checks the host before the first `add` is:

```sh
easy-host doctor
```

`doctor` exits `0` when every check passes or warns, and exits `2` when any check fails. Each failing line is followed by a `next:` remediation. It reads only local state and never installs or downloads anything. The full check list and its output contract are in the [CLI reference](../reference/cli.md#doctor) and in `src/doctor/index.ts`.

## Summary

| Prerequisite | Required value | Verify with | Doctor check |
| --- | --- | --- | --- |
| Rootless Podman | `>= 5.7.0, < 6.0.0` | `podman --version` and `podman info --format '{{.Host.Security.Rootless}}'` | `podman`, `podman-rootless` |
| User lingering | `Linger=yes` for the owning user | `loginctl show-user "$USER" -p Linger` | `linger` |
| Boot replay unit | `podman-restart.service` enabled | `systemctl --user is-enabled podman-restart.service` | `boot-restart` |
| git | 2.40 or newer | `git --version` | `git` |
| Node.js | 24 or newer | `node --version` | `node` |
| Docker-compatible image loader | `docker --version` succeeds | `docker --version` | `docker-loader` |
| One free host port per app | 1024 to 65535, unused, unique per app | `ss -ltnH "sport = :8080"` (empty output means free) | None by design (no host-wide check); the `add` and `update` preflight validates it |
| Free disk space | 2 GiB minimum; 5 GiB recommended | `df -h "$HOME"` | `disk` |

The remaining doctor checks, `railpack` and `buildkit`, cover the build tooling that easy-host installs on first use. They are described under [Other doctor checks](#other-doctor-checks).

If you set `EASY_HOST_HOME` to a directory on another filesystem, measure that filesystem with `df -h "$EASY_HOST_HOME"`; the `disk` doctor check always measures the filesystem that actually holds the state root.

## Rootless Podman

easy-host requires **rootless** Podman in the range `>= 5.7.0, < 6.0.0`. Run easy-host as your normal user, never with `sudo`: a rootful Podman is unsupported even when its version is in range.

### Check the host

```sh
podman --version
podman info --format '{{.Host.Security.Rootless}}'
```

The first command must print `5.7.0` or newer in the 5.x line. The second must print `true`.

- `podman` is the doctor check for presence and version. It fails when Podman is missing, below `5.7.0`, or at or above `6.0.0`. When it can read a version, it names the found version and the supported range.
- `podman-rootless` is the doctor check for rootless mode. It fails when `podman info` reports `false` or the call fails, and tells you to run as a normal user. When Podman itself is missing, this check is skipped because the `podman` check has already failed.

`5.7.0` and `5.8.9` rootless are covered by the doctor unit tests; the v0.1.0 release gate ran `5.7.0` rootless. Any later 5.x release is accepted, because the upper bound is the exclusive `6.0.0`.

### Why 4.9 and 6.x are excluded

- **Podman 4.9.3 is out of security support** and is the package shipped by stock Ubuntu 24.04 and Debian 12. Supporting it would mean owning rootless BuildKit defects on an unmaintained runtime, so it is below the hard minimum. This is the platform finding recorded in the [architecture note](../ARCHITECTURE.md#build-layer).
- **Podman 6.x is excluded while that major line is unstable.** The supported window stops at `6.0.0` (exclusive). A 6.x host is rejected even if the version number looks newer. Re-entering 6.x requires a stable release and a passing rootless BuildKit spike, so there is no flag, environment variable, or config key that opts in early. `doctor` reports the found version and a downgrade starting point.
- **Every version below 5.7.0 fails**, including 4.9.3. `doctor` exits `2` and names both the found version and `>= 5.7.0, < 6.0.0`.

### Upgrade from Podman 4.9 on Ubuntu 24.04

Ubuntu 24.04's archive carries Podman 4.9.3, which fails the minimum. Doctor's Ubuntu remediation names two starting points: the newest Podman 5.8.x package from Ubuntu 25.04+ or the upstream Podman PPA. The goal is to replace 4.9.3 with 5.7.0 or newer in the 5.x line, then prove it with `podman --version`. The exact 5.x version in a distribution point release is not pinned by easy-host, so verify it after the upgrade rather than assuming it.

1. Record what you are leaving:

   ```sh
   podman --version
   # podman version 4.9.3
   ```

2. Move the host to a source that carries 5.7.0 or newer. Either upgrade the Ubuntu release to a currently supported release at or above the doctor's named floor (25.04), or add the upstream Podman PPA using that PPA's own published instructions for your release. Do not point `apt` at a source this guide has not named.

3. With the newer source configured, upgrade the package:

   ```sh
   sudo apt update
   sudo apt install --only-upgrade podman
   ```

4. Verify the result and re-run doctor:

   ```sh
   podman --version
   podman info --format '{{.Host.Security.Rootless}}'
   easy-host doctor
   ```

If step 4 lands on a 6.x release, stop and downgrade to the newest 5.8.x package from the same source. easy-host will not accept 6.x. If the named source still installs a version below 5.7.0, that source does not satisfy the prerequisite; use the upstream Podman packages for your distribution instead of assuming the distro release is enough.

This upgrade was not replayed on this project's release-gate host; that host already ran Podman 5.7.0. The source choices above are the ones the `doctor` remediation names. The verification steps are the part you must run yourself.

### Upgrade from Podman 4.9 on Debian 12

Debian 12's archive also carries Podman 4.9.3. Doctor's Debian remediation names Debian 13 (trixie) or newer as the starting point. The goal is the same: replace 4.9.3 with 5.7.0 or newer in the 5.x line and prove it with `podman --version`.

1. Record what you are leaving:

   ```sh
   podman --version
   # podman version 4.9.3
   ```

2. Upgrade the host to Debian 13 (trixie) or newer, the starting point the doctor names, then check the version its archive actually provides.

3. Install the newer package and verify:

   ```sh
   sudo apt update
   sudo apt install --only-upgrade podman
   podman --version
   podman info --format '{{.Host.Security.Rootless}}'
   easy-host doctor
   ```

There is no documented in-place path for staying on Debian 12: its own package is 4.9.3 and no Debian 12 backport of Podman 5.7 was verified for this release. Do not install an unverified third-party package to avoid the distro upgrade. If Debian 13's archive still installs a version below 5.7.0, use the upstream Podman packages for Debian instead.

### If you are already on Podman 6.x

`doctor` fails the `podman` check with the found 6.x version and tells you to downgrade to the newest 5.8.x package. That is intentional: the support window is `>= 5.7.0, < 6.0.0`, and the build layer has not been spiked against a stable 6.x line. Downgrade rather than looking for an override.

## User lingering

Lingering is **mandatory**, not a convenience. Without it, systemd does not start a user manager for your account at boot, so no user unit runs. `podman-restart.service` is a user unit, so a container with `--restart=always` does not come back after a reboot; the app stays down until you log in or start it by hand.

### Check and enable

```sh
loginctl show-user "$USER" -p Linger
```

Expected output: `Linger=yes`. If it prints `Linger=no`, enable it once:

```sh
sudo loginctl enable-linger "$USER"
```

Re-run the same `loginctl` command to confirm. The `linger` doctor check fails when lingering is disabled and prints the enable command.

### Confirm the boot replay unit

Lingering starts your user manager; it does not by itself restart containers. Podman ships `podman-restart.service`, which replays `--restart=always` containers at user-manager start. easy-host enables that unit during `add`, and the `boot-restart` doctor check reports whether it is currently enabled:

```sh
systemctl --user is-enabled podman-restart.service
```

Expected output: `enabled`. If it is not enabled, enable it directly:

```sh
systemctl --user enable --now podman-restart.service
```

`add` enables this unit when it creates an app; re-running `add` for an app that already exists is rejected with a conflict, so use the direct `systemctl` command above for an existing app.

The consequence of skipping both steps is the same: the app is healthy before the reboot and absent afterwards, with no easy-host command involved. Scenario 2 in the v0.1.0 gate record (`docs/operations/release-gate-v0.1.0.md`) is the verified reboot case with `Linger=yes` and the unit enabled.

## git 2.40 or newer

easy-host clones and fetches your repository with the system `git`, using your existing SSH agent or git credential helper for private repositories.

```sh
git --version
```

The reported version must be `2.40` or newer. The `git` doctor check fails below 2.40, reports the found version, and tells you to install git 2.40 or newer with your package manager. easy-host does not bundle git, prompt for credentials, or manage a credential store; it uses your existing SSH agent or git credential helper.

## Node.js 24 or newer

```sh
node --version
```

The reported major version must be `24` or newer. The package declares `engines.node >= 24`, and the `node` doctor check fails an older runtime with the found version. Install Node.js 24 or newer with your chosen package manager before `npm install -g`.

Keep the install location in mind for scheduled updates: a systemd user unit does not inherit your shell `PATH`, and `easy-host` starts with `#!/usr/bin/env node`. If Node.js is installed outside `/usr/bin` or `/usr/local/bin`, the unit must include its `bin` directory in `PATH`; the [systemd timer guide](systemd-timer.md) shows how.

## A host port at or above 1024

Each app declares exactly one host TCP port. The supported range is **1024 to 65535**, and a port may belong to only one app regardless of bind address.

Rootless Podman cannot bind a port below 1024 without a host-wide sysctl change, which easy-host does not make. A privileged port is therefore unsupported, not merely discouraged.

### Choose and verify a port

```sh
PORT=8080
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] && echo "port range ok"
ss -ltnH "sport = :$PORT"
```

The first line prints `port range ok` when the number is eligible. The `ss` command prints nothing when the port is free; any output means another process is listening. Pick another free port in range if it is occupied.

### How the port rule is enforced

`doctor` has no host-wide port check by design: a port is claimed only when an app is added, and another process can take it afterwards. The equivalent enforcement is the preflight in `add` and `update`, which runs before any container is created:

- A port below 1024 or above 65535 exits `1` with code `INVALID_PORT`, naming the port and the allowed range.
- A port already declared by another app exits `6` with code `PORT_CONFLICT`, naming the other app and its bind address.

If `add` reports `PORT_CONFLICT`, choose another port with `--port` or change the existing app with `easy-host config <app> --edit`. Do not stop the other app just to reuse its port.

## Docker-compatible image loader

Railpack finishes a build by exporting the image through `docker load`. A host with Podman but no `docker` command fails at the end of a full build, so doctor checks for the loader up front.

```sh
docker --version
```

The `docker-loader` doctor check passes when this command succeeds. On Ubuntu, the v0.1.0 gate host used the `podman-docker` package to provide the shim; without it every build stalled at the export step. The doctor remediation names `sudo apt install podman-docker` for Ubuntu and Debian, but this project verified that package only on its Ubuntu gate host. On any other distribution, check that `docker --version` runs before starting a build.

## Other doctor checks

These checks are part of `easy-host doctor`; none of them requires an install step of its own.

| Check | What it verifies | How to verify |
| --- | --- | --- |
| `railpack` | The pinned Railpack `0.43.0` executable is present, executable, and reports the pinned version. The first build downloads it to `<state-root>/tools/railpack`; an existing binary can be selected with `EASY_HOST_RAILPACK_BIN`. | `easy-host doctor` |
| `buildkit` | The managed BuildKit socket at `<state-root>/buildkit/socket/buildkitd.sock` accepts a connection. Doctor never starts the daemon. | `easy-host doctor` |
| `disk` | Free space on the filesystem holding the state root. Doctor warns below 5 GiB and fails below 2 GiB. | `df -h "$HOME"` and `easy-host doctor` |

The state root is `$EASY_HOST_HOME` when set, otherwise `$XDG_DATA_HOME/easy-host`, otherwise `~/.local/share/easy-host`, created with mode `0700`.

## What was verified on this project's hosts

The v0.1.0 release gate ran on Ubuntu 26.04.1 LTS (aarch64) with Podman `5.7.0` rootless, `Linger=yes`, Node.js `24.22.2`, and git `2.53.0`; `easy-host doctor` reported 10 passed, 0 warnings, 0 failed, 0 skipped. The commands, exit codes, and output are recorded in the [v0.1.0 release-gate record](release-gate-v0.1.0.md).

Not verified by this project: an in-place upgrade from Podman 4.9.3 on Ubuntu 24.04 or Debian 12; a real Podman 5.8.x host (only the doctor unit tests cover 5.8.9); and `podman-docker` on any distribution other than the Ubuntu gate host. The steps above are an explicit path, not a claim that every package version was exercised here.

## Next steps

- Install easy-host and run the five-command [quickstart](../../README.md#quickstart).
- Schedule recurring updates with a [systemd user timer](systemd-timer.md).
- Read the full check and remediation contract in the [CLI reference](../reference/cli.md#doctor).
- Read the pinned build tooling in the [architecture note](../ARCHITECTURE.md#build-layer).
