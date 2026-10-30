/**
 * The `rollback` command handler (`RBK-FR-01`, `RBK-FR-05`).
 *
 * The handler is a thin translation layer: the lifecycle owns the lock, the
 * recorded-image check, and the health-gated swap, and this module only
 * chooses the streams and renders the operator summary.
 *
 * The summary answers what the feature promise requires: the image that was
 * restored (now serving) and the image that becomes the new rollback target, so
 * a second `easy-host rollback <app>` is obviously meaningful. Progress stays
 * on stderr; the result goes to stdout so redirecting it stays clean. Errors
 * render through the shared taxonomy: one image exits 5, a failed candidate 4,
 * and a held lock 6.
 */

import {
  createDefaultRollbackOutput,
  type RollbackDependencyOverrides,
  type RollbackResult,
  rollbackApp,
} from "../../lifecycle/rollback.js";
import { EXIT_CODES, type ExitCode, reportError } from "../errors.js";

/** A writable stream, narrowed so tests can inject a recorder. */
export interface RollbackCommandStream {
  write(chunk: string): unknown;
}

/** The flags commander passes for `rollback`, plus composition seams for tests. */
export interface RollbackCommandOptions {
  /** Positional `<app>` argument. */
  readonly app: string;
  readonly json?: boolean;
  readonly stdout?: RollbackCommandStream;
  readonly stderr?: RollbackCommandStream;
  readonly environment?: NodeJS.ProcessEnv;
  /** Test/composition seam; production leaves it undefined. */
  readonly dependencies?: RollbackDependencyOverrides;
}

/** Runs `rollback`, writes the outcome, and returns the documented exit code. */
export async function runRollbackCommand(options: RollbackCommandOptions): Promise<ExitCode> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.dependencies?.environment ?? options.environment ?? process.env;
  const output = options.dependencies?.output ?? createDefaultRollbackOutput(stderr);
  const dependencies: RollbackDependencyOverrides = {
    ...options.dependencies,
    output,
    environment,
  };

  try {
    const result = await rollbackApp({ app: options.app, environment }, dependencies);

    stdout.write(formatRollbackResult(result));

    for (const warning of result.warnings) {
      stderr.write(`easy-host: warning: ${warning}\n`);
    }

    return EXIT_CODES.SUCCESS;
  } catch (error) {
    return reportError(error, {
      stdout,
      stderr,
      env: environment,
      ...(options.json === true ? { json: true } : {}),
    });
  }
}

/**
 * The operator-facing summary: the restored image and the image that is now the
 * rollback target, then the container, health, and URL. No environment value or
 * secret ever appears here (`PRD-NF-10`).
 */
export function formatRollbackResult(result: RollbackResult): string {
  const lines = [
    `rolled back "${result.app}"`,
    `  restored:   ${result.restoredImage}`,
    `  rollback:   ${result.rollbackTarget}`,
    `  container:  ${result.container}`,
    `  health:     ${result.health.state} after ${result.health.attempts} attempt(s) via ${result.health.target}`,
    `  url:        ${result.url}`,
  ];

  if (!result.stateRecorded) {
    lines.push("  warning:    state.json was not updated; see the warning on stderr");
  }

  return `${lines.join("\n")}\n`;
}
