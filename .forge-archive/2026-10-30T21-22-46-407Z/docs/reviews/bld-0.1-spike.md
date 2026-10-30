# BLD-0.1 — Phase 0 compatibility spike

**Task:** Verify Railpack and BuildKit on rootless Podman 5.7.0
**Review file:** `docs/reviews/buildkit-spike.json` (attestation written by `approve-task`)
**Evidence transcript:** `docs/reviews/bld-0.1-spike-commands.log`
**Executed:** 2026-10-29 23:38–23:58 UTC
**Decision:** **PASS** — a Vite repository builds into an image without a Dockerfile. See “Caveats” for the elevated option and the new `docker`-loader prerequisite.

---

## 1. Host under test

| Item | Observed value |
|---|---|
| OS | Ubuntu 26.04.1 LTS |
| Kernel | 7.0.0-42-generic |
| Arch | x86_64 (amd64) |
| Podman | 5.7.0, rootless |
| Cgroup | v2, systemd |
| Storage driver | overlay |
| Linger | `yes` |
| subuid / subgid | `mcfuzzysquirrel:100000:65536` |
| `/dev/fuse` | present |
| `kernel.apparmor_restrict_unprivileged_userns` | `1` |
| `docker` on PATH | `/usr/local/bin/docker` — a local shell shim that `exec podman "$@"` (not `podman-docker`) |

The spike root was `/tmp/opencode/easy-host-bld-0.1`; no product code or fixture was added to the repository.

---

## 2. Pinned artifacts

**Railpack**

```
version: 0.43.0
asset:   railpack-v0.43.0-x86_64-unknown-linux-musl.tar.gz
sha256:  248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb  (verified OK)
binary:  railpack 0.43.0 (24,072,354 bytes)
```

**BuildKit**

```
image:  docker.io/moby/buildkit:v0.34.1-rootless@sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89
config: 9cca736f4c5c924382d15804fdd3e1702823c83ec19546e569e18ae33e700380
size:   267,298,905 bytes
pull:   51.35 s wall clock
```

> Spec correction: the feature document and `versions.ts` plan say `moby/buildkit:0.34.1-rootless`. That tag does **not** exist (Docker Hub 404). The published tag is `v0.34.1-rootless`. The digest above is the multi-arch index digest.

---

## 3. The working daemon command (exact)

```bash
podman run -d --name easy-host-buildkit-spike \
  --label io.easy-host.role=buildkit \
  --user 0 --privileged \
  --entrypoint /usr/bin/buildkitd \
  -v /tmp/opencode/easy-host-bld-0.1/buildkit/state:/home/user/.local/share/buildkit \
  -v /tmp/opencode/easy-host-bld-0.1/buildkit/socket:/run/user/1000/buildkit \
  docker.io/moby/buildkit:v0.34.1-rootless@sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89 \
  --addr unix:///run/user/1000/buildkit/buildkitd.sock \
  --oci-worker-no-process-sandbox
```

Resulting state:

```
container: Up
snapshotter: overlayfs
worker: oci, process-mode=no-sandbox, network=host, selinux=false
socket: /tmp/opencode/easy-host-bld-0.1/buildkit/socket/buildkitd.sock
socket owner: mcfuzzysquirrel (host user), mode srw-rw----
security: User=0 Privileged=true SecurityOpt=[unmask=all] Devices=[] CapAdd=[]
```

Host-side reachability (BuildKit's own client, copied out of the image):

```bash
buildctl --addr unix:///tmp/opencode/easy-host-bld-0.1/buildkit/socket/buildkitd.sock debug workers
# ID                            PLATFORMS
# 6i2gznc61tnin96s0vn88etyp     linux/amd64,linux/amd64/v2,linux/amd64/v3,linux/386
```

### Flags required for rootless operation

| Flag / setting | Necessary? | Why |
|---|---|---|
| `--user 0` | **Yes** | `buildkitd` refuses to start in rootless mode unless it is the mapped root in the user namespace. |
| `--privileged` | **Yes** on this host | Without it the snapshotter cannot bind-mount (`operation not permitted`). `--cap-add SYS_ADMIN` alone was not sufficient. See §6. |
| `--entrypoint /usr/bin/buildkitd` | **Yes** | The image's default entrypoint (`rootlesskit buildkitd`) cannot create its nested UID map under rootless Podman. See §6. |
| `--oci-worker-no-process-sandbox` | **Yes** | Podman has no `systempaths=unconfined` (Docker-only). This is the documented BuildKit substitute; it emits a warning about `ExecOp` processes being able to signal the daemon namespace. |
| `--security-opt seccomp=unconfined` | Not required in the final config | `--privileged` already sets `unmask=all` and unconfined profiles. Tried explicitly in earlier attempts; not sufficient on its own. |
| `--security-opt apparmor=unconfined` | Not required in the final config | Same as above. |
| `--userns=keep-id` | Not used in the final config | It makes the socket host-owned, but the default mapping (`--user 0`) already maps container root to the host user. |
| `--network=host` | Not used | Default Podman networking was sufficient; rootless BuildKit's worker reports `network:host` for build steps. |
| custom `/etc/subuid` | Not used in the final config | Only needed for the `rootlesskit` entrypoint path, which was abandoned. |

**Security note:** `--privileged` is confined to the dedicated `buildkitd` container, which runs as container root mapped to the invoking host user. It is not an app container, and app containers never inherit it. `PRD-SP-03` permits documented options for the dedicated buildkitd provided they are recorded and justified; this is that record.

---

## 4. The build command (exact)

Fixture (throwaway, outside the repo, no Dockerfile):

```bash
npm create vite@latest vite-spa -- --template react-ts
# create-vite v9.3.3
# files include package.json, index.html, vite.config.ts, src/main.tsx
# confirmed: no Dockerfile
```

Build invocation:

```bash
export BUILDKIT_HOST="unix:///tmp/opencode/easy-host-bld-0.1/buildkit/socket/buildkitd.sock"

railpack build /tmp/opencode/easy-host-bld-0.1/vite-spa \
  --name "localhost/easy-host-vite-spike:$(date -u +%Y%m%dT%H%M%SZ)" \
  --progress plain
```

> Spec correction: the CLI flag is `--name`, not `--tag`. The 0.43.0 CLI has no `--tag` option.

Railpack detected:

```
Node 24.22.0 (npm), caddy 2.11.7
provider: vite static site, output directory dist
steps: npm install → npm run build → caddy fmt → deploy caddy run
```

---

## 5. Timings and results

| Measurement | Cold | Warm |
|---|---|---|
| Wall clock (`/usr/bin/time`) | **258.53 s** | **1.42 s** |
| Railpack's own report | 258.46 s | 1.35 s |
| Max RSS | 69,544 KB | 47,496 KB |
| BuildKit state before | 160 KB | ~1.5 GB |
| Included | BuildKit image pull, Railpack builder/runtime pulls, apt, mise, npm | cache hits only |

Cold-build breakdown (from the streamed log):

- builder image pull + extract: 196.7 s
- runtime image pull + extract: 25.8 s
- `apt-get install libatomic1`: 102.7 s
- mise Node install: 27.6 s
- `npm install`: 27.9 s
- `npm run build` (Vite): 0.8 s
- export + `docker load`: 2.4 s

Images:

| | Reference | Image ID | Manifest digest | Size |
|---|---|---|---|---|
| Cold | `localhost/easy-host-vite-spike:20261029T234714Z` | `dbf908718759ed46994b7c8cdeca33b11ccae9a51fcf820401befcacedf01f56` | `sha256:6899fb02bae1c94badafa68d5bb5cb9197f6bc204ac56e9e6cba1e43caad0173` | 157,364,566 B |
| Warm | `localhost/easy-host-vite-spike:20261029T235139Z` | `40f73e4c3f16b1f471a42e5016a90e1a98aa1208138a528a60edf3dca255ea0d` | `sha256:d2bf092a7439729e49e5a38e6bac4a2a126177b48c7dc046169d46ca439eac68` | 157,364,566 B |

Smoke test (warm image):

```bash
podman run -d --name eh-spike-smoke -p 18080:80 localhost/easy-host-vite-spike:20261029T235139Z
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/
# 200
# <!doctype html><html lang="en"><head>... Vite app ...
```

There is no Dockerfile anywhere in the fixture, and the resulting image serves the built Vite app.

---

## 6. Observed failure modes (verbatim)

These were encountered in order while finding the working configuration. They are the useful part of the spike.

### 6.1 Rootlesskit cannot create its nested UID map

Default entrypoint (`rootlesskit buildkitd`), with the image's baked `/etc/subuid` (`user:100000:65536`):

```
[rootlesskit:parent] error: failed to setup UID/GID map: newuidmap 8 [0 1000 1 1 100000 65536] failed: newuidmap: write to uid_map failed: Operation not permitted
: exit status 1
```

This also happened with `--privileged`. The outer (Podman) user namespace does not map host IDs 100000+, so rootlesskit's requested map is invalid.

### 6.2 A reduced subordinate range starts the daemon but breaks `apt`

Mounting `user:1001:64535` over `/etc/subuid` and `/etc/subgid` made rootlesskit succeed, but build steps then ran with an exec map of only `0→1000 (1)`, `1→1001 (64535)`. Debian's `apt` drops to `_apt:nogroup` (gid 65534):

```
#5 0.065 E: setgroups 65534 failed - setgroups (22: Invalid argument)
#5 0.065 E: setegid 65534 failed - setegid (22: Invalid argument)
#5 0.080 E: Method gave invalid 400 URI Failure message: Failed to setgroups - setgroups (22: Invalid argument)
#5 ERROR: process "sh -c apt-get update && apt-get install -y libatomic1" did not complete successfully: exit code: 100
```

### 6.3 The full 65534 range cannot fit around rootlesskit's root mapping

Trying `user:1001:65534` to cover gid 65534 failed because the outer range would exceed the container's 65536-ID map:

```
[rootlesskit:parent] error: failed to setup UID/GID map: newuidmap 8 [0 1000 1 1 1001 65534] failed: newuidmap: write to uid_map failed: Operation not permitted
```

Rootlesskit always maps inner 0 to outer 1000, so a 65534-long range starting at 1001 overruns the mapped space. This is why the `rootlesskit` entrypoint path was abandoned.

### 6.4 `--userns=keep-id` fixes socket ownership but exposes state-directory ownership

With `--userns=keep-id` the socket became host-owned, but the state directory was left owned by the mapped subuid:

```
buildkitd: mkdir /home/user/.local/share/buildkit/runc-overlayfs/executor: permission denied
failed to create /home/user/.local/share/buildkit/runc-overlayfs/executor
```

A clean state directory with permissive ownership resolved it. This matters for `BLD-1.2`: the daemon’s state and socket directories must be writable by the UID the daemon actually uses.

### 6.5 Running `buildkitd` directly as the image user

```
buildkitd: rootless mode requires to be executed as the mapped root in a user namespace; you may use RootlessKit for setting up the namespace
```

### 6.6 Rootless-mode `buildkitd` without `--privileged`

```
error: failed to solve: failed to read dockerfile: failed to mount /home/user/.local/tmp/buildkit-mount818323693: [{Type:bind Source:/home/user/.local/share/buildkit/runc-native/snapshots/snapshots/1 Target: Options:[rbind ro nodev nosuid]}]: mount source: "..." target: "...", fstype: bind, flags: 20487, data: "", err: operation not permitted
```

Adding only `--cap-add SYS_ADMIN` was not sufficient either:

```
error: failed to solve: process "/bin/sh -c echo ok" did not complete successfully: exit code: 1
```

`--privileged` was required for the OCI worker to mount snapshots and select the overlayfs snapshotter.

### 6.7 Railpack requires a `docker`-compatible loader — and hangs without one

Railpack's `build` command pipes the exported image into `docker load` (`exec.Command("docker", "load")` in `buildkit/build.go`). With `PATH=/usr/bin:/bin` (no `/usr/local/bin/docker` shim), the build reached the export stage and then hung indefinitely:

```
#21 exporting to docker image format
#21 exporting layers done
#21 exporting manifest sha256:af0c99... done
#21 exporting config sha256:28b0d4... done
#21 sending tarball
<no further output for 300 s; process killed by the test timeout>
```

This is a deadlock, not a slow export: every other step was `CACHED` and the same build completed in 1.42 s with the shim present. Railpack does not fail fast when the loader is missing.

On this host the shim at `/usr/local/bin/docker` (`exec podman "$@"`) made `docker load` work. That shim is a personal host artifact, not something easy-host installs. Phase 2 must either require `podman-docker` (and check it in `doctor`) or bypass the CLI loader with `railpack prepare` + `buildctl --output type=docker` + `podman load`.

---

## 7. Caveats and follow-ups for Phase 2

1. **`--privileged` is required** for the dedicated buildkitd on this host. It is documented by the pinned rootless image as the shorter alternative to `systempaths=unconfined`, which Podman does not implement. Record it in the operations guide and keep it scoped to the buildkitd container.
2. **The image's default `rootlesskit` entrypoint is not usable** under rootless Podman 5.7.0. `BLD-1.2` must use `--entrypoint /usr/bin/buildkitd`, `--user 0`, `--privileged`, `--oci-worker-no-process-sandbox`, and the socket/state mounts above.
3. **Railpack needs a `docker` loader.** On a clean host with no `docker` binary, `railpack build` hangs at export. Decide between a documented `podman-docker` prerequisite (plus a `doctor` check) and a `buildctl`-based load path. This is a new prerequisite not covered by the current feature document.
4. **Correct the pinned image tag** to `v0.34.1-rootless` and correct the CLI flag to `--name`.
5. **State/socket ownership:** the daemon must be able to write `<root>/buildkit` and create the socket there; the host side must be able to connect to the socket. The working configuration maps container root to the invoking user, so both are host-user owned.
6. **Cold builds are network-bound** (~4.3 min here, mostly image pulls and apt). Warm builds are ~1.4 s. The streaming contract matters: the cold log produced continuous output throughout.

---

## 8. Machine-readable summary

```json
{
  "task": "BLD-0.1",
  "decision": "pass",
  "host": {
    "os": "Ubuntu 26.04.1 LTS",
    "kernel": "7.0.0-42-generic",
    "arch": "x86_64",
    "podman": "5.7.0",
    "rootless": true,
    "cgroup": "v2/systemd",
    "storageDriver": "overlay",
    "linger": true,
    "apparmorRestrictUnprivilegedUserns": 1
  },
  "railpack": {
    "version": "0.43.0",
    "asset": "railpack-v0.43.0-x86_64-unknown-linux-musl.tar.gz",
    "sha256": "248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb"
  },
  "buildkit": {
    "image": "moby/buildkit:v0.34.1-rootless",
    "digest": "sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89",
    "pullSeconds": 51.35,
    "snapshotter": "overlayfs",
    "socket": "/tmp/opencode/easy-host-bld-0.1/buildkit/socket/buildkitd.sock"
  },
  "requiredFlags": [
    "--user 0",
    "--privileged",
    "--entrypoint /usr/bin/buildkitd",
    "--oci-worker-no-process-sandbox",
    "--addr unix:///run/user/1000/buildkit/buildkitd.sock",
    "-v <state>:/home/user/.local/share/buildkit",
    "-v <socket>:/run/user/1000/buildkit"
  ],
  "privilegedRequired": true,
  "seccompUnconfinedSufficientAlone": false,
  "timings": {
    "coldWallSeconds": 258.53,
    "warmWallSeconds": 1.42,
    "coldRailpackSeconds": 258.46,
    "warmRailpackSeconds": 1.35
  },
  "images": {
    "cold": "localhost/easy-host-vite-spike:20261029T234714Z",
    "warm": "localhost/easy-host-vite-spike:20261029T235139Z",
    "sizeBytes": 157364566
  },
  "smokeTest": { "httpStatus": 200 },
  "dockerfileRequired": false,
  "railpackLoader": "docker load (requires a docker-compatible binary; absent -> hangs at export)",
  "failureModes": [
    "rootlesskit newuidmap Operation not permitted under rootless Podman",
    "apt setgroups gid 65534 EINVAL when exec map lacks 65534",
    "newuidmap EPERM when trying to widen the subuid range",
    "state directory permission denied under --userns=keep-id",
    "buildkitd refuses to run as non-root image user",
    "snapshotter mount operation not permitted without --privileged",
    "railpack build hangs at export when docker loader is absent"
  ]
}
```
