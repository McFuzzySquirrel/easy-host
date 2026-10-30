---
name: easy-host-packaging-docs-sync
description: "Keeps global install, packed tarball contents, generated shell completions, README, operations guides, and CLI and config references synchronized with the executable definitions."
---

# Skill: Keep easy-host Packaging and Docs in Sync

Use this skill when the CLI surface, config schema, package fields, completions, README, operations guides, reference docs, or migration note change. easy-host installs from a repository or packed tarball with no registry publish, and every documented command, flag, exit code, and config key is verified against the executable definitions by a test.

Generated artifacts come from source. Hand-edited completions or references drift silently and fail the docs tests.

## Invariants

- Installable globally from a clone, a git tag, and a packed tarball: `bin.easy-host` points at `dist/cli/index.js`, `prepare` builds, `engines.node >= 24`.
- `files` includes `dist`, `completions`, `README.md`, `LICENSE`, `docs/operations`, and `docs/reference`; it excludes tests and secrets.
- Bash, zsh, and fish completions are generated from the commander program and are never hand-edited.
- No `completion` subcommand is added; the ten-command surface is unchanged.
- Every command, flag, exit code, and config key in the references matches the CLI and schema, enforced by tests.
- README describes easy-host, the supported stacks, prerequisites, install paths, a five-command quickstart, and the four success scenarios. It contains no React-only branding outside the migration note.
- The rename from `react-hoster` to `easy-host` is a manual repository step; documentation states that rather than claiming it happened.
- Documentation is plain Markdown with real headings, working relative links, and no text embedded in images.

## Process

### Step 1: Find the source of truth for the change

Read the code that owns the behavior you are documenting. Inspect `src/cli/program.ts`, `src/config/schema.ts`, `package.json`, `scripts/generate-completions.ts`, and the relevant docs page.

If a doc and the executable disagree, then the executable wins until a deliberate contract change lands with tests.

### Step 2: Update the executable definition, then generate

Change the command or schema in code first. Regenerate completions deterministically:

```bash
npm run build
npx tsx scripts/generate-completions.ts
git diff --exit-code completions/
```

The regeneration test writes to a temp directory and compares against the committed files. If the diff is non-empty, commit the regenerated files rather than editing them by hand.

**Output:** updated program or schema plus regenerated completion files.

### Step 3: Update references and README from the definitions

Update `docs/reference/cli.md` with every command, flag, argument, exit code, and example. Update `docs/reference/config.md` with every key, type, default, and validation rule, including the volumes table and env precedence.

Update README only with summary content and links; do not duplicate the full reference. Keep the four success scenarios (add and reach, reboot survival, broken-update protection, rollback and remove data rules) intact.

If the change is a rename or a user-visible move, then update `docs/MIGRATION.md` and state that the repository rename is manual.

### Step 4: Verify packaging from a clean prefix

Never assume `npm install -g .` works because local `npm link` works. Pack and install into a temporary prefix:

```bash
npm pack
npm install -g --prefix "$(mktemp -d)" ./easy-host-<version>.tgz
"$(npm prefix -g)/bin/easy-host" version
```

Assert the tarball contains the built entry, completions, and runtime docs, and no test files or secret files. Assert the installed binary lists ten commands.

### Step 5: Run the docs drift gates

```bash
npm run typecheck
npm test -- tests/unit/completions.test.ts
npm test -- tests/docs/links.test.ts
npm test -- tests/docs/reference.test.ts
npm run test:packaging
```

By default, run all four gates for any CLI or schema change. If a docs gate is missing for the new surface, add the assertion before documenting the feature.

## Gotchas

- **Hand-edited completions pass locally and fail the next regeneration.** Always regenerate and commit.
- **`prepare` runs on install from a git URL.** If it needs dev dependencies that are absent, installation fails; keep the build path self-contained.
- **`files` is an allowlist.** Forgetting `dist` or the runtime docs ships a broken or undocumented package.
- **A local `npm link` hides packaging bugs.** Test the packed tarball in a clean prefix.
- **README duplication drifts.** Point at the reference instead of restating flags.
- **The docs reference test only catches what it parses.** When adding a new command shape, extend the extractor so the new surface is covered.
- **`react-hoster` branding fails the README test outside the migration note.** Rename in prose, not only in the title.
- **The repository rename has not happened.** Do not write installation commands that assume the new remote URL without checking.
- **Completions are shipped files, not a subcommand.** Adding `completion` breaks the ten-command contract.

## Validation

Self-check the released artifact:

- [ ] `npm pack --dry-run` lists `dist/`, `completions/`, `README.md`, `LICENSE`, `docs/operations/`, and `docs/reference/`, and no tests or secrets.
- [ ] A clean-prefix install prints the package version and lists ten commands.
- [ ] `npx tsx scripts/generate-completions.ts && git diff --exit-code completions/` is clean.
- [ ] `tests/docs/reference.test.ts` fails when a new flag or config key is undocumented.
- [ ] `tests/docs/links.test.ts` resolves every relative link and finds no stale React-only branding.

If a gate fails, fix the source or regenerate the artifact; do not relax the assertion. Load [references/packaging-docs.md](./references/packaging-docs.md) when you need package field values, install paths, docs inventory, or the drift-test contract.
