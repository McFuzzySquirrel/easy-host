---
name: easy-host-cli-command-contract
description: "Adds or changes easy-host commands while preserving the ten-command surface, stable exit codes, flag parity, JSON schemaVersion 1, TTY and NO_COLOR behavior, and secret-safe output."
---

# Skill: Preserve the easy-host CLI Command Contract

Use this skill whenever a command, flag, exit code, error message, JSON payload, or table changes in easy-host. It keeps the command surface, machine contract, and operator-visible output consistent across `cli-engineer`, `lifecycle-engineer`, and `docs-engineer`.

The contract lives in code (`src/cli/program.ts`, `src/cli/errors.ts`, `src/cli/json.ts`, `src/cli/format.ts`) and is frozen by tests. Treat a change to it as a public API change, not a refactor.

## Invariants

- Exactly ten commands: `add`, `list`, `status`, `logs`, `update`, `rollback`, `remove`, `config`, `doctor`, `version`. Never register `start`, `stop`, `restart`, `prune`, `completion`, or a daemon.
- Exit codes: `0` success, `1` usage/validation, `2` prerequisite/environment, `3` build, `4` health, `5` app not found, `6` conflict or lock held, `7` unexpected.
- `--json` exists for read-only commands only (`list`, `status`, `doctor`, `config`, `version`); mutating commands communicate through exit code plus the human report.
- Machine output goes to stdout as exactly one document; progress, warnings, and narration go to stderr.
- Every prompt has a flag equivalent, and a non-TTY run never prompts.
- Never print a secret value, an environment value, or credentials embedded in a URL.

## Process

### Step 1: Locate the owning requirement and the current definition

Read the requirement ID in the owning feature document before editing: `docs/features/01-prerequisites-and-doctor.md` for the surface, errors, and doctor; `04-add-and-lifecycle.md` for read commands; `07-observability-and-output.md` for JSON, TTY, and drift; `08-docs-and-packaging.md` for help, references, and completions.

Inspect the current definitions and their tests. If the requirement does not exist, then stop and hand the gap to the PRD owner instead of inventing a command or flag.

**Output:** the requirement ID, the files you will touch, and whether the change is registration, error mapping, or output shape.

### Step 2: Classify the change before writing code

- Registration or flag change → update `program.ts`, the command handler, tests, then hand off completions and reference docs.
- New failure mode → add or reuse a typed error in `errors.ts`; never return a bare `Error`.
- New machine field → update `json.ts` and the schema tests; additive fields are allowed, renames need a `schemaVersion` bump.
- Human rendering only → update `format.ts` and keep the JSON path untouched.

If the change would add an eleventh command, then propose a flag or reuse `update`/`rollback` instead. The surface is a settled PRD decision.

### Step 3: Implement types and errors first, then behavior

Define the typed error class, exit code, remediation command, and structured details before wiring the command. Render failures through the shared renderer so summary, detail, and remediation stay on separate lines.

Apply these rules in order:

1. Validate input and preflight state before any filesystem or process mutation.
2. Emit machine output only on stdout, once, with no ANSI escapes.
3. Redact any detail whose key matches `secret`, `token`, `password`, or `key`, and any URL userinfo.
4. Keep `EASY_HOST_DEBUG=1` as the only path that shows a stack trace.

**Output:** command behavior plus the exact exit code for every failure branch.

### Step 4: Freeze the change with tests

Use the recording process runner and temporary roots; unit tests must run with no Podman and no network. Assert the exact command list, flag names, error class, exit code, JSON top-level shape, absence of ANSI escapes, and that a planted secret never appears.

By default, run the focused test file first. If that fails, fix the module before running the full suite.

```bash
npm run typecheck
npm run lint
npm test -- tests/unit/program.test.ts
npm test -- tests/unit/errors.test.ts
npm test -- tests/unit/json.test.ts
npm test -- tests/unit/format.test.ts
```

### Step 5: Propagate contract changes to consumers

Announce any command, flag, exit-code, JSON, config-key, or file-mode change before it lands. Hand completion generation and reference documentation to the packaging/docs skill rather than editing generated files here.

**Output:** a short contract-change note listing what changed, which consumers are affected, and the validation evidence.

## Gotchas

- **Commander exits 0 on unknown input unless configured.** Explicitly map unknown commands and missing required arguments to exit `1`; otherwise a typo silently succeeds in a timer.
- **`status --json` still exits `4` for an unhealthy app.** Callers rely on the code, not the document, to detect bad health.
- **`--json` must not leak narration.** Writing a progress line to stdout makes the document unparseable; move it to stderr.
- **Color is not status.** A stopped app must print `stopped` or `missing` even when color is unavailable or `NO_COLOR` is set.
- **A held lock is not a usage error.** It is exit `6`; exit `1` tells a monitor to stop retrying.
- **`remove` without `--yes` on a non-TTY must fail before deleting anything.** The confirmation check precedes the first delete, not the last.
- **`status <unknown>` is exit `5`, not `1`.** Not-found and bad-argument paths drive different automation.

## Validation

Self-check before handing off:

- [ ] `node dist/cli/index.js --help` lists exactly the ten commands and every documented flag.
- [ ] `node dist/cli/index.js doctor --json | jq .schemaVersion` prints `1` with no ANSI escapes.
- [ ] `npm test -- tests/unit/program.test.ts tests/unit/errors.test.ts` passes with no Podman and no network.
- [ ] A planted secret value does not appear in human output, `--json` output, or the error renderer.
- [ ] Every new prompt has a flag equivalent and the non-TTY path names the missing value.

If a check fails, revert the contract change rather than adjusting the test to match it. Load [references/cli-contract.md](./references/cli-contract.md) when you need the full exit-code table, command/flag matrix, or JSON and error-shape rules.
