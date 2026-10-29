import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_NAME_PATTERN,
  createPaths,
  InvalidAppNameError,
  Paths,
  resolveStateRoot,
  StateRootError,
} from "../../src/platform/paths.js";

const createdDirectories: string[] = [];
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "easy-host-paths-"));
  createdDirectories.push(directory);
  return directory;
}

function environment(values: Record<string, string>): NodeJS.ProcessEnv {
  return values;
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("expected the action to throw");
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("state root resolution", () => {
  it("prefers EASY_HOST_HOME over XDG_DATA_HOME and HOME", () => {
    const home = makeTemporaryDirectory();
    const xdgDataHome = makeTemporaryDirectory();
    const override = path.join(makeTemporaryDirectory(), "custom-root");

    const root = resolveStateRoot({
      env: environment({
        EASY_HOST_HOME: override,
        XDG_DATA_HOME: xdgDataHome,
        HOME: home,
      }),
      homeDir: home,
    });

    expect(root).toBe(override);
  });

  it("uses XDG_DATA_HOME/easy-host when EASY_HOST_HOME is unset", () => {
    const home = makeTemporaryDirectory();
    const xdgDataHome = path.join(makeTemporaryDirectory(), "data");

    const root = resolveStateRoot({
      env: environment({ XDG_DATA_HOME: xdgDataHome, HOME: home }),
      homeDir: home,
    });

    expect(root).toBe(path.join(xdgDataHome, "easy-host"));
  });

  it("falls back to ~/.local/share/easy-host when both overrides are unset", () => {
    const home = makeTemporaryDirectory();

    const root = resolveStateRoot({
      env: environment({ HOME: home }),
      homeDir: home,
    });

    expect(root).toBe(path.join(home, ".local", "share", "easy-host"));
  });

  it("treats an empty EASY_HOST_HOME as unset", () => {
    const home = makeTemporaryDirectory();

    const root = resolveStateRoot({
      env: environment({ EASY_HOST_HOME: "", XDG_DATA_HOME: "", HOME: home }),
      homeDir: home,
    });

    expect(root).toBe(path.join(home, ".local", "share", "easy-host"));
  });

  it("expands a leading tilde in EASY_HOST_HOME", () => {
    const home = makeTemporaryDirectory();

    const root = resolveStateRoot({
      env: environment({ EASY_HOST_HOME: "~/state", HOME: home }),
      homeDir: home,
    });

    expect(root).toBe(path.join(home, "state"));
  });

  it("expands a leading tilde in XDG_DATA_HOME", () => {
    const home = makeTemporaryDirectory();

    const root = resolveStateRoot({
      env: environment({ XDG_DATA_HOME: "~/.local/share", HOME: home }),
      homeDir: home,
    });

    expect(root).toBe(path.join(home, ".local", "share", "easy-host"));
  });

  it("resolves a relative EASY_HOST_HOME against the working directory", () => {
    const cwd = makeTemporaryDirectory();

    const root = resolveStateRoot({
      cwd,
      env: environment({ EASY_HOST_HOME: "relative/state" }),
      homeDir: makeTemporaryDirectory(),
    });

    expect(root).toBe(path.join(cwd, "relative", "state"));
  });
});

describe("Paths accessors", () => {
  it("derives the apps, tools, and buildkit directories from the root", () => {
    const root = path.join(makeTemporaryDirectory(), "state");
    const paths = createPaths({
      env: environment({ EASY_HOST_HOME: root }),
      homeDir: makeTemporaryDirectory(),
    });

    expect(paths.root).toBe(root);
    expect(paths.appsDir).toBe(path.join(root, "apps"));
    expect(paths.toolsDir).toBe(path.join(root, "tools"));
    expect(paths.buildkitDir).toBe(path.join(root, "buildkit"));
  });

  it("returns a per-app directory beneath apps/", () => {
    const paths = createPaths({
      env: environment({ EASY_HOST_HOME: path.join(makeTemporaryDirectory(), "state") }),
      homeDir: makeTemporaryDirectory(),
    });

    expect(paths.appDir("blog")).toBe(path.join(paths.appsDir, "blog"));
    expect(paths.appDir("api-2")).toBe(path.join(paths.appsDir, "api-2"));
  });

  it.each(["", "Blog", "../escape", "a/b", "a\\b", "-leading", "a".repeat(33)])(
    "rejects the unsafe app name %j",
    (name) => {
      const paths = createPaths({
        env: environment({ EASY_HOST_HOME: path.join(makeTemporaryDirectory(), "state") }),
        homeDir: makeTemporaryDirectory(),
      });

      const error = captureError(() => paths.appDir(name));

      expect(error).toBeInstanceOf(InvalidAppNameError);
      expect((error as InvalidAppNameError).exitCode).toBe(1);
      expect((error as InvalidAppNameError).code).toBe("INVALID_APP_NAME");
    },
  );

  it("publishes the documented app-name pattern", () => {
    expect(APP_NAME_PATTERN.test("blog")).toBe(true);
    expect(APP_NAME_PATTERN.test("my-app-2")).toBe(true);
    expect(APP_NAME_PATTERN.test("2fast")).toBe(true);
    expect(APP_NAME_PATTERN.test("Bad")).toBe(false);
  });
});

describe("ensureLayout", () => {
  it("creates the root and three child directories with mode 0700", () => {
    const parent = makeTemporaryDirectory();
    const root = path.join(parent, "state");
    const paths = createPaths({
      env: environment({ EASY_HOST_HOME: root }),
      homeDir: parent,
    });

    paths.ensureLayout();

    for (const directory of [root, paths.appsDir, paths.toolsDir, paths.buildkitDir]) {
      const stats = statSync(directory);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o700);
    }
  });

  it("never creates directories outside the resolved root", () => {
    const parent = makeTemporaryDirectory();
    const root = path.join(parent, "state");
    const paths = createPaths({
      env: environment({ EASY_HOST_HOME: root }),
      homeDir: parent,
    });

    paths.ensureLayout();

    expect(readdirSync(parent)).toEqual(["state"]);
  });

  it("creates missing XDG parents and keeps the layout private", () => {
    const home = makeTemporaryDirectory();
    const paths = new Paths({
      env: environment({ HOME: home }),
      homeDir: home,
    });

    paths.ensureLayout();

    expect(paths.root).toBe(path.join(home, ".local", "share", "easy-host"));
    for (const directory of [paths.root, paths.appsDir, paths.toolsDir, paths.buildkitDir]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it("is idempotent and never chmods an existing root", () => {
    const parent = makeTemporaryDirectory();
    const root = path.join(parent, "state");
    mkdirSync(root, { mode: 0o755 });
    const paths = createPaths({
      env: environment({ EASY_HOST_HOME: root }),
      homeDir: parent,
    });

    expect(() => paths.ensureLayout()).not.toThrow();
    expect(() => paths.ensureLayout()).not.toThrow();
    expect(statSync(root).mode & 0o777).toBe(0o755);
  });

  it("rejects a root whose nearest existing parent is not writable", () => {
    const parent = makeTemporaryDirectory();
    const root = path.join(parent, "state");
    const paths = createPaths({
      env: environment({ EASY_HOST_HOME: root }),
      homeDir: parent,
      isWritable: () => false,
    });

    const error = captureError(() => paths.ensureLayout());

    expect(error).toBeInstanceOf(StateRootError);
    expect((error as StateRootError).exitCode).toBe(2);
    expect((error as StateRootError).code).toBe("STATE_ROOT_NOT_WRITABLE");
    expect((error as Error).message).toContain(root);
    expect((error as StateRootError).remediation.length).toBeGreaterThan(0);
    expect(existsSync(root)).toBe(false);
  });

  it.skipIf(runningAsRoot)("rejects a root inside a read-only directory", () => {
    const parent = makeTemporaryDirectory();
    const locked = path.join(parent, "locked");
    mkdirSync(locked, { mode: 0o500 });
    chmodSync(locked, 0o500);
    const root = path.join(locked, "state");
    const paths = createPaths({
      env: environment({ EASY_HOST_HOME: root }),
      homeDir: parent,
    });

    try {
      const error = captureError(() => paths.ensureLayout());

      expect(error).toBeInstanceOf(StateRootError);
      expect((error as StateRootError).exitCode).toBe(2);
      expect(existsSync(root)).toBe(false);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("rejects a root that exists as a regular file", () => {
    const parent = makeTemporaryDirectory();
    const root = path.join(parent, "state");
    writeFileSync(root, "not a directory");
    const paths = createPaths({
      env: environment({ EASY_HOST_HOME: root }),
      homeDir: parent,
    });

    const error = captureError(() => paths.ensureLayout());

    expect(error).toBeInstanceOf(StateRootError);
    expect((error as StateRootError).exitCode).toBe(2);
  });
});
