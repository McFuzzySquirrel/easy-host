import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, type EasyHostError, UsageError } from "../../src/cli/errors.js";
import {
  ALLOCATION_LOCK_SUFFIX,
  APP_LOCK_FILE_NAME,
  acquireAllocationLock,
  acquireAppLock,
  allocationLockPath,
  appLockPath,
  LOCK_FILE_MODE,
  readLockHolder,
  withAllocationLock,
  withAppLock,
} from "../../src/platform/lock.js";

const fixedNow = new Date("2026-10-30T12:00:00.000Z");
const createdDirectories: string[] = [];

function makeRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "easy-host-lock-"));
  createdDirectories.push(directory);
  return directory;
}

function makeAppDir(name = "blog"): string {
  const appDir = path.join(makeRoot(), name);
  mkdirSync(appDir, { mode: 0o700 });
  return appDir;
}

function makeAppsDir(): string {
  const appsDir = path.join(makeRoot(), "apps");
  mkdirSync(appsDir, { mode: 0o700 });
  return appsDir;
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("expected the action to throw");
}

function exitCodeOf(error: unknown): number {
  return (error as EasyHostError).exitCode;
}

function writeStaleLock(lockPath: string, pid: number): void {
  writeFileSync(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid,
      startedAt: "2026-10-30T10:00:00.000Z",
      token: "stale-holder",
      operation: "update",
      app: "blog",
    })}\n`,
    { mode: 0o600 },
  );
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("per-app lock", () => {
  it("creates an exclusive lock file inside the app directory with pid and start time", () => {
    const appDir = makeAppDir();
    const lock = acquireAppLock(appDir, {
      pid: 4242,
      clock: () => fixedNow,
      operation: "update",
      app: "blog",
    });

    try {
      const lockPath = appLockPath(appDir);
      expect(lock.path).toBe(lockPath);
      expect(lockPath).toBe(path.join(appDir, APP_LOCK_FILE_NAME));
      expect(lock.holder).toEqual({
        pid: 4242,
        startedAt: fixedNow.toISOString(),
        operation: "update",
        app: "blog",
      });

      const document = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
      expect(document.pid).toBe(4242);
      expect(document.startedAt).toBe(fixedNow.toISOString());
      expect(document.operation).toBe("update");
      expect(document.app).toBe("blog");
      expect(statSync(lockPath).mode & 0o777).toBe(LOCK_FILE_MODE);
      expect(readLockHolder(lockPath)?.pid).toBe(4242);
    } finally {
      lock.release();
    }
  });

  it("fails immediately with exit code 6 and names the live holder", () => {
    const appDir = makeAppDir();
    const held = acquireAppLock(appDir, {
      pid: 5150,
      clock: () => fixedNow,
      operation: "update",
      app: "blog",
    });

    try {
      const error = captureError(() =>
        acquireAppLock(appDir, { pid: 5151, isProcessAlive: () => true }),
      );

      expect(error).toBeInstanceOf(ConflictError);
      const conflict = error as ConflictError;
      expect(conflict.exitCode).toBe(6);
      expect(conflict.code).toBe("LOCK_HELD");
      expect(conflict.message).toContain("blog");
      expect(conflict.message).toContain("5150");
      expect(conflict.message).toContain("update");
      expect(conflict.details.pid).toBe(5150);
      expect(conflict.details.holder).toContain("5150");
    } finally {
      held.release();
    }
  });

  it("reports a second acquisition from the same process as this process", () => {
    const appDir = makeAppDir();
    const held = acquireAppLock(appDir);

    try {
      const error = captureError(() => acquireAppLock(appDir, { isProcessAlive: () => true }));

      expect(exitCodeOf(error)).toBe(6);
      expect((error as ConflictError).message).toContain("this process");
    } finally {
      held.release();
    }
  });

  it("reclaims a stale lock from a dead pid", () => {
    const appDir = makeAppDir();
    const lockPath = appLockPath(appDir);
    writeStaleLock(lockPath, 999_999);

    const lock = acquireAppLock(appDir, {
      pid: 1234,
      clock: () => fixedNow,
      isProcessAlive: (pid) => pid === 1234,
    });

    try {
      expect(readLockHolder(lockPath)).toEqual({
        pid: 1234,
        startedAt: fixedNow.toISOString(),
        operation: "mutate",
        app: "blog",
      });
      expect(readdirSync(appDir)).toEqual([APP_LOCK_FILE_NAME]);
    } finally {
      lock.release();
    }
  });

  it("reclaims an unparseable lock file left by an interrupted writer", () => {
    const appDir = makeAppDir();
    const lockPath = appLockPath(appDir);
    writeFileSync(lockPath, "{ not json", { mode: 0o600 });

    const lock = acquireAppLock(appDir, { pid: 777 });

    try {
      expect(readLockHolder(lockPath)?.pid).toBe(777);
    } finally {
      lock.release();
    }
  });

  it("releases the lock and can be released twice", () => {
    const appDir = makeAppDir();
    const lock = acquireAppLock(appDir);

    lock.release();
    lock.release();

    expect(existsSync(appLockPath(appDir))).toBe(false);

    const again = acquireAppLock(appDir);
    again.release();
    expect(existsSync(appLockPath(appDir))).toBe(false);
  });

  it("does not remove a lock that another holder replaced", () => {
    const appDir = makeAppDir();
    const lock = acquireAppLock(appDir, { pid: 1 });
    const lockPath = appLockPath(appDir);

    writeStaleLock(lockPath, 2);
    lock.release();

    expect(existsSync(lockPath)).toBe(true);
    expect(readLockHolder(lockPath)?.pid).toBe(2);
    rmSync(lockPath, { force: true });
  });

  it("releases the lock when the operation throws", () => {
    const appDir = makeAppDir();

    expect(() =>
      withAppLock(appDir, () => {
        throw new Error("build failed");
      }),
    ).toThrow("build failed");

    expect(existsSync(appLockPath(appDir))).toBe(false);
    const lock = acquireAppLock(appDir);
    lock.release();
  });

  it("holds the lock for the whole action", () => {
    const appDir = makeAppDir();
    let conflict: unknown;

    withAppLock(
      appDir,
      () => {
        expect(existsSync(appLockPath(appDir))).toBe(true);
        try {
          acquireAppLock(appDir, { isProcessAlive: () => true });
        } catch (error) {
          conflict = error;
        }
      },
      { isProcessAlive: () => false },
    );

    expect(exitCodeOf(conflict)).toBe(6);
    expect(existsSync(appLockPath(appDir))).toBe(false);
  });

  it("does not create a missing app directory just to take its lock", () => {
    const appDir = path.join(makeRoot(), "missing");

    const error = captureError(() => acquireAppLock(appDir));

    expect(exitCodeOf(error)).toBe(2);
    expect((error as EasyHostError).code).toBe("LOCK_DIRECTORY_MISSING");
    expect(existsSync(appDir)).toBe(false);
  });
});

describe("name-allocation lock", () => {
  it("creates a short-lived lock beside the apps directory", () => {
    const appsDir = makeAppsDir();
    const lock = acquireAllocationLock(appsDir, "blog", {
      pid: 888,
      clock: () => fixedNow,
    });

    try {
      expect(lock.path).toBe(allocationLockPath(appsDir, "blog"));
      expect(path.dirname(lock.path)).toBe(appsDir);
      expect(path.basename(lock.path)).toBe(`.blog${ALLOCATION_LOCK_SUFFIX}`);
      expect(readLockHolder(lock.path)).toEqual({
        pid: 888,
        startedAt: fixedNow.toISOString(),
        operation: "allocate",
        app: "blog",
      });

      const error = captureError(() =>
        acquireAllocationLock(appsDir, "blog", { pid: 889, isProcessAlive: () => true }),
      );
      expect(exitCodeOf(error)).toBe(6);
      expect((error as ConflictError).message).toContain("blog");
      expect((error as ConflictError).message).toContain("888");
    } finally {
      lock.release();
    }

    expect(existsSync(allocationLockPath(appsDir, "blog"))).toBe(false);
  });

  it("allows a different name to allocate concurrently", () => {
    const appsDir = makeAppsDir();
    const blog = acquireAllocationLock(appsDir, "blog");

    try {
      const api = acquireAllocationLock(appsDir, "api");
      expect(api.path).not.toBe(blog.path);
      api.release();
    } finally {
      blog.release();
    }
  });

  it("releases the allocation lock when the operation throws", () => {
    const appsDir = makeAppsDir();

    expect(() =>
      withAllocationLock(appsDir, "blog", () => {
        throw new Error("name conflict");
      }),
    ).toThrow("name conflict");

    expect(existsSync(allocationLockPath(appsDir, "blog"))).toBe(false);
  });

  it("rejects a name that could escape the apps directory", () => {
    const appsDir = makeAppsDir();

    const error = captureError(() => allocationLockPath(appsDir, "../escape"));

    expect(error).toBeInstanceOf(UsageError);
    expect(exitCodeOf(error)).toBe(1);
    expect((error as UsageError).code).toBe("INVALID_APP_NAME");
  });
});
