# easy-host CLI Contract Detail

Load this file when implementing or reviewing a command, flag, exit code, error renderer, or JSON payload.

## Exit codes

| Code | Class | Typical causes | Recovery surface |
|---|---|---|---|
| 0 | Success | Command completed, no-op update, healthy status | — |
| 1 | Usage / validation | Unknown command, missing argument, invalid TOML value, name collision input, removal without `--yes` on non-TTY | Correct the invocation or config |
| 2 | Prerequisite / environment | Podman missing, outside `>= 5.7.0, < 6.0.0`, not rootless, lingering off, git < 2.40, Node < 24, disk below 2 GiB, BuildKit unreachable | `easy-host doctor` |
| 3 | Build | Railpack found no provider, provider build failed | Inspect streamed build output |
| 4 | Health | Candidate failed the probe, rollback failed, unhealthy `status` | `easy-host logs <app> --tail 200` |
| 5 | Not found | Unknown app, rollback with only one image | `easy-host list` |
| 6 | Conflict / lock | Duplicate name, duplicate port, another mutation holds the app lock | Wait or inspect the named holder |
| 7 | Unexpected | Uncaught exception | Retry with `EASY_HOST_DEBUG=1` and report |

## Command and flag matrix

| Command | Arguments | Flags | JSON |
|---|---|---|---|
| `add` | `<git-url>` or `--local <path>` | `--name`, `--ref`, `--port`, `--container-port`, `--bind`, `--env-file`, `--health-path`, `--probe`, `--volume`, `--yes` | No |
| `list` | — | `--json` | Yes |
| `status` | `[app]` | `--json` | Yes |
| `logs` | `<app>` | `-f`, `--tail <n>` | No |
| `update` | `<app>` | `--rebuild` | No |
| `rollback` | `<app>` | — | No |
| `remove` | `<app>` | `--volumes`, `--force`, `--yes` | No |
| `config` | `<app>` | `--path`, `--edit`, `--json` | Yes |
| `doctor` | — | `--json` | Yes |
| `version` | — | `--json` | Yes |

`logs` forwards `-f` and `--tail` unchanged and exits with Podman's code. `config --edit` opens `$EDITOR`, then validates without applying changes.

## JSON rules

- Exactly one document on stdout, `"schemaVersion": 1`.
- Stable field names; additive fields allowed, renames or removals require a version bump.
- Arrays present and empty rather than omitted.
- Numbers and booleans keep their JSON types; no stringly-typed ports or health flags.
- Timestamps are ISO 8601 UTC, e.g. `2026-10-29T21:14:00Z`.
- No ANSI escapes, no table borders, no secret values.
- `list` includes broken and missing apps; broken entries carry the parse error.
- `status` includes the drift class and the recommended update action.

## Error rendering

```text
easy-host: health check failed for "api"
  probe:    GET http://127.0.0.1:8081/ (90s budget, 2s interval)
  reason:   connection refused after 45 attempts
  previous: easy-host-api:20261028T090200Z is serving again
  next:     easy-host logs api --tail 200
```

Rules: one-line summary, indented details, remediation on its own line, complete sentences, no glyph-only indicators. The `previous` line is required when a revert occurred; the `next` line is required for every non-usage failure.

## Output routing

- stdout: JSON documents, human tables, command results.
- stderr: progress (build lines, probe phases), warnings, narration, prompts.
- `NO_COLOR` or a non-TTY selects plain text; status labels remain.
- Human tables fit 80 columns; long values move to a detail line instead of truncating names or ports.

## Preflight ordering for mutating commands

1. Parse and validate flags.
2. Resolve the app and config.
3. Acquire the app lock.
4. Check name, port, container-name, and prerequisite conflicts.
5. Mutate.

A failure in steps 1–4 must leave no container, volume, image, or directory entry behind.
