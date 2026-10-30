# Feature: Observability and Output

## 1. Feature Overview

**Feature Name:** Observability and Output
**Parent Document:** [PRD](../PRD.md)
**Status:** Draft
**Summary:** Makes the tool scriptable and honest: stable JSON for read-only commands, plain output when color is unavailable, drift detection between recorded state and Podman reality, and disk reporting in `doctor`.
**Scope:** `--json` schemas for `list`, `status`, `doctor`, `config`, and `version`; TTY and `NO_COLOR` behavior; drift detection; and disk usage reporting. Log streaming stays a passthrough and is not wrapped.
**Dependencies:** [Add and Lifecycle](04-add-and-lifecycle.md).

---

## 2. Context: Existing System State

Greenfield feature. Feature 04 created the read commands and their human output. This feature freezes the machine-readable contract, adds drift as a first-class concept, and gives `doctor` the numbers an operator needs before a disk fills.

---

## 3. Feature Goals and Non-Goals

### 3.1 Goals

- Let a systemd timer or monitor consume `list`, `status`, and `doctor` without scraping tables.
- Make output accessible: no color-only status, no ANSI escapes when they cannot be rendered.
- Surface the difference between what the tool recorded and what is actually running.
- Make disk growth visible before it becomes an outage.

### 3.2 Non-Goals

- No metrics endpoint, log storage, or alerting.
- No JSON for mutating commands; their contract is the exit code and the human report.
- No log aggregation or rotation.
- No remote or historical telemetry.

---

## 4. User Stories

| ID | Canonical Source | Ownership | Priority |
|----|------------------|-----------|----------|
| OBS-US-01 | [OBS-US-01](#OBS-US-01) | Owns | Should |
| OBS-US-02 | [OBS-US-02](#OBS-US-02) | Owns | Must |
| OBS-US-03 | [OBS-US-03](#OBS-US-03) | Owns | Should |

```forge-requirement
{"id":"OBS-US-01","kind":"story","text":"As a VPS tinkerer, I want JSON output so that my monitoring can read app state without parsing tables."}
```

```forge-requirement
{"id":"OBS-US-02","kind":"story","text":"As a homelab operator, I want status to tell me when a container disappeared or stopped so that I notice drift before a user does."}
```

```forge-requirement
{"id":"OBS-US-03","kind":"story","text":"As an occasional maintainer, I want doctor to show disk usage so that I can clean up before builds fail."}
```

---

## 5. Technical Approach

### 5.1 Impact on Existing Architecture

Adds `src/cli/json.ts`, `src/cli/format.ts`, `src/registry/drift.ts`, and `src/doctor/disk-checks.ts`. Modifies the read commands from feature 04 to route through the formatter and the JSON serializer, and modifies the doctor composition to include the disk group.

### 5.2 New Components

| Path | Responsibility |
|---|---|
| `src/cli/json.ts` | Serialize read-only results with `schemaVersion: 1` |
| `src/cli/format.ts` | TTY detection, `NO_COLOR`, 80-column tables, status labels |
| `src/registry/drift.ts` | Compare recorded state with Podman inspect results |
| `src/doctor/disk-checks.ts` | Image, cache, and workspace usage with thresholds |

### 5.3 Technology Additions

No new dependencies. Uses `picocolors` for color decisions and `podman system df` plus directory sizing for disk.

---

## 6. Functional Requirements

| ID | Canonical Source | Affects Existing | Priority |
|----|------------------|------------------|----------|
| OBS-FR-01 | [OBS-FR-01](#OBS-FR-01) | Yes — read commands | Should |
| OBS-FR-02 | [OBS-FR-02](#OBS-FR-02) | Yes — all output | Must |
| OBS-FR-03 | [OBS-FR-03](#OBS-FR-03) | Yes — `status` | Should |
| OBS-FR-04 | [OBS-FR-04](#OBS-FR-04) | Yes — doctor | Should |

```forge-requirement
{"id":"OBS-FR-01","kind":"requirement","text":"Emit a single JSON document on stdout for list, status, doctor, config, and version when --json is passed, each with schemaVersion 1 and stable field names. Arrays are present and empty rather than omitted, booleans and numbers keep their types, timestamps are ISO 8601 UTC, and no ANSI escape, human table, or secret value appears in the document."}
```

```forge-requirement
{"id":"OBS-FR-02","kind":"requirement","text":"Detect whether stdout is a TTY and honor NO_COLOR. When color is unavailable, emit no ANSI escapes and convey status with a text label. Tables must fit 80 columns, moving long values to status output rather than truncating them into ambiguity."}
```

```forge-requirement
{"id":"OBS-FR-03","kind":"requirement","text":"Compare recorded state with Podman reality for each app and classify drift as missing-container, stopped-container, image-mismatch, or unhealthy-probe. status reports the drift class and what update would do about it; list marks drifted apps visibly. Drift detection never mutates anything."}
```

```forge-requirement
{"id":"OBS-FR-04","kind":"requirement","text":"Doctor reports total image size per app, BuildKit cache size, and workspace usage, warns above 5 GiB free, fails above 2 GiB free, and includes the same figures in JSON. Sizes are approximate and labelled as such."}
```

```forge-requirement
{"id":"OBS-NF-01","kind":"constraint","text":"Machine-readable output goes to stdout only; progress, warnings, and human narration go to stderr."}
```

```forge-requirement
{"id":"OBS-NF-02","kind":"constraint","text":"schemaVersion 1 field names are a compatibility contract: additive fields are allowed, renames and removals require a version bump."}
```

---

## 7. Non-Functional Requirements

| ID | Canonical Source | Priority |
|----|------------------|----------|
| OBS-NF-01 | [OBS-NF-01](#OBS-NF-01) | Must |
| OBS-NF-02 | [OBS-NF-02](#OBS-NF-02) | Must |

---

## 8. Agent Impact Assessment

Greenfield feature. Planned owner: `cli-engineer` for JSON, formatting, drift, and the doctor disk group. No new specialist is needed; the change is concentrated in the presentation and registry layers.

---

## 9. Implementation Phases

### Phase 1: Output Contracts and Drift

```forge-task
{
  "id": "OBS-1.1",
  "title": "Freeze the JSON output contract",
  "description": "Implement json.ts with serializers for list, status, doctor, config, and version. Every payload includes schemaVersion 1, uses ISO 8601 UTC timestamps, keeps empty arrays, and is written as one document to stdout. Wire the read commands to select JSON when --json is present and keep human narration on stderr. Tests assert the exact top-level shape for each command, absence of ANSI escapes, presence of empty arrays, ISO timestamps, and that a secret value never appears.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["ADD-1.5", "PRE-1.5"],
  "expectedOutputs": ["src/cli/json.ts", "src/cli/schemas.ts", "tests/unit/json.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/json.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/07-observability-and-output.md#OBS-FR-01"],
    "acceptanceCriteria": ["Each read-only command has an asserted top-level shape", "Empty arrays are present rather than omitted", "Timestamps are ISO 8601 UTC", "No ANSI escapes or secret values appear"],
    "constraints": ["JSON goes to stdout only", "Field renames require a schemaVersion bump"],
    "constraintRefs": ["docs/features/07-observability-and-output.md#OBS-NF-01", "docs/features/07-observability-and-output.md#OBS-NF-02"],
    "references": ["docs/PRD.md#12.1 Command surface", "docs/PRD.md#16. Analytics / Success Metrics"]
  }
}
```

```forge-task
{
  "id": "OBS-1.2",
  "title": "Make human output TTY-aware and accessible",
  "description": "Implement format.ts and route the read commands through it. Decide color from TTY and NO_COLOR, render status labels as text, fit tables to 80 columns, and move long values to a detail line rather than truncating them. Tests run with forced TTY, forced non-TTY, NO_COLOR set, and an 80-column width, asserting no ANSI escapes in non-color modes and no row wider than 80 columns.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["OBS-1.1"],
  "expectedOutputs": ["src/cli/format.ts", "tests/unit/format.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/format.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/07-observability-and-output.md#OBS-FR-02"],
    "acceptanceCriteria": ["NO_COLOR and non-TTY produce no ANSI escapes", "Status is legible without color", "No rendered row exceeds 80 columns", "Long values move to a detail line"],
    "constraints": ["Never encode meaning in color alone", "Do not truncate an app name or port"],
    "constraintRefs": ["docs/PRD.md#PRD-ACC-01", "docs/PRD.md#PRD-ACC-02"],
    "references": ["docs/PRD.md#11. Accessibility", "docs/PRD.md#12.2 Interaction rules"]
  }
}
```

```forge-task
{
  "id": "OBS-1.3",
  "title": "Detect drift between state and Podman",
  "description": "Implement drift.ts. For each app, compare the recorded container id and image with podman inspect, and classify missing-container, stopped-container, image-mismatch, or unhealthy-probe from the last health result. Return a typed drift report with the recommended action. Wire status to print it and list to mark drifted apps. Tests cover each class, a clean app, a state file missing, and a Podman inspect that fails.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["ADD-1.5", "REG-1.3"],
  "expectedOutputs": ["src/registry/drift.ts", "tests/unit/drift.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/drift.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/07-observability-and-output.md#OBS-FR-03"],
    "acceptanceCriteria": ["Each drift class is detected and labelled", "A clean app reports no drift", "A missing state file does not crash detection", "The report names the recommended update action"],
    "constraints": ["Drift detection is read-only", "A failed inspect is reported as unknown, not healthy"],
    "constraintRefs": ["docs/PRD.md#PRD-NF-06"],
    "references": ["docs/PRD.md#13. System States / Lifecycle", "docs/PRD.md#7.3 Key APIs / interfaces"]
  }
}
```

```forge-task
{
  "id": "OBS-1.4",
  "title": "Report disk usage in doctor",
  "description": "Implement the doctor disk group. Sum image sizes per app from podman images, read BuildKit cache usage from podman system df when available, and measure workspace and tools directory sizes. Warn when free space is below 5 GiB and fail below 2 GiB, and label sizes as approximate. Wire the group into the doctor composition and the JSON payload. Tests use an injected size reader to cover healthy, warning, failing, and unavailable-measurement cases.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["OBS-1.1", "PRE-1.5", "BLD-1.5"],
  "expectedOutputs": ["src/doctor/disk-checks.ts", "src/doctor/index.ts", "tests/unit/doctor-disk.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/doctor-disk.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/07-observability-and-output.md#OBS-FR-04"],
    "acceptanceCriteria": ["Per-app image size, cache size, and workspace usage are reported", "The 5 GiB warning and 2 GiB failure thresholds are asserted", "Unavailable measurements are reported as unknown, not zero", "The JSON payload includes the same figures"],
    "constraints": ["Doctor remains under its time budget", "No automatic pruning"],
    "constraintRefs": ["docs/features/01-prerequisites-and-doctor.md#PRE-NF-01"],
    "references": ["docs/PRD.md#15. Testing Strategy", "docs/PRD.md#18.2 Risks", "docs/PRD.md#19. Future Considerations"]
  }
}
```

---

## 10. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit Tests | JSON shapes, ANSI suppression, table width, drift classes, disk thresholds | Vitest with forced TTY state and injected size readers |
| Integration Tests | JSON output from a real app on the host | Covered by the read assertions in the gated add test |
| Regression Tests | `schemaVersion` stability and no secrets in output | Snapshot tests with a planted secret value |

Key test scenarios:

1. Every read-only command emits one valid JSON document with `schemaVersion: 1`.
2. `NO_COLOR` and non-TTY output contain no ANSI escapes.
3. Tables fit 80 columns without truncating names or ports.
4. Each drift class is detected and labelled.
5. Disk thresholds warn at 5 GiB and fail at 2 GiB.
6. A planted secret value never appears in human or JSON output.

---

## 11. Rollback Considerations

Reverting removes the JSON, format, drift, and disk modules and restores the simpler human output from feature 04. Consumers of `--json` break, which is why the schema is versioned. No persisted state changes.

---

## 12. Acceptance Criteria

1. `list --json`, `status --json`, `doctor --json`, `config --json`, and `version --json` each emit one document with `schemaVersion: 1`.
2. Non-TTY and `NO_COLOR` output contain no ANSI escapes and still convey status.
3. Tables fit 80 columns.
4. `status` reports the drift class and the recommended action.
5. `doctor` reports image, cache, and workspace sizes and applies the documented thresholds.
6. No secret value appears in any output mode.

---

## 13. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should `list --json` include apps whose config is broken? | Yes, with a `broken` status and the parse error. |
| 2 | Should drift detection run on every `list`? | Yes, but with a short Podman timeout so a hung daemon does not hang the command. |
| 3 | Should `status --json` exit non-zero when the app is unhealthy? | Yes, exit 4, matching the human path. |
