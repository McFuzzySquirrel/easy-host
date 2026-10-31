# Architecture Decision Records

*The durable architectural decisions for easy-host, one decision per record. Each record states the options considered, the choice, and the consequences accepted. This index is linked from the [README](../../README.md) and must stay accurate as records are added or superseded.*

| ADR | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](0001-rootless-podman-runtime.md) | [Run apps as rootless Podman containers with one published port](0001-rootless-podman-runtime.md) | Accepted | 2026-10-31 |
| [ADR-0002](0002-filesystem-registry-derived-state.md) | [Use app directories as the registry and a rebuildable state cache](0002-filesystem-registry-derived-state.md) | Accepted | 2026-10-31 |
| [ADR-0003](0003-pinned-railpack-buildkit-build-layer.md) | [Build with a pinned Railpack binary and a pinned rootless BuildKit](0003-pinned-railpack-buildkit-build-layer.md) | Accepted | 2026-10-31 |
| [ADR-0004](0004-fixed-port-health-gated-swap.md) | [Replace the single container behind a health gate on a fixed port](0004-fixed-port-health-gated-swap.md) | Accepted | 2026-10-31 |
| [ADR-0005](0005-two-image-retention.md) | [Retain exactly two labelled images per app](0005-two-image-retention.md) | Accepted | 2026-10-31 |
| [ADR-0006](0006-label-scoped-volume-deletion.md) | [Delete only explicitly requested, label-scoped named volumes](0006-label-scoped-volume-deletion.md) | Accepted | 2026-10-31 |
| [ADR-0007](0007-ten-command-surface.md) | [Keep a fixed ten-command surface with no daemon](0007-ten-command-surface.md) | Accepted | 2026-10-31 |
| [ADR-0008](0008-exit-codes-and-json-contract.md) | [Treat exit codes and the JSON document as a public contract](0008-exit-codes-and-json-contract.md) | Accepted | 2026-10-31 |

## Rules

- One row per record, in identifier order, with no gaps in numbering.
- Keep each row's status and date in step with the record they point at.
- When a record is superseded, update its row to `Superseded by ADR-NNNN` and link the replacement in the same row rather than deleting the entry.
- Fill a row from the record itself rather than from memory; the index is a directory, not a summary.
