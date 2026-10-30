# Integration Gate Detail

Load this file when adding a gated suite, writing cleanup, or recording release evidence.

## Suite matrix

| Suite | Claim | Key assertions |
|---|---|---|
| `build.test.ts` | Three fixtures build without a Dockerfile | Distinct timestamped tags; second build reuses the cached binary; images and daemon cleaned up |
| `add.test.ts` | Add reaches healthy and cleans up a failed first start | Port published, `restart=always`, probe success; failed add removes the container, keeps the image, exits `4` |
| `update.test.ts` | A broken commit leaves version one serving | Exit `4`; old container runs the old image; version-one response still served; fixed commit serves version two; config-only makes no build call |
| `rollback.test.ts` | Rollback restores and repeats | Version one serves; state refs swap; second rollback serves version two; no build invoked; one-image app exits `5` |
| `remove.test.ts` | Data survives unless explicitly deleted | Default remove keeps the volume and its sentinel data; `--volumes` deletes only the labelled volume; foreign volume untouched |
| `install.test.ts` | The packed tarball installs and runs | `easy-host version` works from a clean prefix; ten commands listed; tarball excludes tests and secrets |

## Harness skeleton

```text
beforeAll:
  if process.env.EASY_HOST_INTEGRATION !== "1": throw
  root = mkdtemp(join(tmpdir(), "easy-host-it-"))
  process.env.EASY_HOST_HOME = root
  suffix = `${process.pid}-${Date.now()}`
  cleanup = []

afterEach / finally:
  for each cleanup entry (reverse order): remove, ignore "not found"
  rm -rf root
```

Cleanup order:

1. Stop and remove app containers.
2. Remove app-labelled volumes (only those the test created).
3. Remove app images.
4. Stop and remove the buildkitd container if started by the suite.
5. Delete the temp state root.

Never delete by prefix alone; use the label plus the unique test suffix.

## Bounded wait

```text
waitFor({
  budget: 90_000,
  interval: 2_000,
  check: () => probe(),
  onTimeout: (lastError) => fail(`probe budget exhausted: ${lastError}`)
})
```

The budget matches the app's `health_startup_ms`. A test may lower it for a deliberately failing app, but never remove the bound.

## Evidence files

- v0.1.0 release gate: `docs/operations/release-gate-v0.1.0.md` (human-run).
- Skill review: the current skill package and its own validation section.

Evidence records commands, observed results, wall-clock time, and explicit pass/fail per scenario. A scenario without an observation is `failed` or `not-run`, never `passed`.

## Non-vacuous assertion patterns

| Weak | Strong |
|---|---|
| `expect(exitCode).toBe(0)` | exit `0` plus container running, port published, probe healthy |
| `expect(volumeList).toContain(name)` | write sentinel, remove, re-mount, read sentinel |
| `expect(updateCalls).toHaveLength(1)` | old image still current after a broken commit and version-one response |
| `expect(result).toBeDefined()` | exact exit code, state fields, and resource absence/presence |
| `expect(builder).not.toHaveBeenCalled()` | plus the container was recreated with the same image |

## Environment

- Linux only, x86_64 or arm64.
- Rootless Podman `>= 5.7.0, < 6.0.0`; 6.x is rejected.
- Lingering enabled for the test user when the suite checks reboot behavior.
- Node `>= 24`, git `>= 2.40`.
- Network for image pulls and the one-time Railpack download; no other outbound traffic.
