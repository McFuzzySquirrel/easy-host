# Swap State Machine Detail

Load this file when implementing or reviewing `diff.ts`, `swap.ts`, `update.ts`, or `rollback.ts`.

## Diff classification

| Changed field | Class |
|---|---|
| none, container running and healthy | `no-op` (exit 0) |
| `repo`, `ref`, `local_path` | `rebuild` |
| `--rebuild` flag | `rebuild` |
| `[env]`, `secrets.env` | `config-only` |
| `bind`, `port`, `container_port` | `config-only` |
| `health_path`, `probe`, health timings | `config-only` |
| `[[volumes]]` | `config-only` |
| unknown / unclassifiable | `rebuild` |
| missing or invalid `state.json` | `rebuild`, never a false no-op |
| container missing | recovery attempt; not a no-op |

## Phase events

| Phase | Meaning | Next |
|---|---|---|
| `stopping` | Current container is being stopped | `starting` |
| `starting` | Candidate container is being created and started | `probing` |
| `probing` | Bounded health probe is running | `keeping` or `reverting` |
| `keeping` | Probe passed; candidate is recorded | done, healthy |
| `reverting` | Candidate failed; previous container is restarting | `reverted` |
| `reverted` | Previous container restarted and probed | exit 4 |

Emit each phase to stderr with the app name. Progress never goes to stdout.

## Revert branches

| Failure point | Action | Exit |
|---|---|---|
| Build fails | Do not stop the old container; leave state untouched | 3 |
| Candidate fails to start | Remove candidate, restart previous, probe once | 4 |
| Candidate probe fails | Stop and remove candidate, restart previous, probe once | 4 |
| Previous also fails to probe | Report both failures; state unchanged | 4 |
| Lock held | Do nothing | 6 |
| Rollback with one image | Do nothing | 5 |

The revert path restarts the previous container from its recorded image **and recorded config**. Do not rebuild it.

## State transitions

```text
healthy --update(rebuild)--> swapping --probe ok--> healthy (current=candidate)
                                   |
                                   +--probe fail--> reverted (current/previous unchanged)

healthy --update(config-only)--> swapping --probe ok--> healthy (same image, new config)
                                        |
                                        +--probe fail--> reverted

healthy --rollback--> swapping --probe ok--> healthy (current/previous swapped)
                          |
                          +--probe fail--> reverted (serving image unchanged)
```

Rules:

- `current` is the image the running container was created from.
- `previous` is the last image that served before `current`; it is the rollback target.
- Write state only after the Podman action and probe outcome are known.
- On revert, leave `current` and `previous` exactly as they were.
- `rollback` with fewer than two recorded images exits `5` before any mutation.
- A missing container or unhealthy app is still updateable; that is a recovery attempt.

## Retention

| Situation | Images kept |
|---|---|
| Successful update | new current + former current (previous) |
| Successful rollback | swapped pair, still two |
| Failed update or rollback | both untouched; no prune |
| Image used by a running container | never remove |
| Image referenced by another app | never remove |
| Third or older app image | remove only when labelled for this app |

Retention runs after success, never before or during a swap.

## Test doubles

- Fake runtime records `stop`, `run`, `rm`, `inspect`, and `image` calls in order.
- Fake probe returns a scripted sequence: healthy immediately, healthy after N attempts, always failing, or hangs until budget.
- Fake reporter captures phase events.
- Fake registry captures state writes and asserts nothing is written before the probe result.

## Required assertions

1. Phase events are ordered.
2. Failed candidate always triggers a previous-container restart.
3. Current and previous references are unchanged after a revert.
4. A build failure never stops the old container.
5. A config-only update makes zero builder calls.
6. A hung probe ends at the startup budget, not later.
7. Rollback twice returns to the original image.
8. A failed update prunes nothing.
