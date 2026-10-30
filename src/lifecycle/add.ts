/**
 * `add` orchestration (ADD-FR-01, ADD-FR-05, ADD-FR-07, ADD-NF-01).
 *
 * The add lifecycle is deliberately ordered so a rejected invocation has no
 * side effects:
 *
 * 1. **preflight** — resolve prompts/flags, validate the complete config, check
 *    the app name, port, container name, volume names, and host prerequisites;
 * 2. **allocate** — take the name-allocation lock, re-check the name and port,
 *    then create the app directory and write `config.toml`;
 * 3. **prepare** — clone at the declared ref, or validate a local path in place;
 * 4. **build** — call the builder seam, which wraps the pinned Railpack/BuildKit
 *    layer in production;
 * 5. **create** — create one labelled named volume per declared mount;
 * 6. **start** — run the container with restart=always and the published port;
 * 7. **probe** — bound the readiness probe by the app's startup budget;
 * 8. **persist** — record current image, container id, and the health result.
 *
 * A failed first probe stops and removes only the container, keeps the image
 * and the app directory, records `unhealthy` with the probe reason, and raises
 * `HealthError` (exit 4) carrying the captured log tail and remediation. The
 * app lock is held across every mutation after the directory exists and is
 * released in `finally` on every path.
 *
 * Tests replace the builder, runtime, probe, registry, prompter, workspace
 * preparer, prerequisite check, output, and state factory, so the whole
 * orchestration runs with no Podman, git, network, or terminal.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  ConflictError,
  HealthError,
  NotFoundError,
  PrerequisiteError,
  redactText,
  UsageError,
} from "../cli/errors.js";
import {
  type AddInputValues,
  createClackPrompter,
  type Prompter,
  resolveAddInputs,
} from "../cli/prompts.js";
import { loadEnvironment } from "../config/env.js";
import { assertAppNameAvailable, resolveAppName } from "../config/name.js";
import { validateAppSpec } from "../config/parse.js";
import type { AppSpec } from "../config/schema.js";
import { runDoctor } from "../doctor/index.js";
import {
  formatProbeTarget,
  type ProbeAppSpec,
  type ProbeResult,
  probeApp,
} from "../health/probe.js";
import {
  type BuildOutputSink,
  type BuildWorkspaceOptions,
  buildWorkspace,
} from "../platform/build.js";
import { ensureBuildkit } from "../platform/buildkit.js";
import {
  type PreparedWorkspace,
  type PrepareWorkspaceOptions,
  prepareWorkspace,
} from "../platform/git.js";
import { acquireAppLock, type LockAcquireOptions, withAllocationLock } from "../platform/lock.js";
import { createPaths } from "../platform/paths.js";
import {
  APP_LABEL,
  type ContainerLogsOptions,
  type ContainerLogsResult,
  type ContainerRunResult,
  type CreateVolumeOptions,
  containerLogs,
  containerName,
  createVolume,
  DEFAULT_LOGS_TAIL,
  IMAGE_LABEL,
  inspectContainer,
  type ListVolumesOptions,
  listVolumes,
  type RemoveContainerOptions,
  type RunContainerOptions,
  removeContainer,
  runContainer,
  type StopContainerOptions,
  stopContainer,
  type VolumeSummary,
  volumeName,
} from "../platform/podman.js";
import { resolveRailpack } from "../platform/railpack.js";
import { assertPortAvailableForApp } from "../registry/ports.js";
import { type AppState, StateStore } from "../registry/state.js";
import {
  type AppListEntry,
  type AppRecord,
  type ConfigWriteOptions,
  Registry,
  SECRETS_FILE_MODE,
  writeFileAtomic,
} from "../registry/store.js";

/** Phase labels used by the progress reporter. */
export type AddPhase =
  | "validating"
  | "allocating"
  | "cloning"
  | "building"
  | "preparing"
  | "starting"
  | "probing"
  | "keeping"
  | "stopping"
  | "removing"
  | "recording"
  | "failed";

/** Progress output. It always goes to stderr so stdout stays scriptable. */
export interface AddOutput {
  phase(phase: AddPhase, message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

/** A writable stream, narrowed so tests can record progress. */
export interface AddOutputStream {
  write(chunk: string): unknown;
}

/** The state-root layout `add` needs. `Paths` satisfies it. */
export interface AddPaths {
  readonly root: string;
  readonly appsDir: string;
  readonly toolsDir: string;
  readonly buildkitDir: string;
  appDir(name: string): string;
  ensureLayout(): unknown;
}

/** The registry operations `add` performs. `Registry` satisfies it. */
export interface AddRegistry {
  list(): readonly AppListEntry[];
  exists(name: string): boolean;
  create(name: string): AppRecord;
  writeConfig(name: string, spec: AppSpec, options?: ConfigWriteOptions): AppRecord;
}

/** One image build, through the builder interface owned by the build layer. */
export interface AddBuildRequest {
  readonly app: string;
  readonly workspace: string;
  readonly stateRoot: string;
  readonly stderr?: BuildOutputSink;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AddBuildResult {
  readonly image: string;
  readonly durationMs?: number;
  readonly railpackVersion?: string;
}

export interface AddBuilder {
  build(request: AddBuildRequest): Promise<AddBuildResult>;
}

/**
 * The container and volume operations `add` performs. Every method is optional-
 * free so a fake runtime used by tests exercises exactly the real call order.
 */
export interface AddRuntime {
  inspectContainer(options: { readonly app: string }): Promise<unknown>;
  createVolume(options: CreateVolumeOptions): Promise<unknown>;
  listVolumes(options?: ListVolumesOptions): Promise<readonly VolumeSummary[]>;
  runContainer(options: RunContainerOptions): Promise<ContainerRunResult>;
  stopContainer(options: StopContainerOptions): Promise<unknown>;
  removeContainer(options: RemoveContainerOptions): Promise<unknown>;
  containerLogs(options: ContainerLogsOptions): Promise<ContainerLogsResult>;
}

export interface AddProber {
  probe(spec: ProbeAppSpec): Promise<ProbeResult>;
}

export interface AddPrerequisites {
  check(): void | Promise<void>;
}

/** Workspace preparation seam; production uses the git adapter. */
export interface AddWorkspace {
  prepare(options: PrepareWorkspaceOptions): Promise<PreparedWorkspace>;
}

export interface AddDependencies {
  readonly paths: AddPaths;
  readonly registry: AddRegistry;
  readonly builder: AddBuilder;
  readonly runtime: AddRuntime;
  readonly prober: AddProber;
  readonly prerequisites: AddPrerequisites;
  readonly prompter: Prompter;
  readonly workspace: AddWorkspace;
  readonly output: AddOutput;
  readonly stateStore: (appDir: string) => StateStore;
  readonly buildStderr?: BuildOutputSink;
  readonly environment?: NodeJS.ProcessEnv;
  readonly clock?: () => Date;
  readonly lock?: LockAcquireOptions;
}

export type AddDependencyOverrides = Partial<AddDependencies>;

/** Raw `add` inputs, before prompting and validation. */
export interface AddRequest extends AddInputValues {
  /** Repeated `--volume <name:container-path>` values. */
  readonly volume?: string | readonly string[];
  /** `--yes`: script the command without prompts. */
  readonly yes?: boolean;
  /** Test/programmatic override for terminal detection. */
  readonly interactive?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

/** The outcome of a healthy add. */
export interface AddResult {
  readonly app: string;
  readonly container: string;
  readonly image: string;
  readonly previousImage: null;
  readonly port: number;
  readonly bind: string;
  readonly healthPath: string;
  readonly url: string;
  readonly workspace: string;
  readonly mode: PreparedWorkspace["mode"];
  readonly devOnly: boolean;
  readonly repo?: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly volumes: readonly string[];
  readonly health: ProbeResult;
  readonly state: AppState | null;
  readonly warnings: readonly string[];
}

interface AddContext {
  readonly spec: AppSpec;
  readonly app: string;
  readonly record: AppRecord;
  readonly dependencies: AddDependencies;
  readonly environment: NodeJS.ProcessEnv;
  readonly clock: () => Date;
}

/** Default progress reporter: plain text on stderr, no ANSI escapes. */
export function createDefaultAddOutput(stream: AddOutputStream = process.stderr): AddOutput {
  return {
    phase(phase, message) {
      stream.write(`add: ${phase}: ${message}\n`);
    },
    info(message) {
      stream.write(`add: ${message}\n`);
    },
    warn(message) {
      stream.write(`add: warning: ${message}\n`);
    },
  };
}

/**
 * The production builder: resolve the verified Railpack binary, ensure the
 * managed rootless buildkitd, then build through `buildWorkspace`. Railpack and
 * BuildKit acquisition stay in their owning modules.
 */
export function createDefaultAddBuilder(options: {
  readonly paths: AddPaths;
  readonly environment?: NodeJS.ProcessEnv;
  readonly stderr?: BuildOutputSink;
}): AddBuilder {
  return {
    async build(request) {
      const railpack = await resolveRailpack({
        paths: options.paths,
        ...(options.environment === undefined ? {} : { env: options.environment }),
      });
      const daemon = await ensureBuildkit({ paths: options.paths });
      const buildOptions: BuildWorkspaceOptions = {
        app: request.app,
        workspace: request.workspace,
        railpackBinaryPath: railpack.path,
        buildkitHost: daemon.buildkitHost,
        stateRoot: request.stateRoot,
        ...(request.stderr === undefined ? {} : { stderr: request.stderr }),
        ...(options.environment === undefined ? {} : { env: options.environment }),
      };
      const result = await buildWorkspace(buildOptions);

      return {
        image: result.image,
        durationMs: result.durationMs,
        ...(railpack.version === undefined ? {} : { railpackVersion: railpack.version }),
      };
    },
  };
}

/** The production runtime: the Podman adapter, unchanged. */
export function createDefaultAddRuntime(): AddRuntime {
  return {
    inspectContainer,
    createVolume,
    listVolumes,
    runContainer,
    stopContainer,
    removeContainer,
    containerLogs,
  };
}

/** The production probe: the bounded HTTP/TCP health probe. */
export function createDefaultAddProber(): AddProber {
  return {
    probe: (spec) => probeApp(spec),
  };
}

/**
 * Host checks that `add` provisions itself. Railpack is downloaded on the
 * first build and the managed buildkitd is started by the builder, so a fresh
 * host whose tools directory is empty is still a valid `add` target. The
 * remaining doctor checks (Podman, rootless mode, lingering, git, Node, disk)
 * are real prerequisites that cannot be repaired by the add operation.
 */
const PROVISIONED_CHECK_IDS: ReadonlySet<string> = new Set(["railpack", "buildkit"]);

/**
 * The production prerequisite check. It runs the ordered doctor checks and
 * fails with exit 2 on the first hard failure that `add` cannot provision,
 * naming the check and carrying doctor's remediation. Warnings (for example a
 * disabled linger) do not block add.
 */
export function createDoctorPrerequisites(
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): AddPrerequisites {
  return {
    check() {
      const report = runDoctor(options.env === undefined ? {} : { env: options.env });
      const failed = report.checks.find(
        (check) => check.status === "fail" && !PROVISIONED_CHECK_IDS.has(check.id),
      );

      if (failed === undefined) {
        return;
      }

      throw new PrerequisiteError(
        `host prerequisite check "${failed.id}" failed: ${failed.detail}`,
        {
          code: "PREREQUISITE_CHECK_FAILED",
          details: { check: failed.id, reason: failed.detail },
          remediation:
            failed.remediation ?? `Run "easy-host doctor" to inspect the host prerequisites.`,
        },
      );
    },
  };
}

/**
 * Runs the complete add transition.
 *
 * Preflight performs only reads: config validation, name/port checks, a
 * container-name inspect, the prerequisite check, and a volume-ownership check.
 * The first filesystem creation happens after all of them pass.
 */
export async function addApp(
  request: AddRequest = {},
  overrides: AddDependencyOverrides = {},
): Promise<AddResult> {
  const environment = overrides.environment ?? request.environment ?? process.env;
  const clock = overrides.clock ?? (() => new Date());
  const dependencies = resolveDependencies(overrides, environment, clock);
  const { paths, registry, runtime, output } = dependencies;

  output.phase("validating", "checking inputs, config, name, port, and host prerequisites");

  const values = await resolveAddInputs(request, {
    prompter: dependencies.prompter,
    ...(request.yes === undefined ? {} : { yes: request.yes }),
    ...(request.interactive === undefined ? {} : { interactive: request.interactive }),
  });
  const spec = specFrom(values, request.volume);
  const source = spec.repo ?? spec.local_path;
  const app = resolveAppName({
    ...(source === undefined ? {} : { source }),
    ...(values.name === undefined ? {} : { name: values.name }),
  });

  assertAppNameAvailable(app, paths);
  assertPortAvailableForApp(spec.port, registry.list(), { app });
  await assertContainerNameFree(app, runtime);
  await dependencies.prerequisites.check();
  await assertVolumeNamesAvailable(app, spec.volumes, runtime);

  // Every preflight check passed; only now does the first mutation happen.
  paths.ensureLayout();

  output.phase("allocating", `creating the app directory for "${app}"`);
  const record = withAllocationLock(
    paths.appsDir,
    app,
    () => {
      // Re-check inside the allocation lock so two concurrent adds cannot both
      // observe a free name or port.
      assertAppNameAvailable(app, paths);
      assertPortAvailableForApp(spec.port, registry.list(), { app });

      const created = registry.create(app);
      registry.writeConfig(app, spec);
      return created;
    },
    dependencies.lock ?? {},
  );

  const lock = acquireAppLock(record.directory, {
    operation: "add",
    ...(dependencies.lock ?? {}),
  });

  try {
    return await addWhileLocked({
      spec,
      app,
      record,
      dependencies,
      environment,
      clock,
    });
  } finally {
    lock.release();
  }
}

async function addWhileLocked(context: AddContext): Promise<AddResult> {
  const { spec, app, record, dependencies, environment, clock } = context;
  const { builder, runtime, prober, output } = dependencies;
  const warnings: string[] = [];

  ensureDeclaredEnvFile(record.directory, spec, output);
  const containerEnvironment = loadEnvironment(record.directory, spec);

  const sourceDescription =
    spec.local_path === undefined
      ? `cloning ${redactText(spec.repo ?? "")} at ${spec.ref}`
      : `validating local path "${spec.local_path}"`;
  output.phase("cloning", sourceDescription);

  let prepared: PreparedWorkspace;
  try {
    prepared = await dependencies.workspace.prepare({
      app,
      appDir: record.directory,
      ...(spec.repo === undefined ? {} : { repo: spec.repo }),
      ...(spec.local_path === undefined ? {} : { localPath: spec.local_path }),
      ref: spec.ref,
      env: environment,
    });
  } catch (error) {
    output.phase("failed", "workspace preparation failed; the app entry is kept for a retry");
    throw error;
  }

  if (prepared.devOnly) {
    const message = `local mode is dev-only: "${prepared.workspace}" is used in place and is not tracked by easy-host`;
    warnings.push(message);
    output.warn(message);
  }

  output.phase("building", `building an image from "${prepared.workspace}"`);
  let built: AddBuildResult;
  try {
    built = await builder.build({
      app,
      workspace: prepared.workspace,
      stateRoot: dependencies.paths.root,
      ...(dependencies.buildStderr === undefined ? {} : { stderr: dependencies.buildStderr }),
      ...(dependencies.environment === undefined ? {} : { env: dependencies.environment }),
    });
  } catch (error) {
    output.phase("failed", "image build failed; no container or volume was created");
    throw error;
  }

  const declaredVolumes = Object.keys(spec.volumes);
  const volumeNames: string[] = [];

  if (declaredVolumes.length > 0) {
    output.phase("preparing", `creating ${declaredVolumes.length} named volume(s)`);
    for (const volume of declaredVolumes) {
      await runtime.createVolume({ app, volume, ignoreExisting: true });
      volumeNames.push(volumeName(app, volume));
    }
  }

  output.phase("starting", `starting container "${containerName(app)}" from ${built.image}`);
  let run: ContainerRunResult;
  try {
    run = await runtime.runContainer({
      app,
      image: built.image,
      port: spec.port,
      containerPort: spec.container_port,
      bind: spec.bind,
      environment: containerEnvironment.values,
      volumes: spec.volumes,
    });
  } catch (error) {
    output.phase(
      "failed",
      "the container did not start; checking for a partial container to remove",
    );
    await removePartiallyCreatedContainer(runtime, app, built.image, output, warnings);
    throw error;
  }

  const target = formatProbeTarget(spec.probe, spec.port, spec.health_path);
  output.phase("probing", `probing ${target} for up to ${spec.health_startup_ms}ms`);
  let health: ProbeResult;
  try {
    health = await prober.probe(spec);
  } catch (error) {
    // The bounded probe reports an unhealthy result instead of throwing, but a
    // programming or option error must still never leave a restarting container
    // behind (ADD-FR-05).
    output.phase("failed", "the readiness probe could not run; removing the container");
    await readContainerLogs(runtime, app, containerEnvironment.values, output, warnings);
    await removeContainerOnly(runtime, app, output, warnings);
    recordProbeFailureState(dependencies, record, built.image, error, clock, output, warnings);

    throw error;
  }

  if (!health.healthy) {
    throw await failHealth({
      app,
      record,
      built,
      run,
      health,
      containerEnvironment,
      dependencies,
      output,
      clock,
      warnings,
      volumeNames,
    });
  }

  output.phase("recording", "recording the healthy state");
  let state: AppState | null = null;
  try {
    state = dependencies.stateStore(record.directory).update({
      images: { current: built.image, previous: null },
      containerId: run.id,
      health: {
        status: "healthy",
        checkedAt: clock().toISOString(),
        detail: `probe ${health.target} healthy after ${health.attempts} attempt(s)`,
      },
    });
  } catch (error) {
    const message = `could not persist state.json: ${messageOf(error)}`;
    warnings.push(message);
    output.warn(message);
  }

  output.phase("keeping", `healthy; current image is ${built.image}`);

  return {
    app,
    container: containerName(app),
    image: built.image,
    previousImage: null,
    port: spec.port,
    bind: spec.bind,
    healthPath: spec.health_path,
    url: `http://localhost:${spec.port}${spec.health_path}`,
    workspace: prepared.workspace,
    mode: prepared.mode,
    devOnly: prepared.devOnly,
    ...(prepared.repo === undefined ? {} : { repo: prepared.repo }),
    ...(prepared.ref === undefined ? {} : { ref: prepared.ref }),
    ...(prepared.commit === undefined ? {} : { commit: prepared.commit }),
    volumes: volumeNames,
    health,
    state,
    warnings,
  };
}

interface FailHealthContext {
  readonly app: string;
  readonly record: AppRecord;
  readonly built: AddBuildResult;
  readonly run: ContainerRunResult;
  readonly health: ProbeResult;
  readonly containerEnvironment: ReturnType<typeof loadEnvironment>;
  readonly dependencies: AddDependencies;
  readonly output: AddOutput;
  readonly clock: () => Date;
  readonly warnings: string[];
  readonly volumeNames: readonly string[];
}

async function failHealth(context: FailHealthContext): Promise<HealthError> {
  const {
    app,
    record,
    built,
    run,
    health,
    containerEnvironment,
    dependencies,
    output,
    clock,
    warnings,
    volumeNames,
  } = context;
  const reason =
    health.lastError?.message ??
    (health.lastStatus === undefined
      ? "no successful probe within the startup budget"
      : `HTTP ${health.lastStatus}`);

  output.phase("stopping", `health check failed for "${app}": ${reason}`);
  const logs = await readContainerLogs(
    dependencies.runtime,
    app,
    containerEnvironment.values,
    output,
    warnings,
  );
  await removeContainerOnly(dependencies.runtime, app, output, warnings);

  let stateRecorded = true;
  try {
    dependencies.stateStore(record.directory).update({
      images: { current: built.image, previous: null },
      containerId: null,
      health: {
        status: "unhealthy",
        checkedAt: clock().toISOString(),
        detail: `probe ${health.target} failed: ${reason}`,
      },
    });
  } catch (error) {
    stateRecorded = false;
    const message = `could not record the unhealthy state: ${messageOf(error)}`;
    warnings.push(message);
    output.warn(message);
  }

  output.phase("removing", "container removed; image and app entry kept");

  return new HealthError(`health check failed for "${app}"`, {
    code: "HEALTH_CHECK_FAILED",
    details: {
      app,
      probe: health.target,
      budget: `${health.startupMs}ms`,
      interval: `${health.intervalMs}ms`,
      attempts: health.attempts,
      reason,
      previous: "none (first version)",
      image: built.image,
      container: run.container,
      state: stateRecorded ? "unhealthy" : "unhealthy (state.json not recorded)",
      volumes: [...volumeNames],
      ...(logs === undefined ? {} : { logs }),
      ...(warnings.length === 0 ? {} : { warnings: warnings.join("; ") }),
    },
    remediation: `Fix the app so it answers on ${health.target}, then retry with "easy-host update ${app}". Edit the configuration with "easy-host config ${app} --edit". The image ${built.image} is kept.`,
  });
}

function recordProbeFailureState(
  dependencies: AddDependencies,
  record: AppRecord,
  image: string,
  error: unknown,
  clock: () => Date,
  output: AddOutput,
  warnings: string[],
): void {
  try {
    dependencies.stateStore(record.directory).update({
      images: { current: image, previous: null },
      containerId: null,
      health: {
        status: "unhealthy",
        checkedAt: clock().toISOString(),
        detail: `probe failed to run: ${messageOf(error)}`,
      },
    });
  } catch (recordError) {
    const message = `could not record the unhealthy state: ${messageOf(recordError)}`;
    warnings.push(message);
    output.warn(message);
  }
}

function resolveDependencies(
  overrides: AddDependencyOverrides,
  environment: NodeJS.ProcessEnv,
  clock: () => Date,
): AddDependencies {
  const paths = overrides.paths ?? createPaths({ env: environment });
  const builder =
    overrides.builder ??
    createDefaultAddBuilder({
      paths,
      environment,
      ...(overrides.buildStderr === undefined ? {} : { stderr: overrides.buildStderr }),
    });

  return {
    paths,
    registry: overrides.registry ?? new Registry(paths),
    builder,
    runtime: overrides.runtime ?? createDefaultAddRuntime(),
    prober: overrides.prober ?? createDefaultAddProber(),
    prerequisites: overrides.prerequisites ?? createDoctorPrerequisites({ env: environment }),
    prompter: overrides.prompter ?? createClackPrompter({ env: environment }),
    workspace: overrides.workspace ?? { prepare: prepareWorkspace },
    output: overrides.output ?? createDefaultAddOutput(),
    stateStore: overrides.stateStore ?? ((appDir) => new StateStore(appDir, { clock })),
    ...(overrides.buildStderr === undefined ? {} : { buildStderr: overrides.buildStderr }),
    environment,
    clock,
    ...(overrides.lock === undefined ? {} : { lock: overrides.lock }),
  };
}

function specFrom(
  values: Awaited<ReturnType<typeof resolveAddInputs>>,
  volumeFlags: string | readonly string[] | undefined,
): AppSpec {
  const volumes = parseVolumeFlags(volumeFlags);
  const input: Record<string, unknown> = {
    ...(values.repo === undefined ? { local_path: values.localPath } : { repo: values.repo }),
    ref: values.ref,
    port: values.port,
    container_port: values.containerPort,
    bind: values.bind,
    probe: values.probe,
    health_path: values.healthPath,
    ...(values.envFile === undefined ? {} : { env_file: values.envFile }),
  };

  if (Object.keys(volumes).length > 0) {
    input.volumes = volumes;
  }

  return validateAppSpec(input, { file: "easy-host add" });
}

function parseVolumeFlags(
  volumeFlags: string | readonly string[] | undefined,
): Record<string, string> {
  if (volumeFlags === undefined) {
    return {};
  }

  const entries = typeof volumeFlags === "string" ? [volumeFlags] : volumeFlags;
  const volumes: Record<string, string> = {};

  for (const entry of entries) {
    const text = entry.trim();
    const separator = text.indexOf(":");
    const name = separator < 0 ? "" : text.slice(0, separator).trim();
    const containerPath = separator < 0 ? "" : text.slice(separator + 1).trim();

    if (name.length === 0 || containerPath.length === 0) {
      throw new UsageError(`invalid --volume value ${JSON.stringify(text)}`, {
        code: "INVALID_VOLUME_FLAG",
        details: { flag: "--volume", received: safeValue(text) },
        remediation:
          'Use "--volume <name>:<container-path>", for example --volume data:/var/lib/data.',
      });
    }

    if (volumes[name] !== undefined) {
      throw new UsageError(`volume "${name}" was declared more than once with --volume`, {
        code: "DUPLICATE_VOLUME",
        details: { flag: "--volume", volume: name },
        remediation: "Declare each named volume once.",
      });
    }

    volumes[name] = containerPath;
  }

  return volumes;
}

async function assertContainerNameFree(app: string, runtime: AddRuntime): Promise<void> {
  try {
    await runtime.inspectContainer({ app });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return;
    }

    throw error;
  }

  throw new ConflictError(`container "${containerName(app)}" already exists for app "${app}"`, {
    code: "CONTAINER_NAME_CONFLICT",
    details: { app, container: containerName(app) },
    remediation: `Remove the existing container with "easy-host remove ${app}", or choose another app name with --name.`,
  });
}

async function assertVolumeNamesAvailable(
  app: string,
  volumes: Readonly<Record<string, string>>,
  runtime: AddRuntime,
): Promise<void> {
  const declared = Object.keys(volumes);
  if (declared.length === 0) {
    return;
  }

  const existing = await runtime.listVolumes();
  const byName = new Map(existing.map((volume) => [volume.name, volume]));

  for (const volume of declared) {
    const name = volumeName(app, volume);
    const found = byName.get(name);

    if (found !== undefined && found.labels[APP_LABEL] !== app) {
      throw new ConflictError(`volume "${name}" already exists and is not owned by app "${app}"`, {
        code: "VOLUME_NAME_CONFLICT",
        details: { app, volume, volumeName: name },
        remediation: `Remove "${name}" with "podman volume rm ${name}", or declare a different volume name.`,
      });
    }
  }
}

async function removePartiallyCreatedContainer(
  runtime: AddRuntime,
  app: string,
  image: string,
  output: AddOutput,
  warnings: string[],
): Promise<void> {
  try {
    const inspected = await runtime.inspectContainer({ app });
    const labels = labelsOf(inspected);

    if (labels[APP_LABEL] !== app || labels[IMAGE_LABEL] !== image) {
      warnings.push(
        `left container "${containerName(app)}" in place because it is not owned by this add`,
      );
      return;
    }
  } catch (error) {
    if (error instanceof NotFoundError) {
      return;
    }

    const message = `could not verify ownership of container "${containerName(app)}": ${messageOf(error)}`;
    warnings.push(message);
    output.warn(message);
    return;
  }

  await removeContainerOnly(runtime, app, output, warnings);
}

async function removeContainerOnly(
  runtime: AddRuntime,
  app: string,
  output: AddOutput,
  warnings: string[],
): Promise<void> {
  output.phase("stopping", `stopping container "${containerName(app)}"`);
  try {
    await runtime.stopContainer({ app, timeSeconds: 10 });
  } catch (error) {
    const message = `could not stop container "${containerName(app)}": ${messageOf(error)}`;
    warnings.push(message);
    output.warn(message);
  }

  output.phase("removing", `removing container "${containerName(app)}"`);
  try {
    await runtime.removeContainer({ app, force: true, ignoreMissing: true });
  } catch (error) {
    const message = `could not remove container "${containerName(app)}": ${messageOf(error)}`;
    warnings.push(message);
    output.warn(message);
  }
}

async function readContainerLogs(
  runtime: AddRuntime,
  app: string,
  secrets: Readonly<Record<string, string>>,
  output: AddOutput,
  warnings: string[],
): Promise<string | undefined> {
  try {
    const result = await runtime.containerLogs({
      app,
      follow: false,
      tail: DEFAULT_LOGS_TAIL,
    });
    const redacted = redactText(
      `${result.stdout}\n${result.stderr}`.trim(),
      Object.values(secrets),
    ).trim();

    if (redacted.length === 0) {
      return undefined;
    }

    output.info(`container logs (last ${DEFAULT_LOGS_TAIL} lines):\n${redacted}`);
    return redacted;
  } catch (error) {
    const message = `could not read container logs: ${messageOf(error)}`;
    warnings.push(message);
    output.warn(message);
    return undefined;
  }
}

/**
 * Creates an empty secrets file when `env_file` is declared. A fresh app has no
 * way to supply the file yet, and `loadEnvironment` correctly treats a declared
 * but missing file as an error. The file is empty so the operator must add the
 * values; it is never populated from a flag value.
 */
function ensureDeclaredEnvFile(appDir: string, spec: AppSpec, output: AddOutput): void {
  if (spec.env_file === undefined) {
    return;
  }

  const target = path.resolve(appDir, spec.env_file);
  const relative = path.relative(appDir, target);

  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new UsageError(`env_file "${spec.env_file}" must point inside the app directory`, {
      code: "INVALID_ENV_FILE",
      details: { setting: "env_file", file: spec.env_file },
      remediation: "Use a relative env_file without '..' segments, for example secrets.env.",
    });
  }

  if (existsSync(target)) {
    return;
  }

  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileAtomic(target, "", { mode: SECRETS_FILE_MODE });
  output.warn(
    `created empty env file "${target}"; add KEY=VALUE lines before the app can start successfully`,
  );
}

function labelsOf(inspected: unknown): Readonly<Record<string, string>> {
  if (inspected === null || typeof inspected !== "object") {
    return {};
  }

  const labels = (inspected as { labels?: unknown }).labels;
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  return result;
}

function safeValue(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
