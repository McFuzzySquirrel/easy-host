/**
 * The `update` command handler (UPD-FR-04, UPD-FR-05, UPD-NF-02).
 *
 * The handler is a thin translation layer: the flags become an
 * {@link UpdateRequest}, the lifecycle owns the lock, diff, build, and swap,
 * and this module only chooses the streams and renders the human summary.
 *
 * The summary answers the three questions the feature promise makes: what
 * changed, what was skipped, and what is serving now. Progress stays on stderr;
 * the result goes to stdout so `easy-host update app > update.txt` stays clean.
 * Errors are rendered through the shared taxonomy, so a failed build exits 3, a
 * failed candidate 4, an unknown app 5, and a held lock 6.
 */

import {
  createDefaultUpdateOutput,
  type UpdateDependencyOverrides,
  type UpdateKind,
  type UpdateRequest,
  type UpdateResult,
  updateApp,
} from "../../lifecycle/update.js";
import { EXIT_CODES, type ExitCode, reportError } from "../errors.js";

/** A writable stream, narrowed so tests can inject a recorder. */
export interface UpdateCommandStream {
  write(chunk: string): unknown;
}

/** The flags commander passes for `update`, plus composition seams for tests. */
export interface UpdateCommandOptions {
  /** Positional `<app>` argument. */
  readonly app: string;
  /** `--rebuild`: force an image build even when the diff says config-only. */
  readonly rebuild?: boolean;
  /** Programmatic configuration changes; the CLI surface only exposes --rebuild. */
  readonly changes?: UpdateRequest["changes"];
  readonly json?: boolean;
  readonly stdout?: UpdateCommandStream;
  readonly stderr?: UpdateCommandStream;
  readonly environment?: NodeJS.ProcessEnv;
  /** Test/composition seam; production leaves it undefined. */
  readonly dependencies?: UpdateDependencyOverrides;
}

/**
 * Runs `update`, writes the outcome, and returns the documented exit code.
 * Both a real update and a no-op return 0.
 */
export async function runUpdateCommand(options: UpdateCommandOptions): Promise<ExitCode> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.dependencies?.environment ?? options.environment ?? process.env;
  const output = options.dependencies?.output ?? createDefaultUpdateOutput(stderr);
  const dependencies: UpdateDependencyOverrides = {
    ...options.dependencies,
    output,
    environment,
    buildStderr: options.dependencies?.buildStderr ?? stderr,
  };

  try {
    const result = await updateApp(
      {
        app: options.app,
        ...(options.rebuild === true ? { rebuild: true } : {}),
        ...(options.changes === undefined ? {} : { changes: options.changes }),
        environment,
      },
      dependencies,
    );

    stdout.write(formatUpdateResult(result));

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

function kindLabel(kind: UpdateKind): string {
  switch (kind) {
    case "no-op":
      return "no-op";
    case "config-only":
      return "config-only";
    case "rebuild":
      return "rebuild";
  }
}

/**
 * The operator-facing summary: the executed class, the changed fields (names
 * only, never values), the work that was skipped, and the image now serving
 * with the rollback target.
 */
export function formatUpdateResult(result: UpdateResult): string {
  const changed =
    result.changes.length > 0
      ? result.changes.map((change) => `${change.field} (${change.kind})`).join(", ")
      : result.sourceChanged
        ? "source (configured ref moved)"
        : result.diff.forced
          ? "forced rebuild (--rebuild)"
          : "nothing";
  const skipped = result.skipped.length === 0 ? "none" : result.skipped.join(", ");
  const headline =
    result.status === "no-op"
      ? `no changes for "${result.app}"`
      : `updated "${result.app}" (${kindLabel(result.kind)})`;

  const lines = [
    headline,
    `  changed:    ${changed}`,
    `  skipped:    ${skipped}`,
    `  container:  ${result.container} (${containerLabel(result.containerState)})`,
    `  image:      ${result.image ?? "none recorded"}`,
    `  previous:   ${result.previousImage === null ? "none (first version)" : result.previousImage}`,
    `  health:     ${healthLabel(result)}`,
    `  url:        ${result.url}`,
  ];

  if (result.commit !== undefined) {
    lines.push(`  commit:     ${shortCommit(result.commit)}`);
  }

  return `${lines.join("\n")}\n`;
}

function containerLabel(state: UpdateResult["containerState"]): string {
  switch (state) {
    case "running":
      return "running";
    case "stopped":
      return "not running";
    case "missing":
      return "missing";
  }
}

function healthLabel(result: UpdateResult): string {
  if (result.health !== null) {
    const via = result.health.target;
    return `${result.health.state} after ${result.health.attempts} attempt(s) via ${via}`;
  }

  const recorded = result.recordedHealth ?? "unknown";
  return result.status === "no-op" ? `${recorded} (recorded; not re-probed)` : recorded;
}

function shortCommit(commit: string): string {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}
