/**
 * The `add` command handler.
 *
 * It is a thin translation layer: commander's flags become an
 * {@link AddRequest}, the lifecycle owns every check and mutation, and this
 * module only chooses the process streams and renders the final human summary.
 * Progress stays on stderr; the result summary goes to stdout so a scripted
 * `easy-host add ... > add.txt` keeps stdout clean.
 *
 * Errors are rendered through the shared taxonomy, so the command returns the
 * documented exit code (1 usage, 2 prerequisite, 3 build, 4 health, 5 not found,
 * 6 conflict) instead of throwing out of the CLI action.
 */

import {
  type AddDependencyOverrides,
  type AddResult,
  addApp,
  createDefaultAddOutput,
} from "../../lifecycle/add.js";
import { EXIT_CODES, type ExitCode, reportError } from "../errors.js";

/** A writable stream, narrowed so tests can inject a recorder. */
export interface AddCommandStream {
  write(chunk: string): unknown;
}

/** The flags commander passes for `add`, in camelCase form. */
export interface AddCommandOptions {
  /** Positional `<git-url>` argument. */
  readonly url?: string;
  readonly local?: string;
  readonly name?: string;
  readonly ref?: string;
  readonly port?: string;
  readonly containerPort?: string;
  readonly bind?: string;
  readonly envFile?: string;
  readonly healthPath?: string;
  readonly probe?: string;
  readonly volume?: string | readonly string[];
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly stdout?: AddCommandStream;
  readonly stderr?: AddCommandStream;
  readonly environment?: NodeJS.ProcessEnv;
  /** Test/composition seam; production leaves it undefined. */
  readonly dependencies?: AddDependencyOverrides;
  /** Test override for terminal detection. */
  readonly interactive?: boolean;
}

/**
 * Runs `add`, writes the outcome, and returns the documented exit code.
 * No exception escapes: the top-level entry point has already rendered any
 * unexpected error by the time this returns.
 */
export async function runAddCommand(options: AddCommandOptions = {}): Promise<ExitCode> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.dependencies?.environment ?? options.environment ?? process.env;
  const output = options.dependencies?.output ?? createDefaultAddOutput(stderr);
  const dependencies: AddDependencyOverrides = {
    ...options.dependencies,
    output,
    environment,
    buildStderr: options.dependencies?.buildStderr ?? stderr,
  };

  try {
    const result = await addApp(
      {
        ...(options.url === undefined ? {} : { repo: options.url }),
        ...(options.local === undefined ? {} : { localPath: options.local }),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.ref === undefined ? {} : { ref: options.ref }),
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.containerPort === undefined ? {} : { containerPort: options.containerPort }),
        ...(options.bind === undefined ? {} : { bind: options.bind }),
        ...(options.envFile === undefined ? {} : { envFile: options.envFile }),
        ...(options.healthPath === undefined ? {} : { healthPath: options.healthPath }),
        ...(options.probe === undefined ? {} : { probe: options.probe }),
        ...(options.volume === undefined ? {} : { volume: options.volume }),
        ...(options.yes === undefined ? {} : { yes: options.yes }),
        ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
        environment,
      },
      dependencies,
    );

    stdout.write(formatAddResult(result));

    for (const warning of result.warnings) {
      stderr.write(`easy-host: warning: ${warning}\n`);
    }

    return EXIT_CODES.SUCCESS;
  } catch (error) {
    return reportError(error, {
      stderr,
      stdout,
      env: environment,
      ...(options.json === true ? { json: true } : {}),
    });
  }
}

/**
 * The operator-facing success summary: where the app is reachable, what image
 * is current, which image is the rollback target, and whether the source is a
 * clone or a dev-only local path. Plain text only (`PRD-ACC-02`).
 */
export function formatAddResult(result: AddResult): string {
  const source =
    result.mode === "local"
      ? `${result.workspace} (local, dev-only)`
      : `${result.repo ?? "repository"} at ${result.ref ?? "default ref"}${
          result.commit === undefined ? "" : ` (${shortCommit(result.commit)})`
        }`;
  const lines = [
    `added "${result.app}"`,
    `  url:        ${result.url}`,
    `  source:     ${source}`,
    `  container:  ${result.container} (running)`,
    `  image:      ${result.image}`,
    `  previous:   none (first version)`,
    `  health:     ${result.health.state} after ${result.health.attempts} attempt(s) via ${result.health.target}`,
  ];

  if (result.volumes.length > 0) {
    lines.push(`  volumes:    ${result.volumes.join(", ")}`);
  }

  if (result.devOnly) {
    lines.push("  local mode: dev-only (the app source is used in place)");
  }

  return `${lines.join("\n")}\n`;
}

function shortCommit(commit: string): string {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}
