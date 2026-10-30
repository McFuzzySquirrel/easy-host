# Scheduled updates with a systemd user timer

easy-host ships no daemon, no scheduler, no webhook receiver, and no git poller. If you want an app updated on a schedule, you write a systemd **user** timer that calls `easy-host update <app>`; the CLI does the fetch, build, health gate, swap, and retention exactly as it does from your shell.

This guide uses the app name `blog` and creates one service unit and one timer unit. Repeat the pair with a different unit name and app argument for each app you schedule.

## Before you start

1. Enable lingering for your user, so the user manager and its timers exist after a reboot. The consequence of skipping this is covered in [Host prerequisites](prerequisites.md#user-lingering).

   ```sh
   loginctl show-user "$USER" -p Linger
   ```

   Expected: `Linger=yes`.

2. Confirm the app is registered and healthy:

   ```sh
   easy-host status blog
   ```

   `status` exits `4` when the app is unhealthy, so a failing result here is worth fixing before you automate updates.

3. Resolve the two absolute paths the unit needs. A systemd user unit does **not** inherit your login shell's `PATH`, and `easy-host` is a Node script that starts with `#!/usr/bin/env node`:

   ```sh
   command -v easy-host
   command -v node
   dirname "$(command -v node)"
   ```

   Use the first path in `ExecStart` and add the directory from the third command to the unit's `PATH`. If `easy-host` came from a system-wide `npm install -g .`, it is commonly `/usr/local/bin/easy-host`; after `npm link` or a user-local npm prefix it is commonly `~/.local/bin/easy-host`.

4. If you set `EASY_HOST_HOME` in your shell, note its value. The unit does not inherit it; add it to the unit as shown below. If you never set it, the CLI uses `$XDG_DATA_HOME/easy-host` or `~/.local/share/easy-host`.

5. Run the timer as the same operating-system user that ran `add`. A systemd **user** unit runs under your uid, and each user resolves a different state root; pointing `EASY_HOST_HOME` at another user's state root (created with mode `0700`) makes `update` exit `2` because it cannot read or write that directory.

## Unit files

Create the directory and the two files under your user unit directory:

```sh
mkdir -p ~/.config/systemd/user
```

### `~/.config/systemd/user/easy-host-update-blog.service`

```ini
[Unit]
Description=Update the easy-host app "blog"

[Service]
Type=oneshot
WorkingDirectory=%h

# systemd user units do not inherit your login shell PATH. The first entry is
# the Node.js 24 directory used on the v0.1.0 gate host; replace it with the
# output of `dirname "$(command -v node)"` when Node lives elsewhere.
Environment=PATH=%h/.local/share/node24/bin:/usr/local/bin:/usr/bin:/bin

# Set this only when you exported EASY_HOST_HOME in your shell. The service
# does not inherit interactive-shell variables.
# Environment=EASY_HOST_HOME=%h/easy-host-state

# Use the absolute path from `command -v easy-host`. `%h` expands to your home
# directory. If your install is at /usr/local/bin/easy-host, write that instead.
ExecStart=%h/.local/bin/easy-host update blog
```

`Type=oneshot` is correct: `update` does its work and exits. Do not add a `Restart=` policy to this unit. A failed build or health probe (exit `3` or `4`) is a source or app problem, not a transient that a restart loop should retry every few seconds; the next scheduled run is the retry.

### `~/.config/systemd/user/easy-host-update-blog.timer`

```ini
[Unit]
Description=Daily update for the easy-host app "blog"

[Timer]
OnCalendar=daily
RandomizedDelaySec=15m
Persistent=true
Unit=easy-host-update-blog.service

[Install]
WantedBy=timers.target
```

- `OnCalendar=daily` is `*-*-* 00:00:00` in the host's local time zone. For a specific window, use a value such as `OnCalendar=*-*-* 04:30:00`.
- `RandomizedDelaySec=15m` spreads the start within a 15-minute window instead of hitting the host at exactly midnight.
- `Persistent=true` runs a missed update after a reboot or while the user manager was stopped.
- `Unit=` names the service above. The timer only schedules it.

## Enable and verify

Reload the user manager, enable the timer, and list it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now easy-host-update-blog.timer
systemctl --user list-timers easy-host-update-blog.timer
```

`list-timers` shows the next and last trigger times. Then prove the unit once by hand before waiting for the schedule:

```sh
systemctl --user start easy-host-update-blog.service
systemctl --user status easy-host-update-blog.service
systemctl --user show -p Result easy-host-update-blog.service
```

A successful oneshot reports `Active: inactive (dead)` with `status=0/SUCCESS`; that is normal, because the process is finished. `show -p Result` prints `Result=success`. The command's output is in the journal (see below).

## Where the output goes

Both streams from `easy-host update` are captured by the user journal: the progress phases (`update: fetching: ...`, `update: probing: ...`) that the CLI writes to stderr, and the final summary (`updated "blog" (rebuild)`, `url`, `image`, `health`) that it writes to stdout.

```sh
journalctl --user -u easy-host-update-blog.service
journalctl --user -u easy-host-update-blog.service -n 50
journalctl --user -u easy-host-update-blog.service -f
journalctl --user -u easy-host-update-blog.service --since "24 hours ago"
```

easy-host writes no log file of its own. The journal is the log location, and its retention is configured by journald on the host (a volatile journal is lost on reboot). Container output is separate: `easy-host logs blog --tail 200` is the `podman logs` passthrough for the app itself.

## Overlapping runs and the app lock

Every mutating command takes a per-app lock at `<state-root>/apps/blog/.lock`. Acquisition is non-blocking. If another `update`, `rollback`, or `remove` for `blog` is already running, the second process does no work at all: it exits **`6`** with code `LOCK_HELD`, names the holder's pid, start time, and operation, and leaves the running update alone. The lock file is created with mode `0600` and records only the holder's pid, start time, operation, and a random token; it holds no secrets. The lock is released on every exit path, and a lock left by a process that no longer exists is reclaimed automatically; you do not need to delete `.lock` by hand.

systemd will not start the same unit twice, but a second invocation can still overlap with it:

- a manual `easy-host update blog` from your shell;
- a second timer or unit that calls `update blog`;
- a `Persistent=true` catch-up run immediately after boot racing a manual start.

All of those cases are safe. The loser exits `6` instead of starting a second candidate image or swapping a container twice. Do not remove the lock to "fix" an overlap; wait for the holder to finish. If the message names a process that no longer exists, retry the command once: the next acquire reclaims the stale lock.

## What each exit code means for the timer

`update` uses the stable exit-code contract documented in the [CLI reference](../reference/cli.md#exit-codes). systemd records any nonzero result as a failed unit, so the number in the journal tells you whether the schedule, the host, the source, or the app needs attention.

| Exit | Meaning for `easy-host update blog` | What to do |
| --- | --- | --- |
| `0` | Success: the app was updated and is healthy, or nothing changed (a no-op). | None. For a git-backed app, a no-op still fetches the configured ref, so a scheduled run notices a moved commit. |
| `1` | Usage or validation failure: app name that fails the name pattern, unsupported flag, or invalid `config.toml`. | Fix the `ExecStart` line or the app configuration; the timer is misconfigured, not unlucky. |
| `2` | Prerequisite or environment failure: state root not writable, container engine unavailable, or the environment file could not be read. | Run `easy-host doctor`, fix the failing check, then retry once by hand. |
| `3` | Fetch or build failure. The serving container and `config.toml` were not touched. | Inspect the build output in the journal. Fix the commit or build inputs; the next scheduled run retries. |
| `4` | Readiness failure. The candidate did not become healthy; when a previous image exists, it is serving again with `state: reverted`. | Inspect `easy-host logs blog --tail 200` and the probe line in the journal. The previous version keeps serving. |
| `5` | App not found: `blog` was removed, renamed, or mistyped in `ExecStart`. | Disable the timer, or correct the app name in `ExecStart`. |
| `6` | Conflict or lock held: another mutation of `blog` is running, or a declared port or volume conflicts with another app. | If it coincides with another run, ignore it; the next trigger is fine. If it repeats with no overlapping run, inspect the error block for `PORT_CONFLICT`, `VOLUME_NAME_CONFLICT`, or `LOCK_HELD`. |
| `7` | Unexpected internal error. | Re-run with `EASY_HOST_DEBUG=1` in the unit environment and capture the journal output for a bug report. |

The human error block in the journal is the same one you see in a terminal: a summary line, structured detail lines, and a `next:` remediation. Use that remediation before changing the schedule.

## Disable or remove the schedule

Stop and disable the timer:

```sh
systemctl --user disable --now easy-host-update-blog.timer
```

Then delete the two unit files if you no longer need them and reload the user manager:

```sh
rm ~/.config/systemd/user/easy-host-update-blog.service
rm ~/.config/systemd/user/easy-host-update-blog.timer
systemctl --user daemon-reload
```

Disabling the timer does not remove the app, its container, its images, or its volumes. Use `easy-host remove blog` for that, and read [Volume safety](../../README.md#volume-safety) before adding `--volumes`.

## What this timer is not

- It is not an easy-host daemon, scheduler, webhook receiver, or git poller. Nothing runs between timer activations.
- It does not add a reverse proxy, TLS termination, or a monitoring service. Those remain your responsibility.
- It does not update every app. One unit pair per app keeps each failure and exit code attributable to one app; chaining several `easy-host update` calls inside one unit hides the first failure behind the wrapper's exit status.
