/**
 * Frozen JSON contract coverage (`OBS-1.1`, `OBS-FR-01`, `OBS-NF-01`,
 * `OBS-NF-02`).
 *
 * Every read-only command is driven through its real handler against a
 * temporary state root, with only the container runtime and doctor host
 * processes stubbed. That proves the documents are produced by the production
 * composition, not by a test-only serializer, and that the registry and state
 * cache are genuinely read.
 *
 * The suite asserts the exact top-level shape of each document, that empty
 * arrays survive, that timestamps are ISO 8601 UTC, that stdout carries
 * exactly one document with no ANSI escapes, and that a planted secret value
 * never appears.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfigCommand } from "../../src/cli/commands/config.js";
import { runDoctorCommand } from "../../src/cli/commands/doctor.js";
import { runListCommand } from "../../src/cli/commands/list.js";
import type { ReadRuntime } from "../../src/cli/commands/read-model.js";
import { runStatusCommand } from "../../src/cli/commands/status.js";
import { EXIT_CODES, NotFoundError } from "../../src/cli/errors.js";
import {
  redactedSpec,
  serializeJson,
  toConfigDocument,
  toDoctorDocument,
  toIsoUtc,
  toListDocument,
  toStatusDocument,
  toVersionDocument,
  writeJsonDocument,
} from "../../src/cli/json.js";
import { runCli } from "../../src/cli/program.js";
import { JSON_SCHEMA_VERSION, type VersionDocument } from "../../src/cli/schemas.js";
import { validateAppSpec } from "../../src/config/parse.js";
import type { AppSpecInput } from "../../src/config/schema.js";
import type { DoctorCheck, ProcessRunner, ProcessRunResult } from "../../src/doctor/checks.js";
import type { DoctorOptions, DoctorReport } from "../../src/doctor/index.js";
import { createPaths } from "../../src/platform/paths.js";
import type {
  ContainerInspect,
  ContainerPortBinding,
  ContainerProcessState,
  ContainerVolumeMount,
} from "../../src/platform/podman.js";
import { RAILPACK_VERSION } from "../../src/platform/versions.js";
import { StateStore } from "../../src/registry/state.js";
import { type AppRecord, Registry } from "../../src/registry/store.js";

const FIXED_TIME = new Date("2026-10-30T12:00:00.000Z");
const FIXED_ISO = FIXED_TIME.toISOString();
const CURRENT_IMAGE = "localhost/easy-host-blog:20261030T120000Z";
const PREVIOUS_IMAGE = "localhost/easy-host-blog:20261029T090000Z";
const SECRET_VALUE = "do-not-print-me-please";
const ANSI_ESCAPE = "\u001B[";
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const GIB = 1024 ** 3;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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

/** A report with no disk facts; individual tests only care about another check. */
function emptyDiskUsage() {
  return {
    freeBytes: null,
    totalBytes: null,
    appImages: [],
    imagesTotalBytes: null,
    buildkitCacheBytes: null,
    workspaces: [],
    workspaceTotalBytes: null,
    toolsBytes: null,
    approximate: true as const,
  };
}

interface Fixture {
  readonly root: string;
  readonly appsDir: string;
  readonly registry: Registry;
  readonly environment: NodeJS.ProcessEnv;
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "easy-host-json-"));
  roots.push(root);

  const environment: NodeJS.ProcessEnv = {
    EASY_HOST_HOME: root,
    NO_COLOR: "1",
  };
  const paths = createPaths({ env: environment });
  paths.ensureLayout();

  return {
    root,
    appsDir: paths.appsDir,
    registry: new Registry(paths.appsDir),
    environment,
  };
}

function addConfiguredApp(
  fixture: Fixture,
  name: string,
  port: number,
  overrides: Partial<AppSpecInput> = {},
): { record: AppRecord; spec: ReturnType<typeof validateAppSpec> } {
  const spec = validateAppSpec({
    repo: `https://example.com/${name}.git`,
    port,
    ...overrides,
  });
  const record = fixture.registry.create(name);
  fixture.registry.writeConfig(name, spec);

  return { record, spec };
}

function writeHealthyState(
  record: AppRecord,
  options: {
    readonly detail?: string;
    readonly current?: string;
    readonly previous?: string | null;
  } = {},
): void {
  const store = new StateStore(record.directory, { clock: () => FIXED_TIME });
  store.update({
    images: {
      current: options.current ?? CURRENT_IMAGE,
      previous: options.previous ?? PREVIOUS_IMAGE,
    },
    containerId: `container-${record.name}`,
    health: {
      status: "healthy",
      checkedAt: FIXED_ISO,
      detail: options.detail ?? "probe http://127.0.0.1:8080/ healthy after 1 attempt(s)",
    },
  });
}

function runningContainer(
  app: string,
  overrides: {
    readonly ports?: readonly ContainerPortBinding[];
    readonly volumes?: readonly ContainerVolumeMount[];
  } = {},
): ContainerInspect {
  const state: ContainerProcessState = {
    status: "running",
    running: true,
    paused: false,
    exitCode: 0,
    startedAt: FIXED_ISO,
  };

  return {
    app,
    name: `easy-host-${app}`,
    id: `container-${app}-0123456789abcdef`,
    image: CURRENT_IMAGE,
    state,
    restartPolicy: "always",
    labels: { "io.easy-host.app": app, "io.easy-host.role": "app" },
    ports: overrides.ports ?? [
      { containerPort: 3000, protocol: "tcp", hostIp: "0.0.0.0", hostPort: 8080 },
    ],
    environmentNames: ["PORT"],
    volumes: overrides.volumes ?? [],
  };
}

class FixtureRuntime implements ReadRuntime {
  readonly containers = new Map<string, ContainerInspect | Error>();

  async inspectContainer(options: { readonly app: string }): Promise<ContainerInspect> {
    const candidate = this.containers.get(options.app);

    if (candidate === undefined) {
      throw new NotFoundError(`container "easy-host-${options.app}" does not exist`, {
        code: "CONTAINER_NOT_FOUND",
        details: { app: options.app },
      });
    }
    if (candidate instanceof Error) {
      throw candidate;
    }

    return candidate;
  }
}

/**
 * Parses exactly one newline-terminated document and asserts neither a second
 * document nor a repeated header slipped into the stream.
 */
function parseSingleDocument(stream: RecordingStream): Record<string, unknown> {
  const output = stream.text;

  expect(output.endsWith("\n")).toBe(true);
  expect(output.slice(0, -1).endsWith("\n")).toBe(false);
  expect(output.split('"schemaVersion"')).toHaveLength(2);
  expect(output).not.toContain(ANSI_ESCAPE);

  return JSON.parse(output) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Serializer-level contract
// ---------------------------------------------------------------------------

describe("json serializers", () => {
  it("normalises timestamps to ISO 8601 UTC and refuses invalid values", () => {
    expect(toIsoUtc(FIXED_ISO)).toBe("2026-10-30T12:00:00.000Z");
    expect(toIsoUtc(FIXED_TIME)).toBe("2026-10-30T12:00:00.000Z");
    expect(toIsoUtc("2026-10-30T14:00:00+02:00")).toBe("2026-10-30T12:00:00.000Z");
    for (const value of [undefined, null, "", "not-a-date", "2026-13-45T99:99:99Z"]) {
      expect(toIsoUtc(value), String(value)).toBeNull();
    }
  });

  it("publishes the version document with the exact documented shape", () => {
    const document: VersionDocument = toVersionDocument("1.2.3");

    expect(document).toEqual({
      schemaVersion: JSON_SCHEMA_VERSION,
      name: "easy-host",
      version: "1.2.3",
    });
    expect(Object.keys(document)).toEqual(["schemaVersion", "name", "version"]);
  });

  it("wires version --json through the CLI to the shared serializer", async () => {
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runCli(["version", "--json"], { stdout, stderr, env: {} });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stderr.text).toBe("");

    const document = parseSingleDocument(stdout);
    expect(Object.keys(document)).toEqual(["schemaVersion", "name", "version"]);
    expect(document.schemaVersion).toBe(1);
    expect(document.name).toBe("easy-host");
    expect(String(document.version)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("keeps empty arrays present and serializes exactly one document", () => {
    const list = toListDocument([]);
    const status = toStatusDocument([]);

    expect(list).toEqual({ schemaVersion: 1, apps: [] });
    expect(status).toEqual({ schemaVersion: 1, apps: [] });
    expect(
      toDoctorDocument({
        status: "pass",
        checks: [],
        durationMs: 0,
        disk: emptyDiskUsage(),
      }).checks,
    ).toEqual([]);

    const stream = new RecordingStream();
    writeJsonDocument(stream, list);

    expect(stream.text).toBe(serializeJson(list));
    expect(stream.text.endsWith("\n")).toBe(true);
    expect(stream.text.slice(0, -1).endsWith("\n")).toBe(false);
  });

  it("strips ANSI escapes and redacts every [env] value", () => {
    const spec = validateAppSpec({
      repo: "https://example.com/app.git",
      port: 8080,
      env: { SESSION_SECRET: SECRET_VALUE, API_TOKEN: "another-secret" },
    });
    const projected = redactedSpec(spec);

    expect(projected.env).toEqual({
      API_TOKEN: "[redacted]",
      SESSION_SECRET: "[redacted]",
    });
    expect(JSON.stringify(projected)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(projected)).not.toContain("another-secret");

    const report: DoctorReport = {
      status: "warn",
      durationMs: 1,
      disk: emptyDiskUsage(),
      checks: [
        {
          id: "podman",
          label: "Podman",
          status: "warn",
          detail: `${ANSI_ESCAPE}31mpodman is old${ANSI_ESCAPE}0m`,
          remediation: null,
        },
      ],
    };

    const document = toDoctorDocument(report);
    expect(document.checks[0]?.detail).toBe("podman is old");
    expect(JSON.stringify(document)).not.toContain(ANSI_ESCAPE);
  });
});

// ---------------------------------------------------------------------------
// list --json
// ---------------------------------------------------------------------------

describe("list --json", () => {
  it("emits one schemaVersion 1 document with the exact top-level shape", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080, {
      env: { SESSION_SECRET: SECRET_VALUE },
    });
    writeHealthyState(blog.record);

    const runtime = new FixtureRuntime();
    runtime.containers.set("blog", runningContainer("blog"));

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runListCommand({
      environment: fixture.environment,
      runtime,
      stdout,
      stderr,
      json: true,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stderr.text).toBe("");

    const document = parseSingleDocument(stdout);
    expect(Object.keys(document)).toEqual(["schemaVersion", "apps"]);
    expect(document.schemaVersion).toBe(1);

    const apps = document.apps as Array<Record<string, unknown>>;
    expect(Array.isArray(apps)).toBe(true);
    expect(apps).toHaveLength(1);

    const app = apps[0];
    expect(app).toBeDefined();
    expect(Object.keys(app ?? {})).toEqual([
      "name",
      "status",
      "port",
      "ref",
      "updatedAt",
      "image",
      "currentImage",
      "previousImage",
      "containerId",
      "drift",
      "error",
    ]);
    expect(app?.name).toBe("blog");
    expect(app?.status).toBe("healthy");
    expect(app?.port).toBe(8080);
    expect(typeof app?.port).toBe("number");
    expect(app?.ref).toBe("main");
    expect(app?.updatedAt).toBe(FIXED_ISO);
    expect(String(app?.updatedAt)).toMatch(ISO_UTC);
    expect(app?.currentImage).toBe(CURRENT_IMAGE);
    expect(app?.previousImage).toBe(PREVIOUS_IMAGE);
    expect(app?.containerId).toBe("container-blog-0123456789abcdef");
    expect(app?.error).toBeNull();

    const drift = app?.drift as Record<string, unknown>;
    expect(drift.class).toBe("none");
    expect(drift.drifted).toBe(false);
    expect(drift.statePresent).toBe(true);

    expect(stdout.text).not.toContain(SECRET_VALUE);
  });

  it("keeps apps empty rather than omitted for an empty registry", async () => {
    const fixture = createFixture();
    const stdout = new RecordingStream();

    const code = await runListCommand({
      environment: fixture.environment,
      runtime: new FixtureRuntime(),
      stdout,
      stderr: new RecordingStream(),
      json: true,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(parseSingleDocument(stdout)).toEqual({ schemaVersion: 1, apps: [] });
  });

  it("includes a broken app with its error object and null fields", async () => {
    const fixture = createFixture();
    mkdirSync(path.join(fixture.appsDir, "broken"), { recursive: true });

    const stdout = new RecordingStream();
    const code = await runListCommand({
      environment: fixture.environment,
      runtime: new FixtureRuntime(),
      stdout,
      stderr: new RecordingStream(),
      json: true,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    const apps = parseSingleDocument(stdout).apps as Array<Record<string, unknown>>;

    expect(apps).toHaveLength(1);
    const app = apps[0];
    expect(app?.status).toBe("broken");
    expect(app?.port).toBeNull();
    expect(app?.updatedAt).toBeNull();
    const error = app?.error as { code?: string } | null | undefined;
    expect(error?.code).toBe("MISSING_CONFIG");
  });
});

// ---------------------------------------------------------------------------
// status --json
// ---------------------------------------------------------------------------

describe("status --json", () => {
  it("emits the exact per-app shape with ISO timestamps and redacted secrets", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080, {
      env: { SESSION_SECRET: SECRET_VALUE },
      volumes: { data: "/var/lib/data" },
    });
    writeHealthyState(blog.record, {
      detail: `${ANSI_ESCAPE}31mprobe failed once${ANSI_ESCAPE}0m then healthy`,
    });

    const runtime = new FixtureRuntime();
    runtime.containers.set(
      "blog",
      runningContainer("blog", {
        volumes: [{ name: "easy-host-blog-data", destination: "/var/lib/data" }],
      }),
    );

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runStatusCommand({
      app: "blog",
      environment: fixture.environment,
      runtime,
      stdout,
      stderr,
      json: true,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stderr.text).toBe("");

    const document = parseSingleDocument(stdout);
    expect(Object.keys(document)).toEqual(["schemaVersion", "apps"]);
    expect(document.schemaVersion).toBe(1);

    const app = (document.apps as Array<Record<string, unknown>>)[0];
    expect(Object.keys(app ?? {})).toEqual([
      "name",
      "status",
      "configPath",
      "directory",
      "spec",
      "source",
      "images",
      "container",
      "health",
      "updatedAt",
      "drift",
      "error",
    ]);

    expect(app?.name).toBe("blog");
    expect(app?.status).toBe("healthy");
    expect(app?.configPath).toBe(blog.record.configPath);
    expect(app?.directory).toBe(blog.record.directory);

    const spec = app?.spec as Record<string, unknown>;
    expect((spec.env as Record<string, string>).SESSION_SECRET).toBe("[redacted]");
    expect(spec.port).toBe(8080);
    expect(typeof spec.port).toBe("number");

    expect(app?.source).toEqual({
      kind: "git",
      repo: "https://example.com/blog.git",
      ref: "main",
    });
    expect(app?.images).toEqual({
      current: CURRENT_IMAGE,
      previous: PREVIOUS_IMAGE,
    });

    const container = app?.container as Record<string, unknown>;
    expect(container.running).toBe(true);
    expect(typeof container.running).toBe("boolean");
    expect(container.startedAt).toBe(FIXED_ISO);
    expect(String(container.startedAt)).toMatch(ISO_UTC);
    expect(container.ports).toEqual(["0.0.0.0:8080->3000/tcp"]);
    expect(container.volumes).toEqual(["easy-host-blog-data:/var/lib/data"]);

    const health = app?.health as Record<string, unknown>;
    expect(health.status).toBe("healthy");
    expect(health.checkedAt).toBe(FIXED_ISO);
    expect(String(health.checkedAt)).toMatch(ISO_UTC);
    expect(health.detail).toBe("probe failed once then healthy");

    expect(app?.updatedAt).toBe(FIXED_ISO);
    expect(String(app?.updatedAt)).toMatch(ISO_UTC);
    expect(app?.error).toBeNull();

    const drift = app?.drift as Record<string, unknown>;
    expect(drift.class).toBe("none");
    expect(drift.drifted).toBe(false);
    expect(drift.recommendedAction).toMatchObject({ kind: "no-op", command: null });

    expect(stdout.text).not.toContain(SECRET_VALUE);
  });

  it("keeps ports and volumes as empty arrays when there are none", async () => {
    const fixture = createFixture();
    const api = addConfiguredApp(fixture, "api", 8081);
    writeHealthyState(api.record);

    const runtime = new FixtureRuntime();
    runtime.containers.set("api", runningContainer("api", { ports: [], volumes: [] }));

    const stdout = new RecordingStream();
    await runStatusCommand({
      app: "api",
      environment: fixture.environment,
      runtime,
      stdout,
      stderr: new RecordingStream(),
      json: true,
    });

    const app = (parseSingleDocument(stdout).apps as Array<Record<string, unknown>>)[0];
    const container = app?.container as Record<string, unknown>;

    expect(container.ports).toEqual([]);
    expect(container.volumes).toEqual([]);
  });

  it("keeps apps empty rather than omitted for an empty registry", async () => {
    const fixture = createFixture();
    const stdout = new RecordingStream();

    const code = await runStatusCommand({
      environment: fixture.environment,
      runtime: new FixtureRuntime(),
      stdout,
      stderr: new RecordingStream(),
      json: true,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(parseSingleDocument(stdout)).toEqual({ schemaVersion: 1, apps: [] });
  });

  it("reports a missing container as null with a health record, not an omission", async () => {
    const fixture = createFixture();
    addConfiguredApp(fixture, "api", 8081);

    const stdout = new RecordingStream();
    const code = await runStatusCommand({
      app: "api",
      environment: fixture.environment,
      runtime: new FixtureRuntime(),
      stdout,
      stderr: new RecordingStream(),
      json: true,
    });

    expect(code).toBe(EXIT_CODES.HEALTH);
    const app = (parseSingleDocument(stdout).apps as Array<Record<string, unknown>>)[0];

    expect(app?.status).toBe("missing");
    expect(app?.container).toBeNull();
    expect(app?.health).toEqual({ status: "unknown", checkedAt: null, detail: null });
  });
});

// ---------------------------------------------------------------------------
// config --json
// ---------------------------------------------------------------------------

describe("config --json", () => {
  it("emits the exact document with every [env] value redacted", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080, {
      env: { SESSION_SECRET: SECRET_VALUE },
    });

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runConfigCommand({
      app: "blog",
      environment: fixture.environment,
      stdout,
      stderr,
      json: true,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stderr.text).toBe("");

    const document = parseSingleDocument(stdout);
    expect(Object.keys(document)).toEqual(["schemaVersion", "app", "path", "valid", "config"]);
    expect(document.schemaVersion).toBe(1);
    expect(document.app).toBe("blog");
    expect(document.path).toBe(blog.record.configPath);
    expect(document.valid).toBe(true);

    const config = document.config as Record<string, unknown>;
    expect(config.port).toBe(8080);
    expect(typeof config.port).toBe("number");
    expect((config.env as Record<string, string>).SESSION_SECRET).toBe("[redacted]");
    expect(stdout.text).not.toContain(SECRET_VALUE);
  });

  it("serializes the same shape directly through toConfigDocument", () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080, {
      env: { SESSION_SECRET: SECRET_VALUE },
    });

    const document = toConfigDocument(blog.record, blog.spec);
    expect(Object.keys(document)).toEqual(["schemaVersion", "app", "path", "valid", "config"]);
    expect(document.config.env).toEqual({ SESSION_SECRET: "[redacted]" });
  });
});

// ---------------------------------------------------------------------------
// doctor --json
// ---------------------------------------------------------------------------

class DoctorRunner implements ProcessRunner {
  run(command: string, args: readonly string[]): ProcessRunResult {
    if (command === "podman" && args[0] === "--version") {
      return { exitCode: 0, stdout: "podman version 5.7.0\n", stderr: "" };
    }
    if (command === "podman" && args[0] === "info") {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    if (command === "docker" && args[0] === "--version") {
      return { exitCode: 0, stdout: "Emulate Docker CLI using podman.\n", stderr: "" };
    }

    if (command === "loginctl") {
      return { exitCode: 0, stdout: "Linger=yes\n", stderr: "" };
    }
    if (command === "systemctl" && args[1] === "is-enabled") {
      return { exitCode: 0, stdout: "enabled\n", stderr: "" };
    }
    if (command === "git" && args[0] === "--version") {
      return { exitCode: 0, stdout: "git version 2.43.0\n", stderr: "" };
    }
    if (command.endsWith("railpack") && args[0] === "--version") {
      return { exitCode: 0, stdout: `railpack ${RAILPACK_VERSION}\n`, stderr: "" };
    }

    return { exitCode: 1, stdout: "", stderr: `unexpected call: ${command}` };
  }
}

function createDoctorFixture(): {
  root: string;
  railpackPath: string;
  options: DoctorOptions;
} {
  const root = mkdtempSync(path.join(tmpdir(), "easy-host-json-doctor-"));
  roots.push(root);
  const railpackPath = path.join(root, "railpack");
  writeFileSync(railpackPath, `#!/bin/sh\nprintf 'railpack ${RAILPACK_VERSION}\\n'\n`, {
    mode: 0o755,
  });
  chmodSync(railpackPath, 0o755);

  return {
    root,
    railpackPath,
    options: {
      env: { EASY_HOST_HOME: root },
      runner: new DoctorRunner(),
      username: "alice",
      osRelease: { id: "fedora", name: "Fedora Linux 42" },
      nodeVersion: "v24.0.0",
      diskPath: root,
      readDiskSpace: () => ({ freeBytes: 42 * GIB, totalBytes: 200 * GIB }),
      toolsDir: root,
      buildkitDir: path.join(root, "buildkit"),
      railpackPath,
      cwd: root,
      homeDir: root,
      probeBuildkit: () => true,
      now: () => 0,
    },
  };
}

describe("doctor --json", () => {
  it("emits the exact document with a checks array and stable check fields", () => {
    const fixture = createDoctorFixture();
    const stdout = new RecordingStream();
    const code = runDoctorCommand({ ...fixture.options, json: true, stdout });

    expect(code).toBe(EXIT_CODES.SUCCESS);

    const document = parseSingleDocument(stdout);
    expect(Object.keys(document)).toEqual(["schemaVersion", "status", "checks", "disk"]);
    expect(document.schemaVersion).toBe(1);
    expect(document.status).toBe("pass");

    const disk = document.disk as Record<string, unknown>;
    expect(Object.keys(disk)).toEqual([
      "freeBytes",
      "totalBytes",
      "appImages",
      "imagesTotalBytes",
      "buildkitCacheBytes",
      "workspaces",
      "workspaceTotalBytes",
      "toolsBytes",
      "approximate",
    ]);
    expect(disk.approximate).toBe(true);
    expect(disk.appImages).toEqual([]);
    expect(disk.workspaces).toEqual([]);

    const checks = document.checks as Array<Record<string, unknown>>;
    expect(checks).toHaveLength(10);

    for (const check of checks) {
      expect(Object.keys(check)).toEqual(["id", "status", "detail", "remediation"]);
      expect(typeof check.status).toBe("string");
      expect(typeof check.detail).toBe("string");
      expect(check.remediation).toBeNull();
    }

    expect(checks.map((check) => check.id)).toEqual([
      "podman",
      "podman-rootless",
      "docker-loader",
      "linger",
      "boot-restart",
      "git",
      "node",
      "railpack",
      "buildkit",
      "disk",
    ]);
  });

  it("keeps a failing report as one document with a non-empty checks array", () => {
    const fixture = createDoctorFixture();
    const failingRunner: ProcessRunner = {
      run: () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
    };
    const failing: DoctorOptions = {
      ...fixture.options,
      runner: failingRunner,
      probeBuildkit: () => false,
    };

    const stdout = new RecordingStream();
    const code = runDoctorCommand({ ...failing, json: true, stdout });

    expect(code).toBe(EXIT_CODES.PREREQUISITE);
    const document = parseSingleDocument(stdout);
    expect(document.status).toBe("fail");
    expect((document.checks as DoctorCheck[]).length).toBeGreaterThan(0);
    expect(stdout.text).not.toContain(ANSI_ESCAPE);
  });
});

// ---------------------------------------------------------------------------
// Cross-command guarantees
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Program wiring
// ---------------------------------------------------------------------------

describe("program wiring", () => {
  it("reaches the list document through runCli with --json", async () => {
    const fixture = createFixture();
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();

    const code = await runCli(["list", "--json"], {
      stdout,
      stderr,
      env: fixture.environment,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stderr.text).toBe("");
    expect(parseSingleDocument(stdout)).toEqual({ schemaVersion: 1, apps: [] });
  });

  it("reaches the status document through runCli with --json", async () => {
    const fixture = createFixture();
    const stdout = new RecordingStream();

    const code = await runCli(["status", "--json"], {
      stdout,
      stderr: new RecordingStream(),
      env: fixture.environment,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(parseSingleDocument(stdout)).toEqual({ schemaVersion: 1, apps: [] });
  });

  it("reaches the config document through runCli with --json", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080, {
      env: { SESSION_SECRET: SECRET_VALUE },
    });
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();

    const code = await runCli(["config", "blog", "--json"], {
      stdout,
      stderr,
      env: fixture.environment,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stderr.text).toBe("");

    const document = parseSingleDocument(stdout);
    expect(Object.keys(document)).toEqual(["schemaVersion", "app", "path", "valid", "config"]);
    expect(document.app).toBe("blog");
    expect(document.path).toBe(blog.record.configPath);
    expect((document.config as { env: Record<string, string> }).env).toEqual({
      SESSION_SECRET: "[redacted]",
    });
    expect(stdout.text).not.toContain(SECRET_VALUE);
  });
});

describe("machine-readable output guarantees", () => {
  it("writes JSON to stdout only and keeps human narration on stderr", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080);
    writeHealthyState(blog.record);

    const runtime = new FixtureRuntime();
    runtime.containers.set("blog", runningContainer("blog"));

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runStatusCommand({
      app: "blog",
      environment: fixture.environment,
      runtime,
      stdout,
      stderr,
      json: true,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stderr.text).toBe("");
    expect(() => JSON.parse(stdout.text)).not.toThrow();
    expect(stdout.text).not.toContain("app:");
    expect(stdout.text).not.toContain("NAME");
  });

  it("never emits a secret, ANSI escape, or table into a JSON document", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080, {
      env: { SESSION_SECRET: SECRET_VALUE },
    });
    writeHealthyState(blog.record, {
      detail: `${ANSI_ESCAPE}32mok${ANSI_ESCAPE}0m`,
    });

    const runtime = new FixtureRuntime();
    runtime.containers.set("blog", runningContainer("blog"));

    const outputs: string[] = [];

    const listOut = new RecordingStream();
    await runListCommand({
      environment: fixture.environment,
      runtime,
      stdout: listOut,
      stderr: new RecordingStream(),
      json: true,
    });
    outputs.push(listOut.text);

    const statusOut = new RecordingStream();
    await runStatusCommand({
      environment: fixture.environment,
      runtime,
      stdout: statusOut,
      stderr: new RecordingStream(),
      json: true,
    });
    outputs.push(statusOut.text);

    const configOut = new RecordingStream();
    await runConfigCommand({
      app: "blog",
      environment: fixture.environment,
      stdout: configOut,
      stderr: new RecordingStream(),
      json: true,
    });
    outputs.push(configOut.text);

    for (const output of outputs) {
      expect(output).not.toContain(SECRET_VALUE);
      expect(output).not.toContain(ANSI_ESCAPE);
      expect(() => JSON.parse(output)).not.toThrow();
      expect(output).not.toContain("NAME  ");
    }
  });
});
