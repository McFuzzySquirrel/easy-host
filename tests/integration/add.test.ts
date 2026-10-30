/**
 * Gated end-to-end proof of `add` on the real host (`ADD-FR-03`, `ADD-FR-04`,
 * `ADD-FR-05`, `PRD-NF-07`, `PRD-C-10`).
 *
 * This suite is the only test that drives the production `add` composition —
 * real git clone, pinned Railpack, managed rootless buildkitd, real container,
 * real port publication, and the real bounded HTTP probe — for every supported
 * fixture stack. It then proves the failed-first-probe contract by declaring a
 * container port that the fixture does not listen on: `add` must stop and
 * remove the container, keep the image and app directory, record an unhealthy
 * state, and return exit code 4.
 *
 * The suite never skips: without `EASY_HOST_INTEGRATION=1` it throws while the
 * module is collected, naming the variable and the command to run. Every
 * resource is test-owned (temporary state root, unique app names, local git
 * fixture copies) and cleanup runs after both pass and failure, then verifies
 * that no container, volume, image, daemon, or temporary root was orphaned.
 *
 * The managed buildkitd uses a fixed container name because the production
 * builder owns it. Setup therefore refuses to run when a
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
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAddCommand } from "../../src/cli/commands/add.js";
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

/** The gate variable. Missing it is a failure, never a skip. */
const INTEGRATION_ENV = "EASY_HOST_INTEGRATION";

if (process.env[INTEGRATION_ENV] !== "1") {
  throw new Error(
    `${INTEGRATION_ENV} must be set to "1" to run the gated add integration suite; ` +
      `it clones, builds, runs, and probes real containers. Run: ${INTEGRATION_ENV}=1 npm run test:integration -- tests/integration/add.test.ts`,
  );
}

/** One cold fixture build was ~248s-277s in the build proof; allow headroom. */
const ADD_TIMEOUT_MS = 15 * 60 * 1000;

/** Setup may include the Railpack download, the BuildKit pull, and git copies. */
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/** Container removal plus daemon stop plus temporary-root deletion. */
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;

/** Finite bound on every direct Podman or git call made by this suite. */
const COMMAND_TIMEOUT_MS = 120 * 1000;

/** Declared container port used by the healthy fixtures. */
const FIXTURE_CONTAINER_PORT = 3000;

/**
 * Declared container port used by the failing fixture, which ignores `PORT`
 * and listens on 3000. Nothing listens on this port, so the probe can only
 * fail at the TCP layer.
 */
const NO_LISTENER_CONTAINER_PORT = 3001;

/** The port the failing fixture hard-codes; asserted from its own test source. */
const NO_LISTENER_FIXED_PORT = 3000;

/**
 * The complete `message` vocabulary of a failed network attempt, mirroring
 * `NETWORK_FAILURE_MESSAGES` in `src/health/probe.ts`. A published host port
 * with nothing listening behind it is reported by Podman's forwarder as
 * `connection closed` (it accepts the connection, then closes it), not always
 * as `connection refused`, so both wordings are legitimate. Anything outside
 * this list, such as an HTTP status, an option error, or a fabricated message,
 * still fails the assertion.
 */
const PROBE_NETWORK_FAILURE =
  /connection refused|connection reset by peer|connection timed out|connection closed|network unreachable|host unreachable|host not found|temporary name resolution failure|request aborted|timed out|network error/i;

/**
 * Optional evidence destination. The default lands under the OS temporary
 * directory so a run always records its observations without writing into the
 * package or the operator's state root.
 */
const EVIDENCE_ENV = "EASY_HOST_ADD_EVIDENCE";
const evidencePath =
  process.env[EVIDENCE_ENV]?.trim() ||
  path.join(tmpdir(), `easy-host-add-evidence-${process.pid}.json`);

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_ROOT = path.join(REPOSITORY_ROOT, "fixtures");

/** Rootless Podman range supported by v1. */
const MINIMUM_PODMAN: readonly [number, number, number] = [5, 7, 0];
const EXCLUDED_PODMAN_MAJOR = 6;

interface Fixture {
  /** Directory name under `fixtures/` and the label used in assertions. */
  readonly slug: string;
  /** Prefix of the unique app name for this run. */
  readonly appPrefix: string;
  /** Absolute fixture directory copied into a local git repository. */
  readonly directory: string;
  /** Text the live HTTP response must contain. */
  readonly marker: string;
  /** Optional named volume declared for this fixture. */
  readonly volume?: { readonly name: string; readonly target: string };
}

const FIXTURES: readonly Fixture[] = [
  {
    slug: "vite-spa",
    appPrefix: "it-vite",
    directory: path.join(FIXTURES_ROOT, "vite-spa"),
    marker: "easy-host Vite fixture",
  },
  {
    slug: "express-api",
    appPrefix: "it-express",
    directory: path.join(FIXTURES_ROOT, "express-api"),
    marker: "express-api",
    volume: { name: "data", target: "/var/lib/data" },
  },
  {
    slug: "fastapi-app",
    appPrefix: "it-fastapi",
    directory: path.join(FIXTURES_ROOT, "fastapi-app"),
    marker: "fastapi-app",
  },
];

/** The failure fixture's unique app-name prefix. */
const FAILURE_APP_PREFIX = "it-nolisten";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface AddObservation {
  readonly fixture: string;
  readonly app: string;
  readonly port: number;
  readonly image: string;
  readonly url: string;
  readonly healthAttempts: number;
  readonly healthElapsedMs: number;
  readonly durationMs: number;
  readonly volumes: readonly string[];
}

interface FailureObservation {
  readonly app: string;
  readonly port: number;
  readonly declaredContainerPort: number;
  readonly exitCode: number;
  readonly code: string;
  readonly reason: string;
  readonly image: string;
  readonly containerRemoved: boolean;
  readonly imageKept: boolean;
  readonly stateRecorded: boolean;
  readonly appDirectoryKept: boolean;
}

interface PodmanInspect {
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
  readonly images?: { readonly current?: string | null };
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

const observations: AddObservation[] = [];
const createdImages = new Set<string>();
const createdVolumes = new Set<string>();
const fixtureRepos = new Map<string, string>();

let temporaryRoot: string | undefined;
let paths: Paths | undefined;
let runSuffix = "";
let failureRepo: string | undefined;
let failureObservation: FailureObservation | undefined;
let podmanVersion = "";
let cleanupPromise: Promise<void> | undefined;

describe("add on the real host", () => {
  beforeAll(async () => {
    try {
      podmanVersion = await assertHostPrerequisites();

      temporaryRoot = mkdtempSync(path.join(tmpdir(), "easy-host-add-it-"));
      runSuffix = `${process.pid.toString(36)}${Date.now().toString(36)}`;
      paths = createPaths({ env: environmentFor(temporaryRoot) }).ensureLayout();

      for (const fixture of FIXTURES) {
        fixtureRepos.set(fixture.slug, await createGitFixture(fixture));
      }

      failureRepo = await createFailureFixture();
    } catch (error) {
      // afterAll may not run when beforeAll throws, so clean up here too.
      await cleanup();
      throw error;
    }
  }, SETUP_TIMEOUT_MS);

  for (const fixture of FIXTURES) {
    it(
      `adds the ${fixture.slug} fixture and serves it on the declared port`,
      async () => {
        const app = appNameFor(fixture);
        const port = await findFreePort();
        const repo = fixtureRepos.get(fixture.slug);
        if (repo === undefined) {
          throw new Error(`the local git repository for "${fixture.slug}" was not created`);
        }

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
          ...(fixture.volume === undefined
            ? {}
            : { volume: [`${fixture.volume.name}:${fixture.volume.target}`] }),
          environment: environment(),
        });
        const durationMs = Date.now() - startedAt;

        assertHealthyResult(result, fixture, port, app);
        createdImages.add(result.image);
        for (const volume of result.volumes) {
          createdVolumes.add(volume);
        }

        await assertContainerOnHost(app, result, fixture, port);
        await assertReachable(port, fixture.marker);

        observations.push({
          fixture: fixture.slug,
          app,
          port,
          image: result.image,
          url: result.url,
          healthAttempts: result.health.attempts,
          healthElapsedMs: result.health.elapsedMs,
          durationMs,
          volumes: result.volumes,
        });
        writeAddEvidence();

        console.info(
          `[add-integration] ${JSON.stringify({
            event: "fixture-added",
            fixture: fixture.slug,
            app,
            port,
            url: result.url,
            image: result.image,
            health: {
              state: result.health.state,
              attempts: result.health.attempts,
              elapsedMs: result.health.elapsedMs,
            },
            volumes: result.volumes,
            durationMs,
          })}`,
        );
      },
      ADD_TIMEOUT_MS,
    );
  }

  it(
    "keeps the image but removes the container when the first probe finds no listener",
    async () => {
      const app = failureAppName();
      const port = await findFreePort();
      const repo = failureRepo;
      if (repo === undefined) {
        throw new Error("the no-listener fixture repository was not created");
      }

      // Precondition: the host port really has no listener before add starts.
      await expect(noListener(port)).resolves.toBe(true);

      const stdout = new RecordingStream();
      const stderr = new RecordingStream();
      const exitCode = await runAddCommand({
        url: repo,
        ref: "main",
        name: app,
        port: String(port),
        bind: "127.0.0.1",
        containerPort: String(NO_LISTENER_CONTAINER_PORT),
        yes: true,
        interactive: false,
        json: true,
        stdout,
        stderr,
        environment: environment(),
      });

      expect(exitCode, "a failed first probe must map to the documented health exit code").toBe(4);

      const document = parseErrorDocument(stdout.text);
      const error = document.error;
      if (error === undefined || error.details === undefined) {
        throw new Error(`the failed add did not emit an error document: ${stdout.text}`);
      }

      expect(document.schemaVersion).toBe(1);
      expect(error.exitCode).toBe(4);
      expect(error.code).toBe("HEALTH_CHECK_FAILED");

      const image = textDetail(error.details, "image");
      const reason = textDetail(error.details, "reason");
      createdImages.add(image);

      expect(image).toMatch(new RegExp(`^localhost/easy-host-${app}:\\d{8}T\\d{6}Z$`));
      expect(error.details.state).toBe("unhealthy");
      expect(reason, "the probe must fail at the network layer, not on an HTTP status").toMatch(
        PROBE_NETWORK_FAILURE,
      );
      expect(error.remediation ?? "").toContain(`easy-host update ${app}`);
      expect(error.remediation ?? "").toContain(`easy-host config ${app}`);

      // ADD-FR-05 also requires the operator to see the container's own output,
      // so the log tail must reach stderr, not only the error document.
      expect(stderr.text, "the failed add must print the container log tail").toContain(
        "container logs (last 200 lines)",
      );
      expect(
        stderr.text,
        "the printed log tail must carry the app's own output from this container",
      ).toContain(`listening on fixed port ${NO_LISTENER_FIXED_PORT}`);
      expect(stderr.text, "the printed failure reason must match the recorded one").toContain(
        reason,
      );

      const containerExists = await podmanContainerExists(containerName(app));
      expect(containerExists, "a failed first probe must not leave a restarting container").toBe(
        false,
      );

      const listed = await runPodman([
        "ps",
        "-a",
        "--filter",
        `name=${containerName(app)}`,
        "--format",
        "{{.Names}}",
      ]);
      expect(listed.stdout.trim(), "no container with the app name may remain").toBe("");

      const imageKept = await podmanImageExists(image);
      expect(imageKept, "the built image must be kept for a retry").toBe(true);

      const appDir = requirePaths().appDir(app);
      expect(existsSync(appDir), "the app directory must be kept for a retry").toBe(true);
      expect(existsSync(path.join(appDir, "config.toml"))).toBe(true);

      const state = readRecordedState(app);
      expect(state.images?.current, "state.json must record the kept image").toBe(image);
      expect(state.containerId, "the removed container must not stay in state.json").toBeNull();
      expect(state.health?.status).toBe("unhealthy");
      // The cache must carry the same probe failure that reached the operator.
      expect(state.health?.detail ?? "").toContain(reason);
      expect(state.health?.detail ?? "").toMatch(PROBE_NETWORK_FAILURE);

      failureObservation = {
        app,
        port,
        declaredContainerPort: NO_LISTENER_CONTAINER_PORT,
        exitCode,
        code: error.code ?? "",
        reason,
        image,
        containerRemoved: true,
        imageKept,
        stateRecorded: true,
        appDirectoryKept: true,
      };
      writeAddEvidence();

      console.info(
        `[add-integration] ${JSON.stringify({
          event: "failed-add",
          fixture: "no-listener",
          ...failureObservation,
          fixedFixturePort: NO_LISTENER_FIXED_PORT,
        })}`,
      );
    },
    ADD_TIMEOUT_MS,
  );

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    }

    try {
      writeAddEvidence(true, cleanupError);
    } catch (error) {
      throw new Error(`could not record add evidence at "${evidencePath}": ${messageOf(error)}`);
    }

    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }, CLEANUP_TIMEOUT_MS);
});

/** Builds the environment `add` needs; the state root is always test-owned. */
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
      `the gated add suite runs only on the Linux target host; this platform is "${process.platform}"`,
    );
  }

  const version = await runCommand(
    "podman",
    ["version", "--format", "{{.Client.Version}}"],
    COMMAND_TIMEOUT_MS,
  ).catch((error: unknown) => {
    throw new Error(
      `could not run "podman" (${messageOf(error)}); the gated add suite requires rootless Podman >= ${MINIMUM_PODMAN.join(".")} and < ${EXCLUDED_PODMAN_MAJOR}.0.0`,
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
      `Podman ${major}.${minor}.${patch} is outside the supported range >= ${MINIMUM_PODMAN.join(".")} and < ${EXCLUDED_PODMAN_MAJOR}.0.0; upgrade or downgrade the host before running the add suite`,
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

  // The production add builder owns the fixed managed-buildkitd name. Refuse
  // to replace an operator daemon rather than silently stopping it.
  const daemonExists = await podmanContainerExists(BUILDKIT_CONTAINER_NAME);
  if (daemonExists) {
    throw new Error(
      `container "${BUILDKIT_CONTAINER_NAME}" already exists; the gated add suite owns the managed buildkitd and will not replace it. Stop and remove it with "podman stop ${BUILDKIT_CONTAINER_NAME} && podman rm ${BUILDKIT_CONTAINER_NAME}" (or use another host) before running the suite`,
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
 * Copies a fixture into a test-owned repository and commits it on `main`. A
 * real clone through `file://` keeps ADD-FR-02 in the add path without needing
 * network access to a remote.
 */
async function createGitFixture(fixture: Fixture): Promise<string> {
  if (!existsSync(fixture.directory)) {
    throw new Error(`fixture "${fixture.slug}" is missing at ${fixture.directory}`);
  }

  const repoDir = path.join(requireTempRoot(), "repos", fixture.slug);
  mkdirSync(path.dirname(repoDir), { recursive: true });
  cpSync(fixture.directory, repoDir, { recursive: true });
  return initializeRepository(repoDir);
}

/**
 * The no-listener fixture: a Node app that ignores `PORT` and binds 3000, while
 * `add` declares container port 3001. The container starts and stays up, but
 * the published port has no listener.
 */
async function createFailureFixture(): Promise<string> {
  const repoDir = path.join(requireTempRoot(), "repos", "no-listener");
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(
    path.join(repoDir, "package.json"),
    `${JSON.stringify(
      {
        name: "easy-host-fixture-no-listener",
        private: true,
        version: "0.0.0",
        main: "server.js",
        scripts: { start: "node server.js" },
        engines: { node: "24" },
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    path.join(repoDir, "server.js"),
    [
      'const http = require("node:http");',
      "",
      `const FIXED_PORT = ${NO_LISTENER_FIXED_PORT};`,
      "",
      "const server = http.createServer((request, response) => {",
      '  response.writeHead(200, { "content-type": "application/json" });',
      '  response.end(JSON.stringify({ status: "ok", service: "no-listener" }));',
      "});",
      "",
      'server.listen(FIXED_PORT, "0.0.0.0", () => {',
      '  console.log("no-listener fixture listening on fixed port " + FIXED_PORT);',
      "});",
      "",
    ].join("\n"),
  );

  return initializeRepository(repoDir);
}

async function initializeRepository(directory: string): Promise<string> {
  await runGit(["init", "--initial-branch=main", directory]);
  await runGit(["-C", directory, "add", "--all"]);
  await runGit([
    "-C",
    directory,
    "-c",
    "user.name=easy-host integration",
    "-c",
    "user.email=integration@easy-host.invalid",
    "commit",
    "-m",
    "fixture",
  ]);

  return `file://${directory}`;
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

/** True when connecting to the loopback port is refused. */
function noListener(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function assertHealthyResult(result: AddResult, fixture: Fixture, port: number, app: string): void {
  expect(result.app).toBe(app);
  expect(result.container).toBe(containerName(app));
  expect(result.port).toBe(port);
  expect(result.bind).toBe("127.0.0.1");
  expect(result.previousImage).toBeNull();
  expect(result.devOnly).toBe(false);
  expect(result.mode).toBe("git");
  expect(result.url).toBe(`http://localhost:${port}/`);

  expect(
    result.health.healthy,
    "add must not return a healthy result without a healthy probe",
  ).toBe(true);
  expect(result.health.state).toBe("healthy");
  expect(result.health.attempts).toBeGreaterThanOrEqual(1);
  expect(result.health.port).toBe(port);
  expect(result.health.target).toBe(`http://127.0.0.1:${port}/`);
  expect(result.health.elapsedMs).toBeGreaterThanOrEqual(0);

  const state = result.state;
  if (state === null) {
    throw new Error(`add did not record state.json for "${app}"`);
  }

  expect(state.health.status).toBe("healthy");
  expect(state.images.current).toBe(result.image);
  expect(state.containerId, "the healthy container id must be recorded").toMatch(/^[0-9a-f]{12,}$/);
  expect(result.image).toMatch(new RegExp(`^localhost/easy-host-${app}:\\d{8}T\\d{6}Z$`));

  if (fixture.volume === undefined) {
    expect(result.volumes).toEqual([]);
  } else {
    expect(result.volumes).toEqual([volumeName(app, fixture.volume.name)]);
  }

  const persisted = readRecordedState(app);
  expect(persisted.images?.current).toBe(result.image);
  expect(persisted.health?.status).toBe("healthy");
  expect(persisted.containerId, "state.json must record the healthy container").toMatch(
    /^[0-9a-f]{12,}$/,
  );
}

/**
 * Inspects the real container independently of the product adapter, then
 * checks the fields `ADD-FR-03` promises on the host.
 */
async function assertContainerOnHost(
  app: string,
  result: AddResult,
  fixture: Fixture,
  port: number,
): Promise<void> {
  const inspect = await inspectAppContainer(app);
  const containerPort = inspect.NetworkSettings?.Ports?.[`${FIXTURE_CONTAINER_PORT}/tcp`];
  const binding = containerPort?.[0];

  expect(inspect.State?.Running, "the container must be running after add").toBe(true);
  expect(inspect.HostConfig?.RestartPolicy?.Name, "restart policy must survive add").toBe("always");
  expect(
    binding,
    `host port ${port} must be published to container port ${FIXTURE_CONTAINER_PORT}`,
  ).toBeDefined();
  expect(binding?.HostPort).toBe(String(port));
  expect(binding?.HostIp).toBe("127.0.0.1");

  expect(inspect.Config?.Env ?? [], "PORT must name the container port").toContain(
    `PORT=${FIXTURE_CONTAINER_PORT}`,
  );

  const labels = inspect.Config?.Labels ?? {};
  expect(labels[APP_LABEL]).toBe(app);
  expect(labels[ROLE_LABEL]).toBe(APP_ROLE_VALUE);
  expect(labels[IMAGE_LABEL]).toBe(result.image);

  if (fixture.volume === undefined) {
    expect(inspect.Mounts ?? []).toEqual([]);
  } else {
    const declared = fixture.volume;
    const name = volumeName(app, declared.name);
    const mount = (inspect.Mounts ?? []).find((entry) => entry.Destination === declared.target);
    expect(mount, `volume ${name} must be mounted at ${declared.target}`).toBeDefined();
    expect(mount?.Type).toBe("volume");
    expect(mount?.Name).toBe(name);

    const volume = await inspectVolume(name);
    expect(volume.Labels?.[APP_LABEL], "the volume must be labelled for its app").toBe(app);
  }

  expect(await podmanImageExists(result.image)).toBe(true);
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
async function assertReachable(port: number, marker: string): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();

  expect(response.status, `expected ${url} to answer with 2xx after a healthy probe`).toBe(200);
  expect(body).toContain(marker);
}

function parseErrorDocument(text: string): ErrorDocument {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("the failed add wrote no JSON error document to stdout");
  }

  const parsed: unknown = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`the failed add wrote an unexpected JSON document: ${trimmed}`);
  }

  return parsed as ErrorDocument;
}

function textDetail(details: Record<string, unknown>, key: string): string {
  const value = details[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`the failed add did not record the "${key}" detail`);
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

function appNameFor(fixture: Fixture): string {
  return `${fixture.appPrefix}-${requireSuffix()}`;
}

function failureAppName(): string {
  return `${FAILURE_APP_PREFIX}-${requireSuffix()}`;
}

function requireSuffix(): string {
  if (runSuffix.length === 0) {
    throw new Error("the integration harness has not initialized its unique suffix");
  }

  return runSuffix;
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
 * Removes only what this suite created: app containers, app volumes, app
 * images, the managed daemon, and the temporary state root. Missing resources
 * are tolerated; every other cleanup failure is reported so a leak cannot
 * masquerade as a pass. Afterwards each resource class is re-read from Podman
 * to prove nothing was orphaned.
 */
async function performCleanup(): Promise<void> {
  const failures: string[] = [];
  const apps = allAppNames();

  for (const app of apps) {
    try {
      const result = await runPodman(["rm", "--force", containerName(app)]);
      if (result.exitCode !== 0 && !isMissingContainer(result.stderr)) {
        failures.push(`remove container "${containerName(app)}": ${result.stderr.trim()}`);
      }
    } catch (error) {
      failures.push(`remove container "${containerName(app)}": ${messageOf(error)}`);
    }
  }

  for (const app of apps) {
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
        continue;
      }

      for (const name of splitLines(listed.stdout)) {
        createdVolumes.add(name);
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

  try {
    for (const image of await listTestImages(apps)) {
      createdImages.add(image);
    }
  } catch (error) {
    failures.push(`list images created by this run: ${messageOf(error)}`);
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
  for (const app of apps) {
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
  }

  try {
    const remaining = await listTestImages(apps);
    if (remaining.length > 0) {
      failures.push(`images still exist after cleanup: ${remaining.join(", ")}`);
    }
  } catch (error) {
    failures.push(`verify image removal: ${messageOf(error)}`);
  }

  if (temporaryRoot !== undefined && existsSync(temporaryRoot)) {
    failures.push(`the temporary state root "${temporaryRoot}" still exists after cleanup`);
  }

  if (failures.length > 0) {
    throw new Error(`add integration cleanup failed:\n- ${failures.join("\n- ")}`);
  }
}

function allAppNames(): readonly string[] {
  if (runSuffix.length === 0) {
    return [];
  }

  return [...FIXTURES.map(appNameFor), failureAppName()];
}

/**
 * Lists image references that belong to this run, identified by each unique app
 * name. The suffix embeds the pid and start time, so a prefix match cannot
 * reach an operator image or a previous run.
 */
async function listTestImages(apps: readonly string[]): Promise<readonly string[]> {
  if (apps.length === 0) {
    return [];
  }

  const result = await runPodman(["images", "--format", "{{.Repository}}:{{.Tag}}"]);
  if (result.exitCode !== 0) {
    throw new Error(`"podman images" failed with code ${result.exitCode}: ${result.stderr.trim()}`);
  }

  const prefixes = apps.map((app) => `localhost/easy-host-${app}:`);
  return splitLines(result.stdout).filter((reference) =>
    prefixes.some((prefix) => reference.startsWith(prefix)),
  );
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
 * evidence that were already collected, then once more after cleanup.
 */
function writeAddEvidence(final = false, cleanupError?: unknown): void {
  const document = {
    schemaVersion: 1,
    task: "ADD-1.6",
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
    fixtures: observations,
    failedAdd: failureObservation ?? null,
    cleanup: final ? (cleanupError === undefined ? "ok" : messageOf(cleanupError)) : "pending",
  };

  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
  console.info(
    `[add-integration] ${JSON.stringify({ event: "evidence", path: evidencePath, final })}`,
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
