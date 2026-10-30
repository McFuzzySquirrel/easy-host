# v0.1.0 Release Gate — RBK-1.6

Reviewer: mcfuzzysquirrel
Date: 2026-10-30
Host: Ubuntu 26.04.1 LTS (Resolute Raccoon), Linux 7.0.0-1020-raspi, aarch64, Podman 5.7.0 rootless, Linger=yes
Node: v24.22.2
Git: 2.53.0
Commit under test: `bc50ae9cd96e12adf2c3b94635b076a18b67910a`
State root: `/home/mcsquirrel/easy-host-v1-gate` (absent and empty at start)

Scenarios were executed over SSH from a second LAN host
(`192.168.8.11`, the machine holding the repository); that host is the
"second machine" for every reachability check below. Every command, exit code
and wall-clock value in this file was captured on the gate host.

## Host proof

```
$ uname -a
Linux mcsquirrel 7.0.0-1020-raspi #20-Ubuntu SMP PREEMPTED Fri Sep 11 16:02:28 UTC 2026 aarch64 GNU/Linux

$ node -v
v24.22.2

$ git --version
git version 2.53.0

$ podman --version
podman version 5.7.0

$ podman info --format '{{.Host.Security.Rootless}}'
true

$ loginctl show-user "$USER" -p Linger
Linger=yes

$ export EASY_HOST_HOME="$HOME/easy-host-v1-gate"
$ ls -la "$EASY_HOST_HOME" 2>/dev/null || echo "state root absent (empty)"
state root absent (empty)
```

`podman ps -a`, `podman images` and `podman volume ls` were all empty before the
first `add`, and no easy-host labelled resource existed.

`easy-host doctor` after `add` (the checklist requires no `fail` rows):

```
10 checks: 10 passed, 0 warnings, 0 failed, 0 skipped.
Result: pass
```

## Scenario 1 — Add and LAN reachability — PASS

Commands (on the gate host):

```
$ easy-host add "file://$HOME/srv/git/demo.git" --name demo --port 8080 --yes
$ echo $?
```

Observed (stdout):

```
added "demo"
  url:        http://localhost:8080/
  source:     file:///home/mcsquirrel/srv/git/demo.git at main (051638df0055)
  container:  easy-host-demo (running)
  image:      localhost/easy-host-demo:20261030T190834Z
  previous:   none (first version)
  health:     healthy after 2 attempt(s) via http://127.0.0.1:8080/
```

Exit code: `0`. Wall clock: `wall=311.11s` (of which the Railpack build itself
was 254.62s; the rest is the Railpack download, the BuildKit image pull and the
first `npm install`).

From the second machine, not the gate host:

```
$ curl -fsS http://192.168.8.18:8080/
{"status":"ok","service":"express-api"}
```

Negative control, same port, on the second machine's own loopback:

```
$ curl -fsS http://127.0.0.1:8080/
curl: (7) Failed to connect to 127.0.0.1 port 8080 after 0 ms: Could not connect to server
```

`easy-host list --json` and `easy-host status demo --json` were captured; both
report `status: healthy`, `restartPolicy: always`, `0.0.0.0:8080->3000/tcp`,
`drift.class: none`.

## Scenario 2 — Reboot recovery — PASS

Pre-reboot:

```
boot_id:  603f0365-8b71-4901-96cf-eac21d22bfc7
container: state=running  started=21:12:49 SAST  restart=always
podman-restart.service: enabled
```

The host was rebooted with `ssh -t mcsquirrel@192.168.8.18 sudo reboot`. No
`easy-host` command was run between the reboot and the first successful
response.

First probe from the second machine:

```
[2026-10-30T19:14:32Z] SERVING: {"status":"ok","service":"express-api"}
```

After the host returned:

```
boot_id:  81ceff49-6842-4fcc-9283-56d161050323      (changed: real reboot)
booted_at: 2026-10-30 21:14:03 SAST
easy-host-demo Up 25 seconds 0.0.0.0:8080->3000/tcp
state=running  started=21:14:11 SAST  restart=always

● podman-restart.service - Podman Start All Containers With Restart Policy Set To Always
     Loaded: loaded (/usr/lib/systemd/user/podman-restart.service; enabled; preset: enabled)
     Active: active (exited) since Fri 2026-10-30 21:14:11 SAST
    Process: 1605 ExecStart=/usr/bin/podman $LOGGING start --all --filter restart-policy=always (code=exited, status=0/SUCCESS)
```

Wall clock: kernel boot `21:14:03` → container started `21:14:11` (8s) →
first successful LAN response `21:14:32` (29s after boot).

## Scenario 3 — Broken update keeps the previous version serving — PASS

```
$ git push origin <broken>:main
   051638d..6a5be76  6a5be766676876206a4ea93961c55320671bbcd0 -> main

$ time easy-host update demo
$ echo $?
4
```

Observed error (abridged to the operator-facing block):

```
easy-host: update of "demo" failed; the previous version is serving again
  app:       demo
  stage:     probe
  candidate: localhost/easy-host-demo:20261030T191443Z
  reason:    timed out after 0.030663999990792945 ms after 46 attempt(s)
  previous:  localhost/easy-host-demo:20261030T190834Z is serving again
  restored:  true
  state:     reverted
  health:    healthy
```

Failure class: **health failure, exit 4** (not a build failure). The build
succeeded in ~9s; the container started and then died, so the readiness probe
was the gate.

Afterwards, from the second machine:

```
$ curl -fsS http://192.168.8.18:8080/
{"status":"ok","service":"express-api"}
```

`easy-host status demo --json` recorded the failed candidate while keeping
`images.current` on the previous image. Wall clock: `wall=128.30s`.

## Scenario 4 — Rollback and second rollback — PASS

Two images were established by a successful v2 update first:

```
$ time easy-host update demo          # main -> v2
updated "demo" (rebuild)
  image:      localhost/easy-host-demo:20261030T191659Z
  previous:   localhost/easy-host-demo:20261030T190834Z
  health:     healthy after 2 attempt(s)
wall=10.95s
```

`update: retention retained: kept 2 image(s), removed 1, refused 0`

Then a broken update (exit 4, `state: reverted`, `wall=101.46s`), then:

```
$ time easy-host rollback demo
ROLLBACK1_EXIT=0
  restored:   localhost/easy-host-demo:20261030T190834Z
  rollback:   localhost/easy-host-demo:20261030T191659Z
wall=3.35s

$ curl -fsS http://192.168.8.18:8080/
{"status":"ok","service":"express-api"}          # v1 marker

$ time easy-host rollback demo
ROLLBACK2_EXIT=0
  restored:   localhost/easy-host-demo:20261030T191659Z
  rollback:   localhost/easy-host-demo:20261030T190834Z
wall=3.45s

$ curl -fsS http://192.168.8.18:8080/
{"status":"ok","service":"express-api-v2"}       # v2 marker
```

`rollback: inspecting: ... no build is required` in both runs; no BuildKit
build occurred. Status JSON showed `current`/`previous` swapping each time
(`190834Z`↔`191659Z`), and the first rollback pruned the leftover failed
candidate (`retention removing: ... 191710Z`, 3 → 2 images).

Rollback with a single recorded image (exit 5) was not exercised here; it is
covered by `tests/integration/rollback.test.ts` as the checklist allows.

## Scenario 5 — Remove, volume retention and deletion — PASS

Re-added with a declared volume, then a proof file written inside it:

```
$ easy-host add file://.../demo.git --name demo --port 8080 --volume demo-data:/data --yes
ADD_EXIT=0
$ podman exec easy-host-demo sh -c 'echo gate > /data/proof.txt'
proof_written
```

```
$ time easy-host remove demo --force
REMOVE_EXIT=0
removed "demo"
  container:  easy-host-demo (removed)
  images:     1 removed: localhost/easy-host-demo:20261030T192116Z
  workspace:  /home/mcsquirrel/easy-host-v1-gate/apps/demo/workspace (deleted)
  app dir:    /home/mcsquirrel/easy-host-v1-gate/apps/demo (deleted)
  volumes:    easy-host-demo-demo-data (kept)
  next:       podman volume rm easy-host-demo-demo-data
wall=2.57s
```

Post-conditions:

```
podman ps -a --filter label=io.easy-host.app=demo      -> (empty)
podman images | grep ^2026                             -> (none)
ls -A $EASY_HOST_HOME/apps                             -> (empty)
podman volume ls --filter label=io.easy-host.app=demo  -> easy-host-demo-demo-data
podman run --rm -v easy-host-demo-demo-data:/data:ro alpine cat /data/proof.txt
gate
```

Volume deletion, foreign volume and non-TTY confirmation:

```
$ easy-host remove demo --volumes --force
  volumes:    easy-host-demo-demo-data (deleted)
podman volume ls | grep demo-data                      -> (volume gone)

$ podman volume create easy-host-demo-foreign
$ easy-host remove demo --volumes --force
REMOVE_FOREIGN_EXIT=0
  volumes:    easy-host-demo-demo-data (deleted)
  refused:    easy-host-demo-foreign (unlabelled)
podman volume ls                                       -> easy-host-demo-foreign

$ easy-host remove demo < /dev/null          # no --yes, no --force
REMOVE_NOTTY_EXIT=1
easy-host: remove of "demo" requires confirmation; stdin is not a terminal and --yes was not passed
  next: Nothing was deleted. Re-run "easy-host remove demo --yes" to proceed, ...
container still running: easy-host-demo
app dir still present: yes
```

## Deviations / surprises

1. **Host is not a disposable VM/LXC/cloud machine.** It is the Pi 5 (16 GB)
   running Ubuntu 26.04.1 **Desktop** with an active GNOME session and two
   logged-in users. The substantive requirement — no existing easy-host
   containers, images or state — was met exactly: Podman storage and the state
   root were empty before the first `add`.

2. **Repository path differs from the checklist.** The host has no passwordless
   sudo, so `/srv/git/demo.git` was replaced by `~/srv/git/demo.git`
   (`file:///home/mcsquirrel/srv/git/demo.git`). The bare repo, its three
   commits (v1 `051638d`, v2 `5484590`, broken `6a5be76`) and the force-push
   choreography are otherwise as written.

3. **Node.js was upgraded out of band.** Ubuntu 26.04 ships Node v20.19.4,
   below the required 24. Node v24.22.2 was installed user-locally under
   `~/.local/share/node24` (no system packages touched); `npm link` then
   provided `easy-host` on `~/.local/bin`.

4. **`podman-docker` had to be installed.** Railpack exports the image through
   `docker load`; without the shim every build reached the export step and
   then stalled. Before that fix this cost a 30-minute build timeout per
   attempt (`reason: docker-loader-unavailable`).

5. **`sudo` was required twice, and both were operator actions:** enabling
   lingering (self-enabled through polkit on an active local session) and
   installing `podman-docker`. Rebooting the host also required the operator,
   since remote `systemctl reboot` needs interactive authentication.

6. **The task text says "four success scenarios" but enumerates five actions,
   and PRD §6.2 lists five numbered criteria.** Five scenarios are recorded
   above.

7. **Five product defects were found and fixed during this gate**, each
   committed before the passing run above; the passing run is against
   `bc50ae9`, which contains all of them:
   - `6aa11e7` — rootless `--restart=always` never survived a reboot because
     nothing enabled `podman-restart.service`; proven with a throwaway
     container that came back `Exited (0)` after a real reboot with
     `Linger=yes`.
   - `498cc5c` — `add`, `update`, `rollback`, `remove` and `logs` were
     `not implemented` stubs, so the gate could not start at all.
   - `0511aed` — doctor did not check for a docker-compatible image loader, so
     `add` passed every prerequisite and then failed after a full build.
   - `bc50ae9` — Railpack-built images carried no labels, so retention listed
     `0 labelled image(s)` and silently kept nothing, and `remove` deleted only
     the recorded pair. Observed before the fix: four images for one app after
     one add, three updates and two rollbacks, two of which survived
     `remove --force`.

8. **Cosmetic, not gate-blocking:** the failed-update error reports
   `timed out after 0.030663999990792945 ms`, an implausible deadline figure
   (the startup budget is 90 000 ms). The behaviour is correct — 46 attempts
   then revert — but the rendered duration is wrong.

9. **Residual behaviour, recorded rather than fixed:** a failed update leaves
   its candidate image on disk until the next successful update or rollback
   runs retention (observed as 3 images after the broken update, pruned back to
   2 by the following rollback). Repeated failing updates without an
   intervening success will accumulate one image each.

10. **Unrelated test flake:** `tests/unit/swap.test.ts > cuts off a hung
    candidate probe at the startup budget and reverts` fails under full
    parallel load (it asserts a 20 ms budget completes within 1000 ms) and
    passes in isolation and with `--no-file-parallelism`. All 809 unit tests
    pass serially.
