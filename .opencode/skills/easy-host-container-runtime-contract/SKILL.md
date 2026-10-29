---
name: easy-host-container-runtime-contract
description: "Wraps Podman and git calls with argument arrays, finite timeouts, labels, named volumes, restart policy, port publication, and redaction of secrets and URL credentials."
---

# Skill: Keep the easy-host Runtime Calls Safe

Use this skill for any change to `src/platform/podman.ts`, `src/platform/git.ts`, the shared process runner, container flags, labels, named volumes, port publication, log passthrough, or inspect normalization. Every container, build daemon, and repository operation passes through these adapters, so one unsafe call leaks credentials or breaks removal scoping.

The adapter contract is: argument arrays only, a finite timeout on every call, typed results, and diagnostic output that never contains environment values or URL credentials.

## Invariants

- Never build a shell string. Pass `argv` arrays to `execa` (or the injected runner) with `shell: false`.
- Every external call has an explicit finite timeout: git, podman, railpack, buildkitd, and probes.
- App container: name `easy-host-<app>`, `--restart=always`, publish `<bind>:<port>:<containerPort>`, `PORT=<containerPort>`, labels `io.easy-host.app=<app>`, `io.easy-host.role=app`, `io.easy-host.image=<image>`.
- Volumes are named `easy-host-<app>-<volume>` and labelled `io.easy-host.app=<app>`; never bind-mount host paths in v1.
- BuildKit container is infrastructure: `io.easy-host.role=buildkit`, `--restart=unless-stopped`, never listed as an app.
- No `--privileged`, host networking, or extra capabilities for app containers.
- Environment values are passed to Podman but never printed, logged, or included in errors.
- Credentials embedded in a git URL are redacted before any message or log line.

## Process

### Step 1: Identify the operation and its owning requirement

Read the relevant part of `docs/features/04-add-and-lifecycle.md` (run, volumes, logs), `03-app-registry-and-config.md` (labels and naming), `05-update-and-health-gate.md` (swap), `06-rollback-and-remove.md` (scoped deletion), or `02-buildkit-and-railpack.md` (daemon).

If the operation needs a new Podman flag, then check the pinned Podman floor (`>= 5.7.0`) and record the flag in the operations guide rather than assuming a newer release.

### Step 2: Add a typed adapter method, not an inline call

Add the method to the runtime interface with a typed input and a normalized output. Never call `podman` directly from lifecycle code; the adapter owns argument construction, timeout, exit-code mapping, and inspect normalization.

Compose the argument array in the documented order and assert it exactly in a test. For `run`, the array contains restart, name, publish, `PORT`, env, volumes, and labels exactly once each.

By default, pass merged environment with repeated `-e KEY=VALUE` arguments. Values are therefore visible in the host process list while `podman run` executes, so if that exposure is unacceptable for a secret-bearing app, use Podman's `--env-file` with a `0600` temp file and unlink it in `finally`; do not fall back to a shell string.

**Output:** interface method, argument builder, typed result, and error mapping.

### Step 3: Enforce redaction at the boundary

Redact before constructing any message:

- URL userinfo (`https://user:token@host/...` becomes `https://***@host/...`).
- Any env key whose name matches `secret`, `token`, `password`, or `key`.
- Full environment dumps; log only key names when needed.

If a failure carries stderr from Podman, then pass it through the same redactor before rendering. Build output may stream raw lines to stderr, but never a command line that includes an env value.

### Step 4: Test with a recording runner

Unit tests must not require Podman or network. Use the recording fake runner and assert the exact argv, timeout, redaction, and exit mapping.

```bash
npm run typecheck
npm test -- tests/unit/podman.test.ts
npm test -- tests/unit/git.test.ts
npm test -- tests/unit/buildkit.test.ts
```

Cover: full and minimal run arrays, a volume mount, log passthrough with `-f` and `--tail`, inspect normalization, a missing container, a timeout, a non-zero exit, a URL credential, and an env value that must not appear.

### Step 5: Keep cleanup label-scoped

Every delete resolves the target by inspecting labels first. A foreign container or volume is reported, not deleted. `logs` is a passthrough: forward flags and exit with Podman's code, without buffering the stream.

**Output:** adapter change plus the label-scoped delete behavior it enables.

## Gotchas

- **`--restart=always` is ineffective without lingering.** The adapter sets the policy; doctor owns the prerequisite. Do not silently substitute a different policy.
- **Publishing the wrong side of the colon silently exposes the container port.** `-p <bind>:<hostPort>:<containerPort>`; a two-part publish binds a random host port.
- **`PORT` is the container port, not the host port.** Setting it to the host port makes the app listen where Podman does not forward.
- **A label is the deletion scope.** Deleting by name prefix can remove a foreign resource that happens to match `easy-host-*`.
- **`execa` with a shell string interpolates user input.** Even quoted values break on newlines; use the array form.
- **Missing timeouts hang a timer.** A `podman logs -f` without a timeout is intentional only for interactive follow; all non-interactive calls need a bound.
- **Inspect output is not stable across Podman minors.** Normalize the fields you need and fail as `unknown` rather than parsing the whole document.
- **A stopped container still exists.** `stop` and `rm` are distinct; cleanup must not assume `stop` removed it.

## Validation

Self-check with an observable argv and a planted secret:

- [ ] `tests/unit/podman.test.ts` asserts the exact full `run` array including restart, publish, `PORT`, volume, and labels.
- [ ] `tests/unit/git.test.ts` asserts `https://user:token@host/repo` renders as `https://***@host/repo` in every failure message.
- [ ] A planted `DATABASE_URL` value never appears in stdout, stderr, or a thrown error.
- [ ] Every adapter method passes a finite `timeout` to the runner.
- [ ] A delete call on a foreign container or volume returns a report and performs no removal.

If a call cannot be bounded, do not add it to the adapter; redesign the operation. Load [references/runtime-argv.md](./references/runtime-argv.md) when you need exact argv shapes, label keys, timeouts, or exit mapping.
