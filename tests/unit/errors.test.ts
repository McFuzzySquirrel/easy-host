import { describe, expect, it } from "vitest";
import {
  BUG_REPORT_HINT,
  BuildError,
  ConflictError,
  EasyHostError,
  EXIT_CODES,
  formatError,
  formatErrorJson,
  HealthError,
  InternalError,
  isEasyHostError,
  isExitCode,
  NotFoundError,
  PrerequisiteError,
  REDACTED,
  redactDetails,
  redactText,
  reportError,
  runWithErrorHandling,
  toEasyHostError,
  toErrorDocument,
  toExitCode,
  UsageError,
} from "../../src/cli/errors.js";
import { InvalidAppNameError, StateRootError } from "../../src/platform/paths.js";

class RecordingStream {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }
}

const ANSI_ESCAPE = "\u001B[";

describe("exit-code taxonomy", () => {
  it("publishes the eight documented exit codes", () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      USAGE: 1,
      PREREQUISITE: 2,
      BUILD: 3,
      HEALTH: 4,
      NOT_FOUND: 5,
      CONFLICT: 6,
      INTERNAL: 7,
    });
  });

  it("maps each failure class to its documented exit code and default code", () => {
    const cases: ReadonlyArray<readonly [EasyHostError, number, string]> = [
      [new UsageError("invalid flag"), EXIT_CODES.USAGE, "USAGE_ERROR"],
      [new PrerequisiteError("podman missing"), EXIT_CODES.PREREQUISITE, "PREREQUISITE_FAILED"],
      [new BuildError("build failed"), EXIT_CODES.BUILD, "BUILD_FAILED"],
      [new HealthError("probe failed"), EXIT_CODES.HEALTH, "HEALTH_CHECK_FAILED"],
      [new NotFoundError("app missing"), EXIT_CODES.NOT_FOUND, "NOT_FOUND"],
      [new ConflictError("lock held"), EXIT_CODES.CONFLICT, "CONFLICT"],
      [new InternalError("unexpected"), EXIT_CODES.INTERNAL, "INTERNAL_ERROR"],
    ];

    for (const [error, exitCode, code] of cases) {
      expect(error).toBeInstanceOf(EasyHostError);
      expect(error).toBeInstanceOf(Error);
      expect(error.exitCode).toBe(exitCode);
      expect(error.code).toBe(code);
    }
  });

  it("recognises only the documented exit codes", () => {
    for (const code of Object.values(EXIT_CODES)) {
      expect(isExitCode(code)).toBe(true);
    }

    expect(isExitCode(8)).toBe(false);
    expect(isExitCode(-1)).toBe(false);
    expect(isExitCode("1")).toBe(false);
    expect(isExitCode(undefined)).toBe(false);
  });

  it("maps unknown exceptions to 7 and preserves the cause", () => {
    const cause = new Error("boom");
    const mapped = toEasyHostError(cause);

    expect(mapped).toBeInstanceOf(InternalError);
    expect(mapped.exitCode).toBe(EXIT_CODES.INTERNAL);
    expect(mapped.cause).toBe(cause);
    expect(toExitCode(cause)).toBe(EXIT_CODES.INTERNAL);
    expect(toExitCode("kaput")).toBe(EXIT_CODES.INTERNAL);
    expect(isEasyHostError(mapped)).toBe(true);
    expect(isEasyHostError(cause)).toBe(false);
  });

  it("adopts typed errors raised by other modules", () => {
    const stateRootError = new StateRootError(
      "/tmp/easy-host",
      "permission denied",
      "Set EASY_HOST_HOME to a writable directory.",
    );
    const appNameError = new InvalidAppNameError("../escape");

    expect(toExitCode(stateRootError)).toBe(EXIT_CODES.PREREQUISITE);
    expect(toExitCode(appNameError)).toBe(EXIT_CODES.USAGE);

    const rendered = formatError(stateRootError, { env: {} });
    expect(rendered).toContain(
      'easy-host: state root "/tmp/easy-host" is not writable: permission denied',
    );
    expect(rendered).toContain("next:     Set EASY_HOST_HOME to a writable directory.");
  });
});

describe("error construction", () => {
  it("keeps a one-line summary plus optional code, details, remediation, and cause", () => {
    const cause = new Error("railpack exited 1");
    const error = new BuildError('build failed\n  for "api"', {
      code: "RAILPACK_BUILD_FAILED",
      details: { step: "railpack build", exit: 1 },
      remediation: "easy-host logs api",
      cause,
    });

    expect(error.message).toBe('build failed for "api"');
    expect(error.name).toBe("BuildError");
    expect(error.code).toBe("RAILPACK_BUILD_FAILED");
    expect(error.details).toEqual({ step: "railpack build", exit: 1 });
    expect(error.remediation).toBe("easy-host logs api");
    expect(error.cause).toBe(cause);
  });

  it("gives internal errors a bug-report hint by default", () => {
    expect(new InternalError("unexpected").remediation).toBe(BUG_REPORT_HINT);
    expect(new InternalError("unexpected", { remediation: "run the tests" }).remediation).toBe(
      "run the tests",
    );
  });
});

describe("human rendering", () => {
  it("separates summary, details, and remediation lines using the PRD 12.3 shape", () => {
    const error = new HealthError('health check failed for "api"', {
      details: {
        probe: "GET http://127.0.0.1:8081/ (90s budget, 2s interval)",
        reason: "connection refused after 45 attempts",
        previous: "easy-host-api:20261028T090200Z is serving again",
      },
      remediation: "easy-host logs api --tail 200",
    });

    expect(formatError(error, { env: {} })).toBe(
      [
        'easy-host: health check failed for "api"',
        "  probe:    GET http://127.0.0.1:8081/ (90s budget, 2s interval)",
        "  reason:   connection refused after 45 attempts",
        "  previous: easy-host-api:20261028T090200Z is serving again",
        "  next:     easy-host logs api --tail 200",
      ].join("\n"),
    );
  });

  it("omits absent details and remediation lines", () => {
    const rendered = formatError(new NotFoundError('app "blog" not found'), { env: {} });

    expect(rendered).toBe('easy-host: app "blog" not found');
    expect(rendered).not.toContain("next:");
    expect(rendered).not.toContain(ANSI_ESCAPE);
  });

  it("renders multiline detail values on aligned continuation lines", () => {
    const rendered = formatError(
      new UsageError("invalid config", {
        details: { reason: "line one\nline two" },
      }),
      { env: {} },
    );

    expect(rendered).toBe(
      ["easy-host: invalid config", "  reason:   line one", "            line two"].join("\n"),
    );
  });

  it("strips ANSI escape sequences from messages and detail values", () => {
    const rendered = formatError(
      new BuildError("\u001B[31mbuild failed\u001B[0m", {
        details: { reason: "\u001B[1mno output\u001B[0m" },
      }),
      { env: {} },
    );

    expect(rendered).toBe("easy-host: build failed\n  reason:   no output");
  });

  it("renders primitive, array, and object detail values without dropping keys", () => {
    const rendered = formatError(
      new BuildError("build failed", {
        details: {
          attempt: 2,
          retryable: false,
          note: null,
          tags: ["railpack", "buildkit"],
          context: { exit: 1 },
        },
      }),
      { env: {} },
    );

    expect(rendered).toContain("  attempt:   2");
    expect(rendered).toContain("  retryable: false");
    expect(rendered).toContain("  note:      null");
    expect(rendered).toContain("  tags:      railpack, buildkit");
    expect(rendered).toContain('  context:   {"exit":1}');
  });
});

describe("secret redaction", () => {
  const error = new UsageError("config rejected", {
    details: {
      apiKey: "sk-live-123",
      clientSecret: "shh-very-secret",
      access_token: "tok-123",
      password: "hunter2",
      repo: "https://deploy:hunter3@example.com/app.git",
      nested: { webhookToken: "nested-token", label: "kept" },
      list: ["visible", { password: "list-pass" }],
      note: "link https://admin:hunter4@example.com/",
    },
  });

  it("redacts detail keys named secret, token, password, or key in human output", () => {
    const rendered = formatError(error, { env: {} });

    for (const secret of [
      "sk-live-123",
      "shh-very-secret",
      "tok-123",
      "hunter2",
      "hunter3",
      "nested-token",
      "list-pass",
      "hunter4",
    ]) {
      expect(rendered).not.toContain(secret);
    }

    expect(rendered).toContain(REDACTED);
    expect(rendered).toContain("https://[redacted]@example.com/app.git");
    expect(rendered).toContain('"label":"kept"');
    expect(rendered).toContain("kept");
    expect(rendered).toContain("visible");
  });

  it("redacts the same values in the JSON document", () => {
    const document = toErrorDocument(error, { env: {} });
    const details = document.error.details as Record<string, unknown>;

    expect(details.apiKey).toBe(REDACTED);
    expect(details.clientSecret).toBe(REDACTED);
    expect(details.access_token).toBe(REDACTED);
    expect(details.password).toBe(REDACTED);
    expect(details.repo).toBe("https://[redacted]@example.com/app.git");
    expect(details.nested).toEqual({ webhookToken: REDACTED, label: "kept" });
    expect(details.list).toEqual(["visible", { password: REDACTED }]);

    const serialized = JSON.stringify(document);
    for (const secret of ["sk-live-123", "shh-very-secret", "tok-123", "hunter2", "hunter3"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("redacts credentials embedded in the summary and remediation", () => {
    const credentialError = new PrerequisiteError(
      "cannot reach https://alice:swordfish@example.com/health",
      { remediation: "curl https://alice:swordfish@example.com/health" },
    );

    const rendered = formatError(credentialError, { env: {} });

    expect(rendered).not.toContain("alice");
    expect(rendered).not.toContain("swordfish");
    expect(rendered).toContain("https://[redacted]@example.com/health");
  });

  it("redacts caller-supplied secret values from every rendered field", () => {
    const secretError = new BuildError("failed with swordfish", {
      details: { reason: "swordfish was rejected" },
      remediation: "retry without swordfish",
    });
    const options = { env: {}, secrets: ["swordfish"] };

    const rendered = formatError(secretError, options);
    expect(rendered).not.toContain("swordfish");

    const serialized = JSON.stringify(toErrorDocument(secretError, options));
    expect(serialized).not.toContain("swordfish");
  });

  it("recursively redacts through nested details and free text", () => {
    expect(
      redactDetails({
        password: "p",
        nested: { Token: "t", safe: "s" },
        list: [{ clientSecret: "c" }],
      }),
    ).toEqual({
      password: REDACTED,
      nested: { Token: REDACTED, safe: "s" },
      list: [{ clientSecret: REDACTED }],
    });

    expect(redactText("see https://user:pass@example.com", [])).toBe(
      "see https://[redacted]@example.com",
    );
    expect(redactText("value one and value two", ["value one", "value two"])).toBe(
      `${REDACTED} and ${REDACTED}`,
    );
  });
});

describe("JSON rendering", () => {
  it("emits one schemaVersion 1 document with stable error fields", () => {
    const error = new ConflictError("port 8080 is already claimed", {
      code: "PORT_IN_USE",
      details: { port: 8080, app: "blog" },
    });

    const document = toErrorDocument(error, { env: {} });
    expect(document).toEqual({
      schemaVersion: 1,
      error: {
        code: "PORT_IN_USE",
        exitCode: 6,
        summary: "port 8080 is already claimed",
        details: { port: 8080, app: "blog" },
        remediation: null,
      },
    });

    const rendered = formatErrorJson(error, { env: {} });
    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered)).toEqual(document);
    expect(rendered).not.toContain(ANSI_ESCAPE);
  });

  it("always includes an empty details object", () => {
    const document = toErrorDocument(new NotFoundError('app "blog" not found'), { env: {} });

    expect(document.error.details).toEqual({});
    expect(document.error.remediation).toBeNull();
  });

  it("normalizes an empty remediation to null", () => {
    const document = toErrorDocument(new UsageError("bad flag", { remediation: "" }), { env: {} });

    expect(document.error.remediation).toBeNull();
  });
});

describe("unexpected exception rendering", () => {
  it("prints a short diagnostic and bug hint without a stack trace", () => {
    const rendered = formatError(new Error("boom"), { env: {} });

    expect(rendered).toContain("easy-host: unexpected error: boom");
    expect(rendered).toContain("EASY_HOST_DEBUG=1");
    expect(rendered).not.toMatch(/\n\s+at\s/);
    expect(rendered).not.toContain(ANSI_ESCAPE);
  });

  it("prints the stack only when EASY_HOST_DEBUG=1 is set", () => {
    const debug = formatError(new Error("boom"), { env: { EASY_HOST_DEBUG: "1" } });

    expect(debug).toMatch(/\n\s+at\s/);
  });

  it("maps a non-Error thrown value to exit 7", () => {
    const document = toErrorDocument("kaput", { env: {} });

    expect(document.error.exitCode).toBe(7);
    expect(document.error.code).toBe("INTERNAL_ERROR");
    expect(document.error.summary).toBe("unexpected error: kaput");
    expect(document.error.remediation).toBe(BUG_REPORT_HINT);
  });
});

describe("error reporting", () => {
  it("writes human output to stderr and returns the exit code", () => {
    const stderr = new RecordingStream();

    const exitCode = reportError(
      new ConflictError("lock held by another process", { remediation: "retry the update" }),
      { env: {}, stderr },
    );

    expect(exitCode).toBe(EXIT_CODES.CONFLICT);
    expect(stderr.text).toBe(
      "easy-host: lock held by another process\n  next:     retry the update\n",
    );
  });

  it("writes one JSON document to stdout and returns the exit code", () => {
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();

    const exitCode = reportError(new NotFoundError('app "blog" not found'), {
      env: {},
      json: true,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(EXIT_CODES.NOT_FOUND);
    expect(stderr.text).toBe("");
    expect(JSON.parse(stdout.text)).toMatchObject({
      schemaVersion: 1,
      error: { code: "NOT_FOUND", exitCode: 5, summary: 'app "blog" not found' },
    });
  });

  it("runs an action and maps a thrown value without leaking a stack", () => {
    const stderr = new RecordingStream();

    expect(runWithErrorHandling(() => 0)).toBe(0);
    expect(
      runWithErrorHandling(
        () => {
          throw new UsageError("missing --port");
        },
        { env: {}, stderr },
      ),
    ).toBe(EXIT_CODES.USAGE);

    expect(stderr.text).toContain("easy-host: missing --port");
    expect(stderr.text).not.toMatch(/\n\s+at\s/);
  });
});
