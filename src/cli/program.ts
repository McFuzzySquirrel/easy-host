import { readFileSync } from "node:fs";
import { Command, CommanderError, type OptionValues } from "commander";
import { createNotImplementedHandler } from "./commands/not-implemented.js";
import {
  type ErrorRenderOptions,
  EXIT_CODES,
  type ExitCode,
  reportError,
  UsageError,
} from "./errors.js";

/**
 * The single executable name. Every help line, remediation, and JSON document
 * uses it so operator-facing text stays consistent.
 */
export const PROGRAM_NAME = "easy-host";

/**
 * The complete command surface from PRD 12.1 and `PRE-FR-06`. Exactly these
 * ten commands are registered; there is no start, stop, restart, prune, or
 * daemon command (`PRD-C-01`).
 */
export const COMMAND_NAMES = [
  "add",
  "list",
  "status",
  "logs",
  "update",
  "rollback",
  "remove",
  "config",
  "doctor",
  "version",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

/**
 * A writable stream, narrowed so tests can inject recorders instead of
 * touching the real terminal.
 */
export interface OutputStream {
  write(chunk: string): unknown;
}

export interface ProgramOptions {
  /** Destination for help, command results, and `--json` documents. */
  stdout?: OutputStream;
  /** Destination for human error output and diagnostics. */
  stderr?: OutputStream;
  /** Environment used for error rendering such as `EASY_HOST_DEBUG`. */
  env?: NodeJS.ProcessEnv;
  /** Overrides the package version lookup, used by tests. */
  readVersion?: () => string;
}

/**
 * The stable `version --json` document. Field names are additive-only under
 * `schemaVersion: 1` (`OBS-NF-02`).
 */
export interface VersionDocument {
  schemaVersion: 1;
  name: string;
  version: string;
}

interface PackageManifest {
  version?: unknown;
}

const PACKAGE_MANIFEST_URL = new URL("../../package.json", import.meta.url);

/**
 * Reads the version from the package manifest next to the built entry.
 * The same relative path works from `src/cli/` and `dist/cli/`.
 */
export function readPackageVersion(): string {
  const manifest = JSON.parse(readFileSync(PACKAGE_MANIFEST_URL, "utf8")) as PackageManifest;
  const { version } = manifest;

  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json does not declare a version");
  }

  return version;
}

/**
 * Creates the commander program with exactly ten subcommands, the documented
 * flags, and the global `--json` flag. `version` is the only command that
 * performs work here: lifecycle and read commands throw a usage error until
 * later tasks wire them.
 */
export function createProgram(options: ProgramOptions = {}): Command {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const readVersion = options.readVersion ?? readPackageVersion;

  const program = new Command();

  program
    .name(PROGRAM_NAME)
    .description("Self-host apps on a rootless Podman host.")
    .helpCommand(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        stdout.write(text);
      },
      writeErr: (text) => {
        stderr.write(text);
      },
      // Errors are rendered once by the shared taxonomy, never twice by
      // commander and the top-level handler.
      outputError: () => {},
    })
    // Global option: accepted before or after any subcommand. Subcommands that
    // document `--json` also declare it so it appears in their own help.
    .option("--json", "write one machine-readable JSON document to stdout");

  registerAdd(program);
  registerList(program);
  registerStatus(program);
  registerLogs(program);
  registerUpdate(program);
  registerRollback(program);
  registerRemove(program);
  registerConfig(program);
  registerDoctor(program);
  registerVersion(program, readVersion, stdout);

  return program;
}

/**
 * Parses one invocation and returns the documented exit code. All expected
 * failures are rendered through the shared error taxonomy; `--help` and a
 * successful command return 0.
 *
 * `argv` contains user arguments only (no `node` executable or script path).
 */
export function runCli(argv: readonly string[], options: ProgramOptions = {}): ExitCode {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const program = createProgram(options);

  const renderOptions: ErrorRenderOptions = {
    json: argv.includes("--json") || program.opts().json === true,
    stdout,
    stderr,
    ...(options.env === undefined ? {} : { env: options.env }),
  };

  try {
    if (argv.length === 0) {
      program.outputHelp();
      return EXIT_CODES.SUCCESS;
    }

    program.parse([...argv], { from: "user" });
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` writes its output and reports exit 0; that is a success.
      if (error.exitCode === 0) {
        return EXIT_CODES.SUCCESS;
      }

      return reportError(toUsageError(error), renderOptions);
    }

    return reportError(error, renderOptions);
  }
}

function registerAdd(program: Command): void {
  program
    .command("add")
    .description("Add an app from a git repository or local path")
    .argument("[git-url]", "git repository URL to clone")
    .option("--local <path>", "add from a local workspace path instead of a git URL")
    .option("--name <app>", "app name (defaults to the repository name)")
    .option("--ref <ref>", "git ref to build (branch, tag, or commit)")
    .option("--port <port>", "host port to publish")
    .option("--container-port <port>", "container port the app listens on")
    .option("--bind <addr>", "address to bind the published port to")
    .option("--env-file <path>", "environment file for the app")
    .option("--health-path <path>", "HTTP path used by the readiness probe")
    .option("--probe <http|tcp>", "probe type used for readiness")
    .option("--volume <name:container-path>", "named volume to mount (repeatable)")
    .option("--yes", "accept prompts without asking")
    .action(createNotImplementedHandler("add"));
}

function registerList(program: Command): void {
  program
    .command("list")
    .description("List registered apps")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(createNotImplementedHandler("list"));
}

function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show app status and drift")
    .argument("[app]", "app name (omit to show every app)")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(createNotImplementedHandler("status"));
}

function registerLogs(program: Command): void {
  program
    .command("logs")
    .description("Stream an app's container logs")
    .argument("<app>", "app name")
    .option("-f, --follow", "follow log output")
    .option("--tail <n>", "number of lines to show before following")
    .action(createNotImplementedHandler("logs"));
}

function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("Rebuild or recreate an app")
    .argument("<app>", "app name")
    .option("--rebuild", "force a rebuild even when the ref is unchanged")
    .action(createNotImplementedHandler("update"));
}

function registerRollback(program: Command): void {
  program
    .command("rollback")
    .description("Swap an app back to its previous image")
    .argument("<app>", "app name")
    .action(createNotImplementedHandler("rollback"));
}

function registerRemove(program: Command): void {
  program
    .command("remove")
    .description("Remove an app and its resources")
    .argument("<app>", "app name")
    .option("--volumes", "also delete the app's named volumes")
    .option("--force", "remove without confirmation prompts")
    .action(createNotImplementedHandler("remove"));
}

function registerConfig(program: Command): void {
  program
    .command("config")
    .description("Show or edit an app's configuration")
    .argument("<app>", "app name")
    .option("--path", "print the app's directory path")
    .option("--edit", "open the app's configuration in $EDITOR")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(createNotImplementedHandler("config"));
}

function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check host prerequisites")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(createNotImplementedHandler("doctor"));
}

function registerVersion(program: Command, readVersion: () => string, stdout: OutputStream): void {
  program
    .command("version")
    .description("Print the easy-host version")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action((_options: OptionValues, command: Command) => {
      const { json } = command.optsWithGlobals<{ json?: boolean }>();
      const version = readVersion();

      if (json === true) {
        const document: VersionDocument = {
          schemaVersion: 1,
          name: PROGRAM_NAME,
          version,
        };
        stdout.write(`${JSON.stringify(document, null, 2)}\n`);
        return;
      }

      stdout.write(`${version}\n`);
    });
}

/**
 * Converts a commander parse failure into the usage error class so exit code 1
 * and the shared summary/detail/remediation shape apply to unknown commands,
 * missing arguments, unknown options, and excess arguments alike.
 */
function toUsageError(error: CommanderError): UsageError {
  const summary = error.message.replace(/^error:\s*/i, "").trim();

  switch (error.code) {
    case "commander.unknownCommand":
      return new UsageError(summary, {
        code: "UNKNOWN_COMMAND",
        remediation: `Run ${PROGRAM_NAME} --help to list the available commands.`,
      });

    case "commander.missingArgument":
      return new UsageError(summary, {
        code: "MISSING_ARGUMENT",
        remediation: `Run ${PROGRAM_NAME} <command> --help for usage.`,
      });

    case "commander.unknownOption":
      return new UsageError(summary, {
        code: "UNKNOWN_OPTION",
        remediation: `Run ${PROGRAM_NAME} <command> --help to see the supported flags.`,
      });

    case "commander.excessArguments":
      return new UsageError(summary, {
        code: "EXCESS_ARGUMENTS",
        remediation: `Run ${PROGRAM_NAME} <command> --help to see the supported arguments.`,
      });

    default:
      return new UsageError(summary, {
        code: "USAGE_ERROR",
        remediation: `Run ${PROGRAM_NAME} --help for usage.`,
      });
  }
}
