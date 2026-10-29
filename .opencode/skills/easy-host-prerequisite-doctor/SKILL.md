---
name: easy-host-prerequisite-doctor
description: "Adds or changes doctor checks for Podman version and rootless mode, lingering, git, Node, disk, Railpack, and BuildKit with ordered pass, warn, fail, and remediation output under a no-network time budget."
---

# Skill: Extend easy-host Doctor

Use this skill when adding, reordering, or changing a `doctor` check, its JSON shape, threshold, or remediation line. Doctor is the first command an operator runs and the check that prevents confusing build failures, so a wrong pass is worse than a missing check.

Doctor is read-only infrastructure diagnosis: no network, no daemon start, no download, no install, and no mutation.

## Invariants

- Checks are ordered and stable: Podman presence, Podman version and rootless mode, lingering, git, Node, disk, Railpack, BuildKit.
- Each result is `pass`, `warn`, `fail`, or `skip`, with a detail line and a remediation line for every non-pass.
- Any `fail` exits `2`; all pass or warn exits `0`; a `skip` never becomes a pass.
- Supported Podman range is `>= 5.7.0, < 6.0.0`; 6.x is rejected while the 6.x line is unstable.
- Disk: warn below 5 GiB free, fail below 2 GiB free. Sizes are approximate and labelled.
- Doctor performs no network calls, starts no buildkitd, and downloads no Railpack.
- Budget is under 2 seconds on a healthy host, measured with injected time in tests.

## Process

### Step 1: Read the check's owning requirement and current implementation

Read the relevant requirement in `docs/features/01-prerequisites-and-doctor.md`, `02-buildkit-and-railpack.md` (build checks), or `07-observability-and-output.md` (disk). Inspect `src/doctor/index.ts`, `checks.ts`, `build-checks.ts`, `disk-checks.ts`, and the command handler `src/cli/commands/doctor.ts`.

If the check needs the network, a daemon start, or an install, then it does not belong in doctor; return a `skip` with a remediation pointing at the command that would do it.

### Step 2: Define the check as a pure, injectable unit

Give the check an ID, human label, severity, and a function that returns status, detail, remediation, and optional structured data. Inject the process runner, clock, filesystem probes, and size readers so tests need no Podman and no network.

Version parsing must compare numeric components, not strings: `5.10.0` is newer than `5.7.0`, and `6.0.0` is out of range. Rootless detection reads Podman's reported mode rather than assuming the invoking user.

**Output:** one check module plus the exact detail and remediation text for each status.

### Step 3: Place the check in the stable order and reuse shared probes

Add the check to the composition in `index.ts` at the documented position. Reuse the build layer's Railpack and BuildKit probes instead of duplicating version or socket logic, and reuse the packaging/docs reference update for any new check name.

If a check is slow or optional, then mark it `warn` or `skip` rather than deleting it; operators need to see that it was not evaluated.

### Step 4: Update both renderers together

Human output prints the ordered report with text status labels to stdout. `--json` emits one document with `schemaVersion: 1`, a `checks` array carrying the same IDs, statuses, details, remediation, and an overall status. No ANSI escapes in JSON, and no color-only meaning in human output.

**Output:** human and JSON paths updated in the same change.

### Step 5: Prove each boundary

```bash
npm run typecheck
npm test -- tests/unit/doctor.test.ts
npm test -- tests/unit/doctor-build.test.ts
npm test -- tests/unit/doctor-disk.test.ts
```

Cover: Podman missing, 4.9.3, 5.7.0 rootless, 5.8.9 rootless, 6.1.4, non-rootless; linger disabled; git 2.39 and 2.40; Node below and at minimum; disk 4 GiB, 6 GiB, 1 GiB; Railpack missing and version mismatch; BuildKit socket unreachable; all-pass; JSON shape; fake-clock budget.

By default, assert the ordered array of check IDs so a reorder is a test failure. If that is too brittle for an optional check, assert relative order instead.

## Gotchas

- **String comparison accepts Podman 6.x.** Parse numeric components; a lexicographic check also misranks 5.10.0.
- **A non-rootless Podman still reports a version.** Rootless must be a separate condition with its own remediation.
- **`loginctl` output differs by systemd version.** Parse the `Linger=` property, not free-form text, and report a `warn` when the command is unavailable rather than a crash.
- **A failed inspect is unknown, not healthy.** The same rule as drift: unavailable measurement is not zero and not pass.
- **Doctor must not start buildkitd.** Checking reachability by starting it turns diagnosis into mutation and breaks the time budget.
- **Warn does not fail the exit code.** A full disk warning is `0`; below 2 GiB is `2`.
- **JSON field drift breaks monitors.** Add fields; never rename `checks`, `status`, `detail`, or `remediation` without a schema bump.

## Validation

Self-check before handing off:

- [ ] `node dist/cli/index.js doctor --json | jq '.checks[].id'` lists the checks in the documented order.
- [ ] `node dist/cli/index.js doctor` exits `0` on a healthy host and `2` when any check is forced to fail.
- [ ] A failing check prints a remediation line that is a runnable command or an exact settings change.
- [ ] `npm test -- tests/unit/doctor.test.ts` covers 4.9.3, 5.7.0, 5.8.9, and 6.1.4 with the expected exit codes.
- [ ] The fake-clock budget test confirms doctor completes under 2 seconds with no network call.

If a check cannot be evaluated, report `skip` with the reason; never convert it to `pass`. Load [references/doctor-checks.md](./references/doctor-checks.md) when you need the check table, thresholds, remediation wording, or JSON shape.
