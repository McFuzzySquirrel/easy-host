# Doctor Check Detail

Load this file when adding a check, writing remediation text, or changing the doctor report shape.

## Ordered checks

| # | ID | Checks | Fail condition |
|---|---|---|---|
| 1 | `podman-present` | `podman --version` resolves | Binary missing |
| 2 | `podman-version` | Numeric version in `>= 5.7.0, < 6.0.0` | Below 5.7.0 or at/above 6.0.0 |
| 3 | `podman-rootless` | Reported mode is rootless | Rootful or unknown mode |
| 4 | `lingering` | `loginctl show-user <user> -p Linger` reports `Linger=yes` | `Linger=no` |
| 5 | `git-version` | System git `>= 2.40` | Missing or older |
| 6 | `node-version` | Node `>= 24` | Missing or older |
| 7 | `disk-space` | Free space at the state root | Below 2 GiB; warn below 5 GiB |
| 8 | `railpack-binary` | Present, executable, expected pinned version | Missing, not executable, version mismatch |
| 9 | `buildkit-reachable` | Managed unix socket accepts a connection | Unreachable within the connect timeout |
| 10 | `disk-usage` | Per-app image size, BuildKit cache, workspace usage | Informational; warn above documented thresholds |

Checks 1–7 belong to `checks.ts`; 8–9 to `build-checks.ts`; 10 to `disk-checks.ts`.

## Detail and remediation examples

```text
FAIL  podman-version
      found 4.9.3; easy-host requires >= 5.7.0 and < 6.0.0
      next:  upgrade Podman to the newest 5.8.x package for your distribution
             (see docs/operations/prerequisites.md)

FAIL  lingering
      Linger=no for user "operator"; --restart=always containers stop at logout and after reboot
      next:  sudo loginctl enable-linger operator

WARN  disk-space
      4.1 GiB free at /home/operator/.local/share/easy-host (warn below 5 GiB)
      next:  easy-host doctor --json and remove unused apps, or prune images manually

SKIP  buildkit-reachable
      buildkitd is not running; doctor does not start it
      next:  rerun a build or start the managed buildkitd, then rerun doctor
```

Rules:

- Detail names the observed value and the expected range.
- Remediation is a command or an exact settings change, on its own line.
- Never claim a package version or distribution command that was not verified.
- 6.x remediation names the stable 5.8.x line; it does not tell the operator to downgrade blindly.

## JSON shape

```json
{
  "schemaVersion": 1,
  "status": "fail",
  "checks": [
    {
      "id": "podman-version",
      "label": "Podman version",
      "status": "fail",
      "detail": "found 4.9.3; requires >= 5.7.0 and < 6.0.0",
      "remediation": "upgrade Podman to the newest 5.8.x package; see docs/operations/prerequisites.md",
      "data": { "found": "4.9.3", "min": "5.7.0", "maxExclusive": "6.0.0" }
    }
  ]
}
```

- `status` is `pass`, `warn`, `fail`, or `skip`.
- `checks` is always present, ordered, and never omitted.
- `data` is optional and additive; never put secret values in it.
- The overall status is the worst check status, with `skip` never promoted to `pass`.

## Version window

```text
supported: 5.7.0 <= version < 6.0.0
pass:  5.7.0, 5.7.1, 5.8.9, 5.10.0
fail:  4.9.3, 5.6.9, 6.0.0, 6.1.4
```

Parse `major.minor.patch`, ignore distro suffixes such as `+ds1` or `-1ubuntu1` after extracting the numeric prefix, and report the raw string in the detail.

## Time budget

- No network calls.
- No daemon start or download.
- Connection attempts use a short connect timeout, not retries.
- Total wall clock under 2 seconds with an injected clock; assert it in a unit test.
- Disk sizing is approximate; label it and never block on a recursive walk of an unbounded tree.
