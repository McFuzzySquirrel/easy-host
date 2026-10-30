/**
 * Interactive prompts for `add` (ADD-FR-01).
 *
 * `add` asks only for values the operator did not supply as flags. Every
 * question has a flag equivalent in {@link ADD_PROMPT_FLAGS}, so the exact same
 * inputs can be scripted. A non-TTY or `--yes` invocation never prompts: it
 * applies the documented defaults to optional values and fails with a usage
 * error naming the first required flag that is missing (`--port`, or a
 * repository/`--local` source).
 *
 * The prompt surface is an injected {@link Prompter}, so lifecycle tests can
 * answer deterministically without a terminal and production uses
 * `@clack/prompts`. Prompt answers are trimmed; a cancelled prompt is a usage
 * failure rather than an empty value. Secret *content* is never requested —
 * only the app-relative path of the secrets file — so nothing sensitive is
 * echoed or retained (`PRD-NF-10`).
 */

import { text as clackText, isCancel } from "@clack/prompts";
import { deriveAppName } from "../config/name.js";
import { APP_SPEC_DEFAULTS, MAX_PORT, MIN_HOST_PORT } from "../config/schema.js";
import { UsageError } from "./errors.js";

/** One text question. Tests implement this narrow shape. */
export interface PromptTextOptions {
  readonly message: string;
  /** Value returned when the operator submits an empty answer. */
  readonly defaultValue?: string;
  /** Hint shown for an empty answer. */
  readonly placeholder?: string;
  /** Returns a message when the answer is rejected. */
  readonly validate?: (value: string) => string | undefined;
}

/**
 * The prompt surface used by {@link resolveAddInputs}. `isInteractive` is a
 * method so an invocation can decide per process, not at module load.
 */
export interface Prompter {
  isInteractive(): boolean;
  text(options: PromptTextOptions): Promise<string | undefined>;
}

/** Process facts used to decide whether prompting is possible. */
export interface InteractiveSessionOptions {
  /** Overrides `process.stdin.isTTY`, so tests never touch the real terminal. */
  readonly stdinIsTTY?: boolean;
  /** Environment used for the explicit `EASY_HOST_NO_PROMPT=1` escape hatch. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * True only when stdin is a terminal and prompting has not been disabled. A
 * piped or redirected stdin is non-interactive, which is what makes a CI run
 * fail fast instead of hanging on a prompt.
 */
export function isInteractiveSession(options: InteractiveSessionOptions = {}): boolean {
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const env = options.env ?? process.env;

  return stdinIsTTY && env.EASY_HOST_NO_PROMPT !== "1";
}

/** A `@clack/prompts`-backed prompter. */
export function createClackPrompter(options: InteractiveSessionOptions = {}): Prompter {
  return {
    isInteractive: () => isInteractiveSession(options),
    async text(prompt) {
      const answer = await clackText({
        message: prompt.message,
        ...(prompt.defaultValue === undefined ? {} : { defaultValue: prompt.defaultValue }),
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
        ...(prompt.validate === undefined
          ? {}
          : { validate: (value: string | undefined) => prompt.validate?.(value ?? "") }),
      });

      return isCancel(answer) ? undefined : answer;
    },
  };
}

/**
 * The flag that answers each prompt. This table is the flag-parity contract:
 * a new prompt without an entry here is a bug, and the unit test asserts one
 * flag per question.
 */
export const ADD_PROMPT_FLAGS = {
  source: "<git-url> or --local <path>",
  name: "--name",
  port: "--port",
  ref: "--ref",
  containerPort: "--container-port",
  bind: "--bind",
  healthPath: "--health-path",
  envFile: "--env-file",
} as const;

export type AddPromptField = keyof typeof ADD_PROMPT_FLAGS;

/** Values already supplied by the operator before prompting. */
export interface AddInputValues {
  readonly repo?: string;
  readonly localPath?: string;
  readonly name?: string;
  readonly port?: string | number;
  readonly ref?: string;
  readonly containerPort?: string | number;
  readonly bind?: string;
  readonly healthPath?: string;
  readonly envFile?: string;
  readonly probe?: string;
}

/** Fully resolved values, with the documented defaults applied. */
export interface ResolvedAddValues {
  readonly repo?: string;
  readonly localPath?: string;
  readonly name?: string;
  readonly port: number;
  readonly ref: string;
  readonly containerPort: number;
  readonly bind: string;
  readonly healthPath: string;
  readonly envFile?: string;
  readonly probe: string;
}

export interface ResolveAddInputsOptions {
  readonly prompter?: Prompter;
  /** Overrides the prompter's terminal detection. */
  readonly interactive?: boolean;
  /** `--yes`: never prompt and require every value that has no default. */
  readonly yes?: boolean;
}

/**
 * Resolves every `add` value, prompting only for the ones not supplied.
 *
 * The prompt order matches the operator's mental model: source, name, port,
 * ref, container port, bind, health path, secret file. Optional values offer
 * their documented default; the host port never does, because easy-host does
 * not allocate ports.
 *
 * @throws {UsageError} `MISSING_FLAG` naming the first required flag absent in
 * a non-interactive session, `INVALID_FLAG_VALUE` for a non-numeric port, or
 * `PROMPT_CANCELLED` when the operator cancels.
 */
export async function resolveAddInputs(
  values: AddInputValues = {},
  options: ResolveAddInputsOptions = {},
): Promise<ResolvedAddValues> {
  const prompter = options.prompter ?? createClackPrompter();
  const interactive =
    options.yes === true ? false : (options.interactive ?? prompter.isInteractive());

  let repo = textOf(values.repo);
  let localPath = textOf(values.localPath);

  if (repo !== undefined && localPath !== undefined) {
    throw conflictingSourceError();
  }

  if (repo === undefined && localPath === undefined) {
    if (!interactive) {
      throw missingFlagError("source");
    }

    const answer = await ask(prompter, {
      message: "Repository URL (https, ssh, git) or local path",
      placeholder: "https://github.com/owner/repo.git",
      validate: (value) =>
        value.trim().length === 0 ? "Enter a repository URL or a local path." : undefined,
    });

    if (answer.length === 0) {
      throw emptySourceError();
    }

    if (isRepositorySource(answer)) {
      repo = answer;
    } else {
      localPath = answer;
    }
  }

  const source = repo ?? localPath ?? "";
  const derived = derivedName(source);
  let name = textOf(values.name);

  if (name === undefined && interactive) {
    const answer = await ask(prompter, {
      message: "App name",
      ...(derived.length === 0 ? {} : { defaultValue: derived, placeholder: derived }),
      ...(derived.length === 0
        ? {
            validate: (value: string) =>
              value.trim().length === 0 ? "Enter an app name." : undefined,
          }
        : {}),
    });
    name = answer.length > 0 ? answer : derived.length > 0 ? derived : undefined;
  }

  if (name === undefined) {
    if (derived.length > 0) {
      name = derived;
    } else if (!interactive) {
      throw missingFlagError("name");
    }
  }

  let port = parseNumberValue(values.port, "port");

  if (port === undefined && interactive) {
    const answer = await ask(prompter, {
      message: `Host port (${MIN_HOST_PORT}-${MAX_PORT}); easy-host never picks one`,
      validate: validatePortAnswer,
    });
    port = Number(answer);
  }

  if (port === undefined) {
    throw missingFlagError("port");
  }

  let ref = textOf(values.ref);
  if (ref === undefined) {
    ref = interactive
      ? await askWithDefault(prompter, {
          message: "Git ref to build",
          defaultValue: APP_SPEC_DEFAULTS.ref,
        })
      : APP_SPEC_DEFAULTS.ref;
  }

  let containerPort = parseNumberValue(values.containerPort, "containerPort");
  if (containerPort === undefined) {
    containerPort = interactive
      ? Number(
          await askWithDefault(prompter, {
            message: "Container port the app listens on",
            defaultValue: String(APP_SPEC_DEFAULTS.container_port),
            validate: validatePortAnswer,
          }),
        )
      : APP_SPEC_DEFAULTS.container_port;
  }

  let bind = textOf(values.bind);
  if (bind === undefined) {
    bind = interactive
      ? await askWithDefault(prompter, {
          message: "Bind address for the published port",
          defaultValue: APP_SPEC_DEFAULTS.bind,
        })
      : APP_SPEC_DEFAULTS.bind;
  }

  let healthPath = textOf(values.healthPath);
  if (healthPath === undefined) {
    healthPath = interactive
      ? await askWithDefault(prompter, {
          message: "Health path used by the readiness probe",
          defaultValue: APP_SPEC_DEFAULTS.health_path,
        })
      : APP_SPEC_DEFAULTS.health_path;
  }

  let envFile = textOf(values.envFile);
  if (envFile === undefined && interactive) {
    const answer = await ask(prompter, {
      message: "Secret file path (app-relative; leave blank for the default secrets.env)",
      placeholder: "secrets.env",
    });
    envFile = answer.length > 0 ? answer : undefined;
  }

  const probe = textOf(values.probe) ?? APP_SPEC_DEFAULTS.probe;

  return {
    ...(repo === undefined ? {} : { repo }),
    ...(localPath === undefined ? {} : { localPath }),
    ...(name === undefined ? {} : { name }),
    port,
    ref,
    containerPort,
    bind,
    healthPath,
    ...(envFile === undefined ? {} : { envFile }),
    probe,
  };
}

/** True when the source looks like a git remote rather than a filesystem path. */
export function isRepositorySource(value: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    return true;
  }

  return /^[^@\s/\\]+@[^:\s/\\]+:/.test(value);
}

function derivedName(source: string): string {
  if (source.length === 0) {
    return "";
  }

  try {
    return deriveAppName(source);
  } catch {
    // The lifecycle layer turns a missing derived name into a named usage
    // error; the prompt can still accept an explicit answer.
    return "";
  }
}

async function ask(prompter: Prompter, options: PromptTextOptions): Promise<string> {
  const answer = await prompter.text(options);

  if (answer === undefined) {
    throw promptCancelledError();
  }

  return answer.trim();
}

async function askWithDefault(
  prompter: Prompter,
  options: PromptTextOptions & { readonly defaultValue: string },
): Promise<string> {
  const answer = await ask(prompter, options);
  return answer.length > 0 ? answer : options.defaultValue;
}

function validatePortAnswer(value: string): string | undefined {
  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    return "Enter a whole-number port.";
  }

  const port = Number(trimmed);
  if (port < MIN_HOST_PORT || port > MAX_PORT) {
    return `Enter a port between ${MIN_HOST_PORT} and ${MAX_PORT}.`;
  }

  return undefined;
}

function parseNumberValue(
  value: string | number | undefined,
  field: "port" | "containerPort",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const text = String(value).trim();
  if (text.length === 0) {
    return undefined;
  }

  if (!/^\d+$/.test(text)) {
    throw invalidFlagValue(field, text);
  }

  return Number(text);
}

function textOf(value: string | number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const text = String(value).trim();
  return text.length === 0 ? undefined : text;
}

function missingFlagError(field: AddPromptField): UsageError {
  const flag = ADD_PROMPT_FLAGS[field];

  return new UsageError(`missing required value ${flag} in a non-interactive session`, {
    code: "MISSING_FLAG",
    details: { field, flag },
    remediation: `Pass ${flag} explicitly, or run "easy-host add" on a terminal to be prompted.`,
  });
}

function invalidFlagValue(field: "port" | "containerPort", received: string): UsageError {
  const flag = ADD_PROMPT_FLAGS[field];

  return new UsageError(`invalid ${flag} value: must be a whole number`, {
    code: "INVALID_FLAG_VALUE",
    details: { field, flag, received },
    remediation: `Pass a whole-number value for ${flag}.`,
  });
}

function conflictingSourceError(): UsageError {
  return new UsageError("pass either a repository URL or --local <path>, not both", {
    code: "CONFLICTING_SOURCE",
    details: { repository: ADD_PROMPT_FLAGS.source },
    remediation: "Choose a git repository or a local path for the app source.",
  });
}

function emptySourceError(): UsageError {
  return new UsageError("a repository URL or local path is required", {
    code: "MISSING_SOURCE",
    details: { source: ADD_PROMPT_FLAGS.source },
    remediation: "Enter a repository URL or a local path for the app source.",
  });
}

function promptCancelledError(): UsageError {
  return new UsageError("add was cancelled before every required value was provided", {
    code: "PROMPT_CANCELLED",
    remediation: `Re-run "easy-host add" and answer each prompt, or pass the flags directly.`,
  });
}
