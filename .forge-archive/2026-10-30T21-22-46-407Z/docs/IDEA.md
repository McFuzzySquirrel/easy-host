# Project Idea — easy-host

> Sharpened on 2026-10-29 from the original idea below via `/forge-grill-idea`.
> This file records settled decisions only; it is not a PRD.

## The original idea (verbatim)

The idea it to have a podman container that you can connect to and install your local app from a repo to that would normally run in local host on your machine, but will now act as a self host in  the container with a defined port that can be accessed

Read literally: take an app from a repo, run it inside a Podman container as a
self-hosted service on a known port, instead of running it on the host.

## What it is

**easy-host** is a Linux CLI that turns a git repository into a running,
self-hosted service on a single machine, using rootless Podman and Railpack. You
give it a repo URL; it clones, builds an image with no per-repo Dockerfile,
runs it with a restart policy on a port you declare, keeps the last two versions
for rollback, and tells you whether the thing is actually healthy.

## Problem and user

One operator running apps **24/7** on a single Linux host — a homelab box or a
VPS — who does not want to author and maintain a Dockerfile per project, and
does not want a platform. The pain is the gap between "I have a repo" and "it is
a service that survives reboots and updates cleanly": writing container files,
remembering run flags, hand-rolling restarts, and having no rollback when a
deploy goes bad.

This is a **hosting** tool, not a local development loop. Fast edit-rebuild
cycles are explicitly not the goal; uptime, clean updates, and rollback are.

## The differentiator

Zero-Dockerfile repo → running service on a defined port. No per-repo container
authoring, no compose file, no platform.

Honest caveat: the build/detection work is delegated to Railpack. The value of
this project is the hosting and lifecycle layer around the build — clone,
build, swap, health, rollback, remove — not the build heuristics themselves.

## Settled decisions

| Area | Decision |
| --- | --- |
| App scope | Any repo that starts an HTTP server and is opened at a URL. Only stacks that have actually been tested are claimed as supported. |
| Build | Delegate detection and image building to **Railpack** (MIT, Nixpacks successor; Nixpacks itself is in maintenance mode). Requires BuildKit. |
| Repo input | Git URL plus branch/ref is the primary input. A local path is a secondary, explicitly-marked development mode. |
| Workspace | Repos are cloned into a tool-owned workspace directory on the host and mounted into builds — never baked into an image layer or hidden in an opaque volume. |
| Architecture | **Image per app**; each app runs as a container with `--restart=always`. No long-lived "pet" container that you `exec` into and install into. |
| Deployment model | Many apps per host, tracked in a plain on-disk registry. No database, no scheduler, no clustering, one host only. |
| Surface | **CLI only.** |
| Access | One explicit host port per app, bound on the LAN. No TLS, no bundled reverse proxy; internet exposure and HTTPS are the operator's responsibility. |
| Configuration | One per-app config file on the host declaring repo/ref, port, build settings, environment variables, and volume mounts. Injected at run time; changing config does not require rebuilding the build context semantics beyond a normal update. |
| Secrets | Plain files with `0600` permissions. No secret manager, no encryption at rest. |
| Updates | Manual `update` command. Build the new image first, swap the container only on success. A failed build leaves the old version running. No daemon, no webhook, no git polling — a systemd timer calling the CLI is the user's own choice. |
| Dependencies | The tool never provisions databases or sidecar services. Apps reach external services through environment variables. |
| History | Keep the last 2 images per app and expose `rollback`. |
| Removal | `remove` deletes the container, workspace, and images, but **never** a declared volume unless `--volumes` is passed explicitly. |
| Health | "Running" means the container is up **and** an HTTP/TCP probe against the declared port succeeds within a timeout. A failing probe during `update` keeps the old version serving. |
| Observability | `podman logs` passthrough only. No log storage, no metrics, no alerting. |
| Language | TypeScript CLI. Requiring a Node runtime on the host is an accepted cost. |
| Platform | Linux only, rootless Podman. Rootless lingering must be enabled for `--restart=always` to survive reboot; this is a documented prerequisite, not an assumption the tool can make. |
| Name | **easy-host** (replaces `react-hoster`; the repository rename itself is a manual step outside this work). |

## Non-goals

- Web UI or dashboard.
- Multi-node operation, scheduling, or clustering.
- Provisioning databases or sidecar services.
- Multi-service / compose-style stacks.
- TLS, certificates, or a bundled reverse proxy.
- Pet containers or `exec`-into-the-box install workflows.
- Kubernetes or any orchestrator integration.
- CI/CD platform behavior.
- Multi-tenant hosting.
- Non-Linux hosts, including macOS and Windows via Podman machine.
- Auto-detecting which paths an app needs to persist.
- Secret management or encryption.
- Metrics, alerting, or log storage.

## Success signals

Version 1 is done when this scenario passes on a fresh Linux host with rootless
Podman and an empty configuration:

1. `add <git-url>` results in the app reachable at `http://<host>:<port>` on the LAN.
2. Rebooting the host brings the app back without manual intervention.
3. Pushing a broken commit and running `update` leaves the previous version serving.
4. `rollback` restores the previous image and it serves again.

## Constraints and risks

- **BuildKit under rootless Podman is the top technical risk.** The installed
  environment is Podman 4.9.3, rootless. If Railpack cannot drive BuildKit there,
  the "any repo" premise collapses to a hand-maintained stack allowlist.
- **Scope of "any repo" is only as wide as Railpack's support**, so a tested-stack
  list is required from day one.
- **Updates are full rebuilds**, measured in minutes, not seconds.
- **Four of five grilling rounds were accepted without contest.** The main risk is
  that this idea is under-tested in practice rather than under-specified on paper.
- **Name drift:** the repository is still `react-hoster` until renamed, and
  `README.md` still describes a React-only hoster.

## Open questions

- **Config file format** (TOML / YAML / JSON) — implementation detail for the PRD.
- **TypeScript distribution** (npm package vs. Node SEA single binary) — affects
  the install story, not the idea.
- **Registry file location and format details** — implementation.
- **Exact supported-stack list** — only knowable after the BuildKit spike and the
  first real builds.
- **CLI ergonomics** — ungrillable by conversation; `add` / `update` / `rollback`
  / `remove` must be used in daily practice before they can be judged.
- **Does Railpack drive BuildKit under rootless Podman 4.9.3?** — ungrillable. The
  smallest thing that settles it is a throwaway spike: one `railpack build` of a
  Vite repo against BuildKit in a rootless Podman container, on the target host.
  This should happen before a PRD is treated as buildable.

---

> Originally generated by forge-launcher on 2026-10-29T20:00:10Z.
> Next step: `@workspace /forge-build-prd Use docs/IDEA.md as the project idea`
