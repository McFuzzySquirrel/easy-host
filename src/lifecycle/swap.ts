/**
 * Health-gated container swap (`UPD-FR-02`, `UPD-FR-03`, `UPD-NF-01`).
 *
 * `update` and `rollback` both replace the single container that publishes an
 * app's host port. That is the riskiest transition in the product, so it is
 * implemented once, here:
 *
 * 1. **stopping** — stop the current container and remove it so the fixed
 *    container name is free (`PRD-C-03`: one explicit host port per app);
 * 2. **starting** — run the candidate image with the same app, bind, host port,
 *    container port, environment, and named volumes;
 * 3. **probing** — run the injected probe, bounded by the app's startup budget
 *    plus one settling interval so a probe that never settles cannot hang the
 *    operation;
 * 4. **keeping** — on a healthy candidate, record the candidate as current and
 *    the replaced image as previous, then report success;
 * 5. **reverting** — on any candidate failure after the old container stopped,
 *    stop and remove the candidate and start the previously serving image with
 *    its recorded config and environment (`recoverySpec`/`recoveryEnvironment`,
 *    defaulting to the candidate's);
 * 6. **reverted** — probe the restored container once and report whether it is
 *    serving again.
 *
 * Two invariants are deliberate:
 *
 * - **Never zero containers.** A failed candidate always enters the revert
 *   path before the operation returns, even when the candidate failed to start
 *   (`UPD-NF-01`). The result tells the caller whether recovery succeeded so
 *   `update` can still exit 4 honestly.
 * - **Never overwrite an image tag.** The swap only ever removes containers; it
 *   has no image operation at all. State is written only after the candidate is
 *   healthy, with `current = candidate` and `previous = replaced image`. A
 *   revert writes health/container facts but leaves both image references
 *   untouched (`UPD-FR-03`).
 *
 * The runtime, prober, reporter, state writer, and clock are injected, so the
 * unit suite exercises the keep, revert, start-failure, and hung-probe paths
 * with no Podman process and no real network.
 */

import { NotFoundError, UsageError } from "../cli/errors.js";
import { validateAppName } from "../config/name.js";
import {
  formatProbeTarget,
  type ProbeAppSpec,
  type ProbeResult,
  probeApp,
} from "../health/probe.js";
import {
  type ContainerRunResult,
  containerName,
  type RemoveContainerOptions,
  type RunContainerOptions,
  removeContainer,
  runContainer,
  type StopContainerOptions,
  stopContainer,
} from "../platform/podman.js";
import type { AppStatePatch, HealthStatus } from "../registry/state.js";

/** Ordered phases a swap reports, matching the task vocabulary. */
export const SWAP_PHASES = [
  "stopping",
  "starting",
  "probing",
  "keeping",
  "reverting",
  "reverted",
] as const;

export type SwapPhase = (typeof SWAP_PHASES)[number];

/** The two terminal outcomes of a swap. */
export const SWAP_STATUSES = ["kept", "reverted"] as const;

export type SwapStatus = (typeof SWAP_STATUSES)[number];

/** Stable diagnostic codes carried by failure and recovery results. */
export const SWAP_FAILURE_CODES = {
  INVALID_INPUT: "INVALID_SWAP_INPUT",
  PREPARE_FAILED: "SWAP_PREPARE_FAILED",
  CANDIDATE_START_FAILED: "SWAP_CANDIDATE_START_FAILED",
  CANDIDATE_UNHEALTHY: "SWAP_CANDIDATE_UNHEALTHY",
  PROBE_FAILED: "SWAP_PROBE_FAILED",
  PROBE_TIMEOUT: "SWAP_PROBE_TIMEOUT",
  RECOVERY_START_FAILED: "SWAP_RECOVERY_START_FAILED",
  RECOVERY_UNHEALTHY: "SWAP_RECOVERY_UNHEALTHY",
  RECOVERY_PROBE_FAILED: "SWAP_RECOVERY_PROBE_FAILED",
  RECOVERY_PROBE_TIMEOUT: "SWAP_RECOVERY_PROBE_TIMEOUT",
} as const;

/** Extra time allowed for the probe to settle after its own startup budget. */
export const SWAP_PROBE_SETTLE_MS = 1_000;

/** Seconds Podman waits for a graceful stop before SIGKILL. */
export const SWAP_STOP_GRACE_SECONDS = 10;

/** The config fields a swap needs; `AppSpec` satisfies this shape. */
export interface SwapSpec extends ProbeAppSpec {
  readonly container_port: number;
  readonly bind: string;
  readonly volumes: Readonly<Record<string, string>>;
}

/** Everything that defines one candidate replacement. */
export interface SwapRequest {
  readonly app: string;
  /** The validated app config that defines the candidate's runtime settings. */
  readonly spec: SwapSpec;
  /** The image that should replace the currently serving image. */
  readonly candidateImage: string;
  /** The image the current container was started from; restored on revert. */
  readonly currentImage: string;
  /** The older rollback target. It is never started by a swap. */
  readonly previousImage?: string | null;
  /** Merged inline and secrets-file environment for the replacement container. */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * The config the current container was started with. It defaults to
   * {@link SwapRequest.spec}; `update` passes the previously applied spec so a
   * reverted candidate restores the old port, bind, probe, and volumes
   * (`UPD-FR-02`).
   */
  readonly recoverySpec?: SwapSpec;
  /**
   * The merged environment the current container was started with. Defaults to
   * {@link SwapRequest.environment}.
   */
  readonly recoveryEnvironment?: Readonly<Record<string, string>>;
}

/** Container operations the swap performs. `AddRuntime` satisfies this shape. */
export interface SwapRuntime {
  stopContainer(options: StopContainerOptions): Promise<unknown>;
  removeContainer(options: RemoveContainerOptions): Promise<unknown>;
  runContainer(options: RunContainerOptions): Promise<ContainerRunResult>;
}

/** Probe seam. The production implementation is the bounded health probe. */
export interface SwapProber {
  probe(spec: ProbeAppSpec): Promise<ProbeResult>;
}

/** Progress output seam. Phases always go to stderr in production. */
export interface SwapReporter {
  phase(phase: SwapPhase, message: string): void;
}

/**
 * The state writer seam. `StateStore` satisfies it. Writes happen only after a
 * confirmed health result, never before the candidate is touched.
 */
export interface SwapStateStore {
  update(patch: AppStatePatch): unknown;
}

export interface SwapDependencies {
  readonly runtime?: SwapRuntime;
  readonly prober?: SwapProber;
  readonly reporter?: SwapReporter;
  readonly state?: SwapStateStore | null;
  readonly clock?: () => Date;
}

/** Why the candidate did not survive. */
export type SwapFailureStage = "prepare" | "start" | "probe" | "budget";

export interface SwapFailure {
  readonly stage: SwapFailureStage;
  readonly code: string;
  readonly message: string;
  /** Present for a probe that ran and reported unhealthy. */
  readonly health?: ProbeResult;
}

/** What happened when the previously serving image was restarted. */
export interface SwapRecovery {
  readonly attempted: true;
  readonly image: string;
  readonly started: boolean;
  readonly healthy: boolean;
  readonly containerId: string | null;
  readonly code?: string;
  readonly message: string;
  /** Present when the restored container was started and probed. */
  readonly health?: ProbeResult;
}

/** The image pair a consumer may persist after a successful keep. */
export interface SwapImages {
  readonly current: string;
  readonly previous: string | null;
}

export interface SwapKeptResult {
  readonly status: "kept";
  readonly app: string;
  readonly container: string;
  /** The image now serving, identical to {@link SwapKeptResult.candidateImage}. */
  readonly image: string;
  readonly candidateImage: string;
  /** The replaced image, now the rollback target. */
  readonly previousImage: string;
  readonly images: SwapImages;
  readonly containerId: string;
  readonly health: ProbeResult;
  readonly stateRecorded: boolean;
  readonly phases: readonly SwapPhase[];
  readonly warnings: readonly string[];
}

export interface SwapRevertedResult {
  readonly status: "reverted";
  readonly app: string;
  readonly container: string;
  /** The image still recorded as current, unchanged by the revert. */
  readonly image: string;
  readonly candidateImage: string;
  /** The rollback target, unchanged by the revert. */
  readonly previousImage: string | null;
  /** The unchanged image pair; the caller must not persist a new one. */
  readonly images: SwapImages;
  readonly failure: SwapFailure;
  readonly recovery: SwapRecovery;
  readonly stateRecorded: boolean;
  readonly phases: readonly SwapPhase[];
  readonly warnings: readonly string[];
}

export type SwapResult = SwapKeptResult | SwapRevertedResult;

/** A writable stream narrowed so tests can record progress. */
export interface SwapOutputStream {
  write(chunk: string): unknown;
}

/** Default reporter: plain text on stderr, no ANSI escapes. */
export function createDefaultSwapReporter(stream: SwapOutputStream = process.stderr): SwapReporter {
  return {
    phase(phase, message) {
      stream.write(`swap: ${phase}: ${message}\n`);
    },
  };
}

/** The production runtime: the Podman adapter, unchanged. */
export function createDefaultSwapRuntime(): SwapRuntime {
  return { stopContainer, removeContainer, runContainer };
}

/** The production probe: the bounded HTTP/TCP health probe. */
export function createDefaultSwapProber(): SwapProber {
  return { probe: (spec) => probeApp(spec) };
}

/**
 * The hard deadline for one probe call. The probe is already bounded by the
 * startup budget; one probe interval (capped at a second) of grace prevents a
 * healthy probe that settles exactly on its budget from being lost to timer
 * ordering. A probe that ignores both bounds is still cut off here.
 */
export function swapProbeDeadlineMs(
  spec: Pick<ProbeAppSpec, "health_startup_ms" | "health_interval_ms">,
): number {
  const grace = Math.min(Math.max(1, spec.health_interval_ms), SWAP_PROBE_SETTLE_MS);
  return spec.health_startup_ms + grace;
}

interface SwapContext {
  readonly request: SwapRequest;
  readonly app: string;
  readonly candidateImage: string;
  readonly currentImage: string;
  readonly previousImage: string | null;
  readonly environment: Readonly<Record<string, string>>;
  readonly recoverySpec: SwapSpec;
  readonly recoveryEnvironment: Readonly<Record<string, string>>;
  readonly runtime: SwapRuntime;
  readonly prober: SwapProber;
  readonly reporter: SwapReporter;
  readonly state: SwapStateStore | null | undefined;
  readonly clock: () => Date;
  readonly phases: SwapPhase[];
  readonly warnings: string[];
}

type CandidateOutcome =
  | { readonly kind: "healthy"; readonly run: ContainerRunResult; readonly health: ProbeResult }
  | { readonly kind: "failed"; readonly failure: SwapFailure };

type ProbeOutcome =
  | { readonly kind: "result"; readonly result: ProbeResult }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout"; readonly deadlineMs: number };

/**
 * Runs one health-gated swap.
 *
 * The function does not throw for an unhealthy candidate: it reverts, records
 * the unchanged image pair and the recovery facts, and returns
 * {@link SwapRevertedResult}. The command layer maps `status === "reverted"` to
 * `HealthError` (exit 4, `UPD-FR-02`). It only throws when the pre-swap stop
 * fails before the candidate is attempted, or when the input is invalid.
 */
export async function swapApp(
  request: SwapRequest,
  dependencies: SwapDependencies = {},
): Promise<SwapResult> {
  const context = createContext(request, dependencies);

  validateImageReference("candidateImage", context.candidateImage);
  validateImageReference("currentImage", context.currentImage);
  if (context.previousImage !== null) {
    validateImageReference("previousImage", context.previousImage);
  }

  emit(context, "stopping", `stopping and removing container "${containerName(context.app)}"`);
  await stopCurrentContainer(context);

  const outcome = await attemptCandidate(context);
  if (outcome.kind === "healthy") {
    const stateRecorded = recordKept(context, outcome.run, outcome.health);
    emit(
      context,
      "keeping",
      `candidate ${context.candidateImage} is healthy; ${context.currentImage} is now the rollback target`,
    );

    return {
      status: "kept",
      app: context.app,
      container: containerName(context.app),
      image: context.candidateImage,
      candidateImage: context.candidateImage,
      previousImage: context.currentImage,
      images: { current: context.candidateImage, previous: context.currentImage },
      containerId: outcome.run.id,
      health: outcome.health,
      stateRecorded,
      phases: [...context.phases],
      warnings: [...context.warnings],
    };
  }

  return revert(context, outcome.failure);
}

function createContext(request: SwapRequest, dependencies: SwapDependencies): SwapContext {
  const app = validateAppName(request.app);

  return {
    request,
    app,
    candidateImage: request.candidateImage,
    currentImage: request.currentImage,
    previousImage: request.previousImage ?? null,
    environment: request.environment,
    recoverySpec: request.recoverySpec ?? request.spec,
    recoveryEnvironment: request.recoveryEnvironment ?? request.environment,
    runtime: dependencies.runtime ?? createDefaultSwapRuntime(),
    prober: dependencies.prober ?? createDefaultSwapProber(),
    reporter: dependencies.reporter ?? createDefaultSwapReporter(),
    state: dependencies.state,
    clock: dependencies.clock ?? (() => new Date()),
    phases: [],
    warnings: [],
  };
}

/**
 * Stops the currently serving container. A missing container is not a failure:
 * `update` may deliberately recreate an app whose container disappeared
 * (`UPD-FR-04`). Any other stop failure aborts before the candidate starts, so
 * the old container is still the one in place.
 */
async function stopCurrentContainer(context: SwapContext): Promise<void> {
  try {
    await context.runtime.stopContainer({
      app: context.app,
      timeSeconds: SWAP_STOP_GRACE_SECONDS,
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return;
    }

    throw error;
  }
}

/**
 * Frees the fixed container name and starts the candidate. Any failure from
 * here on is a candidate failure and must enter the revert path.
 */
async function attemptCandidate(context: SwapContext): Promise<CandidateOutcome> {
  try {
    // The old container is stopped; remove it so `podman run` can reuse the
    // name. The image stays in place and is never deleted here.
    await context.runtime.removeContainer({
      app: context.app,
      force: true,
      ignoreMissing: true,
    });
  } catch (error) {
    return { kind: "failed", failure: failureFromError("prepare", error) };
  }

  let run: ContainerRunResult;
  try {
    run = await startContainer(context, context.candidateImage);
  } catch (error) {
    return { kind: "failed", failure: failureFromError("start", error) };
  }

  const probe = await probeWithinDeadline(context);
  if (probe.kind === "result") {
    if (probe.result.healthy) {
      return { kind: "healthy", run, health: probe.result };
    }

    return { kind: "failed", failure: unhealthyFailure(probe.result) };
  }

  if (probe.kind === "timeout") {
    return {
      kind: "failed",
      failure: {
        stage: "budget",
        code: SWAP_FAILURE_CODES.PROBE_TIMEOUT,
        message: `the probe did not finish within ${probe.deadlineMs}ms (startup budget ${context.request.spec.health_startup_ms}ms)`,
      },
    };
  }

  return { kind: "failed", failure: failureFromError("probe", probe.error) };
}

/**
 * Stops and removes the candidate, restarts the image that was serving before
 * the command, and probes it once. Recovery failures are reported rather than
 * thrown so the caller can distinguish "previous is serving again" from
 * "previous could not be restored" (`UPD-NF-01`).
 */
async function revert(context: SwapContext, failure: SwapFailure): Promise<SwapRevertedResult> {
  emit(
    context,
    "reverting",
    `candidate ${context.candidateImage} failed (${failure.message}); restoring ${context.currentImage}`,
  );

  await cleanupCandidate(context);

  const recovery = await recoverPrevious(context);
  const stateRecorded = recordReverted(context, failure, recovery);
  emit(context, "reverted", recovery.message);

  return {
    status: "reverted",
    app: context.app,
    container: containerName(context.app),
    image: context.currentImage,
    candidateImage: context.candidateImage,
    previousImage: context.previousImage,
    images: { current: context.currentImage, previous: context.previousImage },
    failure,
    recovery,
    stateRecorded,
    phases: [...context.phases],
    warnings: [...context.warnings],
  };
}

async function cleanupCandidate(context: SwapContext): Promise<void> {
  await stopContainerQuietly(context);
  try {
    await context.runtime.removeContainer({
      app: context.app,
      force: true,
      ignoreMissing: true,
    });
  } catch (error) {
    warn(
      context,
      `could not remove the failed candidate container "${containerName(context.app)}": ${messageOf(error)}`,
    );
  }
}

async function recoverPrevious(context: SwapContext): Promise<SwapRecovery> {
  let run: ContainerRunResult;
  try {
    // The reverting/reverted phases already narrate the recovery; emitting a
    // second starting/probing pair would make the phase order ambiguous.
    run = await startContainer(
      context,
      context.currentImage,
      false,
      context.recoverySpec,
      context.recoveryEnvironment,
    );
  } catch (error) {
    return {
      attempted: true,
      image: context.currentImage,
      started: false,
      healthy: false,
      containerId: null,
      code: errorCode(error, SWAP_FAILURE_CODES.RECOVERY_START_FAILED),
      message: `the previous image ${context.currentImage} could not be restarted: ${messageOf(error)}`,
    };
  }

  const probe = await probeWithinDeadline(context, false, context.recoverySpec);
  if (probe.kind === "result") {
    const health = probe.result;
    return {
      attempted: true,
      image: context.currentImage,
      started: true,
      healthy: health.healthy,
      containerId: run.id,
      ...(health.healthy ? {} : { code: SWAP_FAILURE_CODES.RECOVERY_UNHEALTHY }),
      message: health.healthy
        ? `the previous image ${context.currentImage} is serving again (probe ${health.target}, ${health.attempts} attempt(s))`
        : `the previous image ${context.currentImage} did not become healthy: ${probeReason(health)}`,
      health,
    };
  }

  if (probe.kind === "timeout") {
    return {
      attempted: true,
      image: context.currentImage,
      started: true,
      healthy: false,
      containerId: run.id,
      code: SWAP_FAILURE_CODES.RECOVERY_PROBE_TIMEOUT,
      message: `the previous image ${context.currentImage} did not answer within ${probe.deadlineMs}ms`,
    };
  }

  return {
    attempted: true,
    image: context.currentImage,
    started: true,
    healthy: false,
    containerId: run.id,
    code: errorCode(probe.error, SWAP_FAILURE_CODES.RECOVERY_PROBE_FAILED),
    message: `the previous image ${context.currentImage} could not be probed: ${messageOf(probe.error)}`,
  };
}

async function stopContainerQuietly(context: SwapContext): Promise<void> {
  try {
    await context.runtime.stopContainer({
      app: context.app,
      timeSeconds: SWAP_STOP_GRACE_SECONDS,
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return;
    }

    warn(
      context,
      `could not stop the failed candidate container "${containerName(context.app)}": ${messageOf(error)}`,
    );
  }
}

function startContainer(
  context: SwapContext,
  image: string,
  announce = true,
  spec: SwapSpec = context.request.spec,
  environment: Readonly<Record<string, string>> = context.environment,
): Promise<ContainerRunResult> {
  if (announce) {
    emit(
      context,
      "starting",
      `starting ${image} on ${spec.bind}:${spec.port} (container port ${spec.container_port})`,
    );
  }

  return context.runtime.runContainer({
    app: context.app,
    image,
    port: spec.port,
    containerPort: spec.container_port,
    bind: spec.bind,
    environment,
    volumes: spec.volumes,
  });
}

async function probeWithinDeadline(
  context: SwapContext,
  announce = true,
  spec: SwapSpec = context.request.spec,
): Promise<ProbeOutcome> {
  const deadlineMs = swapProbeDeadlineMs(spec);
  if (announce) {
    emit(
      context,
      "probing",
      `probing ${formatProbeTarget(spec.probe, spec.port, spec.health_path)} for up to ${spec.health_startup_ms}ms`,
    );
  }

  // `Promise.resolve().then` converts a synchronous throw into a rejection and
  // keeps a late rejection handled after the deadline wins the race.
  const pending = Promise.resolve()
    .then(() => context.prober.probe(spec))
    .then(
      (result): ProbeOutcome => ({ kind: "result", result }),
      (error): ProbeOutcome => ({ kind: "error", error }),
    );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProbeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout", deadlineMs }), deadlineMs);
  });

  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Records the successful image pair only after the probe has confirmed health. */
function recordKept(context: SwapContext, run: ContainerRunResult, health: ProbeResult): boolean {
  if (context.state === undefined || context.state === null) {
    return false;
  }

  try {
    context.state.update({
      images: { current: context.candidateImage, previous: context.currentImage },
      containerId: run.id,
      health: {
        status: "healthy",
        checkedAt: context.clock().toISOString(),
        detail:
          `candidate ${context.candidateImage} healthy after ${health.attempts} attempt(s); ` +
          `${context.currentImage} is the rollback target`,
      },
    });
    return true;
  } catch (error) {
    warn(context, `could not record the healthy candidate in state.json: ${messageOf(error)}`);
    return false;
  }
}

/**
 * Records the revert outcome. The image pair is deliberately omitted so the
 * current and previous references stay exactly as they were (`UPD-FR-03`).
 */
function recordReverted(
  context: SwapContext,
  failure: SwapFailure,
  recovery: SwapRecovery,
): boolean {
  if (context.state === undefined || context.state === null) {
    return false;
  }

  const status: HealthStatus = recovery.healthy ? "healthy" : "unhealthy";
  const outcome = recovery.healthy
    ? `previous image ${context.currentImage} is serving again`
    : `previous image ${context.currentImage} is not healthy: ${recovery.message}`;

  try {
    context.state.update({
      containerId: recovery.containerId,
      health: {
        status,
        checkedAt: context.clock().toISOString(),
        detail: `candidate ${context.candidateImage} failed: ${failure.message}; ${outcome}`,
      },
    });
    return true;
  } catch (error) {
    warn(context, `could not record the reverted state in state.json: ${messageOf(error)}`);
    return false;
  }
}

function unhealthyFailure(health: ProbeResult): SwapFailure {
  return {
    stage: "probe",
    code: SWAP_FAILURE_CODES.CANDIDATE_UNHEALTHY,
    message: probeReason(health),
    health,
  };
}

function failureFromError(stage: Exclude<SwapFailureStage, "budget">, error: unknown): SwapFailure {
  const code =
    stage === "start"
      ? errorCode(error, SWAP_FAILURE_CODES.CANDIDATE_START_FAILED)
      : stage === "prepare"
        ? errorCode(error, SWAP_FAILURE_CODES.PREPARE_FAILED)
        : errorCode(error, SWAP_FAILURE_CODES.PROBE_FAILED);

  return {
    stage,
    code,
    message: messageOf(error),
  };
}

function probeReason(health: ProbeResult): string {
  const reason =
    health.lastError?.message ??
    (health.lastStatus === undefined
      ? "no successful probe within the startup budget"
      : `HTTP ${health.lastStatus}`);

  return `${reason} after ${health.attempts} attempt(s)`;
}

function emit(context: SwapContext, phase: SwapPhase, message: string): void {
  context.phases.push(phase);
  try {
    context.reporter.phase(phase, message);
  } catch {
    // Progress output is advisory; a broken stream must not corrupt the swap.
  }
}

function warn(context: SwapContext, message: string): void {
  context.warnings.push(message);
}

function errorCode(error: unknown, fallback: string): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }

  return fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateImageReference(field: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UsageError(`invalid swap input "${field}"`, {
      code: SWAP_FAILURE_CODES.INVALID_INPUT,
      details: { setting: field, reason: "must be a non-empty image reference" },
      remediation: "Pass the image reference recorded by the build or state.json.",
    });
  }

  return value;
}
