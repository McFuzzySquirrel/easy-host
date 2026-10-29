/**
 * Container environment assembly (REG-FR-06, PRD-NF-10).
 *
 * Values come from two places: the inline `[env]` table in `config.toml` and an
 * optional secrets file (`secrets.env` by default, or the `env_file` path from
 * the config). The secrets file is applied second, so it wins on duplicate
 * keys. Secrets are therefore never required in `config.toml` (PRD-SP-01).
 *
 * Parsing accepts `KEY=VALUE` lines, blank lines, full-line comments, inline
 * comments after unquoted values, and single- or double-quoted values. Invalid
 * names and malformed lines raise a usage error (exit 1) that names the file
 * and line but never the value (PRD-NF-10).
 *
 * {@link loadEnvironment} returns the merged values for the container plus a
 * {@link redactEnvironment redacted view} that is safe to render in logs and
 * `--json` diagnostics.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PrerequisiteError, REDACTED, UsageError } from "../cli/errors.js";
import { type AppSpec, ENV_NAME_PATTERN } from "./schema.js";

/**
 * Default secrets file inside the app directory. `env_file` in `config.toml`
 * selects an alternate app-relative file.
 */
export const DEFAULT_SECRETS_FILE = "secrets.env";

/** Stable diagnostic code for a malformed secrets file. */
export const INVALID_ENV_FILE_CODE = "INVALID_ENV_FILE";

/** Stable diagnostic code for a declared secrets file that does not exist. */
export const SECRETS_FILE_MISSING_CODE = "SECRETS_FILE_MISSING";

/** The inline `[env]` table and optional secrets file selected by the config. */
export type EnvironmentSpec = Pick<AppSpec, "env" | "env_file">;

export interface EnvironmentFileErrorInit {
  /** File name or resolved path shown in the diagnostic. */
  file: string;
  /** 1-based line number for a malformed line. */
  line?: number;
  /** Original exception, kept for `EASY_HOST_DEBUG=1` diagnostics. */
  cause?: unknown;
}

/**
 * A usage failure raised while reading or parsing a secrets file. Only the
 * file and line are recorded — never the offending value.
 */
export class EnvironmentFileError extends UsageError {
  readonly file: string;
  readonly line: number | undefined;

  constructor(reason: string, init: EnvironmentFileErrorInit) {
    const location = init.line === undefined ? "" : `:${init.line}`;
    const details: Record<string, string | number> = { file: init.file, reason };
    if (init.line !== undefined) {
      details.line = init.line;
    }

    super(`invalid ${init.file}${location}: ${reason}`, {
      code: INVALID_ENV_FILE_CODE,
      details,
      remediation: `Edit ${init.file}${init.line === undefined ? "" : ` line ${init.line}`} and retry.`,
      ...(init.cause === undefined ? {} : { cause: init.cause }),
    });

    this.file = init.file;
    this.line = init.line;
  }
}

export interface SecretsParseOptions {
  /** File name or resolved path used in diagnostics. Defaults to `secrets.env`. */
  file?: string;
}

/**
 * Parses secrets-file text into a name-to-value map.
 *
 * Parsing rules:
 * - blank lines and lines whose first non-space character is `#` are ignored;
 * - a line must contain `=`, and the name before it must match
 *   {@link ENV_NAME_PATTERN};
 * - surrounding whitespace is trimmed from unquoted values, and a `#`
 *   preceded by whitespace starts an inline comment;
 * - `'…'` values are literal; `"…"` values accept `\n`, `\r`, `\t`, `\"`,
 *   `\'`, and `\\`;
 * - a repeated key keeps the last value, matching dotenv semantics.
 *
 * @throws {EnvironmentFileError} for a malformed line. The error records the
 * line number and never the value.
 */
export function parseSecretsFile(
  source: string,
  options: SecretsParseOptions = {},
): Record<string, string> {
  const file = options.file ?? DEFAULT_SECRETS_FILE;
  const entries: Record<string, string> = {};
  // A BOM is metadata, not part of the first variable name.
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    const line = index + 1;

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const separator = raw.indexOf("=");
    if (separator < 0) {
      throw new EnvironmentFileError("must be a KEY=VALUE line", { file, line });
    }

    const name = raw.slice(0, separator).trim();
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new EnvironmentFileError("is not a valid environment variable name", { file, line });
    }

    entries[name] = parseSecretValue(raw.slice(separator + 1), file, line);
  }

  return entries;
}

/**
 * Merges inline `[env]` values with secrets-file values. File values override
 * inline values on duplicate keys, as required by REG-FR-06.
 */
export function mergeEnvironment(
  inline: Readonly<Record<string, string>> = {},
  secrets: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...inline, ...secrets };
}

/**
 * Diagnostics-safe view of an environment: every name is preserved so an
 * operator can see which variables exist, and every value is replaced with
 * {@link REDACTED}. The result never contains a secret value.
 */
export function redactEnvironment(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const redacted: Record<string, string> = {};

  for (const name of Object.keys(environment)) {
    redacted[name] = REDACTED;
  }

  return redacted;
}

/** Reads a secrets file, returning `undefined` when it does not exist. */
export type SecretsFileReader = (target: string) => string | undefined;

export interface LoadEnvironmentOptions {
  /**
   * File reader, injectable for tests. Defaults to a synchronous read that
   * treats `ENOENT` as an absent optional file.
   */
  read?: SecretsFileReader;
  /** File name or path used in diagnostics instead of the resolved path. */
  file?: string;
}

/**
 * The merged environment for one container.
 *
 * `values` contains secret material: pass it to the container runtime only and
 * never log it. Use `redacted` for diagnostics.
 */
export interface ContainerEnvironment {
  /** Merged environment; may contain secrets. */
  readonly values: Readonly<Record<string, string>>;
  /** Sorted variable names present after merging. */
  readonly names: readonly string[];
  /** Name-to-`[redacted]` map safe for logs and JSON output. */
  readonly redacted: Readonly<Record<string, string>>;
  /** Resolved secrets file, or `undefined` when no file was read. */
  readonly file: string | undefined;
}

/**
 * Reads the optional secrets file for an app and merges it over the inline
 * `[env]` table.
 *
 * A missing default `secrets.env` is fine. A missing `env_file` that the
 * config declares is a usage error (exit 1), because the operator explicitly
 * asked for that file. Unreadable files are prerequisite errors (exit 2).
 */
export function loadEnvironment(
  appDir: string,
  spec: EnvironmentSpec,
  options: LoadEnvironmentOptions = {},
): ContainerEnvironment {
  const root = path.resolve(appDir);
  const declared = spec.env_file !== undefined;
  const target = resolveSecretsPath(root, spec.env_file);
  const file = options.file ?? target;
  const read = options.read ?? readSecretsFile;

  let source: string | undefined;
  try {
    source = read(target);
  } catch (error) {
    throw new PrerequisiteError(`could not read secrets file "${file}"`, {
      code: "SECRETS_UNREADABLE",
      // Only the errno code is safe: a lower-level message could quote file
      // content from a custom reader (`PRD-NF-10`).
      details: { file, reason: errorCodeOf(error) },
      remediation: `Grant read permission on "${file}" and retry.`,
      cause: error,
    });
  }

  if (source === undefined) {
    if (declared) {
      throw new UsageError(`secrets file "${file}" is missing`, {
        code: SECRETS_FILE_MISSING_CODE,
        details: { file, setting: "env_file" },
        remediation: `Create "${file}", or remove "env_file" from config.toml.`,
      });
    }

    return environmentFrom(spec.env, {}, undefined);
  }

  const secrets = parseSecretsFile(source, { file });
  return environmentFrom(spec.env, secrets, file);
}

/**
 * Resolves the secrets path and keeps it inside the app directory. The schema
 * already rejects absolute and `..` paths (REG-FR-01); this second check makes
 * the module safe for callers that assemble a spec without the schema.
 */
function resolveSecretsPath(root: string, envFile: string | undefined): string {
  const relative = envFile ?? DEFAULT_SECRETS_FILE;
  const target = path.resolve(root, relative);
  const inside = path.relative(root, target);

  if (
    inside === "" ||
    path.isAbsolute(inside) ||
    inside === ".." ||
    inside.startsWith(`..${path.sep}`)
  ) {
    throw new UsageError(`env_file "${relative}" must point inside the app directory`, {
      code: INVALID_ENV_FILE_CODE,
      details: { setting: "env_file", file: relative },
      remediation: 'Use a relative env_file without ".." segments, for example "secrets.env".',
    });
  }

  return target;
}

function environmentFrom(
  inline: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>,
  file: string | undefined,
): ContainerEnvironment {
  const values = mergeEnvironment(inline, secrets);

  return {
    values,
    names: Object.keys(values).sort(),
    redacted: redactEnvironment(values),
    file,
  };
}

function readSecretsFile(target: string): string | undefined {
  try {
    return readFileSync(target, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return undefined;
    }

    throw error;
  }
}

/**
 * Parses one value. Quoted values are read literally up to the matching quote
 * and may be followed only by whitespace or a comment. Unquoted values stop at
 * a `#` that starts a word, so `PASSWORD=abc#123` stays intact.
 */
function parseSecretValue(input: string, file: string, line: number): string {
  const value = input.trim();

  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0] === '"' ? '"' : "'";
    const parsed = readQuoted(value, quote, file, line);
    ensureTrailingComment(parsed.rest, file, line);
    return assertNoNul(parsed.value, file, line);
  }

  const comment = findUnquotedComment(value);
  const unquoted = comment < 0 ? value : value.slice(0, comment).trimEnd();
  return assertNoNul(unquoted, file, line);
}

interface QuotedValue {
  value: string;
  rest: string;
}

function readQuoted(input: string, quote: '"' | "'", file: string, line: number): QuotedValue {
  let value = "";

  for (let position = 1; position < input.length; position += 1) {
    const character = input[position];

    if (character === quote) {
      return { value, rest: input.slice(position + 1) };
    }

    if (quote === '"' && character === "\\") {
      const escaped = input[position + 1];
      if (escaped === undefined) {
        break;
      }
      value += decodeEscape(escaped);
      position += 1;
      continue;
    }

    value += character;
  }

  // The message deliberately omits the content of the line.
  throw new EnvironmentFileError("has an unterminated quoted value", { file, line });
}

function decodeEscape(character: string): string {
  switch (character) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      // `\"`, `\'`, `\\`, and any other escaped character resolve to itself.
      return character;
  }
}

function ensureTrailingComment(rest: string, file: string, line: number): void {
  const trailing = rest.trim();
  if (trailing !== "" && !trailing.startsWith("#")) {
    throw new EnvironmentFileError("has unexpected text after the closing quote", { file, line });
  }
}

function findUnquotedComment(value: string): number {
  for (let position = 0; position < value.length; position += 1) {
    if (value[position] !== "#") {
      continue;
    }

    const previous = position === 0 ? "" : (value[position - 1] ?? "");
    if (previous === "" || /\s/.test(previous)) {
      return position;
    }
  }

  return -1;
}

function assertNoNul(value: string, file: string, line: number): string {
  if (value.includes("\u0000")) {
    throw new EnvironmentFileError("contains a NUL character", { file, line });
  }

  return value;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorCodeOf(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }

  return "unreadable";
}
