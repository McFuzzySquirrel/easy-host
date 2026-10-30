import { readFileSync } from "node:fs";
import { Command, CommanderError, type OptionValues } from "commander";
import { type AddCommandOptions, runAddCommand } from "./commands/add.js";
import { type ConfigCommandOptions, runConfigCommand } from "./commands/config.js";
import { type DoctorCommandOptions, runDoctorCommand } from "./commands/doctor.js";
import { type ListCommandOptions, runListCommand } from "./commands/list.js";
import { type LogsCommandOptions, runLogsCommand } from "./commands/logs.js";
import { type RemoveCommandOptions, runRemoveCommand } from "./commands/remove.js";
import { type RollbackCommandOptions, runRollbackCommand } from "./commands/rollback.js";
import { runStatusCommand, type StatusCommandOptions } from "./commands/status.js";
import { runUpdateCommand, type UpdateCommandOptions } from "./commands/update.js";
import {
  type ErrorRenderOptions,
  EXIT_CODES,
  type ExitCode,
  reportError,
  UsageError,
} from "./errors.js";
import { toVersionDocument, writeJsonDocument } from "./json.js";

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
  /**
   * Runs the doctor command. Tests replace it so a unit test never probes the
   * real host; production uses {@link runDoctorCommand}.
   */
  runDoctor?: (options: DoctorCommandOptions) => ExitCode;
  /**
   * Runs the read commands. The default handlers perform the real registry,
   * state-cache, and Podman reads; tests and embedders can replace one handler
   * without touching the others.
   */
  runList?: (options: ListCommandOptions) => ExitCode | Promise<ExitCode>;
  runStatus?: (options: StatusCommandOptions) => ExitCode | Promise<ExitCode>;
  runConfig?: (options: ConfigCommandOptions) => ExitCode | Promise<ExitCode>;
  /**
   * Runs the lifecycle commands. The defaults are the real handlers; tests and
   * embedders replace one handler without touching the others.
   */
  runAdd?: (options: AddCommandOptions) => ExitCode | Promise<ExitCode>;
  runLogs?: (options: LogsCommandOptions) => number | Promise<number>;
  runUpdate?: (options: UpdateCommandOptions) => ExitCode | Promise<ExitCode>;
  runRollback?: (options: RollbackCommandOptions) => ExitCode | Promise<ExitCode>;
  runRemove?: (options: RemoveCommandOptions) => ExitCode | Promise<ExitCode>;
}

/**
 * Commander actions cannot return an exit code through `parse`, so the program
 * carries one mutable result for the duration of a single invocation.
 */
interface ExitState {
  exitCode: ExitCode;
}

const EXIT_STATE: unique symbol = Symbol("easy-host.exit-state");

type ProgramWithExitState = Command & { [EXIT_STATE]?: ExitState };

/**
 * The stable `version --json` document shape is part of the shared contract in
 * `src/cli/schemas.ts`; field names are additive-only under `schemaVersion: 1`
 * (`OBS-NF-02`).
 */
export type { VersionDocument } from "./schemas.js";

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
 * flags, and the global `--json` flag. Every command performs work here; the
 * handlers are injectable so a test can replace one without touching the rest.
 */
export function createProgram(options: ProgramOptions = {}): Command {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const readVersion = options.readVersion ?? readPackageVersion;
  const runList = options.runList ?? runListCommand;
  const runStatus = options.runStatus ?? runStatusCommand;
  const runConfig = options.runConfig ?? runConfigCommand;
  const runAdd = options.runAdd ?? runAddCommand;
  const runLogs = options.runLogs ?? runLogsCommand;
  const runUpdate = options.runUpdate ?? runUpdateCommand;
  const runRollback = options.runRollback ?? runRollbackCommand;
  const runRemove = options.runRemove ?? runRemoveCommand;

  const program = new Command();
  const exitState: ExitState = { exitCode: EXIT_CODES.SUCCESS };
  (program as ProgramWithExitState)[EXIT_STATE] = exitState;

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

  registerAdd(program, exitState, runAdd, stdout, stderr, options.env);
  registerList(program, exitState, runList, stdout, stderr, options.env);
  registerStatus(program, exitState, runStatus, stdout, stderr, options.env);
  registerLogs(program, exitState, runLogs, stdout, stderr, options.env);
  registerUpdate(program, exitState, runUpdate, stdout, stderr, options.env);
  registerRollback(program, exitState, runRollback, stdout, stderr, options.env);
  registerRemove(program, exitState, runRemove, stdout, stderr, options.env);
  registerConfig(program, exitState, runConfig, stdout, stderr, options.env);
  registerDoctor(program, exitState, options.runDoctor ?? runDoctorCommand, stdout, options.env);
  registerVersion(program, readVersion, stdout);

  return program;
}

/**
 * Parses one invocation and resolves the documented exit code. All expected
 * failures are rendered through the shared error taxonomy; `--help` and a
 * successful command return 0. Read commands are asynchronous, so callers
 * await this function; the synchronous commands simply resolve immediately.
 *
 * `argv` contains user arguments only (no `node` executable or script path).
 */
export async function runCli(
  argv: readonly string[],
  options: ProgramOptions = {},
): Promise<ExitCode> {
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

    await program.parseAsync([...argv], { from: "user" });
    return (program as ProgramWithExitState)[EXIT_STATE]?.exitCode ?? EXIT_CODES.SUCCESS;
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

/** Commander collector for the repeatable `--volume` flag. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function registerAdd(
  program: Command,
  exitState: ExitState,
  runAdd: (options: AddCommandOptions) => ExitCode | Promise<ExitCode>,
  stdout: OutputStream,
  stderr: OutputStream,
  env: NodeJS.ProcessEnv | undefined,
): void {
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
    .option("--volume <name:container-path>", "named volume to mount (repeatable)", collect, [])
    .option("--yes", "accept prompts without asking")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(async (url: string | undefined, _options: OptionValues, command: Command) => {
      const opts = command.optsWithGlobals<{
        local?: string;
        name?: string;
        ref?: string;
        port?: string;
        containerPort?: string;
        bind?: string;
        envFile?: string;
        healthPath?: string;
        probe?: string;
        volume?: string[];
        yes?: boolean;
        json?: boolean;
      }>();
      const volumes = opts.volume ?? [];

      exitState.exitCode = await runAdd({
        ...(url === undefined ? {} : { url }),
        ...(opts.local === undefined ? {} : { local: opts.local }),
        ...(opts.name === undefined ? {} : { name: opts.name }),
        ...(opts.ref === undefined ? {} : { ref: opts.ref }),
        ...(opts.port === undefined ? {} : { port: opts.port }),
        ...(opts.containerPort === undefined ? {} : { containerPort: opts.containerPort }),
        ...(opts.bind === undefined ? {} : { bind: opts.bind }),
        ...(opts.envFile === undefined ? {} : { envFile: opts.envFile }),
        ...(opts.healthPath === undefined ? {} : { healthPath: opts.healthPath }),
        ...(opts.probe === undefined ? {} : { probe: opts.probe }),
        ...(volumes.length === 0 ? {} : { volume: volumes }),
        ...(opts.yes === undefined ? {} : { yes: opts.yes }),
        json: opts.json === true,
        stdout,
        stderr,
        ...(env === undefined ? {} : { environment: env }),
      });
    });
}

function registerList(
  program: Command,
  exitState: ExitState,
  runList: (options: ListCommandOptions) => ExitCode | Promise<ExitCode>,
  stdout: OutputStream,
  stderr: OutputStream,
  env: NodeJS.ProcessEnv | undefined,
): void {
  program
    .command("list")
    .description("List registered apps")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(async (_options: OptionValues, command: Command) => {
      const { json } = command.optsWithGlobals<{ json?: boolean }>();

      exitState.exitCode = await runList({
        json: json === true,
        stdout,
        stderr,
        ...(env === undefined ? {} : { environment: env }),
      });
    });
}

function registerStatus(
  program: Command,
  exitState: ExitState,
  runStatus: (options: StatusCommandOptions) => ExitCode | Promise<ExitCode>,
  stdout: OutputStream,
  stderr: OutputStream,
  env: NodeJS.ProcessEnv | undefined,
): void {
  program
    .command("status")
    .description("Show app status and drift")
    .argument("[app]", "app name (omit to show every app)")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(async (app: string | undefined, _options: OptionValues, command: Command) => {
      const { json } = command.optsWithGlobals<{ json?: boolean }>();

      exitState.exitCode = await runStatus({
        ...(app === undefined ? {} : { app }),
        json: json === true,
        stdout,
        stderr,
        ...(env === undefined ? {} : { environment: env }),
      });
    });
}

function registerLogs(
  program: Command,
  exitState: ExitState,
  runLogs: (options: LogsCommandOptions) => number | Promise<number>,
  stdout: OutputStream,
  stderr: OutputStream,
  env: NodeJS.ProcessEnv | undefined,
): void {
  program
    .command("logs")
    .description("Stream an app's container logs")
    .argument("<app>", "app name")
    .option("-f, --follow", "follow log output")
    .option("--tail <n>", "number of lines to show before following")
    .action(async (app: string, _options: OptionValues, command: Command) => {
      const opts = command.optsWithGlobals<{ follow?: boolean; tail?: string; json?: boolean }>();

      // The logs handler returns the Podman exit status, which is a number.
      exitState.exitCode = (await runLogs({
        app,
        ...(opts.follow === undefined ? {} : { follow: opts.follow }),
        ...(opts.tail === undefined ? {} : { tail: opts.tail }),
        stdout,
        stderr,
        ...(env === undefined ? {} : { environment: env }),
      })) as ExitCode;
    });
}

function registerUpdate(
  program: Command,
  exitState: ExitState,
  runUpdate: (options: UpdateCommandOptions) => ExitCode | Promise<ExitCode>,
  stdout: OutputStream,
  stderr: OutputStream,
  env: NodeJS.ProcessEnv | undefined,
): void {
  program
    .command("update")
    .description("Rebuild or recreate an app")
    .argument("<app>", "app name")
    .option("--rebuild", "force a rebuild even when the ref is unchanged")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(async (app: string, _options: OptionValues, command: Command) => {
      const opts = command.optsWithGlobals<{ rebuild?: boolean; json?: boolean }>();

      exitState.exitCode = await runUpdate({
        app,
        ...(opts.rebuild === undefined ? {} : { rebuild: opts.rebuild }),
        json: opts.json === true,
        stdout,
        stderr,
        ...(env === undefined ? {} : { environment: env }),
      });
    });
}

function registerRollback(
  program: Command,
  exitState: ExitState,
  runRollback: (options: RollbackCommandOptions) => ExitCode | Promise<ExitCode>,
  stdout: OutputStream,
  stderr: OutputStream,
  env: NodeJS.ProcessEnv | undefined,
): void {
  program
    .command("rollback")
    .description("Swap an app back to its previous image")
    .argument("<app>", "app name")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(async (app: string, _options: OptionValues, command: Command) => {
      const opts = command.optsWithGlobals<{ json?: boolean }>();

      exitState.exitCode = await runRollback({
        app,
        json: opts.json === true,
        stdout,
        stderr,
        ...(env === undefined ? {} : { environment: env }),
      });
    });
}

function registerRemove(
  program: Command,
  exitState: ExitState,
  runRemove: (options: RemoveCommandOptions) => ExitCode | Promise<ExitCode>,
  stdout: OutputStream,
  stderr: OutputStream,
  env: NodeJS.ProcessEnv | undefined,
): void {
  program
    .command("remove")
    .description("Remove an app and its resources")
    .argument("<app>", "app name")
    .option("--volumes", "also delete the app's named volumes")
    .option("--yes", "confirm non-interactively")
    .option("--force", "remove without confirmation prompts")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(async (app: string, _options: OptionValues, command: Command) => {
      const opts = command.optsWithGlobals<{
        volumes?: boolean;
        yes?: boolean;
        force?: boolean;
        json?: boolean;
      }>();

      exitState.exitCode = await runRemove({
        app,
        ...(opts.volumes === undefined ? {} : { volumes: opts.volumes }),
        ...(opts.yes === undefined ? {} : { yes: opts.yes }),
        ...(opts.force === undefined ? {} : { force: opts.force }),
        json: opts.json === true,
        stdout,
        stderr,
        ...(env === undefined ? {} : { environment: env }),
      });
    });
}

function registerConfig(
  program: Command,
  exitState: ExitState,
  runConfig: (options: ConfigCommandOptions) => ExitCode | Promise<ExitCode>,
  stdout: OutputStream,
  stderr: OutputStream,
  env: NodeJS.ProcessEnv | undefined,
): void {
  program
    .command("config")
    .description("Show or edit an app's configuration")
    .argument("<app>", "app name")
    .option("--path", "print the app's directory path")
    .option("--edit", "open the app's configuration in $EDITOR")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action(async (app: string, _options: OptionValues, command: Command) => {
      const flags = command.optsWithGlobals<{
        json?: boolean;
        path?: boolean;
        edit?: boolean;
      }>();

      exitState.exitCode = await runConfig({
        app,
        ...(flags.path === true ? { path: true } : {}),
        ...(flags.edit === true ? { edit: true } : {}),
        json: flags.json === true,
        stdout,
        stderr,
        ...(env === undefined ? {} : { environment: env }),
      });
    });
}

function registerDoctor(
  program: Command,
  exitState: ExitState,
  runDoctor: (options: DoctorCommandOptions) => ExitCode,
  stdout: OutputStream,
  env: NodeJS.ProcessEnv | undefined,
): void {
  program
    .command("doctor")
    .description("Check host prerequisites")
    .option("--json", "write one machine-readable JSON document to stdout")
    .action((_options: OptionValues, command: Command) => {
      const { json } = command.optsWithGlobals<{ json?: boolean }>();

      exitState.exitCode = runDoctor({
        json: json === true,
        stdout,
        ...(env === undefined ? {} : { env }),
      });
    });
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
        writeJsonDocument(stdout, toVersionDocument(version));
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
