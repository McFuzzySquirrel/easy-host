# Support

easy-host is maintained by the agent team below. The original build
requirements and execution tooling have been retired; this document is the
current ownership map.

## Team

| Agent | Scope | Invoke when |
|---|---|---|
| `support-lead` | triage, routing, release, `docs/SUPPORT.md` | priority, cross-module change, release decision |
| `cli-engineer` | `src/cli`, `src/config`, `src/doctor`, `src/registry`, packaging, completions | command surface, exit codes, config schema, JSON output, install |
| `platform-engineer` | `src/platform`, `src/health` | process runner, Podman, git, probes, locks, ports, boot recovery |
| `build-engineer` | build files in `src/platform`, `fixtures` | Railpack, BuildKit, image build, supported stacks |
| `lifecycle-engineer` | `src/lifecycle` | add, update, rollback, remove, retention |
| `qa-engineer` | `tests` | failing or flaky tests, gated host suites, release evidence |
| `docs-engineer` | `README.md`, `docs/` | README, operator guides, CLI and config reference, migration note |

## Ownership

| Area | Owner | Checks |
|---|---|---|
| `src/cli` | `cli-engineer` | `npm test -- tests/unit/program.test.ts tests/unit/errors.test.ts tests/unit/json.test.ts` |
| `src/config` | `cli-engineer` | `npm test -- tests/unit/config-parse.test.ts tests/unit/config-env.test.ts tests/unit/config-name.test.ts` |
| `src/doctor` | `cli-engineer` | `npm test -- tests/unit/doctor.test.ts` |
| `src/registry` | `cli-engineer` | `npm test -- tests/unit/registry-store.test.ts tests/unit/drift.test.ts tests/unit/ports.test.ts` |
| `src/platform` | `platform-engineer` | `npm test -- tests/unit/git.test.ts tests/unit/podman.test.ts tests/unit/lock.test.ts` |
| `src/platform/versions.ts`, `railpack.ts`, `buildkit.ts`, `build.ts` | `build-engineer` | `npm test -- tests/unit/railpack.test.ts tests/unit/buildkit.test.ts tests/unit/build.test.ts` |
| `src/health` | `platform-engineer` | `npm test -- tests/unit/probe.test.ts` |
| `src/lifecycle` | `lifecycle-engineer` | `npm test -- tests/unit/add.test.ts tests/unit/update.test.ts tests/unit/rollback.test.ts tests/unit/remove.test.ts` |
| `fixtures` | `build-engineer` | `npm test -- tests/unit/fixtures.test.ts` |
| `tests` | `qa-engineer` | `npm test` |
| `README.md`, `docs/` | `docs-engineer` | `npm test -- tests/docs` |
| `completions`, `scripts` | `cli-engineer` | `npm run test:packaging` |

The build files under `src/platform` are the only nested ownership boundary:
`platform-engineer` owns the directory and its adapters, `build-engineer` owns
those four files.

## Intake

1. Capture the report: command, app name, expected behaviour, observed output,
   exit code, and `easy-host doctor` output.
2. Route it to the owning agent from the ownership table above.
3. The owner reproduces, fixes the cause, adds a regression test, and runs the
   owned checks.
4. Cross-module or contract changes go to `support-lead`, who names a primary
   owner and a reviewer.
5. `support-lead` records the release evidence.

## Release checklist

- [ ] `npm run typecheck`, `npm run lint`, and `npm test` pass.
- [ ] Gated host suites pass on a rootless Podman host when the change touches
      container, build, or lifecycle behaviour.
- [ ] `npm run test:packaging` passes when packaging or completions change.
- [ ] CLI and config reference match the code (drift tests pass).
- [ ] `package.json` version bumped when the release publishes.
- [ ] Release evidence recorded with commands, observed results, and timings.
- [ ] No accepted-risk item is left without an owner.

## Escalation

- Unclear ownership: `support-lead`.
- Cross-module change: `support-lead` coordinates the owners.
- Public contract change (command, flag, exit code, JSON field, config key, file
  mode): announce before it lands; `docs-engineer` and `support-lead` must know.
- Product or scope decision: the human maintainer.

## Historical records

`docs/operations/release-gate-v0.1.0.md` is the human-run release gate record
for v0.1.0. It is evidence, not a specification; a later gate gets its own
dated document.
