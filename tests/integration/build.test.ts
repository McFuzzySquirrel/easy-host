/**
 * Gated proof that the zero-Dockerfile build layer works on the real host
 * (`BLD-FR-03`, `BLD-FR-04`, `PRD-NF-07`, `PRD-C-10`).
 *
 * This suite is the only test that runs the pinned Railpack binary, the real
 * managed rootless buildkitd, and a real image export. It builds the three
 * supported fixture stacks, asserts that each produced a distinct timestamped
 * `localhost/easy-host-<app>:<UTC>` reference that Podman can see, and proves
 * that a second build of the same fixture reuses the verified Railpack cache
 * instead of downloading again.
 *
 * The suite never skips: without `EASY_HOST_INTEGRATION=1` it fails while the
 * module is loaded, naming the variable and the command to run. Every resource
 * is test-owned (temporary state root, unique app names, unique daemon name and
 * socket) and cleanup runs even when setup or a build throws.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUILD_IMAGE_PREFIX,
  BUILD_TIMESTAMP_PATTERN,
  buildWorkspace,
} from "../../src/platform/build.js";
import {
  BUILDKIT_ROLE_LABEL,
  BUILDKIT_ROLE_VALUE,
  type BuildkitDaemon,
  createBuildkit,
} from "../../src/platform/buildkit.js";
import { createPaths, type Paths } from "../../src/platform/paths.js";
import {
  type RailpackBinary,
  type RailpackBinarySource,
  resolveRailpack,
} from "../../src/platform/railpack.js";
import { BUILDKIT_IMAGE_REFERENCE, RAILPACK_VERSION } from "../../src/platform/versions.js";

/** The gate variable. Missing it is a failure, never a skip. */
const INTEGRATION_ENV = "EASY_HOST_INTEGRATION";

/**
 * Fail during collection, before any hook or resource, when the gate is absent.
 * The default `npm test` run excludes `tests/integration/**`; this message is
 * what an operator sees if they run the file through a config that includes it.
 */
if (process.env[INTEGRATION_ENV] !== "1") {
  throw new Error(
    `${INTEGRATION_ENV} must be set to "1" to run the gated build integration suite; ` +
      `it performs real Railpack and BuildKit builds. Run: ${INTEGRATION_ENV}=1 npm run test:integration -- tests/integration/build.test.ts`,
  );
}

/** Per-build budget handed to the build layer; a cold spike build was ~259s. */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** Setup may include the Railpack download and the BuildKit image pull. */
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/** Three sequential cold builds plus their warm-up overhead. */
const THREE_BUILD_TIMEOUT_MS = BUILD_TIMEOUT_MS * 3 + 60 * 1000;

/** A single warm re-build of the same fixture. */
const REBUILD_TIMEOUT_MS = BUILD_TIMEOUT_MS + 60 * 1000;

/** Image removal plus daemon stop plus temporary-root deletion. */
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;

/** Finite bound on every direct Podman call made by this suite. */
const PODMAN_TIMEOUT_MS = 60 * 1000;

/**
 * Optional evidence destination. The default lands under the OS temporary
 * directory so a run always records its durations without writing into the
 * package or the operator's state root.
 */
const EVIDENCE_ENV = "EASY_HOST_BUILD_EVIDENCE";
const evidencePath =
  process.env[EVIDENCE_ENV]?.trim() ||
  path.join(tmpdir(), `easy-host-build-evidence-${process.pid}.json`);

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_ROOT = path.join(REPOSITORY_ROOT, "fixtures");

/** Podman is the only engine this project supports in v1. */
const MINIMUM_PODMAN: readonly [number, number, number] = [5, 7, 0];
const EXCLUDED_PODMAN_MAJOR = 6;

interface Fixture {
  /** Directory name under `fixtures/` and the label used in assertions. */
  readonly slug: string;
  /** Prefix of the unique app name for this run. */
  readonly appPrefix: string;
  /** Absolute build context; it never contains a Dockerfile. */
  readonly directory: string;
}

const FIXTURES: readonly Fixture[] = [
  {
    slug: "vite-spa",
    appPrefix: "it-vite",
    directory: path.join(FIXTURES_ROOT, "vite-spa"),
  },
  {
    slug: "express-api",
    appPrefix: "it-express",
    directory: path.join(FIXTURES_ROOT, "express-api"),
  },
  {
    slug: "fastapi-app",
    appPrefix: "it-fastapi",
    directory: path.join(FIXTURES_ROOT, "fastapi-app"),
  },
];

/** One real build, including the timing evidence the task asks us to record. */
interface BuildObservation {
  readonly fixture: string;
  readonly app: string;
  readonly image: string;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly firstOutputMs: number;
  readonly streamedLines: number;
  readonly railpackSource: RailpackBinarySource;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const observations: BuildObservation[] = [];
const binariesByFixture = new Map<string, RailpackBinary>();
const createdImages: string[] = [];

let temporaryRoot: string | undefined;
let previousEasyHostHome: string | undefined;
let paths: Paths | undefined;
let buildkit: ReturnType<typeof createBuildkit> | undefined;
let daemon: BuildkitDaemon | undefined;
let containerName: string | undefined;
let runSuffix = "";
let fetchCalls = 0;
let podmanVersion = "";
let cleanupPromise: Promise<void> | undefined;

describe("build layer on the real host", () => {
  beforeAll(async () => {
    try {
      podmanVersion = await assertHostPrerequisites();

      temporaryRoot = mkdtempSync(path.join(tmpdir(), "easy-host-build-it-"));
      previousEasyHostHome = process.env.EASY_HOST_HOME;
      process.env.EASY_HOST_HOME = temporaryRoot;

      runSuffix = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
      containerName = `easy-host-buildkit-it-${runSuffix}`;

      paths = createPaths({ env: { EASY_HOST_HOME: temporaryRoot } }).ensureLayout();

      for (const fixture of FIXTURES) {
        const stats = statSync(fixture.directory);
        if (!stats.isDirectory()) {
          throw new Error(`fixture "${fixture.slug}" is not a directory at ${fixture.directory}`);
        }

        // The build proof is only meaningful when Railpack must detect the
        // provider itself; a Dockerfile would bypass that contract.
        for (const dockerfile of ["Dockerfile", "dockerfile"]) {
          const candidate = path.join(fixture.directory, dockerfile);
          if (existsSync(candidate)) {
            throw new Error(
              `fixture "${fixture.slug}" contains ${dockerfile}; the zero-Dockerfile contract requires provider detection (BLD-FR-03)`,
            );
          }
        }
      }

      buildkit = createBuildkit({
        paths,
        containerName,
        readinessTimeoutMs: 180_000,
        startTimeoutMs: 15 * 60 * 1000,
        stopTimeoutMs: 60_000,
      });
      daemon = await buildkit.ensure();

      // The daemon is infrastructure: prove the label on the real host rather
      // than trusting the command builder alone.
      const label = await runCommand(
        "podman",
        ["inspect", "--format", `{{index .Config.Labels "${BUILDKIT_ROLE_LABEL}"}}`, containerName],
        PODMAN_TIMEOUT_MS,
      );
      if (label.exitCode !== 0) {
        throw new Error(
          `could not inspect the managed buildkitd container "${containerName}": ${label.stderr.trim()}`,
        );
      }
      expect(label.stdout.trim(), "the managed buildkitd must be labelled as infrastructure").toBe(
        BUILDKIT_ROLE_VALUE,
      );
    } catch (error) {
      // afterAll may not run when beforeAll throws, so clean up here too.
      await cleanup();
      throw error;
    }
  }, SETUP_TIMEOUT_MS);

  it(
    "builds all three supported fixtures into distinct timestamped images",
    async () => {
      for (const fixture of FIXTURES) {
        // Resolving before every build makes the cache assertion truthful: the
        // path handed to Railpack comes from this resolution, not a stale value.
        const binary = await resolveManagedRailpack();
        binariesByFixture.set(fixture.slug, binary);
        await buildFixture(fixture, binary);
      }

      const sources = FIXTURES.map((fixture) => binariesByFixture.get(fixture.slug)?.source);
      expect(sources[0], "the first build must download and verify Railpack").toBe("download");
      expect(sources.slice(1), "every later build must reuse the verified Railpack cache").toEqual([
        "cache",
        "cache",
      ]);
      expect(fetchCalls, "Railpack must be downloaded exactly once").toBe(1);

      expect(observations).toHaveLength(FIXTURES.length);

      for (const observation of observations) {
        const fixture = requireFixture(observation.fixture);
        const expectedApp = appNameFor(fixture);

        expect(observation.app).toBe(expectedApp);
        expect(BUILD_TIMESTAMP_PATTERN.test(observation.timestamp)).toBe(true);
        expect(observation.image).toBe(
          `${BUILD_IMAGE_PREFIX}${expectedApp}:${observation.timestamp}`,
        );
        expect(observation.durationMs).toBeGreaterThan(0);
        expect(observation.durationMs).toBeLessThanOrEqual(BUILD_TIMEOUT_MS);
        expect(observation.streamedLines).toBeGreaterThan(0);
        expect(
          observation.firstOutputMs,
          "output must arrive while the build runs, not after it completes",
        ).toBeLessThan(observation.durationMs + 1);

        expect(
          await imageExists(observation.image),
          `expected "${observation.image}" to exist in Podman storage after the build`,
        ).toBe(true);
        expect(
          await imageRepoTags(observation.image),
          "the loaded image must carry the exact immutable tag Railpack reported",
        ).toContain(observation.image);
      }

      const distinct = new Set(observations.map((observation) => observation.image));
      expect(distinct.size, "each fixture must produce its own immutable image reference").toBe(
        FIXTURES.length,
      );

      console.info(
        `[build-integration] ${JSON.stringify({
          event: "fixtures-built",
          podman: podmanVersion,
          railpack: RAILPACK_VERSION,
          buildkit: BUILDKIT_IMAGE_REFERENCE,
          daemon: { container: daemon?.containerName, reused: daemon?.reused },
          images: observations.map((observation) => observation.image),
          durationsMs: Object.fromEntries(
            observations.map((observation) => [observation.fixture, observation.durationMs]),
          ),
        })}`,
      );
    },
    THREE_BUILD_TIMEOUT_MS,
  );

  it(
    "reuses the cached Railpack binary for the second build of the same fixture",
    async () => {
      const fixture = requireFixture("vite-spa");
      const firstBinary = binariesByFixture.get(fixture.slug);
      if (firstBinary === undefined) {
        throw new Error('the first "vite-spa" build did not complete, so its binary is unknown');
      }

      const secondBinary = await resolveManagedRailpack();
      expect(secondBinary.source, "the second build must resolve from the verified cache").toBe(
        "cache",
      );
      expect(secondBinary.version).toBe(RAILPACK_VERSION);
      expect(secondBinary.path, "the cached binary must be the same executable").toBe(
        firstBinary.path,
      );
      expect(fetchCalls, "a cache hit must not touch the network").toBe(1);

      const observation = await buildFixture(fixture, secondBinary);

      expect(observation.image).toBe(
        `${BUILD_IMAGE_PREFIX}${observation.app}:${observation.timestamp}`,
      );
      expect(observation.durationMs).toBeGreaterThan(0);
      expect(observation.streamedLines).toBeGreaterThan(0);
      expect(await imageExists(observation.image)).toBe(true);

      const first = observations.find((candidate) => candidate.fixture === fixture.slug);
      if (first === undefined) {
        throw new Error('the first "vite-spa" observation is missing');
      }
      if (observation.image !== first.image) {
        expect(
          await imageRepoTags(observation.image),
          "a distinct re-build tag must also be loadable by exact reference",
        ).toContain(observation.image);
      }

      console.info(
        `[build-integration] ${JSON.stringify({
          event: "cached-rebuild",
          fixture: fixture.slug,
          image: observation.image,
          durationMs: observation.durationMs,
          railpack: {
            version: secondBinary.version,
            source: secondBinary.source,
            path: secondBinary.path,
          },
          downloadCount: fetchCalls,
        })}`,
      );
    },
    REBUILD_TIMEOUT_MS,
  );

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    }

    try {
      writeBuildEvidence(cleanupError, true);
    } catch (error) {
      throw new Error(`could not record build evidence at "${evidencePath}": ${messageOf(error)}`);
    }

    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }, CLEANUP_TIMEOUT_MS);
});

/** Runs the pinned acquisition path against the isolated state root. */
async function resolveManagedRailpack(): Promise<RailpackBinary> {
  const stateRoot = requirePaths();

  return resolveRailpack({
    paths: stateRoot,
    // An empty environment deliberately ignores EASY_HOST_RAILPACK_BIN so the
    // suite proves the managed download and cache rather than an operator binary.
    env: {},
    fetch: async (url, init) => {
      fetchCalls += 1;
      return fetch(url, init);
    },
  });
}

/**
 * Builds one fixture and fails if no output reaches the sink before the build
 * resolves, which is the streaming guarantee (`BLD-NF-01`) on the real host.
 */
async function buildFixture(fixture: Fixture, binary: RailpackBinary): Promise<BuildObservation> {
  const buildkitDaemon = requireDaemon();
  const stateRoot = requirePaths();
  const app = appNameFor(fixture);
  const startedAt = Date.now();

  let firstOutputAt: number | undefined;
  let streamedLines = 0;
  let signalFirstOutput: (() => void) | undefined;
  const firstOutput = new Promise<void>((resolve) => {
    signalFirstOutput = resolve;
  });

  const sink = {
    write(chunk: string): boolean {
      if (firstOutputAt === undefined) {
        firstOutputAt = Date.now();
        const signal = signalFirstOutput;
        signalFirstOutput = undefined;
        signal?.();
      }

      streamedLines += chunk.split("\n").length - 1;
      return process.stderr.write(chunk);
    },
  };

  const pending = buildWorkspace({
    app,
    workspace: fixture.directory,
    railpackBinaryPath: binary.path,
    buildkitHost: buildkitDaemon.buildkitHost,
    stderr: sink,
    stateRoot: stateRoot.root,
    timeoutMs: BUILD_TIMEOUT_MS,
  });

  const raced = await Promise.race([
    firstOutput.then(() => "output" as const),
    pending.then(() => "completed" as const),
  ]);

  if (raced !== "output") {
    // Surface the real classified error when the build failed before printing.
    await pending;
    throw new Error(
      `Railpack produced no output before the build of "${fixture.slug}" completed; the stream must be forwarded while the build runs`,
    );
  }

  const result = await pending;
  createdImages.push(result.image);

  const observation: BuildObservation = {
    fixture: fixture.slug,
    app,
    image: result.image,
    timestamp: result.timestamp,
    durationMs: result.durationMs,
    firstOutputMs: Math.max(0, (firstOutputAt ?? startedAt) - startedAt),
    streamedLines,
    railpackSource: binary.source,
  };

  observations.push(observation);
  writeBuildEvidence();
  console.info(`[build-integration] ${JSON.stringify({ event: "build", ...observation })}`);
  return observation;
}

/** One bounded, shell-free command execution. No argument is interpolated. */
function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }

        const code = (error as { code?: unknown }).code;
        if (typeof code === "number") {
          resolve({ exitCode: code, stdout, stderr });
          return;
        }

        const timedOut = (error as { killed?: boolean }).killed === true;
        reject(
          new Error(
            `could not run "${command} ${args.join(" ")}"${timedOut ? ` (timed out after ${timeoutMs}ms)` : ""}: ${error.message}`,
          ),
        );
      },
    );
  });
}

/**
 * Verifies the host contract before any build: Linux, a supported rootless
 * Podman, and a Docker-compatible loader for Railpack's image export.
 */
async function assertHostPrerequisites(): Promise<string> {
  if (process.platform !== "linux") {
    throw new Error(
      `the gated build suite runs only on the Linux target host; this platform is "${process.platform}"`,
    );
  }

  const version = await runCommand(
    "podman",
    ["version", "--format", "{{.Client.Version}}"],
    PODMAN_TIMEOUT_MS,
  ).catch((error: unknown) => {
    throw new Error(
      `could not run "podman" (${messageOf(error)}); the gated build suite requires rootless Podman >= ${MINIMUM_PODMAN.join(".")} and < ${EXCLUDED_PODMAN_MAJOR}.0.0`,
    );
  });

  if (version.exitCode !== 0) {
    throw new Error(
      `"podman version" exited with code ${version.exitCode}: ${version.stderr.trim() || "no output"}`,
    );
  }

  const parsed = parsePodmanVersion(version.stdout);
  if (parsed === undefined) {
    throw new Error(`could not parse the Podman version from "${version.stdout.trim()}"`);
  }

  const [major, minor, patch] = parsed;
  const belowMinimum =
    major < MINIMUM_PODMAN[0] || (major === MINIMUM_PODMAN[0] && minor < MINIMUM_PODMAN[1]);
  if (belowMinimum || major >= EXCLUDED_PODMAN_MAJOR) {
    throw new Error(
      `Podman ${major}.${minor}.${patch} is outside the supported range >= ${MINIMUM_PODMAN.join(".")} and < ${EXCLUDED_PODMAN_MAJOR}.0.0; upgrade or downgrade the host before running the build suite`,
    );
  }

  // Railpack 0.43.0 pipes its export into `docker load`; without a compatible
  // loader the build hangs at export instead of failing fast (BLD-0.1 §6.7).
  const loader = await runCommand("docker", ["load", "--help"], PODMAN_TIMEOUT_MS).catch(
    (error: unknown) => {
      throw new Error(
        `Railpack ${RAILPACK_VERSION} exports through "docker load", but no docker-compatible loader is on PATH (${messageOf(error)}); install podman-docker or a working docker CLI and retry`,
      );
    },
  );
  if (loader.exitCode !== 0) {
    throw new Error(
      `Railpack ${RAILPACK_VERSION} needs a working "docker load" loader; "docker load --help" exited with code ${loader.exitCode}: ${loader.stderr.trim() || "no output"}`,
    );
  }

  return `${major}.${minor}.${patch}`;
}

function parsePodmanVersion(output: string): readonly [number, number, number] | undefined {
  const match = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (match === null) {
    return undefined;
  }

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);

  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return undefined;
  }

  return [major, minor, patch];
}

async function imageExists(image: string): Promise<boolean> {
  const result = await runCommand("podman", ["image", "exists", image], PODMAN_TIMEOUT_MS);
  if (result.exitCode === 0) {
    return true;
  }

  if (result.exitCode === 1) {
    return false;
  }

  throw new Error(
    `"podman image exists ${image}" failed with code ${result.exitCode}: ${result.stderr.trim()}`,
  );
}

async function imageRepoTags(image: string): Promise<readonly string[]> {
  const result = await runCommand(
    "podman",
    ["image", "inspect", "--format", "{{json .RepoTags}}", image],
    PODMAN_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `"podman image inspect ${image}" failed with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`unexpected RepoTags for "${image}": ${result.stdout.trim()}`);
  }

  return parsed;
}

/**
 * Lists image references that belong to this run, identified by the unique app
 * suffix. The suffix embeds the pid and start time, so a prefix match cannot
 * reach an operator image or a previous run.
 */
async function listTestImages(): Promise<readonly string[]> {
  if (runSuffix.length === 0) {
    return [];
  }

  const result = await runCommand(
    "podman",
    ["images", "--format", "{{.Repository}}:{{.Tag}}"],
    PODMAN_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) {
    throw new Error(`"podman images" failed with code ${result.exitCode}: ${result.stderr.trim()}`);
  }

  const prefixes = FIXTURES.map(
    (fixture) => `${BUILD_IMAGE_PREFIX}${fixture.appPrefix}-${runSuffix}:`,
  );

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((reference) => prefixes.some((prefix) => reference.startsWith(prefix)));
}

function appNameFor(fixture: Fixture): string {
  if (runSuffix.length === 0) {
    throw new Error("the integration harness has not initialized its unique suffix");
  }

  return `${fixture.appPrefix}-${runSuffix}`;
}

function requireFixture(slug: string): Fixture {
  const fixture = FIXTURES.find((candidate) => candidate.slug === slug);
  if (fixture === undefined) {
    throw new Error(`unknown fixture "${slug}"`);
  }

  return fixture;
}

function requirePaths(): Paths {
  if (paths === undefined) {
    throw new Error("the isolated easy-host state root was not created");
  }

  return paths;
}

function requireDaemon(): BuildkitDaemon {
  if (daemon === undefined) {
    throw new Error("the managed buildkitd was not started");
  }

  return daemon;
}

function cleanup(): Promise<void> {
  cleanupPromise ??= performCleanup();
  return cleanupPromise;
}

/**
 * Removes only what this suite created: its images, its uniquely named daemon,
 * and its temporary state root. Missing resources are tolerated; every other
 * cleanup failure is reported so a leak cannot masquerade as a pass.
 */
async function performCleanup(): Promise<void> {
  const failures: string[] = [];

  // A build can load an image and then fail before returning its reference
  // (for example a killed process at export). Discover every image that carries
  // this run's unique app prefix so those cannot leak.
  try {
    for (const image of await listTestImages()) {
      createdImages.push(image);
    }
  } catch (error) {
    failures.push(`list images created by this run: ${messageOf(error)}`);
  }

  for (const image of [...new Set(createdImages)].reverse()) {
    try {
      const result = await runCommand("podman", ["rmi", "--force", image], PODMAN_TIMEOUT_MS);
      if (result.exitCode !== 0 && !isMissingImage(result.stderr)) {
        failures.push(`remove image "${image}": ${result.stderr.trim()}`);
      }
    } catch (error) {
      failures.push(`remove image "${image}": ${messageOf(error)}`);
    }
  }

  if (buildkit !== undefined) {
    try {
      await buildkit.stop();
    } catch (error) {
      failures.push(`stop the managed buildkitd: ${messageOf(error)}`);
    }
  } else if (containerName !== undefined) {
    try {
      const result = await runCommand(
        "podman",
        ["rm", "--force", containerName],
        PODMAN_TIMEOUT_MS,
      );
      if (result.exitCode !== 0 && !isMissingContainer(result.stderr)) {
        failures.push(`remove the managed buildkitd: ${result.stderr.trim()}`);
      }
    } catch (error) {
      failures.push(`remove the managed buildkitd: ${messageOf(error)}`);
    }
  }

  if (previousEasyHostHome === undefined) {
    delete process.env.EASY_HOST_HOME;
  } else {
    process.env.EASY_HOST_HOME = previousEasyHostHome;
  }

  if (temporaryRoot !== undefined) {
    const removalError = await removeTemporaryRoot(temporaryRoot);
    if (removalError !== undefined) {
      failures.push(removalError);
    }
  }

  if (failures.length > 0) {
    throw new Error(`build integration cleanup failed:\n- ${failures.join("\n- ")}`);
  }
}

/**
 * Rootless BuildKit leaves `000` work directories and subuid-owned mount
 * points in its overlay snapshot store. The host user cannot traverse those
 * even after the daemon is stopped, so a plain recursive remove fails with
 * `EACCES`. `podman unshare rm -rf` deletes them inside the user namespace
 * where the mapped IDs are addressable.
 */
async function removeTemporaryRoot(directory: string): Promise<string | undefined> {
  try {
    rmSync(directory, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    if (!isPermissionError(error)) {
      return `remove the temporary state root "${directory}": ${messageOf(error)}`;
    }
  }

  try {
    const result = await runCommand(
      "podman",
      ["unshare", "rm", "-rf", directory],
      PODMAN_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      return `remove the temporary state root "${directory}" with "podman unshare": ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`;
    }
  } catch (error) {
    return `remove the temporary state root "${directory}" with "podman unshare": ${messageOf(error)}`;
  }

  if (existsSync(directory)) {
    return `remove the temporary state root "${directory}": the directory still exists after "podman unshare rm -rf"`;
  }

  return undefined;
}

/**
 * Persists the duration evidence the task asks the suite to record. The file
 * is rewritten after every build so a later failure still leaves the timings
 * that were observed, and once more after cleanup with the cleanup result.
 */
function writeBuildEvidence(cleanupError?: unknown, final = false): void {
  const document = {
    schemaVersion: 1,
    task: "BLD-1.6",
    generatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      podman: podmanVersion,
    },
    pins: {
      railpack: RAILPACK_VERSION,
      buildkit: BUILDKIT_IMAGE_REFERENCE,
    },
    daemon:
      daemon === undefined
        ? null
        : {
            container: daemon.containerName,
            reused: daemon.reused,
          },
    builds: observations,
    images: [...new Set(createdImages)],
    railpackDownloads: fetchCalls,
    cleanup: final ? (cleanupError === undefined ? "ok" : messageOf(cleanupError)) : "pending",
  };

  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
  console.info(
    `[build-integration] ${JSON.stringify({ event: "evidence", path: evidencePath, final })}`,
  );
}

function isPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

function isMissingImage(stderr: string): boolean {
  return /no such image|image not known|unable to find|does not exist/i.test(stderr);
}

function isMissingContainer(stderr: string): boolean {
  return /no such container|no container with name or id/i.test(stderr);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
