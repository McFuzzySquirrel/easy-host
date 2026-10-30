/**
 * Gated end-to-end proof of `remove` on the real host
 * (`RBK-FR-03`, `RBK-FR-04`, `RBK-NF-01`, `PRD-C-08`, `PRD-NF-07`).
 *
 * This is the only test that drives the production removal composition against
 * a real app: a real clone, the pinned Railpack binary, the managed rootless
 * buildkitd, a real container with a labelled named volume, the real Podman
 * volume store, and the real app directory on disk. It proves the three claims
 * the PRD makes about removal:
 *
 * 1. a default removal deletes the container, the workspace, the retained
 *    images, and the app directory, but leaves the named volume and the data
 *    inside it intact, and prints the volume name plus the exact
 *    `podman volume rm` command that would delete it (`RBK-FR-03`);
 * 2. the retained volume is real: a re-added app mounts it again and reads the
 *    exact bytes written before the removal back over HTTP. This is a read-back
 *    proof, not a listing check, and it is what makes "the data survived" a
 *    non-vacuous assertion (`RBK-NF-01`);
 * 3. `remove --volumes` deletes only the volume whose
 *    `io.easy-host.app` label matches the app, and reports an unlabelled volume
 *    that merely shares the app's name pattern instead of deleting it
 *    (`RBK-FR-04`, `PRD-C-08`).
 *
 * The suite never skips: without `EASY_HOST_INTEGRATION=1` it throws while the
 * module is collected, naming the variable and the command to run. Every
 * resource is test-owned (temporary state root, a unique app name, a local git
 * fixture copy the test controls, one labelled app volume, and one deliberately
 * unlabelled foreign volume with the app's name pattern). Cleanup runs after
 * both pass and failure, then re-reads Podman and the filesystem to prove that
 * no container, volume, image, daemon, app directory, or temporary root was
 * orphaned.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRemoveCommand } from "../../src/cli/commands/remove.js";
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
import { Registry } from "../../src/registry/store.js";

/** The gate variable. Missing it is a failure, never a skip. */
const INTEGRATION_ENV = "EASY_HOST_INTEGRATION";

if (process.env[INTEGRATION_ENV] !== "1") {
  throw new Error(
    `${INTEGRATION_ENV} must be set to "1" to run the gated remove integration suite; ` +
      `it builds, runs, and removes real containers, volumes, and images. Run: ${INTEGRATION_ENV}=1 npm run test:integration -- tests/integration/remove.test.ts`,
  );
}

/** One cold fixture build was ~248s-277s in the build proof; allow headroom. */
const SCENARIO_TIMEOUT_MS = 20 * 60 * 1000;

/** Setup may include the Railpack download, the BuildKit pull, and the git copy. */
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/** Container removal plus volume/image removal plus temporary-root deletion. */
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;

/** Finite bound on every direct Podman or git call made by this suite. */
const COMMAND_TIMEOUT_MS = 120 * 1000;

/** Declared container port used by the fixture stack. */
const FIXTURE_CONTAINER_PORT = 3000;

/** The named volume declared on add, and the path it is mounted at. */
const DATA_VOLUME = "data";
const DATA_VOLUME_TARGET = "/var/lib/data";

/** The file the fixture writes inside the volume; read back over HTTP. */
const DATA_FILE_NAME = "record.txt";

/**
 * The exact payload written into the volume before the first removal. It is a
 * single line with spaces so a whitespace-mangling bug fails the read-back.
 */
const DATA_PAYLOAD = "easy-host remove integration payload: keep me across remove";

/**
 * Optional evidence destination. The default lands under the OS temporary
 * directory so a run always records its observations without writing into the
 * package or the operator's state root.
 */
const EVIDENCE_ENV = "EASY_HOST_REMOVE_EVIDENCE";
const evidencePath =
  process.env[EVIDENCE_ENV]?.trim() ||
  path.join(tmpdir(), `easy-host-remove-evidence-${process.pid}.json`);

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
  readonly volume: string;
  readonly volumeCreatedAt: string;
  readonly dataFileSize: number;
  readonly foreignVolume: string;
  readonly healthAttempts: number;
  readonly healthElapsedMs: number;
  readonly durationMs: number;
}

interface DefaultRemoveObservation {
  readonly exitCode: number;
  readonly app: string;
  readonly containerRemoved: boolean;
  readonly imageRemoved: boolean;
  readonly workspaceDeleted: boolean;
  readonly appDirectoryDeleted: boolean;
  readonly volumeRetained: boolean;
  readonly volumeCreatedAt: string;
  readonly dataReadBackFromDisk: string;
  readonly deleteCommand: string;
  readonly foreignVolumeUntouched: boolean;
  readonly volumesDeleted: readonly string[];
  readonly durationMs: number;
}

interface ReAddObservation {
  readonly exitCode: number;
  readonly app: string;
  readonly port: number;
  readonly image: string;
  readonly volume: string;
  readonly volumeCreatedAt: string;
  readonly dataReadBack: string;
  readonly durationMs: number;
}

interface VolumeRemoveObservation {
  readonly exitCode: number;
  readonly app: string;
  readonly volumeDeleted: boolean;
  readonly foreignVolumeUntouched: boolean;
  readonly containerRemoved: boolean;
  readonly imagesRemoved: boolean;
  readonly workspaceDeleted: boolean;
  readonly appDirectoryDeleted: boolean;
  readonly volumesDeleted: readonly string[];
  readonly durationMs: number;
}

interface PodmanInspect {
  readonly Id?: string;
  readonly State?: { readonly Running?: boolean; readonly Status?: string };
  readonly HostConfig?: { readonly RestartPolicy?: { readonly Name?: string } };
  readonly Config?: {
    readonly Image?: string;
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
  readonly CreatedAt?: string;
  readonly Mountpoint?: string;
  readonly Labels?: Readonly<Record<string, string>>;
}

interface RecordedState {
  readonly images?: { readonly current?: string | null; readonly previous?: string | null };
  readonly containerId?: string | null;
  readonly health?: { readonly status?: string; readonly detail?: string | null };
}

let temporaryRoot: string | undefined;
let paths: Paths | undefined;
let runSuffix = "";
let testApp = "";
let appVolume = "";
let foreignVolume = "";
let fixtureRepoUrl: string | undefined;
let podmanVersion = "";
let added: AddObservation | undefined;
let defaultRemoved: DefaultRemoveObservation | undefined;
let reAdded: ReAddObservation | undefined;
let volumeRemoved: VolumeRemoveObservation | undefined;
let cleanupPromise: Promise<void> | undefined;

const createdImages = new Set<string>();
const createdVolumes = new Set<string>();

describe("remove on the real host", () => {
  beforeAll(async () => {
    try {
      podmanVersion = await assertHostPrerequisites();

      temporaryRoot = mkdtempSync(path.join(tmpdir(), "easy-host-remove-it-"));
      runSuffix = `${process.pid.toString(36)}${Date.now().toString(36)}`;
      testApp = `it-remove-${runSuffix}`;
      paths = createPaths({ env: environmentFor(temporaryRoot) }).ensureLayout();

      appVolume = volumeName(testApp, DATA_VOLUME);
      // The same prefix as the app's own volume with no `io.easy-host.app`
      // label: removal must report it and must never delete it.
      foreignVolume = `${appVolume}-foreign`;

      fixtureRepoUrl = await createFixtureRepository();
    } catch (error) {
      // afterAll may not run when beforeAll throws, so clean up here too.
      await cleanup();
      throw error;
    }
  }, SETUP_TIMEOUT_MS);

  it(
    "adds the app with a declared volume and writes data into it",
    async () => {
      const app = requireApp();
      const repo = requireFixtureUrl();
      const port = await findFreePort();
      const volume = requireAppVolume();

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

      assertHealthyAdd(result, app, port, volume);
      createdImages.add(result.image);

      const inspect = await inspectAppContainer(app);
      const containerId = requireInspectId(inspect, app);
      assertRunningAppContainer(inspect, app, port, result.image);
      assertDataVolumeMounted(inspect, volume);

      // The volume is real and labelled for this app before anything is deleted.
      const volumeInspect = await inspectVolume(volume);
      expect(volumeInspect.Labels?.[APP_LABEL], "the volume must be labelled for its app").toBe(
        app,
      );
      if (typeof volumeInspect.CreatedAt !== "string" || volumeInspect.CreatedAt.length === 0) {
        throw new Error(`volume "${volume}" did not report a creation timestamp`);
      }
      const volumeCreatedAt = volumeInspect.CreatedAt;

      const persisted = readRecordedState(app);
      expect(persisted.images?.current).toBe(result.image);
      expect(persisted.images?.previous).toBeNull();
      expect(persisted.containerId).toBe(containerId);
      expect(persisted.health?.status).toBe("healthy");

      // Write through the live app; this is the only write into the volume.
      await writeData(port, DATA_PAYLOAD);
      expect(
        await readData(port),
        "the fixture must read back the bytes it just wrote into the volume",
      ).toBe(DATA_PAYLOAD);

      const images = await listAppImages(app);
      expect(images, "the first add must leave exactly one app image").toEqual([result.image]);

      // Create the foreign volume after the app exists, so the first removal's
      // volume listing sees both the labelled app volume and this unlabelled one.
      await createUnlabelledVolume(requireForeignVolume());
      const foreignInspect = await inspectVolume(requireForeignVolume());
      expect(
        foreignInspect.Labels?.[APP_LABEL],
        "the foreign volume must not carry the app label",
      ).toBeUndefined();

      added = {
        app,
        port,
        repo,
        image: result.image,
        containerId,
        url: result.url,
        volume,
        volumeCreatedAt,
        dataFileSize: Buffer.byteLength(DATA_PAYLOAD),
        foreignVolume: requireForeignVolume(),
        healthAttempts: result.health.attempts,
        healthElapsedMs: result.health.elapsedMs,
        durationMs,
      };
      writeRemoveEvidence();

      console.info(
        `[remove-integration] ${JSON.stringify({
          event: "app-added",
          ...added,
          images,
        })}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "removes the app without --volumes, keeps the volume and its data, and reports the volume",
    async () => {
      const context = requireAddedApp();
      const { app, image, volume, volumeCreatedAt, containerId } = context;
      const appDirectory = requirePaths().appDir(app);
      const workspace = path.join(appDirectory, "workspace");

      // Every volume that exists before the removal. A default removal must
      // leave this set intact; this catches an over-broad delete (`volume
      // prune`-style) that a single-volume assertion would miss.
      const volumesBefore = await listVolumes();

      const stdout = new RecordingStream();
      const stderr = new RecordingStream();
      const startedAt = Date.now();
      const exitCode = await runRemoveCommand({
        app,
        yes: true,
        interactive: false,
        stdout,
        stderr,
        environment: environment(),
      });
      const durationMs = Date.now() - startedAt;

      expect(exitCode, "a confirmed removal must exit 0").toBe(0);

      // The operator summary must name what went and what stayed.
      expect(stdout.text).toContain(`removed "${app}"`);
      expect(stdout.text).toContain(`container:  ${containerName(app)} (removed)`);
      expect(stdout.text).toContain(`images:     1 removed: ${image}`);
      expect(stdout.text).toContain(`workspace:  ${workspace} (deleted)`);
      expect(stdout.text).toContain(`app dir:    ${appDirectory} (deleted)`);
      expect(stdout.text, "the retained volume must be listed by name").toContain(
        `volumes:    ${volume} (kept)`,
      );
      expect(
        stdout.text,
        "the exact podman command that would delete the volume must be printed",
      ).toContain(`next:       podman volume rm ${volume}`);
      expect(stdout.text, "an unlabelled name-matching volume must be reported").toContain(
        `refused:    ${requireForeignVolume()} (unlabelled)`,
      );

      for (const phase of [
        "stopping",
        "removing-container",
        "removing-images",
        "removing-workspace",
        "removing-app",
      ]) {
        expect(stderr.text, `the phase stream must report "${phase}"`).toContain(
          `remove: ${phase}:`,
        );
      }
      expect(stderr.text, "a default removal must not delete the volume").not.toContain(
        "remove: removing-volumes:",
      );
      expect(stderr.text).toContain(
        `kept volume ${volume}; delete it with "podman volume rm ${volume}"`,
      );
      expect(stderr.text).toContain(
        `refused to touch volume ${requireForeignVolume()} (unlabelled)`,
      );

      // RBK-NF-01: no container, image, workspace, or app directory remains.
      expect(
        await podmanContainerExists(containerName(app)),
        "the app container must be gone after removal",
      ).toBe(false);
      expect(existsSync(appDirectory), "the app directory must be gone after removal").toBe(false);
      expect(existsSync(workspace), "the workspace must be gone after removal").toBe(false);
      expect(
        await podmanImageExists(image),
        "the app's recorded image must be removed even when the build did not label it",
      ).toBe(false);
      expect(await listAppImages(app), "no image for the app may remain").toEqual([]);
      expect(registryNames(), "the registry must no longer list the removed app").not.toContain(
        app,
      );
      expect(readRecordedStateOrNull(app), "state.json must be gone with the app directory").toBe(
        null,
      );

      // The volume is kept with its identity and label intact.
      expect(await volumeExists(volume), "the named volume must survive a default removal").toBe(
        true,
      );
      const keptVolume = await inspectVolume(volume);
      expect(keptVolume.Labels?.[APP_LABEL]).toBe(app);
      expect(keptVolume.CreatedAt, "the same volume must be kept, not recreated").toBe(
        volumeCreatedAt,
      );

      // No volume at all may disappear on a default removal, not just this
      // app's volume. Additions by another actor are tolerated.
      const volumesAfter = await listVolumes();
      const volumesDeleted = volumesBefore.filter((name) => !volumesAfter.includes(name));
      expect(
        volumesDeleted,
        "a default removal must not delete any volume, including one outside the app",
      ).toEqual([]);

      // Read the bytes back from the volume's own data directory, independently
      // of any container. This is the data-retention proof for RBK-NF-01.
      const dataMountpoint = keptVolume.Mountpoint;
      if (typeof dataMountpoint !== "string" || dataMountpoint.length === 0) {
        throw new Error(`volume "${volume}" did not report a mountpoint`);
      }
      const dataPath = path.join(dataMountpoint, DATA_FILE_NAME);
      expect(existsSync(dataPath), `the data file must still exist at ${dataPath}`).toBe(true);
      const dataReadBack = readFileSync(dataPath, "utf8");
      expect(dataReadBack, "the volume data must be unchanged after a default removal").toBe(
        DATA_PAYLOAD,
      );

      // The foreign volume is untouched and still unlabelled.
      expect(
        await volumeExists(requireForeignVolume()),
        "an unlabelled name-matching volume must not be deleted",
      ).toBe(true);
      const foreignInspect = await inspectVolume(requireForeignVolume());
      expect(foreignInspect.Labels?.[APP_LABEL]).toBeUndefined();

      // Nothing about the removed app remains, including its old container id.
      expect(await podmanContainerExists(containerId)).toBe(false);

      defaultRemoved = {
        exitCode,
        app,
        containerRemoved: true,
        imageRemoved: true,
        workspaceDeleted: true,
        appDirectoryDeleted: true,
        volumeRetained: true,
        volumeCreatedAt,
        dataReadBackFromDisk: dataReadBack,
        deleteCommand: `podman volume rm ${volume}`,
        foreignVolumeUntouched: true,
        volumesDeleted,
        durationMs,
      };
      writeRemoveEvidence();

      console.info(
        `[remove-integration] ${JSON.stringify({
          event: "default-remove",
          ...defaultRemoved,
          stdout: stdout.text,
        })}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "re-adds the app on the retained volume and reads the original data back",
    async () => {
      const context = requireDefaultRemoved();
      const app = context.app;
      const volume = requireAppVolume();
      const repo = requireFixtureUrl();
      const port = await findFreePort();

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

      assertHealthyAdd(result, app, port, volume);
      createdImages.add(result.image);
      expect(result.image, "the re-add must build a fresh image").not.toBe(requireAddedApp().image);

      const inspect = await inspectAppContainer(app);
      assertRunningAppContainer(inspect, app, port, result.image);
      assertDataVolumeMounted(inspect, volume);

      const volumeInspect = await inspectVolume(volume);
      expect(volumeInspect.Labels?.[APP_LABEL]).toBe(app);
      expect(
        volumeInspect.CreatedAt,
        "the re-add must reuse the retained volume instead of recreating it",
      ).toBe(context.volumeCreatedAt);

      // The read-back proof: a brand-new container mounting the retained volume
      // returns the exact bytes written before the first removal.
      const dataReadBack = await readData(port);
      expect(
        dataReadBack,
        "the app must read the pre-removal data back from the retained volume",
      ).toBe(DATA_PAYLOAD);

      expect(
        await listAppImages(app),
        "the old image must be gone and only the rebuilt image may remain",
      ).toEqual([result.image]);
      expect(
        await volumeExists(requireForeignVolume()),
        "the foreign volume must not be touched by a re-add",
      ).toBe(true);

      reAdded = {
        exitCode: 0,
        app,
        port,
        image: result.image,
        volume,
        volumeCreatedAt: context.volumeCreatedAt,
        dataReadBack,
        durationMs,
      };
      writeRemoveEvidence();

      console.info(`[remove-integration] ${JSON.stringify({ event: "re-added", ...reAdded })}`);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "removes with --volumes and deletes only the app volume",
    async () => {
      const context = requireReAdded();
      const { app, image, volume } = context;
      const appDirectory = requirePaths().appDir(app);
      const workspace = path.join(appDirectory, "workspace");

      // The exact set of host volumes before and after `--volumes`. Only the
      // app's labelled volume may disappear from it.
      const volumesBefore = await listVolumes();

      const stdout = new RecordingStream();
      const stderr = new RecordingStream();
      const startedAt = Date.now();
      const exitCode = await runRemoveCommand({
        app,
        volumes: true,
        yes: true,
        interactive: false,
        stdout,
        stderr,
        environment: environment(),
      });
      const durationMs = Date.now() - startedAt;

      expect(exitCode, "a confirmed volume removal must exit 0").toBe(0);

      expect(stdout.text).toContain(`removed "${app}"`);
      expect(stdout.text, "the deleted app volume must be reported").toContain(
        `volumes:    ${volume} (deleted)`,
      );
      expect(stdout.text, "the unlabelled name-matching volume must be refused").toContain(
        `refused:    ${requireForeignVolume()} (unlabelled)`,
      );
      expect(stdout.text, "a deleted volume leaves no delete command").not.toContain("next:");
      expect(stdout.text).toContain(`images:     1 removed: ${image}`);

      expect(stderr.text).toContain("remove: removing-volumes:");
      expect(stderr.text).toContain(`removed volume ${volume}`);
      expect(stderr.text).toContain(
        `refused to delete volume ${requireForeignVolume()} (unlabelled)`,
      );

      // Only the labelled app volume is gone.
      expect(
        await volumeExists(volume),
        "the labelled app volume must be deleted with --volumes",
      ).toBe(false);
      expect(
        await volumeExists(requireForeignVolume()),
        "the unlabelled name-matching volume must survive --volumes",
      ).toBe(true);
      const foreignInspect = await inspectVolume(requireForeignVolume());
      expect(
        foreignInspect.Labels?.[APP_LABEL],
        "the foreign volume must remain unlabelled",
      ).toBeUndefined();

      // RBK-NF-01 again, this time after the volume step.
      expect(await podmanContainerExists(containerName(app))).toBe(false);
      expect(existsSync(appDirectory)).toBe(false);
      expect(existsSync(workspace)).toBe(false);
      expect(await podmanImageExists(image)).toBe(false);
      expect(await listAppImages(app)).toEqual([]);
      expect(registryNames()).not.toContain(app);

      // RBK-FR-04's scope: exactly the labelled app volume may be deleted. Any
      // other host volume that existed before must still exist afterwards.
      const volumesAfter = await listVolumes();
      const volumesDeleted = volumesBefore.filter((name) => !volumesAfter.includes(name));
      expect(
        volumesDeleted,
        "remove --volumes must delete the app volume and no other host volume",
      ).toEqual([volume]);

      volumeRemoved = {
        exitCode,
        app,
        volumeDeleted: true,
        foreignVolumeUntouched: true,
        containerRemoved: true,
        imagesRemoved: true,
        workspaceDeleted: true,
        appDirectoryDeleted: true,
        volumesDeleted,
        durationMs,
      };
      writeRemoveEvidence();

      console.info(
        `[remove-integration] ${JSON.stringify({
          event: "volume-remove",
          ...volumeRemoved,
          stdout: stdout.text,
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
      writeRemoveEvidence(true, cleanupError);
    } catch (error) {
      throw new Error(`could not record remove evidence at "${evidencePath}": ${messageOf(error)}`);
    }

    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }, CLEANUP_TIMEOUT_MS);
});

/** Builds the environment `remove` needs; the state root is always test-owned. */
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
      `the gated remove suite runs only on the Linux target host; this platform is "${process.platform}"`,
    );
  }

  const version = await runCommand(
    "podman",
    ["version", "--format", "{{.Client.Version}}"],
    COMMAND_TIMEOUT_MS,
  ).catch((error: unknown) => {
    throw new Error(
      `could not run "podman" (${messageOf(error)}); the gated remove suite requires rootless Podman >= ${MINIMUM_PODMAN.join(".")} and < ${EXCLUDED_PODMAN_MAJOR}.0.0`,
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
      `Podman ${major}.${minor}.${patch} is outside the supported range >= ${MINIMUM_PODMAN.join(".")} and < ${EXCLUDED_PODMAN_MAJOR}.0.0; upgrade or downgrade the host before running the remove suite`,
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
      `container "${BUILDKIT_CONTAINER_NAME}" already exists; the gated remove suite owns the managed buildkitd and will not replace it. Stop and remove it with "podman stop ${BUILDKIT_CONTAINER_NAME} && podman rm ${BUILDKIT_CONTAINER_NAME}" (or use another host) before running the suite`,
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
 * commits it on `main`. The fixture's `server.js` is replaced by a test-owned
 * version that writes to and reads from the declared volume, so the volume
 * data can be proven by reading it back through a real container.
 */
async function createFixtureRepository(): Promise<string> {
  if (!existsSync(EXPRESS_FIXTURE)) {
    throw new Error(`the express-api fixture is missing at ${EXPRESS_FIXTURE}`);
  }

  const repoDir = path.join(requireTempRoot(), "repos", "remove-fixture");
  mkdirSync(path.dirname(repoDir), { recursive: true });
  cpSync(EXPRESS_FIXTURE, repoDir, { recursive: true });
  writeFileSync(path.join(repoDir, "server.js"), dataServerSource());

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
    "remove fixture",
  ]);

  return `file://${repoDir}`;
}

/** The fixture: health on `/`, write on `POST /data`, read on `GET /data`. */
function dataServerSource(): string {
  return [
    'const express = require("express");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "",
    'const port = Number.parseInt(process.env.PORT ?? "", 10);',
    "",
    "if (!Number.isInteger(port) || port < 1 || port > 65535) {",
    '  console.error("PORT must be set to a valid TCP port");',
    "  process.exit(1);",
    "}",
    "",
    `const DATA_DIRECTORY = "${DATA_VOLUME_TARGET}";`,
    `const DATA_FILE = path.join(DATA_DIRECTORY, "${DATA_FILE_NAME}");`,
    "",
    "const app = express();",
    "",
    'app.get("/", (_request, response) => {',
    '  response.json({ status: "ok", service: "remove-fixture" });',
    "});",
    "",
    'app.post("/data", express.text({ type: "text/plain" }), (request, response) => {',
    "  fs.mkdirSync(DATA_DIRECTORY, { recursive: true });",
    '  fs.writeFileSync(DATA_FILE, request.body ?? "", "utf8");',
    '  response.json({ written: Buffer.byteLength(request.body ?? "") });',
    "});",
    "",
    'app.get("/data", (_request, response) => {',
    "  if (!fs.existsSync(DATA_FILE)) {",
    "    response.status(404).json({ missing: true });",
    "    return;",
    "  }",
    '  response.type("text/plain").send(fs.readFileSync(DATA_FILE, "utf8"));',
    "});",
    "",
    'app.listen(port, "0.0.0.0", () => {',
    '  console.log("remove-fixture listening on port " + port);',
    "});",
    "",
  ].join("\n");
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

/** Writes the payload into the volume through the running app. */
async function writeData(port: number, payload: string): Promise<void> {
  const url = `http://127.0.0.1:${port}/data`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();

  expect(response.status, `expected ${url} to accept the data write: ${body}`).toBe(200);
}

/** Reads the volume's data back through the running app. */
async function readData(port: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/data`;
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();

  expect(response.status, `expected ${url} to return the retained data: ${body}`).toBe(200);
  return body;
}

/** The add assertions this suite's starting state depends on. */
function assertHealthyAdd(result: AddResult, app: string, port: number, volume: string): void {
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
  expect(result.volumes, "the declared data volume must be created").toEqual([volume]);

  const state = result.state;
  if (state === null) {
    throw new Error(`add did not record state.json for "${app}"`);
  }

  expect(state.images.current).toBe(result.image);
  expect(state.health.status).toBe("healthy");
  expect(state.containerId, "the healthy container id must be recorded").toMatch(/^[0-9a-f]{12,}$/);
}

/** The container facts the removal assertions rely on. */
function assertRunningAppContainer(
  inspect: PodmanInspect,
  app: string,
  port: number,
  image: string,
): void {
  const binding = inspect.NetworkSettings?.Ports?.[`${FIXTURE_CONTAINER_PORT}/tcp`]?.[0];

  expect(inspect.State?.Running, "the app container must be running").toBe(true);
  expect(inspect.HostConfig?.RestartPolicy?.Name).toBe("always");
  expect(binding, `host port ${port} must be published`).toBeDefined();
  expect(binding?.HostPort).toBe(String(port));
  expect(binding?.HostIp).toBe("127.0.0.1");
  expect(inspect.Config?.Image, "the container must run the expected image").toBe(image);

  const labels = inspect.Config?.Labels ?? {};
  expect(labels[APP_LABEL]).toBe(app);
  expect(labels[ROLE_LABEL]).toBe(APP_ROLE_VALUE);
  expect(labels[IMAGE_LABEL]).toBe(image);
}

/** The declared volume must be mounted at its target before any removal. */
function assertDataVolumeMounted(inspect: PodmanInspect, volume: string): void {
  const mount = (inspect.Mounts ?? []).find((entry) => entry.Destination === DATA_VOLUME_TARGET);
  expect(mount, `volume ${volume} must be mounted at ${DATA_VOLUME_TARGET}`).toBeDefined();
  expect(mount?.Type).toBe("volume");
  expect(mount?.Name).toBe(volume);
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

async function volumeExists(name: string): Promise<boolean> {
  const result = await runPodman(["volume", "exists", name]);
  if (result.exitCode === 0) {
    return true;
  }

  if (result.exitCode === 1) {
    return false;
  }

  throw new Error(
    `"podman volume exists ${name}" failed with code ${result.exitCode}: ${result.stderr.trim()}`,
  );
}

/** Creates a deliberately unlabelled volume; cleanup owns it from now on. */
async function createUnlabelledVolume(name: string): Promise<void> {
  const result = await runPodman(["volume", "create", name]);
  if (result.exitCode !== 0) {
    throw new Error(
      `"podman volume create ${name}" exited with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  createdVolumes.add(name);
}

/** Lists every volume name on the host; the removal scope assertions use it. */
async function listVolumes(): Promise<string[]> {
  const result = await runPodman(["volume", "ls", "--format", "{{.Name}}"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `"podman volume ls" failed with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  return splitLines(result.stdout).sort();
}

function readRecordedState(app: string): RecordedState {
  const statePath = path.join(requirePaths().appDir(app), "state.json");
  const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`unexpected state.json for "${app}"`);
  }

  return parsed as RecordedState;
}

function readRecordedStateOrNull(app: string): RecordedState | null {
  const statePath = path.join(requirePaths().appDir(app), "state.json");
  if (!existsSync(statePath)) {
    return null;
  }

  return readRecordedState(app);
}

function registryNames(): string[] {
  return new Registry(requirePaths()).list().map((entry) => entry.name);
}

/** Image references tagged for this app. The unique app name scopes the match. */
async function listAppImages(app: string): Promise<string[]> {
  const result = await runPodman(["images", "--format", "{{.Repository}}:{{.Tag}}"]);
  if (result.exitCode !== 0) {
    throw new Error(`"podman images" failed with code ${result.exitCode}: ${result.stderr.trim()}`);
  }

  const prefix = `localhost/easy-host-${app}:`;
  return splitLines(result.stdout)
    .filter((reference) => reference.startsWith(prefix))
    .sort();
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

function requireAppVolume(): string {
  if (appVolume.length === 0) {
    throw new Error("the integration harness has not initialized the app volume name");
  }

  return appVolume;
}

function requireForeignVolume(): string {
  if (foreignVolume.length === 0) {
    throw new Error("the integration harness has not initialized the foreign volume name");
  }

  return foreignVolume;
}

function requireFixtureUrl(): string {
  if (fixtureRepoUrl === undefined) {
    throw new Error("the local git fixture URL was not created");
  }

  return fixtureRepoUrl;
}

function requireAddedApp(): AddObservation {
  if (added === undefined) {
    throw new Error("the setup add did not complete, so removal cannot be exercised");
  }

  return added;
}

function requireDefaultRemoved(): DefaultRemoveObservation {
  if (defaultRemoved === undefined) {
    throw new Error("the default removal did not complete, so the re-add cannot be exercised");
  }

  return defaultRemoved;
}

function requireReAdded(): ReAddObservation {
  if (reAdded === undefined) {
    throw new Error("the re-add did not complete, so the volume removal cannot be exercised");
  }

  return reAdded;
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
 * Removes only what this suite created: the app container, every volume it
 * created (including the unlabelled foreign one), the app images, the managed
 * daemon, and the temporary state root. Missing resources are tolerated; every
 * other cleanup failure is reported so a leak cannot masquerade as a pass.
 * Afterwards each resource class is re-read to prove nothing was orphaned.
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

    try {
      for (const reference of await listAppImages(app)) {
        createdImages.add(reference);
      }
    } catch (error) {
      failures.push(`list images created by this run: ${messageOf(error)}`);
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
      const remaining = await listAppImages(app);
      if (remaining.length > 0) {
        failures.push(`images still exist after cleanup: ${remaining.join(", ")}`);
      }
    } catch (error) {
      failures.push(`verify image removal: ${messageOf(error)}`);
    }
  }

  if (foreignVolume.length > 0) {
    try {
      if (await volumeExists(foreignVolume)) {
        failures.push(`foreign volume "${foreignVolume}" still exists after cleanup`);
      }
    } catch (error) {
      failures.push(`verify foreign volume removal: ${messageOf(error)}`);
    }
  }

  if (temporaryRoot !== undefined && existsSync(temporaryRoot)) {
    failures.push(`the temporary state root "${temporaryRoot}" still exists after cleanup`);
  }

  if (failures.length > 0) {
    throw new Error(`remove integration cleanup failed:\n- ${failures.join("\n- ")}`);
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
function writeRemoveEvidence(final = false, cleanupError?: unknown): void {
  const document = {
    schemaVersion: 1,
    task: "RBK-1.5",
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
      dataVolume: appVolume.length > 0 ? appVolume : null,
      foreignVolume: foreignVolume.length > 0 ? foreignVolume : null,
    },
    added: added ?? null,
    defaultRemove: defaultRemoved ?? null,
    reAdd: reAdded ?? null,
    volumeRemove: volumeRemoved ?? null,
    cleanup: final ? (cleanupError === undefined ? "ok" : messageOf(cleanupError)) : "pending",
  };

  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
  console.info(
    `[remove-integration] ${JSON.stringify({ event: "evidence", path: evidencePath, final })}`,
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
