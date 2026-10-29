import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatError,
  formatErrorJson,
  REDACTED,
  toExitCode,
  UsageError,
} from "../../src/cli/errors.js";
import {
  DEFAULT_SECRETS_FILE,
  EnvironmentFileError,
  type EnvironmentSpec,
  loadEnvironment,
  mergeEnvironment,
  parseSecretsFile,
  redactEnvironment,
} from "../../src/config/env.js";
import { parseConfigToml } from "../../src/config/parse.js";

const SECRET_VALUE = "s3cr3t-value-9f3a";

const createdDirectories: string[] = [];

function makeAppDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "easy-host-env-"));
  createdDirectories.push(directory);
  return directory;
}

function writeSecrets(appDir: string, contents: string, name = DEFAULT_SECRETS_FILE): string {
  const target = path.join(appDir, name);
  writeFileSync(target, contents);
  return target;
}

function specWith(env: Record<string, string> = {}, envFile?: string): EnvironmentSpec {
  return envFile === undefined ? { env } : { env, env_file: envFile };
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("expected the action to throw");
}

function captureEnvironmentError(source: string, file = "secrets.env"): EnvironmentFileError {
  const error = captureError(() => parseSecretsFile(source, { file }));
  expect(error).toBeInstanceOf(EnvironmentFileError);
  return error as EnvironmentFileError;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("REG-FR-06 secrets file parsing", () => {
  it("parses simple assignments and ignores blank lines and full-line comments", () => {
    const entries = parseSecretsFile(
      [
        "# leading comment",
        "",
        "   ",
        "   # indented comment",
        "DATABASE_URL=postgres://localhost/app",
        "EMPTY=",
        "PADDED =  value with spaces  ",
        "",
      ].join("\n"),
    );

    expect(entries).toEqual({
      DATABASE_URL: "postgres://localhost/app",
      EMPTY: "",
      PADDED: "value with spaces",
    });
  });

  it("accepts a UTF-8 BOM and CRLF line endings", () => {
    const entries = parseSecretsFile("\uFEFFAPI_TOKEN=first\r\nREGION=eu-west\r\n");

    expect(entries).toEqual({ API_TOKEN: "first", REGION: "eu-west" });
  });

  it("keeps '=' characters inside values", () => {
    expect(parseSecretsFile("CONNECTION=host=db;user=app")).toEqual({
      CONNECTION: "host=db;user=app",
    });
  });

  it("uses the last value for duplicate keys", () => {
    expect(parseSecretsFile("TOKEN=first\nTOKEN=second\n")).toEqual({ TOKEN: "second" });
  });

  it("strips an inline comment from an unquoted value", () => {
    expect(parseSecretsFile("TOKEN=abc123 # rotate quarterly\n")).toEqual({ TOKEN: "abc123" });
  });

  it("keeps '#' when it does not start a comment", () => {
    expect(parseSecretsFile("TOKEN=abc#123\n")).toEqual({ TOKEN: "abc#123" });
  });

  it("parses single-quoted values literally, including '#' and '='", () => {
    expect(parseSecretsFile("MOTD='line # one = two'\n")).toEqual({ MOTD: "line # one = two" });
  });

  it("parses double-quoted values with escapes", () => {
    expect(parseSecretsFile('MOTD="line1\\nline2\\t\\"quoted\\""\n')).toEqual({
      MOTD: 'line1\nline2\t"quoted"',
    });
  });

  it("allows a comment after a quoted value", () => {
    expect(parseSecretsFile('TOKEN="abc#123" # keep the hash\n')).toEqual({ TOKEN: "abc#123" });
  });

  it("parses quoted values that contain spaces and '='", () => {
    expect(parseSecretsFile('DSN="postgres://user:pass@host/db?sslmode=disable"\n')).toEqual({
      DSN: "postgres://user:pass@host/db?sslmode=disable",
    });
  });

  it("accepts underscore and mixed-case names", () => {
    expect(parseSecretsFile("_PRIVATE=1\nMixed_Case_2=two\n")).toEqual({
      _PRIVATE: "1",
      Mixed_Case_2: "two",
    });
  });

  it.each(["1TOKEN=value", "BAD-NAME=value", "BAD NAME=value", "=value"])(
    "rejects the invalid variable name in %s with its line",
    (line) => {
      const error = captureEnvironmentError(`GOOD=value\n${line}\n`, "/tmp/secrets.env");

      expect(error.line).toBe(2);
      expect(error.code).toBe("INVALID_ENV_FILE");
      expect(error.details.line).toBe(2);
      expect(error.message).toContain("/tmp/secrets.env:2");
      expect(error.message).not.toContain(line.split("=")[1] ?? "no-value");
    },
  );

  it("rejects a line without '=' and reports only the line", () => {
    const error = captureEnvironmentError(`TOKEN=${SECRET_VALUE}\nJUST_A_NAME\n`);

    expect(error.line).toBe(2);
    expect(error.message).toContain("must be a KEY=VALUE line");
    expect(formatError(error)).not.toContain(SECRET_VALUE);
    expect(formatErrorJson(error)).not.toContain(SECRET_VALUE);
  });

  it("rejects an unterminated quote without echoing the value", () => {
    const error = captureEnvironmentError(`TOKEN="${SECRET_VALUE}\n`);

    expect(error.line).toBe(1);
    expect(error.message).toContain("unterminated quoted value");
    expect(error.message).not.toContain(SECRET_VALUE);
    expect(formatError(error)).not.toContain(SECRET_VALUE);
    expect(formatErrorJson(error)).not.toContain(SECRET_VALUE);
  });

  it("rejects text after a closing quote without echoing the value", () => {
    const error = captureEnvironmentError(`TOKEN="${SECRET_VALUE}" trailing\n`);

    expect(error.line).toBe(1);
    expect(error.message).toContain("unexpected text after the closing quote");
    expect(error.message).not.toContain(SECRET_VALUE);
  });

  it("rejects a NUL character without echoing the value", () => {
    const error = captureEnvironmentError(`TOKEN=abc\u0000${SECRET_VALUE}\n`);

    expect(error.line).toBe(1);
    expect(error.message).toContain("NUL");
    expect(error.message).not.toContain(SECRET_VALUE);
  });
});

describe("REG-FR-06 environment merge order", () => {
  it("applies secrets-file values over inline values on duplicate keys", () => {
    expect(mergeEnvironment({ SHARED: "inline", INLINE_ONLY: "a" }, { SHARED: "file" })).toEqual({
      SHARED: "file",
      INLINE_ONLY: "a",
    });
  });
});

describe("REG-FR-06 loadEnvironment", () => {
  it("merges inline [env] with the default secrets.env and lets the file win", () => {
    const appDir = makeAppDirectory();
    writeSecrets(appDir, "SHARED=from-file\nSECRET_ONLY=hidden\n");

    const environment = loadEnvironment(
      appDir,
      specWith({ SHARED: "from-inline", INLINE_ONLY: "visible" }),
    );

    expect(environment.values).toEqual({
      SHARED: "from-file",
      INLINE_ONLY: "visible",
      SECRET_ONLY: "hidden",
    });
    expect(environment.names).toEqual(["INLINE_ONLY", "SECRET_ONLY", "SHARED"]);
    expect(environment.file).toBe(path.join(appDir, DEFAULT_SECRETS_FILE));
  });

  it("returns only inline values when the optional default file is absent", () => {
    const appDir = makeAppDirectory();

    const environment = loadEnvironment(appDir, specWith({ INLINE_ONLY: "visible" }));

    expect(environment.values).toEqual({ INLINE_ONLY: "visible" });
    expect(environment.file).toBeUndefined();
  });

  it("reads the app-relative file declared by env_file", () => {
    const appDir = makeAppDirectory();
    writeFileSync(path.join(appDir, "runtime.env"), "FROM_DECLARED=yes\n");
    writeSecrets(appDir, "FROM_DEFAULT=ignored\n");

    const environment = loadEnvironment(appDir, specWith({}, "runtime.env"));

    expect(environment.values).toEqual({ FROM_DECLARED: "yes" });
    expect(environment.file).toBe(path.join(appDir, "runtime.env"));
  });

  it("merges a parsed config.toml env table with its declared env_file", () => {
    const appDir = makeAppDirectory();
    writeFileSync(path.join(appDir, "runtime.env"), `SHARED=from-file\nTOKEN=${SECRET_VALUE}\n`);

    const spec = parseConfigToml(
      [
        'repo = "https://github.com/example/demo.git"',
        "port = 8080",
        'env_file = "runtime.env"',
        "",
        "[env]",
        'SHARED = "from-inline"',
        'PLAIN = "yes"',
        "",
      ].join("\n"),
    );
    const environment = loadEnvironment(appDir, spec);

    expect(environment.values).toEqual({
      SHARED: "from-file",
      PLAIN: "yes",
      TOKEN: SECRET_VALUE,
    });
    expect(JSON.stringify(environment.redacted)).not.toContain(SECRET_VALUE);
  });

  it("treats a declared but missing secrets file as a usage error", () => {
    const appDir = makeAppDirectory();
    const error = captureError(() => loadEnvironment(appDir, specWith({}, "missing.env")));

    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("SECRETS_FILE_MISSING");
    expect(toExitCode(error)).toBe(1);
    expect((error as UsageError).details.file).toBe(path.join(appDir, "missing.env"));
  });

  it("rejects an env_file that escapes the app directory", () => {
    const appDir = makeAppDirectory();
    const error = captureError(() => loadEnvironment(appDir, specWith({}, "../outside.env")));

    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("INVALID_ENV_FILE");
    expect(toExitCode(error)).toBe(1);
    expect((error as UsageError).details.setting).toBe("env_file");
  });

  it("reports an unreadable secrets file as a prerequisite error without the value", () => {
    const appDir = makeAppDirectory();
    const error = captureError(() =>
      loadEnvironment(appDir, specWith({}), {
        read: () => {
          throw Object.assign(new Error(`EACCES: cannot read ${SECRET_VALUE}`), { code: "EACCES" });
        },
      }),
    );

    expect(toExitCode(error)).toBe(2);
    expect((error as UsageError).code).toBe("SECRETS_UNREADABLE");
    expect(formatError(error)).not.toContain(SECRET_VALUE);
  });
});

describe("REG-FR-06 redacted diagnostics view", () => {
  it("replaces every value and keeps every name", () => {
    const environment = { TOKEN: SECRET_VALUE, EMPTY: "", REGION: "eu-west" };

    expect(redactEnvironment(environment)).toEqual({
      TOKEN: REDACTED,
      EMPTY: REDACTED,
      REGION: REDACTED,
    });
  });

  it("never exposes a value from a loaded environment", () => {
    const appDir = makeAppDirectory();
    writeSecrets(appDir, `TOKEN=${SECRET_VALUE}\n`);

    const environment = loadEnvironment(appDir, specWith({ INLINE_SECRET: SECRET_VALUE }));

    const serialized = JSON.stringify(environment.redacted);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).toContain("[redacted]");
    expect(Object.values(environment.redacted)).toEqual([REDACTED, REDACTED]);
    expect(environment.names).toEqual(["INLINE_SECRET", "TOKEN"]);
  });

  it("keeps the secret out of a parse error rendered as text and JSON", () => {
    const error = captureEnvironmentError(`bad name=${SECRET_VALUE}\n`, "secrets.env");

    for (const rendered of [formatError(error), formatErrorJson(error)]) {
      expect(rendered).not.toContain(SECRET_VALUE);
      expect(rendered).toContain("secrets.env:1");
    }
  });
});
