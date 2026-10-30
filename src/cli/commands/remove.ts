/**
 * The `remove` command handler (`RBK-FR-03`, `RBK-FR-04`, `RBK-FR-05`).
 *
 * The handler is a thin translation layer: the flags become a
 * {@link RemoveRequest}, the lifecycle owns the confirmation gate, the lock,
 * every deletion, and the volume scoping, and this module only chooses the
 * streams and renders the operator summary.
 *
 * The summary answers the safety questions the command promises: what was
 * deleted, which images were kept and why, which volumes survived, and the
 * exact `podman volume rm` command that deletes them later. Progress stays on
 * stderr; the result goes to stdout so `easy-host remove app > removed.txt`
 * stays clean.
 *
 * A non-TTY invocation without `--yes` fails with exit 1 before anything is
 * deleted; an unknown app exits 5; a held lock exits 6.
 */

import {
  createDefaultRemoveOutput,
  type RemoveDependencyOverrides,
  type RemoveResult,
  removeApp,
} from "../../lifecycle/remove.js";
import { EXIT_CODES, type ExitCode, reportError } from "../errors.js";
import { isInteractiveSession } from "../prompts.js";

/** A writable stream, narrowed so tests can inject a recorder. */
export interface RemoveCommandStream {
  write(chunk: string): unknown;
}

/** The flags commander passes for `remove`, plus composition seams for tests. */
export interface RemoveCommandOptions {
  /** Positional `<app>` argument. */
  readonly app: string;
  /** `--volumes`: also delete named volumes labelled for the app. */
  readonly volumes?: boolean;
  /** `--yes`: confirm non-interactively. */
  readonly yes?: boolean;
  /** `--force`: skip confirmation only; never implies `--volumes`. */
  readonly force?: boolean;
  readonly json?: boolean;
  readonly stdout?: RemoveCommandStream;
  readonly stderr?: RemoveCommandStream;
  /** Overrides terminal detection, so tests never depend on a real stdin. */
  readonly stdinIsTTY?: boolean;
  /** Direct override for the same decision. */
  readonly interactive?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  /** Test/composition seam; production leaves it undefined. */
  readonly dependencies?: RemoveDependencyOverrides;
}

/** Runs `remove`, writes the outcome, and returns the documented exit code. */
export async function runRemoveCommand(options: RemoveCommandOptions): Promise<ExitCode> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.dependencies?.environment ?? options.environment ?? process.env;
  const output = options.dependencies?.output ?? createDefaultRemoveOutput(stderr);
  const interactive =
    options.interactive ??
    isInteractiveSession({
      ...(options.stdinIsTTY === undefined ? {} : { stdinIsTTY: options.stdinIsTTY }),
      env: environment,
    });
  const dependencies: RemoveDependencyOverrides = {
    ...options.dependencies,
    output,
    environment,
  };

  try {
    const result = await removeApp(
      {
        app: options.app,
        interactive,
        ...(options.volumes === true ? { volumes: true } : {}),
        ...(options.yes === true ? { yes: true } : {}),
        ...(options.force === true ? { force: true } : {}),
        environment,
      },
      dependencies,
    );

    stdout.write(formatRemoveResult(result));

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
 * The operator-facing summary: what was deleted, what was kept, and the exact
 * command for retained volumes. No environment value or secret ever appears
 * here (`PRD-NF-10`).
 */
export function formatRemoveResult(result: RemoveResult): string {
  const lines = [
    `removed "${result.app}"`,
    `  container:  ${containerLabel(result)}`,
    `  images:     ${imageLabel(result)}`,
    `  workspace:  ${result.workspace.path} (${result.workspace.deleted ? "deleted" : "not present"})`,
    `  app dir:    ${result.appDirectory.path} (${
      result.appDirectory.deleted ? "deleted" : "kept"
    })`,
  ];

  if (result.volumes.deleted.length > 0) {
    lines.push(`  volumes:    ${result.volumes.deleted.join(", ")} (deleted)`);
  } else if (result.volumes.retained.length > 0) {
    lines.push(`  volumes:    ${result.volumes.retained.join(", ")} (kept)`);
  } else {
    lines.push("  volumes:    none");
  }

  for (const image of result.images.kept) {
    lines.push(`  kept:       ${image.reference} (${image.reason})`);
  }

  for (const volume of result.volumes.refused) {
    lines.push(`  refused:    ${volume.name} (${volume.reason})`);
  }

  if (result.volumes.deleteCommand !== null) {
    lines.push(`  next:       ${result.volumes.deleteCommand}`);
  }

  return `${lines.join("\n")}\n`;
}

function containerLabel(result: RemoveResult): string {
  const { name, present, removed } = result.container;

  if (removed) {
    return `${name} (removed)`;
  }

  if (!present) {
    return `${name} (already absent)`;
  }

  return `${name} (not present)`;
}

function imageLabel(result: RemoveResult): string {
  if (result.images.removed.length > 0) {
    return `${result.images.removed.length} removed: ${result.images.removed.join(", ")}`;
  }

  if (result.images.kept.length > 0) {
    return "none removed";
  }

  return "none found";
}
