# Changelog

All notable changes to easy-host are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the `package.json` version.

## [Unreleased]

### Added

- MIT license (`LICENSE`) and the `license` field in `package.json`.
- Tailscale operations guide covering the loopback bind plus `tailscale serve` layout, `funnel` for public exposure, ACLs, persistence, and troubleshooting (`docs/operations/tailscale.md`).
- Architecture Decision Records under `docs/adr/` with an index, covering the rootless runtime, filesystem registry, pinned build layer, fixed-port swap, two-image retention, volume deletion, ten-command surface, and the exit-code and JSON contract.
- User guide and administrator guide for the app-owner and host-owner workflows.
- Release notes for `0.1.0` and this changelog.

### Changed

- The README now links the user guide, administrator guide, ADR index, changelog, and release notes from its documentation index, and documents the full project structure and configuration surface.
- The documentation drift suite now also checks the Tailscale guide, the new guides, the ADRs, and the changelog for resolving links and registered command names.

## [0.1.0] - 2026-10-30

First recorded release. No git tag or npm publication exists for this version in the repository; the version comes from `package.json`, and the host evidence comes from the [v0.1.0 release-gate record](docs/operations/release-gate-v0.1.0.md).

### Added

- Ten-command CLI: `add`, `list`, `status`, `logs`, `update`, `rollback`, `remove`, `config`, `doctor`, and `version`.
- App registration from a git repository or a local workspace, with a strict `config.toml` schema, name derivation, and preflight validation.
- Rootless Podman runtime with `--restart=always`, one published host port per app, and labels used for ownership and cleanup.
- Railpack builds with no per-repository Dockerfile, executed against a pinned Railpack release and a pinned rootless BuildKit image with verified digests.
- Health-gated updates and rollbacks with a revert path that restarts the previously serving image, plus a 90-second default readiness budget.
- Exactly two retained images per app, with label-scoped retention that never removes an in-use or shared image.
- Named-volume support that keeps data on `remove` unless `--volumes` is passed, and refuses volumes whose ownership label does not match.
- `doctor` host checks for Podman, rootless mode, the Docker-compatible image loader, lingering, boot replay, git, Node.js, Railpack, BuildKit, and disk.
- `schemaVersion: 1` JSON documents for read commands and error envelopes, with secrets redacted.
- Per-app locking with stale-lock reclamation, and port-conflict checks across apps.
- Shell completions for bash, zsh, and fish, generated from the command definitions.
- Operator documentation: README, CLI and configuration references, host prerequisites, scheduled-update timer guide, release-gate record, architecture note, support map, and migration note.

### Changed

- The project and binary are named `easy-host`; the previous name was `react-hoster`. The migration note records what early users must change.
- The build scaffolding used during the initial build was retired; `docs/SUPPORT.md` now holds the current ownership map.

### Fixed

- Railpack-produced images are labelled for their app so retention and removal can identify them.
- `doctor` fails fast when no Docker-compatible image loader is present instead of letting a build stall at export.
- The lifecycle commands are wired to their handlers rather than only being registered.
- Rootless apps return after a reboot through lingering and `podman-restart.service`.

### Security

- Containers run rootless with no privileged mode, host networking, or extra capabilities.
- Secret values are redacted from human and JSON output, and the secrets file is created with mode `0600`.
- Volume deletion requires an explicit flag and a matching `io.easy-host.app` label.
