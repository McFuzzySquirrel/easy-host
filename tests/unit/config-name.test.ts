import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, toExitCode } from "../../src/cli/errors.js";
import {
  APP_NAME_PATTERN,
  AppNameError,
  appNameExists,
  assertAppNameAvailable,
  deriveAppName,
  isAmbiguousAppName,
  isValidAppName,
  MAX_APP_NAME_LENGTH,
  repositoryBasename,
  resolveAppName,
  sanitizeAppName,
  validateAppName,
} from "../../src/config/name.js";

const createdDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "easy-host-name-"));
  createdDirectories.push(directory);
  return directory;
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("expected the action to throw");
}

function captureAppNameError(action: () => void): AppNameError {
  const error = captureError(action);
  expect(error).toBeInstanceOf(AppNameError);
  return error as AppNameError;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("REG-FR-02 name derivation", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["https://github.com/example/demo.git", "demo"],
    ["https://github.com/example/Demo", "demo"],
    ["https://github.com/example/demo.git/", "demo"],
    ["https://gitlab.com/group/subgroup/My_App.git", "my-app"],
    ["https://github.com/example/caf%C3%A9-app.git", "caf-app"],
    ["https://github.com/example/demo.git?ref=main#readme", "demo"],
    ["ssh://git@github.com/example/demo.git", "demo"],
    ["ssh://git@gitlab.com:2222/group/subgroup/repo.GIT", "repo"],
    ["git://github.com/example/demo.git", "demo"],
    ["git+ssh://git@github.com/example/demo.git", "demo"],
    ["git@github.com:example/demo.git", "demo"],
    ["git@gitlab.com:group/subgroup/repo.git", "repo"],
    ["git@github.com:example/demo", "demo"],
    ["file:///srv/repos/demo.git", "demo"],
    ["/home/operator/projects/My App/", "my-app"],
    ["/home/operator/projects/repo.git", "repo"],
    ["relative/path/to/Some_Repo", "some-repo"],
    ["C:\\Users\\dev\\projects\\Demo.App", "demo-app"],
  ];

  it.each(cases)("derives %j as %j", (source, expected) => {
    expect(deriveAppName(source)).toBe(expected);
    expect(APP_NAME_PATTERN.test(deriveAppName(source))).toBe(true);
  });

  it("removes a trailing .git suffix from the repository basename", () => {
    expect(repositoryBasename("https://github.com/example/demo.git")).toBe("demo");
    expect(repositoryBasename("git@github.com:example/demo.git")).toBe("demo");
    expect(repositoryBasename("/tmp/demo.git/")).toBe("demo");
    expect(deriveAppName("/tmp/demo.git/")).toBe("demo");
  });

  it("collapses unicode and other characters outside a-z0-9", () => {
    expect(deriveAppName("https://github.com/example/Café Ünit.git")).toBe("caf-nit");
    expect(sanitizeAppName("Hello,  Wörld!!")).toBe("hello-w-rld");
  });

  it("truncates over-long basenames to 32 characters", () => {
    const longName = "x".repeat(40);
    expect(deriveAppName(`https://github.com/example/${longName}.git`)).toBe("x".repeat(32));
    expect(deriveAppName(longName)).toHaveLength(MAX_APP_NAME_LENGTH);
  });

  it("removes a hyphen left at the truncation boundary", () => {
    const source = `${"a".repeat(31)}-hidden`;
    const name = deriveAppName(source);

    expect(name).toBe("a".repeat(31));
    expect(name.endsWith("-")).toBe(false);
    expect(APP_NAME_PATTERN.test(name)).toBe(true);
  });

  it("allows reserved-looking names that are safe under the allowlist", () => {
    for (const source of ["CON", "NUL", "AUX", "PRN", "config", "apps", "tools", "doctor"]) {
      const name = deriveAppName(source);
      expect(name).toBe(source.toLowerCase());
      expect(validateAppName(name)).toBe(name);
    }
  });

  it("rejects sources with no usable repository segment", () => {
    for (const source of ["", "   ", ".", "..", "/", "\\", "https://github.com/", ".git"]) {
      const error = captureAppNameError(() => deriveAppName(source));
      expect(error.exitCode).toBe(1);
      expect(error.code).toBe("INVALID_APP_NAME");
      expect(error.remediation).toContain("--name");
    }
  });

  it("rejects a wholly numeric derived name as ambiguous", () => {
    const error = captureAppNameError(() => deriveAppName("123"));

    expect(error.code).toBe("AMBIGUOUS_APP_NAME");
    expect(toExitCode(error)).toBe(1);
    expect(error.details).toMatchObject({ name: "123", reason: "ambiguous-name" });
    expect(isAmbiguousAppName("123")).toBe(true);
    expect(isAmbiguousAppName("123-app")).toBe(false);
    expect(deriveAppName("123-app")).toBe("123-app");
  });

  it("never echoes URL credentials in a naming error", () => {
    const error = captureAppNameError(() => deriveAppName("https://user:s3cr3t@github.com/"));

    expect(error.message).not.toContain("s3cr3t");
    expect(JSON.stringify(error.details)).not.toContain("s3cr3t");
    expect(error.message).toContain("[redacted]");
  });
});

describe("REG-FR-02 explicit name validation", () => {
  it("accepts values that match the documented pattern", () => {
    for (const name of [
      "a",
      "blog",
      "my-app",
      "0",
      "123",
      "app-123",
      "foo-",
      "a".repeat(MAX_APP_NAME_LENGTH),
    ]) {
      expect(isValidAppName(name)).toBe(true);
      expect(validateAppName(name)).toBe(name);
    }
  });

  it("rejects values outside the documented pattern", () => {
    const invalid = [
      "",
      " ",
      "Foo",
      "FOO",
      "foo_bar",
      "foo.bar",
      "foo/bar",
      "../escape",
      "-foo",
      "foo bar",
      "café",
      "a".repeat(MAX_APP_NAME_LENGTH + 1),
    ];

    for (const name of invalid) {
      const error = captureAppNameError(() => validateAppName(name));
      expect(isValidAppName(name)).toBe(false);
      expect(error.code).toBe("INVALID_APP_NAME");
      expect(error.exitCode).toBe(1);
      expect(error.remediation).toContain("^[a-z0-9][a-z0-9-]{0,31}$");
    }
  });

  it("does not echo control characters or escape sequences", () => {
    const error = captureAppNameError(() => validateAppName("bad\u001b[31mname"));

    expect(error.message).not.toContain("\u001b");
    expect(error.details).toMatchObject({ reason: "invalid-name" });
  });

  it("resolves an explicit override without sanitizing it", () => {
    expect(
      captureError(() => resolveAppName("https://github.com/example/demo.git", "Chosen Name")),
    ).toBeInstanceOf(AppNameError);

    expect(resolveAppName("https://github.com/example/demo.git", "chosen-name")).toBe(
      "chosen-name",
    );
    expect(resolveAppName({ source: "https://github.com/example/demo.git" })).toBe("demo");
    expect(resolveAppName({ name: "override" })).toBe("override");
    expect(resolveAppName({ name: "123" })).toBe("123");
  });

  it("requires a source when there is no override", () => {
    const error = captureAppNameError(() => resolveAppName(undefined));

    expect(error.details).toMatchObject({ reason: "missing-source" });
  });
});

describe("REG-FR-02 collision detection", () => {
  it("reports an existing app directory as a conflict instead of overwriting", () => {
    const appsDir = path.join(makeTemporaryDirectory(), "apps");
    const appDir = path.join(appsDir, "existing");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, "marker.txt"), "keep me");

    expect(appNameExists("existing", appsDir)).toBe(true);
    expect(appNameExists("other", appsDir)).toBe(false);

    const error = captureError(() => assertAppNameAvailable("existing", appsDir));
    expect(error).toBeInstanceOf(ConflictError);
    expect(toExitCode(error)).toBe(6);
    expect((error as ConflictError).code).toBe("APP_NAME_CONFLICT");
    expect((error as ConflictError).details).toMatchObject({ name: "existing", directory: appDir });

    // The pre-check never mutates the existing app.
    expect(appNameExists("existing", appsDir)).toBe(true);
    expect(readFileSync(path.join(appDir, "marker.txt"), "utf8")).toBe("keep me");
  });

  it("treats a file occupying the name as a conflict", () => {
    const appsDir = path.join(makeTemporaryDirectory(), "apps");
    mkdirSync(appsDir, { recursive: true });
    writeFileSync(path.join(appsDir, "blocked"), "not a directory");

    expect(appNameExists("blocked", appsDir)).toBe(true);
    expect(captureError(() => assertAppNameAvailable("blocked", appsDir))).toBeInstanceOf(
      ConflictError,
    );
  });

  it("accepts a free name and returns it", () => {
    const appsDir = path.join(makeTemporaryDirectory(), "apps");
    mkdirSync(appsDir, { recursive: true });

    expect(assertAppNameAvailable("fresh-app", appsDir)).toBe("fresh-app");
  });

  it("accepts a Paths-shaped holder and a missing apps directory", () => {
    const appsDir = path.join(makeTemporaryDirectory(), "apps");

    expect(appNameExists("fresh-app", { appsDir })).toBe(false);
    expect(assertAppNameAvailable("fresh-app", { appsDir })).toBe("fresh-app");
  });

  it("validates the name before touching the filesystem", () => {
    const appsDir = makeTemporaryDirectory();

    expect(captureError(() => assertAppNameAvailable("../escape", appsDir))).toBeInstanceOf(
      AppNameError,
    );
    expect(captureError(() => appNameExists("../escape", appsDir))).toBeInstanceOf(AppNameError);
  });
});

describe("sanitization invariants", () => {
  it("returns either an empty string or a name matching the pattern", () => {
    const samples = [
      "",
      "!!!",
      "日本語",
      ".hidden",
      "A__B",
      "  padded  ",
      "x".repeat(100),
      `${"a".repeat(40)}---${"B".repeat(40)}`,
    ];

    for (const sample of samples) {
      const name = sanitizeAppName(sample);
      expect(name === "" || APP_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it("lowercases and collapses each non-alphanumeric run to one hyphen", () => {
    expect(sanitizeAppName("My  __  App")).toBe("my-app");
    expect(sanitizeAppName("--Edge--Case--")).toBe("edge-case");
  });
});
