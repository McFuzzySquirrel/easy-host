/**
 * `rollback` orchestration (`RBK-FR-01`, `RBK-NF-02`).
 *
 * A rollback is one build-free health-gated swap between the two image
 * references `state.json` records for an app:
 *
 * 1. **validating** — the app name is validated and the registry record is
 *    resolved (exit 5 for an unknown app);
 * 2. **locking** — the per-app lock is taken for the whole operation and
 *    released in `finally` on every path (exit 6 when another mutation holds
 *    it, naming the holder);
 * 3. **inspecting** — `config.toml` is validated, the merged environment is
 *    read, and the recorded pair is required to contain two *distinct*
 *    non-empty image references; anything less exits 5 before a container is
 *    touched (`RBK-FR-01`);
 * 4. **swapping** — the previous image is started as the candidate over the
 *    current image through {@link swapApp}: stop, start, probe, then keep or
 *    revert (`RBK-NF-02`). This module never invokes Railpack, BuildKit, git,
 *    or the builder seam; there is no such dependency to call;
 * 5. **recording** — only a healthy candidate is persisted. The pair is
 *    swapped so `current` becomes the restored image and `previous` becomes the
 *    image that was serving before, which is what makes a second rollback
 *    return to the newer image;
 * 6. **reverting** — an unhealthy candidate, a failed start, or an expired
 *    probe budget makes the swap restart the previously serving image. The
 *    image pair is then left exactly as it was; only health and container facts
 *    are recorded, and the command exits 4.
 *
 * Two invariants are deliberate:
 *
 * - **The serving image never changes on a failure.** The recorded pair is
 *   written only after a healthy candidate, so a failed rollback leaves
 *   `current` and `previous` untouched and a retry still targets the same
 *   older image.
 * - **No image is deleted here.** Rollback only removes containers (through the
 *   swap). Retention is a separate policy (`RBK-FR-02`), so a rollback can never
 *   destroy the image an operator is rolling back to or from.
 *
 * Runtime, prober, state writer, output, swap, lock options, and clock are
 * injected, so the unit suite runs the keep, revert, start-failure, contention,
 * and single-image paths with no Podman process, network, or terminal.
 */

import { HealthError, NotFoundError, UsageError } from "../cli/errors.js";
import { type ContainerEnvironment, loadEnvironment } from "../config/env.js";
import { validateAppName } from "../config/name.js";
import type { AppSpec } from "../config/schema.js";
import { type ProbeResult, probeApp } from "../health/probe.js";
import { acquireAppLock, type LockAcquireOptions } from "../platform/lock.js";
import { createPaths } from "../platform/paths.js";
import { containerName, removeContainer, runContainer, stopContainer } from "../platform/podman.js";
import { type AppStatePatch, StateStore } from "../registry/state.js";
import { type AppRecord, Registry } from "../registry/store.js";
import {
  type SwapFailure,
  type SwapPhase,
  type SwapProber,
  type SwapRecovery,
  type SwapReporter,
  type SwapResult,
  type SwapRuntime,
  swapApp,
} from "./swap.js";

/** Failed outcomes reported by the rollback command. */
export const ROLLBACK_FAILURE_CODES = {
  INVALID_APP: "INVALID_APP_NAME",
  /** Fewer than two distinct recorded image references (`RBK-FR-01`). */
  ONE_IMAGE: "ROLLBACK_ONE_IMAGE",
  CANDIDATE_FAILED: "ROLLBACK_CANDIDATE_FAILED",
} as const;

/** Progress phases. Swap phases are forwarded unchanged by the swap reporter. */
export const ROLLBACK_PHASES = [
  "validating",
  "locking",
  "inspecting",
  "stopping",
  "starting",
  "probing",
  "keeping",
  "reverting",
  "reverted",
  "recording",
] as const;

export type RollbackPhase = (typeof ROLLBACK_PHASES)[number];

/** Progress output. It always goes to stderr so stdout stays scriptable. */
export interface RollbackOutput {
  phase(phase: RollbackPhase, message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

/** A writable stream, narrowed so tests can record progress. */
export interface RollbackOutputStream {
  write(chunk: string): unknown;
}

/** The registry operations `rollback` performs. `Registry` satisfies it. */
export interface RollbackRegistry {
  record(name: string): AppRecord;
  readConfig(name: string): AppSpec;
}

/** Container operations the swap performs. The Podman adapter satisfies it. */
export type RollbackRuntime = SwapRuntime;

/** The recorded image pair a rollback needs. `AppState` satisfies it. */
export interface RollbackRecordedState {
  readonly images: {
    readonly current: string | null;
    readonly previous: string | null;
  };
}

/** The state writer seam. `StateStore` satisfies it. */
export interface RollbackStateStore {
  readCache(): RollbackRecordedState | undefined;
  update(patch: AppStatePatch): unknown;
}

export interface RollbackDependencies {
  readonly registry: RollbackRegistry;
  readonly runtime: RollbackRuntime;
  readonly prober: SwapProber;
  readonly stateStore: (appDir: string) => RollbackStateStore;
  readonly output: RollbackOutput;
  /** The health-gated swap. Defaults to {@link swapApp}; injectable for tests. */
  readonly swap?: typeof swapApp;
  readonly environment: NodeJS.ProcessEnv;
  readonly clock: () => Date;
  readonly lock?: LockAcquireOptions;
}

export type RollbackDependencyOverrides = Partial<RollbackDependencies>;

/** Raw `rollback` inputs. */
export interface RollbackRequest {
  readonly app: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/** The outcome of one successful rollback. */
export interface RollbackResult {
  readonly status: "rolled-back";
  readonly app: string;
  readonly container: string;
  /** The restored image, now recorded as current. */
  readonly image: string;
  /** The image that was serving before, now the rollback target. */
  readonly previousImage: string;
  /** Alias of {@link RollbackResult.image}, named for the operator report. */
  readonly restoredImage: string;
  /** Alias of {@link RollbackResult.previousImage}. */
  readonly rollbackTarget: string;
  readonly containerId: string;
  readonly health: ProbeResult;
  readonly port: number;
  readonly bind: string;
  readonly healthPath: string;
  readonly url: string;
  /** True when `state.json` recorded the swapped pair. */
  readonly stateRecorded: boolean;
  /** Work this command deliberately did not do. */
  readonly skipped: readonly string[];
  readonly phases: readonly RollbackPhase[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

interface RollbackContext {
  readonly app: string;
  readonly spec: AppSpec;
  readonly environment: ContainerEnvironment;
  readonly dependencies: RollbackDependencies;
  readonly clock: () => Date;
  readonly output: RollbackOutput;
  readonly state: RollbackStateStore;
  readonly currentImage: string;
  readonly previousImage: string;
  readonly phases: RollbackPhase[];
  readonly warnings: string[];
}

/** Default progress reporter: plain text on stderr, no ANSI escapes. */
export function createDefaultRollbackOutput(
  stream: RollbackOutputStream = process.stderr,
): RollbackOutput {
  return {
    phase(phase, message) {
      stream.write(`rollback: ${phase}: ${message}\n`);
    },
    info(message) {
      stream.write(`rollback: ${message}\n`);
    },
    warn(message) {
      stream.write(`rollback: warning: ${message}\n`);
    },
  };
}

/** The production runtime: the Podman adapter, unchanged. */
export function createDefaultRollbackRuntime(): RollbackRuntime {
  return { stopContainer, removeContainer, runContainer };
}

/** The production probe: the bounded HTTP/TCP health probe. */
export function createDefaultRollbackProber(): SwapProber {
  return { probe: (spec) => probeApp(spec) };
}

/**
 * Runs one rollback.
 *
 * The registry record is resolved first, so an unknown app exits 5 before a
 * lock is taken. The lock is then held across the config read, the state read,
 * and the entire swap, so a concurrent `update`, `rollback`, or `remove` on the
 * same app fails with exit 6 before touching anything (`RBK-FR-05`).
 */
export async function rollbackApp(
  request: RollbackRequest,
  overrides: RollbackDependencyOverrides = {},
): Promise<RollbackResult> {
  if (typeof request.app !== "string" || request.app.trim().length === 0) {
    throw new UsageError("rollback requires an app name", {
      code: ROLLBACK_FAILURE_CODES.INVALID_APP,
      details: { command: "rollback" },
      remediation:
        'Run "easy-host list" and pass one app name, for example "easy-host rollback blog".',
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
    operation: "rollback",
    ...(dependencies.lock ?? {}),
  });

  try {
    return await rollbackWhileLocked(app, record, dependencies, clock);
  } finally {
    lock.release();
  }
}

async function rollbackWhileLocked(
  app: string,
  record: AppRecord,
  dependencies: RollbackDependencies,
  clock: () => Date,
): Promise<RollbackResult> {
  const { registry, stateStore, output } = dependencies;

  // Preflight: every read below happens before the first mutation.
  const spec = registry.readConfig(app);
  const containerEnvironment = loadEnvironment(record.directory, spec);
  const state = stateStore(record.directory);
  const pair = recordedPair(app, state.readCache());

  output.phase(
    "inspecting",
    `recorded current ${pair.current}, rollback target ${pair.previous}; no build is required`,
  );

  const context: RollbackContext = {
    app,
    spec,
    environment: containerEnvironment,
    dependencies,
    clock,
    output,
    state,
    currentImage: pair.current,
    previousImage: pair.previous,
    phases: [],
    warnings: [],
  };

  const result = await runSwap(context);
  if (result.status === "reverted") {
    recordReverted(context, result.failure, result.recovery);
    throw rollbackFailure(context, result.failure, result.recovery);
  }

  emit(
    context,
    "recording",
    `recording ${pair.previous} as current and ${pair.current} as previous`,
  );
  const stateRecorded = recordKept(context, result.containerId, result.health);

  return {
    status: "rolled-back",
    app,
    container: containerName(app),
    image: pair.previous,
    previousImage: pair.current,
    restoredImage: pair.previous,
    rollbackTarget: pair.current,
    containerId: result.containerId,
    health: result.health,
    port: spec.port,
    bind: spec.bind,
    healthPath: spec.health_path,
    url: `http://localhost:${spec.port}${spec.health_path}`,
    stateRecorded,
    skipped: ["image build"],
    phases: [...context.phases],
    warnings: [...context.warnings],
    notes: [
      `restored ${pair.previous}; ${pair.current} is now the rollback target`,
      "Railpack and BuildKit were not invoked",
      "no image was removed; keeping exactly two images is a separate retention step",
    ],
  };
}

interface RecordedPair {
  readonly current: string;
  readonly previous: string;
}

/**
 * Requires two distinct, non-empty recorded image references (`RBK-FR-01`).
 *
 * A missing `state.json`, a null `previous`, and an identical pair all mean
 * there is no older version to restore, so they fail with exit 5 before the
 * container is touched rather than restarting the same image under new labels.
 */
function recordedPair(app: string, state: RollbackRecordedState | undefined): RecordedPair {
  const current = imageOrNull(state?.images.current);
  const previous = imageOrNull(state?.images.previous);

  if (current === null || previous === null) {
    throw new NotFoundError(
      `app "${app}" has fewer than two recorded images; rollback needs a current and a previous image`,
      {
        code: ROLLBACK_FAILURE_CODES.ONE_IMAGE,
        details: {
          app,
          current: current ?? "none",
          previous: previous ?? "none",
          state: state === undefined ? "missing" : "recorded",
        },
        remediation: `Run "easy-host update ${app}" to create a second version before rolling back, or "easy-host list" to confirm the recorded state.`,
      },
    );
  }

  if (current === previous) {
    throw new NotFoundError(
      `app "${app}" records the same image as both current and previous; there is no older version to restore`,
      {
        code: ROLLBACK_FAILURE_CODES.ONE_IMAGE,
        details: { app, image: current },
        remediation: `Run "easy-host update ${app}" to create a new version before rolling back.`,
      },
    );
  }

  return { current, previous };
}

/**
 * Runs the shared swap: the previous image is the candidate and the current
 * image is what the revert path restarts. No state writer is passed, because
 * the swap's own "kept" pair would say `previous = current`; this module writes
 * the swapped pair itself only after the candidate is healthy.
 */
function runSwap(context: RollbackContext): Promise<SwapResult> {
  const { app, spec, environment, dependencies, clock } = context;
  const swap = dependencies.swap ?? swapApp;
  const reporter: SwapReporter = {
    phase(phase: SwapPhase, message: string) {
      emit(context, phase, message);
    },
  };

  return swap(
    {
      app,
      spec,
      candidateImage: context.previousImage,
      currentImage: context.currentImage,
      previousImage: null,
      environment: environment.values,
    },
    {
      runtime: dependencies.runtime,
      prober: dependencies.prober,
      reporter,
      state: null,
      clock,
    },
  );
}

/** Persists the swapped pair only after the candidate answered its probe. */
function recordKept(context: RollbackContext, containerId: string, health: ProbeResult): boolean {
  try {
    context.state.update({
      images: { current: context.previousImage, previous: context.currentImage },
      containerId,
      health: {
        status: "healthy",
        checkedAt: context.clock().toISOString(),
        detail:
          `rolled back from ${context.currentImage} to ${context.previousImage}; ` +
          `healthy after ${health.attempts} attempt(s)`,
      },
    });
    return true;
  } catch (error) {
    warn(
      context,
      `the app is serving ${context.previousImage}, but state.json could not be updated: ${messageOf(error)}; ` +
        `run "easy-host status ${context.app}" and retry "easy-host rollback ${context.app}" if needed`,
    );
    return false;
  }
}

/**
 * Records a reverted rollback. The image pair is deliberately omitted so the
 * recorded current and previous references stay exactly as they were, which is
 * what makes a retry target the same older image (`RBK-FR-01`).
 */
function recordReverted(
  context: RollbackContext,
  failure: SwapFailure,
  recovery: SwapRecovery,
): void {
  const status = recovery.healthy ? "healthy" : "unhealthy";
  const outcome = recovery.healthy
    ? `${context.currentImage} is serving again`
    : `${context.currentImage} is not healthy: ${recovery.message}`;

  try {
    context.state.update({
      containerId: recovery.containerId,
      health: {
        status,
        checkedAt: context.clock().toISOString(),
        detail: `rollback to ${context.previousImage} failed: ${failure.message}; ${outcome}`,
      },
    });
  } catch (error) {
    warn(context, `could not record the reverted state: ${messageOf(error)}`);
  }
}

/** Exit 4 with the failed check, the reason, and the unchanged image pair. */
function rollbackFailure(
  context: RollbackContext,
  failure: SwapFailure,
  recovery: SwapRecovery,
): HealthError {
  const { app, currentImage, previousImage } = context;
  const serving = recovery.healthy
    ? `${currentImage} is serving again`
    : recovery.started
      ? `${currentImage} restarted but is not healthy: ${recovery.message}`
      : `${currentImage} could not be restarted: ${recovery.message}`;
  const summary = recovery.healthy
    ? `rollback of "${app}" failed; the current version is serving again`
    : `rollback of "${app}" failed and the current version could not be restored`;

  return new HealthError(summary, {
    code: ROLLBACK_FAILURE_CODES.CANDIDATE_FAILED,
    details: {
      app,
      stage: failure.stage,
      candidate: previousImage,
      reason: failure.message,
      outcome: serving,
      serving: currentImage,
      restored: recovery.healthy,
      image: currentImage,
      rollback: previousImage,
      state: recovery.healthy ? "reverted" : "unhealthy",
      health: recovery.health?.state ?? "unhealthy",
    },
    remediation: recovery.healthy
      ? `Fix the cause, then retry "easy-host rollback ${app}" (it still targets ${previousImage}); inspect the app with "easy-host status ${app}" and "easy-host logs ${app} --tail 200".`
      : `The app is not serving. Run "easy-host status ${app}" and "easy-host logs ${app} --tail 200", then "easy-host rollback ${app}" once ${currentImage} can start.`,
  });
}

function resolveDependencies(
  overrides: RollbackDependencyOverrides,
  environment: NodeJS.ProcessEnv,
  clock: () => Date,
): RollbackDependencies {
  const registry = overrides.registry ?? new Registry(createPaths({ env: environment }));

  return {
    registry,
    runtime: overrides.runtime ?? createDefaultRollbackRuntime(),
    prober: overrides.prober ?? createDefaultRollbackProber(),
    stateStore: overrides.stateStore ?? ((appDir) => new StateStore(appDir, { clock })),
    output: overrides.output ?? createDefaultRollbackOutput(),
    ...(overrides.swap === undefined ? {} : { swap: overrides.swap }),
    environment,
    clock,
    ...(overrides.lock === undefined ? {} : { lock: overrides.lock }),
  };
}

function emit(context: RollbackContext, phase: RollbackPhase, message: string): void {
  context.phases.push(phase);
  try {
    context.output.phase(phase, message);
  } catch {
    // Progress output is advisory; a broken stream must not corrupt the rollback.
  }
}

function warn(context: RollbackContext, message: string): void {
  context.warnings.push(message);
  try {
    context.output.warn(message);
  } catch {
    // See emit.
  }
}

function imageOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
