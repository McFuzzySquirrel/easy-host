/**
 * `config.toml` read/write layer (REG-FR-01).
 *
 * Parsing is strict: unknown keys, wrong types, out-of-range ports, unsupported
 * bind addresses, and path traversal are rejected with the offending key named.
 * Serialization is deterministic and can carry full-line and end-of-line
 * comments forward from the source document, so a round-trip through
 * parse → edit → serialize keeps hand-written annotations (REG-US-01).
 *
 * This module performs no filesystem or process I/O. Callers validate first and
 * only then touch the app directory (`PRD-NF-03`).
 */

import { parse as parseToml, TomlError, type TomlTableWithoutBigInt } from "smol-toml";
import type { z } from "zod";
import {
  APP_SPEC_KEYS,
  type AppSpec,
  appSpecSchema,
  ConfigValidationError,
  describeConfigValue,
} from "./schema.js";

/** Default name used in validation errors. */
export const CONFIG_FILE_NAME = "config.toml";

export interface ParseConfigOptions {
  /** File name shown in errors. Defaults to `config.toml`. */
  file?: string;
}

export interface SerializeConfigOptions {
  /**
   * Original TOML text. Comment blocks and end-of-line comments attached to
   * keys or table entries are carried into the output. Values always come from
   * the supplied spec, never from the source. Defaults to the document that
   * produced `spec` via {@link parseConfigToml}, so a plain parse/serialize
   * round-trip preserves comments without extra plumbing.
   */
  source?: string;
}

/**
 * The source document associated with a parsed spec. Keeping it out of the
 * `AppSpec` shape means JSON output and equality checks stay clean, while
 * `serializeConfig(parseConfigToml(text))` still round-trips comments.
 */
const configSources = new WeakMap<AppSpec, string>();

/**
 * Parses TOML text into a fully-defaulted {@link AppSpec}.
 *
 * @throws {ConfigValidationError} for TOML syntax errors and every validation
 * failure. The error names the key and the received value, except for `[env]`
 * values, which are never echoed.
 */
export function parseConfigToml(source: string, options: ParseConfigOptions = {}): AppSpec {
  const file = options.file ?? CONFIG_FILE_NAME;

  let table: TomlTableWithoutBigInt;
  try {
    table = parseToml(source, {
      // `__proto__` and `constructor` keys could otherwise mutate prototypes.
      unsafeKeyBehaviour: "throw",
    });
  } catch (error) {
    throw tomlSyntaxError(error, file);
  }

  const spec = validateAppSpec(table, { file });
  configSources.set(spec, source);
  return spec;
}

/**
 * Validates an already-decoded TOML object (or any unknown input) and applies
 * defaults. Exposed separately so callers such as the add command can validate
 * a spec assembled from flags without rendering it to TOML first.
 */
export function validateAppSpec(input: unknown, options: ParseConfigOptions = {}): AppSpec {
  const file = options.file ?? CONFIG_FILE_NAME;
  const result = appSpecSchema.safeParse(input);

  if (!result.success) {
    throw configErrorFromIssue(result.error.issues[0], input, file);
  }

  return result.data;
}

/**
 * Renders a spec as canonical TOML. When `source` is provided, comments that
 * belong to a still-present key or table entry are preserved. Output order is
 * stable regardless of the source order, which keeps diffs small.
 */
export function serializeConfig(spec: AppSpec, options: SerializeConfigOptions = {}): string {
  const source = options.source ?? configSources.get(spec);
  const comments = source === undefined ? emptyComments() : collectComments(source);
  const lines: string[] = [];

  const topLevel: Array<readonly [string, string | number | undefined]> = [
    ["repo", spec.repo],
    ["local_path", spec.local_path],
    ["ref", spec.ref],
    ["port", spec.port],
    ["container_port", spec.container_port],
    ["bind", spec.bind],
    ["probe", spec.probe],
    ["health_path", spec.health_path],
    ["health_interval_ms", spec.health_interval_ms],
    ["health_timeout_ms", spec.health_timeout_ms],
    ["health_startup_ms", spec.health_startup_ms],
    ["env_file", spec.env_file],
  ];

  for (const [key, value] of topLevel) {
    if (value === undefined) {
      continue;
    }
    appendCommentBlock(lines, comments.top.get(key));
    lines.push(`${key} = ${tomlValue(value)}${comments.inline.get(key) ?? ""}`);
  }

  appendTable(lines, comments, "volumes", spec.volumes);
  appendTable(lines, comments, "env", spec.env);

  appendCommentBlock(lines, comments.trailing);

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/**
 * Appends a table only when it has entries. An empty table is indistinguishable
 * from an absent one after parsing, so emitting it would add noise.
 */
function appendTable(
  lines: string[],
  comments: CommentIndex,
  name: string,
  entries: Readonly<Record<string, string>>,
): void {
  const names = Object.keys(entries);
  if (names.length === 0) {
    return;
  }

  if (lines.length > 0 && lines.at(-1) !== "") {
    lines.push("");
  }

  appendCommentBlock(lines, comments.sections.get(name));
  lines.push(`[${name}]`);

  for (const entryName of names) {
    const entryKey = `${name}.${entryName}`;
    appendCommentBlock(lines, comments.entries.get(entryKey));
    const value = entries[entryName];
    if (value === undefined) {
      continue;
    }
    lines.push(`${entryName} = ${tomlValue(value)}${comments.inline.get(entryKey) ?? ""}`);
  }
}

/**
 * Appends a preserved comment block, collapsing repeated blank lines so the
 * output stays readable after a programmatic edit.
 */
function appendCommentBlock(lines: string[], block: readonly string[] | undefined): void {
  if (block === undefined || block.length === 0) {
    return;
  }

  let previousBlank = lines.at(-1) === "";
  for (const line of block) {
    if (line === "") {
      if (!previousBlank) {
        lines.push("");
        previousBlank = true;
      }
      continue;
    }

    lines.push(line);
    previousBlank = false;
  }
}

interface CommentIndex {
  top: Map<string, string[]>;
  sections: Map<string, string[]>;
  entries: Map<string, string[]>;
  inline: Map<string, string>;
  trailing: string[];
}

function emptyComments(): CommentIndex {
  return {
    top: new Map(),
    sections: new Map(),
    entries: new Map(),
    inline: new Map(),
    trailing: [],
  };
}

const SECTION_PATTERN = /^\[([A-Za-z0-9_-]+)\]$/;
const KEY_PATTERN = /^([A-Za-z0-9_-]+)\s*=/;

/**
 * Indexes comments by the key or table entry they precede. Only comments
 * attached to a key that survives re-serialization are emitted again; comments
 * for a removed key are intentionally dropped.
 */
function collectComments(source: string): CommentIndex {
  const index = emptyComments();
  let pending: string[] = [];
  let section: string | undefined;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      pending.push(trimmed === "" ? "" : line);
      continue;
    }

    const sectionMatch = SECTION_PATTERN.exec(trimmed);
    if (sectionMatch !== null) {
      const name = sectionMatch[1];
      if (name !== undefined) {
        index.sections.set(name, normalizeBlock(pending));
        section = name;
      }
      pending = [];
      continue;
    }

    const keyMatch = KEY_PATTERN.exec(trimmed);
    if (keyMatch !== null) {
      const key = keyMatch[1];
      if (key !== undefined) {
        const { comment } = splitInlineComment(line);
        const qualified = section === undefined ? key : `${section}.${key}`;
        if (section === undefined) {
          index.top.set(key, normalizeBlock(pending));
        } else {
          index.entries.set(qualified, normalizeBlock(pending));
        }
        if (comment !== undefined) {
          index.inline.set(qualified, `  ${comment}`);
        }
      }
      pending = [];
      continue;
    }

    // A multiline array or anything the index does not model: drop the pending
    // block rather than attaching it to the wrong key.
    pending = [];
  }

  index.trailing = normalizeBlock(pending);
  return index;
}

/**
 * Splits an end-of-line comment from a TOML line while respecting basic and
 * literal strings, so `#` inside a value is not mistaken for a comment.
 */
function splitInlineComment(line: string): { comment?: string } {
  let inBasic = false;
  let inLiteral = false;
  let escaped = false;

  for (let position = 0; position < line.length; position += 1) {
    const character = line[position];

    if (inBasic) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inBasic = false;
      }
      continue;
    }

    if (inLiteral) {
      if (character === "'") {
        inLiteral = false;
      }
      continue;
    }

    if (character === '"') {
      inBasic = true;
    } else if (character === "'") {
      inLiteral = true;
    } else if (character === "#") {
      const comment = line.slice(position + 1).trim();
      return comment.length === 0 ? {} : { comment: `# ${comment}` };
    }
  }

  return {};
}

/**
 * Removes leading and trailing blank lines while preserving blank lines that
 * separate multiple comments inside a block.
 */
function normalizeBlock(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim() === "") {
    end -= 1;
  }

  return lines.slice(start, end);
}

/**
 * Serializes one scalar. JSON escapes are valid TOML basic-string escapes for
 * the characters easy-host stores, and numbers keep their decimal form.
 */
function tomlValue(value: string | number): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

function tomlSyntaxError(error: unknown, file: string): ConfigValidationError {
  if (error instanceof TomlError) {
    // TomlError.message includes the source line, which could contain a value
    // from an inline [env] table. Keep only the reason, line, and column.
    const reason = error.message.split("\n", 1)[0] ?? "invalid TOML document";
    return new ConfigValidationError(reason, {
      file,
      line: error.line,
      column: error.column,
      cause: error,
    });
  }

  return new ConfigValidationError("could not be parsed as TOML", { file, cause: error });
}

function configErrorFromIssue(
  issue: z.core.$ZodIssue | undefined,
  input: unknown,
  file: string,
): ConfigValidationError {
  if (issue === undefined) {
    return new ConfigValidationError("is not a valid app configuration", { file });
  }

  if (issue.code === "unrecognized_keys") {
    const unknown = issue.keys[0] ?? "unknown";
    const extra = issue.keys.length > 1 ? `, ${issue.keys.slice(1).join(", ")}` : "";
    return new ConfigValidationError(
      `is not a recognized config key (allowed: ${APP_SPEC_KEYS.join(", ")}); unexpected: ${unknown}${extra}`,
      { file, setting: unknown },
    );
  }

  const pathParts = issue.path.map(String);
  const setting = pathParts.length > 0 ? pathParts.join(".") : undefined;
  const raw = valueAtPath(input, pathParts);
  const envValue = pathParts[0] === "env";
  const received = envValue || raw === undefined ? undefined : describeConfigValue(raw);

  if (issue.code === "invalid_type" && raw === undefined) {
    return new ConfigValidationError("is required", {
      file,
      ...(setting === undefined ? {} : { setting }),
    });
  }

  const reason = reasonForIssue(issue);

  return new ConfigValidationError(reason, {
    file,
    ...(setting === undefined ? {} : { setting }),
    ...(received === undefined ? {} : { received }),
  });
}

function reasonForIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type": {
      const expected = issue.expected === "int" ? "integer" : issue.expected;
      return `must be ${article(expected)}`;
    }
    case "too_small": {
      const suffix = issue.origin === "string" ? " characters" : "";
      return `must be at least ${String(issue.minimum)}${suffix}`;
    }
    case "too_big": {
      const suffix = issue.origin === "string" ? " characters" : "";
      return `must be at most ${String(issue.maximum)}${suffix}`;
    }
    case "invalid_value": {
      const allowed = issue.values.map((value) => String(value)).join(", ");
      return `must be one of ${allowed}`;
    }
    default:
      return issue.message;
  }
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function valueAtPath(input: unknown, path: readonly string[]): unknown {
  let current: unknown = input;

  for (const part of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
