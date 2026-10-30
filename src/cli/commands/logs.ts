/**
 * The `logs` command handler (`ADD-FR-06`).
 *
 * Logs are a pure passthrough: no parsing, no filtering, no stored copy
 * (`PRD-C-09`). The handler forwards `-f` exactly when `--follow` was passed
 * and `--tail` exactly as parsed, writes Podman's stdout and stderr to the
 * matching process streams, and returns Podman's exit code. Podman failures
 * that the runtime adapter turns into typed errors are rendered through the
 * shared taxonomy (missing container 5, engine failure 2).
 */

import {
  type ContainerLogsOptions,
  type ContainerLogsResult,
  containerLogs,
  DEFAULT_LOGS_TAIL,
} from "../../platform/podman.js";
import { EXIT_CODES, reportError, UsageError } from "../errors.js";
import type { ReadOutputStream } from "./read-model.js";

/** The log operation the handler needs. */
export interface LogsRuntime {
  containerLogs(options: ContainerLogsOptions): Promise<ContainerLogsResult>;
}

/** Options accepted by {@link runLogsCommand}. */
export interface LogsCommandOptions {
  /** App whose container logs are read. */
  readonly app: string;
  /** `-f` / `--follow`. Absent means print the tail and exit. */
  readonly follow?: boolean;
  /** `--tail <n>` from commander (a string) or a programmatic number. */
  readonly tail?: string | number;
  /** Destination for Podman stdout. Defaults to stdout. */
  readonly stdout?: ReadOutputStream;
  /** Destination for Podman stderr. Defaults to stderr. */
  readonly stderr?: ReadOutputStream;
  /** Environment used when rendering an error. Defaults to `process.env`. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Test/programmatic runtime seam; production uses the Podman adapter. */
  readonly runtime?: LogsRuntime;
}

const DEFAULT_LOGS_RUNTIME: LogsRuntime = { containerLogs };
const MAX_TAIL_LINES = 1_000_000;

/**
 * Runs `logs` and returns Podman's exit code. A nonzero Podman result is
 * returned unchanged; a typed runtime failure is reported and mapped to its
 * documented exit code.
 */
export async function runLogsCommand(options: LogsCommandOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runtime = options.runtime ?? DEFAULT_LOGS_RUNTIME;
  const environment = options.environment ?? process.env;

  try {
    const tail = normalizeTail(options.tail);
    const result = await runtime.containerLogs({
      app: options.app,
      follow: options.follow === true,
      tail,
    });

    if (result.stdout.length > 0) {
      stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      stderr.write(result.stderr);
    }

    return result.exitCode;
  } catch (error) {
    return reportError(error, { stdout, stderr, env: environment });
  }
}

/**
 * Accepts the commander string or a programmatic number. Omitted means the
 * documented default of 200 lines (PRD open question 4).
 */
export function normalizeTail(value: string | number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LOGS_TAIL;
  }

  if (typeof value === "number") {
    return validateTail(value);
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new UsageError(`invalid --tail value ${JSON.stringify(value)}`, {
      code: "INVALID_LOG_OPTION",
      details: { tail: value, maximum: MAX_TAIL_LINES },
      remediation: `Pass a whole number of lines between 0 and ${MAX_TAIL_LINES}, for example --tail 200.`,
    });
  }

  return validateTail(Number.parseInt(trimmed, 10));
}

function validateTail(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TAIL_LINES) {
    throw new UsageError(`invalid --tail value ${String(value)}`, {
      code: "INVALID_LOG_OPTION",
      details: { tail: value, maximum: MAX_TAIL_LINES },
      remediation: `Pass a whole number of lines between 0 and ${MAX_TAIL_LINES}, for example --tail 200.`,
    });
  }

  return value;
}

/** Re-exported so a caller can compare against the handler's success code. */
export const LOGS_SUCCESS_EXIT_CODE = EXIT_CODES.SUCCESS;
