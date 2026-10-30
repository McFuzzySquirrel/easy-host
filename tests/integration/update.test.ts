/**
 * Gated end-to-end proof of `update` on the real host
 * (`UPD-FR-02`, `UPD-FR-05`, `PRD-NF-07`, `PRD-C-10`).
 *
 * This is the only test that drives the production update composition against a
 * real git remote, the pinned Railpack binary, the managed rootless buildkitd,
 * a real container swap, and the real bounded HTTP probe. It proves the two
 * claims the PRD makes about update safety:
 *
 * 1. a broken commit never trades a working version for a broken one — the
 *    candidate image is built, the candidate fails its probe, the previous
 *    image is restarted, the app answers with its version-one response again,
 *    `state.json` still records the old image as current, and the command exits
 *    with code 4 carrying the failure reason (UPD-FR-02);
 * 2. a config-only change recreates the container on the recorded image with
 *    the new settings and never invokes Railpack or BuildKit (UPD-FR-05).
 *
 * A fixed commit in between proves the failure is not sticky: the next update
 * builds and serves version two and records the old image as the rollback
 * target.
 *
 * The suite never skips: without `EASY_HOST_INTEGRATION=1` it throws while the
 * module is collected, naming the variable and the command to run. Every
 * resource is test-owned (temporary state root, a unique app name, a local git
 * fixture copy the test controls) and cleanup runs after both pass and failure,
 * then re-reads Podman to prove that no container, volume, image, daemon, or
 * temporary root was orphaned.
 *
 * The managed buildkitd uses a fixed container name because the production
 * builder owns it. Setup therefore refuses to run when an
 * `easy-host-buildkitd` container already exists, so this suite can never
 * clobber a daemon an operator is using.
 */

import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runUpdateCommand } from "../../src/cli/commands/update.js";
import {
  type AddBuilder,
  type AddBuildRequest,
  type AddBuildResult,
  type AddResult,
  addApp,
} from "../../src/lifecycle/add.js";
import type { UpdateDependencyOverrides } from "../../src/lifecycle/update.js";
import { BUILDKIT_CONTAINER_NAME, createBuildkit } from "../../src/platform/buildkit.js";
import { createPaths, type Paths } from "../../src/platform/paths.js";
import {
  APP_LABEL,
  APP_ROLE_VALUE,
  containerName,
  IMAGE_LABEL,
  ROLE_LABEL,
  volumeName,
} from "../../src/platform/podman.js";
import { RAILPACK_VERSION } from "../../src/platform/versions.js";
import { Registry } from "../../src/registry/store.js";

/** The gate variable. Missing it is a failure, never a skip. */
const INTEGRATION_ENV = "EASY_HOST_INTEGRATION";

if (process.env[INTEGRATION_ENV] !== "1") {
  throw new Error(
    `${INTEGRATION_ENV} must be set to "1" to run the gated update integration suite; ` +
      `it clones, builds, swaps, and probes real containers. Run: ${INTEGRATION_ENV}=1 npm run test:integration -- tests/integration/update.test.ts`,
  );
}

/** One cold fixture build was ~248s-277s in the build proof; allow headroom. */
const SCENARIO_TIMEOUT_MS = 20 * 60 * 1000;

/** Setup may include the Railpack download, the BuildKit pull, and the git copy. */
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/** Container removal plus daemon stop plus temporary-root deletion. */
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;

/** Finite bound on every direct Podman or git call made by this suite. */
const COMMAND_TIMEOUT_MS = 120 * 1000;

/** Declared container port used by the versioned fixture. */
const FIXTURE_CONTAINER_PORT = 3000;

/** The app's body for version one; the failure path must keep serving it. */
const VERSION_ONE_BODY = "update-fixture version=one";

/** The prefix of the app's body after the fixed commit. */
const VERSION_TWO_PREFIX = "update-fixture version=two";

/** The env label the config-only update adds to the version-two body. */
const CONFIG_ONLY_LABEL = "config-only";

/** The volume freshly declared by the config-only update (UPD-FR-05). */
const CONFIG_ONLY_VOLUME = "data";
const CONFIG_ONLY_VOLUME_TARGET = "/var/lib/data";

/**
 * The complete `message` vocabulary of a failed network attempt, mirroring
 * `NETWORK_FAILURE_MESSAGES` in `src/health/probe.ts`. A published host port
 * with no listener behind it is reported by Podman's forwarder as
 * `connection closed` (it accepts the connection, then closes it), not always
 * as `connection refused`, so both wordings are legitimate.
 */
const PROBE_NETWORK_FAILURE =
  /connection refused|connection reset by peer|connection timed out|connection closed|network unreachable|host unreachable|host not found|temporary name resolution failure|request aborted|timed out|network error/i;

/**
 * Optional evidence destination. The default lands under the OS temporary
 * directory so a run always records its observations without writing into the
 * package or the operator's state root.
 */
const EVIDENCE_ENV = "EASY_HOST_UPDATE_EVIDENCE";
const evidencePath =
  process.env[EVIDENCE_ENV]?.trim() ||
  path.join(tmpdir(), `easy-host-update-evidence-${process.pid}.json`);

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPRESS_FIXTURE = path.join(REPOSITORY_ROOT, "fixtures", "express-api");

/** Rootless Podman range supported by v1. */
const MINIMUM_PODMAN: readonly [number, number, number] = [5, 7, 0];
const EXCLUDED_PODMAN_MAJOR = 6;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface AddedObservation {
  readonly app: string;
  readonly port: number;
  readonly repo: string;
  readonly image: string;
  readonly containerId: string;
  readonly url: string;
  readonly commit: string;
  readonly healthAttempts: number;
  readonly healthElapsedMs: number;
  readonly durationMs: number;
}

interface BrokenUpdateObservation {
  readonly exitCode: number;
  readonly code: string;
  readonly stage: string;
  readonly reason: string;
  readonly candidateImage: string;
  readonly currentImage: string;
  readonly restored: boolean;
  readonly state: string;
  readonly containerImage: string;
  readonly containerId: string;
  readonly body: string;
  readonly recordedCurrent: string | null;
  readonly recordedPrevious: string | null;
  readonly recordedHealth: string | undefined;
  readonly recordedDetail: string | undefined;
  readonly candidateImageKept: boolean;
  readonly progress: readonly string[];
  readonly durationMs: number;
}

interface FixedUpdateObservation {
  readonly exitCode: number;
  readonly app: string;
  readonly port: number;
  readonly image: string;
  readonly previousImage: string | null;
  readonly containerId: string;
  readonly body: string;
  readonly recordedCurrent: string | null;
  readonly recordedPrevious: string | null;
  readonly durationMs: number;
}

interface ConfigOnlyObservation {
  readonly exitCode: number;
  readonly image: string;
  readonly previousImage: string | null;
  readonly containerId: string;
  readonly buildRequests: number;
  readonly imagesBefore: readonly string[];
  readonly imagesAfter: readonly string[];
  readonly containerImage: string;
  readonly environment: readonly string[];
  readonly volume: string;
  readonly body: string;
  readonly recordedCurrent: string | null;
  readonly recordedPrevious: string | null;
  readonly durationMs: number;
}

interface PodmanInspect {
  readonly Id?: string;
  readonly State?: { readonly Running?: boolean; readonly Status?: string };
  readonly HostConfig?: { readonly RestartPolicy?: { readonly Name?: string } };
  readonly Config?: {
    readonly Image?: string;
    readonly Env?: readonly string[];
    readonly Labels?: Readonly<Record<string, string>>;
  };
  readonly NetworkSettings?: {
    readonly Ports?: Readonly<
      Record<string, readonly { readonly HostIp?: string; readonly HostPort?: string }[] | null>
    >;
  };
  readonly Mounts?: readonly {
    readonly Type?: string;
    readonly Name?: string;
    readonly Destination?: string;
  }[];
}

interface PodmanVolumeInspect {
  readonly Name?: string;
  readonly Labels?: Readonly<Record<string, string>>;
}

interface RecordedState {
  readonly images?: { readonly current?: string | null; readonly previous?: string | null };
  readonly containerId?: string | null;
  readonly health?: { readonly status?: string; readonly detail?: string | null };
}

interface ErrorDocument {
  readonly schemaVersion?: number;
  readonly error?: {
    readonly code?: string;
    readonly exitCode?: number;
    readonly summary?: string;
    readonly details?: Record<string, unknown>;
    readonly remediation?: string | null;
  };
}

let temporaryRoot: string | undefined;
let paths: Paths | undefined;
let runSuffix = "";
let testApp = "";
let fixtureRepoPath: string | undefined;
let fixtureRepoUrl: string | undefined;
let podmanVersion = "";
let added: AddedObservation | undefined;
let broken: BrokenUpdateObservation | undefined;
let fixed: FixedUpdateObservation | undefined;
let configOnly: ConfigOnlyObservation | undefined;
let cleanupPromise: Promise<void> | undefined;

const createdImages = new Set<string>();
const createdVolumes = new Set<string>();

describe("update on the real host", () => {
  beforeAll(async () => {
    try {
      podmanVersion = await assertHostPrerequisites();

      temporaryRoot = mkdtempSync(path.join(tmpdir(), "easy-host-update-it-"));
      runSuffix = `${process.pid.toString(36)}${Date.now().toString(36)}`;
      testApp = `it-update-${runSuffix}`;
      paths = createPaths({ env: environmentFor(temporaryRoot) }).ensureLayout();

      fixtureRepoPath = await createVersionOneFixture();
      fixtureRepoUrl = `file://${fixtureRepoPath}`;
    } catch (error) {
      // afterAll may not run when beforeAll throws, so clean up here too.
      await cleanup();
      throw error;
    }
  }, SETUP_TIMEOUT_MS);

  it(
    "adds version one from the local fixture and serves it",
    async () => {
      const repo = requireFixtureUrl();
      const app = requireApp();
      const port = await findFreePort();

      const startedAt = Date.now();
      const result = await addApp({
        repo,
        ref: "main",
        name: app,
        port,
        bind: "127.0.0.1",
        containerPort: FIXTURE_CONTAINER_PORT,
        yes: true,
        interactive: false,
        environment: environment(),
      });
      const durationMs = Date.now() - startedAt;

      assertHealthyAdd(result, app, port);
      createdImages.add(result.image);

      const body = await fetchBody(port);
      expect(body, "version one must answer before any update runs").toContain(VERSION_ONE_BODY);

      const persisted = readRecordedState(app);
      expect(persisted.images?.current).toBe(result.image);
      expect(persisted.images?.previous).toBeNull();

      added = {
        app,
        port,
        repo,
        image: result.image,
        containerId: requireContainerId(result),
        url: result.url,
        commit: await gitHead(requireFixtureRepoPath()),
        healthAttempts: result.health.attempts,
        healthElapsedMs: result.health.elapsedMs,
        durationMs,
      };
      writeUpdateEvidence();

      console.info(
        `[update-integration] ${JSON.stringify({
          event: "version-one-added",
          ...added,
          body,
        })}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "keeps version one serving and exits 4 when the commit is broken",
    async () => {
      const context = requireUpdatedApp();
      const { app, port, image: versionOne } = context;

      // A syntactically invalid `server.js`: the image still builds (Railpack
      // only installs and exports), but `node server.js` crashes at startup, so
      // the candidate can never answer on the published port.
      const brokenCommit = await commitServerSource(
        'const express = require("express";\n',
        "broken commit",
      );

      const stdout = new RecordingStream();
      const stderr = new RecordingStream();
      const startedAt = Date.now();
      const exitCode = await runUpdateCommand({
        app,
        json: true,
        stdout,
        stderr,
        environment: environment(),
      });
      const durationMs = Date.now() - startedAt;

      expect(exitCode, "a failed candidate must map to the documented health exit code").toBe(4);

      const document = parseErrorDocument(stdout.text);
      const error = document.error;
      if (error === undefined || error.details === undefined) {
        throw new Error(`the failed update did not emit an error document: ${stdout.text}`);
      }

      expect(document.schemaVersion).toBe(1);
      expect(error.exitCode).toBe(4);
      expect(error.code).toBe("UPDATE_CANDIDATE_FAILED");

      const reason = textDetail(error.details, "reason");
      const candidateImage = textDetail(error.details, "candidate");
      const currentImage = textDetail(error.details, "image");
      createdImages.add(candidateImage);

      expect(reason, "the failure reason must be a probe failure, not a build error").toMatch(
        PROBE_NETWORK_FAILURE,
      );
      expect(error.details.stage, "the build succeeded; the probe is what failed").toBe("probe");
      expect(error.details.restored, "the previous image must be serving again").toBe(true);
      expect(error.details.state).toBe("reverted");
      expect(currentImage).toBe(versionOne);
      expect(
        candidateImage,
        "the candidate must be a new image, not the image that is still serving",
      ).not.toBe(versionOne);
      expect(candidateImage).toMatch(new RegExp(`^localhost/easy-host-${app}:\\d{8}T\\d{6}Z$`));
      expect(textDetail(error.details, "previous")).toContain("serving again");
      expect(error.remediation ?? "").toContain(`easy-host update ${app}`);

      // The failure reason must also reach the operator through progress.
      expect(stderr.text, "the phase stream must report the revert").toContain(
        "update: reverting:",
      );
      expect(stderr.text).toContain("update: reverted:");
      expect(stderr.text, "the printed progress must carry the probe reason").toContain(reason);

      // UPD-FR-02: the old container is running from its recorded image again.
      const inspect = await inspectAppContainer(app);
      const containerId = requireInspectId(inspect, app);
      assertRunningAppContainer(inspect, app, port, versionOne);

      const body = await fetchBody(port);
      expect(body, "version one must still answer after a broken update").toContain(
        VERSION_ONE_BODY,
      );
      expect(body, "a broken candidate must not serve its own version").not.toContain(
        VERSION_TWO_PREFIX,
      );

      // UPD-FR-03: a revert leaves the recorded image pair exactly as it was.
      const persisted = readRecordedState(app);
      expect(persisted.images?.current, "state.json must still record the old image").toBe(
        versionOne,
      );
      expect(persisted.images?.previous).toBeNull();
      expect(persisted.containerId, "state.json must record the restored container").toBe(
        containerId,
      );
      expect(persisted.health?.status).toBe("healthy");
      expect(
        persisted.health?.detail ?? "",
        "the recorded health detail must carry the same failure reason",
      ).toContain(reason);
      expect(persisted.health?.detail ?? "").toContain("serving again");

      expect(
        await podmanImageExists(candidateImage),
        "the built candidate image is kept; update never prunes images",
      ).toBe(true);

      broken = {
        exitCode,
        code: error.code ?? "",
        stage: String(error.details.stage),
        reason,
        candidateImage,
        currentImage,
        restored: true,
        state: String(error.details.state),
        containerImage: requireContainerImage(inspect, app),
        containerId,
        body,
        recordedCurrent: persisted.images?.current ?? null,
        recordedPrevious: persisted.images?.previous ?? null,
        recordedHealth: persisted.health?.status,
        recordedDetail: persisted.health?.detail ?? undefined,
        candidateImageKept: true,
        progress: [
          `reverting=${stderr.text.includes("update: reverting:")}`,
          `reverted=${stderr.text.includes("update: reverted:")}`,
        ],
        durationMs,
      };
      writeUpdateEvidence();

      console.info(
        `[update-integration] ${JSON.stringify({
          event: "broken-update",
          brokenCommit,
          ...broken,
        })}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "serves version two after the commit is fixed",
    async () => {
      const context = requireUpdatedApp();
      const { app, port, image: versionOne } = context;

      const fixedCommit = await commitServerSource(versionTwoServerSource(), "fixed commit");

      const stdout = new RecordingStream();
      const stderr = new RecordingStream();
      const startedAt = Date.now();
      const exitCode = await runUpdateCommand({
        app,
        stdout,
        stderr,
        environment: environment(),
      });
      const durationMs = Date.now() - startedAt;

      expect(exitCode, "a healthy rebuild must exit 0").toBe(0);
      expect(stdout.text).toContain(`updated "${app}" (rebuild)`);

      const persisted = readRecordedState(app);
      const image = persisted.images?.current ?? null;
      if (image === null) {
        throw new Error("the fixed update did not record a current image");
      }

      createdImages.add(image);
      expect(image, "the fixed update must build a new image").not.toBe(versionOne);
      expect(image).toMatch(new RegExp(`^localhost/easy-host-${app}:\\d{8}T\\d{6}Z$`));
      expect(
        stdout.text,
        "the summary must name the image now serving and the rollback target",
      ).toContain(image);
      expect(stdout.text).toContain(versionOne);

      const inspect = await inspectAppContainer(app);
      const containerId = requireInspectId(inspect, app);
      assertRunningAppContainer(inspect, app, port, image);
      expect(containerId, "the candidate must be a fresh container").not.toBe(context.containerId);

      const body = await fetchBody(port);
      expect(body, "version two must serve after the fixed commit").toContain(VERSION_TWO_PREFIX);
      expect(body).toContain("label=none");
      expect(body, "the previous version must no longer answer").not.toContain(VERSION_ONE_BODY);

      expect(persisted.images?.current).toBe(image);
      expect(persisted.images?.previous, "the old image must become the rollback target").toBe(
        versionOne,
      );
      expect(persisted.containerId).toBe(containerId);
      expect(persisted.health?.status).toBe("healthy");

      fixed = {
        exitCode,
        app,
        port,
        image,
        previousImage: persisted.images?.previous ?? null,
        containerId,
        body,
        recordedCurrent: persisted.images?.current ?? null,
        recordedPrevious: persisted.images?.previous ?? null,
        durationMs,
      };
      writeUpdateEvidence();

      console.info(
        `[update-integration] ${JSON.stringify({
          event: "fixed-update",
          fixedCommit,
          ...fixed,
        })}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "recreates the container without invoking the builder for a config-only update",
    async () => {
      const context = requireFixedApp();
      const { app, port, image } = context;
      const previousImage = requireFixedPreviousImage();
      const imagesBefore = await listTestImages(app);

      // A change limited to env and volumes is config-only (UPD-FR-01). The
      // builder is replaced by a recorder that fails the test if update ever
      // tries to build; the real runtime, probe, and swap still run.
      const builder = new RefusingBuilder();
      const dependencies: UpdateDependencyOverrides = { builder };

      const stdout = new RecordingStream();
      const stderr = new RecordingStream();
      const startedAt = Date.now();
      const exitCode = await runUpdateCommand({
        app,
        changes: {
          env: { FIXTURE_LABEL: CONFIG_ONLY_LABEL },
          volumes: { [CONFIG_ONLY_VOLUME]: CONFIG_ONLY_VOLUME_TARGET },
        },
        stdout,
        stderr,
        dependencies,
        environment: environment(),
      });
      const durationMs = Date.now() - startedAt;

      expect(exitCode, "a healthy config-only recreate must exit 0").toBe(0);
      expect(
        builder.requests,
        "a config-only update must never invoke the builder (UPD-FR-05)",
      ).toHaveLength(0);
      expect(stdout.text).toContain(`updated "${app}" (config-only)`);
      expect(stdout.text).toContain("image build");
      expect(stdout.text, "the summary must name the reused image").toContain(image);

      const imagesAfter = await listTestImages(app);
      expect(
        [...imagesAfter].sort(),
        "no image may be created by a config-only update, even if the builder seam were bypassed",
      ).toEqual([...imagesBefore].sort());

      const inspect = await inspectAppContainer(app);
      const containerId = requireInspectId(inspect, app);
      assertRunningAppContainer(inspect, app, port, image);
      expect(containerId, "the recorded image must be recreated as a new container").not.toBe(
        context.containerId,
      );
      expect(inspect.Config?.Env ?? [], "the new environment must reach the container").toContain(
        `FIXTURE_LABEL=${CONFIG_ONLY_LABEL}`,
      );

      const volume = volumeName(app, CONFIG_ONLY_VOLUME);
      createdVolumes.add(volume);
      const mount = (inspect.Mounts ?? []).find(
        (entry) => entry.Destination === CONFIG_ONLY_VOLUME_TARGET,
      );
      expect(mount, "the newly declared volume must be mounted at its target").toBeDefined();
      expect(mount?.Type).toBe("volume");
      expect(mount?.Name).toBe(volume);
      const volumeInspect = await inspectVolume(volume);
      expect(volumeInspect.Labels?.[APP_LABEL], "the volume must be labelled for its app").toBe(
        app,
      );

      const body = await fetchBody(port);
      expect(
        body,
        "the recreated container must serve the same image with the new settings",
      ).toContain(`${VERSION_TWO_PREFIX} label=${CONFIG_ONLY_LABEL}`);
      expect(body).not.toContain(VERSION_ONE_BODY);

      const persisted = readRecordedState(app);
      expect(persisted.images?.current, "the image pair must survive a config-only update").toBe(
        image,
      );
      expect(persisted.images?.previous).toBe(previousImage);
      expect(persisted.containerId).toBe(containerId);
      expect(persisted.health?.status).toBe("healthy");

      // The desired settings must be persisted by the same update.
      const config = new Registry(requirePaths()).readConfig(app);
      expect(config.env.FIXTURE_LABEL).toBe(CONFIG_ONLY_LABEL);
      expect(config.volumes[CONFIG_ONLY_VOLUME]).toBe(CONFIG_ONLY_VOLUME_TARGET);

      configOnly = {
        exitCode,
        image,
        previousImage,
        containerId,
        buildRequests: builder.requests.length,
        imagesBefore,
        imagesAfter,
        containerImage: requireContainerImage(inspect, app),
        environment: inspect.Config?.Env ?? [],
        volume,
        body,
        recordedCurrent: persisted.images?.current ?? null,
        recordedPrevious: persisted.images?.previous ?? null,
        durationMs,
      };
      writeUpdateEvidence();

      console.info(
        `[update-integration] ${JSON.stringify({
          event: "config-only-update",
          ...configOnly,
        })}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    }

    try {
      writeUpdateEvidence(true, cleanupError);
    } catch (error) {
      throw new Error(`could not record update evidence at "${evidencePath}": ${messageOf(error)}`);
    }

    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }, CLEANUP_TIMEOUT_MS);
});

/** Builds the environment `update` needs; the state root is always test-owned. */
function environmentFor(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, EASY_HOST_HOME: root };
  // Prove the managed Railpack acquisition instead of an operator override.
  delete environment.EASY_HOST_RAILPACK_BIN;
  return environment;
}

function environment(): NodeJS.ProcessEnv {
  return environmentFor(requireTempRoot());
}

/**
 * Verifies the host contract before any mutation: Linux, a supported rootless
 * Podman, the Docker-compatible loader Railpack exports through, and an unused
 * managed-buildkitd name.
 */
async function assertHostPrerequisites(): Promise<string> {
  if (process.platform !== "linux") {
    throw new Error(
      `the gated update suite runs only on the Linux target host; this platform is "${process.platform}"`,
    );
  }

  const version = await runCommand(
    "podman",
    ["version", "--format", "{{.Client.Version}}"],
    COMMAND_TIMEOUT_MS,
  ).catch((error: unknown) => {
    throw new Error(
      `could not run "podman" (${messageOf(error)}); the gated update suite requires rootless Podman >= ${MINIMUM_PODMAN.join(".")} and < ${EXCLUDED_PODMAN_MAJOR}.0.0`,
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
      `Podman ${major}.${minor}.${patch} is outside the supported range >= ${MINIMUM_PODMAN.join(".")} and < ${EXCLUDED_PODMAN_MAJOR}.0.0; upgrade or downgrade the host before running the update suite`,
    );
  }

  // Railpack 0.43.0 pipes its export into `docker load`; without a compatible
  // loader the build hangs at export instead of failing fast (BLD-0.1 §6.7).
  const loader = await runCommand("docker", ["load", "--help"], COMMAND_TIMEOUT_MS).catch(
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

  // The production update builder owns the fixed managed-buildkitd name. Refuse
  // to replace an operator daemon rather than silently stopping it.
  const daemonExists = await podmanContainerExists(BUILDKIT_CONTAINER_NAME);
  if (daemonExists) {
    throw new Error(
      `container "${BUILDKIT_CONTAINER_NAME}" already exists; the gated update suite owns the managed buildkitd and will not replace it. Stop and remove it with "podman stop ${BUILDKIT_CONTAINER_NAME} && podman rm ${BUILDKIT_CONTAINER_NAME}" (or use another host) before running the suite`,
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

/**
 * Copies the supported Node/Express fixture into a test-owned repository and
 * commits version one on `main`. A real clone through `file://` keeps the add
 * path honest without needing network access to a remote; the test then owns
 * every later commit.
 */
async function createVersionOneFixture(): Promise<string> {
  if (!existsSync(EXPRESS_FIXTURE)) {
    throw new Error(`the express-api fixture is missing at ${EXPRESS_FIXTURE}`);
  }

  const repoDir = path.join(requireTempRoot(), "repos", "update-fixture");
  mkdirSync(path.dirname(repoDir), { recursive: true });
  cpSync(EXPRESS_FIXTURE, repoDir, { recursive: true });
  writeFileSync(path.join(repoDir, "server.js"), versionOneServerSource());

  await runGit(["init", "--initial-branch=main", repoDir]);
  await runGit(["-C", repoDir, "add", "--all"]);
  await runGit([
    "-C",
    repoDir,
    "-c",
    "user.name=easy-host integration",
    "-c",
    "user.email=integration@easy-host.invalid",
    "commit",
    "-m",
    "version one",
  ]);

  return repoDir;
}

/** Writes a new `server.js`, commits it, and returns the new commit id. */
async function commitServerSource(source: string, message: string): Promise<string> {
  const repo = requireFixtureRepoPath();
  writeFileSync(path.join(repo, "server.js"), source);
  await runGit(["-C", repo, "add", "--all"]);
  await runGit([
    "-C",
    repo,
    "-c",
    "user.name=easy-host integration",
    "-c",
    "user.email=integration@easy-host.invalid",
    "commit",
    "-m",
    message,
  ]);

  return gitHead(repo);
}

/** Version one: the known-good response the failure path must preserve. */
function versionOneServerSource(): string {
  return [
    'const express = require("express");',
    "",
    'const port = Number.parseInt(process.env.PORT ?? "", 10);',
    "",
    "if (!Number.isInteger(port) || port < 1 || port > 65535) {",
    '  console.error("PORT must be set to a valid TCP port");',
    "  process.exit(1);",
    "}",
    "",
    "const app = express();",
    "",
    'app.get("/", (_request, response) => {',
    `  response.type("text/plain").send("${VERSION_ONE_BODY}");`,
    "});",
    "",
    'app.listen(port, "0.0.0.0", () => {',
    '  console.log("update-fixture listening on port " + port);',
    "});",
    "",
  ].join("\n");
}

/** Version two: adds the env-driven label the config-only step changes. */
function versionTwoServerSource(): string {
  return [
    'const express = require("express");',
    "",
    'const port = Number.parseInt(process.env.PORT ?? "", 10);',
    "",
    "if (!Number.isInteger(port) || port < 1 || port > 65535) {",
    '  console.error("PORT must be set to a valid TCP port");',
    "  process.exit(1);",
    "}",
    "",
    "const app = express();",
    "",
    'app.get("/", (_request, response) => {',
    `  response
    .type("text/plain")
    .send(\`${VERSION_TWO_PREFIX} label=\${process.env.FIXTURE_LABEL ?? "none"}\`);`,
    "});",
    "",
    'app.listen(port, "0.0.0.0", () => {',
    '  console.log("update-fixture listening on port " + port);',
    "});",
    "",
  ].join("\n");
}

async function gitHead(directory: string): Promise<string> {
  const result = await runCommand(
    "git",
    ["-C", directory, "rev-parse", "HEAD"],
    COMMAND_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `"git -C ${directory} rev-parse HEAD" exited with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  return result.stdout.trim();
}

async function runGit(args: readonly string[]): Promise<void> {
  const result = await runCommand("git", args, COMMAND_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new Error(
      `"git ${args.join(" ")}" exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

/** Picks an ephemeral host port, then releases it for Podman to publish. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine a free host port"));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error === undefined) {
          resolve(port);
        } else {
          reject(error);
        }
      });
    });
  });
}

/**
 * The add assertions. They are deliberately repeated here (instead of trusting
 * the add suite's run) because this suite owns the starting state that every
 * later update assertion depends on.
 */
function assertHealthyAdd(result: AddResult, app: string, port: number): void {
  expect(result.app).toBe(app);
  expect(result.container).toBe(containerName(app));
  expect(result.port).toBe(port);
  expect(result.bind).toBe("127.0.0.1");
  expect(result.previousImage).toBeNull();
  expect(result.devOnly).toBe(false);
  expect(result.mode).toBe("git");
  expect(result.url).toBe(`http://localhost:${port}/`);
  expect(result.health.healthy, "add must not return without a healthy probe").toBe(true);
  expect(result.health.state).toBe("healthy");
  expect(result.health.attempts).toBeGreaterThanOrEqual(1);
  expect(result.image).toMatch(new RegExp(`^localhost/easy-host-${app}:\\d{8}T\\d{6}Z$`));
  expect(result.volumes).toEqual([]);

  const state = result.state;
  if (state === null) {
    throw new Error(`add did not record state.json for "${app}"`);
  }

  expect(state.images.current).toBe(result.image);
  expect(state.images.previous).toBeNull();
  expect(state.health.status).toBe("healthy");
  expect(state.containerId, "the healthy container id must be recorded").toMatch(/^[0-9a-f]{12,}$/);
}

/** The fields update promises on the host for a running app container. */
function assertRunningAppContainer(
  inspect: PodmanInspect,
  app: string,
  port: number,
  image: string,
): void {
  const binding = inspect.NetworkSettings?.Ports?.[`${FIXTURE_CONTAINER_PORT}/tcp`]?.[0];

  expect(inspect.State?.Running, "the app container must be running").toBe(true);
  expect(inspect.HostConfig?.RestartPolicy?.Name, "restart policy must survive a swap").toBe(
    "always",
  );
  expect(binding, `host port ${port} must be published`).toBeDefined();
  expect(binding?.HostPort).toBe(String(port));
  expect(binding?.HostIp).toBe("127.0.0.1");
  expect(requireContainerImage(inspect, app), "the container must run the expected image").toBe(
    image,
  );

  const labels = inspect.Config?.Labels ?? {};
  expect(labels[APP_LABEL]).toBe(app);
  expect(labels[ROLE_LABEL]).toBe(APP_ROLE_VALUE);
  expect(labels[IMAGE_LABEL]).toBe(image);
}

function requireContainerImage(inspect: PodmanInspect, app: string): string {
  const image = inspect.Config?.Image;
  if (typeof image !== "string" || image.length === 0) {
    throw new Error(`the container for "${app}" does not report its image`);
  }

  return image;
}

function requireInspectId(inspect: PodmanInspect, app: string): string {
  const id = inspect.Id;
  if (typeof id !== "string" || !/^[0-9a-f]{12,}$/.test(id)) {
    throw new Error(`the container for "${app}" does not report a usable id`);
  }

  return id;
}

function requireContainerId(result: AddResult): string {
  const id = result.state?.containerId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("add did not record a container id");
  }

  return id;
}

async function inspectAppContainer(app: string): Promise<PodmanInspect> {
  const result = await runPodman(["inspect", containerName(app)]);
  if (result.exitCode !== 0) {
    throw new Error(
      `"podman inspect ${containerName(app)}" exited with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`unexpected "podman inspect" output for "${app}": ${result.stdout.trim()}`);
  }

  return parsed[0] as PodmanInspect;
}

async function inspectVolume(name: string): Promise<PodmanVolumeInspect> {
  const result = await runPodman(["volume", "inspect", name]);
  if (result.exitCode !== 0) {
    throw new Error(
      `"podman volume inspect ${name}" exited with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `unexpected "podman volume inspect" output for "${name}": ${result.stdout.trim()}`,
    );
  }

  return parsed[0] as PodmanVolumeInspect;
}

/** Proves the app answers over HTTP on the loopback interface. */
async function fetchBody(port: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/`;
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();

  expect(response.status, `expected ${url} to answer with 2xx`).toBe(200);
  return body;
}

function parseErrorDocument(text: string): ErrorDocument {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("the failed update wrote no JSON error document to stdout");
  }

  const parsed: unknown = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`the failed update wrote an unexpected JSON document: ${trimmed}`);
  }

  return parsed as ErrorDocument;
}

function textDetail(details: Record<string, unknown>, key: string): string {
  const value = details[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`the failed update did not record the "${key}" detail`);
  }

  return value;
}

function readRecordedState(app: string): RecordedState {
  const statePath = path.join(requirePaths().appDir(app), "state.json");
  const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`unexpected state.json for "${app}"`);
  }

  return parsed as RecordedState;
}

async function podmanContainerExists(name: string): Promise<boolean> {
  const result = await runPodman(["container", "exists", name]);
  if (result.exitCode === 0) {
    return true;
  }

  if (result.exitCode === 1) {
    return false;
  }

  throw new Error(
    `"podman container exists ${name}" failed with code ${result.exitCode}: ${result.stderr.trim()}`,
  );
}

async function podmanImageExists(image: string): Promise<boolean> {
  const result = await runPodman(["image", "exists", image]);
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

function runPodman(args: readonly string[]): Promise<CommandResult> {
  return runCommand("podman", args, COMMAND_TIMEOUT_MS);
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

function requireApp(): string {
  if (testApp.length === 0) {
    throw new Error("the integration harness has not initialized the app name");
  }

  return testApp;
}

function requireFixtureRepoPath(): string {
  if (fixtureRepoPath === undefined) {
    throw new Error("the local git fixture repository was not created");
  }

  return fixtureRepoPath;
}

function requireFixtureUrl(): string {
  if (fixtureRepoUrl === undefined) {
    throw new Error("the local git fixture URL was not created");
  }

  return fixtureRepoUrl;
}

function requireUpdatedApp(): AddedObservation {
  if (added === undefined) {
    throw new Error("the version-one add did not complete, so update cannot be exercised");
  }

  return added;
}

function requireFixedApp(): FixedUpdateObservation {
  if (fixed === undefined) {
    throw new Error("the fixed update did not complete, so the config-only update cannot run");
  }

  return fixed;
}

function requireFixedPreviousImage(): string {
  const previous = fixed?.previousImage;
  if (typeof previous !== "string" || previous.length === 0) {
    throw new Error("the fixed update did not record a rollback target");
  }

  return previous;
}

function requireTempRoot(): string {
  if (temporaryRoot === undefined) {
    throw new Error("the temporary state root was not created");
  }

  return temporaryRoot;
}

function requirePaths(): Paths {
  if (paths === undefined) {
    throw new Error("the isolated easy-host state root was not created");
  }

  return paths;
}

function cleanup(): Promise<void> {
  cleanupPromise ??= performCleanup();
  return cleanupPromise;
}

/**
 * Removes only what this suite created: the app container, its volumes, its
 * images, the managed daemon, and the temporary state root. Missing resources
 * are tolerated; every other cleanup failure is reported so a leak cannot
 * masquerade as a pass. Afterwards each resource class is re-read from Podman
 * to prove nothing was orphaned.
 */
async function performCleanup(): Promise<void> {
  const failures: string[] = [];
  const app = testApp.length > 0 ? testApp : undefined;

  if (app !== undefined) {
    try {
      const result = await runPodman(["rm", "--force", containerName(app)]);
      if (result.exitCode !== 0 && !isMissingContainer(result.stderr)) {
        failures.push(`remove container "${containerName(app)}": ${result.stderr.trim()}`);
      }
    } catch (error) {
      failures.push(`remove container "${containerName(app)}": ${messageOf(error)}`);
    }

    try {
      const listed = await runPodman([
        "volume",
        "ls",
        "--filter",
        `label=${APP_LABEL}=${app}`,
        "--format",
        "{{.Name}}",
      ]);
      if (listed.exitCode !== 0) {
        failures.push(`list volumes for "${app}": ${listed.stderr.trim()}`);
      } else {
        for (const name of splitLines(listed.stdout)) {
          createdVolumes.add(name);
        }
      }
    } catch (error) {
      failures.push(`list volumes for "${app}": ${messageOf(error)}`);
    }
  }

  for (const volume of [...createdVolumes].reverse()) {
    try {
      const result = await runPodman(["volume", "rm", "--force", volume]);
      if (result.exitCode !== 0 && !isMissingVolume(result.stderr)) {
        failures.push(`remove volume "${volume}": ${result.stderr.trim()}`);
      }
    } catch (error) {
      failures.push(`remove volume "${volume}": ${messageOf(error)}`);
    }
  }

  if (app !== undefined) {
    try {
      for (const image of await listTestImages(app)) {
        createdImages.add(image);
      }
    } catch (error) {
      failures.push(`list images created by this run: ${messageOf(error)}`);
    }
  }

  for (const image of [...createdImages].reverse()) {
    try {
      const result = await runPodman(["rmi", "--force", image]);
      if (result.exitCode !== 0 && !isMissingImage(result.stderr)) {
        failures.push(`remove image "${image}": ${result.stderr.trim()}`);
      }
    } catch (error) {
      failures.push(`remove image "${image}": ${messageOf(error)}`);
    }
  }

  if (paths !== undefined) {
    try {
      await createBuildkit({ paths }).stop();
    } catch (error) {
      failures.push(`stop the managed buildkitd: ${messageOf(error)}`);
    }
  }

  if (temporaryRoot !== undefined) {
    const removalError = await removeTemporaryRoot(temporaryRoot);
    if (removalError !== undefined) {
      failures.push(removalError);
    }
  }

  // Prove the cleanup instead of trusting the removal commands.
  if (app !== undefined) {
    try {
      if (await podmanContainerExists(containerName(app))) {
        failures.push(`container "${containerName(app)}" still exists after cleanup`);
      }
    } catch (error) {
      failures.push(`verify container "${containerName(app)}" removal: ${messageOf(error)}`);
    }

    try {
      const remaining = await runPodman([
        "volume",
        "ls",
        "--filter",
        `label=${APP_LABEL}=${app}`,
        "--format",
        "{{.Name}}",
      ]);
      if (remaining.exitCode !== 0) {
        failures.push(`verify volume removal for "${app}": ${remaining.stderr.trim()}`);
      } else if (splitLines(remaining.stdout).length > 0) {
        failures.push(
          `volumes still exist for "${app}" after cleanup: ${splitLines(remaining.stdout).join(", ")}`,
        );
      }
    } catch (error) {
      failures.push(`verify volume removal for "${app}": ${messageOf(error)}`);
    }

    try {
      const remaining = await listTestImages(app);
      if (remaining.length > 0) {
        failures.push(`images still exist after cleanup: ${remaining.join(", ")}`);
      }
    } catch (error) {
      failures.push(`verify image removal: ${messageOf(error)}`);
    }
  }

  if (temporaryRoot !== undefined && existsSync(temporaryRoot)) {
    failures.push(`the temporary state root "${temporaryRoot}" still exists after cleanup`);
  }

  if (failures.length > 0) {
    throw new Error(`update integration cleanup failed:\n- ${failures.join("\n- ")}`);
  }
}

/**
 * Lists image references that belong to this run, identified by the unique app
 * name. The suffix embeds the pid and start time, so a prefix match cannot
 * reach an operator image or a previous run.
 */
async function listTestImages(app: string): Promise<readonly string[]> {
  const result = await runPodman(["images", "--format", "{{.Repository}}:{{.Tag}}"]);
  if (result.exitCode !== 0) {
    throw new Error(`"podman images" failed with code ${result.exitCode}: ${result.stderr.trim()}`);
  }

  const prefix = `localhost/easy-host-${app}:`;
  return splitLines(result.stdout).filter((reference) => reference.startsWith(prefix));
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
    const result = await runPodman(["unshare", "rm", "-rf", directory]);
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
 * A builder that records the call and fails the update if it is reached. The
 * config-only path must never invoke it (UPD-FR-05); recording keeps the
 * failure legible instead of silently building.
 */
class RefusingBuilder implements AddBuilder {
  readonly requests: AddBuildRequest[] = [];

  async build(request: AddBuildRequest): Promise<AddBuildResult> {
    this.requests.push(request);
    throw new Error("a config-only update must not invoke the builder");
  }
}

/**
 * Persists the observations so a later failure still leaves the timings and
 * evidence already collected, then once more after cleanup.
 */
function writeUpdateEvidence(final = false, cleanupError?: unknown): void {
  const document = {
    schemaVersion: 1,
    task: "UPD-1.4",
    generatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      podman: podmanVersion,
    },
    pins: {
      railpack: RAILPACK_VERSION,
    },
    stateRoot: temporaryRoot ?? null,
    fixture: {
      repo: fixtureRepoUrl ?? null,
      app: testApp.length > 0 ? testApp : null,
    },
    added: added ?? null,
    brokenUpdate: broken ?? null,
    fixedUpdate: fixed ?? null,
    configOnlyUpdate: configOnly ?? null,
    cleanup: final ? (cleanupError === undefined ? "ok" : messageOf(cleanupError)) : "pending",
  };

  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
  console.info(
    `[update-integration] ${JSON.stringify({ event: "evidence", path: evidencePath, final })}`,
  );
}

class RecordingStream {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isMissingContainer(stderr: string): boolean {
  return /no such container|no container with name or id/i.test(stderr);
}

function isMissingVolume(stderr: string): boolean {
  return /no such volume|volume .* (?:does not exist|not found)/i.test(stderr);
}

function isMissingImage(stderr: string): boolean {
  return /no such image|image not known|unable to find|does not exist/i.test(stderr);
}

function isPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
