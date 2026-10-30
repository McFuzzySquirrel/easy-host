# Configuration reference

Each app is described by one TOML file at `<state-root>/apps/<name>/config.toml`. The file is written by `easy-host add` and can be edited by hand or with `easy-host config <app> --edit`. It is the authoritative definition of an app: `state.json` is only a rebuildable cache.

This page documents every key, type, default, and validation rule, the volumes table, and the environment precedence order. `tests/docs/reference.test.ts` imports `APP_SPEC_KEYS` and `APP_SPEC_DEFAULTS` from `src/config/schema.ts` and fails when a schema key or default is missing here (`DOC-FR-04`, `DOC-NF-01`).

The enclosing state root and file modes are covered in [Files and permissions](#files-and-permissions). Command behaviour is in the [CLI reference](cli.md).

## Location

The state root resolves in this order:

1. `EASY_HOST_HOME` when set and non-empty;
2. `$XDG_DATA_HOME/easy-host` when `XDG_DATA_HOME` is set;
3. `~/.local/share/easy-host`.

An app lives at `<state-root>/apps/<app>/` and contains:

| Entry | Purpose |
| --- | --- |
| `config.toml` | The validated app configuration documented on this page. |
| `secrets.env` | Optional secret values, by default. Selected by the `env_file` key. |
| `workspace/` | The cloned repository, or a local path used in place for a dev-only app. |
| `state.json` | Rebuildable cache of image references, health, and timestamps. Never authoritative. |

## Minimal config

```toml
# The repository is cloned at add time and fetched again by update.
repo = "https://github.com/your-org/blog.git"

# The only key with no default. Rootless Podman cannot publish below 1024.
port = 8080

# Optional, shown with their defaults:
ref = "main"
container_port = 3000
bind = "0.0.0.0"
probe = "http"
health_path = "/"

[volumes]
data = "/var/lib/data"

[env]
LOG_LEVEL = "info"
```

The file is parsed as TOML, then validated by the strict `AppSpec` schema. Unknown top-level keys, wrong types, out-of-range ports, unsupported bind addresses, unsafe paths, and invalid volume or environment names are rejected with the offending key named. Validation happens before any filesystem or container mutation.

## Keys

| Key | TOML type | Default | Validation rule |
| --- | --- | --- | --- |
| `repo` | string | none; one of `repo` or `local_path` is required | 1 to 2048 characters; `https://`, `http://`, `ssh://`, `git+ssh://`, `git://`, or `file://` URL, or an scp-style `user@host:path`; no whitespace or control characters; no embedded URL credentials (SSH usernames are allowed, passwords are not). |
| `local_path` | string | none; one of `repo` or `local_path` is required | 1 to 4096 characters; app-relative, not absolute, no `..` segment, no control characters. The path must exist and be a directory when `add` runs. |
| `ref` | string | `main` | 1 to 255 characters; valid git ref without whitespace, `..`, `//`, `\`, `@{`, a leading `-` or `/`, a trailing `/` or `.`, or a `.lock` suffix. |
| `port` | integer | required, no default | Whole number from 1024 to 65535. A privileged port is rejected with `INVALID_PORT`. A port already declared by another app is rejected with `PORT_CONFLICT` (exit `6`), regardless of bind address. |
| `container_port` | integer | `3000` | Whole number from 1024 to 65535. Injected into the container as `PORT`. |
| `bind` | string | `0.0.0.0` | One of `0.0.0.0`, `127.0.0.1`, or `::`. |
| `probe` | string | `http` | One of `http` or `tcp`. `http` expects a 2xx or 3xx response; `tcp` only requires the port to accept a connection. |
| `health_path` | string | `/` | Absolute HTTP path: must start with `/`, be at most 2048 characters, and contain no whitespace, backslash, control character, or `..` segment. |
| `health_interval_ms` | integer | `2000` | Whole number of milliseconds from 1 to 86400000. |
| `health_timeout_ms` | integer | `5000` | Whole number of milliseconds from 1 to 86400000. Bounds each probe attempt. |
| `health_startup_ms` | integer | `90000` | Whole number of milliseconds from 1 to 86400000. Total budget for the readiness probe before the app is declared unhealthy. |
| `env_file` | string | `secrets.env` | 1 to 4096 characters; app-relative, not absolute, no `..` segment, no control characters. A declared file that is missing is a usage error (exit `1`); an unreadable file is a prerequisite error (exit `2`). |
| `volumes` | table of string to string | `{}` (empty table) | Each key is a volume name matching `^[a-z0-9][a-z0-9-]{0,31}$`; each value is an absolute container path other than `/`, at most 4096 characters, with no `..` segment. See [Volumes](#volumes). |
| `env` | table of string to string | `{}` (empty table) | Each key must match `^[A-Za-z_][A-Za-z0-9_]*$`; each value must be a string. Values are secret material and are never printed or written to JSON output. See [Environment precedence](#environment-precedence). |

Exactly one of `repo` and `local_path` must be present. Supplying both, or neither, is a usage error. `port` is the only other required key; every other key has a default.

## Volumes

A named volume is declared in the `[volumes]` table as `name = "container-path"`. `easy-host add --volume name:container-path` writes the same table. The key is a logical name; easy-host expands it to a Podman volume name so two apps cannot collide.

| Config entry | App | Resulting Podman volume name | Container path | Ownership label |
| --- | --- | --- | --- | --- |
| `data = "/var/lib/data"` under `[volumes]` | `blog` | `easy-host-blog-data` | `/var/lib/data` | `io.easy-host.app=blog` |
| `uploads = "/srv/uploads"` under `[volumes]` | `blog` | `easy-host-blog-uploads` | `/srv/uploads` | `io.easy-host.app=blog` |
| `cache = "/data/cache"` under `[volumes]` | `api` | `easy-host-api-cache` | `/data/cache` | `io.easy-host.app=api` |

Rules that apply to every declared volume:

- The volume is created before the container starts, or reused when it already carries this app's `io.easy-host.app` label. A same-named volume owned by another app is a conflict (`VOLUME_NAME_CONFLICT`, exit `6`).
- Named volumes survive `update`, `rollback`, and `remove` by default. `easy-host remove <app>` reports each retained volume and the exact `podman volume rm` command.
- `easy-host remove <app> --volumes` deletes only volumes whose `io.easy-host.app` label equals the app. A name that merely matches the app pattern but has a missing or different label is refused, not deleted.
- A bind mount or host filesystem path is never deleted by any command. Only named volumes are in scope.
- Volume names and container paths are validated before any Podman call, so a bad declaration fails with exit `1` without creating anything.

`update` treats a volume declaration as configuration: changing only the `[volumes]` table recreates the container without rebuilding the image.

## Environment precedence

The container environment is assembled in three layers. Later layers win on duplicate names:

1. the inline `[env]` table in `config.toml`;
2. the secrets file, which defaults to `secrets.env` and can be changed with `env_file`;
3. `PORT`, which easy-host always sets to `container_port` and which therefore overrides any `PORT` value from either layer.

For example, with `[env]` containing `LOG_LEVEL = "info"` and a secrets file containing `LOG_LEVEL = "debug"`, the container receives `LOG_LEVEL=debug`. If either layer sets `PORT = "5000"` but `container_port = 3000`, the container receives `PORT=3000`.

Secrets file format:

- one `KEY=VALUE` per line; blank lines and lines starting with `#` are ignored;
- an unquoted value ends at a `#` that is preceded by whitespace, so `TOKEN=abc#123` keeps the `#`;
- single-quoted values are literal; double-quoted values accept `\n`, `\r`, `\t`, `\"`, `\'`, and `\\`;
- a repeated key keeps the last value;
- an invalid variable name or a malformed line fails with exit `1` and names the file and line, never the value;
- a declared `env_file` that does not exist fails with exit `1`; a file that cannot be read fails with exit `2`.

Values are secret material. Human output never prints them, and `--json` documents preserve variable names while replacing every value with `[redacted]`; error messages never echo an `[env]` or secrets-file value.

## Files and permissions

| Path | Mode | Notes |
| --- | --- | --- |
| `<state-root>/` and its `apps/`, `tools/`, `buildkit/` children | `0700` | Created on first use and private to the operator. |
| `<state-root>/apps/<app>/` and `workspace/` | `0700` | App and checkout directories are private. |
| `<state-root>/apps/<app>/config.toml` | `0644` | Atomically replaced through a same-directory temporary file and rename. |
| `<state-root>/apps/<app>/secrets.env` | `0600` | Read-only secret input; easy-host never writes secret values into `config.toml`. |
| `<state-root>/apps/<app>/state.json` | `0644` | Rebuildable cache; deleting it loses no app definition. |

`config.toml`, `secrets.env`, and `state.json` writes are atomic: a crash leaves either the previous complete file or the new complete file, never a partial document. Comments on retained keys and table entries are preserved when easy-host rewrites the file.

## Validation errors

A bad configuration is a usage failure (exit `1`) with a stable diagnostic code:

| Situation | Result |
| --- | --- |
| TOML syntax error | `invalid config.toml: <reason>`, with the source line and column where the parser reports them. |
| Unknown key | Names the unexpected key and lists the allowed keys. |
| Missing `port` | Names `port` as required. |
| `repo` and `local_path` both set or both absent | Names the `repo` key and states that exactly one is required. |
| Wrong type, out-of-range number, or unsupported enum value | Names the key and the rule, for example `must be at least 1024`. |
| Unsafe path in `local_path` or `env_file` | Names the key and rejects absolute paths and `..` segments. |
| Invalid volume or environment name | Names the table entry and its required pattern. |

Errors are raised before any container, volume, or directory mutation. Fix the named key and retry; `easy-host config <app>` validates the file without applying it, and `easy-host update <app>` applies a valid configuration.

## Related documentation

- [CLI reference](cli.md) for every command, flag, and exit code.
- [Host prerequisites](../operations/prerequisites.md) for Podman, lingering, git, Node.js, and the port floor.
- [Architecture](../ARCHITECTURE.md#on-disk-state) for the storage contract behind this schema.
- [Architecture](../ARCHITECTURE.md#output) for the `--json` document contract.
