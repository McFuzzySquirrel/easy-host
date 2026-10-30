/**
 * `update` orchestration (UPD-FR-01 … UPD-FR-05, UPD-NF-01, UPD-NF-02).
 *
 * One update performs exactly one of three transitions, decided before any
 * container, volume, image, or config file is touched:
 *
 * - **no-op** — the diff found nothing to do and the live container is running
 *   from the recorded image with recorded health. It reports "nothing changed"
 *   and exits 0. For a git-backed app the configured ref is fetched first; a
 *   moved commit turns the no-op into a rebuild instead of silently ignoring
 *   the new source (the PRD's core "update after a push" loop).
 * - **config-only** — only run-time settings changed (or the recorded container
 *   is missing, stopped, or unhealthy). The recorded image is recreated with
 *   the desired settings through the health-gated swap, with no Railpack or
 *   BuildKit invocation (UPD-FR-05). The image pair in `state.json` is left
 *   untouched, so a config-only update never destroys the rollback target. If
 *   the recreated container fails, the previous image restarts with the
 *   previously applied port, bind, volumes, probe, and environment.
 * - **rebuild** — the source or an unknown difference requires a new image.
 *   The workspace is fetched and checked out, the candidate image is built, and
 *   only after a successful build is the old container stopped and swapped. A
 *   build failure therefore leaves the serving version untouched (exit 3).
 *
 * Ordering rules that the implementation keeps:
 *
 * 1. the app name and registry record are resolved, then the per-app lock is
 *    acquired for the entire operation (including the diff), and released in
 *    `finally` on every path;
 * 2. every read-only preflight check — config validation, cross-app port
 *    conflict, volume ownership, secrets-file parsing — runs before the first
 *    mutation (`PRD-NF-03`);
 * 3. `config.toml` is written only after the operation succeeds, and never on a
 *    failed build or a reverted swap; the candidate image is recorded by the
 *    swap itself, only after a healthy probe;
 * 4. the recorded pair is pruned only after a successful transition: retention
 *    keeps exactly the current and previous image and never touches an image
 *    that is in use or shared (`RBK-FR-02`). A retention failure is a warning,
 *    because the app is already serving.
 *
 * Every phase is reported through {@link UpdateOutput} so an operator can tell
 * a slow build from a stuck probe (`UPD-NF-02`). The builder, runtime, probe,
 * workspace source, swap, state writer, output, and clock are injected, so the
 * unit suite exercises every class with no Podman, git, or network.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  ConflictError,
  HealthError,
  NotFoundError,
  PrerequisiteError,
  redactText,
  UsageError,
} from "../cli/errors.js";
import { type ContainerEnvironment, loadEnvironment } from "../config/env.js";
import { validateAppName } from "../config/name.js";
import { validateAppSpec } from "../config/parse.js";
import type { AppSpec, AppSpecInput } from "../config/schema.js";
import {
  formatProbeTarget,
  PROBE_FAILURE_CODES,
  type ProbeAppSpec,
  type ProbeResult,
} from "../health/probe.js";
import type { BuildOutputSink } from "../platform/build.js";
import {
  createDefaultGitRunner,
  GIT_REV_PARSE_TIMEOUT_MS,
  type GitRunner,
  type PreparedWorkspace,
  type PrepareWorkspaceOptions,
  prepareWorkspace,
  workspacePath,
} from "../platform/git.js";
import { acquireAppLock, type LockAcquireOptions } from "../platform/lock.js";
import { createPaths } from "../platform/paths.js";
import {
  APP_LABEL,
  type ContainerRunResult,
  type CreateVolumeOptions,
  containerName,
  createVolume,
  inspectContainer,
  type ListVolumesOptions,
  listVolumes,
  type RunContainerOptions,
  removeContainer,
  runContainer,
  stopContainer,
  type VolumeSummary,
  volumeName,
} from "../platform/podman.js";
import { assertPortAvailableForApp } from "../registry/ports.js";
import { type AppStatePatch, type HealthStatus, StateStore } from "../registry/state.js";
import {
  type AppListEntry,
  type AppRecord,
  type ConfigWriteOptions,
  Registry,
} from "../registry/store.js";
import {
  type AddBuilder,
  type AddBuildRequest,
  type AddBuildResult,
  createDefaultAddBuilder,
} from "./add.js";
import {
  classifyUpdate,
  type UpdateChange,
  type UpdateContainerObservation,
  type UpdateContainerStatus,
  type UpdateDiff,
  type UpdateDiffKind,
  type UpdateRecordedState,
} from "./diff.js";
import { type RetainImages, type RetainOutput, type RetainResult, retainImages } from "./retain.js";
import {
  createDefaultSwapProber,
  type SwapFailure,
  type SwapPhase,
  type SwapProber,
  type SwapRecovery,
  type SwapReporter,
  type SwapResult,
  type SwapRuntime,
  swapApp,
  swapProbeDeadlineMs,
} from "./swap.js";

/** Failed or advisory outcomes reported by the update command. */
export const UPDATE_FAILURE_CODES = {
  INVALID_APP: "INVALID_APP_NAME",
  NO_RECORDED_IMAGE: "UPDATE_NO_RECORDED_IMAGE",
  CANDIDATE_FAILED: "UPDATE_CANDIDATE_FAILED",
  FIRST_START_FAILED: "UPDATE_FIRST_START_FAILED",
  VOLUME_CONFLICT: "VOLUME_NAME_CONFLICT",
} as const;

/** Progress phases. Swap phases are forwarded unchanged by the swap reporter. */
export const UPDATE_PHASES = [
  "validating",
  "locking",
  "inspecting",
  "fetching",
  "building",
  "preparing",
  "stopping",
  "starting",
  "probing",
  "keeping",
  "reverting",
  "reverted",
  "recording",
  "applying-config",
  "skipped",
  "failed",
] as const;

export type UpdatePhase = (typeof UPDATE_PHASES)[number];

/** Progress output. It always goes to stderr so stdout stays scriptable. */
export interface UpdateOutput {
  phase(phase: UpdatePhase, message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

/** A writable stream, narrowed so tests can record progress. */
export interface UpdateOutputStream {
  write(chunk: string): unknown;
}

/** The state-root layout `update` needs. `Paths` satisfies it. */
export interface UpdatePaths {
  readonly root: string;
  readonly appsDir: string;
  readonly toolsDir: string;
  readonly buildkitDir: string;
  appDir(name: string): string;
  ensureLayout(): unknown;
}

/** The registry operations `update` performs. `Registry` satisfies it. */
export interface UpdateRegistry {
  list(): readonly AppListEntry[];
  record(name: string): AppRecord;
  readConfig(name: string): AppSpec;
  writeConfig(name: string, spec: AppSpec, options?: ConfigWriteOptions): AppRecord;
}

/** The container operations `update` performs. The Podman adapter satisfies it. */
export interface UpdateRuntime extends SwapRuntime {
  inspectContainer(options: { readonly app: string }): Promise<unknown>;
  createVolume(options: CreateVolumeOptions): Promise<unknown>;
  listVolumes(options?: ListVolumesOptions): Promise<readonly VolumeSummary[]>;
}

/** The state writer seam. `StateStore` satisfies it. */
export interface UpdateStateStore {
  readCache(): UpdateRecordedState | undefined;
  update(patch: AppStatePatch): unknown;
}

/** A head read used to decide whether a healthy app's source actually moved. */
export interface UpdateSourceHeadRequest {
  readonly app: string;
  readonly appDir: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Workspace preparation plus the optional last-built commit probe. */
export interface UpdateSource {
  prepare(options: PrepareWorkspaceOptions): Promise<PreparedWorkspace>;
  /**
   * The commit currently checked out in the app workspace, or `undefined` when
   * there is no checkout. `undefined` makes a no-op conservative: update
   * rebuilds because it cannot prove the source is unchanged.
   */
  head?(request: UpdateSourceHeadRequest): Promise<string | undefined>;
}

export interface UpdateDependencies {
  readonly paths: UpdatePaths;
  readonly registry: UpdateRegistry;
  readonly runtime: UpdateRuntime;
  readonly builder: AddBuilder;
  readonly prober: SwapProber;
  readonly source: UpdateSource;
  readonly stateStore: (appDir: string) => UpdateStateStore;
  readonly output: UpdateOutput;
  /** The health-gated swap. Defaults to {@link swapApp}; injectable for tests. */
  readonly swap?: typeof swapApp;
  /**
   * Two-image retention after a successful transition (`RBK-FR-02`). Defaults
   * to {@link retainImages}; injected so unit tests never call Podman.
   */
  readonly retain?: RetainImages;
  readonly buildStderr?: BuildOutputSink;
  readonly environment: NodeJS.ProcessEnv;
  readonly clock: () => Date;
  readonly lock?: LockAcquireOptions;
}

export type UpdateDependencyOverrides = Partial<UpdateDependencies>;

/** Raw `update` inputs. */
export interface UpdateRequest {
  readonly app: string;
  /** `--rebuild`: force a build even when the diff says otherwise. */
  readonly rebuild?: boolean;
  /** Partial configuration changes applied over `config.toml`. */
  readonly changes?: Partial<AppSpecInput>;
  /** A complete desired spec; wins over `changes`. */
  readonly desired?: AppSpec;
  readonly environment?: NodeJS.ProcessEnv;
}

/** The executed class of an update. */
export type UpdateKind = UpdateDiffKind;

/** The outcome of one update. */
export interface UpdateResult {
  /** `no-op` for an unchanged healthy app; `updated` after a keep. */
  readonly status: "no-op" | "updated";
  /** The transition that actually ran. */
  readonly kind: UpdateKind;
  readonly app: string;
  readonly container: string;
  /** Image now serving, or the recorded image for a no-op. */
  readonly image: string | null;
  /** Rollback target after the update. */
  readonly previousImage: string | null;
  /** Candidate built or reused by this update; `null` for a no-op. */
  readonly candidateImage: string | null;
  readonly containerId: string | null;
  readonly port: number;
  readonly bind: string;
  readonly healthPath: string;
  readonly url: string;
  /** Probe result from a swap; `null` for a no-op. */
  readonly health: ProbeResult | null;
  /** Health last recorded in `state.json`, or `null` when it is missing. */
  readonly recordedHealth: HealthStatus | null;
  readonly containerState: UpdateContainerStatus;
  /** Detected differences, in the diff's deterministic order. */
  readonly changes: readonly UpdateChange[];
  /** Work that this class deliberately did not do, for the operator report. */
  readonly skipped: readonly string[];
  /** True when `config.toml` was rewritten with the desired settings. */
  readonly configApplied: boolean;
  /** True when `state.json` was written by this update. */
  readonly stateRecorded: boolean;
  /** True when a no-op became a rebuild because the configured ref moved. */
  readonly sourceChanged: boolean;
  readonly phases: readonly UpdatePhase[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
  readonly diff: UpdateDiff;
  readonly repo?: string;
  readonly ref?: string;
  readonly commit?: string;
}

interface UpdateContext {
  readonly app: string;
  readonly record: AppRecord;
  readonly current: AppSpec;
  readonly desired: AppSpec;
  readonly dependencies: UpdateDependencies;
  readonly environment: NodeJS.ProcessEnv;
  readonly clock: () => Date;
  readonly output: UpdateOutput;
  readonly phases: UpdatePhase[];
  readonly warnings: string[];
  /** The environment the current container was started with, when readable. */
  readonly currentEnvironment: ContainerEnvironment | undefined;
  readonly desiredEnvironment: ContainerEnvironment;
  readonly state: UpdateStateStore;
  readonly observation: UpdateContainerSnapshot | null;
  readonly diff: UpdateDiff;
}

/** A narrowed inspect view; `ContainerInspect` satisfies it structurally. */
interface UpdateContainerSnapshot {
  readonly id: string | null;
  readonly image: string | null;
  readonly running: boolean;
}

/** Default progress reporter: plain text on stderr, no ANSI escapes. */
export function createDefaultUpdateOutput(
  stream: UpdateOutputStream = process.stderr,
): UpdateOutput {
  return {
    phase(phase, message) {
      stream.write(`update: ${phase}: ${message}\n`);
    },
    info(message) {
      stream.write(`update: ${message}\n`);
    },
    warn(message) {
      stream.write(`update: warning: ${message}\n`);
    },
  };
}

/** The production runtime: the Podman adapter, unchanged. */
export function createDefaultUpdateRuntime(): UpdateRuntime {
  return {
    inspectContainer,
    createVolume,
    listVolumes,
    stopContainer,
    removeContainer,
    runContainer,
  };
}

/**
 * The production source: the git workspace preparer plus a read-only HEAD probe
 * through the shared {@link GitRunner}. The HEAD probe never mutates the
 * checkout; `prepare` owns fetch and checkout.
 */
export function createDefaultUpdateSource(
  options: { readonly environment?: NodeJS.ProcessEnv; readonly runner?: GitRunner } = {},
): UpdateSource {
  const runner = options.runner ?? createDefaultGitRunner();

  return {
    prepare: prepareWorkspace,
    async head(request) {
      const workspace = workspacePath(request.appDir);
      if (!existsSync(workspace)) {
        return undefined;
      }

      const result = await runner.run("git", ["-C", workspace, "rev-parse", "--verify", "HEAD"], {
        timeoutMs: GIT_REV_PARSE_TIMEOUT_MS,
        env: request.environment ?? options.environment ?? process.env,
      });

      if (result.spawnError !== undefined || result.exitCode !== 0) {
        return undefined;
      }

      const commit = result.stdout.trim();
      return commit.length > 0 ? commit : undefined;
    },
  };
}

/**
 * Runs one update.
 *
 * The registry record is resolved first (a missing app exits 5 before a lock is
 * taken). The per-app lock is then held across the config read, the diff, and
 * every mutation, so a concurrent `update`, `rollback`, or `remove` on the same
 * app fails with exit 6 before touching anything.
 */
export async function updateApp(
  request: UpdateRequest,
  overrides: UpdateDependencyOverrides = {},
): Promise<UpdateResult> {
  if (typeof request.app !== "string" || request.app.trim().length === 0) {
    throw new UsageError("update requires an app name", {
      code: UPDATE_FAILURE_CODES.INVALID_APP,
      details: { command: "update" },
      remediation:
        'Run "easy-host list" and pass one app name, for example "easy-host update blog".',
    });
  }

  const environment = overrides.environment ?? request.environment ?? process.env;
  const clock = overrides.clock ?? (() => new Date());
  const dependencies = resolveDependencies(overrides, environment, clock);
  const { registry, output } = dependencies;
  const app = validateAppName(request.app);

  output.phase("validating", `loading app "${app}"`);
  const record = registry.record(app);

  output.phase("locking", `acquiring the app lock for "${app}"`);
  const lock = acquireAppLock(record.directory, {
    operation: "update",
    ...(dependencies.lock ?? {}),
  });

  try {
    return await updateWhileLocked(request, app, record, dependencies, environment, clock);
  } finally {
    lock.release();
  }
}

async function updateWhileLocked(
  request: UpdateRequest,
  app: string,
  record: AppRecord,
  dependencies: UpdateDependencies,
  environment: NodeJS.ProcessEnv,
  clock: () => Date,
): Promise<UpdateResult> {
  const { registry, runtime, output } = dependencies;
  const phases: UpdatePhase[] = [];
  const warnings: string[] = [];

  // Preflight: every check below is read-only and runs before a mutation.
  const current = registry.readConfig(app);
  const desired = resolveDesiredSpec(current, request);
  assertPortAvailableForApp(desired.port, registry.list(), { app });
  const desiredEnvironment = loadEnvironment(record.directory, desired);
  const currentEnvironment = readCurrentEnvironment(record, current, warnings, output);
  await assertVolumeOwnership(app, desired.volumes, runtime);

  const state = dependencies.stateStore(record.directory);
  const recorded = state.readCache();
  const observation = await observeContainer(runtime, app);

  const diff = classifyUpdate({
    current,
    desired,
    state: recorded ?? null,
    container: toDiffObservation(observation),
    environment: {
      current: currentEnvironment?.values,
      desired: desiredEnvironment.values,
    },
    ...(request.rebuild === true ? { rebuild: true } : {}),
  });

  output.phase(
    "inspecting",
    diff.kind === "no-op" && desired.repo !== undefined
      ? "no configuration or state differences; checking the configured ref for new commits"
      : diff.reason,
  );

  const context: UpdateContext = {
    app,
    record,
    current,
    desired,
    dependencies,
    environment,
    clock,
    output,
    phases,
    warnings,
    currentEnvironment,
    desiredEnvironment,
    state,
    observation,
    diff,
  };

  if (diff.kind === "no-op") {
    const moved = await detectSourceChange(context);
    if (moved === undefined) {
      return noOpResult(context);
    }

    return rebuild(context, moved.prepared, true);
  }

  if (diff.kind === "config-only") {
    return configOnly(context);
  }

  return rebuild(context, undefined, false);
}

/**
 * The current environment snapshot is used only to compare secret-file values.
 * A current config that can no longer be read is not a reason to block the
 * repair: an incomplete snapshot makes the diff treat the environment as an
 * unknown difference and rebuild (UPD-FR-04).
 */
function readCurrentEnvironment(
  record: AppRecord,
  current: AppSpec,
  warnings: string[],
  output: UpdateOutput,
): ContainerEnvironment | undefined {
  try {
    return loadEnvironment(record.directory, current);
  } catch (error) {
    if (error instanceof UsageError || error instanceof PrerequisiteError) {
      const message = `the existing environment could not be read (${messageOf(error)}), so the environment is treated as changed`;
      warnings.push(message);
      try {
        output.warn(message);
      } catch {
        // Progress output is advisory.
      }
      return undefined;
    }

    throw error;
  }
}

/** Desired spec: a full spec wins; otherwise partial changes layer over disk. */
function resolveDesiredSpec(current: AppSpec, request: UpdateRequest): AppSpec {
  if (request.desired !== undefined) {
    return validateAppSpec(request.desired, { file: "easy-host update" });
  }

  if (request.changes === undefined) {
    return current;
  }

  return validateAppSpec({ ...current, ...request.changes }, { file: "easy-host update" });
}

interface SourceMove {
  readonly prepared: PreparedWorkspace;
  readonly previousCommit: string | undefined;
}

/**
 * For a git-backed app whose diff is a no-op, fetch the configured ref and
 * compare the resolved commit with the checkout's current HEAD (the commit the
 * serving image was built from). A missing checkout or an unavailable HEAD
 * read is treated as an unknown difference: rebuild rather than risk a false
 * no-op.
 *
 * Local mode is used in place and has no upstream commit, so its no-op stands.
 */
async function detectSourceChange(context: UpdateContext): Promise<SourceMove | undefined> {
  const { app, record, desired, dependencies, environment, output } = context;

  if (desired.repo === undefined) {
    return undefined;
  }

  output.phase("fetching", `checking ${redactText(desired.repo)} at ${desired.ref}`);

  let previousCommit: string | undefined;
  if (dependencies.source.head !== undefined) {
    previousCommit = await dependencies.source.head({
      app,
      appDir: record.directory,
      environment,
    });
  }

  const prepared = await dependencies.source.prepare({
    app,
    appDir: record.directory,
    repo: desired.repo,
    ref: desired.ref,
    env: environment,
  });

  if (previousCommit !== undefined && prepared.commit === previousCommit) {
    return undefined;
  }

  return { prepared, previousCommit };
}

/** Recreates the recorded image with the desired settings; never builds. */
async function configOnly(context: UpdateContext): Promise<UpdateResult> {
  const { app, diff } = context;
  const currentImage = diff.currentImage;

  if (currentImage === null) {
    // The diff only returns config-only with a recorded current image; this is
    // a defensive guard against a future classifier change.
    throw new PrerequisiteError(`update of "${app}" has no recorded image to recreate`, {
      code: UPDATE_FAILURE_CODES.NO_RECORDED_IMAGE,
      details: { app },
      remediation: `Run "easy-host update ${app} --rebuild" to build a new image.`,
    });
  }

  await createDeclaredVolumes(context);

  const result = await runSwap(context, {
    candidateImage: currentImage,
    currentImage,
    previousImage: diff.previousImage,
  });

  if (result.status === "reverted") {
    recordConfigOnlyState(context, result.recovery);
    throw candidateFailure(
      context,
      result.failure,
      result.recovery,
      currentImage,
      currentImage,
      diff.previousImage,
    );
  }

  const stateRecorded = recordConfigOnlyHealthy(context, result.containerId, result.health);
  const configApplied = applyConfig(context);
  await runRetention(context);

  return {
    ...baseResult(context),
    status: "updated",
    kind: "config-only",
    image: currentImage,
    previousImage: diff.previousImage,
    candidateImage: currentImage,
    containerId: result.containerId,
    health: result.health,
    recordedHealth: "healthy",
    containerState: "running",
    changes: diff.changes,
    skipped: configApplied ? ["image build"] : ["image build", "configuration write"],
    configApplied,
    stateRecorded,
    sourceChanged: false,
    notes: [
      ...diff.notes,
      `the recorded image ${currentImage} was reused; Railpack and BuildKit were not invoked`,
    ],
    phases: [...context.phases],
  };
}

/** Fetches, builds, and swaps a new image. A build failure never stops anything. */
async function rebuild(
  context: UpdateContext,
  prepared: PreparedWorkspace | undefined,
  sourceChanged: boolean,
): Promise<UpdateResult> {
  const { app, current, desired, dependencies, environment, output } = context;

  let workspace = prepared;
  if (workspace === undefined) {
    if (requiresFreshCheckout(current, desired)) {
      output.phase("fetching", "the source changed; discarding the previous checkout");
      discardWorkspace(context);
    }

    output.phase("fetching", describeSource(desired));
    workspace = await dependencies.source.prepare({
      app,
      appDir: context.record.directory,
      ...(desired.repo === undefined ? {} : { repo: desired.repo }),
      ...(desired.local_path === undefined ? {} : { localPath: desired.local_path }),
      ref: desired.ref,
      env: environment,
    });
  }

  if (workspace.devOnly) {
    warn(
      context,
      `local mode is dev-only: "${workspace.workspace}" is used in place and is not tracked by easy-host`,
    );
  }

  output.phase("building", `building a candidate image from "${workspace.workspace}"`);
  let built: AddBuildResult;
  try {
    built = await dependencies.builder.build({
      app,
      workspace: workspace.workspace,
      stateRoot: dependencies.paths.root,
      ...(dependencies.buildStderr === undefined ? {} : { stderr: dependencies.buildStderr }),
      ...(dependencies.environment === undefined ? {} : { env: dependencies.environment }),
    } satisfies AddBuildRequest);
  } catch (error) {
    output.phase(
      "failed",
      "the image build failed; the serving container and config.toml were not touched",
    );
    // A failed build may leave the checkout ahead of the serving image. Drop
    // the disposable clone so the next update cannot mistake it for "built".
    discardWorkspace(context);
    throw error;
  }

  await createDeclaredVolumes(context);

  const currentImage = context.diff.currentImage ?? context.observation?.image ?? null;
  if (currentImage === null) {
    return firstStart(context, built.image, sourceChanged, workspace);
  }

  const result = await runSwap(context, {
    candidateImage: built.image,
    currentImage,
    previousImage: context.diff.previousImage,
  });

  if (result.status === "reverted") {
    // The checkout is now ahead of the image that is serving again. Drop the
    // disposable clone so a retry re-fetches and re-attempts this source
    // instead of comparing the checkout with itself and reporting a no-op.
    discardWorkspace(context);
    throw candidateFailure(
      context,
      result.failure,
      result.recovery,
      built.image,
      currentImage,
      context.diff.previousImage,
    );
  }

  if (!result.stateRecorded) {
    warn(context, "the healthy candidate could not be recorded in state.json");
  }

  const configApplied = applyConfig(context);
  await runRetention(context);

  return {
    ...baseResult(context),
    status: "updated",
    kind: "rebuild",
    image: built.image,
    previousImage: currentImage,
    candidateImage: built.image,
    containerId: result.containerId,
    health: result.health,
    recordedHealth: "healthy",
    containerState: "running",
    changes: context.diff.changes,
    skipped: configApplied ? [] : ["configuration write"],
    configApplied,
    stateRecorded: result.stateRecorded,
    sourceChanged,
    notes: [
      ...context.diff.notes,
      ...(sourceChanged ? ["the configured ref moved; the candidate was rebuilt"] : []),
    ],
    phases: [...context.phases],
    ...(workspace.mode === "git" && workspace.commit !== undefined
      ? { commit: workspace.commit }
      : {}),
    ...(workspace.repo === undefined ? {} : { repo: workspace.repo }),
    ...(workspace.ref === undefined ? {} : { ref: workspace.ref }),
  };
}

/**
 * Starts a rebuilt image when neither `state.json` nor a live container names a
 * previous image. There is nothing to revert to, so this mirrors `add`: probe
 * the candidate, keep it on success, and remove only the container on failure.
 */
async function firstStart(
  context: UpdateContext,
  candidateImage: string,
  sourceChanged: boolean,
  workspace: PreparedWorkspace,
): Promise<UpdateResult> {
  const { app, desired, dependencies } = context;

  await stopAndRemoveQuietly(context);

  emit(context, "starting", `starting ${candidateImage} (no previous image to revert to)`);
  let run: ContainerRunResult;
  try {
    run = await dependencies.runtime.runContainer(
      runOptions(app, desired, candidateImage, context.desiredEnvironment.values),
    );
  } catch (error) {
    emit(context, "failed", "the first candidate did not start; no container is left behind");
    await discardCandidateContainer(context);
    throw error;
  }

  emit(context, "probing", `probing ${probeDescription(desired)}`);
  let health: ProbeResult;
  try {
    health = await probeFirstVersion(context, desired);
  } catch (error) {
    await discardCandidateContainer(context);
    throw error;
  }

  if (!health.healthy) {
    emit(
      context,
      "failed",
      "the first version did not become healthy; the container was removed and the image was kept",
    );
    await discardCandidateContainer(context);
    recordFirstStartFailure(context, candidateImage, health);
    throw firstStartHealthError(context, candidateImage, health);
  }

  let stateRecorded = true;
  try {
    context.state.update({
      images: { current: candidateImage, previous: null },
      containerId: run.id,
      health: {
        status: "healthy",
        checkedAt: context.clock().toISOString(),
        detail: `first version ${candidateImage} healthy after ${health.attempts} attempt(s)`,
      },
    });
  } catch (error) {
    stateRecorded = false;
    warn(context, `could not record the healthy state: ${messageOf(error)}`);
  }

  const configApplied = applyConfig(context);
  await runRetention(context);

  return {
    ...baseResult(context),
    status: "updated",
    kind: "rebuild",
    image: candidateImage,
    previousImage: null,
    candidateImage,
    containerId: run.id,
    health,
    recordedHealth: "healthy",
    containerState: "running",
    changes: context.diff.changes,
    skipped: configApplied ? [] : ["configuration write"],
    configApplied,
    stateRecorded,
    sourceChanged,
    notes: [
      ...context.diff.notes,
      "no previous image was recorded; the candidate is the first version",
    ],
    phases: [...context.phases],
    ...(workspace.mode === "git" && workspace.commit !== undefined
      ? { commit: workspace.commit }
      : {}),
    ...(workspace.repo === undefined ? {} : { repo: workspace.repo }),
    ...(workspace.ref === undefined ? {} : { ref: workspace.ref }),
  };
}

interface SwapInput {
  readonly candidateImage: string;
  readonly currentImage: string;
  readonly previousImage: string | null;
}

/**
 * Runs the shared swap. Config-only updates deliberately pass no state writer:
 * the swap's "kept" image pair would set `previous` to the candidate (the same
 * image), destroying the rollback target. `update` writes the config-only
 * health/container facts itself and never touches the image pair.
 */
function runSwap(context: UpdateContext, input: SwapInput): Promise<SwapResult> {
  const { app, desired, dependencies, clock } = context;
  const swap = dependencies.swap ?? swapApp;
  const reporter: SwapReporter = {
    phase(phase: SwapPhase, message: string) {
      emit(context, phase, message);
    },
  };

  return swap(
    {
      app,
      spec: desired,
      candidateImage: input.candidateImage,
      currentImage: input.currentImage,
      previousImage: input.previousImage,
      environment: context.desiredEnvironment.values,
      recoverySpec: context.current,
      recoveryEnvironment: context.currentEnvironment?.values ?? context.desiredEnvironment.values,
    },
    {
      runtime: dependencies.runtime,
      prober: dependencies.prober,
      reporter,
      state: context.diff.kind === "config-only" ? null : context.state,
      clock,
    },
  );
}

function recordConfigOnlyHealthy(
  context: UpdateContext,
  containerId: string,
  health: ProbeResult,
): boolean {
  try {
    context.state.update({
      containerId,
      health: {
        status: "healthy",
        checkedAt: context.clock().toISOString(),
        detail: `container recreated on ${context.diff.currentImage} after a config-only update; healthy after ${health.attempts} attempt(s)`,
      },
    });
    return true;
  } catch (error) {
    warn(context, `could not record the healthy state: ${messageOf(error)}`);
    return false;
  }
}

/**
 * Records a reverted config-only update. The image pair is omitted so the
 * current and previous references stay exactly as they were (UPD-FR-03).
 */
function recordConfigOnlyState(context: UpdateContext, recovery: SwapRecovery): void {
  const status: HealthStatus = recovery.healthy ? "healthy" : "unhealthy";
  const outcome = recovery.healthy
    ? `the previous container is serving again on ${context.diff.currentImage}`
    : `the recorded image ${context.diff.currentImage} is not healthy: ${recovery.message}`;

  try {
    context.state.update({
      containerId: recovery.containerId,
      health: {
        status,
        checkedAt: context.clock().toISOString(),
        detail: `config-only recreate failed: ${outcome}`,
      },
    });
  } catch (error) {
    warn(context, `could not record the reverted state: ${messageOf(error)}`);
  }
}

function recordFirstStartFailure(context: UpdateContext, image: string, health: ProbeResult): void {
  try {
    context.state.update({
      images: { current: image, previous: null },
      containerId: null,
      health: {
        status: "unhealthy",
        checkedAt: context.clock().toISOString(),
        detail: `probe ${health.target} failed: ${probeReason(health)}`,
      },
    });
  } catch (error) {
    warn(context, `could not record the unhealthy state: ${messageOf(error)}`);
  }
}

/** Rewrites `config.toml` only after a successful operation. */
function applyConfig(context: UpdateContext): boolean {
  if (context.diff.changes.length === 0) {
    return false;
  }

  const configFields = context.diff.changes.filter(
    (change) => !change.field.startsWith("environment"),
  );
  if (configFields.length === 0) {
    // Only secrets-file values changed; `config.toml` already matches.
    return false;
  }

  emit(
    context,
    "applying-config",
    `writing ${configFields.length} configuration change(s) to config.toml`,
  );

  try {
    const source = readConfigSource(context.record.configPath);
    context.dependencies.registry.writeConfig(
      context.app,
      context.desired,
      source === undefined ? {} : { source },
    );
    return true;
  } catch (error) {
    warn(
      context,
      `the app is serving the new settings, but config.toml could not be written: ${messageOf(error)}; ` +
        `retry "easy-host update ${context.app}" or edit it with "easy-host config ${context.app} --edit"`,
    );
    return false;
  }
}

/**
 * Prunes old images after a successful transition (`RBK-FR-02`).
 *
 * Retention runs with the operation's registry, state cache, and environment so
 * it sees the same `state.json` the update just wrote, and with a quiet output
 * adapter: update summarizes the outcome once instead of forwarding every
 * retention phase. A failure here is a warning, never an error: the new version
 * is serving and the old images are simply left for the next run.
 */
async function runRetention(context: UpdateContext): Promise<void> {
  const retain = context.dependencies.retain;
  if (retain === undefined) {
    return;
  }

  try {
    const result = await retain(
      { app: context.app, environment: context.environment },
      {
        registry: context.dependencies.registry,
        stateStore: context.dependencies.stateStore,
        output: retentionOutput(context),
        environment: context.environment,
      },
    );
    reportRetention(context, result);
  } catch (error) {
    warn(
      context,
      `the app is serving, but old images could not be pruned: ${messageOf(error)}; ` +
        `run "easy-host doctor", then retry "easy-host update ${context.app}"`,
    );
  }
}

/** Narrates retention progress and warnings; removals are summarized by the caller. */
function retentionOutput(context: UpdateContext): RetainOutput {
  return {
    phase(phase, message) {
      info(context, `retention ${phase}: ${message}`);
    },
    info() {
      // Summarized from the result so each removal is not printed twice.
    },
    warn(message) {
      warn(context, message);
    },
  };
}

function reportRetention(context: UpdateContext, result: RetainResult): void {
  if (result.status === "skipped") {
    return;
  }

  if (result.removed.length > 0) {
    info(
      context,
      `retention removed ${result.removed.length} old image(s): ${result.removed.join(", ")}`,
    );
  }

  if (result.refused.length > 0) {
    info(
      context,
      `retention kept ${result.refused.length} image(s) it could not remove: ` +
        result.refused.map((entry) => `${entry.reference} (${entry.reason})`).join(", "),
    );
  }
}

function noOpResult(context: UpdateContext): UpdateResult {
  const { diff } = context;

  emit(context, "skipped", "nothing changed: no build, no container recreate, no config write");

  return {
    ...baseResult(context),
    status: "no-op",
    kind: "no-op",
    image: diff.currentImage,
    previousImage: diff.previousImage,
    candidateImage: null,
    containerId: context.observation?.id ?? null,
    health: null,
    recordedHealth: diff.recordedHealth,
    containerState: diff.container,
    changes: [],
    skipped: ["image build", "container recreate", "configuration write"],
    configApplied: false,
    stateRecorded: false,
    sourceChanged: false,
    notes: [...diff.notes, diff.reason],
    phases: [...context.phases],
  };
}

function baseResult(
  context: UpdateContext,
): Omit<
  UpdateResult,
  | "status"
  | "kind"
  | "image"
  | "previousImage"
  | "candidateImage"
  | "containerId"
  | "health"
  | "recordedHealth"
  | "containerState"
  | "changes"
  | "skipped"
  | "configApplied"
  | "stateRecorded"
  | "sourceChanged"
  | "notes"
  | "phases"
> {
  const { app, desired, diff } = context;

  return {
    app,
    container: containerName(app),
    port: desired.port,
    bind: desired.bind,
    healthPath: desired.health_path,
    url: `http://localhost:${desired.port}${desired.health_path}`,
    warnings: [...context.warnings],
    diff,
    ...(desired.repo === undefined ? {} : { repo: desired.repo }),
    ...(desired.ref === undefined ? {} : { ref: desired.ref }),
  };
}

function candidateFailure(
  context: UpdateContext,
  failure: SwapFailure,
  recovery: SwapRecovery,
  candidateImage: string,
  currentImage: string,
  previousImage: string | null,
): HealthError {
  const { app } = context;
  const previous = recovery.healthy
    ? `${currentImage} is serving again`
    : recovery.started
      ? `${currentImage} restarted but is not healthy: ${recovery.message}`
      : `${currentImage} could not be restarted: ${recovery.message}`;
  const summary = recovery.healthy
    ? `update of "${app}" failed; the previous version is serving again`
    : `update of "${app}" failed and the previous version could not be restored`;

  return new HealthError(summary, {
    code: UPDATE_FAILURE_CODES.CANDIDATE_FAILED,
    details: {
      app,
      stage: failure.stage,
      candidate: candidateImage,
      reason: failure.message,
      previous,
      restored: recovery.healthy,
      image: currentImage,
      rollback: previousImage,
      state: recovery.healthy ? "reverted" : "unhealthy",
      health: recovery.health?.state ?? "unhealthy",
    },
    remediation: recovery.healthy
      ? `Fix the cause, then retry "easy-host update ${app}"; inspect the app with "easy-host logs ${app} --tail 200".`
      : `The app is not serving. Run "easy-host update ${app}" to recreate ${currentImage}, then "easy-host logs ${app} --tail 200".`,
  });
}

function firstStartHealthError(
  context: UpdateContext,
  image: string,
  health: ProbeResult,
): HealthError {
  return new HealthError(`the first version of "${context.app}" failed its health check`, {
    code: UPDATE_FAILURE_CODES.FIRST_START_FAILED,
    details: {
      app: context.app,
      probe: health.target,
      reason: probeReason(health),
      previous: "none (no previous version was recorded)",
      image,
      state: "unhealthy",
    },
    remediation: `Fix the app so it answers on ${health.target}, then retry "easy-host update ${context.app}" (add --rebuild to build a new image).`,
  });
}

async function observeContainer(
  runtime: UpdateRuntime,
  app: string,
): Promise<UpdateContainerSnapshot | null> {
  try {
    const inspected = await runtime.inspectContainer({ app });
    return toSnapshot(inspected);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return null;
    }

    throw error;
  }
}

function toSnapshot(inspected: unknown): UpdateContainerSnapshot {
  if (inspected === null || typeof inspected !== "object") {
    return { id: null, image: null, running: false };
  }

  const record = inspected as {
    id?: unknown;
    image?: unknown;
    state?: { running?: unknown };
  };

  return {
    id: typeof record.id === "string" && record.id.length > 0 ? record.id : null,
    image: typeof record.image === "string" && record.image.length > 0 ? record.image : null,
    running: record.state?.running === true,
  };
}

function toDiffObservation(
  observation: UpdateContainerSnapshot | null,
): UpdateContainerObservation | null {
  if (observation === null) {
    return null;
  }

  return {
    state: { running: observation.running },
    image: observation.image,
  };
}

async function assertVolumeOwnership(
  app: string,
  volumes: Readonly<Record<string, string>>,
  runtime: UpdateRuntime,
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
        code: UPDATE_FAILURE_CODES.VOLUME_CONFLICT,
        details: { app, volume, volumeName: name },
        remediation: `Remove "${name}" with "podman volume rm ${name}", or declare a different volume name.`,
      });
    }
  }
}

async function createDeclaredVolumes(context: UpdateContext): Promise<void> {
  const declared = Object.keys(context.desired.volumes);
  if (declared.length === 0) {
    return;
  }

  emit(context, "preparing", `ensuring ${declared.length} named volume(s) exist`);
  for (const volume of declared) {
    await context.dependencies.runtime.createVolume({
      app: context.app,
      volume,
      ignoreExisting: true,
    });
  }
}

/** True when the workspace checkout must be discarded before re-preparing. */
function requiresFreshCheckout(current: AppSpec, desired: AppSpec): boolean {
  if (current.repo === undefined) {
    // Never delete a local source; local mode is used in place.
    return false;
  }

  return desired.repo !== current.repo || desired.local_path !== undefined;
}

/**
 * Deletes the disposable git checkout after a failed build or a source change.
 *
 * Only a *current* git app owns `<appDir>/workspace`: a local-mode app may use
 * `workspace/` as its source directory, so it is never deleted (PRD-C-02: data
 * and source are the operator's).
 */
function discardWorkspace(context: UpdateContext): void {
  if (context.current.repo === undefined) {
    return;
  }

  const target = workspacePath(context.record.directory);
  try {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
  } catch (error) {
    warn(context, `could not remove the stale checkout "${target}": ${messageOf(error)}`);
  }
}

async function stopAndRemoveQuietly(context: UpdateContext): Promise<void> {
  const { app, dependencies, output } = context;
  output.phase("stopping", `stopping container "${containerName(app)}"`);
  try {
    await dependencies.runtime.stopContainer({ app, timeSeconds: 10 });
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      warn(context, `could not stop container "${containerName(app)}": ${messageOf(error)}`);
    }
  }

  try {
    await dependencies.runtime.removeContainer({ app, force: true, ignoreMissing: true });
  } catch (error) {
    warn(context, `could not remove container "${containerName(app)}": ${messageOf(error)}`);
  }
}

async function discardCandidateContainer(context: UpdateContext): Promise<void> {
  const { app, dependencies } = context;
  try {
    await dependencies.runtime.stopContainer({ app, timeSeconds: 10 });
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      warn(context, `could not stop the failed candidate: ${messageOf(error)}`);
    }
  }

  try {
    await dependencies.runtime.removeContainer({ app, force: true, ignoreMissing: true });
  } catch (error) {
    warn(context, `could not remove the failed candidate: ${messageOf(error)}`);
  }
}

function runOptions(
  app: string,
  spec: AppSpec,
  image: string,
  environment: Readonly<Record<string, string>>,
): RunContainerOptions {
  return {
    app,
    image,
    port: spec.port,
    containerPort: spec.container_port,
    bind: spec.bind,
    environment,
    volumes: spec.volumes,
  };
}

function probeDescription(spec: ProbeAppSpec): string {
  return `${spec.probe} port ${spec.port} for up to ${spec.health_startup_ms}ms`;
}

/**
 * Bounds the first-version probe. The production probe already stops at the
 * startup budget; the deadline also covers an injected prober that ignores it,
 * so a first start can never hang the command (PRD-NF-05).
 */
function probeFirstVersion(context: UpdateContext, spec: ProbeAppSpec): Promise<ProbeResult> {
  const deadlineMs = swapProbeDeadlineMs(spec);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pending = Promise.resolve().then(() => context.dependencies.prober.probe(spec));
  const deadline = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve(probeTimeoutResult(spec, deadlineMs)), deadlineMs);
  });

  return Promise.race([pending, deadline]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function probeTimeoutResult(spec: ProbeAppSpec, deadlineMs: number): ProbeResult {
  return {
    state: "unhealthy",
    healthy: false,
    kind: spec.probe,
    port: spec.port,
    target: formatProbeTarget(spec.probe, spec.port, spec.health_path),
    attempts: 0,
    elapsedMs: deadlineMs,
    lastStatus: undefined,
    lastError: {
      kind: "timeout",
      code: PROBE_FAILURE_CODES.TIMEOUT,
      message: `the probe did not finish within ${deadlineMs}ms`,
      status: undefined,
      timeoutMs: spec.health_timeout_ms,
      causeCode: undefined,
    },
    intervalMs: spec.health_interval_ms,
    timeoutMs: spec.health_timeout_ms,
    startupMs: spec.health_startup_ms,
  };
}

function probeReason(health: ProbeResult): string {
  return (
    health.lastError?.message ??
    (health.lastStatus === undefined
      ? "no successful probe within the startup budget"
      : `HTTP ${health.lastStatus}`)
  );
}

function describeSource(spec: AppSpec): string {
  if (spec.local_path !== undefined) {
    return `validating local path "${spec.local_path}"`;
  }

  return `fetching ${redactText(spec.repo ?? "")} at ${spec.ref}`;
}

function readConfigSource(configPath: string): string | undefined {
  try {
    return readFileSync(configPath, "utf8");
  } catch {
    // The comment-preserving rewrite is advisory; the registry still writes the
    // complete desired spec atomically.
    return undefined;
  }
}

function emit(context: UpdateContext, phase: UpdatePhase, message: string): void {
  context.phases.push(phase);
  try {
    context.output.phase(phase, message);
  } catch {
    // Progress output is advisory; a broken stream must not corrupt the update.
  }
}

function info(context: UpdateContext, message: string): void {
  try {
    context.output.info(message);
  } catch {
    // Progress output is advisory.
  }
}

function warn(context: UpdateContext, message: string): void {
  context.warnings.push(message);
  try {
    context.output.warn(message);
  } catch {
    // See emit.
  }
}

function resolveDependencies(
  overrides: UpdateDependencyOverrides,
  environment: NodeJS.ProcessEnv,
  clock: () => Date,
): UpdateDependencies {
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
    runtime: overrides.runtime ?? createDefaultUpdateRuntime(),
    builder,
    prober: overrides.prober ?? createDefaultSwapProber(),
    source: overrides.source ?? createDefaultUpdateSource({ environment }),
    stateStore: overrides.stateStore ?? ((appDir) => new StateStore(appDir, { clock })),
    output: overrides.output ?? createDefaultUpdateOutput(),
    ...(overrides.swap === undefined ? {} : { swap: overrides.swap }),
    retain: overrides.retain ?? retainImages,
    ...(overrides.buildStderr === undefined ? {} : { buildStderr: overrides.buildStderr }),
    environment,
    clock,
    ...(overrides.lock === undefined ? {} : { lock: overrides.lock }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
