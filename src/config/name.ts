/**
 * App naming contract (REG-FR-02, PRD-SP-05).
 *
 * App names become directory names under `apps/` and positional arguments of
 * every command, so they are sanitized and then validated against the single
 * documented allowlist `^[a-z0-9][a-z0-9-]{0,31}$` before any filesystem or
 * process mutation. Derivation accepts the repository forms `add` supports —
 * HTTPS/SSH/git/file URLs, scp-style SSH remotes, and local paths — and never
 * returns a value that has not passed the allowlist.
 *
 * This module performs no writes. Collision detection is a read-only pre-check;
 * `REG-1.4` adds the short-lived allocation lock that closes the remaining race
 * between the check and directory creation.
 */

import { lstatSync } from "node:fs";
import path from "node:path";
import { ConflictError, type ErrorDetails, redactText, UsageError } from "../cli/errors.js";
import { APP_NAME_PATTERN } from "../platform/paths.js";

export { APP_NAME_PATTERN };

/**
 * Longest app name accepted by the pattern (the first character plus 31 more).
 */
export const MAX_APP_NAME_LENGTH = 32;

/**
 * Remediation shared by every naming failure. It names the pattern so an
 * operator can correct the value without consulting the docs (PRD-ACC-05).
 */
export const APP_NAME_REMEDIATION =
  "Use 1-32 characters matching ^[a-z0-9][a-z0-9-]{0,31}$ (lowercase letters, digits, and hyphens).";

/**
 * A usage failure (exit code 1) raised when a derived or explicit app name
 * cannot satisfy the allowlist. The code is `INVALID_APP_NAME`, matching the
 * guard in `src/platform/paths.ts`, so both layers present the same stable
 * diagnostic key.
 */
export class AppNameError extends UsageError {
  /** The rejected value, redacted and safe to serialize. */
  readonly appName: string | undefined;

  constructor(
    summary: string,
    init: { code?: string; details?: ErrorDetails; remediation?: string; appName?: string } = {},
  ) {
    super(summary, {
      code: init.code ?? "INVALID_APP_NAME",
      ...(init.details === undefined ? {} : { details: init.details }),
      ...(init.remediation === undefined ? {} : { remediation: init.remediation }),
    });

    this.appName = init.appName;
  }
}

/**
 * A directory holder for the registry: either the `apps/` path itself or any
 * object exposing `appsDir` (notably `Paths`). Passing `Paths` avoids callers
 * re-deriving the directory.
 */
export type AppsDirectoryLocation = string | { readonly appsDir: string };

export interface AppNameAvailabilityOptions {
  /**
   * Existence probe, injectable for tests. Defaults to `lstatSync`, which also
   * detects a broken symlink occupying the name.
   */
  exists?: (target: string) => boolean;
}

/** Inputs for {@link resolveAppName}. */
export interface AppNameRequest {
  /** Repository URL or local path used when `name` is absent. */
  source?: string;
  /** Explicit `--name` override, validated against the same pattern. */
  name?: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is intentional input hardening.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** Any URL with a scheme, including `git+ssh://` and `file://`. */
const URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * scp-style remotes: `git@github.com:group/repo.git`. The path after the colon
 * may contain further colons on unusual hosts, so only the first separates.
 */
const SCP_STYLE_PATTERN = /^[^@\s/\\]+@[^:\s/\\]+:(.+)$/;

/**
 * A name made only of digits is readable as a port, a count, or an index in
 * operator commands, so derivation refuses to guess it. An explicit `--name`
 * is operator intent and is validated against the documented pattern only.
 */
const NUMERIC_NAME_PATTERN = /^[0-9]+$/;

/**
 * True when the value already satisfies the documented name allowlist.
 * Patternness is the whole public contract; ambiguity is a derivation rule.
 */
export function isValidAppName(value: string): boolean {
  return typeof value === "string" && APP_NAME_PATTERN.test(value);
}

/**
 * True for a purely numeric name, which derivation treats as ambiguous.
 */
export function isAmbiguousAppName(value: string): boolean {
  return NUMERIC_NAME_PATTERN.test(value);
}

/**
 * Applies the sanitization pipeline from REG-FR-02:
 *
 * 1. lowercase,
 * 2. collapse each run of characters outside `a-z0-9` to one hyphen,
 * 3. trim hyphens from both ends,
 * 4. truncate to {@link MAX_APP_NAME_LENGTH},
 * 5. trim a hyphen left at the truncation boundary.
 *
 * The result is either empty or guaranteed to match
 * {@link APP_NAME_PATTERN}; the caller decides whether empty is an error.
 */
export function sanitizeAppName(value: string): string {
  if (typeof value !== "string") {
    return "";
  }

  const collapsed = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const trimmed = collapsed.replace(/^-+|-+$/g, "");
  return trimmed.slice(0, MAX_APP_NAME_LENGTH).replace(/-+$/, "");
}

/**
 * Extracts the raw basename from a repository URL, scp-style remote, or local
 * path. A trailing `.git` suffix is removed. No sanitization happens here, and
 * no filesystem access is performed.
 *
 * Returns an empty string for a source with no repository segment, such as a
 * bare host URL (`https://github.com/`) or a filesystem root.
 */
export function repositoryBasename(source: string): string {
  if (typeof source !== "string") {
    return "";
  }

  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return "";
  }

  if (URL_PATTERN.test(trimmed)) {
    return basenameFromUrl(trimmed);
  }

  const scpStyle = SCP_STYLE_PATTERN.exec(trimmed);
  if (scpStyle?.[1] !== undefined) {
    return stripGitSuffix(lastPathSegment(scpStyle[1]));
  }

  return stripGitSuffix(lastPathSegment(trimmed));
}

/**
 * Derives a safe app name from a repository URL, scp-style remote, or local
 * path. Throws {@link AppNameError} (exit code 1) when the source has no usable
 * basename or when the result is a purely numeric, ambiguous name.
 */
export function deriveAppName(source: string): string {
  const rawBasename = repositoryBasename(source);
  const name = sanitizeAppName(rawBasename);
  const safeSource = safeValue(source);

  if (name.length === 0) {
    throw new AppNameError(
      `cannot derive an app name from ${describeSafe(safeSource)}: the repository name is empty`,
      {
        details: { reason: "empty-name", source: safeSource },
        remediation: `Choose a name explicitly with --name. ${APP_NAME_REMEDIATION}`,
      },
    );
  }

  if (isAmbiguousAppName(name)) {
    throw new AppNameError(
      `cannot derive an app name from ${describeSafe(safeSource)}: "${name}" is ambiguous with a numeric value`,
      {
        code: "AMBIGUOUS_APP_NAME",
        details: { name, reason: "ambiguous-name", source: safeSource },
        remediation: `Choose a non-numeric name explicitly with --name. ${APP_NAME_REMEDIATION}`,
      },
    );
  }

  return validateAppName(name);
}

/**
 * Validates an explicit app name against the documented pattern. Returns the
 * name unchanged on success; throws {@link AppNameError} on a mismatch so
 * `--name` and derived names share one contract.
 */
export function validateAppName(value: string): string {
  const safe = safeValue(value);
  const reason = invalidNameReason(value);

  if (reason !== undefined) {
    throw new AppNameError(`invalid app name ${describeSafe(safe)}: ${reason}`, {
      details: { name: safe, reason: "invalid-name" },
      remediation: APP_NAME_REMEDIATION,
      appName: safe,
    });
  }

  return value;
}

/**
 * Resolves the name for a new app: an explicit override is validated against
 * the pattern, otherwise the source is sanitized and validated.
 *
 * Accepts either `(source, override)` or an {@link AppNameRequest} object.
 */
export function resolveAppName(source: string | undefined, override?: string): string;
export function resolveAppName(request: AppNameRequest): string;
export function resolveAppName(
  input: string | AppNameRequest | undefined,
  override?: string,
): string {
  if (typeof input === "object" && input !== null) {
    return resolveFrom(input.source, input.name);
  }

  return resolveFrom(input, override);
}

/**
 * True when `apps/<name>` already exists. The name is validated first, so the
 * check can never be used to probe outside `apps/` (PRD-SP-05). Any directory,
 * file, or broken symlink occupying the name counts as existing.
 */
export function appNameExists(
  name: string,
  location: AppsDirectoryLocation,
  options: AppNameAvailabilityOptions = {},
): boolean {
  const validated = validateAppName(name);
  const exists = options.exists ?? pathEntryExists;
  return exists(path.join(appsDirectoryOf(location), validated));
}

/**
 * Rejects a name whose app directory already exists with a conflict error
 * (exit code 6). An existing app is never overwritten; callers must choose
 * another name or operate on the existing app.
 *
 * The check is deliberately non-destructive: it only probes for an entry and
 * returns the validated name for the caller to use.
 */
export function assertAppNameAvailable(
  name: string,
  location: AppsDirectoryLocation,
  options: AppNameAvailabilityOptions = {},
): string {
  const validated = validateAppName(name);
  const appsDir = appsDirectoryOf(location);
  const directory = path.join(appsDir, validated);

  if ((options.exists ?? pathEntryExists)(directory)) {
    throw new ConflictError(`app "${validated}" already exists`, {
      code: "APP_NAME_CONFLICT",
      details: { name: validated, directory },
      remediation: `Choose another name with --name, or inspect the existing app with "easy-host status ${validated}".`,
    });
  }

  return validated;
}

function resolveFrom(source: string | undefined, override: string | undefined): string {
  if (override !== undefined) {
    return validateAppName(override);
  }

  if (source === undefined || source.trim().length === 0) {
    throw new AppNameError("an app name is required: no repository or local path was supplied", {
      details: { reason: "missing-source" },
      remediation: `Pass a repository or local path, or choose a name with --name. ${APP_NAME_REMEDIATION}`,
    });
  }

  return deriveAppName(source);
}

function basenameFromUrl(source: string): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    // A scheme-looking string that is not a valid URL has no trustworthy
    // basename, so derivation fails rather than guessing from raw text.
    return "";
  }

  if (url.hostname.length === 0 && url.protocol !== "file:") {
    return "";
  }

  return stripGitSuffix(lastPathSegment(decodePath(url.pathname)));
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function lastPathSegment(value: string): string {
  const segments = value.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? "";
}

function stripGitSuffix(basename: string): string {
  return basename.toLowerCase().endsWith(".git") ? basename.slice(0, -4) : basename;
}

function appsDirectoryOf(location: AppsDirectoryLocation): string {
  const directory = typeof location === "string" ? location : location.appsDir;

  if (directory.trim().length === 0) {
    throw new UsageError("the apps directory must not be empty", {
      code: "INVALID_APPS_DIRECTORY",
      remediation: "Resolve the state root with src/platform/paths.ts before naming an app.",
    });
  }

  return directory;
}

function pathEntryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return false;
    }

    throw error;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function invalidNameReason(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return "must be a string";
  }

  if (value.length === 0) {
    return "must not be empty";
  }

  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return "must not contain control characters";
  }

  if (/\s/.test(value)) {
    return "must not contain whitespace";
  }

  if (/[^a-z0-9-]/.test(value)) {
    return "must contain only lowercase letters, digits, and hyphens";
  }

  if (value.startsWith("-")) {
    return "must not start with a hyphen";
  }

  if (value.length > MAX_APP_NAME_LENGTH) {
    return `must be ${MAX_APP_NAME_LENGTH} characters or fewer`;
  }

  if (!APP_NAME_PATTERN.test(value)) {
    return `must match ${APP_NAME_PATTERN.source}`;
  }

  return undefined;
}

/**
 * Removes URL credentials and control characters from anything that may be
 * echoed. PRD-SP-02 and PRD-NF-10 apply to naming errors too, because a
 * mistyped repository URL is exactly where a token can appear.
 */
function safeValue(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const redacted = redactText(value);
  const printable = redacted.replace(CONTROL_CHARACTER_PATTERN, "?");
  return printable.length > 80 ? `${printable.slice(0, 77)}...` : printable;
}

function describeSafe(value: string): string {
  return JSON.stringify(value);
}
