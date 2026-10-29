/**
 * Error taxonomy, exit-code contract, and secret-safe error rendering.
 *
 * `PRE-FR-05` makes exit codes a public contract: 0 success, 1 usage, 2
 * prerequisite or environment, 3 build, 4 health, 5 not found, 6 conflict or
 * lock held, 7 unexpected. `PRD-NF-02` requires every failure to name the
 * failed check, the reason, and a remediation command; `PRD-NF-10` requires
 * secrets to stay out of human and JSON diagnostics.
 *
 * The renderer intentionally emits no colour or ANSI escapes. Status meaning
 * comes from text labels, matching the terminal accessibility rules
 * (`PRD-ACC-02`, `PRD-ACC-05`).
 */

/**
 * The complete exit-code table from PRD section 7.3 and `PRE-FR-05`.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  USAGE: 1,
  PREREQUISITE: 2,
  BUILD: 3,
  HEALTH: 4,
  NOT_FOUND: 5,
  CONFLICT: 6,
  INTERNAL: 7,
} as const;

/**
 * A number in the public exit-code contract.
 */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Placeholder written in place of a redacted value. It is stable so tests and
 * operators can recognise intentional redaction.
 */
export const REDACTED = "[redacted]";

/**
 * The default remediation for an unexpected exception: point at the debug
 * switch and the bug-report path instead of dumping a stack trace.
 */
export const BUG_REPORT_HINT =
  "Re-run with EASY_HOST_DEBUG=1 to capture diagnostics, then report this as an easy-host bug.";

/**
 * Structured context attached to an error. Values stay primitive or nested so
 * both the human renderer and the JSON document can serialize them without
 * losing key names.
 */
export type ErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | readonly ErrorDetailValue[]
  | { readonly [key: string]: ErrorDetailValue };

export type ErrorDetails = Readonly<Record<string, ErrorDetailValue>>;

export interface ErrorInit {
  /** Overrides the class default for a narrower, stable diagnostic code. */
  code?: string;
  /** Structured context rendered as indented `key: value` lines. */
  details?: ErrorDetails;
  /** Concrete next command or instruction, rendered as the `next:` line. */
  remediation?: string;
  /** Original exception, kept for `EASY_HOST_DEBUG=1` output and tests. */
  cause?: unknown;
}

/**
 * Base class for every expected failure. `exitCode` is the public contract;
 * `code` is the stable machine-readable diagnostic key used in JSON output.
 */
export class EasyHostError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly details: ErrorDetails;
  readonly remediation: string | undefined;

  constructor(summary: string, exitCode: ExitCode, defaultCode: string, init: ErrorInit = {}) {
    super(singleLine(summary), errorOptions(init.cause));
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.code = init.code ?? defaultCode;
    this.details = init.details ?? {};
    this.remediation = init.remediation;
  }
}

/** Exit 1: invalid arguments, invalid config, or an unknown command. */
export class UsageError extends EasyHostError {
  constructor(summary: string, init: ErrorInit = {}) {
    super(summary, EXIT_CODES.USAGE, "USAGE_ERROR", init);
  }
}

/** Exit 2: a missing or unusable host prerequisite. */
export class PrerequisiteError extends EasyHostError {
  constructor(summary: string, init: ErrorInit = {}) {
    super(summary, EXIT_CODES.PREREQUISITE, "PREREQUISITE_FAILED", init);
  }
}

/** Exit 3: a clone, Railpack, or BuildKit failure. */
export class BuildError extends EasyHostError {
  constructor(summary: string, init: ErrorInit = {}) {
    super(summary, EXIT_CODES.BUILD, "BUILD_FAILED", init);
  }
}

/** Exit 4: a readiness probe failed or an app is unhealthy. */
export class HealthError extends EasyHostError {
  constructor(summary: string, init: ErrorInit = {}) {
    super(summary, EXIT_CODES.HEALTH, "HEALTH_CHECK_FAILED", init);
  }
}

/** Exit 5: the requested app, image, or file does not exist. */
export class NotFoundError extends EasyHostError {
  constructor(summary: string, init: ErrorInit = {}) {
    super(summary, EXIT_CODES.NOT_FOUND, "NOT_FOUND", init);
  }
}

/** Exit 6: a port, name, or lock conflict. */
export class ConflictError extends EasyHostError {
  constructor(summary: string, init: ErrorInit = {}) {
    super(summary, EXIT_CODES.CONFLICT, "CONFLICT", init);
  }
}

/** Exit 7: an unexpected exception, including a swallowed programming bug. */
export class InternalError extends EasyHostError {
  constructor(summary: string, init: ErrorInit = {}) {
    super(summary, EXIT_CODES.INTERNAL, "INTERNAL_ERROR", {
      ...init,
      remediation: init.remediation ?? BUG_REPORT_HINT,
    });
  }
}

/** A writable stream, narrowed so tests can inject a recorder. */
export interface ErrorOutputStream {
  write(chunk: string): unknown;
}

export interface ErrorRenderOptions {
  /** Writes one JSON document to stdout instead of human text to stderr. */
  json?: boolean;
  /** Overrides the `EASY_HOST_DEBUG=1` environment check. */
  debug?: boolean;
  /** Environment used for the debug check. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Known secret values scrubbed wherever they appear in rendered text. */
  secrets?: readonly string[];
  /** Destination for `--json` output. Defaults to `process.stdout`. */
  stdout?: ErrorOutputStream;
  /** Destination for human output. Defaults to `process.stderr`. */
  stderr?: ErrorOutputStream;
}

/**
 * The stable `--json` error envelope. `schemaVersion` is part of the output
 * contract (PRD open question 10); `details` is always an object and
 * `remediation` is always present, using `null` when there is no next step.
 */
export interface ErrorDocument {
  schemaVersion: 1;
  error: {
    code: string;
    exitCode: ExitCode;
    summary: string;
    details: ErrorDetails;
    remediation: string | null;
  };
}

/**
 * True when the value is one of the eight documented exit codes.
 */
export function isExitCode(value: unknown): value is ExitCode {
  return (
    typeof value === "number" && Object.values(EXIT_CODES).some((candidate) => candidate === value)
  );
}

/**
 * Normalizes any thrown value into an {@link EasyHostError}. Typed errors from
 * other modules (`paths.ts` predates this taxonomy) are adopted by shape so a
 * single exit-code mapper covers the whole CLI.
 */
export function toEasyHostError(error: unknown): EasyHostError {
  if (error instanceof EasyHostError) {
    return error;
  }

  const adopted = adoptTypedError(error);
  if (adopted !== undefined) {
    return adopted;
  }

  return new InternalError(unexpectedSummary(error), { cause: error });
}

/**
 * Maps any thrown value to the documented exit code. Unknown exceptions and
 * anything without a recognised numeric `exitCode` map to 7.
 */
export function toExitCode(error: unknown): ExitCode {
  return toEasyHostError(error).exitCode;
}

/**
 * True when the value is already a typed easy-host failure.
 */
export function isEasyHostError(value: unknown): value is EasyHostError {
  return value instanceof EasyHostError;
}

/**
 * Renders the human error shape from PRD section 12.3:
 *
 * ```text
 * easy-host: health check failed for "api"
 *   probe:    GET http://127.0.0.1:8081/
 *   reason:   connection refused
 *   next:     easy-host logs api --tail 200
 * ```
 *
 * Summary, details, and remediation are separate lines. A stack trace is only
 * appended when `EASY_HOST_DEBUG=1` is set (or `debug: true` is passed).
 */
export function formatError(error: unknown, options: ErrorRenderOptions = {}): string {
  const typed = toEasyHostError(error);
  const line = describe(typed, options);
  const lines = [`easy-host: ${line.summary}`];

  const entries: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(line.details)) {
    entries.push([detailLabel(key), renderDetailValue(value)]);
  }

  if (line.remediation !== undefined && line.remediation.length > 0) {
    entries.push(["next:", line.remediation]);
  }

  const labelWidth = entries.reduce(
    (width, [label]) => Math.max(width, label.length + 1),
    MIN_LABEL_WIDTH,
  );

  for (const [label, value] of entries) {
    const [first = "", ...continuation] = value.split("\n");
    lines.push(`  ${label.padEnd(labelWidth)}${first}`);
    for (const part of continuation) {
      lines.push(`  ${" ".repeat(labelWidth)}${part}`);
    }
  }

  if (isDebug(options)) {
    const stack = stackOf(typed);
    if (stack !== undefined) {
      for (const entry of stack.split("\n")) {
        lines.push(`  ${entry}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Serializes the error envelope. Exactly one JSON document is returned, with
 * no ANSI escapes and every detail redacted before serialization.
 */
export function toErrorDocument(error: unknown, options: ErrorRenderOptions = {}): ErrorDocument {
  const typed = toEasyHostError(error);
  const line = describe(typed, options);

  return {
    schemaVersion: 1,
    error: {
      code: typed.code,
      exitCode: typed.exitCode,
      summary: line.summary,
      details: line.details,
      remediation: line.remediation ?? null,
    },
  };
}

/**
 * Renders the JSON error envelope as one newline-terminated document.
 */
export function formatErrorJson(error: unknown, options: ErrorRenderOptions = {}): string {
  return `${JSON.stringify(toErrorDocument(error, options), null, 2)}\n`;
}

/**
 * Writes the error in the selected mode and returns the exit code, so a CLI
 * entry point can do `process.exitCode = reportError(error)`.
 */
export function reportError(error: unknown, options: ErrorRenderOptions = {}): ExitCode {
  const exitCode = toExitCode(error);

  if (options.json === true) {
    (options.stdout ?? process.stdout).write(formatErrorJson(error, options));
  } else {
    (options.stderr ?? process.stderr).write(`${formatError(error, options)}\n`);
  }

  return exitCode;
}

/**
 * Runs an action, reporting any thrown value through {@link reportError}.
 * Successful numeric returns pass through unchanged.
 */
export function runWithErrorHandling(
  action: () => number,
  options: ErrorRenderOptions = {},
): number {
  try {
    return action();
  } catch (error) {
    return reportError(error, options);
  }
}

/**
 * Redacts credential userinfo embedded in URLs and strips ANSI control
 * sequences so diagnostics stay plain text in every mode:
 * `https://user:password@host` becomes `https://[redacted]@host`.
 */
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is intentional.
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

/**
 * Detail keys matching any of these words are replaced wholesale, so a value
 * can never leak through a nested object or array.
 */
const SECRET_KEY_PATTERN = /(secret|token|password|passwd|credential|authorization|key)/i;

/**
 * The label column keeps the PRD 12.3 alignment (`probe:`, `reason:`,
 * `previous:`, `next:`) even for errors that carry fewer details.
 */
const MIN_LABEL_WIDTH = 10;

/**
 * Replaces secret-looking detail values and credentials embedded in URLs.
 * Applied recursively so nested structures cannot bypass redaction.
 */
export function redactDetails(
  details: ErrorDetails,
  secrets: readonly string[] = [],
): ErrorDetails {
  const redacted: Record<string, ErrorDetailValue> = {};

  for (const [key, value] of Object.entries(details)) {
    redacted[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactDetailValue(value, secrets);
  }

  return redacted;
}

/**
 * Scrubs URL credentials and any caller-supplied secret values from free text.
 */
export function redactText(value: string, secrets: readonly string[] = []): string {
  let redacted = value.replace(ANSI_PATTERN, "").replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED}@`);

  const sorted = secrets
    .filter((secret) => secret.length > 0)
    .slice()
    .sort((left, right) => right.length - left.length);

  for (const secret of sorted) {
    redacted = redacted.split(secret).join(REDACTED);
  }

  return redacted;
}

interface DescribedError {
  summary: string;
  details: ErrorDetails;
  remediation: string | undefined;
}

function describe(error: EasyHostError, options: ErrorRenderOptions): DescribedError {
  const secrets = options.secrets ?? [];

  return {
    summary: redactText(error.message, secrets),
    details: redactDetails(error.details, secrets),
    remediation:
      error.remediation === undefined || error.remediation.length === 0
        ? undefined
        : redactText(error.remediation, secrets),
  };
}

function redactDetailValue(value: ErrorDetailValue, secrets: readonly string[]): ErrorDetailValue {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactDetailValue(entry, secrets));
  }

  if (value !== null && typeof value === "object") {
    return redactDetails(value as ErrorDetails, secrets);
  }

  return value;
}

function renderDetailValue(value: ErrorDetailValue): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => renderDetailValue(entry)).join(", ");
  }

  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function detailLabel(key: string): string {
  const label = singleLine(key);
  return label.endsWith(":") ? label : `${label}:`;
}

function adoptTypedError(error: unknown): EasyHostError | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const candidate = error as Error & {
    exitCode?: unknown;
    code?: unknown;
    details?: unknown;
    remediation?: unknown;
  };

  if (!isExitCode(candidate.exitCode) || candidate.exitCode === EXIT_CODES.SUCCESS) {
    return undefined;
  }

  return new EasyHostError(
    candidate.message,
    candidate.exitCode,
    typeof candidate.code === "string" && candidate.code.length > 0 ? candidate.code : "ERROR",
    {
      details: normalizeDetails(candidate.details),
      ...(typeof candidate.remediation === "string" && candidate.remediation.length > 0
        ? { remediation: candidate.remediation }
        : {}),
      cause: error,
    },
  );
}

function normalizeDetails(value: unknown): ErrorDetails {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const details: Record<string, ErrorDetailValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeDetailValue(entry);
    if (normalized !== undefined) {
      details[key] = normalized;
    }
  }

  return details;
}

function normalizeDetailValue(value: unknown): ErrorDetailValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDetailValue(entry) ?? String(entry));
  }

  if (typeof value === "object") {
    return normalizeDetails(value);
  }

  return undefined;
}

function unexpectedSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cleaned = singleLine(message);

  return cleaned.length === 0 ? "unexpected error" : `unexpected error: ${cleaned}`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function errorOptions(cause: unknown): ErrorOptions | undefined {
  return cause === undefined ? undefined : { cause };
}

function isDebug(options: ErrorRenderOptions): boolean {
  if (options.debug !== undefined) {
    return options.debug;
  }

  return (options.env ?? process.env).EASY_HOST_DEBUG === "1";
}

function stackOf(error: EasyHostError): string | undefined {
  if (error.cause instanceof Error && typeof error.cause.stack === "string") {
    return error.cause.stack;
  }

  return error.stack;
}
