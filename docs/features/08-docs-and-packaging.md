# Feature: Docs and Packaging

## 1. Feature Overview

**Feature Name:** Docs and Packaging
**Parent Document:** [PRD](../PRD.md)
**Status:** Draft
**Summary:** Makes the tool installable from the repository today and operable by someone who did not write it: a packaging and install story with no npm publish, a README that replaces the stale React-only one, a prerequisite and upgrade guide, a systemd timer example, a CLI and config reference, shell completions generated from the command definitions, and a note about the repository rename.
**Scope:** `package.json` packaging fields, the prepare/build step, a clean-prefix install smoke test, completion generation, and all operator documentation. No product behavior changes.
**Dependencies:** [Rollback and Remove](06-rollback-and-remove.md), [Observability and Output](07-observability-and-output.md).

---

## 2. Context: Existing System State

Greenfield feature. All commands exist by the time this feature runs. `README.md` still describes a React-only hoster and the repository is still named `react-hoster`; both are corrected or explicitly documented here.

---

## 3. Feature Goals and Non-Goals

### 3.1 Goals

- Make installation reproducible without a registry: clone, pack, or install from a git tag.
- Replace stale documentation rather than layering on top of it.
- Make the Podman 6.1 upgrade and lingering requirement impossible to miss.
- Keep documented flags and completions generated from the same source as the CLI.

### 3.2 Non-Goals

- No npm registry publish, no release automation, and no changelog tooling in v1.
- No documentation site, versioned docs, or screenshots.
- No completion command; completions are static files shipped in the package.
- No packaging for macOS, Windows, or single-binary distribution.

---

## 4. User Stories

| ID | Canonical Source | Ownership | Priority |
|----|------------------|-----------|----------|
| DOC-US-01 | [DOC-US-01](#DOC-US-01) | Owns | Must |
| DOC-US-02 | [DOC-US-02](#DOC-US-02) | Owns | Must |
| DOC-US-03 | [DOC-US-03](#DOC-US-03) | Owns | Should |
| DOC-US-04 | [DOC-US-04](#DOC-US-04) | Owns | Could |

```forge-requirement
{"id":"DOC-US-01","kind":"story","text":"As a homelab operator, I want to install from the repository without a registry so that I can run the current version on my host."}
```

```forge-requirement
{"id":"DOC-US-02","kind":"story","text":"As a homelab operator, I want to know exactly which Podman and lingering setup I need so that my apps survive a reboot."}
```

```forge-requirement
{"id":"DOC-US-03","kind":"story","text":"As an occasional maintainer, I want a command and config reference so that I do not have to read source to change a setting."}
```

```forge-requirement
{"id":"DOC-US-04","kind":"story","text":"As a VPS tinkerer, I want shell completions so that I can use the tool faster and with fewer typos."}
```

---

## 5. Technical Approach

### 5.1 Impact on Existing Architecture

Modifies `package.json` (files list, bin, prepare, engines, repository metadata) and `README.md`. Adds `scripts/generate-completions.ts`, `completions/`, `docs/operations/`, `docs/reference/`, `docs/MIGRATION.md`, and docs tests. No runtime module changes except the completion generator importing the command definitions.

### 5.2 New Components

| Path | Responsibility |
|---|---|
| `scripts/generate-completions.ts` | Emit bash, zsh, and fish completions from the commander program |
| `completions/easy-host.bash`, `completions/easy-host.zsh`, `completions/easy-host.fish` | Shipped completion files |
| `tests/packaging/install.test.ts` | Pack, install into a clean prefix, run the binary |
| `tests/docs/links.test.ts` | Relative link and required-section checks across all docs |
| `docs/operations/prerequisites.md` | Podman 6.1, lingering, git, Node, upgrade from 4.9 |
| `docs/operations/systemd-timer.md` | Timer unit that calls update on a schedule |
| `docs/reference/cli.md`, `docs/reference/config.md` | Command, flag, exit-code, and config-key reference |
| `docs/MIGRATION.md` | Repository rename and what changed from the React-only README |

### 5.3 Technology Additions

No new runtime dependencies. Uses the existing commander definitions as the single source for help and completions.

---

## 6. Functional Requirements

| ID | Canonical Source | Affects Existing | Priority |
|----|------------------|------------------|----------|
| DOC-FR-01 | [DOC-FR-01](#DOC-FR-01) | Yes — replaces `README.md` | Must |
| DOC-FR-02 | [DOC-FR-02](#DOC-FR-02) | No — new operations guide | Must |
| DOC-FR-03 | [DOC-FR-03](#DOC-FR-03) | No — new operations guide | Should |
| DOC-FR-04 | [DOC-FR-04](#DOC-FR-04) | No — new reference | Should |
| DOC-FR-05 | [DOC-FR-05](#DOC-FR-05) | No — new completions | Could |
| DOC-FR-06 | [DOC-FR-06](#DOC-FR-06) | Yes — `package.json` | Must |
| DOC-FR-07 | [DOC-FR-07](#DOC-FR-07) | No — new migration note | Should |

```forge-requirement
{"id":"DOC-FR-01","kind":"requirement","text":"Replace README.md with a document that states what easy-host is, the supported stacks, the host prerequisites, install-from-repository commands, a five-command quickstart, the four success scenarios, and links to the operations and reference docs. It must not describe a React-only hoster."}
```

```forge-requirement
{"id":"DOC-FR-02","kind":"requirement","text":"Document the host prerequisites: rootless Podman 6.1 or newer with an upgrade path from the 4.9 packages shipped by Ubuntu 24.04 and Debian 12, loginctl enable-linger and why it is mandatory, git 2.40 or newer, Node.js 24 or newer, and ports at or above 1024. Include a verification command for each prerequisite."}
```

```forge-requirement
{"id":"DOC-FR-03","kind":"requirement","text":"Provide a systemd user timer example that runs update for a named app on a schedule, including the unit files, the enable commands, and a note that the tool ships no daemon and that overlapping runs exit on the app lock."}
```

```forge-requirement
{"id":"DOC-FR-04","kind":"requirement","text":"Document every command, flag, exit code, and config key with its type, default, and validation rule. The reference must be generated from or verified against the CLI and schema rather than maintained by hand alone."}
```

```forge-requirement
{"id":"DOC-FR-05","kind":"requirement","text":"Ship bash, zsh, and fish completion files generated from the same command definitions as --help, and document where to install each file. Do not add a completion subcommand to the ten-command surface."}
```

```forge-requirement
{"id":"DOC-FR-06","kind":"requirement","text":"Make the package installable globally from a clone, from a git tag, and from a packed tarball: bin points at the built entry, files includes dist and the runtime docs, prepare builds, engines requires Node 24, and a packaging test installs into a clean prefix and runs easy-host version."}
```

```forge-requirement
{"id":"DOC-FR-07","kind":"requirement","text":"Document the rename from react-hoster to easy-host, the fact that the repository rename is a manual step outside this work, and any behavior that differs from the old React-only README. Keep the note factual and short."}
```

```forge-requirement
{"id":"DOC-NF-01","kind":"constraint","text":"Every command, flag, and exit code shown in documentation must match the CLI help output, enforced by a test rather than review."}
```

```forge-requirement
{"id":"DOC-NF-02","kind":"constraint","text":"Documentation is plain Markdown with real headings, no text embedded in images, and no required JavaScript to read."}
```

---

## 7. Non-Functional Requirements

| ID | Canonical Source | Priority |
|----|------------------|----------|
| DOC-NF-01 | [DOC-NF-01](#DOC-NF-01) | Must |
| DOC-NF-02 | [DOC-NF-02](#DOC-NF-02) | Must |

---

## 8. Agent Impact Assessment

Greenfield feature. Planned owner: `docs-engineer` for README, operations, reference, and migration note; `cli-engineer` for packaging and completion generation because both touch `package.json` and the CLI definitions. No runtime behavior changes.

---

## 9. Implementation Phases

### Phase 1: Install and Generate

```forge-task
{
  "id": "DOC-1.1",
  "title": "Make the package installable from the repository",
  "description": "Update package.json with a files list containing dist, completions, README.md, LICENSE, and docs/operations and docs/reference; set bin.easy-host to dist/cli/index.js; set engines.node to >=24; add a prepare script that builds; and add test:packaging. Write tests/packaging/install.test.ts to run npm pack, install the tarball into a clean temporary prefix, and assert the installed easy-host binary prints the package version and lists ten commands. Add scripts/pack-smoke.mjs if a shell wrapper is clearer than inline test code. Document the three install paths in the test output on failure. Tests also assert the tarball contains no source test files and no secrets file.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["PRE-1.1", "RBK-1.6"],
  "expectedOutputs": ["package.json", "tests/packaging/install.test.ts"],
  "validationCommands": ["npm run typecheck", "npm run test:packaging"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/08-docs-and-packaging.md#DOC-FR-06"],
    "acceptanceCriteria": ["A tarball install into a clean prefix produces a working binary", "The tarball excludes tests and secrets", "The installed binary lists ten commands", "prepare builds without a separate manual step"],
    "constraints": ["No npm registry publish", "No postinstall that downloads binaries"],
    "constraintRefs": ["docs/PRD.md#PRD-C-12", "docs/PRD.md#PRD-NF-08"],
    "references": ["docs/PRD.md#7.2 Project structure", "docs/PRD.md#1. Overview"]
  }
}
```

```forge-task
{
  "id": "DOC-1.2",
  "title": "Generate shell completions from the command definitions",
  "description": "Implement scripts/generate-completions.ts that imports the commander program, walks its commands and options, and emits bash, zsh, and fish completion files into completions/. The script must be deterministic so a test can regenerate into a temporary directory and compare against the committed files. The test fails when a command or flag exists in the CLI but not in the completions, and asserts that no completion subcommand was added.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["PRE-1.4", "DOC-1.1"],
  "expectedOutputs": ["scripts/generate-completions.ts", "completions/easy-host.bash", "completions/easy-host.zsh", "completions/easy-host.fish", "tests/unit/completions.test.ts"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/unit/completions.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/08-docs-and-packaging.md#DOC-FR-05"],
    "acceptanceCriteria": ["All ten commands and their flags appear in each completion file", "Regeneration is deterministic", "The test fails when the CLI and completions drift", "No completion subcommand is registered"],
    "constraints": ["Completions are generated, never hand-edited", "The command surface stays at ten"],
    "constraintRefs": ["docs/features/08-docs-and-packaging.md#DOC-NF-01", "docs/PRD.md#PRD-ACC-07"],
    "references": ["docs/PRD.md#12.1 Command surface", "docs/PRD.md#11. Accessibility"]
  }
}
```

### Phase 2: Operator Documentation

```forge-task
{
  "id": "DOC-1.3",
  "title": "Rewrite the README for easy-host",
  "description": "Replace README.md with the easy-host README: one-paragraph description, the three supported stacks, host prerequisites summary with a link to the operations guide, the three install paths, a five-command quickstart, the four success scenarios, a safety note about volumes, and a documentation index. Create tests/docs/links.test.ts to verify relative links resolve, required headings exist, and every command named in the README exists in the CLI. The test must also fail if the README still contains react-hoster branding outside the migration note.",
  "ownerAgent": "docs-engineer",
  "dependencies": ["DOC-1.1", "RBK-1.6"],
  "expectedOutputs": ["README.md", "tests/docs/links.test.ts"],
  "validationCommands": ["npm test -- tests/docs/links.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/08-docs-and-packaging.md#DOC-FR-01"],
    "acceptanceCriteria": ["Every relative link resolves", "Required headings and the four scenarios are present", "No stale React-only description remains", "Named commands exist in the CLI"],
    "constraints": ["Plain Markdown only", "Do not duplicate the full reference in the README"],
    "constraintRefs": ["docs/features/08-docs-and-packaging.md#DOC-NF-02", "docs/PRD.md#PRD-ACC-06"],
    "references": ["docs/PRD.md#6.2 Success / completion criteria", "docs/PRD.md#3.2 Non-Goals"]
  }
}
```

```forge-task
{
  "id": "DOC-1.4",
  "title": "Write the prerequisite and systemd timer guides",
  "description": "Write docs/operations/prerequisites.md covering rootless Podman 6.1 with an upgrade path from 4.9 on Ubuntu 24.04 and Debian 12, lingering with its reboot consequence, git 2.40, Node 24, and ports at or above 1024, each with a verification command and the matching doctor check. Write docs/operations/systemd-timer.md with user unit files that run update for one app, enable commands, log location, and the note that overlapping runs exit on the app lock. Extend the docs link test to cover both files.",
  "ownerAgent": "docs-engineer",
  "dependencies": ["DOC-1.3"],
  "expectedOutputs": ["docs/operations/prerequisites.md", "docs/operations/systemd-timer.md"],
  "validationCommands": ["npm test -- tests/docs/links.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/08-docs-and-packaging.md#DOC-FR-02", "docs/features/08-docs-and-packaging.md#DOC-FR-03"],
    "acceptanceCriteria": ["Every prerequisite has a verification command and a doctor reference", "The Podman 4.9 to 6.1 upgrade path is explicit", "The timer example is complete and uses the documented exit codes", "Links resolve"],
    "constraints": ["Do not claim a distribution package that was not verified", "No daemon instructions"],
    "constraintRefs": ["docs/PRD.md#PRD-C-04"],
    "references": ["docs/PRD.md#6.3 What the operator must provide", "docs/PRD.md#5.4 Platform finding that shaped the scope", "docs/PRD.md#18.2 Risks"]
  }
}
```

```forge-task
{
  "id": "DOC-1.5",
  "title": "Write the CLI and config reference",
  "description": "Write docs/reference/cli.md with every command, flag, argument, exit code, and example, and docs/reference/config.md with every key, type, default, and validation rule including the volumes table and env precedence. Add a test that extracts the command and flag names from the CLI program and asserts each appears in the reference, and asserts each config key in the schema appears in the config reference. Extend the docs link test.",
  "ownerAgent": "docs-engineer",
  "dependencies": ["DOC-1.3", "OBS-1.1"],
  "expectedOutputs": ["docs/reference/cli.md", "docs/reference/config.md", "tests/docs/reference.test.ts"],
  "validationCommands": ["npm test -- tests/docs/reference.test.ts", "npm test -- tests/docs/links.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/08-docs-and-packaging.md#DOC-FR-04"],
    "acceptanceCriteria": ["Every command and flag appears in the CLI reference", "Every schema key appears in the config reference with a default", "Exit codes match the error taxonomy", "The drift test fails when a new flag is undocumented"],
    "constraints": ["Reference content is verified by tests, not by review alone", "No invented flags"],
    "constraintRefs": ["docs/features/08-docs-and-packaging.md#DOC-NF-01"],
    "references": ["docs/PRD.md#7.3 Key APIs / interfaces", "docs/PRD.md#12.1 Command surface"]
  }
}
```

```forge-task
{
  "id": "DOC-1.6",
  "title": "Document the rename and migration",
  "description": "Write docs/MIGRATION.md explaining that the project is now easy-host, that the repository is still named react-hoster until renamed manually, what the old README claimed, and what an early user must change: install command, binary name, config location, and the Podman minimum. Add a test asserting the migration note exists, links to the PRD and README, and does not claim the repository has already been renamed. Extend the docs link test.",
  "ownerAgent": "docs-engineer",
  "dependencies": ["DOC-1.3"],
  "expectedOutputs": ["docs/MIGRATION.md"],
  "validationCommands": ["npm test -- tests/docs/links.test.ts"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/08-docs-and-packaging.md#DOC-FR-07"],
    "acceptanceCriteria": ["The note names the old and new project names", "It states the repository rename is manual", "It lists the concrete changes for an existing user", "Links resolve"],
    "constraints": ["Do not claim a rename that has not happened", "Keep the note short and factual"],
    "constraintRefs": [],
    "references": ["docs/PRD.md#20. Open Questions", "docs/IDEA.md#Open questions", "docs/PRD.md#2. Version History"]
  }
}
```

---

## 10. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit Tests | Completion generation and drift against the CLI | Vitest comparing regenerated output with committed files |
| Packaging Tests | Tarball contents and clean-prefix install | `npm pack`, install into a temporary prefix, run `version` |
| Docs Tests | Links, required headings, command and key coverage | Vitest parsers over the CLI program and the zod schema |
| Manual | Following the README and the prerequisite guide on a fresh host | Release gate companion checklist |

Key test scenarios:

1. Tarball installs into a clean prefix and the binary runs.
2. The tarball excludes tests and secrets.
3. Regenerated completions match the committed files.
4. Every CLI command and flag appears in the reference.
5. Every config key appears in the config reference.
6. All relative links resolve.
7. The README contains no stale React-only description.

---

## 11. Rollback Considerations

Reverting restores the old README and removes the generated completions, operations guides, reference, migration note, and packaging tests. The `package.json` changes must be reverted together; leaving `files` or `prepare` behind while removing `dist` would break installation. No runtime state is affected.

---

## 12. Acceptance Criteria

1. A clone, a git tag install, and a packed tarball all produce a working `easy-host` binary.
2. The tarball contains the built entry, completions, and runtime docs, and no tests or secrets.
3. README describes easy-host, its supported stacks, install paths, quickstart, and the four success scenarios.
4. The prerequisite guide covers Podman 6.1, the 4.9 upgrade, lingering, git, Node, and ports.
5. The systemd timer example is complete and explains lock behavior.
6. The CLI and config references cover every command, flag, exit code, and key, verified by tests.
7. Bash, zsh, and fish completions are generated and current.
8. The migration note states the rename is manual and lists the concrete changes.

---

## 13. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Is a LICENSE file added in this feature? | Yes, MIT, matching the PRD open question default. |
| 2 | Should the packaging test require network access for dependencies? | Yes; it is a release-time check, separate from the offline runtime guarantee. |
| 3 | Should completions be installed by the package or sourced manually? | Shipped in the package and sourced manually; no install hook. |
| 4 | Is a changelog required for 0.1.0? | No; the release gate evidence and PRD version history suffice. |
