/**
 * Rootless buildkitd lifecycle (`BLD-FR-02`).
 *
 * easy-host owns exactly one BuildKit daemon per host. {@link Buildkit.ensure}
 * reuses it when the managed container is running and its unix socket accepts a
 * connection; otherwise it starts the pinned rootless image declared in
 * `versions.ts` and waits a bounded time for that socket.
 *
 * The daemon command is the one the Phase 0 spike proved on rootless Podman
 * 5.7.0 (`docs/reviews/bld-0.1-spike.md` §3). Every flag below is deliberate:
 *
 * - `--user 0` — buildkitd refuses to start in rootless mode otherwise.
 * - `--privileged` — the OCI worker cannot bind-mount its snapshots without it;
 *   `--cap-add SYS_ADMIN` alone was not sufficient. `PRD-SP-03` permits this
 *   elevated option for the dedicated buildkitd when the spike records and
 *   justifies it. It is never applied to an app container.
 * - `--entrypoint /usr/bin/buildkitd` — the image's `rootlesskit` entrypoint
 *   cannot create its nested UID map under rootless Podman.
 * - `--oci-worker-no-process-sandbox` — Podman has no
 *   `systempaths=unconfined`; this is BuildKit's documented substitute.
 * - `--addr unix:///run/user/1000/buildkit/buildkitd.sock` plus the two volume
 *   mounts — the state and socket live under `<root>/buildkit`, and the host
 *   user owns both because container root maps to the invoking user.
 *
 * The container is named distinctly from app containers (`easy-host-<app>`) and
 * carries `io.easy-host.role=buildkit`, so it is infrastructure and never
 * appears as an app. No `--privileged`, host-network, or namespace flag is used
 * anywhere else in this module.
 *
 * Every Podman call goes through {@link BuildkitRunner} with an argument array
 * and a finite timeout (`PRD-NF-05`, `PRD-NF-09`). The default runner is a
 * shell-free `spawnSync` call; the shared platform runner can replace it by
 * injection without changing this module's interface.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { ConflictError, PrerequisiteError } from "../cli/errors.js";
import { BUILDKIT_IMAGE_REFERENCE } from "./versions.js";

/** Container name used for the one managed BuildKit daemon. */
export const BUILDKIT_CONTAINER_NAME = "easy-host-buildkitd";

/** Label key that marks the daemon as infrastructure rather than an app. */
export const BUILDKIT_ROLE_LABEL = "io.easy-host.role";

/** Label value that excludes the daemon from `list` and app lookups. */
export const BUILDKIT_ROLE_VALUE = "buildkit";

/** Name of the socket file inside `<root>/buildkit/socket`. */
export const BUILDKIT_SOCKET_FILENAME = "buildkitd.sock";

/** State directory below `<root>/buildkit`, mounted for the BuildKit cache. */
export const BUILDKIT_STATE_DIRECTORY = "state";

/** Socket directory below `<root>/buildkit`, mounted for the unix socket. */
export const BUILDKIT_SOCKET_DIRECTORY = "socket";

/** BuildKit's state path inside the pinned image (spike §3). */
export const BUILDKIT_STATE_TARGET = "/home/user/.local/share/buildkit";

/** BuildKit's socket directory inside the pinned image (spike §3). */
export const BUILDKIT_SOCKET_TARGET = "/run/user/1000/buildkit";

/** BuildKit's listening socket inside the pinned image (spike §3). */
export const BUILDKIT_CONTAINER_SOCKET = `${BUILDKIT_SOCKET_TARGET}/${BUILDKIT_SOCKET_FILENAME}`;

/**
 * The buildkitd command-line flags from the spike, in order. These are the
 * "runtime flags" the operations guide must record verbatim.
 */
export const BUILDKITD_RUNTIME_FLAGS = [
  "--addr",
  `unix://${BUILDKIT_CONTAINER_SOCKET}`,
  "--oci-worker-no-process-sandbox",
] as const;

/** Bounded wait for a freshly started daemon to accept a connection. */
export const BUILDKIT_READINESS_TIMEOUT_MS = 20_000;

/** Interval between socket probes while waiting for readiness. */
export const BUILDKIT_READINESS_POLL_MS = 100;

/** Bound on a single socket connection attempt. */
export const BUILDKIT_SOCKET_PROBE_TIMEOUT_MS = 1_000;

/** Bound on `podman run`, which may include a cold image pull (~51s in the spike). */
export const BUILDKIT_START_TIMEOUT_MS = 600_000;

/** Bound on `podman stop` / `podman rm` calls. */
export const BUILDKIT_STOP_TIMEOUT_MS = 30_000;

/** Bound on `podman container exists` and `podman inspect`. */
export const BUILDKIT_INSPECT_TIMEOUT_MS = 15_000;

/** Permissions for the state and socket directories created under the root. */
export const BUILDKIT_DIRECTORY_MODE = 0o700;

/** How long `podman stop` gives the daemon before it is removed. */
export const BUILDKIT_STOP_GRACE_SECONDS = 10;

/** One completed Podman call. */
export interface BuildkitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the executable could not be started, for example `ENOENT`. */
  spawnError?: string;
}

/** Per-call overrides; every call also receives a finite default timeout. */
export interface BuildkitCommandOptions {
  timeoutMs?: number;
}

/**
 * The narrow process-runner surface this module needs. It is structurally
 * satisfied by the shared platform runner and by doctor's runner, so tests can
 * inject a recording fake. A synchronous return is accepted for compatibility;
 * callers always `await` it.
 */
export interface BuildkitRunner {
  run(
    command: string,
    args: readonly string[],
    options?: BuildkitCommandOptions,
  ): BuildkitCommandResult | Promise<BuildkitCommandResult>;
}

/** The directories and socket that make up the managed BuildKit layout. */
export interface BuildkitLayout {
  /** `<root>/buildkit`. */
  readonly root: string;
  /** `<root>/buildkit/state`, mounted at {@link BUILDKIT_STATE_TARGET}. */
  readonly stateDir: string;
  /** `<root>/buildkit/socket`, mounted at {@link BUILDKIT_SOCKET_TARGET}. */
  readonly socketDir: string;
  /** Host path of the daemon socket. */
  readonly socketPath: string;
  /** `BUILDKIT_HOST` value for Railpack and `buildctl`. */
  readonly buildkitHost: string;
}

/** The part of `Paths` this module reads. */
export interface BuildkitPaths {
  /** `<root>/buildkit`. */
  readonly buildkitDir: string;
}

/** Injectable socket probe. Tests return a recorded value instead of connecting. */
export type BuildkitSocketProbe = (socketPath: string, timeoutMs: number) => Promise<boolean>;

/** Inputs shared by all lifecycle operations. */
export interface BuildkitOptions {
  /** State-root layout, usually the `Paths` instance. */
  paths: BuildkitPaths;
  /** Process runner. Defaults to a shell-free `spawnSync` implementation. */
  runner?: BuildkitRunner;
  /** Container name. Defaults to {@link BUILDKIT_CONTAINER_NAME}. */
  containerName?: string;
  /** Fully pinned image reference. Defaults to `BUILDKIT_IMAGE_REFERENCE`. */
  image?: string;
  /** Readiness budget. Defaults to {@link BUILDKIT_READINESS_TIMEOUT_MS}. */
  readinessTimeoutMs?: number;
  /** Socket probe interval. Defaults to {@link BUILDKIT_READINESS_POLL_MS}. */
  pollIntervalMs?: number;
  /** Single probe budget. Defaults to {@link BUILDKIT_SOCKET_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
  /** `podman run` budget. Defaults to {@link BUILDKIT_START_TIMEOUT_MS}. */
  startTimeoutMs?: number;
  /** `podman stop`/`rm` budget. Defaults to {@link BUILDKIT_STOP_TIMEOUT_MS}. */
  stopTimeoutMs?: number;
  /** Inspect budget. Defaults to {@link BUILDKIT_INSPECT_TIMEOUT_MS}. */
  inspectTimeoutMs?: number;
  /** Socket probe implementation. */
  probeSocket?: BuildkitSocketProbe;
  /** Monotonic-enough clock for the readiness deadline. Defaults to `Date.now`. */
  now?: () => number;
  /** Sleep used between probes. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Lifecycle state reported by {@link Buildkit.status}. */
export type BuildkitState = "running" | "unhealthy" | "stopped" | "absent" | "conflict" | "unknown";

/** Read-only status of the managed daemon. */
export interface BuildkitStatus {
  readonly containerName: string;
  readonly containerId: string | undefined;
  readonly image: string;
  readonly socketPath: string;
  readonly buildkitHost: string;
  readonly state: BuildkitState;
  /** True when the socket accepted a connection. */
  readonly socketReachable: boolean;
  /** One-line explanation suitable for a doctor line. */
  readonly detail: string;
}

/** A daemon that is running and ready for a build. */
export interface BuildkitDaemon {
  readonly containerName: string;
  readonly containerId: string | undefined;
  readonly image: string;
  readonly socketPath: string;
  readonly buildkitHost: string;
  /** True when an existing daemon was adopted instead of started. */
  readonly reused: boolean;
  readonly state: "running";
}

/** Outcome of {@link Buildkit.stop}. */
export interface BuildkitStopResult {
  readonly containerName: string;
  /** True when a running container was stopped with `podman stop`. */
  readonly stopped: boolean;
  /** True when the container was removed. */
  readonly removed: boolean;
  readonly socketPath: string;
}

interface ObservedContainer {
  readonly id: string;
  readonly status: string;
  readonly role: string | undefined;
}

/** Resolves the paths derived from `<root>/buildkit`. */
export function buildkitLayout(buildkitDir: string): BuildkitLayout {
  const root = path.resolve(buildkitDir);
  const socketDir = path.join(root, BUILDKIT_SOCKET_DIRECTORY);
  const socketPath = path.join(socketDir, BUILDKIT_SOCKET_FILENAME);

  return {
    root,
    stateDir: path.join(root, BUILDKIT_STATE_DIRECTORY),
    socketDir,
    socketPath,
    buildkitHost: `unix://${socketPath}`,
  };
}

/**
 * Builds the exact `podman run` argument array recorded by the spike. Callers
 * should not add flags: the pinned flags and mounts are the seam, and a
 * different daemon command needs a new spike record.
 */
export function buildkitRunArguments(
  layout: BuildkitLayout,
  options: { containerName?: string; image?: string } = {},
): string[] {
  return [
    "run",
    "-d",
    "--name",
    options.containerName ?? BUILDKIT_CONTAINER_NAME,
    "--label",
    `${BUILDKIT_ROLE_LABEL}=${BUILDKIT_ROLE_VALUE}`,
    "--user",
    "0",
    "--privileged",
    "--entrypoint",
    "/usr/bin/buildkitd",
    "-v",
    `${layout.stateDir}:${BUILDKIT_STATE_TARGET}`,
    "-v",
    `${layout.socketDir}:${BUILDKIT_SOCKET_TARGET}`,
    options.image ?? BUILDKIT_IMAGE_REFERENCE,
    ...BUILDKITD_RUNTIME_FLAGS,
  ];
}

/**
 * Connects to a unix socket and hangs up as soon as the connection succeeds.
 * Resolves `false` for a missing socket, a refused connection, or a timeout; it
 * never throws.
 */
export function probeBuildkitSocket(
  socketPath: string,
  timeoutMs: number = BUILDKIT_SOCKET_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath });
    let settled = false;

    const finish = (reachable: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(normalizeDuration(timeoutMs, BUILDKIT_SOCKET_PROBE_TIMEOUT_MS), () =>
      finish(false),
    );
  });
}

/**
 * Manages the one rootless buildkitd container.
 *
 * `ensure()` mutates host state only after the managed container's identity is
 * verified; `status()` is read-only and never starts or stops anything.
 */
export class Buildkit {
  readonly layout: BuildkitLayout;
  readonly containerName: string;
  readonly image: string;

  readonly #runner: BuildkitRunner;
  readonly #socketProbe: BuildkitSocketProbe;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #readinessTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #probeTimeoutMs: number;
  readonly #startTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #inspectTimeoutMs: number;

  constructor(options: BuildkitOptions) {
    this.layout = buildkitLayout(options.paths.buildkitDir);
    this.containerName = options.containerName ?? BUILDKIT_CONTAINER_NAME;
    this.image = options.image ?? BUILDKIT_IMAGE_REFERENCE;
    this.#runner = options.runner ?? createDefaultRunner();
    this.#socketProbe = options.probeSocket ?? probeBuildkitSocket;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#readinessTimeoutMs = normalizeDuration(
      options.readinessTimeoutMs,
      BUILDKIT_READINESS_TIMEOUT_MS,
    );
    this.#pollIntervalMs = normalizeDuration(options.pollIntervalMs, BUILDKIT_READINESS_POLL_MS);
    this.#probeTimeoutMs = normalizeDuration(
      options.probeTimeoutMs,
      BUILDKIT_SOCKET_PROBE_TIMEOUT_MS,
    );
    this.#startTimeoutMs = normalizeDuration(options.startTimeoutMs, BUILDKIT_START_TIMEOUT_MS);
    this.#stopTimeoutMs = normalizeDuration(options.stopTimeoutMs, BUILDKIT_STOP_TIMEOUT_MS);
    this.#inspectTimeoutMs = normalizeDuration(
      options.inspectTimeoutMs,
      BUILDKIT_INSPECT_TIMEOUT_MS,
    );
  }

  /**
   * Returns a running, ready daemon, starting the pinned container only when no
   * healthy managed daemon exists.
   *
   * A running managed container whose socket does not accept connections is
   * replaced. A container that carries this name without the buildkit role
   * label is foreign and is never stopped; that is a name conflict. A socket
   * already served by something else is a socket conflict. A leftover socket
   * file with no listener is stale and is removed before the cold start.
   */
  async ensure(): Promise<BuildkitDaemon> {
    this.#prepareDirectories();

    const existing = await this.#inspectContainer();
    if (existing !== undefined) {
      if (existing.role !== BUILDKIT_ROLE_VALUE) {
        throw nameConflictError(this.containerName);
      }

      if (existing.status === "running" && (await this.#socketAccepts())) {
        return this.#daemon(existing.id, true);
      }

      await this.#removeContainer();
    }

    await this.#clearStaleSocket();
    const containerId = await this.#startContainer();

    if (!(await this.#waitForSocket())) {
      throw socketTimeoutError(
        this.containerName,
        this.layout.socketPath,
        this.#readinessTimeoutMs,
      );
    }

    return this.#daemon(containerId, false);
  }

  /**
   * Read-only status for doctor and diagnostics. It never starts the daemon and
   * never throws; an unusable Podman client is reported as `unknown`.
   */
  async status(): Promise<BuildkitStatus> {
    const base = {
      containerName: this.containerName,
      image: this.image,
      socketPath: this.layout.socketPath,
      buildkitHost: this.layout.buildkitHost,
    };

    try {
      const existing = await this.#inspectContainer();
      const socketReachable = await this.#socketAccepts();

      if (existing === undefined) {
        return {
          ...base,
          containerId: undefined,
          state: "absent",
          socketReachable,
          detail: socketReachable
            ? "no managed buildkitd container, but something is accepting connections on the managed socket"
            : "no managed buildkitd container",
        };
      }

      if (existing.role !== BUILDKIT_ROLE_VALUE) {
        return {
          ...base,
          containerId: existing.id,
          state: "conflict",
          socketReachable,
          detail: `container "${this.containerName}" exists without the ${BUILDKIT_ROLE_LABEL}=${BUILDKIT_ROLE_VALUE} label`,
        };
      }

      if (existing.status === "running") {
        return {
          ...base,
          containerId: existing.id,
          state: socketReachable ? "running" : "unhealthy",
          socketReachable,
          detail: socketReachable
            ? "buildkitd is running and the socket accepts connections"
            : "buildkitd container is running but the socket does not accept connections",
        };
      }

      return {
        ...base,
        containerId: existing.id,
        state: "stopped",
        socketReachable,
        detail: `buildkitd container is ${existing.status}`,
      };
    } catch (error) {
      return {
        ...base,
        containerId: undefined,
        state: "unknown",
        socketReachable: false,
        detail: messageOf(error),
      };
    }
  }

  /**
   * Stops and removes the managed daemon. The daemon is disposable
   * infrastructure, so removing it makes the next {@link ensure} a clean cold
   * start. Idempotent when no managed container exists, and never touches a
   * foreign container.
   */
  async stop(): Promise<BuildkitStopResult> {
    const existing = await this.#inspectContainer();

    if (existing === undefined) {
      await this.#removeSocketIfUnused();
      return {
        containerName: this.containerName,
        stopped: false,
        removed: false,
        socketPath: this.layout.socketPath,
      };
    }

    if (existing.role !== BUILDKIT_ROLE_VALUE) {
      throw nameConflictError(this.containerName);
    }

    let stopped = false;
    if (existing.status === "running" || existing.status === "paused") {
      const result = await this.#podman(
        ["stop", "--time", String(BUILDKIT_STOP_GRACE_SECONDS), this.containerName],
        this.#stopTimeoutMs,
      );
      this.#assertPodmanAvailable(result, "stop the buildkitd container");
      stopped = result.exitCode === 0;
    }

    const removal = await this.#podman(["rm", "--force", this.containerName], this.#stopTimeoutMs);
    this.#assertPodmanAvailable(removal, "remove the buildkitd container");

    if (removal.exitCode !== 0 && !isMissingContainer(removal)) {
      throw commandFailureError(
        "BUILDKIT_STOP_FAILED",
        `could not remove the buildkitd container "${this.containerName}"`,
        removal,
        `Run "podman rm --force ${this.containerName}" and retry.`,
      );
    }

    await this.#removeSocketIfUnused();

    return {
      containerName: this.containerName,
      stopped,
      removed: true,
      socketPath: this.layout.socketPath,
    };
  }

  #daemon(containerId: string | undefined, reused: boolean): BuildkitDaemon {
    return {
      containerName: this.containerName,
      containerId,
      image: this.image,
      socketPath: this.layout.socketPath,
      buildkitHost: this.layout.buildkitHost,
      reused,
      state: "running",
    };
  }

  #prepareDirectories(): void {
    for (const directory of [this.layout.root, this.layout.stateDir, this.layout.socketDir]) {
      try {
        mkdirSync(directory, { recursive: true, mode: BUILDKIT_DIRECTORY_MODE });
      } catch (error) {
        throw new PrerequisiteError(
          `could not prepare the BuildKit directory "${directory}": ${messageOf(error)}`,
          {
            code: "BUILDKIT_STATE_UNWRITABLE",
            details: { path: directory, reason: messageOf(error) },
            remediation: `Set EASY_HOST_HOME to a writable directory or grant write permission on "${this.layout.root}".`,
            cause: error,
          },
        );
      }
    }
  }

  async #inspectContainer(): Promise<ObservedContainer | undefined> {
    const exists = await this.#podman(
      ["container", "exists", this.containerName],
      this.#inspectTimeoutMs,
    );
    this.#assertPodmanAvailable(exists, "check the buildkitd container");

    if (exists.exitCode === 1) {
      return undefined;
    }

    if (exists.exitCode !== 0) {
      throw inspectError(this.containerName, exists);
    }

    const inspected = await this.#podman(
      [
        "inspect",
        "--format",
        "{{.Id}}|{{.State.Status}}|{{json .Config.Labels}}",
        this.containerName,
      ],
      this.#inspectTimeoutMs,
    );
    this.#assertPodmanAvailable(inspected, "inspect the buildkitd container");

    if (inspected.exitCode !== 0) {
      if (isMissingContainer(inspected)) {
        return undefined;
      }

      throw inspectError(this.containerName, inspected);
    }

    return parseInspectOutput(inspected.stdout, this.containerName, inspected);
  }

  async #startContainer(): Promise<string | undefined> {
    const result = await this.#podman(
      buildkitRunArguments(this.layout, {
        containerName: this.containerName,
        image: this.image,
      }),
      this.#startTimeoutMs,
    );
    this.#assertPodmanAvailable(result, "start the buildkitd container");

    if (result.exitCode !== 0 || result.spawnError !== undefined) {
      throw commandFailureError(
        "BUILDKIT_START_FAILED",
        `could not start the buildkitd container "${this.containerName}"`,
        result,
        `Run "podman logs ${this.containerName}" for details, then retry. The pinned image is ${this.image}.`,
      );
    }

    const printed = result.stdout.trim();
    if (printed.length > 0) {
      return printed.split(/\s+/).at(-1);
    }

    const observed = await this.#inspectContainer();
    return observed?.id;
  }

  async #removeContainer(): Promise<void> {
    const result = await this.#podman(["rm", "--force", this.containerName], this.#stopTimeoutMs);
    this.#assertPodmanAvailable(result, "replace the buildkitd container");

    if (result.exitCode !== 0 && !isMissingContainer(result)) {
      throw commandFailureError(
        "BUILDKIT_REPLACE_FAILED",
        `could not replace the unhealthy buildkitd container "${this.containerName}"`,
        result,
        `Run "podman rm --force ${this.containerName}" and retry.`,
      );
    }
  }

  /**
   * A socket path with no listener is a leftover from a previous daemon and is
   * removed before the cold start. A live listener means another process owns
   * the managed path, which is a conflict rather than something to delete.
   */
  async #clearStaleSocket(): Promise<void> {
    const socketPath = this.layout.socketPath;
    let stats: ReturnType<typeof lstatSync>;

    try {
      stats = lstatSync(socketPath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
        return;
      }

      throw socketPathError(socketPath, messageOf(error));
    }

    if (!stats.isSocket()) {
      throw new ConflictError(
        `the BuildKit socket path "${socketPath}" exists and is not a unix socket`,
        {
          code: "BUILDKIT_SOCKET_PATH_OCCUPIED",
          details: { socket: socketPath },
          remediation: `Inspect "${socketPath}" and remove it if it is a leftover file, then retry.`,
        },
      );
    }

    if (await this.#socketAccepts()) {
      throw new ConflictError(
        `the BuildKit socket "${socketPath}" already accepts connections but no managed buildkitd container owns it`,
        {
          code: "BUILDKIT_SOCKET_CONFLICT",
          details: { socket: socketPath, container: this.containerName },
          remediation: `Stop the process listening on "${socketPath}" or remove the socket file, then retry.`,
        },
      );
    }

    try {
      rmSync(socketPath, { force: true });
    } catch (error) {
      throw socketPathError(socketPath, messageOf(error));
    }
  }

  async #removeSocketIfUnused(): Promise<void> {
    const socketPath = this.layout.socketPath;

    try {
      if (!lstatSync(socketPath).isSocket()) {
        return;
      }
    } catch {
      return;
    }

    if (await this.#socketAccepts()) {
      return;
    }

    try {
      rmSync(socketPath, { force: true });
    } catch {
      // Best effort: a stale socket is removed by the next ensure().
    }
  }

  async #waitForSocket(): Promise<boolean> {
    const deadline = this.#now() + this.#readinessTimeoutMs;

    for (;;) {
      if (await this.#socketAccepts()) {
        return true;
      }

      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        return false;
      }

      await this.#sleep(Math.min(this.#pollIntervalMs, remaining));
    }
  }

  #socketAccepts(): Promise<boolean> {
    return this.#socketProbe(this.layout.socketPath, this.#probeTimeoutMs);
  }

  #podman(args: readonly string[], timeoutMs: number): Promise<BuildkitCommandResult> {
    return Promise.resolve(this.#runner.run("podman", args, { timeoutMs }));
  }

  #assertPodmanAvailable(result: BuildkitCommandResult, operation: string): void {
    if (result.spawnError !== "ENOENT") {
      return;
    }

    const reason = `podman executable not found (${describeFailure(result)})`;

    throw new PrerequisiteError(`could not ${operation}: ${reason}`, {
      code: "BUILDKIT_PODMAN_UNAVAILABLE",
      details: { reason },
      remediation:
        "Install rootless Podman 5.7.0-5.8.x, ensure `podman` is on PATH, then run `easy-host doctor`.",
    });
  }
}

/** Convenience factory for {@link Buildkit}. */
export function createBuildkit(options: BuildkitOptions): Buildkit {
  return new Buildkit(options);
}

/** Convenience wrapper for {@link Buildkit.ensure}. */
export function ensureBuildkit(options: BuildkitOptions): Promise<BuildkitDaemon> {
  return createBuildkit(options).ensure();
}

/** Convenience wrapper for {@link Buildkit.status}. */
export function buildkitStatus(options: BuildkitOptions): Promise<BuildkitStatus> {
  return createBuildkit(options).status();
}

/** Convenience wrapper for {@link Buildkit.stop}. */
export function stopBuildkit(options: BuildkitOptions): Promise<BuildkitStopResult> {
  return createBuildkit(options).stop();
}

function createDefaultRunner(): BuildkitRunner {
  return {
    run(command, args, options = {}) {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        timeout: normalizeDuration(options.timeoutMs, BUILDKIT_INSPECT_TIMEOUT_MS),
        maxBuffer: 8 * 1024 * 1024,
      });
      const spawnError = spawnErrorOf(result.error);

      return {
        exitCode: result.status ?? (spawnError === undefined ? 1 : 127),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ...(spawnError === undefined ? {} : { spawnError }),
      };
    },
  };
}

function parseInspectOutput(
  stdout: string,
  containerName: string,
  result: BuildkitCommandResult,
): ObservedContainer {
  const firstSeparator = stdout.indexOf("|");
  const secondSeparator = stdout.indexOf("|", firstSeparator + 1);

  if (firstSeparator < 0 || secondSeparator < 0) {
    throw inspectError(containerName, { ...result, stdout, stderr: "unexpected inspect output" });
  }

  const id = stdout.slice(0, firstSeparator).trim();
  const status = stdout.slice(firstSeparator + 1, secondSeparator).trim();
  const labels = parseLabels(stdout.slice(secondSeparator + 1).trim());

  if (id.length === 0 || status.length === 0) {
    throw inspectError(containerName, result);
  }

  const role = labels[BUILDKIT_ROLE_LABEL];

  return {
    id,
    status,
    role: typeof role === "string" ? role : undefined,
  };
}

function parseLabels(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.trunc(value);
}

function spawnErrorOf(error: Error | undefined): string | undefined {
  if (error === undefined) {
    return undefined;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && code.length > 0 ? code : error.message;
}

function describeFailure(result: BuildkitCommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }

  if (result.spawnError !== undefined) {
    return result.spawnError;
  }

  return `exit code ${result.exitCode}`;
}

function isMissingContainer(result: BuildkitCommandResult): boolean {
  return /no such (container|object)/i.test(result.stderr);
}

function inspectError(containerName: string, result: BuildkitCommandResult): PrerequisiteError {
  return new PrerequisiteError(
    `could not inspect the buildkitd container "${containerName}": ${describeFailure(result)}`,
    {
      code: "BUILDKIT_INSPECT_FAILED",
      details: { container: containerName, reason: describeFailure(result) },
      remediation: "Run `podman info` to check the container engine, then run `easy-host doctor`.",
    },
  );
}

function nameConflictError(containerName: string): ConflictError {
  return new ConflictError(
    `container "${containerName}" already exists but is not the easy-host buildkitd (missing ${BUILDKIT_ROLE_LABEL}=${BUILDKIT_ROLE_VALUE})`,
    {
      code: "BUILDKIT_NAME_CONFLICT",
      details: { container: containerName, expectedRole: BUILDKIT_ROLE_VALUE },
      remediation: `Confirm what owns "${containerName}" and remove or rename it, or set a different buildkit container name.`,
    },
  );
}

function socketTimeoutError(
  containerName: string,
  socketPath: string,
  timeoutMs: number,
): PrerequisiteError {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));

  return new PrerequisiteError(
    `buildkitd did not accept connections on "${socketPath}" within ${seconds}s`,
    {
      code: "BUILDKIT_SOCKET_TIMEOUT",
      details: { container: containerName, socket: socketPath, timeoutMs },
      remediation: `Run "podman logs ${containerName}" for the daemon error, then retry.`,
    },
  );
}

function socketPathError(socketPath: string, reason: string): PrerequisiteError {
  return new PrerequisiteError(`could not prepare the BuildKit socket "${socketPath}": ${reason}`, {
    code: "BUILDKIT_SOCKET_UNWRITABLE",
    details: { socket: socketPath, reason },
    remediation: `Grant write permission on "${path.dirname(socketPath)}" and retry.`,
  });
}

function commandFailureError(
  code: string,
  summary: string,
  result: BuildkitCommandResult,
  remediation: string,
): PrerequisiteError {
  return new PrerequisiteError(`${summary}: ${describeFailure(result)}`, {
    code,
    details: { reason: describeFailure(result), exitCode: result.exitCode },
    remediation,
  });
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
