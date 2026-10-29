/**
 * On-disk app registry (REG-FR-03) and crash-safe file writes (REG-FR-04).
 *
 * `apps/<name>/` is the authoritative list of apps: every operation starts from
 * a directory scan, never from a cache. An app directory whose `config.toml`
 * is missing or invalid is returned as a `broken` entry carrying the parse
 * error, so `list` can report it instead of hiding it (feature open question
 * 4). Only real directories are apps; symlinked entries are reported as broken
 * because following them could leave the state root (PRD-SP-05).
 *
 * Every write goes through {@link writeFileAtomic}: a temporary file in the
 * same directory, fsync, then rename over the target. A crash therefore leaves
 * either the previous complete file or the new complete file, never a partial
 * one (REG-NF-02). `config.toml` is written with mode `0644` and `secrets.env`
 * with `0600` (PRD-SP-01); directories are `0700`.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  type Dirent,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  ConflictError,
  type EasyHostError,
  NotFoundError,
  PrerequisiteError,
  toEasyHostError,
  UsageError,
} from "../cli/errors.js";
import { validateAppName } from "../config/name.js";
import {
  CONFIG_FILE_NAME,
  parseConfigToml,
  serializeConfig,
  validateAppSpec,
} from "../config/parse.js";
import type { AppSpec } from "../config/schema.js";

export { CONFIG_FILE_NAME };

/** Optional secret environment file inside an app directory. */
export const SECRETS_FILE_NAME = "secrets.env";

/** Rebuildable per-app cache (see `src/registry/state.ts`). */
export const STATE_FILE_NAME = "state.json";

/** Checked-out repository or local workspace. */
export const WORKSPACE_DIRECTORY_NAME = "workspace";

/** Documented mode for `config.toml` (REG-FR-04). */
export const CONFIG_FILE_MODE = 0o644;

/** Documented mode for `secrets.env` (REG-FR-04, PRD-SP-01). */
export const SECRETS_FILE_MODE = 0o600;

/** The cache holds no secrets, so it shares the config file's readable mode. */
export const STATE_FILE_MODE = 0o644;

/** App and workspace directories are private to the operator (PRD-SP-01). */
export const APP_DIRECTORY_MODE = 0o700;

const TEMPORARY_FILE_PREFIX = ".";
const TEMPORARY_FILE_SUFFIX = ".tmp";

/**
 * Fault-injection seam called after the temporary file is complete and fsynced
 * but before the rename. Throwing aborts the replace and leaves the previous
 * file untouched, which is how tests and crash simulations prove REG-NF-02.
 * Production callers never set it.
 */
export type BeforeRenameHook = (temporaryPath: string, targetPath: string) => void;

export interface AtomicWriteOptions {
  /** Mode applied to the replacement file. Defaults to `0644`. */
  mode?: number;
  /** Test and crash-simulation seam; omit in production. */
  beforeRename?: BeforeRenameHook;
}

/**
 * Replaces `targetPath` atomically.
 *
 * The temporary file lives in the same directory so `rename` stays on one
 * filesystem, which is what makes the replacement atomic. The file is
 * fsynced before the rename and the containing directory is fsynced after it
 * (best effort) so a crash cannot expose a truncated document.
 */
export function writeFileAtomic(
  targetPath: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  const directory = path.dirname(targetPath);
  const mode = options.mode ?? CONFIG_FILE_MODE;
  const temporaryPath = path.join(
    directory,
    `${TEMPORARY_FILE_PREFIX}${path.basename(targetPath)}.${process.pid}.${randomUUID()}${TEMPORARY_FILE_SUFFIX}`,
  );

  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    writeAll(descriptor, contents);
    // `open` applies the umask, so set the documented mode explicitly.
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    options.beforeRename?.(temporaryPath, targetPath);

    renameSync(temporaryPath, targetPath);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original failure is the one worth reporting.
      }
    }

    removeIfPresent(temporaryPath);
    throw error;
  }
}

/** A directory holding an `apps/` tree: either the path or a `Paths` object. */
export type AppsDirectoryLocation = string | { readonly appsDir: string };

export interface RegistryOptions {
  /**
   * Applied to every write this registry performs. Intended for unit tests and
   * fault injection; production code leaves it unset.
   */
  beforeRename?: BeforeRenameHook;
}

/** The fixed layout of one app directory (REG-FR-03). */
export interface AppRecord {
  name: string;
  directory: string;
  configPath: string;
  secretsPath: string;
  statePath: string;
  workspacePath: string;
}

/** A directory with a valid `config.toml`. */
export interface OkAppEntry {
  status: "ok";
  name: string;
  directory: string;
  configPath: string;
  spec: AppSpec;
}

/**
 * A directory that exists but cannot be used. `error` is the typed parse or
 * read failure, rendered by the shared error printer without being hidden.
 */
export interface BrokenAppEntry {
  status: "broken";
  name: string;
  directory: string;
  configPath: string;
  error: EasyHostError;
}

export type AppListEntry = OkAppEntry | BrokenAppEntry;

export interface ConfigWriteOptions {
  /** Original TOML text, so hand-written comments survive the rewrite. */
  source?: string;
  /** Test and crash-simulation seam; omit in production. */
  beforeRename?: BeforeRenameHook;
}

export interface SecretsWriteOptions {
  /** Test and crash-simulation seam; omit in production. */
  beforeRename?: BeforeRenameHook;
}

export interface RemoveOptions {
  /**
   * `remove` deletes a directory, so the caller must confirm explicitly
   * (REG-FR-03, RBK-FR-03). Anything other than `true` is a usage error.
   */
  confirmed: boolean;
}

/**
 * Filesystem-backed registry rooted at `apps/`.
 *
 * Construction performs no I/O. `create` is the only method that creates the
 * `apps/` directory, and every mutation is confined to one app directory.
 */
export class Registry {
  /** Absolute `<root>/apps` path. */
  readonly appsDir: string;
  readonly #beforeRename: BeforeRenameHook | undefined;

  constructor(location: AppsDirectoryLocation, options: RegistryOptions = {}) {
    this.appsDir = appsDirectoryOf(location);
    this.#beforeRename = options.beforeRename;
  }

  /** True when `<apps>/<name>` is a real directory. */
  exists(name: string): boolean {
    const validated = validateAppName(name);
    const stats = lstatIfPresent(path.join(this.appsDir, validated));
    return stats?.isDirectory() === true;
  }

  /**
   * Resolves the fixed paths for an existing app. Throws a typed not-found
   * error (exit code 5) when the directory is missing or is not a real
   * directory, which also refuses a symlink that could escape `apps/`.
   */
  record(name: string): AppRecord {
    const validated = validateAppName(name);
    const directory = path.join(this.appsDir, validated);
    const stats = lstatIfPresent(directory);

    if (stats === undefined) {
      throw new NotFoundError(`app "${validated}" was not found`, {
        code: "APP_NOT_FOUND",
        details: { app: validated, directory },
        remediation: `Run "easy-host list" to see existing apps, or "easy-host add <repo>" to create this one.`,
      });
    }

    if (!stats.isDirectory()) {
      throw new NotFoundError(`app "${validated}" is not a directory`, {
        code: "APP_NOT_A_DIRECTORY",
        details: { app: validated, directory },
        remediation: `Move "${directory}" out of the apps directory and retry.`,
      });
    }

    return recordFor(validated, directory);
  }

  /**
   * Scans `apps/` and reads every config. Results are sorted by name so output
   * is stable. A directory with a broken config is returned with its error;
   * the scan never stops early because of one broken app.
   */
  list(): AppListEntry[] {
    const entries = readAppsDirectory(this.appsDir);
    const result: AppListEntry[] = [];

    for (const entry of entries) {
      const directory = path.join(this.appsDir, entry.name);
      const configPath = path.join(directory, CONFIG_FILE_NAME);

      if (!entry.isDirectory()) {
        // A symlinked app candidate is reported rather than followed or hidden.
        if (entry.isSymbolicLink()) {
          result.push({
            status: "broken",
            name: entry.name,
            directory,
            configPath,
            error: toEasyHostError(
              new UsageError(`"${entry.name}" is a symlink, not an app directory`, {
                code: "APP_NOT_A_DIRECTORY",
                details: { app: entry.name, directory },
                remediation: `Replace "${directory}" with a real directory, or remove it.`,
              }),
            ),
          });
        }
        continue;
      }

      try {
        validateAppName(entry.name);
      } catch (error) {
        result.push({
          status: "broken",
          name: entry.name,
          directory,
          configPath,
          error: toEasyHostError(error),
        });
        continue;
      }

      try {
        const spec = this.readConfig(entry.name);
        result.push({ status: "ok", name: entry.name, directory, configPath, spec });
      } catch (error) {
        result.push({
          status: "broken",
          name: entry.name,
          directory,
          configPath,
          error: toEasyHostError(error),
        });
      }
    }

    return result.sort(compareEntries);
  }

  /** Reads and validates `<apps>/<name>/config.toml` into an `AppSpec`. */
  readConfig(name: string): AppSpec {
    const record = this.record(name);

    let source: string;
    try {
      source = readFileSync(record.configPath, "utf8");
    } catch (error) {
      throw configReadError(record, error);
    }

    return parseConfigToml(source, { file: record.configPath });
  }

  /**
   * Validates and atomically writes `<apps>/<name>/config.toml`. Validation
   * runs before any mutation (PRD-NF-03); the previous file survives a failed
   * write (REG-NF-02).
   */
  writeConfig(name: string, spec: AppSpec, options: ConfigWriteOptions = {}): AppRecord {
    const record = this.record(name);
    validateAppSpec(spec, { file: record.configPath });

    const contents = serializeConfig(
      spec,
      options.source === undefined ? {} : { source: options.source },
    );
    writeFileAtomic(record.configPath, contents, {
      mode: CONFIG_FILE_MODE,
      ...(hookOf(options.beforeRename, this.#beforeRename) ?? {}),
    });

    return record;
  }

  /** Reads `secrets.env`, or `undefined` when the optional file is absent. */
  readSecrets(name: string): string | undefined {
    const record = this.record(name);

    try {
      return readFileSync(record.secretsPath, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
        return undefined;
      }

      throw new PrerequisiteError(`could not read ${SECRETS_FILE_NAME} for app "${record.name}"`, {
        code: "SECRETS_UNREADABLE",
        details: { app: record.name, file: record.secretsPath, reason: messageOf(error) },
        remediation: `Grant read permission on "${record.secretsPath}" and retry.`,
      });
    }
  }

  /**
   * Atomically writes `secrets.env` with mode `0600`. The value is never
   * logged or included in an error (PRD-NF-10).
   */
  writeSecrets(name: string, contents: string, options: SecretsWriteOptions = {}): AppRecord {
    const record = this.record(name);

    writeFileAtomic(record.secretsPath, contents, {
      mode: SECRETS_FILE_MODE,
      ...(hookOf(options.beforeRename, this.#beforeRename) ?? {}),
    });

    return record;
  }

  /**
   * Creates `<apps>/<name>` and its `workspace/` directory with mode `0700`.
   * An existing entry, including a file or symlink, is a conflict and is never
   * overwritten (REG-FR-02).
   */
  create(name: string): AppRecord {
    const validated = validateAppName(name);
    this.ensureAppsDirectory();

    const record = recordFor(validated, path.join(this.appsDir, validated));
    const existing = lstatIfPresent(record.directory);

    if (existing !== undefined) {
      throw new ConflictError(`app "${validated}" already exists`, {
        code: "APP_NAME_CONFLICT",
        details: { app: validated, directory: record.directory },
        remediation: `Choose another name with --name, or inspect the existing app with "easy-host status ${validated}".`,
      });
    }

    try {
      mkdirSync(record.directory, { mode: APP_DIRECTORY_MODE });
      chmodSync(record.directory, APP_DIRECTORY_MODE);
      mkdirSync(record.workspacePath, { mode: APP_DIRECTORY_MODE });
      chmodSync(record.workspacePath, APP_DIRECTORY_MODE);
    } catch (error) {
      // A half-created app would look broken to `list`; remove only what this
      // call created.
      removeIfPresent(record.directory);
      throw createError(record, error);
    }

    return record;
  }

  /**
   * Deletes the whole app directory, but only after the caller confirms. The
   * confirmation check runs before any filesystem access so an accidental
   * `remove` cannot even probe the app.
   */
  remove(name: string, options: RemoveOptions): AppRecord {
    const validated = validateAppName(name);

    if (options.confirmed !== true) {
      throw new UsageError(`refusing to delete app "${validated}" without confirmation`, {
        code: "CONFIRMATION_REQUIRED",
        details: { app: validated },
        remediation: `Re-run with "easy-host remove ${validated} --yes" to delete the app directory.`,
      });
    }

    const record = this.record(validated);

    try {
      rmSync(record.directory, { recursive: true });
    } catch (error) {
      throw new PrerequisiteError(`could not delete app "${validated}"`, {
        code: "APP_DELETE_FAILED",
        details: { app: validated, directory: record.directory, reason: messageOf(error) },
        remediation: `Check permissions on "${record.directory}" and retry.`,
      });
    }

    return record;
  }

  private ensureAppsDirectory(): void {
    const stats = lstatIfPresent(this.appsDir);

    if (stats === undefined) {
      try {
        mkdirSync(this.appsDir, { recursive: true, mode: APP_DIRECTORY_MODE });
      } catch (error) {
        throw new PrerequisiteError(`could not create "${this.appsDir}"`, {
          code: "APPS_DIRECTORY_NOT_WRITABLE",
          details: { directory: this.appsDir, reason: messageOf(error) },
          remediation: `Grant write permission on "${path.dirname(this.appsDir)}" or set EASY_HOST_HOME to a writable directory.`,
        });
      }
      return;
    }

    if (!stats.isDirectory()) {
      throw new PrerequisiteError(`"${this.appsDir}" is not a directory`, {
        code: "APPS_DIRECTORY_INVALID",
        details: { directory: this.appsDir },
        remediation: `Move "${this.appsDir}" aside and run "easy-host doctor".`,
      });
    }
  }
}

function recordFor(name: string, directory: string): AppRecord {
  return {
    name,
    directory,
    configPath: path.join(directory, CONFIG_FILE_NAME),
    secretsPath: path.join(directory, SECRETS_FILE_NAME),
    statePath: path.join(directory, STATE_FILE_NAME),
    workspacePath: path.join(directory, WORKSPACE_DIRECTORY_NAME),
  };
}

function appsDirectoryOf(location: AppsDirectoryLocation): string {
  const directory = typeof location === "string" ? location : location.appsDir;

  if (directory.trim().length === 0) {
    throw new UsageError("the apps directory must not be empty", {
      code: "INVALID_APPS_DIRECTORY",
      remediation: "Resolve the state root with src/platform/paths.ts before using the registry.",
    });
  }

  return path.resolve(directory);
}

function readAppsDirectory(appsDir: string): Dirent[] {
  try {
    return readdirSync(appsDir, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return [];
    }

    throw new PrerequisiteError(`could not read the apps directory "${appsDir}"`, {
      code: "APPS_DIRECTORY_UNREADABLE",
      details: { directory: appsDir, reason: messageOf(error) },
      remediation: `Grant read permission on "${appsDir}" and retry.`,
    });
  }
}

function configReadError(record: AppRecord, error: unknown): EasyHostError {
  if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
    return new UsageError(`app "${record.name}" is missing ${CONFIG_FILE_NAME}`, {
      code: "MISSING_CONFIG",
      details: { app: record.name, file: record.configPath },
      remediation: `Restore ${CONFIG_FILE_NAME} in "${record.directory}", or delete the directory with "easy-host remove ${record.name} --yes".`,
    });
  }

  if (isErrnoCode(error, "EACCES") || isErrnoCode(error, "EPERM")) {
    return new PrerequisiteError(`app "${record.name}" has an unreadable ${CONFIG_FILE_NAME}`, {
      code: "CONFIG_UNREADABLE",
      details: { app: record.name, file: record.configPath, reason: messageOf(error) },
      remediation: `Grant read permission on "${record.configPath}" and retry.`,
    });
  }

  return new PrerequisiteError(`app "${record.name}" could not be read`, {
    code: "CONFIG_UNREADABLE",
    details: { app: record.name, file: record.configPath, reason: messageOf(error) },
    remediation: `Check "${record.configPath}" and retry.`,
  });
}

function createError(record: AppRecord, error: unknown): EasyHostError {
  if (isErrnoCode(error, "EEXIST")) {
    return new ConflictError(`app "${record.name}" already exists`, {
      code: "APP_NAME_CONFLICT",
      details: { app: record.name, directory: record.directory },
      remediation: `Choose another name with --name, or inspect the existing app with "easy-host status ${record.name}".`,
    });
  }

  return new PrerequisiteError(`could not create app "${record.name}"`, {
    code: "APP_CREATE_FAILED",
    details: { app: record.name, directory: record.directory, reason: messageOf(error) },
    remediation: `Grant write permission on "${path.dirname(record.directory)}" and retry.`,
  });
}

function compareEntries(left: AppListEntry, right: AppListEntry): number {
  if (left.name === right.name) {
    return 0;
  }

  return left.name < right.name ? -1 : 1;
}

function hookOf(
  override: BeforeRenameHook | undefined,
  fallback: BeforeRenameHook | undefined,
): { beforeRename: BeforeRenameHook } | undefined {
  const hook = override ?? fallback;
  return hook === undefined ? undefined : { beforeRename: hook };
}

function writeAll(descriptor: number, contents: string): void {
  const buffer = Buffer.from(contents, "utf8");
  let written = 0;

  while (written < buffer.length) {
    written += writeSync(descriptor, buffer, written, buffer.length - written);
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;

  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Best effort: some filesystems refuse fsync on a directory. The rename
    // is still atomic, so this cannot expose a partial file.
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Ignore; the write already succeeded.
      }
    }
  }
}

function removeIfPresent(target: string): void {
  try {
    rmSync(target, { force: true, recursive: true });
  } catch {
    // Cleanup is best effort; the original error is more useful.
  }
}

function lstatIfPresent(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return undefined;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
