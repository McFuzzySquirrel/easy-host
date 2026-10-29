/**
 * Strict, typed configuration contract for an easy-host app (REG-FR-01).
 *
 * The schema is the single source of truth for `config.toml`: every documented
 * key, its default, and its allowlist lives here. Validation is pure — it never
 * reads, writes, or spawns anything — so callers can satisfy `PRD-NF-03` by
 * validating the whole spec before any filesystem or process mutation.
 *
 * Errors are `UsageError`s (exit code 1) and name the offending key and the
 * received value. Values under `[env]` are never echoed, matching `PRD-NF-10`.
 */

import path from "node:path";
import { z } from "zod";
import { redactText, UsageError } from "../cli/errors.js";

/**
 * Every key accepted at the top level of `config.toml`. Keeping this list
 * explicit lets the parser reject unknown keys with a stable, helpful message
 * instead of silently accepting a typo (`PRD-SP-05`).
 */
export const APP_SPEC_KEYS = [
  "repo",
  "local_path",
  "ref",
  "port",
  "container_port",
  "bind",
  "probe",
  "health_path",
  "health_interval_ms",
  "health_timeout_ms",
  "health_startup_ms",
  "env_file",
  "volumes",
  "env",
] as const;

/**
 * Documented defaults from PRD section 7.3. Tests assert each one individually
 * so a change to a default is a deliberate contract change.
 */
export const APP_SPEC_DEFAULTS = {
  ref: "main",
  container_port: 3000,
  bind: "0.0.0.0",
  probe: "http",
  health_path: "/",
  health_interval_ms: 2000,
  health_timeout_ms: 5000,
  health_startup_ms: 90000,
} as const;

/** Host ports are unprivileged only (REG-FR-01, PRD-SP-05). */
export const MIN_HOST_PORT = 1024;
export const MAX_PORT = 65535;

/** Bind addresses an operator may publish on (REG-FR-01 open question 1). */
export const BIND_ADDRESSES = ["0.0.0.0", "127.0.0.1", "::"] as const;

/** Probe kinds understood by the health subsystem. */
export const PROBE_KINDS = ["http", "tcp"] as const;

/**
 * Named-volume names become Podman volume names and are validated against an
 * allowlist before use in any command (`PRD-SP-05`).
 */
export const VOLUME_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Environment variable names accepted in the inline `[env]` table. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REPO_SCHEME_PATTERN = /^(?:https?|ssh|git\+ssh|git|file):\/\/\S+$/i;
const SCP_STYLE_REPO_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+$/;

/**
 * Initializer for {@link ConfigValidationError}. `received` is already
 * formatted for humans; callers must not pass a raw `[env]` value.
 */
export interface ConfigErrorInit {
  /** File name shown in the summary. Defaults to `config.toml`. */
  file?: string;
  /** Dotted key path, for example `port` or `volumes.data`. */
  setting?: string;
  /** Safe, formatted representation of the offending value. */
  received?: string;
  /** 1-based source line for a TOML syntax error. */
  line?: number;
  /** 1-based source column for a TOML syntax error. */
  column?: number;
  /** Original exception, kept for `EASY_HOST_DEBUG=1` diagnostics. */
  cause?: unknown;
}

/**
 * A usage failure raised while validating an app spec. The summary names the
 * key and the received value; the structured details carry the same
 * information for `--json` output. Secret-looking values are redacted before
 * they reach the message.
 */
export class ConfigValidationError extends UsageError {
  readonly setting: string | undefined;

  constructor(reason: string, init: ConfigErrorInit = {}) {
    const file = init.file ?? "config.toml";
    const setting = init.setting;
    const received = init.received;
    const location = setting === undefined ? "" : ` "${setting}"`;
    const value = received === undefined ? "" : ` (received ${received})`;
    const details: Record<string, string | number> = { file, reason };

    if (setting !== undefined) {
      details.setting = setting;
    }
    if (received !== undefined) {
      details.received = received;
    }
    if (init.line !== undefined) {
      details.line = init.line;
    }
    if (init.column !== undefined) {
      details.column = init.column;
    }

    super(`invalid ${file}:${location} ${reason}${value}`, {
      code: "INVALID_CONFIG",
      details,
      remediation: `Edit ${file} and retry.`,
      ...(init.cause === undefined ? {} : { cause: init.cause }),
    });

    this.setting = setting;
  }
}

/**
 * Formats a value for an error message without leaking secrets. Strings are
 * quoted, containers are JSON-encoded, and over-long output is truncated.
 * Callers must skip this for `[env]` values.
 */
export function describeConfigValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  let rendered: string;
  if (typeof value === "string") {
    rendered = JSON.stringify(value);
  } else if (typeof value === "number" || typeof value === "boolean") {
    rendered = String(value);
  } else if (value === null) {
    rendered = "null";
  } else {
    rendered = JSON.stringify(value) ?? String(value);
  }

  const trimmed = rendered.length > 80 ? `${rendered.slice(0, 77)}...` : rendered;
  return redactText(trimmed);
}

/**
 * Control characters have no legitimate place in a path, ref, URL, or header
 * and are rejected before any value reaches a process argument or a log line.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is intentional input hardening.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Git refs are passed to `git checkout`, so option-looking values, path
 * traversal, and characters git itself rejects are refused here.
 */
export function isValidRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) {
    return false;
  }
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".")) {
    return false;
  }
  if (ref.includes("..") || ref.includes("//") || ref.includes("\\") || ref.includes("@{")) {
    return false;
  }
  if (/[\s~^:?*[\]\\]/.test(ref) || CONTROL_CHARACTER_PATTERN.test(ref)) {
    return false;
  }
  if (ref.endsWith(".lock")) {
    return false;
  }
  return /^[A-Za-z0-9._/-]+$/.test(ref);
}

function isValidRepo(repo: string): boolean {
  if (repo.length === 0 || repo.length > 2048) {
    return false;
  }
  if (/\s/.test(repo) || CONTROL_CHARACTER_PATTERN.test(repo)) {
    return false;
  }
  return REPO_SCHEME_PATTERN.test(repo) || SCP_STYLE_REPO_PATTERN.test(repo);
}

/**
 * Lexical traversal defence shared by `local_path`, `env_file`, and volume
 * mount paths. Absolute paths are rejected because both config paths are
 * defined relative to the app directory; `..` segments are rejected even if
 * they would normalise back inside it, so a config cannot be used to probe
 * outside `apps/<name>/` (`PRD-SP-05`).
 */
function isContainedRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) {
    return false;
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }

  const segments = value.split(/[\\/]+/);
  return segments.every((segment) => segment !== "..");
}

function isAbsoluteContainerPath(value: string): boolean {
  if (!path.posix.isAbsolute(value) || value.length > 4096) {
    return false;
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  if (value === "/") {
    return false;
  }
  return value.split("/").every((segment) => segment !== "..");
}

function isHealthPath(value: string): boolean {
  if (!value.startsWith("/") || value.length > 2048) {
    return false;
  }
  if (/[\s\\]/.test(value) || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "..");
}

const refSchema = z.string().refine(isValidRef, {
  message: "must be a valid git ref without spaces, '..', or a leading '-'",
});

const repoPathSchema = z
  .string()
  .refine(isValidRepo, {
    message: "must be an https, ssh, git, git+ssh, or file URL, or an scp-style user@host:path",
  })
  .refine((value) => !hasUrlCredentials(value), {
    // Credentials belong in the operator's git configuration, never in a
    // config file that ends up in diagnostics.
    message: "must not embed a username or password; use your git credential helper",
  });

const localPathSchema = z.string().refine(isContainedRelativePath, {
  message: "must be a relative path inside the app directory without '..' segments",
});

const envFilePathSchema = z.string().refine(isContainedRelativePath, {
  message: "must be a relative path inside the app directory without '..' segments",
});

const portSchema = z
  .number()
  .int("must be a whole number")
  .min(MIN_HOST_PORT, `must be at least ${MIN_HOST_PORT}`)
  .max(MAX_PORT, `must be at most ${MAX_PORT}`);

const containerPortSchema = z
  .number()
  .int("must be a whole number")
  .min(MIN_HOST_PORT, `must be at least ${MIN_HOST_PORT}`)
  .max(MAX_PORT, `must be at most ${MAX_PORT}`);

const healthPathSchema = z.string().refine(isHealthPath, {
  message: "must be an absolute HTTP path starting with '/' and containing no spaces or '..'",
});

const positiveTimingSchema = z
  .number()
  .int("must be a whole number of milliseconds")
  .min(1, "must be at least 1")
  .max(86_400_000, "must be at most 86400000");

const containerPathSchema = z.string().refine(isAbsoluteContainerPath, {
  message: "must be an absolute container path other than '/' without '..' segments",
});

const volumeMapSchema = z.record(z.string(), containerPathSchema).superRefine((entries, ctx) => {
  for (const name of Object.keys(entries)) {
    if (!VOLUME_NAME_PATTERN.test(name)) {
      ctx.addIssue({
        code: "custom",
        message: `is not a valid volume name; it must match ${VOLUME_NAME_PATTERN.source}`,
        path: [name],
      });
    }
  }
});

const envMapSchema = z.record(z.string(), z.string()).superRefine((entries, ctx) => {
  for (const name of Object.keys(entries)) {
    if (!ENV_NAME_PATTERN.test(name)) {
      ctx.addIssue({
        code: "custom",
        message: `is not a valid environment variable name; it must match ${ENV_NAME_PATTERN.source}`,
        path: [name],
      });
    }
  }
});

/**
 * The AppSpec schema. `strictObject` is what rejects unknown keys; defaults
 * are applied here so every caller sees the same fully-populated spec.
 */
export const appSpecSchema = z
  .strictObject({
    repo: repoPathSchema.optional(),
    local_path: localPathSchema.optional(),
    ref: refSchema.default(APP_SPEC_DEFAULTS.ref),
    port: portSchema,
    container_port: containerPortSchema.default(APP_SPEC_DEFAULTS.container_port),
    bind: z.enum(BIND_ADDRESSES).default(APP_SPEC_DEFAULTS.bind),
    probe: z.enum(PROBE_KINDS).default(APP_SPEC_DEFAULTS.probe),
    health_path: healthPathSchema.default(APP_SPEC_DEFAULTS.health_path),
    health_interval_ms: positiveTimingSchema.default(APP_SPEC_DEFAULTS.health_interval_ms),
    health_timeout_ms: positiveTimingSchema.default(APP_SPEC_DEFAULTS.health_timeout_ms),
    health_startup_ms: positiveTimingSchema.default(APP_SPEC_DEFAULTS.health_startup_ms),
    env_file: envFilePathSchema.optional(),
    volumes: volumeMapSchema.default(() => ({})),
    env: envMapSchema.default(() => ({})),
  })
  .superRefine((spec, ctx) => {
    const hasRepo = spec.repo !== undefined;
    const hasLocalPath = spec.local_path !== undefined;

    if (hasRepo && hasLocalPath) {
      ctx.addIssue({
        code: "custom",
        message: 'conflicts with "local_path"; exactly one of "repo" or "local_path" is required',
        path: ["repo"],
      });
      return;
    }

    if (!hasRepo && !hasLocalPath) {
      ctx.addIssue({
        code: "custom",
        message: 'is required: exactly one of "repo" or "local_path" must be set',
        path: ["repo"],
      });
    }
  });

/** Fully-populated, validated app configuration. */
export type AppSpec = z.infer<typeof appSpecSchema>;

/** Input shape before defaults are applied, useful to callers building a spec. */
export type AppSpecInput = z.input<typeof appSpecSchema>;

function hasUrlCredentials(value: string): boolean {
  const scheme = value.indexOf("://");
  if (scheme < 0) {
    return false;
  }

  const authorityStart = scheme + 3;
  const pathStart = value.indexOf("/", authorityStart);
  const authority = value.slice(authorityStart, pathStart < 0 ? undefined : pathStart);
  const at = authority.lastIndexOf("@");
  if (at < 0) {
    return false;
  }

  const userInfo = authority.slice(0, at);
  const schemeName = value.slice(0, scheme).toLowerCase();

  // `ssh://git@host` and `git+ssh://git@host` name the SSH account, not a
  // secret. A password (or any userinfo on an HTTP scheme) is a credential
  // and is refused by PRD-SP-02.
  if (schemeName === "ssh" || schemeName === "git+ssh") {
    return userInfo.includes(":");
  }

  return true;
}
