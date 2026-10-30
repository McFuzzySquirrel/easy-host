# Migration from react-hoster to easy-host

The project is now **easy-host**; the previous name was **react-hoster**. The repository is still named `react-hoster` in this checkout. Renaming the repository is a manual step outside this work, so the clone URL and directory name do not change until it is performed by hand. This note does not claim that the repository rename has happened.

The [README](../README.md) is the current operator entry point, the [product definition](PRD.md) is the authoritative scope, and the [version history](PRD.md#2-version-history) records the Podman re-baseline in v1.1.

## What the old README claimed

The old README contained only:

> # react-hoster
>
> A podman container you can load your react app in and self host

It described a Podman container for a React app. It did not document an install command, a binary name, a supported-stack list, a config file or location, host prerequisites, updates, rollback, or volume handling.

## What an existing user must change

| Area | Old README | easy-host |
| --- | --- | --- |
| Install command | Not documented | Clone the repository and run `npm install`, then `npm install -g .`, with Node.js 24 or newer. See [Install](../README.md#install). |
| Binary name | `react-hoster` appeared only as the project heading; no command was documented | `easy-host`, for example `easy-host doctor`. |
| Config location | Not documented | `<state-root>/apps/<app>/config.toml`, where the state root is `$EASY_HOST_HOME`, else `$XDG_DATA_HOME/easy-host`, else `~/.local/share/easy-host`. See [Location](reference/config.md#location). |
| Podman minimum | Not stated | Rootless Podman `>= 5.7.0, < 6.0.0`; the 6.x line is excluded while it is unstable and must be downgraded. See [Host prerequisites](operations/prerequisites.md#rootless-podman). |

The old README documented no on-disk state, so there is no automatic conversion step to run. Start new apps with `easy-host add` so they are recorded in the state root above.

## Behavior that differs

- easy-host is a CLI for a git repository, not a React-only container. Only Vite/React, Node/Express, and Python/FastAPI are claimed as supported; see [Supported stacks](../README.md#supported-stacks).
- Updates are health-gated, the last two images are kept for rollback, and `remove` never deletes a named volume unless `--volumes` is passed. See the [CLI reference](reference/cli.md) and [Volume safety](../README.md#volume-safety).
- easy-host ships no daemon, scheduler, webhook receiver, TLS terminator, or reverse proxy. A schedule is a systemd user timer that calls `easy-host update`; see [Scheduled updates](operations/systemd-timer.md).
