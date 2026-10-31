# User Guide

This guide is for the person who registers and operates apps with easy-host. It covers the day-to-day workflows: adding an app, checking it, updating it, rolling it back, editing its configuration, and deleting it. Host preparation and hardening are in the [Administrator Guide](admin-guide.md); every flag and exit code is in the [CLI reference](reference/cli.md).

## Who This Is For

You have a repository that builds into an HTTP service, and you have already been given access to a Linux host that runs easy-host. You want the app to keep serving without writing a Dockerfile, a systemd unit, or a container command by hand.

You do **not** need root. You do need to be the operating-system user who owns the easy-host state root, because every command resolves state under that user's home or `EASY_HOST_HOME`.

If you are the person who installs Podman, enables lingering, and owns the host, read the [Administrator Guide](admin-guide.md) first.

## Before You Begin

1. Confirm the CLI is installed and the host is ready:

   ```sh
   easy-host version
   easy-host doctor
   ```

   `doctor` exits `2` when a prerequisite fails and prints a remediation command for each failing check. Do not start an `add` until it exits `0`.

2. Know the repository URL and the ref you want to deploy. The ref defaults to `main`; a branch, tag, or commit is accepted.

3. Choose a free host port at or above `1024`. It must not already be declared by another app, even on a different bind address.

4. Decide whether the app needs persistent data. If it does, plan a named volume and its container path now; adding one later is a configuration change followed by `update`.

5. Check the stack is supported. The claimed stacks are Vite/React static sites, Node/Express, and Python/FastAPI. Railpack may detect others, but that is not a support promise.

## Sign In and First Use

**Not applicable.** easy-host has no accounts, sign-in, or remote service. Your identity is the operating-system user running the command, and all state is local.

First use is registering an app:

```sh
easy-host add https://github.com/your-org/blog.git --name blog --port 8080 --yes
```

`add` validates the name, port, and volumes before it clones or builds anything. It then clones the repository, builds an image, creates any declared volumes, starts the container with `--restart=always`, and waits for the readiness probe. On success it prints the app name, the URL, the image, the previous image (none on a first add), and the health result.

The app is reachable on the host's published address, by default `0.0.0.0:8080`. Use `--bind 127.0.0.1` when the host terminates TLS or proxies the app; the [Tailscale guide](operations/tailscale.md) is a worked example.

## Main Workflows

### See what is registered

```sh
easy-host list
easy-host status
easy-host status blog
```

`list` is a survey: an unhealthy, stopped, or broken app appears in the table without failing the command. `status` is the detailed view for one app, including configuration, images, container state, volumes, the last health result, and drift. `status` exits `4` when the named app is unhealthy, stopped, or missing, which makes it usable as a check in a script.

### Read the logs

```sh
easy-host logs blog
easy-host logs blog --tail 500
easy-host logs blog -f
```

`logs` is a direct `podman logs` passthrough. easy-host does not parse, filter, or retain a copy, and a nonzero Podman exit status is returned unchanged.

### Update to the configured ref

```sh
easy-host update blog
```

`update` fetches the configured ref, classifies the change, and acts on the classification:

| Classification | What happens |
| --- | --- |
| No-op | Nothing is rebuilt or recreated; the command exits `0`. |
| Configuration-only | The container is recreated with the same image; no build. |
| Rebuild | A candidate image is built, the old container is stopped, the candidate starts, and the probe decides. |

A candidate that fails to build exits `3` and leaves the old container untouched. A candidate that starts but fails its probe exits `4`, stops the candidate, restarts the previous image, and reports `state: reverted`. Because the app has one fixed port, the swap briefly stops serving.

Use `--rebuild` to force an image build even when the change would otherwise be a no-op or configuration-only.

### Roll back

```sh
easy-host rollback blog
```

`rollback` swaps the recorded current and previous images, probes the restored image, and makes the image it left the new rollback target. Running it a second time returns to the newer image. It never clones or builds. Rollback needs two distinct recorded images; with fewer, it exits `5`.

The rollback window is one step deep. If you need a version older than the previous image, set `ref` to that commit (or tag) in `config.toml` and run `update`, or keep your own image archive.

### Change configuration

```sh
easy-host config blog
easy-host config blog --path
easy-host config blog --edit
```

`config` prints, validates, or opens `<state-root>/apps/blog/config.toml`. It never applies the change itself: edit the file, then run `easy-host update blog`. A valid configuration is applied by `update`; an invalid one fails with exit `1` and names the offending key before anything is changed.

The keys, defaults, and validation rules are in the [configuration reference](reference/config.md). Values in `[env]` and the secrets file are never printed.

### Remove an app

```sh
easy-host remove blog --yes
```

`remove` deletes the container, workspace, app directory, and images. Named volumes are kept unless you pass `--volumes`, and the summary prints the exact `podman volume rm` command for each retained volume. `--force` skips confirmation but does not imply `--volumes`.

Run `easy-host remove blog --volumes --yes` only when you are certain the data is disposable. A host filesystem path is never deleted, and a volume whose `io.easy-host.app` label does not match the app is refused rather than deleted.

## Offline and Reconnect Behavior

**Not applicable as a client application.** easy-host has no session, account, or cache to resynchronise, and it does not run in the background.

Each command is a single process that reads the local state root and talks to Podman on the same host. `add` and `update` also reach the configured git remote and may pull the pinned build artifacts, so they need network access; a clone or build failure exits `3`. `list`, `status`, `config`, `logs`, `doctor`, and `version` work without network access as long as the local state and Podman are available.

There is no automatic retry. Re-run the command after fixing the cause; the per-app lock makes an overlapping run exit `6` instead of corrupting state.

## Statuses and Notifications

easy-host has no notifications, email, or webhooks. State is reported when you ask for it, and it is also recorded in `state.json` for `status` to read.

| Status | Meaning |
| --- | --- |
| `healthy` | The last readiness probe succeeded. |
| `unhealthy` | The last probe failed, or the container is stopped or missing. |
| `unknown` | The app has never been probed. |

`update` adds one outcome to its report: `reverted`, meaning the candidate failed and the previous image was restarted. The command still exits `4`, because the requested update did not succeed.

Every expected failure carries one of eight exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success, including a no-op update. |
| `1` | Usage: bad arguments, invalid or missing configuration. |
| `2` | Prerequisite or environment: a host check, runtime, or state-root problem. |
| `3` | Build: clone, Railpack, or BuildKit failed. |
| `4` | Health: a probe failed, or `status` found the app unhealthy, stopped, or missing. |
| `5` | Not found: the app, image, config file, or container does not exist. |
| `6` | Conflict: a name, port, or volume clash, or another process holds the lock. |
| `7` | Internal: an unexpected error; re-run with `EASY_HOST_DEBUG=1`. |

Add `--json` to `list`, `status`, `config`, `doctor`, or `version` for one machine-readable document with `schemaVersion: 1`. Progress and errors stay on stderr, so stdout can be piped.

## Attachments or Other Data

easy-host has no attachments. The data you manage is:

- **Named volumes**, declared at add time with `--volume name:container-path` or in the `[volumes]` table. They survive `update`, `rollback`, and `remove`, and are only deleted by `remove --volumes`.
- **Environment and secrets**, supplied through the `[env]` table and a secrets file (by default `secrets.env`, mode `0600`). Values are secret material: human output never prints them and JSON output replaces each value with `[redacted]`.
- **The app's source checkout**, kept under the app directory's `workspace/`. It is recreated from the remote; do not keep work there.

A volume belongs to one app. Two apps cannot mount the same named volume; a name owned by another app is a conflict (exit `6`).

## Accessibility and Mobile Use

**Mobile use is not applicable.** easy-host is a terminal CLI on the host. There is no web or mobile interface.

Terminal behaviour that matters:

- Status meaning is carried by text, never by colour alone.
- `NO_COLOR=1` or `TERM=dumb` disables colour; non-TTY output contains no ANSI escapes.
- Every prompt has a non-interactive path: pass `--yes` to `add` or `remove`, and set `EASY_HOST_NO_PROMPT=1` to force non-interactive mode.
- `--json` gives a stable, line-oriented document for screen readers, scripts, and piping.
- Errors are a summary line, indented details, and a `next:` remediation, in that order.

## Privacy and Data Handling

- easy-host sends no telemetry and calls no service of its own. The only network calls are to your git remote, the pinned Railpack release, and the container registry used by BuildKit.
- State stays under the state root: `EASY_HOST_HOME`, else `$XDG_DATA_HOME/easy-host`, else `~/.local/share/easy-host`, created with mode `0700`.
- Secrets are read from your secrets file and passed to the container environment. They are never written into `config.toml`, never printed, and never written to JSON output.
- Container logs come from your app and are passed through unchanged. easy-host stores no log copy, so retention and rotation are your app's or Podman's responsibility.
- Removing an app deletes its local directory and images. Exported data, backups, and volumes you keep are outside easy-host.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `add` exits `1` with `INVALID_PORT` | Port below `1024` or not a whole number | Choose a port from `1024` to `65535`. |
| `add` exits `6` with `PORT_CONFLICT` | Another app already declares that host port | Pick another port or change the existing app's configuration. |
| `add` exits `6` with `LOCK_HELD` | Another easy-host command is mutating the same app | Wait for it to finish; a stale lock is reclaimed when its process is gone. |
| `add` exits `4` | The container started but the readiness probe failed | Check `easy-host logs <app>`, confirm the app listens on the container port, and check `health_path`. |
| `update` exits `4` and reports `reverted` | The candidate failed and the previous image was restarted | The app is still serving; fix the candidate and update again. |
| `update` exits `3` | Clone or build failed | Check the ref exists and the repository builds locally; `EASY_HOST_DEBUG=1` adds diagnostics. |
| `status` exits `4` | The app is unhealthy, stopped, or missing | Read the status block, then `logs`; start or replace the container by fixing the cause and running `update`. |
| `logs` exits `5` | The container does not exist | Check `easy-host list`; the app may have failed its first probe and been removed. |
| A command exits `2` | Host prerequisite or environment problem | Run `easy-host doctor` and follow its remediation lines. |
| A command exits `7` | Unexpected internal error | Re-run with `EASY_HOST_DEBUG=1` and report it with the output. |

## Getting Help

1. Re-run the failing command with `--json` (for read commands) or `EASY_HOST_DEBUG=1` (for diagnostics) and capture the exit code.
2. Collect `easy-host version`, `easy-host doctor`, and, when relevant, `easy-host status <app>`.
3. Compare the exit code with the table above and with the [CLI reference](reference/cli.md#exit-codes).
4. Report the issue on the repository with the command, app name, expected result, observed output, exit code, and host facts (distribution, architecture, Podman version, Node version). Secret values, tokens, and URL credentials must be removed from the report.

Ownership and the intake process are in [Support](SUPPORT.md). If the problem is host-wide rather than app-specific, hand it to the host administrator with the [Administrator Guide](admin-guide.md).

## Related Documentation

- [CLI reference](reference/cli.md) for every command, flag, and exit code.
- [Configuration reference](reference/config.md) for every `config.toml` key and default.
- [Scheduled updates](operations/systemd-timer.md) for a timer that calls `update`.
- [Tailscale guide](operations/tailscale.md) for reaching an app from outside the LAN.
- [Architecture](ARCHITECTURE.md) for the modules behind these behaviours.
