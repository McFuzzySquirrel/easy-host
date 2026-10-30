/**
 * HTTP and TCP readiness probes (`ADD-FR-04`, `ADD-NF-02`).
 *
 * A probe is a bounded loop, never a single unbounded request:
 *
 * - the first attempt starts immediately;
 * - HTTP mode requests `http://127.0.0.1:<port><health_path>` and treats any
 *   2xx or 3xx status as healthy; 4xx, 5xx, a network error, or a timeout is an
 *   attempt failure;
 * - TCP mode connects to `127.0.0.1:<port>` and treats a completed connection
 *   as healthy;
 * - a failed attempt is followed by the declared interval;
 * - no attempt starts at or after the startup budget, and an attempt near the
 *   budget is clamped to the remaining time, so the loop can never run past it.
 *
 * Defaults come from the config schema (`APP_SPEC_DEFAULTS`): a 2s interval, a
 * 5s per-attempt timeout, and a 90s total budget. They are overridable per app.
 *
 * The clock and the HTTP client are injectable so unit tests are deterministic:
 * a fake clock advances virtual time, and a fake fetch can hang until its
 * per-attempt timer aborts it. The default TCP connector is exported so tests
 * and callers can replace it without a real socket.
 *
 * Response bodies and headers are never read, retained, or included in a
 * result. A failure carries only a stable kind, a stable code, a short reason,
 * the HTTP status where one exists, and the attempt timeout where relevant.
 * Invalid options are a `UsageError` (exit 1); an unhealthy probe is a normal
 * result that the lifecycle layer maps to exit 4.
 */

import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import { UsageError } from "../cli/errors.js";
import { APP_SPEC_DEFAULTS, MAX_PORT, MIN_HOST_PORT, type PROBE_KINDS } from "../config/schema.js";

/**
 * The loopback address required by `ADD-FR-04`. It is fixed rather than
 * configurable because the container publishes its port on the host and the
 * probe must never be pointed at another machine.
 */
export const PROBE_HOST = "127.0.0.1";

/**
 * Documented timing defaults, re-exported from the single config source so a
 * schema default change updates the probe too.
 */
export const PROBE_DEFAULTS = {
  kind: APP_SPEC_DEFAULTS.probe,
  healthPath: APP_SPEC_DEFAULTS.health_path,
  intervalMs: APP_SPEC_DEFAULTS.health_interval_ms,
  timeoutMs: APP_SPEC_DEFAULTS.health_timeout_ms,
  startupMs: APP_SPEC_DEFAULTS.health_startup_ms,
} as const;

/** Upper bound mirrored from the config schema's timing validation. */
export const MAX_PROBE_TIMING_MS = 86_400_000;

/** Stable diagnostic codes used by {@link ProbeFailure} and option errors. */
export const PROBE_FAILURE_CODES = {
  HTTP_STATUS: "PROBE_HTTP_STATUS",
  TIMEOUT: "PROBE_TIMEOUT",
  CONNECTION_REFUSED: "PROBE_CONNECTION_REFUSED",
  NETWORK: "PROBE_NETWORK_ERROR",
  INVALID_OPTIONS: "INVALID_PROBE_OPTIONS",
} as const;

/** Probe kinds are shared with the config schema. */
export type ProbeKind = (typeof PROBE_KINDS)[number];

/** Why a single attempt failed. A healthy probe reports none. */
export type ProbeFailureKind = "http-status" | "timeout" | "connection-refused" | "network";

/**
 * One failed attempt. `message` is a short, stable reason such as
 * `connection refused` or `HTTP 500`; it never contains a response body.
 */
export interface ProbeFailure {
  readonly kind: ProbeFailureKind;
  readonly code: string;
  readonly message: string;
  /** HTTP status, present only for an HTTP status failure or success. */
  readonly status: number | undefined;
  /** Effective per-attempt timeout, present only for a timeout failure. */
  readonly timeoutMs: number | undefined;
  /** System errno or Undici code that explained a network failure. */
  readonly causeCode: string | undefined;
}

/** The complete, secret-free outcome of a probe loop. */
export interface ProbeResult {
  /** Human label that mirrors the PRD lifecycle states. */
  readonly state: "healthy" | "unhealthy";
  readonly healthy: boolean;
  readonly kind: ProbeKind;
  readonly port: number;
  /** `http://127.0.0.1:<port><path>` or `tcp://127.0.0.1:<port>`. */
  readonly target: string;
  /** Number of attempts made, including the successful or final failure. */
  readonly attempts: number;
  /** Wall-clock time from the first attempt to the result, in milliseconds. */
  readonly elapsedMs: number;
  /** Last HTTP status observed, when the probe used HTTP mode. */
  readonly lastStatus: number | undefined;
  /** Last attempt failure, or `undefined` when the probe became healthy. */
  readonly lastError: ProbeFailure | undefined;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly startupMs: number;
}

/** An opaque handle owned by the clock that created it. */
export interface ProbeTimer {
  readonly handle: unknown;
}

/**
 * Time and timer seam. Tests advance a virtual clock; production uses
 * `performance.now` and Node timers.
 */
export interface ProbeClock {
  /** Monotonic milliseconds. */
  now(): number;
  /** Waits for the requested interval. */
  sleep(ms: number): Promise<void>;
  /** Schedules a cancellable callback. */
  setTimeout(callback: () => void, ms: number): ProbeTimer;
  /** Cancels a callback created by {@link ProbeClock.setTimeout}. */
  clearTimeout(timer: ProbeTimer): void;
}

/** The narrow fetch surface the HTTP probe needs. */
export interface ProbeFetchInit {
  readonly method: "GET";
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}

/** Injectable HTTP client. Defaults to Node's global `fetch`. */
export type ProbeFetch = (url: string, init: ProbeFetchInit) => Promise<Response>;

/** One TCP connection attempt. The request is aborted on timeout. */
export interface TcpConnectRequest {
  readonly host: string;
  readonly port: number;
  readonly signal: AbortSignal;
}

/** Injectable TCP connector. Defaults to {@link connectTcp}. */
export type TcpConnector = (request: TcpConnectRequest) => Promise<void>;

/** Runtime seams that tests replace without changing the probe contract. */
export interface ProbeRuntimeOptions {
  clock?: ProbeClock;
  fetch?: ProbeFetch;
  tcpConnect?: TcpConnector;
}

/** Public probe input. Every value has the schema default applied here too. */
export interface ProbeOptions extends ProbeRuntimeOptions {
  /** Declared host port. Required, and validated to the unprivileged range. */
  port: number;
  probe?: ProbeKind;
  healthPath?: string;
  intervalMs?: number;
  timeoutMs?: number;
  startupMs?: number;
}

/** The config fields a probe needs, structurally satisfied by `AppSpec`. */
export interface ProbeAppSpec {
  readonly port: number;
  readonly probe: ProbeKind;
  readonly health_path: string;
  readonly health_interval_ms: number;
  readonly health_timeout_ms: number;
  readonly health_startup_ms: number;
}

interface ResolvedProbeOptions {
  port: number;
  kind: ProbeKind;
  healthPath: string;
  intervalMs: number;
  timeoutMs: number;
  startupMs: number;
  clock: ProbeClock;
  fetch: ProbeFetch;
  tcpConnect: TcpConnector;
}

type AttemptOutcome =
  | { readonly ok: true; readonly status: number | undefined }
  | { readonly ok: false; readonly failure: ProbeFailure };

const DEFAULT_TIMEOUT_ABORT_CODE = "PROBE_TIMEOUT";

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is intentional input hardening.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Network errno and Undici codes mapped to a short operator-facing reason. The
 * raw error message is never used because library wording can include request
 * context we do not want in diagnostics.
 */
const NETWORK_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset by peer",
  ETIMEDOUT: "connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "connection timed out",
  UND_ERR_SOCKET: "connection closed",
  ENETUNREACH: "network unreachable",
  EHOSTUNREACH: "host unreachable",
  ENOTFOUND: "host not found",
  EAI_AGAIN: "temporary name resolution failure",
  ABORT_ERR: "request aborted",
};

const systemProbeClock: ProbeClock = {
  now: () => performance.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  setTimeout: (callback, ms) => ({ handle: setTimeout(callback, ms) }),
  clearTimeout: (timer) => {
    clearTimeout(timer.handle as NodeJS.Timeout);
  },
};

const defaultFetch: ProbeFetch = (url, init) => fetch(url, init);

/**
 * The production TCP connector. It resolves as soon as the connection is
 * established and destroys the socket immediately; the attempt timer aborts it
 * on timeout, which the pending promise observes as an AbortError.
 */
export const connectTcp: TcpConnector = ({ host, port, signal }) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };

    const onAbort = (): void => {
      finish(abortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });

/**
 * Builds the loopback target shown in status and error output.
 */
export function formatProbeTarget(kind: ProbeKind, port: number, healthPath: string): string {
  return kind === "http"
    ? `http://${PROBE_HOST}:${port}${healthPath}`
    : `tcp://${PROBE_HOST}:${port}`;
}

/**
 * Probes an app spec with its declared probe kind, path, and timings.
 * `runtime` can inject a clock, fetch, or TCP connector for tests.
 */
export function probeApp(
  spec: ProbeAppSpec,
  runtime: ProbeRuntimeOptions = {},
): Promise<ProbeResult> {
  return probeHealth({
    port: spec.port,
    probe: spec.probe,
    healthPath: spec.health_path,
    intervalMs: spec.health_interval_ms,
    timeoutMs: spec.health_timeout_ms,
    startupMs: spec.health_startup_ms,
    ...runtime,
  });
}

/**
 * Runs the probe loop and resolves with a structured result.
 *
 * A failed probe is not an exception: the lifecycle layer decides whether that
 * means exit 4 and cleanup. Only invalid inputs (which indicate a programming
 * or config error) throw.
 */
export async function probeHealth(options: ProbeOptions): Promise<ProbeResult> {
  const config = resolveProbeOptions(options);
  const target = formatProbeTarget(config.kind, config.port, config.healthPath);
  const startedAt = config.clock.now();
  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: ProbeFailure | undefined;

  while (true) {
    if (attempts > 0) {
      const remaining = config.startupMs - (config.clock.now() - startedAt);
      if (remaining <= 0) {
        break;
      }
      await config.clock.sleep(Math.min(config.intervalMs, remaining));
    }

    const remaining = config.startupMs - (config.clock.now() - startedAt);
    if (remaining <= 0) {
      break;
    }

    attempts += 1;
    const attemptTimeoutMs = Math.min(config.timeoutMs, remaining);
    const outcome = await runAttempt(config, target, attemptTimeoutMs);

    if (outcome.ok) {
      return buildResult(
        config,
        target,
        attempts,
        startedAt,
        true,
        outcome.status ?? lastStatus,
        undefined,
      );
    }

    lastError = outcome.failure;
    if (outcome.failure.status !== undefined) {
      lastStatus = outcome.failure.status;
    }
  }

  return buildResult(config, target, attempts, startedAt, false, lastStatus, lastError);
}

function buildResult(
  config: ResolvedProbeOptions,
  target: string,
  attempts: number,
  startedAt: number,
  healthy: boolean,
  lastStatus: number | undefined,
  lastError: ProbeFailure | undefined,
): ProbeResult {
  return {
    state: healthy ? "healthy" : "unhealthy",
    healthy,
    kind: config.kind,
    port: config.port,
    target,
    attempts,
    elapsedMs: Math.max(0, Math.round(config.clock.now() - startedAt)),
    lastStatus,
    lastError,
    intervalMs: config.intervalMs,
    timeoutMs: config.timeoutMs,
    startupMs: config.startupMs,
  };
}

/**
 * Bounds one attempt with a clock timer and an AbortController. The race is
 * deliberate: even a client that ignores its signal cannot keep the probe
 * waiting past the per-attempt timeout (`ADD-NF-02`).
 */
function runAttempt(
  config: ResolvedProbeOptions,
  target: string,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timer: ProbeTimer | undefined;
  let timedOut = false;

  const timeout = new Promise<AttemptOutcome>((resolve) => {
    timer = config.clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ ok: false, failure: timeoutFailure(timeoutMs) });
    }, timeoutMs);
  });

  const attempt = executeAttempt(config, target, controller.signal).then(
    (outcome) => outcome,
    (error: unknown): AttemptOutcome => {
      if (timedOut) {
        return { ok: false, failure: timeoutFailure(timeoutMs) };
      }
      return { ok: false, failure: networkFailure(error) };
    },
  );

  return Promise.race([attempt, timeout]).finally(() => {
    if (timer !== undefined) {
      config.clock.clearTimeout(timer);
    }
  });
}

function executeAttempt(
  config: ResolvedProbeOptions,
  target: string,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  return config.kind === "http" ? attemptHttp(config, target, signal) : attemptTcp(config, signal);
}

async function attemptHttp(
  config: ResolvedProbeOptions,
  target: string,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  const response = await config.fetch(target, {
    method: "GET",
    redirect: "manual",
    signal,
  });

  // The body is deliberately discarded unread: it may contain secret material
  // and no part of it is needed to decide health.
  discardBody(response);

  if (response.status >= 200 && response.status < 400) {
    return { ok: true, status: response.status };
  }

  return {
    ok: false,
    failure: {
      kind: "http-status",
      code: PROBE_FAILURE_CODES.HTTP_STATUS,
      message: `HTTP ${response.status}`,
      status: response.status,
      timeoutMs: undefined,
      causeCode: undefined,
    },
  };
}

async function attemptTcp(
  config: ResolvedProbeOptions,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  await config.tcpConnect({ host: PROBE_HOST, port: config.port, signal });
  return { ok: true, status: undefined };
}

function discardBody(response: Response): void {
  const body = response.body;
  if (body === null || body === undefined) {
    return;
  }

  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // The attempt is already bounded; an uncancellable body is abandoned.
    return;
  }
}

function timeoutFailure(timeoutMs: number): ProbeFailure {
  return {
    kind: "timeout",
    code: PROBE_FAILURE_CODES.TIMEOUT,
    message: `timed out after ${timeoutMs} ms`,
    status: undefined,
    timeoutMs,
    causeCode: DEFAULT_TIMEOUT_ABORT_CODE,
  };
}

function networkFailure(error: unknown): ProbeFailure {
  const causeCode = findErrorCode(error);
  const aborted = isAbortError(error);
  const code = causeCode ?? (aborted ? "ABORT_ERR" : undefined);
  const message =
    code === undefined ? "network error" : (NETWORK_FAILURE_MESSAGES[code] ?? "network error");
  const refused = code === "ECONNREFUSED";

  return {
    kind: refused ? "connection-refused" : "network",
    code: refused ? PROBE_FAILURE_CODES.CONNECTION_REFUSED : PROBE_FAILURE_CODES.NETWORK,
    message,
    status: undefined,
    timeoutMs: undefined,
    causeCode: code,
  };
}

function findErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || error === null || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof candidate.code === "string" && candidate.code.length > 0) {
    return candidate.code;
  }

  const fromCause = findErrorCode(candidate.cause, depth + 1);
  if (fromCause !== undefined) {
    return fromCause;
  }

  if (Array.isArray(candidate.errors)) {
    for (const nested of candidate.errors) {
      const code = findErrorCode(nested, depth + 1);
      if (code !== undefined) {
        return code;
      }
    }
  }

  return undefined;
}

function isAbortError(error: unknown, depth = 0): boolean {
  if (depth > 4 || error === null || typeof error !== "object") {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (candidate.name === "AbortError" || candidate.code === "ABORT_ERR") {
    return true;
  }

  return isAbortError(candidate.cause, depth + 1);
}

function abortError(): Error {
  const error = new Error("probe attempt aborted");
  error.name = "AbortError";
  return error;
}

function resolveProbeOptions(options: ProbeOptions): ResolvedProbeOptions {
  const port = options.port;
  if (!Number.isInteger(port) || port < MIN_HOST_PORT || port > MAX_PORT) {
    invalidProbeOption(
      "port",
      `must be a whole number between ${MIN_HOST_PORT} and ${MAX_PORT}`,
      port,
    );
  }

  const kind = options.probe ?? PROBE_DEFAULTS.kind;
  if (kind !== "http" && kind !== "tcp") {
    invalidProbeOption("probe", 'must be one of "http" or "tcp"', kind);
  }

  const healthPath = options.healthPath ?? PROBE_DEFAULTS.healthPath;
  if (!isValidHealthPath(healthPath)) {
    invalidProbeOption(
      "health_path",
      "must be an absolute HTTP path starting with '/' with no spaces or '..' segments",
      healthPath,
    );
  }

  const intervalMs = options.intervalMs ?? PROBE_DEFAULTS.intervalMs;
  assertTiming("health_interval_ms", intervalMs);

  const timeoutMs = options.timeoutMs ?? PROBE_DEFAULTS.timeoutMs;
  assertTiming("health_timeout_ms", timeoutMs);

  const startupMs = options.startupMs ?? PROBE_DEFAULTS.startupMs;
  assertTiming("health_startup_ms", startupMs);

  return {
    port,
    kind,
    healthPath,
    intervalMs,
    timeoutMs,
    startupMs,
    clock: options.clock ?? systemProbeClock,
    fetch: options.fetch ?? defaultFetch,
    tcpConnect: options.tcpConnect ?? connectTcp,
  };
}

function assertTiming(setting: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PROBE_TIMING_MS) {
    invalidProbeOption(
      setting,
      `must be a whole number of milliseconds between 1 and ${MAX_PROBE_TIMING_MS}`,
      value,
    );
  }
}

function isValidHealthPath(value: string): boolean {
  if (!value.startsWith("/") || value.length === 0 || value.length > 2048) {
    return false;
  }
  if (/[\s\\]/.test(value) || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "..");
}

function invalidProbeOption(setting: string, reason: string, received: unknown): never {
  throw new UsageError(`invalid probe option "${setting}": ${reason}`, {
    code: PROBE_FAILURE_CODES.INVALID_OPTIONS,
    details: {
      setting,
      reason,
      received: describeValue(received),
    },
    remediation: "Check the port, health path, and probe timings in config.toml and retry.",
  });
}

function describeValue(value: unknown): string {
  const rendered = typeof value === "string" ? JSON.stringify(value) : String(value);
  return rendered.length > 80 ? `${rendered.slice(0, 77)}...` : rendered;
}
