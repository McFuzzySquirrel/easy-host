/**
 * Rootless Podman container and volume operations (`ADD-FR-03`).
 *
 * The container runtime is a narrow, injectable seam: `run`, `stop`, `remove`,
 * `inspect`, `logs`, and the volume create/list/remove calls. Every method
 * receives a finite timeout and invokes Podman through an argument array, never
 * a shell string (`PRD-SP-04`, `PRD-NF-05`, `PRD-NF-09`).
 *
 * `run` implements the ADD-FR-03 contract exactly:
 *
 * - container name `easy-host-<app>`;
 * - `--restart=always`;
 * - one `--publish <bind>:<port>:<containerPort>`;
 * - `PORT` set to the container port, overriding any app-provided value;
 * - one `--env KEY=VALUE` per merged environment entry;
 * - one `--volume easy-host-<app>-<volume>:<containerPath>` per declared mount;
 * - the `io.easy-host.app`, `io.easy-host.role=app`, and `io.easy-host.image`
 *   labels.
 *
 * App containers are never started privileged, with host networking, or with
 * added capabilities (`PRD-SP-03`). The module does not accept options for any
 * of those flags.
 *
 * Environment values are passed to Podman but are deliberately absent from
 * every error message, detail object, and remediation. Error details carry the
 * variable *names* and the declared volumes only, and any Podman output echoed
 * into an error is redacted against the supplied environment values
 * (`PRD-NF-10`). {@link inspectContainer} likewise exposes environment names,
 * never values.
 *
 * Failure mapping keeps host/runtime problems distinct from configuration
 * problems: invalid app names, ports, binds, environment keys, and volume
 * mounts are `UsageError` (exit 1); a missing Podman binary, timeout, or failed
 * container/volume operation is `PrerequisiteError` (exit 2); a container name,
 * host port, or existing volume collision is `ConflictError` (exit 6); and a
 * missing container or volume is `NotFoundError` (exit 5).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  ConflictError,
  type ErrorDetails,
  NotFoundError,
  PrerequisiteError,
  redactText,
  UsageError,
} from "../cli/errors.js";
import { validateAppName } from "../config/name.js";
import {
  APP_SPEC_DEFAULTS,
  BIND_ADDRESSES,
  ENV_NAME_PATTERN,
  MAX_PORT,
  MIN_HOST_PORT,
  VOLUME_NAME_PATTERN,
} from "../config/schema.js";
import { validateDeclaredPort } from "../registry/ports.js";

/** The Podman executable. It is always invoked through the argument array. */
export const PODMAN_BINARY = "podman";

/** Prefix shared by app containers and app volumes. */
export const CONTAINER_NAME_PREFIX = "easy-host-";

/** Restart policy required for every app container (`ADD-FR-03`). */
export const RESTART_POLICY = "always";

/** Label naming the owning app. */
export const APP_LABEL = "io.easy-host.app";

/** Label distinguishing app containers from infrastructure containers. */
export const ROLE_LABEL = "io.easy-host.role";

/** Role value carried by every app container. */
export const APP_ROLE_VALUE = "app";

/** Label recording the image an app container was started from. */
export const IMAGE_LABEL = "io.easy-host.image";

/** Default number of trailing log lines passed to `podman logs`. */
export const DEFAULT_LOGS_TAIL = 200;

/** Bound on `podman run`; the image is local, but a pull may still occur. */
export const PODMAN_RUN_TIMEOUT_MS = 600_000;

/** Bound on `podman stop`. */
export const PODMAN_STOP_TIMEOUT_MS = 60_000;

/** Bound on `podman rm`. */
export const PODMAN_REMOVE_TIMEOUT_MS = 60_000;

/** Bound on `podman container inspect`. */
export const PODMAN_INSPECT_TIMEOUT_MS = 15_000;

/**
 * Bound on `podman logs`. `logs -f` can follow for a long time, but
 * `PRD-NF-05` still requires a finite bound; callers may raise it per call.
 */
export const PODMAN_LOGS_TIMEOUT_MS = 3_600_000;

/** Bound on volume create/list/remove. */
export const PODMAN_VOLUME_TIMEOUT_MS = 60_000;

/** Stable diagnostic codes for every failure this module raises. */
export const PODMAN_FAILURE_CODES = {
  UNAVAILABLE: "PODMAN_UNAVAILABLE",
  TIMEOUT: "PODMAN_TIMEOUT",
  RUN_FAILED: "CONTAINER_RUN_FAILED",
  NAME_CONFLICT: "CONTAINER_NAME_CONFLICT",
  PORT_IN_USE: "PORT_IN_USE",
  STOP_FAILED: "CONTAINER_STOP_FAILED",
  REMOVE_FAILED: "CONTAINER_REMOVE_FAILED",
  INSPECT_FAILED: "CONTAINER_INSPECT_FAILED",
  CONTAINER_NOT_FOUND: "CONTAINER_NOT_FOUND",
  LOGS_FAILED: "CONTAINER_LOGS_FAILED",
  VOLUME_CREATE_FAILED: "VOLUME_CREATE_FAILED",
  VOLUME_LIST_FAILED: "VOLUME_LIST_FAILED",
  VOLUME_REMOVE_FAILED: "VOLUME_REMOVE_FAILED",
  VOLUME_EXISTS: "VOLUME_EXISTS",
  VOLUME_NOT_FOUND: "VOLUME_NOT_FOUND",
  INVALID_IMAGE: "INVALID_IMAGE_REFERENCE",
  INVALID_BIND: "INVALID_BIND_ADDRESS",
  INVALID_CONTAINER_PORT: "INVALID_CONTAINER_PORT",
  INVALID_ENV_NAME: "INVALID_ENV_NAME",
  INVALID_ENV_VALUE: "INVALID_ENV_VALUE",
  INVALID_VOLUME_MOUNT: "INVALID_VOLUME_MOUNT",
  INVALID_VOLUME_NAME: "INVALID_VOLUME_NAME",
  INVALID_STOP_GRACE: "INVALID_STOP_GRACE",
  INVALID_LOG_OPTION: "INVALID_LOG_OPTION",
} as const;

/** One completed Podman call. */
export interface PodmanCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the executable could not be started, for example `ENOENT`. */
  spawnError?: string;
}

/** Per-call options; every call also receives a finite default timeout. */
export interface PodmanCommandOptions {
  timeoutMs?: number;
}

/**
 * The narrow process-runner surface this module needs. It is structurally
 * satisfied by the shared platform runner, so tests inject a recording fake and
 * production can replace the default runner without changing this module.
 */
export interface PodmanRunner {
  run(
    command: string,
    args: readonly string[],
    options?: PodmanCommandOptions,
  ): PodmanCommandResult | Promise<PodmanCommandResult>;
}

/** The values that define one app container. */
export interface ContainerRunSpec {
  readonly app: string;
  readonly image: string;
  /** Host port published on {@link ContainerRunSpec.bind}. */
  readonly port: number;
  /** Container port; defaults to 3000. */
  readonly containerPort?: number;
  /** Host bind address; defaults to `0.0.0.0`. */
  readonly bind?: string;
  /** Merged inline and secrets-file environment. Values are never echoed. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Volume name to absolute container path, matching the config table. */
  readonly volumes?: Readonly<Record<string, string>>;
}

export interface RunContainerOptions extends ContainerRunSpec {
  runner?: PodmanRunner;
  timeoutMs?: number;
}

export interface StopContainerOptions {
  readonly app: string;
  /** Seconds Podman waits before SIGKILL; omitted means Podman's default. */
  readonly timeSeconds?: number;
  runner?: PodmanRunner;
  timeoutMs?: number;
}

export interface RemoveContainerOptions {
  readonly app: string;
  /** Add `--force`, which removes a running container. */
  readonly force?: boolean;
  /** Treat an already-absent container as success. Defaults to true for cleanup. */
  readonly ignoreMissing?: boolean;
  runner?: PodmanRunner;
  timeoutMs?: number;
}

export interface InspectContainerOptions {
  readonly app: string;
  runner?: PodmanRunner;
  timeoutMs?: number;
}

export interface ContainerLogsOptions {
  readonly app: string;
  /** Follow new output with `-f`; defaults to true. */
  readonly follow?: boolean;
  /** Trailing lines; defaults to {@link DEFAULT_LOGS_TAIL}. */
  readonly tail?: number;
  /** Add `--timestamps`. */
  readonly timestamps?: boolean;
  /** Podman `--since` value, for example `10m` or an RFC 3339 timestamp. */
  readonly since?: string;
  runner?: PodmanRunner;
  timeoutMs?: number;
}

export interface CreateVolumeOptions {
  readonly app: string;
  readonly volume: string;
  /** Add `--ignore` so an existing volume is reused instead of conflicting. */
  readonly ignoreExisting?: boolean;
  runner?: PodmanRunner;
  timeoutMs?: number;
}

export interface ListVolumesOptions {
  /** Restrict the listing to volumes labelled for this app. */
  readonly app?: string;
  runner?: PodmanRunner;
  timeoutMs?: number;
}

export interface RemoveVolumeOptions {
  readonly name: string;
  /** Add `--force`. */
  readonly force?: boolean;
  /** Treat an already-absent volume as success. */
  readonly ignoreMissing?: boolean;
  runner?: PodmanRunner;
  timeoutMs?: number;
}

/** A normalized inspect state block. */
export interface ContainerProcessState {
  readonly status: string;
  readonly running: boolean;
  readonly paused: boolean;
  readonly exitCode: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Podman's state error; already redacted. */
  readonly error?: string;
}

/** One published container port. */
export interface ContainerPortBinding {
  readonly containerPort: number;
  readonly protocol: string;
  readonly hostIp: string;
  readonly hostPort: number;
}

/** One named volume mounted into the container. */
export interface ContainerVolumeMount {
  readonly name: string;
  readonly destination: string;
}

/**
 * The typed inspect view. Environment values are intentionally replaced by
 * {@link ContainerInspect.environmentNames} so this object is safe to render.
 */
export interface ContainerInspect {
  readonly app: string;
  /** Container name without Podman's leading slash. */
  readonly name: string;
  readonly id: string;
  readonly image: string;
  readonly imageId?: string;
  readonly createdAt?: string;
  readonly state: ContainerProcessState;
  readonly restartPolicy?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly ports: readonly ContainerPortBinding[];
  readonly environmentNames: readonly string[];
  readonly volumes: readonly ContainerVolumeMount[];
}

/** One normalized named volume. */
export interface VolumeSummary {
  readonly name: string;
  /** Set when the volume carries an `io.easy-host.app` label. */
  readonly app?: string;
  readonly driver?: string;
  readonly createdAt?: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ContainerRunResult {
  readonly app: string;
  readonly container: string;
  readonly id: string;
  readonly image: string;
  readonly port: number;
  readonly containerPort: number;
  readonly bind: string;
  readonly volumes: readonly string[];
  readonly environmentNames: readonly string[];
}

export interface ContainerStopResult {
  readonly app: string;
  readonly container: string;
  readonly stopped: boolean;
}

export interface ContainerRemoveResult {
  readonly app: string;
  readonly container: string;
  readonly removed: boolean;
}

export interface ContainerLogsResult {
  readonly app: string;
  readonly container: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly followed: boolean;
  readonly tail: number;
}

export interface VolumeCreateResult {
  readonly app: string;
  readonly volume: string;
  readonly name: string;
}

export interface VolumeRemoveResult {
  readonly name: string;
  readonly removed: boolean;
}

/** The canonical container name for an app. */
export function containerName(app: string): string {
  return `${CONTAINER_NAME_PREFIX}${validateAppName(app)}`;
}

/** The canonical volume name for an app's declared volume. */
export function volumeName(app: string, volume: string): string {
  const validatedApp = validateAppName(app);
  validateVolumeKey(volume);

  return `${CONTAINER_NAME_PREFIX}${validatedApp}-${volume}`;
}

/**
 * Formats the `--publish` value. IPv6 bind addresses are bracketed so the
 * colons in the address are not confused with the port separators.
 */
export function publishSpec(bind: string, port: number, containerPort: number): string {
  const host = bind.includes(":") ? `[${bind}]` : bind;
  return `${host}:${port}:${containerPort}`;
}

/**
 * Builds the complete `podman run` argument array. This is pure, so tests and
 * callers can assert the exact command without starting a container.
 *
 * @throws {UsageError} for an invalid app, image, port, bind, environment key,
 *   environment value, or volume mount.
 */
export function podmanRunArguments(spec: ContainerRunSpec): string[] {
  const app = validateAppName(spec.app);
  const container = containerName(app);
  const image = validateImage(spec.image);
  const port = validateDeclaredPort(spec.port);
  const containerPort = validateContainerPort(
    spec.containerPort ?? APP_SPEC_DEFAULTS.container_port,
  );
  const bind = validateBind(spec.bind ?? APP_SPEC_DEFAULTS.bind);
  const environment = normalizeEnvironment(spec.environment, containerPort);
  const volumes = normalizeVolumes(app, spec.volumes);

  return [
    "run",
    "--detach",
    "--name",
    container,
    `--restart=${RESTART_POLICY}`,
    "--publish",
    publishSpec(bind, port, containerPort),
    ...volumes.flatMap(({ name, target }) => ["--volume", `${name}:${target}`]),
    "--label",
    `${APP_LABEL}=${app}`,
    "--label",
    `${ROLE_LABEL}=${APP_ROLE_VALUE}`,
    "--label",
    `${IMAGE_LABEL}=${image}`,
    ...Object.entries(environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    image,
  ];
}

/**
 * Creates and starts the app container. The returned id is Podman's stdout.
 *
 * The merged environment is passed as `--env KEY=VALUE` argument pairs; values
 * never appear in this module's errors or details.
 */
export async function runContainer(options: RunContainerOptions): Promise<ContainerRunResult> {
  const app = validateAppName(options.app);
  const container = containerName(app);
  const image = validateImage(options.image);
  const port = validateDeclaredPort(options.port);
  const containerPort = validateContainerPort(
    options.containerPort ?? APP_SPEC_DEFAULTS.container_port,
  );
  const bind = validateBind(options.bind ?? APP_SPEC_DEFAULTS.bind);
  const environment = normalizeEnvironment(options.environment, containerPort);
  const volumes = normalizeVolumes(app, options.volumes);
  const timeoutMs = normalizeTimeout(options.timeoutMs, PODMAN_RUN_TIMEOUT_MS);
  const runner = options.runner ?? createDefaultPodmanRunner();
  const args = podmanRunArguments(options);
  const secrets = Object.values(environment);
  const result = await invokePodman(runner, args, timeoutMs);

  if (result.spawnError === "ENOENT") {
    throw podmanUnavailableError();
  }

  if (result.spawnError === "ETIMEDOUT") {
    throw podmanTimeoutError(runContext("run", app, timeoutMs, container, secrets));
  }

  if (result.exitCode !== 0 || result.spawnError !== undefined) {
    const reason = summarizePodmanOutput(result, timeoutMs, secrets);
    const details: ErrorDetails = {
      app,
      container,
      image,
      port,
      containerPort,
      bind,
      environmentNames: Object.keys(environment).sort(),
      volumes: volumes.map((entry) => entry.name),
      reason,
      timeoutMs,
    };

    if (isContainerNameConflict(result)) {
      throw new ConflictError(`container "${container}" already exists: ${reason}`, {
        code: PODMAN_FAILURE_CODES.NAME_CONFLICT,
        details,
        remediation: `Remove the existing container with "easy-host remove ${app}", or choose another app name.`,
      });
    }

    if (isPortInUse(result)) {
      throw new ConflictError(`host port ${port} is already in use: ${reason}`, {
        code: PODMAN_FAILURE_CODES.PORT_IN_USE,
        details,
        remediation: `Stop the process using port ${port} or declare another port in config.toml, then retry.`,
      });
    }

    throw new PrerequisiteError(`could not start container "${container}": ${reason}`, {
      code: PODMAN_FAILURE_CODES.RUN_FAILED,
      details,
      remediation: `Run "podman info", check "podman logs ${container}", then run "easy-host doctor".`,
    });
  }

  const id = result.stdout.trim();
  if (id.length === 0) {
    throw new PrerequisiteError(
      `podman reported success but did not return an id for container "${container}"`,
      {
        code: PODMAN_FAILURE_CODES.RUN_FAILED,
        details: { app, container, image, timeoutMs },
        remediation: `Run "podman ps --filter name=${container}" to inspect the container, then run "easy-host doctor".`,
      },
    );
  }

  return {
    app,
    container,
    id,
    image,
    port,
    containerPort,
    bind,
    volumes: volumes.map((entry) => entry.name),
    environmentNames: Object.keys(environment).sort(),
  };
}

/**
 * Stops the app container. `timeSeconds` adds `--time`; omitting it uses
 * Podman's own grace period.
 */
export async function stopContainer(options: StopContainerOptions): Promise<ContainerStopResult> {
  const app = validateAppName(options.app);
  const container = containerName(app);
  const timeoutMs = normalizeTimeout(options.timeoutMs, PODMAN_STOP_TIMEOUT_MS);
  const timeSeconds =
    options.timeSeconds === undefined ? undefined : validateGraceSeconds(options.timeSeconds);
  const runner = options.runner ?? createDefaultPodmanRunner();
  const args = [
    "stop",
    ...(timeSeconds === undefined ? [] : ["--time", String(timeSeconds)]),
    container,
  ];
  const result = await invokePodman(runner, args, timeoutMs);

  if (result.spawnError === "ENOENT") {
    throw podmanUnavailableError();
  }

  if (result.spawnError === "ETIMEDOUT") {
    throw podmanTimeoutError(runContext("stop", app, timeoutMs, container));
  }

  if (result.exitCode !== 0 || result.spawnError !== undefined) {
    const reason = summarizePodmanOutput(result, timeoutMs);
    if (isMissingContainer(result)) {
      throw containerNotFoundError(app, container, reason);
    }

    throw new PrerequisiteError(`could not stop container "${container}": ${reason}`, {
      code: PODMAN_FAILURE_CODES.STOP_FAILED,
      details: { app, container, reason, timeoutMs },
      remediation: `Run "podman ps --filter name=${container}", then run "easy-host doctor".`,
    });
  }

  return { app, container, stopped: true };
}

/**
 * Removes the app container. Cleanup callers use the default
 * `ignoreMissing: true` so a failed add cannot be stuck on an absent container.
 */
export async function removeContainer(
  options: RemoveContainerOptions,
): Promise<ContainerRemoveResult> {
  const app = validateAppName(options.app);
  const container = containerName(app);
  const timeoutMs = normalizeTimeout(options.timeoutMs, PODMAN_REMOVE_TIMEOUT_MS);
  const runner = options.runner ?? createDefaultPodmanRunner();
  const args = ["rm", ...(options.force === true ? ["--force"] : []), container];
  const result = await invokePodman(runner, args, timeoutMs);

  if (result.spawnError === "ENOENT") {
    throw podmanUnavailableError();
  }

  if (result.spawnError === "ETIMEDOUT") {
    throw podmanTimeoutError(runContext("remove", app, timeoutMs, container));
  }

  if (result.exitCode !== 0 || result.spawnError !== undefined) {
    const reason = summarizePodmanOutput(result, timeoutMs);
    if (isMissingContainer(result)) {
      if (options.ignoreMissing !== false) {
        return { app, container, removed: false };
      }

      throw containerNotFoundError(app, container, reason);
    }

    throw new PrerequisiteError(`could not remove container "${container}": ${reason}`, {
      code: PODMAN_FAILURE_CODES.REMOVE_FAILED,
      details: { app, container, reason, timeoutMs },
      remediation: `Run "podman rm --force ${container}", then run "easy-host doctor".`,
    });
  }

  return { app, container, removed: true };
}

/**
 * Inspects the app container and normalizes Podman's JSON into a typed view.
 * Environment values from `Config.Env` are reduced to names.
 *
 * The call is scoped to containers with `podman container inspect`, never the
 * generic `podman inspect`. Generic inspect resolves names across object types
 * and does volume name-prefix matching, so `podman inspect easy-host-<app>`
 * resolves the *retained volume* `easy-host-<app>-data` (exit 0, volume JSON) or
 * fails with `more than one result for volume name ...`. Either way it cannot
 * answer "does this container exist?" (`ADD-FR-03` re-add on a retained volume).
 *
 * An absent container is reported as {@link NotFoundError} (exit 5) for both
 * `no such container` and Podman 5.7's `no such object: "<name>"` wording; every
 * other nonzero exit stays a {@link PrerequisiteError}. A successful exit whose
 * document is not container-shaped (for example a volume document) is also a
 * {@link PrerequisiteError}: an ambiguous result is never reported as an
 * existing *or* an absent container.
 */
export async function inspectContainer(
  options: InspectContainerOptions,
): Promise<ContainerInspect> {
  const app = validateAppName(options.app);
  const container = containerName(app);
  const timeoutMs = normalizeTimeout(options.timeoutMs, PODMAN_INSPECT_TIMEOUT_MS);
  const runner = options.runner ?? createDefaultPodmanRunner();
  const result = await invokePodman(runner, ["container", "inspect", container], timeoutMs);

  if (result.spawnError === "ENOENT") {
    throw podmanUnavailableError();
  }

  if (result.spawnError === "ETIMEDOUT") {
    throw podmanTimeoutError(runContext("inspect", app, timeoutMs, container));
  }

  if (result.exitCode !== 0 || result.spawnError !== undefined) {
    const reason = summarizePodmanOutput(result, timeoutMs);
    if (isMissingInspectTarget(result)) {
      throw containerNotFoundError(app, container, reason);
    }

    throw new PrerequisiteError(`could not inspect container "${container}": ${reason}`, {
      code: PODMAN_FAILURE_CODES.INSPECT_FAILED,
      details: { app, container, reason, timeoutMs },
      remediation: `Run "podman container inspect ${container}", then run "easy-host doctor".`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new PrerequisiteError(
      `podman container inspect returned invalid JSON for "${container}"`,
      {
        code: PODMAN_FAILURE_CODES.INSPECT_FAILED,
        details: { app, container, reason: "invalid JSON", timeoutMs },
        remediation: `Run "podman container inspect ${container}" directly, then run "easy-host doctor".`,
        cause: error,
      },
    );
  }

  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const record = asRecord(entry);
  if (record === undefined) {
    throw new PrerequisiteError(`podman container inspect returned no object for "${container}"`, {
      code: PODMAN_FAILURE_CODES.INSPECT_FAILED,
      details: { app, container, reason: "unexpected JSON shape", timeoutMs },
      remediation: `Run "podman container inspect ${container}" directly, then run "easy-host doctor".`,
    });
  }

  if (!isContainerDocument(record)) {
    throw new PrerequisiteError(
      `podman container inspect returned a non-container object for "${container}"`,
      {
        code: PODMAN_FAILURE_CODES.INSPECT_FAILED,
        details: { app, container, reason: "unexpected document type", timeoutMs },
        remediation: `Run "podman container inspect ${container}" directly, then run "easy-host doctor".`,
      },
    );
  }

  return normalizeInspect(record, app, container);
}

/**
 * Runs `podman logs` and returns the bounded output. Follow defaults to true so
 * the CLI passes through live logs with `-f`, matching ADD-FR-06.
 */
export async function containerLogs(options: ContainerLogsOptions): Promise<ContainerLogsResult> {
  const app = validateAppName(options.app);
  const container = containerName(app);
  const follow = options.follow ?? true;
  const tail = validateTail(options.tail ?? DEFAULT_LOGS_TAIL);
  const since = options.since === undefined ? undefined : validateSince(options.since);
  const timeoutMs = normalizeTimeout(options.timeoutMs, PODMAN_LOGS_TIMEOUT_MS);
  const runner = options.runner ?? createDefaultPodmanRunner();
  const args = [
    "logs",
    ...(follow ? ["-f"] : []),
    "--tail",
    String(tail),
    ...(options.timestamps === true ? ["--timestamps"] : []),
    ...(since === undefined ? [] : ["--since", since]),
    container,
  ];
  const result = await invokePodman(runner, args, timeoutMs);

  if (result.spawnError === "ENOENT") {
    throw podmanUnavailableError();
  }

  if (result.spawnError === "ETIMEDOUT") {
    throw podmanTimeoutError(runContext("logs", app, timeoutMs, container));
  }

  if (result.exitCode !== 0 || result.spawnError !== undefined) {
    const reason = summarizePodmanOutput(result, timeoutMs);
    if (isMissingContainer(result)) {
      throw containerNotFoundError(app, container, reason);
    }

    throw new PrerequisiteError(`could not read logs for container "${container}": ${reason}`, {
      code: PODMAN_FAILURE_CODES.LOGS_FAILED,
      details: { app, container, reason, timeoutMs },
      remediation: `Run "podman logs --tail ${tail} ${container}", then run "easy-host doctor".`,
    });
  }

  return {
    app,
    container,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    followed: follow,
    tail,
  };
}

/**
 * Creates a labelled named volume. Labels scope later deletion to this app
 * (`RBK-FR-04`). Without `ignoreExisting`, an existing volume is a conflict.
 */
export async function createVolume(options: CreateVolumeOptions): Promise<VolumeCreateResult> {
  const app = validateAppName(options.app);
  const name = volumeName(app, options.volume);
  const timeoutMs = normalizeTimeout(options.timeoutMs, PODMAN_VOLUME_TIMEOUT_MS);
  const runner = options.runner ?? createDefaultPodmanRunner();
  const args = [
    "volume",
    "create",
    "--label",
    `${APP_LABEL}=${app}`,
    ...(options.ignoreExisting === true ? ["--ignore"] : []),
    name,
  ];
  const result = await invokePodman(runner, args, timeoutMs);

  if (result.spawnError === "ENOENT") {
    throw podmanUnavailableError();
  }

  if (result.spawnError === "ETIMEDOUT") {
    throw podmanTimeoutError(volumeContext("volume create", app, timeoutMs, name));
  }

  if (result.exitCode !== 0 || result.spawnError !== undefined) {
    const reason = summarizePodmanOutput(result, timeoutMs);
    if (isVolumeExists(result)) {
      throw new ConflictError(`volume "${name}" already exists: ${reason}`, {
        code: PODMAN_FAILURE_CODES.VOLUME_EXISTS,
        details: { app, name, volume: options.volume, reason, timeoutMs },
        remediation: `Reuse the volume or remove it with "podman volume rm ${name}", then retry.`,
      });
    }

    throw new PrerequisiteError(`could not create volume "${name}": ${reason}`, {
      code: PODMAN_FAILURE_CODES.VOLUME_CREATE_FAILED,
      details: { app, name, volume: options.volume, reason, timeoutMs },
      remediation: `Run "podman volume ls", then run "easy-host doctor".`,
    });
  }

  return { app, volume: options.volume, name };
}

/**
 * Lists volumes, optionally filtered to one app's `io.easy-host.app` label.
 * Podman's JSON output accepts both object entries and bare names.
 */
export async function listVolumes(options: ListVolumesOptions = {}): Promise<VolumeSummary[]> {
  const app = options.app === undefined ? undefined : validateAppName(options.app);
  const timeoutMs = normalizeTimeout(options.timeoutMs, PODMAN_VOLUME_TIMEOUT_MS);
  const runner = options.runner ?? createDefaultPodmanRunner();
  const args = [
    "volume",
    "ls",
    ...(app === undefined ? [] : ["--filter", `label=${APP_LABEL}=${app}`]),
    "--format",
    "json",
  ];
  const result = await invokePodman(runner, args, timeoutMs);

  if (result.spawnError === "ENOENT") {
    throw podmanUnavailableError();
  }

  if (result.spawnError === "ETIMEDOUT") {
    throw podmanTimeoutError(volumeContext("volume list", app, timeoutMs));
  }

  if (result.exitCode !== 0 || result.spawnError !== undefined) {
    const reason = summarizePodmanOutput(result, timeoutMs);
    throw new PrerequisiteError(`could not list volumes: ${reason}`, {
      code: PODMAN_FAILURE_CODES.VOLUME_LIST_FAILED,
      details: { ...(app === undefined ? {} : { app }), reason, timeoutMs },
      remediation: `Run "podman volume ls", then run "easy-host doctor".`,
    });
  }

  return parseVolumeList(result.stdout, app);
}

/**
 * Removes one named volume. Callers that need RBK-FR-04 ownership semantics
 * must inspect {@link VolumeSummary.labels} first; this helper removes exactly
 * the name it is given.
 */
export async function removeVolume(options: RemoveVolumeOptions): Promise<VolumeRemoveResult> {
  const name = validateVolumeName(options.name);
  const timeoutMs = normalizeTimeout(options.timeoutMs, PODMAN_VOLUME_TIMEOUT_MS);
  const runner = options.runner ?? createDefaultPodmanRunner();
  const args = ["volume", "rm", ...(options.force === true ? ["--force"] : []), name];
  const result = await invokePodman(runner, args, timeoutMs);

  if (result.spawnError === "ENOENT") {
    throw podmanUnavailableError();
  }

  if (result.spawnError === "ETIMEDOUT") {
    throw podmanTimeoutError(volumeContext("volume remove", undefined, timeoutMs, name));
  }

  if (result.exitCode !== 0 || result.spawnError !== undefined) {
    const reason = summarizePodmanOutput(result, timeoutMs);
    if (isMissingVolume(result)) {
      if (options.ignoreMissing === true) {
        return { name, removed: false };
      }

      throw new NotFoundError(`volume "${name}" does not exist`, {
        code: PODMAN_FAILURE_CODES.VOLUME_NOT_FOUND,
        details: { name, reason, timeoutMs },
        remediation: `Run "podman volume ls" to list existing volumes.`,
      });
    }

    throw new PrerequisiteError(`could not remove volume "${name}": ${reason}`, {
      code: PODMAN_FAILURE_CODES.VOLUME_REMOVE_FAILED,
      details: { name, reason, timeoutMs },
      remediation: `Run "podman volume rm ${name}", then run "easy-host doctor".`,
    });
  }

  return { name, removed: true };
}

/**
 * The default runner. It is shell-free, finite-timeout, and bounded in output;
 * tests replace it through {@link PodmanRunner}.
 */
export function createDefaultPodmanRunner(): PodmanRunner {
  return {
    run(command, args, options = {}) {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        timeout: normalizeTimeout(options.timeoutMs, PODMAN_INSPECT_TIMEOUT_MS),
        maxBuffer: 32 * 1024 * 1024,
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

interface PodmanContext {
  operation: string;
  app: string | undefined;
  container: string | undefined;
  volume: string | undefined;
  timeoutMs: number;
  secrets: readonly string[];
}

function runContext(
  operation: string,
  app: string,
  timeoutMs: number,
  container: string,
  secrets: readonly string[] = [],
): PodmanContext {
  return { operation, app, container, volume: undefined, timeoutMs, secrets };
}

function volumeContext(
  operation: string,
  app: string | undefined,
  timeoutMs: number,
  volume?: string,
): PodmanContext {
  return { operation, app, container: undefined, volume, timeoutMs, secrets: [] };
}

async function invokePodman(
  runner: PodmanRunner,
  args: readonly string[],
  timeoutMs: number,
): Promise<PodmanCommandResult> {
  try {
    return await Promise.resolve(runner.run(PODMAN_BINARY, args, { timeoutMs }));
  } catch (error) {
    throw new PrerequisiteError(`could not start podman: ${messageOf(error)}`, {
      code: PODMAN_FAILURE_CODES.UNAVAILABLE,
      details: { binary: PODMAN_BINARY, reason: messageOf(error), timeoutMs },
      remediation:
        "Install rootless Podman 5.7.0-5.8.x, ensure `podman` is on PATH, then run `easy-host doctor`.",
      cause: error,
    });
  }
}

/**
 * Fail-closed guard: a document is only treated as a container when it carries a
 * container id and a `State` block. Generic `podman inspect` can resolve a
 * differently-typed object with the same name prefix (a volume document has
 * `Name`, `Driver`, `Mountpoint`, and no `State`/`Config`), and that must never
 * be reported as an existing container.
 */
function isContainerDocument(entry: Record<string, unknown>): boolean {
  if (asRecord(entry.State) === undefined) {
    return false;
  }

  const id = stringOf(entry.Id) ?? stringOf(entry.ID);
  if (id === undefined || id.length === 0) {
    return false;
  }

  // Belt and braces: reject a volume-shaped document even if a future runtime
  // were to add unrelated keys to it.
  return !(
    entry.Config === undefined &&
    (entry.Driver !== undefined || entry.Mountpoint !== undefined)
  );
}

function normalizeInspect(
  entry: Record<string, unknown>,
  app: string,
  fallbackContainer: string,
): ContainerInspect {
  const config = asRecord(entry.Config) ?? {};
  const state = asRecord(entry.State) ?? {};
  const hostConfig = asRecord(entry.HostConfig) ?? {};
  const network = asRecord(entry.NetworkSettings) ?? {};
  const labels = stringRecord(config.Labels);
  const name = stripLeadingSlash(stringOf(entry.Name) ?? fallbackContainer);
  const id = stringOf(entry.Id) ?? stringOf(entry.ID) ?? "";
  const imageId = stringOf(entry.Image);
  const image = stringOf(entry.ImageName) ?? stringOf(config.Image) ?? imageId ?? "unknown";
  const createdAt = stringOf(entry.Created);
  const restartPolicy = stringOf(asRecord(hostConfig.RestartPolicy)?.Name);
  const stateError = stringOf(state.Error);
  const startedAt = stringOf(state.StartedAt);
  const finishedAt = stringOf(state.FinishedAt);

  return {
    app,
    name,
    id,
    image,
    ...(imageId === undefined ? {} : { imageId }),
    ...(createdAt === undefined ? {} : { createdAt }),
    state: {
      status: stringOf(state.Status) ?? "unknown",
      running: booleanOf(state.Running) ?? false,
      paused: booleanOf(state.Paused) ?? false,
      exitCode: numberFromUnknown(state.ExitCode) ?? 0,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      ...(stateError === undefined || stateError.length === 0
        ? {}
        : { error: redactText(stateError) }),
    },
    ...(restartPolicy === undefined ? {} : { restartPolicy }),
    labels,
    ports: normalizePorts(network.Ports ?? hostConfig.PortBindings),
    environmentNames: environmentNamesFrom(config.Env),
    volumes: normalizeMounts(entry.Mounts),
  };
}

function normalizePorts(source: unknown): ContainerPortBinding[] {
  const record = asRecord(source);
  if (record === undefined) {
    return [];
  }

  const ports: ContainerPortBinding[] = [];
  for (const [key, value] of Object.entries(record)) {
    const separator = key.indexOf("/");
    const portText = separator === -1 ? key : key.slice(0, separator);
    const protocol = separator === -1 ? "tcp" : key.slice(separator + 1);
    const containerPort = Number.parseInt(portText, 10);
    if (!Number.isInteger(containerPort)) {
      continue;
    }

    const bindings = Array.isArray(value) ? value : [];
    if (bindings.length === 0) {
      ports.push({ containerPort, protocol, hostIp: "", hostPort: 0 });
      continue;
    }

    for (const binding of bindings) {
      const entry = asRecord(binding);
      if (entry === undefined) {
        continue;
      }

      ports.push({
        containerPort,
        protocol,
        hostIp: stringOf(entry.HostIp) ?? "",
        hostPort: numberFromUnknown(entry.HostPort) ?? 0,
      });
    }
  }

  return ports.sort(
    (left, right) => left.containerPort - right.containerPort || left.hostPort - right.hostPort,
  );
}

function normalizeMounts(source: unknown): ContainerVolumeMount[] {
  if (!Array.isArray(source)) {
    return [];
  }

  const mounts: ContainerVolumeMount[] = [];
  for (const item of source) {
    const entry = asRecord(item);
    if (entry === undefined) {
      continue;
    }

    const type = stringOf(entry.Type);
    if (type !== undefined && type !== "volume") {
      continue;
    }

    const name = stringOf(entry.Name);
    const destination = stringOf(entry.Destination);
    if (name === undefined || destination === undefined) {
      continue;
    }

    mounts.push({ name, destination });
  }

  return mounts.sort((left, right) => left.destination.localeCompare(right.destination));
}

function environmentNamesFrom(source: unknown): string[] {
  if (!Array.isArray(source)) {
    return [];
  }

  const names: string[] = [];
  for (const entry of source) {
    if (typeof entry !== "string") {
      continue;
    }

    const separator = entry.indexOf("=");
    const name = separator === -1 ? entry : entry.slice(0, separator);
    if (name.length > 0) {
      names.push(name);
    }
  }

  return names.sort();
}

function parseVolumeList(stdout: string, app: string | undefined): VolumeSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.length === 0 ? "[]" : stdout);
  } catch (error) {
    throw new PrerequisiteError("podman volume ls returned invalid JSON", {
      code: PODMAN_FAILURE_CODES.VOLUME_LIST_FAILED,
      details: { ...(app === undefined ? {} : { app }), reason: "invalid JSON" },
      remediation: `Run "podman volume ls --format json" directly, then run "easy-host doctor".`,
      cause: error,
    });
  }

  if (parsed === null) {
    return [];
  }

  if (!Array.isArray(parsed)) {
    throw new PrerequisiteError("podman volume ls returned an unexpected JSON shape", {
      code: PODMAN_FAILURE_CODES.VOLUME_LIST_FAILED,
      details: { ...(app === undefined ? {} : { app }), reason: "unexpected JSON shape" },
      remediation: `Run "podman volume ls --format json" directly, then run "easy-host doctor".`,
    });
  }

  const volumes: VolumeSummary[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      volumes.push({ name: item, labels: {} });
      continue;
    }

    const entry = asRecord(item);
    if (entry === undefined) {
      continue;
    }

    const name = stringOf(entry.Name) ?? stringOf(entry.name);
    if (name === undefined) {
      continue;
    }

    const labels = stringRecord(entry.Labels ?? entry.labels);
    const driver = stringOf(entry.Driver ?? entry.driver);
    const createdAt = stringOf(entry.CreatedAt ?? entry.createdAt);
    const owner = labels[APP_LABEL];

    volumes.push({
      name,
      ...(owner === undefined ? {} : { app: owner }),
      ...(driver === undefined ? {} : { driver }),
      ...(createdAt === undefined ? {} : { createdAt }),
      labels,
    });
  }

  return volumes.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
  containerPort: number,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(environment ?? {})) {
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new UsageError(`invalid environment variable name ${JSON.stringify(key)}`, {
        code: PODMAN_FAILURE_CODES.INVALID_ENV_NAME,
        details: { name: key },
        remediation: "Environment variable names must match [A-Za-z_][A-Za-z0-9_]*.",
      });
    }

    if (typeof value !== "string" || value.includes("\u0000")) {
      throw new UsageError(`invalid value for environment variable "${key}"`, {
        code: PODMAN_FAILURE_CODES.INVALID_ENV_VALUE,
        details: { name: key },
        remediation: "Environment values must be strings without NUL bytes.",
      });
    }

    normalized[key] = value;
  }

  // ADD-FR-03: PORT always names the container port, even if the merged
  // environment supplied its own value.
  normalized.PORT = String(containerPort);
  return normalized;
}

function normalizeVolumes(
  app: string,
  volumes: Readonly<Record<string, string>> | undefined,
): Array<{ name: string; target: string }> {
  const entries: Array<{ name: string; target: string }> = [];

  for (const [volume, target] of Object.entries(volumes ?? {})) {
    validateVolumeKey(volume);
    validateContainerPath(volume, target);
    entries.push({ name: volumeName(app, volume), target });
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function validateVolumeKey(volume: string): void {
  if (!VOLUME_NAME_PATTERN.test(volume)) {
    throw new UsageError(`invalid volume name ${JSON.stringify(volume)}`, {
      code: PODMAN_FAILURE_CODES.INVALID_VOLUME_NAME,
      details: { volume: safeValue(volume), pattern: VOLUME_NAME_PATTERN.source },
      remediation: "Volume names must match [a-z0-9][a-z0-9-]{0,31}.",
    });
  }
}

function validateContainerPath(volume: string, target: string): void {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.length > 4096 ||
    CONTROL_CHARACTER_PATTERN.test(target) ||
    !path.posix.isAbsolute(target) ||
    target === "/" ||
    target.split("/").includes("..")
  ) {
    throw new UsageError(`invalid container path for volume "${volume}"`, {
      code: PODMAN_FAILURE_CODES.INVALID_VOLUME_MOUNT,
      details: { volume, reason: "must be an absolute container path other than '/'" },
      remediation: 'Mount volumes at an absolute container path such as "/var/lib/data".',
    });
  }
}

function validateImage(image: string): string {
  if (
    typeof image !== "string" ||
    image.length === 0 ||
    image.length > 512 ||
    CONTROL_CHARACTER_PATTERN.test(image) ||
    /\s/.test(image) ||
    image.startsWith("-") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image)
  ) {
    throw new UsageError("invalid image reference", {
      code: PODMAN_FAILURE_CODES.INVALID_IMAGE,
      details: { image: safeValue(image) },
      remediation:
        "Use the image reference returned by the build, for example localhost/easy-host-<app>:<timestamp>.",
    });
  }

  return image;
}

function validateBind(bind: string): string {
  if (!(BIND_ADDRESSES as readonly string[]).includes(bind)) {
    throw new UsageError(`invalid bind address ${JSON.stringify(bind)}`, {
      code: PODMAN_FAILURE_CODES.INVALID_BIND,
      details: { bind: safeValue(bind), allowed: [...BIND_ADDRESSES] },
      remediation: `Use one of: ${BIND_ADDRESSES.join(", ")}.`,
    });
  }

  return bind;
}

function validateContainerPort(port: number): number {
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < MIN_HOST_PORT ||
    port > MAX_PORT
  ) {
    throw new UsageError(`invalid container port ${String(port)}`, {
      code: PODMAN_FAILURE_CODES.INVALID_CONTAINER_PORT,
      details: { port: safeValue(port), minimum: MIN_HOST_PORT, maximum: MAX_PORT },
      remediation: `Choose a whole-number container port between ${MIN_HOST_PORT} and ${MAX_PORT}.`,
    });
  }

  return port;
}

function validateGraceSeconds(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
    throw new UsageError(`invalid stop grace period ${String(seconds)}`, {
      code: PODMAN_FAILURE_CODES.INVALID_STOP_GRACE,
      details: { seconds: safeValue(seconds) },
      remediation: "Choose a whole number of seconds between 0 and 3600.",
    });
  }

  return seconds;
}

function validateTail(tail: number): number {
  if (!Number.isInteger(tail) || tail < 0 || tail > 1_000_000) {
    throw new UsageError(`invalid log tail ${String(tail)}`, {
      code: PODMAN_FAILURE_CODES.INVALID_LOG_OPTION,
      details: { tail: safeValue(tail) },
      remediation: "Choose a whole number of lines between 0 and 1000000.",
    });
  }

  return tail;
}

function validateSince(since: string): string {
  if (
    typeof since !== "string" ||
    since.length === 0 ||
    since.length > 128 ||
    since.startsWith("-") ||
    CONTROL_CHARACTER_PATTERN.test(since) ||
    /\s/.test(since)
  ) {
    throw new UsageError("invalid log --since value", {
      code: PODMAN_FAILURE_CODES.INVALID_LOG_OPTION,
      details: { since: safeValue(since) },
      remediation: "Use a duration such as 10m or an RFC 3339 timestamp without spaces.",
    });
  }

  return since;
}

function validateVolumeName(name: string): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 255 ||
    name.startsWith("-") ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)
  ) {
    throw new UsageError(`invalid volume name ${JSON.stringify(name)}`, {
      code: PODMAN_FAILURE_CODES.INVALID_VOLUME_NAME,
      details: { volume: safeValue(name) },
      remediation:
        "Volume names must start with a letter or digit and contain only letters, digits, '_', '.', or '-'.",
    });
  }

  return name;
}

function containerNotFoundError(app: string, container: string, reason: string): NotFoundError {
  return new NotFoundError(`container "${container}" does not exist`, {
    code: PODMAN_FAILURE_CODES.CONTAINER_NOT_FOUND,
    details: { app, container, reason },
    remediation: `Run "easy-host list" to confirm the app is registered.`,
  });
}

function podmanUnavailableError(): PrerequisiteError {
  return new PrerequisiteError("the podman executable was not found", {
    code: PODMAN_FAILURE_CODES.UNAVAILABLE,
    details: { binary: PODMAN_BINARY },
    remediation:
      "Install rootless Podman 5.7.0-5.8.x, ensure `podman` is on PATH, then run `easy-host doctor`.",
  });
}

function podmanTimeoutError(context: PodmanContext): PrerequisiteError {
  const subject =
    context.container === undefined
      ? context.volume === undefined
        ? context.operation
        : `${context.operation} for "${context.volume}"`
      : `${context.operation} for "${context.container}"`;

  return new PrerequisiteError(
    `podman ${subject} timed out after ${Math.max(1, Math.round(context.timeoutMs / 1000))}s`,
    {
      code: PODMAN_FAILURE_CODES.TIMEOUT,
      details: contextDetails(context),
      remediation:
        "Run `podman info` and `easy-host doctor` to check the container engine, then retry with EASY_HOST_DEBUG=1 for details.",
    },
  );
}

function contextDetails(context: PodmanContext): ErrorDetails {
  return {
    operation: context.operation,
    ...(context.app === undefined ? {} : { app: context.app }),
    ...(context.container === undefined ? {} : { container: context.container }),
    ...(context.volume === undefined ? {} : { volume: context.volume }),
    timeoutMs: context.timeoutMs,
  };
}

function summarizePodmanOutput(
  result: PodmanCommandResult,
  timeoutMs: number,
  secrets: readonly string[] = [],
): string {
  if (result.spawnError === "ETIMEDOUT") {
    return `timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s`;
  }

  const raw = result.stderr.trim() || result.stdout.trim();
  const fallback =
    result.spawnError !== undefined
      ? `could not start podman (${result.spawnError})`
      : `exit code ${result.exitCode}`;

  if (raw.length === 0) {
    return fallback;
  }

  const tail = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-6)
    .join(" ");

  const redacted = redactText(tail.length > 0 ? tail : fallback, secrets);
  return redacted.length > 600 ? `${redacted.slice(0, 597)}...` : redacted;
}

function isContainerNameConflict(result: PodmanCommandResult): boolean {
  return NAME_CONFLICT_PATTERN.test(outputOf(result));
}

function isPortInUse(result: PodmanCommandResult): boolean {
  return PORT_IN_USE_PATTERN.test(outputOf(result));
}

function isMissingContainer(result: PodmanCommandResult): boolean {
  return MISSING_CONTAINER_PATTERN.test(outputOf(result));
}

/**
 * `podman container inspect` (and generic inspect) on Podman 5.7 reports an
 * absent container as `Error: no such object: "<name>"` (exit 125, stdout `[]`),
 * while `stop`/`rm`/`logs` say `no such container`. The pattern stays anchored
 * to that exact wording so an unrelated runtime failure is never mistaken for
 * an absent container.
 */
function isMissingInspectTarget(result: PodmanCommandResult): boolean {
  return isMissingContainer(result) || MISSING_INSPECT_PATTERN.test(outputOf(result));
}

function isVolumeExists(result: PodmanCommandResult): boolean {
  return VOLUME_EXISTS_PATTERN.test(outputOf(result));
}

function isMissingVolume(result: PodmanCommandResult): boolean {
  return MISSING_VOLUME_PATTERN.test(outputOf(result));
}

function outputOf(result: PodmanCommandResult): string {
  return `${result.stderr}\n${result.stdout}`;
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record === undefined) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }

  return result;
}

function stripLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function safeValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }

  return String(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is intentional input hardening.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const NAME_CONFLICT_PATTERN =
  /container name .* is already in use|name .* is already in use|the container name .* is already in use/i;
const PORT_IN_USE_PATTERN =
  /address already in use|port is already allocated|failed to bind host port|bind for .* port is already allocated/i;
const MISSING_CONTAINER_PATTERN =
  /no such container|no container with name or id|container .* (?:does not exist|not found)/i;
const MISSING_INSPECT_PATTERN = /no such object: "[^"]*"/i;
const VOLUME_EXISTS_PATTERN = /volume .* already exists|volume already exists/i;
const MISSING_VOLUME_PATTERN = /no such volume|volume .* (?:does not exist|not found)/i;
