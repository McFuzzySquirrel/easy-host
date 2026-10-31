---
id: ADR-0008
applies_to:
  - "src/cli/errors.ts"
  - "src/cli/json.ts"
  - "src/cli/format.ts"
status: Accepted
---

# ADR-0008: Treat exit codes and the JSON document as a public contract

- **Deciders:** mcfuzzysquirrel (maintainer)
- **Date:** 2026-10-31

**Technical Story:** `PRE-FR-05`, `PRD-NF-02`, `PRD-NF-10`

## Agent Rules

- **MUST:** map every expected failure to exactly one of the eight exit codes: `0` success, `1` usage, `2` prerequisite, `3` build, `4` health, `5` not found, `6` conflict or lock held, `7` internal.
- **MUST:** keep the JSON success documents at `schemaVersion: 1` with stable field names and empty arrays present, written as exactly one document to stdout.
- **MUST:** write human progress, warnings, and errors to stderr, and never mix them into JSON stdout.
- **MUST:** redact environment values, secrets, and URL credentials in both human and JSON output; `[redacted]` is the only placeholder.
- **MUST NOT:** renumber an existing exit code or rename a published JSON field without updating the references and announcing a contract change.
- **MUST NOT:** depend on colour to carry meaning; emit no ANSI escapes when stdout is not a TTY, when `NO_COLOR` is set, or when `TERM=dumb`.
- **SHOULD:** give every failure a stable diagnostic `code` and a remediation command.

## Verify

- **Check:** `npm test -- tests/unit/errors.test.ts tests/unit/json.test.ts tests/docs/reference.test.ts`
- **Expected:** every error class maps to its documented code; the reference table matches `EXIT_CODES`; JSON output carries `schemaVersion: 1` and no secret values; non-TTY output contains no escapes.

## Context and Problem Statement

Operators wire `easy-host` into shell scripts and systemd timers, where the only reliable signal is the exit status and, for richer cases, a machine-readable document. Ad-hoc error codes and free-form messages make automation guess. How stable should the machine interface be, and where does human text go?

## Decision Drivers

- Automation needs a small, documented set of outcomes that never shift.
- Secrets must not leak into logs, JSON, or error text.
- Terminal output must stay readable and accessible without colour.
- A single shared surface keeps every command consistent.

## Considered Options

- Exit `1` for every failure and free-form messages.
- Per-command exit codes chosen as needed.
- One shared eight-code taxonomy plus a versioned JSON document.

## Decision Outcome

Chosen option: "One shared eight-code taxonomy plus a versioned JSON document", because it makes failures branchable without parsing prose and gives every command the same shape. The cost is that the taxonomy becomes a compatibility promise: adding a code or renaming a field is a breaking change.

### Positive Consequences

- A timer can distinguish "build failed" from "unhealthy" without reading stderr.
- JSON consumers get one document, one schema version, and redacted secrets.
- Human output stays on stderr, so piping JSON stdout is safe.

### Negative Consequences

- The exit-code and JSON field names are frozen; improving them requires a migration.
- The eight codes cannot express every nuance, so the diagnostic `code` carries the detail.
- `logs` is an explicit exception: a nonzero Podman exit status passes through unchanged.

## Pros and Cons of the Options

### Exit `1` for everything

- Good, because it is trivial to implement.
- Bad, because automation cannot tell a bad flag from a failed build or an unhealthy app.

### Per-command codes

- Good, because each command can describe its own failures precisely.
- Bad, because the same number means different things across commands, and documentation drifts per command.

### Shared taxonomy plus JSON

- Good, because it is consistent, documented, and testable against the code.
- Bad, because it is a public contract that must be versioned and announced.

## Links

- Implemented by `src/cli/errors.ts`, `src/cli/json.ts`, `src/cli/format.ts`.
- Documented in the [CLI reference](../reference/cli.md#exit-codes).
- Related: [ADR-0007](0007-ten-command-surface.md).
