/**
 * The `config` command handler (`ADD-FR-06`).
 *
 * `config` has four modes:
 *
 * - `--path` prints the app's `config.toml` path and confirms it exists;
 * - `--edit` opens that file in the editor named by `$EDITOR`, waits for it to
 *   exit, then re-validates the file without applying or rewriting anything
 *   (PRD open question 2/3);
 * - `--json` emits one `schemaVersion: 1` document with the validated spec and
 *   every `[env]` value redacted;
 * - no flag prints the path, validates the file, and prints a short summary.
 *
 * The command never writes configuration itself: the editor does, and a bad
 * result is reported through the shared error renderer with the offending key
 * named. Unknown apps exit 5 through the registry.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AppSpec } from "../../config/schema.js";
import type { AppRecord } from "../../registry/store.js";
import {
  EXIT_CODES,
  type ExitCode,
  NotFoundError,
  PrerequisiteError,
  reportError,
  UsageError,
} from "../errors.js";
import {
  formatField,
  probeDescription,
  type ReadDependencyOverrides,
  type ReadOutputStream,
  redactedSpec,
  resolveReadDependencies,
  sourceDescription,
} from "./read-model.js";

/** One resolved editor command line. */
export interface EditorInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly file: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** Runs the configured editor and returns its exit code. */
export type EditorRunner = (invocation: EditorInvocation) => number | Promise<number>;

/** Options accepted by {@link runConfigCommand}. */
export interface ConfigCommandOptions extends ReadDependencyOverrides {
  /** App whose configuration is inspected. */
  readonly app: string;
  /** Print only the config file path. */
  readonly path?: boolean;
  /** Open the config file in `$EDITOR`, then validate it. */
  readonly edit?: boolean;
  /** Emit one machine-readable document. */
  readonly json?: boolean;
  /** Destination for output. Defaults to stdout. */
  readonly stdout?: ReadOutputStream;
  /** Destination for human errors. Defaults to stderr. */
  readonly stderr?: ReadOutputStream;
  /** Editor seam; production uses {@link createDefaultEditorRunner}. */
  readonly editorRunner?: EditorRunner;
  /** Existence probe, injectable for tests. Defaults to `existsSync`. */
  readonly pathExists?: (target: string) => boolean;
}

/** The stable `config --json` document (`schemaVersion: 1`). */
export interface ConfigDocument {
  readonly schemaVersion: 1;
  readonly app: string;
  readonly path: string;
  readonly valid: true;
  readonly config: Record<string, unknown>;
}

type ConfigMode = "path" | "edit" | "json" | "validate";

/**
 * Runs `config` and returns the documented exit code. An invalid config exits
 * 1 with the key and value named; a missing app or file exits 5.
 */
export async function runConfigCommand(options: ConfigCommandOptions): Promise<ExitCode> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.environment ?? process.env;

  try {
    const mode = resolveMode(options);

    if (typeof options.app !== "string" || options.app.trim().length === 0) {
      throw new UsageError("config requires an app name", {
        code: "MISSING_APP",
        details: { command: "config" },
        remediation:
          'Run "easy-host list" and pass one app name, for example "easy-host config blog".',
      });
    }

    const dependencies = resolveReadDependencies(options);
    const record = dependencies.registry.record(options.app);

    if (mode === "path") {
      const exists = options.pathExists ?? existsSync;
      if (!exists(record.configPath)) {
        throw new NotFoundError(`config file "${record.configPath}" was not found`, {
          code: "CONFIG_NOT_FOUND",
          details: { app: record.name, path: record.configPath },
          remediation: `Create "${record.configPath}" with "easy-host config ${record.name} --edit", or re-add the app.`,
        });
      }

      stdout.write(`${record.configPath}\n`);
      return EXIT_CODES.SUCCESS;
    }

    if (mode === "edit") {
      await runEditor(record, dependencies.environment, options, stderr);
    }

    // Validation runs after a successful edit and for the read-only modes.
    // The registry reads the file; it never writes it.
    const spec = dependencies.registry.readConfig(record.name);

    stdout.write(
      mode === "json"
        ? `${JSON.stringify(toConfigDocument(record, spec), null, 2)}\n`
        : formatConfigReport(record, spec),
    );

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

function resolveMode(options: ConfigCommandOptions): ConfigMode {
  const selected = [options.path === true, options.edit === true, options.json === true].filter(
    Boolean,
  ).length;

  if (selected > 1) {
    throw new UsageError("config accepts only one of --path, --edit, or --json", {
      code: "INVALID_FLAG_COMBINATION",
      details: { command: "config" },
      remediation: 'Run "easy-host config <app> [--path | --edit | --json]" with a single mode.',
    });
  }

  if (options.path === true) {
    return "path";
  }

  if (options.edit === true) {
    return "edit";
  }

  return options.json === true ? "json" : "validate";
}

async function runEditor(
  record: AppRecord,
  environment: NodeJS.ProcessEnv,
  options: ConfigCommandOptions,
  stderr: ReadOutputStream,
): Promise<void> {
  const parsed = parseEditorCommand(environment.EDITOR);

  if (parsed === undefined) {
    throw new UsageError("no editor is configured: EDITOR is not set", {
      code: "EDITOR_NOT_SET",
      details: { app: record.name, file: record.configPath },
      remediation:
        'Set EDITOR to an editor command, for example EDITOR="vim" or EDITOR="code --wait", then retry.',
    });
  }

  const runner = options.editorRunner ?? createDefaultEditorRunner();
  const exitCode = await runner({
    command: parsed.command,
    args: parsed.args,
    file: record.configPath,
    environment,
  });

  if (exitCode !== 0) {
    throw new PrerequisiteError(
      `editor "${parsed.command}" exited with code ${exitCode} before the file was saved`,
      {
        code: "EDITOR_FAILED",
        details: { app: record.name, file: record.configPath, exitCode },
        remediation: `Set EDITOR to an editor that opens config.toml and exits 0, then retry "easy-host config ${record.name} --edit".`,
      },
    );
  }

  // The editor is interactive; a quiet note on stderr confirms the file was
  // reopened for validation without pretending the app was changed.
  stderr.write(
    `easy-host: validating ${record.configPath} (the app is not updated until you run "easy-host update ${record.name}")\n`,
  );
}

/**
 * The production editor runner. It uses an argument array, never a shell
 * string, and inherits the terminal so an interactive editor works normally.
 */
export function createDefaultEditorRunner(): EditorRunner {
  return (invocation) => {
    const result = spawnSync(invocation.command, [...invocation.args, invocation.file], {
      stdio: "inherit",
      env: invocation.environment,
    });

    if (result.error !== undefined) {
      throw new PrerequisiteError(
        `could not start editor "${invocation.command}": ${result.error.message}`,
        {
          code: "EDITOR_FAILED",
          details: {
            editor: invocation.command,
            file: invocation.file,
            reason: result.error.message,
          },
          remediation:
            'Set EDITOR to an executable on PATH, for example EDITOR="vim" or EDITOR="code --wait".',
          cause: result.error,
        },
      );
    }

    if (result.status === null) {
      throw new PrerequisiteError(
        `editor "${invocation.command}" did not exit normally${
          result.signal === null ? "" : ` (signal ${result.signal})`
        }`,
        {
          code: "EDITOR_FAILED",
          details: {
            editor: invocation.command,
            file: invocation.file,
            signal: result.signal ?? "none",
          },
          remediation: `Close the editor normally, then retry "easy-host config --edit".`,
        },
      );
    }

    return result.status;
  };
}

/**
 * Splits `$EDITOR` into a command and arguments without a shell. Single and
 * double quotes group a token; a backslash escapes the next character outside
 * single quotes. An empty value means no editor.
 */
export function parseEditorCommand(
  value: string | undefined,
): { readonly command: string; readonly args: readonly string[] } | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const tokens = tokenize(value.trim());
  const [command, ...args] = tokens;

  if (command === undefined || command.length === 0) {
    return undefined;
  }

  return { command, args };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && quote === '"' && index + 1 < input.length) {
        index += 1;
        current += input[index] ?? "";
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (character === "\\" && index + 1 < input.length) {
      index += 1;
      current += input[index] ?? "";
      continue;
    }

    current += character;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * The human summary: path, validation result, source, port, probe settings,
 * declared volumes, and environment variable names. Values are never printed.
 */
export function formatConfigReport(record: AppRecord, spec: AppSpec): string {
  const lines = [
    ...formatField("config", record.configPath),
    ...formatField("status", "valid"),
    ...formatField("app", record.name),
    ...formatField("source", sourceDescription(spec)),
    ...formatField("port", `${spec.port} -> ${spec.container_port} on ${spec.bind}`),
    ...formatField("probe", probeDescription(spec)),
  ];

  const volumes = Object.entries(spec.volumes)
    .map(([name, target]) => `${name}:${target}`)
    .join(", ");
  if (volumes.length > 0) {
    lines.push(...formatField("volumes", volumes));
  }

  const environmentNames = Object.keys(spec.env).sort();
  if (environmentNames.length > 0) {
    lines.push(...formatField("env", `${environmentNames.join(", ")} (values hidden)`));
  }

  return `${lines.join("\n")}\n`;
}

/** Builds the `config --json` document with every `[env]` value redacted. */
export function toConfigDocument(record: AppRecord, spec: AppSpec): ConfigDocument {
  return {
    schemaVersion: 1,
    app: record.name,
    path: record.configPath,
    valid: true,
    config: redactedSpec(spec),
  };
}
