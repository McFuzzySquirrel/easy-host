/**
 * Gated end-to-end proof of `rollback` on the real host
 * (`RBK-FR-01`, `RBK-NF-02`, `PRD-NF-07`, `PRD-C-10`).
 *
 * This is the only test that drives the production rollback composition against
 * two real images built by the pinned Railpack binary on the managed rootless
 * buildkitd, a real container swap, and the real bounded HTTP probe. It proves
 * the three claims the PRD makes about rollback:
 *
 * 1. a rollback restores the previous serving version and swaps the recorded
 *    image pair, so a second rollback returns to the newer version;
 * 2. a rollback with only one recorded image exits 5 before touching the
 *    container, the app keeps serving, and nothing is rebuilt;
 * 3. neither rollback invokes a build: the production builder seam
 *    (`buildWorkspace`) records zero extra calls and no image is created,
 *    retagged, or replaced (`RBK-NF-02`).
 *
 * The no-build assertion is deliberately non-vacuous: the same counter must
 * observe exactly one call for the setup `add` and one more for the setup
 * `update`, so a counter that never fires fails the suite instead of passing it.
 *
 * The suite never skips: without `EASY_HOST_INTEGRATION=1` it throws while the
 * module is collected, naming the variable and the command to run. Every
 * resource is test-owned (temporary state root, a unique app name, a local git
 * fixture copy the test controls, one labelled volume) and cleanup runs after
 * both pass and failure, then re-reads Podman to prove that no container,
 * volume, image, daemon, or temporary root was orphaned.
 *
 * The managed buildkitd uses a fixed container name because the production
 * builder owns it. Setup therefore refuses to run when an `easy-host-buildkitd`
 * container already exists, so this suite can never clobber a daemon an
 * operator is using.
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runRollbackCommand } from "../../src/cli/commands/rollback.js";
import { runUpdateCommand } from "../../src/cli/commands/update.js";
import { type AddResult, addApp } from "../../src/lifecycle/add.js";
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

/**
 * Records every call to the production build seam. `rollback` has no builder
 * dependency by design, so this counter is the runtime proof that a rollback
 * cannot rebuild an image even indirectly (`RBK-NF-02`).
 */
const buildInvocations = vi.hoisted(() => {
  const calls: string[] = [];
  return calls;
});

vi.mock("../../src/platform/build.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/build.js")>();

  return {
    ...actual,
    buildWorkspace: async (options: Parameters<typeof actual.buildWorkspace>[0]) => {
      buildInvocations.push(`${options.app} ${options.workspace}`);
      return actual.buildWorkspace(options);
    },
  };
});

/** The gate variable. Missing it is a failure, never a skip. */
const INTEGRATION_ENV = "EASY_HOST_INTEGRATION";

if (process.env[INTEGRATION_ENV] !== "1") {
  throw new Error(
    `${INTEGRATION_ENV} must be set to "1" to run the gated rollback integration suite; ` +
      `it builds, swaps, and probes real containers. Run: ${INTEGRATION_ENV}=1 npm run test:integration -- tests/integration/rollback.test.ts`,
  );
}

/** Two cold fixture builds were ~248s-277s each in the build proof; allow headroom. */
const SCENARIO_TIMEOUT_MS = 20 * 60 * 1000;

/** Setup may include the Railpack download, the BuildKit pull, and the git copy. */
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/** Container removal plus daemon stop plus temporary-root deletion. */
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;

/** Finite bound on every direct Podman or git call made by this suite. */
const COMMAND_TIMEOUT_MS = 120 * 1000;

/** Declared container port used by the versioned fixture. */
const FIXTURE_CONTAINER_PORT = 3000;

/** The app's body for version one; rollback must restore it. */
const VERSION_ONE_BODY = "rollback-fixture version=one";

/** The app's body for version two; the second rollback must restore it. */
const VERSION_TWO_BODY = "rollback-fixture version=two";

/** The named volume declared on add, which every swap must preserve. */
const DATA_VOLUME = "data";
const DATA_VOLUME_TARGET = "/var/lib/data";

/**
 * Optional evidence destination. The default lands under the OS temporary
 * directory so a run always records its observations without writing into the
 * package or the operator's state root.
 */
const EVIDENCE_ENV = "EASY_HOST_ROLLBACK_EVIDENCE";
const evidencePath =
  process.env[EVIDENCE_ENV]?.trim() ||
  path.join(tmpdir(), `easy-host-rollback-evidence-${process.pid}.json`);

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

interface AddObservation {
  readonly app: string;
  readonly port: number;
  readonly repo: string;
  readonly image: string;
  readonly containerId: string;
  readonly url: string;
  readonly commit: string;
  readonly volume: string;
  readonly buildCalls: number;
  readonly images: readonly string[];
  readonly healthAttempts: number;
  readonly healthElapsedMs: number;
  readonly durationMs: number;
}

interface OneImageObservation {
  readonly exitCode: number;
  readonly code: string;
  readonly current: string;
  readonly previous: string;
  readonly state: string;
  readonly containerId: string;
  readonly body: string;
  readonly recordedCurrent: string | null;
  readonly recordedPrevious: string | null;
  readonly buildCalls: number;
  readonly images: readonly string[];
  readonly durationMs: number;
}

interface UpdateObservation {
  readonly exitCode: number;
  readonly app: string;
  readonly port: number;
  readonly image: string;
  readonly previousImage: string | null;
  readonly containerId: string;
  readonly body: string;
  readonly buildCalls: number;
  readonly images: readonly string[];
  readonly durationMs: number;
}

interface RollbackObservation {
  readonly exitCode: number;
  readonly restoredImage: string;
  readonly rollbackTarget: string;
  readonly containerId: string;
  readonly previousContainerId: string;
  readonly body: string;
  readonly recordedCurrent: string | null;
  readonly recordedPrevious: string | null;
  readonly buildCalls: number;
  readonly imagesBefore: readonly string[];
  readonly imagesAfter: readonly string[];
  readonly progress: readonly string[];
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

interface ImageSnapshot {
  /** `reference id` pairs, sorted; any new image changes this list. */
  readonly entries: readonly string[];
  readonly references: readonly string[];
}

let temporaryRoot: string | undefined;
let paths: Paths | undefined;
let runSuffix = "";
let testApp = "";
let fixtureRepoPath: string | undefined;
let fixtureRepoUrl: string | undefined;
let podmanVersion = "";
let added: AddObservation | undefined;
let oneImage: OneImageObservation | undefined;
let updated: UpdateObservation | undefined;
let firstRollback: RollbackObservation | undefined;
let secondRollback: RollbackObservation | undefined;
let cleanupPromise: Promise<void> | undefined;

const createdImages = new Set<string>();
const createdVolumes = new Set<string>();

describe("rollback on the real host", () => {
  beforeAll(async () => {
    try {
      podmanVersion = await assertHostPrerequisites();

      temporaryRoot = mkdtempSync(path.join(tmpdir(), "easy-host-rollback-it-"));
      runSuffix = `${process.pid.toString(36)}${Date.now().toString(36)}`;
      testApp = `it-rollback-${runSuffix}`;
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
      const volume = volumeName(app, DATA_VOLUME);

      const startedAt = Date.now();
      const result = await addApp({
        repo,
        ref: "main",
        name: app,
        port,
        bind: "127.0.0.1",
        containerPort: FIXTURE_CONTAINER_PORT,
        volume: [`${DATA_VOLUME}:${DATA_VOLUME_TARGET}`],
        yes: true,
        interactive: false,
        environment: environment(),
      });
      const durationMs = Date.now() - startedAt;

      assertHealthyAdd(result, app, port);
      createdImages.add(result.image);
      createdVolumes.add(volume);
      expect(result.volumes, "the declared data volume must be created").toEqual([volume]);

      // The counter must observe the setup build, otherwise the later
      // "rollback built nothing" assertion would be vacuous.
      expect(
        buildInvocations,
        "add must have exercised the production build seam once",
      ).toHaveLength(1);

      const inspect = await inspectAppContainer(app);
      const containerId = requireInspectId(inspect, app);
      assertRunningAppContainer(inspect, app, port, result.image);
      assertDataVolumeMounted(inspect, volume);

      const body = await fetchBody(port);
      expect(body, "version one must answer before any rollback runs").toContain(VERSION_ONE_BODY);
      expect(body).not.toContain(VERSION_TWO_BODY);

      const persisted = readRecordedState(app);
      expect(persisted.images?.current).toBe(result.image);
      expect(persisted.images?.previous).toBeNull();
      expect(persisted.containerId).toBe(containerId);

      const images = await snapshotImages(app);
      expect(images.references).toEqual([result.image]);

      const volumeInspect = await inspectVolume(volume);
      expect(volumeInspect.Labels?.[APP_LABEL], "the volume must be labelled for its app").toBe(
        app,
      );

      added = {
        app,
        port,
        repo,
        image: result.image,
        containerId,
        url: result.url,
        commit: await gitHead(requireFixtureRepoPath()),
        volume,
        buildCalls: buildInvocations.length,
        images: images.references,
        healthAttempts: result.health.attempts,
        healthElapsedMs: result.health.elapsedMs,
        durationMs,
      };
      writeRollbackEvidence();

      console.info(
        `[rollback-integration] ${JSON.stringify({
          event: "version-one-added",
          ...added,
          body,
        })}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "exits 5 for a one-image app and leaves it serving without a build",
    async () => {
      const context = requireAddedApp();
      const { app, port, image } = context;

      const imagesBefore = await snapshotImages(app);
      const buildCallsBefore = buildInvocations.length;

      const stdout = new RecordingStream();
      const stderr = new RecordingStream();
      const startedAt = Date.now();
      const exitCode = await runRollbackCommand({
        app,
        json: true,
        stdout,
        stderr,
        environment: environment(),
      });
      const durationMs = Date.now() - startedAt;

      expect(exitCode, "one recorded image must map to the documented not-found exit code").toBe(5);

      const document = parseErrorDocument(stdout.text);
      const error = document.error;
      if (error === undefined || error.details === undefined) {
        throw new Error(`the one-image rollback did not emit an error document: ${stdout.text}`);
      }

      expect(document.schemaVersion).toBe(1);
      expect(error.exitCode).toBe(5);
      expect(error.code).toBe("ROLLBACK_ONE_IMAGE");
      expect(error.details.app).toBe(app);
      expect(error.details.current).toBe(image);
      expect(error.details.previous).toBe("none");
      expect(error.details.state).toBe("recorded");
      expect(error.remediation ?? "").toContain(`easy-host update ${app}`);

      // RBK-FR-01: the check fails after locking but before any container
      // operation. `rollback` emits `inspecting` only after the pair is
      // accepted, so the observable proof is that no swap phase ever ran.
      expect(stderr.text, "the registry and lock phases must still run").toContain(
        "rollback: locking:",
      );
      expect(stderr.text, "a one-image rollback must not stop the container").not.toContain(
        "rollback: stopping:",
      );
      expect(stderr.text, "a one-image rollback must not start a container").not.toContain(
        "rollback: starting:",
      );
      expect(stderr.text, "a one-image rollback must not probe").not.toContain(
        "rollback: probing:",
      );
      expect(stderr.text, "a one-image rollback must not keep a candidate").not.toContain(
        "rollback: keeping:",
      );
      expect(stderr.text, "a one-image rollback must not record a new pair").not.toContain(
        "rollback: recording:",
      );

      // The app is untouched: same container, same image, same response.
      const inspect = await inspectAppContainer(app);
      const containerId = requireInspectId(inspect, app);
      expect(containerId, "the running container must not be replaced").toBe(context.containerId);
      assertRunningAppContainer(inspect, app, port, image);
      assertDataVolumeMounted(inspect, context.volume);

      const body = await fetchBody(port);
      expect(body, "the app must keep serving version one").toContain(VERSION_ONE_BODY);

      const persisted = readRecordedState(app);
      expect(persisted.images?.current).toBe(image);
      expect(persisted.images?.previous).toBeNull();
      expect(persisted.containerId).toBe(context.containerId);
      expect(
        persisted.health?.status,
        "a refused rollback must not record a new health state",
      ).toBe("healthy");

      // No build, no image: the pair check fails before the swap.
      expect(buildInvocations.length, "a one-image rollback must not invoke the builder").toBe(
        buildCallsBefore,
      );
      const imagesAfter = await snapshotImages(app);
      expect(imagesAfter.entries, "a one-image rollback must not create an image").toEqual(
        imagesBefore.entries,
      );

      oneImage = {
        exitCode,
        code: error.code ?? "",
        current: image,
        previous: "none",
        state: String(error.details.state),
        containerId,
        body,
        recordedCurrent: persisted.images?.current ?? null,
        recordedPrevious: persisted.images?.previous ?? null,
        buildCalls: buildInvocations.length,
        images: imagesAfter.references,
        durationMs,
      };
      writeRollbackEvidence();

      console.info(
        `[rollback-integration] ${JSON.stringify({ event: "one-image-rollback", ...oneImage })}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "updates to version two and records it as the rollback target",
    async () => {
      const context = requireAddedApp();
      const { app, port, image: versionOne } = context;

      const commit = await commitServerSource(versionTwoServerSource(), "version two");

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
      expect(
        buildInvocations,
        "update must have exercised the production build seam once",
      ).toHaveLength(2);

      const persisted = readRecordedState(app);
      const image = persisted.images?.current ?? null;
      if (image === null) {
        throw new Error("the update did not record a current image");
      }

      createdImages.add(image);
      expect(image, "the update must build a new image").not.toBe(versionOne);
      expect(persisted.images?.previous, "the old image must become the rollback target").toBe(
        versionOne,
      );

      const inspect = await inspectAppContainer(app);
      const containerId = requireInspectId(inspect, app);
      assertRunningAppContainer(inspect, app, port, image);
      assertDataVolumeMounted(inspect, context.volume);
      expect(containerId).not.toBe(context.containerId);

      const body = await fetchBody(port);
      expect(body).toContain(VERSION_TWO_BODY);
      expect(body, "version one must no longer answer").not.toContain(VERSION_ONE_BODY);

      const images = await snapshotImages(app);
      expect([...images.references].sort()).toEqual([image, versionOne].sort());

      updated = {
        exitCode,
        app,
        port,
        image,
        previousImage: persisted.images?.previous ?? null,
        containerId,
        body,
        buildCalls: buildInvocations.length,
        images: images.references,
        durationMs,
      };
      writeRollbackEvidence();

      console.info(
        `[rollback-integration] ${JSON.stringify({
          event: "version-two-updated",
          commit,
          ...updated,
        })}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "rolls back to version one without building and swaps the recorded pair",
    async () => {
      const context = requireUpdatedApp();
      const { app, port, image: versionTwo } = context;
      const previousImage = requireUpdatedPreviousImage();
      const imagesBefore = await snapshotImages(app);
      const buildCallsBefore = buildInvocations.length;

      const stdout = new RecordingStream();
      const stderr = new RecordingStream();
      const startedAt = Date.now();
      const exitCode = await runRollbackCommand({
        app,
        stdout,
        stderr,
        environment: environment(),
      });
      const durationMs = Date.now() - startedAt;

      expect(exitCode, "a healthy rollback must exit 0").toBe(0);
      expect(stdout.text).toContain(`rolled back "${app}"`);
      expect(stdout.text, "the summary must name the restored image").toContain(
        `restored:   ${previousImage}`,
      );
      expect(
        stdout.text,
        "the summary must name the new rollback target so a second rollback is meaningful",
      ).toContain(`rollback:   ${versionTwo}`);
      expect(stdout.text).toContain(`container:  ${containerName(app)}`);
      expect(stdout.text).toContain(`url:        http://localhost:${port}/`);

      for (const phase of [
        "inspecting",
        "stopping",
        "starting",
        "probing",
        "keeping",
        "recording",
      ]) {
        expect(stderr.text, `the phase stream must report "${phase}"`).toContain(
          `rollback: ${phase}:`,
        );
      }
      expect(stderr.text, "no rollback phase may announce a build").not.toContain(
        "rollback: building:",
      );

      // RBK-NF-02: the identical image list proves no image was built, and the
      // build seam counter proves Railpack was never reached.
      expect(buildInvocations.length, "rollback must never invoke the builder").toBe(
        buildCallsBefore,
      );
      const imagesAfter = await snapshotImages(app);
      expect(imagesAfter.entries, "rollback must not create, retag, or replace an image").toEqual(
        imagesBefore.entries,
      );
      expect(await podmanImageExists(previousImage), "retention must keep the restored image").toBe(
        true,
      );
      expect(await podmanImageExists(versionTwo), "retention must keep the rollback target").toBe(
        true,
      );

      const inspect = await inspectAppContainer(app);
      const containerId = requireInspectId(inspect, app);
      assertRunningAppContainer(inspect, app, port, previousImage);
      assertDataVolumeMounted(inspect, requireAddedApp().volume);
      expect(containerId, "the swap must start a fresh container").not.toBe(context.containerId);

      const body = await fetchBody(port);
      expect(body, "the previous version must serve after a rollback").toContain(VERSION_ONE_BODY);
      expect(body, "the newer version must no longer answer").not.toContain(VERSION_TWO_BODY);

      // RBK-FR-01: the pair is swapped, not merely re-recorded.
      const persisted = readRecordedState(app);
      expect(persisted.images?.current, "the restored image must become current").toBe(
        previousImage,
      );
      expect(
        persisted.images?.previous,
        "the former current image must become the rollback target",
      ).toBe(versionTwo);
      expect(persisted.containerId).toBe(containerId);
      expect(persisted.health?.status).toBe("healthy");
      expect(persisted.health?.detail ?? "").toContain("rolled back");

      firstRollback = {
        exitCode,
        restoredImage: previousImage,
        rollbackTarget: versionTwo,
        containerId,
        previousContainerId: context.containerId,
        body,
        recordedCurrent: persisted.images?.current ?? null,
        recordedPrevious: persisted.images?.previous ?? null,
        buildCalls: buildInvocations.length,
        imagesBefore: imagesBefore.entries,
        imagesAfter: imagesAfter.entries,
        progress: [
          `inspecting=${stderr.text.includes("rollback: inspecting:")}`,
          `keeping=${stderr.text.includes("rollback: keeping:")}`,
          `recording=${stderr.text.includes("rollback: recording:")}`,
        ],
        durationMs,
      };
      writeRollbackEvidence();

      console.info(
        `[rollback-integration] ${JSON.stringify({ event: "first-rollback", ...firstRollback })}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "rolls back again to version two without building and swaps the pair back",
    async () => {
      const context = requireFirstRollback();
      const { app, port } = requireUpdatedApp();
      const versionOne = context.restoredImage;
      const versionTwo = context.rollbackTarget;
      const imagesBefore = await snapshotImages(app);
      const buildCallsBefore = buildInvocations.length;

      expect(
        [...imagesBefore.references].sort(),
        "both versions must still exist before rollback",
      ).toEqual([versionOne, versionTwo].sort());

      const stdout = new RecordingStream();
      const stderr = new RecordingStream();
      const startedAt = Date.now();
      const exitCode = await runRollbackCommand({
        app,
        stdout,
        stderr,
        environment: environment(),
      });
      const durationMs = Date.now() - startedAt;

      expect(exitCode, "a second healthy rollback must exit 0").toBe(0);
      expect(stdout.text).toContain(`rolled back "${app}"`);
      expect(stdout.text, "the second rollback must restore the newer image").toContain(
        `restored:   ${versionTwo}`,
      );
      expect(stdout.text, "the older image must become the rollback target again").toContain(
        `rollback:   ${versionOne}`,
      );

      for (const phase of [
        "inspecting",
        "stopping",
        "starting",
        "probing",
        "keeping",
        "recording",
      ]) {
        expect(stderr.text, `the phase stream must report "${phase}"`).toContain(
          `rollback: ${phase}:`,
        );
      }

      expect(buildInvocations.length, "the second rollback must never invoke the builder").toBe(
        buildCallsBefore,
      );
      const imagesAfter = await snapshotImages(app);
      expect(
        imagesAfter.entries,
        "the second rollback must not create or replace an image",
      ).toEqual(imagesBefore.entries);

      const inspect = await inspectAppContainer(app);
      const containerId = requireInspectId(inspect, app);
      assertRunningAppContainer(inspect, app, port, versionTwo);
      assertDataVolumeMounted(inspect, requireAddedApp().volume);
      expect(containerId, "each rollback must start a fresh container").not.toBe(
        context.containerId,
      );

      const body = await fetchBody(port);
      expect(body, "a second rollback must return to version two").toContain(VERSION_TWO_BODY);
      expect(body, "version one must no longer answer").not.toContain(VERSION_ONE_BODY);

      const persisted = readRecordedState(app);
      expect(persisted.images?.current, "version two must be current again").toBe(versionTwo);
      expect(persisted.images?.previous, "version one must be the rollback target again").toBe(
        versionOne,
      );
      expect(persisted.containerId).toBe(containerId);
      expect(persisted.health?.status).toBe("healthy");

      secondRollback = {
        exitCode,
        restoredImage: versionTwo,
        rollbackTarget: versionOne,
        containerId,
        previousContainerId: context.containerId,
        body,
        recordedCurrent: persisted.images?.current ?? null,
        recordedPrevious: persisted.images?.previous ?? null,
        buildCalls: buildInvocations.length,
        imagesBefore: imagesBefore.entries,
        imagesAfter: imagesAfter.entries,
        progress: [
          `inspecting=${stderr.text.includes("rollback: inspecting:")}`,
          `keeping=${stderr.text.includes("rollback: keeping:")}`,
          `recording=${stderr.text.includes("rollback: recording:")}`,
        ],
        durationMs,
      };
      writeRollbackEvidence();

      console.info(
        `[rollback-integration] ${JSON.stringify({ event: "second-rollback", ...secondRollback })}`,
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
      writeRollbackEvidence(true, cleanupError);
    } catch (error) {
      throw new Error(
        `could not record rollback evidence at "${evidencePath}": ${messageOf(error)}`,
      );
    }

    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }, CLEANUP_TIMEOUT_MS);
});

/** Builds the environment `rollback` needs; the state root is always test-owned. */
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
      `the gated rollback suite runs only on the Linux target host; this platform is "${process.platform}"`,
    );
  }

  const version = await runCommand(
    "podman",
    ["version", "--format", "{{.Client.Version}}"],
    COMMAND_TIMEOUT_MS,
  ).catch((error: unknown) => {
    throw new Error(
      `could not run "podman" (${messageOf(error)}); the gated rollback suite requires rootless Podman >= ${MINIMUM_PODMAN.join(".")} and < ${EXCLUDED_PODMAN_MAJOR}.0.0`,
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
      `Podman ${major}.${minor}.${patch} is outside the supported range >= ${MINIMUM_PODMAN.join(".")} and < ${EXCLUDED_PODMAN_MAJOR}.0.0; upgrade or downgrade the host before running the rollback suite`,
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

  // The production builder owns the fixed managed-buildkitd name. Refuse to
  // replace an operator daemon rather than silently stopping it.
  const daemonExists = await podmanContainerExists(BUILDKIT_CONTAINER_NAME);
  if (daemonExists) {
    throw new Error(
      `container "${BUILDKIT_CONTAINER_NAME}" already exists; the gated rollback suite owns the managed buildkitd and will not replace it. Stop and remove it with "podman stop ${BUILDKIT_CONTAINER_NAME} && podman rm ${BUILDKIT_CONTAINER_NAME}" (or use another host) before running the suite`,
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
 * every later commit, so both versions are deterministic local copies.
 */
async function createVersionOneFixture(): Promise<string> {
  if (!existsSync(EXPRESS_FIXTURE)) {
    throw new Error(`the express-api fixture is missing at ${EXPRESS_FIXTURE}`);
  }

  const repoDir = path.join(requireTempRoot(), "repos", "rollback-fixture");
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

/** Version one: the body a rollback must restore. */
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
    '  console.log("rollback-fixture listening on port " + port);',
    "});",
    "",
  ].join("\n");
}

/** Version two: the body a second rollback must restore. */
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
    `  response.type("text/plain").send("${VERSION_TWO_BODY}");`,
    "});",
    "",
    'app.listen(port, "0.0.0.0", () => {',
    '  console.log("rollback-fixture listening on port " + port);',
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
 * The add assertions. They are repeated here (instead of trusting the add
 * suite's run) because this suite owns the starting state every rollback
 * assertion depends on.
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

  const state = result.state;
  if (state === null) {
    throw new Error(`add did not record state.json for "${app}"`);
  }

  expect(state.images.current).toBe(result.image);
  expect(state.images.previous).toBeNull();
  expect(state.health.status).toBe("healthy");
  expect(state.containerId, "the healthy container id must be recorded").toMatch(/^[0-9a-f]{12,}$/);
}

/** The container facts every swap must preserve on the host. */
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

/** RBK-FR-01's swap must not drop the app's named volume. */
function assertDataVolumeMounted(inspect: PodmanInspect, volume: string | undefined): void {
  if (volume === undefined) {
    throw new Error("the data volume name was not recorded");
  }

  const mount = (inspect.Mounts ?? []).find((entry) => entry.Destination === DATA_VOLUME_TARGET);
  expect(mount, `volume ${volume} must stay mounted at ${DATA_VOLUME_TARGET}`).toBeDefined();
  expect(mount?.Type).toBe("volume");
  expect(mount?.Name).toBe(volume);
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
    throw new Error("the failed rollback wrote no JSON error document to stdout");
  }

  const parsed: unknown = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`the failed rollback wrote an unexpected JSON document: ${trimmed}`);
  }

  return parsed as ErrorDocument;
}

function readRecordedState(app: string): RecordedState {
  const statePath = path.join(requirePaths().appDir(app), "state.json");
  const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`unexpected state.json for "${app}"`);
  }

  return parsed as RecordedState;
}

/**
 * The complete image state for this run, keyed by tag and id. A build creates a
 * new timestamped tag, so list equality is a builder-independent no-build
 * proof; the id keeps a silent retag visible too.
 */
async function snapshotImages(app: string): Promise<ImageSnapshot> {
  const result = await runPodman(["images", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"]);
  if (result.exitCode !== 0) {
    throw new Error(`"podman images" failed with code ${result.exitCode}: ${result.stderr.trim()}`);
  }

  const prefix = `localhost/easy-host-${app}:`;
  const entries = splitLines(result.stdout)
    .filter((line) => line.startsWith(prefix))
    .sort();

  return {
    entries,
    references: entries.map((line) => line.split(" ")[0] ?? "").sort(),
  };
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

function requireAddedApp(): AddObservation {
  if (added === undefined) {
    throw new Error("the version-one add did not complete, so rollback cannot be exercised");
  }

  return added;
}

function requireUpdatedApp(): UpdateObservation {
  if (updated === undefined) {
    throw new Error("the version-two update did not complete, so rollback cannot be exercised");
  }

  return updated;
}

function requireUpdatedPreviousImage(): string {
  const previous = updated?.previousImage;
  if (typeof previous !== "string" || previous.length === 0) {
    throw new Error("the update did not record a rollback target");
  }

  return previous;
}

function requireFirstRollback(): RollbackObservation {
  if (firstRollback === undefined) {
    throw new Error("the first rollback did not complete, so a second rollback cannot run");
  }

  return firstRollback;
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
 * Removes only what this suite created: the app container, its labelled volume,
 * its images, the managed daemon, and the temporary state root. Missing
 * resources are tolerated; every other cleanup failure is reported so a leak
 * cannot masquerade as a pass. Afterwards each resource class is re-read from
 * Podman to prove nothing was orphaned.
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
      for (const reference of (await snapshotImages(app)).references) {
        createdImages.add(reference);
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
      const remaining = await snapshotImages(app);
      if (remaining.entries.length > 0) {
        failures.push(`images still exist after cleanup: ${remaining.references.join(", ")}`);
      }
    } catch (error) {
      failures.push(`verify image removal: ${messageOf(error)}`);
    }
  }

  if (temporaryRoot !== undefined && existsSync(temporaryRoot)) {
    failures.push(`the temporary state root "${temporaryRoot}" still exists after cleanup`);
  }

  if (failures.length > 0) {
    throw new Error(`rollback integration cleanup failed:\n- ${failures.join("\n- ")}`);
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
 * Persists the observations so a later failure still leaves the timings and
 * evidence already collected, then once more after cleanup.
 */
function writeRollbackEvidence(final = false, cleanupError?: unknown): void {
  const document = {
    schemaVersion: 1,
    task: "RBK-1.4",
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
      volume: added?.volume ?? null,
    },
    buildInvocations: buildInvocations.length,
    added: added ?? null,
    oneImageRollback: oneImage ?? null,
    updated: updated ?? null,
    firstRollback: firstRollback ?? null,
    secondRollback: secondRollback ?? null,
    cleanup: final ? (cleanupError === undefined ? "ok" : messageOf(cleanupError)) : "pending",
  };

  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
  console.info(
    `[rollback-integration] ${JSON.stringify({ event: "evidence", path: evidencePath, final })}`,
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
