/**
 * Per-app and name-allocation locks (REG-FR-05).
 *
 * A mutating lifecycle operation takes one exclusive lock file inside the app
 * directory; `add` additionally takes a short-lived allocation lock beside the
 * apps directory while it re-checks the name and creates the directory. Both
 * locks record the holder's pid and start time so a conflict can name the
 * process that owns it.
 *
 * Acquire is non-blocking: the complete lock document is hard-linked into
 * place, and a live holder makes the second caller fail immediately with exit
 * code 6. A lock whose pid is gone is reclaimed. Reclamation renames the stale
 * file to a unique quarantine path and verifies the bytes have not changed in
 * the meantime, so a concurrent reclaim cannot delete a lock that a third
 * process just acquired.
 *
 * Read-only commands never take a lock: this module offers no global lock, and
 * callers acquire the app lock only around the mutation they perform. The
 * return value of {@link withAppLock} and {@link withAllocationLock} is the
 * action's result; the lock is released in `finally` on every throw path.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { ConflictError, PrerequisiteError, UsageError } from "../cli/errors.js";
import { APP_NAME_PATTERN } from "./paths.js";

/** Name of the per-app lock file, relative to the app directory. */
export const APP_LOCK_FILE_NAME = ".lock";

/** Suffix of the short-lived name-allocation lock beside the apps directory. */
export const ALLOCATION_LOCK_SUFFIX = ".allocation.lock";

/**
 * Locks hold no secrets, but they are private to the operator like the rest of
 * the app directory (`PRD-SP-01`).
 */
export const LOCK_FILE_MODE = 0o600;

/** Version of the lock-file document, for future diagnostics. */
export const LOCK_SCHEMA_VERSION = 1;

/** How many times a stale or vanished lock is reclaimed before giving up. */
const DEFAULT_RECLAIM_ATTEMPTS = 3;

const TEMPORARY_LOCK_SUFFIX = ".tmp";

/**
 * The public view of whoever holds a lock. `startedAt` is an ISO timestamp
 * from the holder's clock; `operation` names the command that took the lock.
 */
export interface LockHolder {
  readonly pid: number;
  readonly startedAt: string;
  readonly operation?: string;
  readonly app?: string;
}

/**
 * Inputs every acquisition accepts. The defaults target the current process
 * and real clock; tests inject a pid, clock, and liveness probe so lock
 * behaviour is deterministic with no real competing process.
 */
export interface LockAcquireOptions {
  /** App name used in diagnostics. Defaults to the app directory basename. */
  app?: string;
  /** Command or phase that owns the lock, for example `update`. */
  operation?: string;
  /** Pid recorded as the holder. Defaults to `process.pid`. */
  pid?: number;
  /** Clock used for `startedAt`. Defaults to `new Date()`. */
  clock?: () => Date;
  /** Liveness probe for a recorded pid. Defaults to `kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /** Reclaim attempts before reporting contention. Defaults to 3. */
  maxReclaimAttempts?: number;
}

/** An acquired exclusive lock. Calling `release` more than once is a no-op. */
export interface FileLock {
  /** Absolute path of the lock file. */
  readonly path: string;
  /** The holder recorded in the file when it was created. */
  readonly holder: LockHolder;
  release(): void;
}

/** The persisted lock document. `token` identifies this exact acquisition. */
interface LockDocument extends LockHolder {
  readonly schemaVersion: number;
  readonly token: string;
}

/** What was read from an existing lock file. */
interface ObservedLock {
  readonly raw: string;
  readonly holder: LockHolder | undefined;
}

/**
 * The lock file for one app: `<appDir>/.lock`.
 *
 * The lock lives inside the app directory so the registry never needs a global
 * lock and a removed app cannot leave a lock behind outside its own tree.
 */
export function appLockPath(appDir: string): string {
  return path.join(path.resolve(appDir), APP_LOCK_FILE_NAME);
}

/**
 * The short-lived allocation lock for a name: `<appsDir>/.<name>.allocation.lock`.
 *
 * It lives beside the app directories, not inside one, because it guards the
 * window before the app directory exists. A plain file is ignored by the
 * registry scan, which treats only directories as app candidates.
 */
export function allocationLockPath(appsDir: string, appName: string): string {
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new UsageError(`invalid app name ${JSON.stringify(appName)} for an allocation lock`, {
      code: "INVALID_APP_NAME",
      details: { name: appName },
      remediation: "Use 1-32 characters matching ^[a-z0-9][a-z0-9-]{0,31}$.",
    });
  }

  return path.join(path.resolve(appsDir), `.${appName}${ALLOCATION_LOCK_SUFFIX}`);
}

/**
 * Acquires the exclusive lock for an existing app directory.
 *
 * Fails with exit code 6 when a live process holds the lock and names that
 * process. A lock whose pid no longer exists is reclaimed.
 */
export function acquireAppLock(appDir: string, options: LockAcquireOptions = {}): FileLock {
  const directory = path.resolve(appDir);

  return acquireLock(appLockPath(directory), {
    operation: "mutate",
    ...options,
    app: options.app ?? path.basename(directory),
  });
}

/**
 * Runs `action` while holding the app lock and releases it on every throw path.
 * Read-only work must not use this helper.
 */
export function withAppLock<T>(
  appDir: string,
  action: (lock: FileLock) => T,
  options: LockAcquireOptions = {},
): T {
  const lock = acquireAppLock(appDir, options);

  try {
    return action(lock);
  } finally {
    lock.release();
  }
}

/**
 * Acquires the short-lived name-allocation lock used by `add` while it
 * re-checks the name, validates the port, and creates the app directory.
 */
export function acquireAllocationLock(
  appsDir: string,
  appName: string,
  options: LockAcquireOptions = {},
): FileLock {
  return acquireLock(allocationLockPath(appsDir, appName), {
    operation: "allocate",
    ...options,
    app: appName,
  });
}

/**
 * Runs `action` while holding the name-allocation lock and releases it on every
 * throw path.
 */
export function withAllocationLock<T>(
  appsDir: string,
  appName: string,
  action: (lock: FileLock) => T,
  options: LockAcquireOptions = {},
): T {
  const lock = acquireAllocationLock(appsDir, appName, options);

  try {
    return action(lock);
  } finally {
    lock.release();
  }
}

/**
 * Acquires any lock file non-blockingly. Callers normally use
 * {@link acquireAppLock} or {@link acquireAllocationLock}; this seam exists so
 * the build and lifecycle layers can reuse the same semantics.
 */
export function acquireLock(lockPath: string, options: LockAcquireOptions = {}): FileLock {
  const absolutePath = path.resolve(lockPath);
  const pid = options.pid ?? process.pid;
  const startedAt = (options.clock ?? defaultClock)().toISOString();
  const token = randomUUID();
  const document: LockDocument = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid,
    startedAt,
    token,
    ...(options.operation === undefined ? {} : { operation: options.operation }),
    ...(options.app === undefined ? {} : { app: options.app }),
  };
  const holder = holderOf(document);
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const attempts = Math.max(1, options.maxReclaimAttempts ?? DEFAULT_RECLAIM_ATTEMPTS);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      createLockFile(absolutePath, document);
      return new HeldLock(absolutePath, holder, token);
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) {
        throw lockCreateError(absolutePath, error);
      }
    }

    const observed = readLockFile(absolutePath);
    if (observed === undefined) {
      // The holder released between our create attempt and the read; retry.
      continue;
    }

    if (observed.holder !== undefined && isProcessAlive(observed.holder.pid)) {
      throw lockHeldError(absolutePath, observed.holder, options, pid);
    }

    reclaimStaleLock(absolutePath, observed, pid);
  }

  throw new ConflictError(
    `lock "${absolutePath}" could not be acquired after ${attempts} attempt(s): another process kept recreating it`,
    {
      code: "LOCK_CONTENTION",
      details: { lock: absolutePath, attempts },
      remediation: `Wait for the other easy-host process to finish, then retry. If no process is running, remove "${absolutePath}".`,
    },
  );
}

/**
 * Reads the holder recorded in a lock file, or `undefined` when the file is
 * absent or unparseable. Intended for diagnostics and tests; taking the lock is
 * the only way to claim it.
 */
export function readLockHolder(lockPath: string): LockHolder | undefined {
  return readLockFile(path.resolve(lockPath))?.holder;
}

/** One acquired lock. */
class HeldLock implements FileLock {
  readonly path: string;
  readonly holder: LockHolder;
  readonly #token: string;
  #released = false;

  constructor(lockPath: string, holder: LockHolder, token: string) {
    this.path = lockPath;
    this.holder = holder;
    this.#token = token;
  }

  release(): void {
    if (this.#released) {
      return;
    }

    this.#released = true;
    removeOwnLock(this.path, this.#token);
  }
}

/**
 * Creates the lock file atomically.
 *
 * The complete document is written and fsynced to a same-directory temporary
 * file first, then hard-linked into place. `link` fails with `EEXIST` when the
 * path is taken, which is the whole contention rule, and it never exposes a
 * half-written document to another process. The temporary file is removed on
 * every path.
 */
function createLockFile(lockPath: string, document: LockDocument): void {
  const temporaryPath = path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.${process.pid}.${randomUUID()}${TEMPORARY_LOCK_SUFFIX}`,
  );
  const descriptor = openSync(temporaryPath, "wx", LOCK_FILE_MODE);

  try {
    const contents = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
    let written = 0;

    while (written < contents.length) {
      written += writeSync(descriptor, contents, written, contents.length - written);
    }

    fsyncSync(descriptor);
  } catch (error) {
    removeQuietly(temporaryPath);
    throw error;
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The document is either complete or already removed; closing again is
      // not useful and the original error is more informative.
    }
  }

  try {
    linkSync(temporaryPath, lockPath);
  } finally {
    removeQuietly(temporaryPath);
  }
}

function readLockFile(lockPath: string): ObservedLock | undefined {
  let raw: string;

  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return undefined;
    }

    throw new PrerequisiteError(`could not read lock file "${lockPath}"`, {
      code: "LOCK_UNREADABLE",
      details: { lock: lockPath, reason: messageOf(error) },
      remediation: `Grant read permission on "${lockPath}" and retry.`,
    });
  }

  return { raw, holder: parseHolder(raw) };
}

/**
 * Reclaims a lock whose holder is gone. The rename both detaches the stale file
 * and gives this process a private copy to verify; if the bytes changed while
 * we were deciding, another process won the race, so the replacement is put
 * back and the caller sees a conflict rather than two holders.
 */
function reclaimStaleLock(lockPath: string, observed: ObservedLock, pid: number): void {
  const quarantinePath = `${lockPath}.${pid}.${randomUUID()}.stale`;

  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return;
    }

    throw new PrerequisiteError(`could not reclaim the stale lock "${lockPath}"`, {
      code: "LOCK_RECLAIM_FAILED",
      details: { lock: lockPath, reason: messageOf(error) },
      remediation: `Remove "${lockPath}" manually if no easy-host process is running, then retry.`,
    });
  }

  let quarantined: string | undefined;
  try {
    quarantined = readFileSync(quarantinePath, "utf8");
  } catch (error) {
    if (!(isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR"))) {
      throw error;
    }
  }

  if (quarantined !== observed.raw) {
    restoreQuarantinedLock(lockPath, quarantinePath);
    throw new ConflictError(`lock "${lockPath}" changed while a stale lock was being reclaimed`, {
      code: "LOCK_CONTENTION",
      details: { lock: lockPath },
      remediation: `Retry the command. If it keeps failing, check for another easy-host process with "ps".`,
    });
  }

  removeQuietly(quarantinePath);
}

function restoreQuarantinedLock(lockPath: string, quarantinePath: string): void {
  try {
    if (!pathEntryExists(lockPath)) {
      renameSync(quarantinePath, lockPath);
      return;
    }
  } catch {
    // Fall through to cleanup; the live holder still owns `lockPath`.
  }

  removeQuietly(quarantinePath);
}

function removeOwnLock(lockPath: string, token: string): void {
  let raw: string;

  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return;
  }

  if (tokenOf(raw) !== token) {
    // Another process already replaced the lock; never delete its file.
    return;
  }

  removeQuietly(lockPath);
}

function parseHolder(raw: string): LockHolder | undefined {
  const parsed = parseDocument(raw);
  if (parsed === undefined) {
    return undefined;
  }

  return holderOf(parsed);
}

function parseDocument(raw: string): LockDocument | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;
  const { pid, startedAt, token } = candidate;

  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof startedAt !== "string" ||
    startedAt.length === 0 ||
    typeof token !== "string" ||
    token.length === 0
  ) {
    return undefined;
  }

  return {
    schemaVersion:
      typeof candidate.schemaVersion === "number" ? candidate.schemaVersion : LOCK_SCHEMA_VERSION,
    pid,
    startedAt,
    token,
    ...(typeof candidate.operation === "string" ? { operation: candidate.operation } : {}),
    ...(typeof candidate.app === "string" ? { app: candidate.app } : {}),
  };
}

function tokenOf(raw: string): string | undefined {
  return parseDocument(raw)?.token;
}

function holderOf(document: LockDocument): LockHolder {
  return {
    pid: document.pid,
    startedAt: document.startedAt,
    ...(document.operation === undefined ? {} : { operation: document.operation }),
    ...(document.app === undefined ? {} : { app: document.app }),
  };
}

function lockHeldError(
  lockPath: string,
  holder: LockHolder,
  options: LockAcquireOptions,
  currentPid: number,
): ConflictError {
  const label = options.app === undefined ? `lock "${lockPath}"` : `app "${options.app}"`;
  const self = holder.pid === currentPid ? " (this process)" : "";
  const operation = holder.operation === undefined ? "" : ` running "${holder.operation}"`;

  return new ConflictError(
    `${label} is locked by pid ${holder.pid}${self}${operation} (started ${holder.startedAt})`,
    {
      code: "LOCK_HELD",
      details: {
        lock: path.basename(lockPath),
        holder: describeHolder(holder),
        pid: holder.pid,
        startedAt: holder.startedAt,
        ...(holder.operation === undefined ? {} : { operation: holder.operation }),
        ...(holder.app === undefined ? {} : { app: holder.app }),
      },
      remediation: `Wait for pid ${holder.pid} to finish. If that process no longer exists, remove "${lockPath}" and retry.`,
    },
  );
}

function describeHolder(holder: LockHolder): string {
  const operation = holder.operation === undefined ? "" : `, ${holder.operation}`;
  const app = holder.app === undefined ? "" : `, app ${holder.app}`;
  return `pid ${holder.pid} (started ${holder.startedAt}${operation}${app})`;
}

function lockCreateError(lockPath: string, error: unknown): PrerequisiteError {
  if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
    return new PrerequisiteError(
      `could not create lock file "${lockPath}": the directory is missing`,
      {
        code: "LOCK_DIRECTORY_MISSING",
        details: { lock: lockPath, reason: messageOf(error) },
        remediation: `Create "${path.dirname(lockPath)}" first, or check that the app still exists.`,
      },
    );
  }

  if (isErrnoCode(error, "EACCES") || isErrnoCode(error, "EPERM") || isErrnoCode(error, "EROFS")) {
    return new PrerequisiteError(`could not create lock file "${lockPath}": permission denied`, {
      code: "LOCK_NOT_WRITABLE",
      details: { lock: lockPath, reason: messageOf(error) },
      remediation: `Grant write permission on "${path.dirname(lockPath)}" and retry.`,
    });
  }

  return new PrerequisiteError(`could not create lock file "${lockPath}"`, {
    code: "LOCK_CREATE_FAILED",
    details: { lock: lockPath, reason: messageOf(error) },
    remediation: `Check permissions and free space on "${path.dirname(lockPath)}" and retry.`,
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return isErrnoCode(error, "EPERM");
  }
}

function defaultClock(): Date {
  return new Date();
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

function removeQuietly(target: string): void {
  try {
    rmSync(target, { force: true });
  } catch {
    // Best effort: a leftover stale file is reclaimed on the next acquire.
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
