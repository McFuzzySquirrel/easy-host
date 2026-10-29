# Build Pipeline Detail

Load this file when implementing Railpack acquisition, buildkitd lifecycle, image tagging, streaming, or failure classification.

## Pinned values (single module)

```text
RAILPACK_VERSION = "0.43.0"
RAILPACK_SHA256 = { x86_64: "...", arm64: "..." }
BUILDKIT_IMAGE  = "moby/buildkit:0.34.1-rootless"
BUILDKIT_DIGEST = "sha256:..."
```

Rules:

- No `latest`, ranges, or runtime version discovery.
- Upgrade is a deliberate change with fixtures and integration evidence.
- Every reference imports these values; no caller duplicates a version string.

## Acquisition branches

| Condition | Behavior | Exit |
|---|---|---|
| Verified binary in `<root>/tools` | Reuse, no download | — |
| Cache miss | Download to temp, hash, extract, move into place | — |
| SHA-256 mismatch | Delete temp, do not execute, report expected and actual | 3 (build infrastructure) |
| `EASY_HOST_RAILPACK_BIN` set and executable | Use it, skip download | — |
| Override set but missing or not executable | Report the path and permission | 2 |
| Unsupported architecture | Name the detected arch and supported set | 2 |
| Network failure during download | Report URL host and failure | 2 |

Never execute a partially downloaded file; never leave a temp archive in `tools/`.

## buildkitd lifecycle

```text
ensure():
  if socket accepts a connection -> reuse
  else start pinned rootless image:
    --name easy-host-buildkit
    --restart=unless-stopped
    -v <root>/buildkit:/var/lib/buildkit
    -v <root>/buildkit/socket:/run/buildkit
    --label io.easy-host.role=buildkit
  wait for socket, bounded readiness timeout
  on timeout -> stop the attempted container and exit 2

stop():
  podman stop easy-host-buildkit

status():
  socket reachable? report running/stale/absent
```

Exact flags follow `docs/reviews/buildkit-spike.json`. Any elevated option must be recorded there with a justification; app containers never inherit it.

## Build invocation

```text
BUILDKIT_HOST=unix://<root>/buildkit/socket
railpack build <workspace> --tag localhost/easy-host-<app>:<UTC yyyymmddThhmmssZ>
```

- Validate `<app>` against `^[a-z0-9][a-z0-9-]{0,31}$` before it enters the tag.
- Timestamp is UTC, `YYYYMMDDThhmmssZ`, e.g. `20261029T211400Z`.
- No `:current` or other mutable tag.
- Stream every line to stderr as it arrives; do not collect then print.
- One build at a time per host.

## Failure classes

| Class | Detection | Exit | Message focus |
|---|---|---|---|
| `unsupported-source` | Railpack reports no provider | 3 | Stack detection; link supported stacks |
| `build-failure` | Provider selected, build command failed | 3 | The failing step from streamed output |
| `infrastructure-failure` | Socket unreachable, readiness timeout, image pull error | 2 | Host/buildkit/registry, `easy-host doctor` |
| Digest mismatch | Local SHA-256 differs from pin | 3 | Never execute; report pin and actual |
| Download failure | Network or HTTP error | 2 | URL host, no retry loop |

Each class has a distinct remediation hint. Do not collapse them into one generic error.

## Fixtures

| Fixture | Stack | Required signals |
|---|---|---|
| `fixtures/vite-spa` | Vite/React static SPA | `package.json`, `index.html`, `vite.config.ts`, `src/main.tsx` |
| `fixtures/express-api` | Node/Express | `package.json`, `server.js`, reads `PORT` |
| `fixtures/fastapi-app` | Python/FastAPI | `requirements.txt`, `main.py`, reads `PORT` |

Fixtures are test assets: small, dependency-light, no Dockerfile. The unit fixture test fails when a required file is removed or a server stops reading `PORT`.

## Streaming contract

- Every line reaches stderr within one second of being produced.
- Preserve order.
- Redact any environment value or URL credential that appears.
- Build progress is not a JSON payload; it belongs on stderr even when the caller later emits JSON.
