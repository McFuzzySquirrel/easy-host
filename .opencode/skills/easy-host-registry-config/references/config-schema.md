# AppSpec and Registry Detail

Load this file when editing the zod schema, the TOML parser, naming, registry writes, state recovery, or env merging.

## AppSpec fields

| Key | Type | Required | Default | Validation |
|---|---|---|---|---|
| `repo` | string | one of `repo`/`local_path` | — | Git URL shapes; credentials allowed but redacted in output |
| `local_path` | string | one of `repo`/`local_path` | — | Relative to the app directory; no traversal; no absolute path; dev-only |
| `port` | integer | yes | — | `1024–65535`; unique across apps |
| `ref` | string | no | `main` | Non-empty; no shell metacharacters |
| `container_port` | integer | no | `3000` | `1–65535` |
| `bind` | string | no | `0.0.0.0` | One of `0.0.0.0`, `127.0.0.1`, `::` |
| `health_path` | string | no | `/` | Starts with `/` |
| `probe` | string | no | `http` | `http` or `tcp` |
| `health_interval_ms` | integer | no | `2000` | Positive; less than the startup budget |
| `health_timeout_ms` | integer | no | `5000` | Positive |
| `health_startup_ms` | integer | no | `90000` | Positive; bounds the whole probe |
| `env_file` | string | no | — | Relative to the app directory; no traversal; no absolute path |
| `[env]` | table | no | empty | Valid `KEY=VALUE` names; values never echoed |
| `[[volumes]]` | array of tables | no | empty | `name` and `container_path`; named volumes only |

Unknown keys are rejected, not ignored. Wrong types are rejected with the key and received type.

## Example config.toml

```toml
repo = "https://github.com/example/blog.git"
ref = "main"
port = 8080
container_port = 3000
bind = "0.0.0.0"
health_path = "/health"
probe = "http"

[env]
NODE_ENV = "production"
LOG_LEVEL = "info"

[[volumes]]
name = "data"
container_path = "/app/data"
```

`secrets.env` lives beside it with mode `0600`:

```text
# values here win over [env]
DATABASE_URL="postgres://user:pass@db.internal/app"
API_TOKEN='abc123'
```

## Registry layout

```text
<root>/apps/<name>/
├── config.toml      # 0644, authoritative
├── secrets.env      # 0600, optional, wins over [env]
├── workspace/       # clone target; unused in --local mode
└── state.json       # cache: schemaVersion, current/previous image, last health, timestamps
```

Root resolution: `EASY_HOST_HOME`, else `XDG_DATA_HOME/easy-host`, else `~/.local/share/easy-host`. Create `apps/`, `tools/`, `buildkit/` with `0700`.

## Name derivation

1. Take the repository basename or local-path basename.
2. Strip a trailing `.git`.
3. Lowercase.
4. Replace runs outside `[a-z0-9]` with one hyphen.
5. Trim leading and trailing hyphens.
6. Truncate to 32 characters, then re-trim.
7. Apply `^[a-z0-9][a-z0-9-]{0,31}$`.

Reject an empty result. An explicit `--name` is validated against the same pattern. An existing directory is exit `6`.

## Atomic write recipe

```text
tmp = join(appDir, `.config.toml.${pid}.tmp`)
writeFile(tmp, contents, { mode })
fsync/close if the platform allows
rename(tmp, config.toml)   # same filesystem
```

Never write to `os.tmpdir()` and rename across filesystems. Never leave the temp file behind on failure.

## State cache

`state.json` holds `schemaVersion`, current image, previous image, last health result, and timestamps. Read leniently:

- Missing → rebuild from the directory and Podman inspect.
- Invalid JSON or failed schema → rebuild, keep the app, report the rebuild.
- Partial write → the atomic rename prevents this; treat a stray temp file as garbage.

The state cache never determines whether an app exists, and a failed rebuild must not delete anything.

## Lock protocol

- Lock file inside the app directory records `pid` and process start time.
- Acquire exclusively before any mutating lifecycle operation.
- Held by a live pid → exit `6`, naming the pid and operation.
- Pid gone or start time differs → reclaim.
- Release in `finally`, including on thrown errors.
- Read-only commands never take the app lock.
- A short-lived allocation lock covers new app directory creation; release it before build.

## Error text rules

Good:

```text
easy-host: invalid config for "blog"
  key:    port
  reason: 443 is below the rootless minimum of 1024
  next:   set port to a value from 1024 to 65535 in /home/me/.local/share/easy-host/apps/blog/config.toml
```

Bad: echoing the received value for an env key, printing the whole TOML document, or naming only the file without the key.
