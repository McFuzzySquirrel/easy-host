# CLI reference

`easy-host` is a Linux CLI for running a git repository as a long-running service under rootless Podman. This page is the complete command, flag, argument, and exit-code reference. It is checked against the built commander program by `tests/docs/reference.test.ts`, so a command or flag that is added to the CLI without a matching entry here fails the test suite.

The supported host range, the lingering requirement, and the port floor are in [Host prerequisites](../operations/prerequisites.md). The `config.toml` keys are in the [configuration reference](config.md). The module layout behind these commands is in the [architecture note](../ARCHITECTURE.md#module-map).

## Synopsis

```text
easy-host <command> [arguments] [options]
```

There are exactly ten commands: `add`, `list`, `status`, `logs`, `update`, `rollback`, `remove`, `config`, `doctor`, and `version`. There is no `start`, `stop`, `restart`, `prune`, `completion`, or `daemon` command, and easy-host ships no scheduler, webhook receiver, TLS terminator, or reverse proxy.

The host baseline is rootless Podman `>= 5.7.0, < 6.0.0` (6.x is excluded while that major line is unstable), user lingering enabled with `sudo loginctl enable-linger "$USER"`, git 2.40 or newer, Node.js 24 or newer, and one free host port per app in the range 1024 to 65535. Privileged ports are unsupported.

| Command | Purpose | Mutates host state |
| --- | --- | --- |
| [`add`](#add) | Clone or register an app, build it, and start its container | Yes |
| [`list`](#list) | List registered apps in one table | No |
| [`status`](#status) | Show one app or every app in detail | No |
| [`logs`](#logs) | Stream an app's container logs | No |
| [`update`](#update) | Rebuild or recreate an app behind a health gate | Yes |
| [`rollback`](#rollback) | Swap back to the previous image | Yes |
| [`remove`](#remove) | Delete an app, keeping volumes unless asked | Yes |
| [`config`](#config) | Show, validate, or edit an app's configuration | No (the editor writes the file) |
| [`doctor`](#doctor) | Check the host prerequisites | No |
| [`version`](#version) | Print the easy-host version | No |

Commands without a mutating effect never take the app lock. Each mutating command takes the per-app lock and exits `6` when another easy-host process holds it.

## Global options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--json` | none | off | Write one machine-readable JSON document to stdout. Accepted before or after any command. `list`, `status`, `config`, `doctor`, and `version` always emit a `schemaVersion: 1` success document. `add`, `update`, `rollback`, and `remove` emit the `schemaVersion: 1` error envelope on failure but keep their human success summary. `logs` is a passthrough and ignores `--json`. |
| `-h`, `--help` | none | off | Print help for the program or for one command, then exit `0`. |

Machine-readable results go to stdout. Progress, warnings, and human error text go to stderr, so `--json` output can be piped. Human output contains no ANSI escapes when stdout is not a terminal, when `NO_COLOR` is set, or when `TERM=dumb`; status meaning is always carried by text, never by colour alone.

## Exit codes

Every expected failure maps to one code. Unexpected exceptions exit `7` with a bug-report hint instead of a raw stack trace. Set `EASY_HOST_DEBUG=1` to include diagnostics and the stack trace.

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | success | The command completed. A no-op `update` is still success. |
| `1` | usage | Invalid arguments, invalid or missing configuration, a missing required flag, or a rejected flag combination. |
| `2` | prerequisite | A missing or unusable host prerequisite: Podman, rootless mode, lingering, git, Node.js, disk, state root, or the container runtime. |
| `3` | build | A clone, Railpack, or BuildKit failure. |
| `4` | health | A readiness probe failed, or `status` found an app that is unhealthy, stopped, or missing. |
| `5` | not found | The requested app, image, config file, or container does not exist. |
| `6` | conflict | A name, port, or volume conflict, or another process holds the app lock (`LOCK_HELD`). |
| `7` | internal | An unexpected exception. Re-run with `EASY_HOST_DEBUG=1` and report it. |

The human error block has three parts: a one-line summary, indented details, and a `next:` remediation command. Secret values and URL credentials are redacted in both human and JSON output.

## Commands

### add

Create an app from a git repository or a local workspace, build its image, create its named volumes, start its container with `--restart=always`, and wait for the readiness probe.

```text
easy-host add [git-url] [options]
```

#### Arguments

| Argument | Required | Meaning |
| --- | --- | --- |
| `git-url` | No, unless `--local` is omitted | HTTPS, SSH, git, `git+ssh`, or `file://` repository URL, or an scp-style `user@host:path` remote. In an interactive terminal, omitting both sources prompts for one; a non-interactive run fails with exit `1`. |

Exactly one of `git-url` and `--local` must be supplied. Supplying both is a usage error.

#### Options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--local <path>` | path | none | Add a local workspace in place instead of cloning a repository. Local mode is dev-only and is not tracked by easy-host. |
| `--name <app>` | string | derived from the source basename | App name. Must match `^[a-z0-9][a-z0-9-]{0,31}$`; an existing name is a conflict (`6`). |
| `--ref <ref>` | string | `main` | Git branch, tag, or commit to build. Ignored in local mode. |
| `--port <port>` | integer | required, no default | Host port to publish. Must be 1024 to 65535 and unused by another app. |
| `--container-port <port>` | integer | `3000` | Container port the app listens on. Must be 1024 to 65535. |
| `--bind <addr>` | `0.0.0.0`, `127.0.0.1`, or `::` | `0.0.0.0` | Address the published host port binds to. |
| `--env-file <path>` | path | `secrets.env` | App-relative environment file. Must stay inside the app directory and contain no `..` segment. |
| `--health-path <path>` | HTTP path | `/` | Path requested by the readiness probe. Must start with `/`. |
| `--probe <http\|tcp>` | `http` or `tcp` | `http` | Readiness probe type. |
| `--volume <name:container-path>` | `name:path` | none | Named volume to mount. Repeatable. The name must match `^[a-z0-9][a-z0-9-]{0,31}$` and the container path must be absolute and not `/`. |
| `--yes` | none | off | Never prompt. A missing required value fails with exit `1` instead of asking. |
| `--json` | none | off | Write the JSON error envelope on failure; success keeps the human summary. |

The readiness probe allows 90 seconds by default, with a 2-second interval and a 5-second per-attempt timeout. These values come from `health_startup_ms`, `health_interval_ms`, and `health_timeout_ms` in `config.toml`.

#### Examples

```sh
easy-host add https://github.com/your-org/blog.git --name blog --port 8080 --yes
easy-host add https://github.com/your-org/blog.git --ref v1.2.0 --port 8080 --volume data:/var/lib/data --yes
easy-host add --local ../blog --name blog --port 8081 --probe tcp
```

#### Exit codes

| Code | When |
| --- | --- |
| `0` | The app is running and the probe succeeded. |
| `1` | Invalid or missing input, invalid config, privileged or duplicate port, invalid name, or a bad volume declaration. |
| `2` | A host prerequisite or container runtime check failed. |
| `3` | The clone, Railpack build, or BuildKit export failed. |
| `4` | The container started but the readiness probe failed. The container is removed and the image and app directory are kept. |
| `6` | The app name, container name, volume name, or port is already claimed, or another process holds a lock. |

### list

List every registered app in one table. `list` is a survey: a broken app directory, a missing container, or an unhealthy app is shown in the table and does not fail the command.

```text
easy-host list [options]
```

#### Arguments

None.

#### Options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--json` | none | off | Write the `schemaVersion: 1` list document, including `apps`, `drift`, and per-app `error`. |

#### Examples

```sh
easy-host list
easy-host list --json
```

#### Exit codes

| Code | When |
| --- | --- |
| `0` | The registry was read and the table printed, even when rows are broken or unhealthy. |
| `1` | An invalid option or argument was supplied. |
| `2` | A Podman inspect failed, so the affected row could not be classified. |

### status

Show one app's configuration, source, images, container state, volumes, last health result, and drift. Without an app name, print the same block for every app.

```text
easy-host status [app] [options]
```

#### Arguments

| Argument | Required | Meaning |
| --- | --- | --- |
| `app` | No | App name. Omit to show every registered app. An unknown name exits `5`. |

#### Options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--json` | none | off | Write the `schemaVersion: 1` status document. Env values are redacted; timestamps are ISO 8601 UTC. |

#### Examples

```sh
easy-host status blog
easy-host status
easy-host status blog --json
```

#### Exit codes

| Code | When |
| --- | --- |
| `0` | Every requested app is healthy or has never been probed but is running. |
| `1` | An invalid option or argument was supplied. |
| `2` | A Podman inspect failed. |
| `4` | The requested app is unhealthy, stopped, or missing. |
| `5` | The named app is not registered. |

### logs

Stream an app's container logs. This is a direct `podman logs` passthrough: easy-host does not parse, filter, or store a copy.

```text
easy-host logs <app> [options]
```

#### Arguments

| Argument | Required | Meaning |
| --- | --- | --- |
| `app` | Yes | App name. |

#### Options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `-f`, `--follow` | none | off | Follow new output instead of printing the tail and exiting. |
| `--tail <n>` | integer | `200` | Lines to show before following. Must be a whole number from 0 to 1000000. |

`--json` is accepted as a global option but has no effect on `logs`.

#### Examples

```sh
easy-host logs blog
easy-host logs blog --tail 100
easy-host logs blog -f
```

#### Exit codes

| Code | When |
| --- | --- |
| `0` | Podman returned success. |
| `1` | `--tail` was not a whole number in range. |
| `2` | The container runtime could not be started or inspected. |
| `5` | The app's container does not exist. |

A nonzero Podman exit status is returned unchanged, so `logs` can also return a code outside this taxonomy when Podman itself does.

### update

Fetch the configured ref, rebuild only when the source or build inputs changed, recreate for configuration-only changes, and health-gate the swap. A failed candidate is stopped and the previous image is restarted.

```text
easy-host update <app> [options]
```

#### Arguments

| Argument | Required | Meaning |
| --- | --- | --- |
| `app` | Yes | App name. |

#### Options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--rebuild` | none | off | Force an image build even when the diff classifies the change as a no-op or config-only. |
| `--json` | none | off | Write the JSON error envelope on failure; success keeps the human summary. |

#### Examples

```sh
easy-host update blog
easy-host update blog --rebuild
```

#### Exit codes

| Code | When |
| --- | --- |
| `0` | The update, configuration-only recreate, or no-op completed and the app serves. |
| `1` | The app name or configuration is invalid. |
| `2` | A host prerequisite, container runtime, or environment check failed. |
| `3` | The clone or candidate build failed; the old container is untouched. |
| `4` | The candidate failed its probe; the previous image was restarted and the state records `reverted`. |
| `5` | The app is not registered. |
| `6` | Another process holds the app lock, or a port or volume conflict exists. |

### rollback

Swap the current and previous images, probe the restored image, and make the image it left the new rollback target. A second `rollback` therefore returns to the newer image.

```text
easy-host rollback <app> [options]
```

#### Arguments

| Argument | Required | Meaning |
| --- | --- | --- |
| `app` | Yes | App name. Rollback requires a recorded current and previous image. |

#### Options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--json` | none | off | Write the JSON error envelope on failure; success keeps the human summary. |

#### Examples

```sh
easy-host rollback blog
```

#### Exit codes

| Code | When |
| --- | --- |
| `0` | The restored image serves and the pair was recorded. |
| `1` | The app name or configuration is invalid. |
| `2` | A host prerequisite or container runtime check failed. |
| `4` | The restored image failed its probe; the image it was leaving was restarted. |
| `5` | The app is not registered, or it has fewer than two distinct recorded images. |
| `6` | Another process holds the app lock. |

### remove

Delete an app's container, images, workspace, and app directory. Named volumes are kept unless `--volumes` is passed. A non-interactive `remove` without `--yes` or `--force` fails with exit `1` before deleting anything.

```text
easy-host remove <app> [options]
```

#### Arguments

| Argument | Required | Meaning |
| --- | --- | --- |
| `app` | Yes | App name. |

#### Options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--volumes` | none | off | Also delete the named volumes labelled for this app. Only volumes whose `io.easy-host.app` label equals the app are deleted; a host filesystem path is never deleted. |
| `--yes` | none | off | Confirm non-interactively. |
| `--force` | none | off | Skip confirmation prompts. It does not imply `--volumes`. |
| `--json` | none | off | Write the JSON error envelope on failure; success keeps the human summary. |

Without `--volumes`, the summary lists the retained volumes and the exact `podman volume rm` command that would delete each one.

#### Examples

```sh
easy-host remove blog --yes
easy-host remove blog --volumes --yes
easy-host remove blog --force
```

#### Exit codes

| Code | When |
| --- | --- |
| `0` | The app's unrequested resources were deleted and any retained volumes were reported. |
| `1` | The app name is invalid, confirmation was refused or cancelled, or a path safety check failed. |
| `2` | A Podman operation or filesystem deletion failed. |
| `5` | The app is not registered. |
| `6` | Another process holds the app lock. |

### config

Show or edit one app's `config.toml`. With no mode flag, print the path, validate the file, and print a short summary. `config` never applies the change itself; run `update` afterwards.

```text
easy-host config <app> [options]
```

#### Arguments

| Argument | Required | Meaning |
| --- | --- | --- |
| `app` | Yes | App name. |

#### Options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--path` | none | off | Print only the app's config file path. |
| `--edit` | none | off | Open the file in `$EDITOR`, wait for the editor to exit, then validate it. A missing or failing editor exits `1` or `2`. |
| `--json` | none | off | Write the `schemaVersion: 1` config document with every `[env]` value redacted. |

`--path`, `--edit`, and `--json` are mutually exclusive; passing more than one exits `1` with `INVALID_FLAG_COMBINATION`.

#### Examples

```sh
easy-host config blog
easy-host config blog --path
EDITOR="vim" easy-host config blog --edit
easy-host config blog --json
```

#### Exit codes

| Code | When |
| --- | --- |
| `0` | The path was printed, the file validated, or the JSON document was written. |
| `1` | The app name is missing, the flag combination is invalid, the configuration is invalid or missing, or `EDITOR` is not set. |
| `2` | The editor could not start or exited nonzero. |
| `5` | The app is not registered, or the config file requested by `--path` does not exist. |

### doctor

Check the host prerequisites in order: Podman, rootless mode, a Docker-compatible image loader, lingering, boot replay, git, Node.js, Railpack, BuildKit, and disk. Every failing check prints a remediation command. `doctor` never starts a daemon or installs software.

```text
easy-host doctor [options]
```

#### Arguments

None.

#### Options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--json` | none | off | Write the `schemaVersion: 1` doctor document with the ordered `checks` array and the additive `disk` object. |

#### Examples

```sh
easy-host doctor
easy-host doctor --json
```

#### Exit codes

| Code | When |
| --- | --- |
| `0` | Every check passed, warned, or was skipped. |
| `2` | At least one check failed. |

### version

Print the easy-host package version.

```text
easy-host version [options]
```

#### Arguments

None.

#### Options

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--json` | none | off | Write the `schemaVersion: 1` version document with `name` and `version`. |

#### Examples

```sh
easy-host version
easy-host version --json
```

#### Exit codes

| Code | When |
| --- | --- |
| `0` | The version was printed. |
| `7` | The package manifest could not be read. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `EASY_HOST_HOME` | State-root override. When set and non-empty, it replaces the XDG and home fallbacks. |
| `XDG_DATA_HOME` | Base for the state root when `EASY_HOST_HOME` is unset. The root becomes `$XDG_DATA_HOME/easy-host`. |
| `EASY_HOST_DEBUG=1` | Include diagnostics and a stack trace for an unexpected error. Secret values remain redacted. |
| `EASY_HOST_NO_PROMPT=1` | Treat the session as non-interactive even when stdin is a terminal. |
| `EASY_HOST_RAILPACK_BIN` | Use a Railpack binary you provide instead of the pinned managed download. |
| `EDITOR` | Editor command used by `easy-host config <app> --edit`. Quotes group arguments, for example `EDITOR="code --wait"`. |
| `NO_COLOR` | Disable colour when set to a non-empty value. `TERM=dumb` also disables colour. |

The state root is `$EASY_HOST_HOME` when set, otherwise `$XDG_DATA_HOME/easy-host`, otherwise `~/.local/share/easy-host`. It is created with mode `0700`.

## Related documentation

- [Configuration reference](config.md) for every `config.toml` key, default, and validation rule.
- [Host prerequisites](../operations/prerequisites.md) for the Podman support window, lingering, git, Node.js, and ports.
- [Scheduled updates](../operations/systemd-timer.md) for a user timer that calls `update`.
- [Architecture](../ARCHITECTURE.md#output) for the JSON document fields and TTY rules.
- [Architecture](../ARCHITECTURE.md#module-map) for the module layout and the drift tests.
