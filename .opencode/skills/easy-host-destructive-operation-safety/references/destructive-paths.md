# Destructive Path Detail

Load this file when implementing `remove`, retention, rollback confirmation, or volume and image deletion.

## Removal matrix

| Resource | Default `remove` | `remove --volumes` | Notes |
|---|---|---|---|
| Container `easy-host-<app>` | Delete | Delete | Stop first, then remove |
| `workspace/` | Delete | Delete | Clone target only |
| App directory | Delete | Delete | Includes `config.toml`, `secrets.env`, `state.json` |
| Current and previous images | Delete | Delete | Label-scoped; skip in-use and shared |
| Named volumes | Keep and report | Delete if label matches | The data-safety boundary |
| Host paths / bind mounts | Never | Never | Not supported in v1 |
| Foreign container or volume | Report | Report | Never delete |

## Confirmation branches

| Context | `--yes` | `--force` | Result |
|---|---|---|---|
| TTY | absent | absent | Prompt; proceed only on explicit confirmation |
| TTY | present | absent | Skip prompt |
| TTY | absent | present | Skip prompt (force is confirmation-only) |
| non-TTY | absent | absent | Exit `1`, delete nothing |
| non-TTY | present | absent | Proceed |
| non-TTY | absent | present | Still exit `1`; force does not replace `--yes` in scripts |
| any | any | any, with lock held | Exit `6`, name holder |

## Volume ownership check

```text
1. podman volume ls --filter label=io.easy-host.app=<app> --format json
2. For each candidate name, podman volume inspect <name>
3. Require .Labels["io.easy-host.app"] == <app>
4. Delete only matches; report everything else
```

A volume named `easy-host-<app>-data` without the label is foreign. Report it; never delete it.

## Retention rules

| Image state | Action |
|---|---|
| Equals `current` | Keep |
| Equals `previous` | Keep |
| Older, labelled for this app | Remove |
| Used by a running container | Keep and report |
| Referenced by another app | Keep and report |
| Missing from Podman | Skip and report |
| Any image after a failed update/rollback | Keep; no prune |

Retention runs after success only. `rollback` never deletes and never builds.

## Rollback boundaries

- Requires two recorded image references; one image is exit `5` with no mutation.
- Swaps current and previous through the health-gated primitive.
- On failure, the image serving before the command stays serving; exit `4`.
- A second rollback returns to the newer image.
- Lock contention is exit `6`.

## Human output

```text
easy-host: removing "blog"
  container: easy-host-blog
  workspace: /home/operator/.local/share/easy-host/apps/blog/workspace
  images:    localhost/easy-host-blog:20261028T090200Z
             localhost/easy-host-blog:20261029T211400Z
  volume:    easy-host-blog-data (retained)
  next:      easy-host remove blog --volumes   # deletes the retained volume and its data
```

Rules:

- Print the exact resources before deleting them.
- Name retained volumes and give the delete command.
- Never print secret file contents or environment values.
- Report every refused foreign resource with its name and the reason.
