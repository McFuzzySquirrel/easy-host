import { accessSync, constants, mkdirSync, type Stats, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";

/**
 * Directory name appended to `XDG_DATA_HOME` and to the home fallback.
 */
export const STATE_ROOT_DIRECTORY_NAME = "easy-host";

/**
 * Every directory this module creates is private to the current user.
 */
export const STATE_ROOT_MODE = 0o700;

/**
 * Exit code class for prerequisite or environment failures (PRD PRE-FR-05).
 */
export const PREREQUISITE_EXIT_CODE = 2;

/**
 * Exit code class for usage or validation failures (PRD PRE-FR-05).
 */
export const USAGE_EXIT_CODE = 1;

/**
 * App names are used as directory names, so they must never contain path
 * separators, dots, or shell-significant characters (PRD-SP-05, REG-FR-02).
 */
export const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface PathsOptions {
  /** Environment used for `EASY_HOST_HOME`, `XDG_DATA_HOME`, and `HOME`. */
  env?: NodeJS.ProcessEnv;
  /** Overrides the home directory used for tilde expansion and the fallback. */
  homeDir?: string;
  /** Base directory used to resolve a relative root. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Writability probe for the nearest existing ancestor of the root.
   * Injectable so tests can simulate a host that denies writes without
   * relying on `chmod` or a root-owned filesystem.
   */
  isWritable?: (directory: string) => boolean;
}

/**
 * A prerequisite failure (exit code 2) raised when the state root cannot be
 * created or written. The message names the failed check and the reason; the
 * remediation is rendered on its own line by the CLI error renderer
 * (PRD-NF-02). `exitCode` is part of the top-level error mapping contract.
 */
export class StateRootError extends Error {
  readonly exitCode = PREREQUISITE_EXIT_CODE;
  readonly code = "STATE_ROOT_NOT_WRITABLE";
  readonly remediation: string;

  constructor(root: string, reason: string, remediation: string) {
    super(`state root "${root}" is not writable: ${reason}`);
    this.name = "StateRootError";
    this.remediation = remediation;
  }
}

/**
 * A usage failure (exit code 1) raised when an app name could escape the
 * `apps/` directory. App names are validated upstream as well; this check is
 * the last line of defence before the name becomes a filesystem path.
 */
export class InvalidAppNameError extends Error {
  readonly exitCode = USAGE_EXIT_CODE;
  readonly code = "INVALID_APP_NAME";
  readonly remediation =
    "Use a name matching ^[a-z0-9][a-z0-9-]{0,31}$ (lowercase letters, digits, hyphens).";

  constructor(name: string) {
    super(`invalid app name ${JSON.stringify(name)}: expected ^[a-z0-9][a-z0-9-]{0,31}$`);
    this.name = "InvalidAppNameError";
  }
}

/**
 * Resolves the state root:
 *
 * 1. `EASY_HOST_HOME`
 * 2. `XDG_DATA_HOME/easy-host`
 * 3. `~/.local/share/easy-host`
 *
 * A leading `~` or `~/` is expanded from the resolved home directory. An empty
 * variable is treated as unset so that `EASY_HOST_HOME=` does not produce an
 * empty path.
 */
export function resolveStateRoot(options: PathsOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = resolveHomeDir(options, env);
  const cwd = options.cwd ?? process.cwd();

  const override = readEnvironmentPath(env, "EASY_HOST_HOME");
  if (override !== undefined) {
    return absolutePath(expandHome(override, homeDir), cwd);
  }

  const xdgDataHome = readEnvironmentPath(env, "XDG_DATA_HOME");
  if (xdgDataHome !== undefined) {
    return path.join(
      absolutePath(expandHome(xdgDataHome, homeDir), cwd),
      STATE_ROOT_DIRECTORY_NAME,
    );
  }

  return path.join(homeDir, ".local", "share", STATE_ROOT_DIRECTORY_NAME);
}

/**
 * Resolved, typed accessors for the state-root layout. Construction performs
 * no filesystem I/O; call {@link Paths.ensureLayout} before reading or writing
 * app data.
 */
export class Paths {
  /** Absolute state root. */
  readonly root: string;
  /** `<root>/apps` — the authoritative app registry (REG-FR-03). */
  readonly appsDir: string;
  /** `<root>/tools` — downloaded pinned tools such as Railpack. */
  readonly toolsDir: string;
  /** `<root>/buildkit` — BuildKit state and configuration. */
  readonly buildkitDir: string;

  readonly #isWritable: (directory: string) => boolean;

  constructor(options: PathsOptions = {}) {
    this.root = resolveStateRoot(options);
    this.appsDir = path.join(this.root, "apps");
    this.toolsDir = path.join(this.root, "tools");
    this.buildkitDir = path.join(this.root, "buildkit");
    this.#isWritable = options.isWritable ?? isDirectoryWritable;
  }

  /**
   * Returns the directory for one app, rejecting names that could escape
   * `apps/`.
   */
  appDir(name: string): string {
    if (!APP_NAME_PATTERN.test(name)) {
      throw new InvalidAppNameError(name);
    }

    return path.join(this.appsDir, name);
  }

  /**
   * Creates `<root>`, `apps/`, `tools/`, and `buildkit/` with mode `0700`.
   * Refuses to run when the nearest existing ancestor of the root is not a
   * writable directory, raising {@link StateRootError} (exit code 2) instead of
   * letting a raw `EACCES` escape. Existing directories are never chmodded and
   * nothing outside the resolved root is created (PRD-SP-06).
   */
  ensureLayout(): this {
    const existing = nearestExistingAncestor(this.root);
    if (existing === undefined) {
      throw new StateRootError(
        this.root,
        "no existing parent directory was found",
        stateRootRemediation(this.root),
      );
    }

    const existingStat = statIfPresent(existing);
    if (existingStat === undefined || !existingStat.isDirectory()) {
      throw new StateRootError(
        this.root,
        `"${existing}" exists and is not a directory`,
        stateRootRemediation(existing),
      );
    }

    if (!this.#isWritable(existing)) {
      throw new StateRootError(
        this.root,
        `"${existing}" is not writable by ${currentUser()}`,
        stateRootRemediation(existing),
      );
    }

    for (const directory of [this.root, this.appsDir, this.toolsDir, this.buildkitDir]) {
      this.createDirectory(directory, existing);
    }

    return this;
  }

  private createDirectory(directory: string, writableAncestor: string): void {
    try {
      mkdirSync(directory, { mode: STATE_ROOT_MODE, recursive: true });
    } catch (error) {
      if (!isLayoutError(error)) {
        throw error;
      }

      throw new StateRootError(
        this.root,
        `could not create "${directory}": ${errorMessage(error)}`,
        stateRootRemediation(writableAncestor),
      );
    }
  }
}

/**
 * Convenience factory for {@link Paths}.
 */
export function createPaths(options: PathsOptions = {}): Paths {
  return new Paths(options);
}

function resolveHomeDir(options: PathsOptions, env: NodeJS.ProcessEnv): string {
  if (options.homeDir !== undefined && options.homeDir.length > 0) {
    return options.homeDir;
  }

  return readEnvironmentPath(env, "HOME") ?? homedir();
}

function readEnvironmentPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return value;
}

function expandHome(input: string, homeDir: string): string {
  if (input === "~") {
    return homeDir;
  }

  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }

  return input;
}

function absolutePath(input: string, cwd: string): string {
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(cwd, input);
}

function isDirectoryWritable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function statIfPresent(target: string): Stats | undefined {
  try {
    return statSync(target);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return undefined;
    }

    throw error;
  }
}

function nearestExistingAncestor(target: string): string | undefined {
  let current = target;

  for (;;) {
    if (statIfPresent(current) !== undefined) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isLayoutError(error: unknown): boolean {
  return (
    isErrnoCode(error, "EACCES") ||
    isErrnoCode(error, "EPERM") ||
    isErrnoCode(error, "EROFS") ||
    isErrnoCode(error, "EEXIST") ||
    isErrnoCode(error, "ENOTDIR") ||
    isErrnoCode(error, "ENOSPC")
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "the current user";
  }
}

function stateRootRemediation(directory: string): string {
  return `Set EASY_HOST_HOME to a writable directory (for example $HOME/.local/share/easy-host) or grant write permission on "${directory}".`;
}
