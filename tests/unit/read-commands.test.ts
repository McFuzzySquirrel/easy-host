/**
 * Read-command coverage (`ADD-1.5`, `ADD-FR-06`).
 *
 * The suite uses the real filesystem registry and state cache under a
 * temporary state root, and injects only the container runtime, editor, and
 * streams. That combination proves the commands read real `config.toml` and
 * `state.json` documents, never persist a rebuilt cache, and render stable
 * plain-text output with no Podman or network access.
 *
 * Scenarios mirror the task contract: a mixed registry, a missing app, a
 * stopped container, exact log flag forwarding, and config validation output.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type EditorInvocation,
  type EditorRunner,
  parseEditorCommand,
  runConfigCommand,
} from "../../src/cli/commands/config.js";
import { runListCommand } from "../../src/cli/commands/list.js";
import { type LogsRuntime, runLogsCommand } from "../../src/cli/commands/logs.js";
import type { ReadRuntime } from "../../src/cli/commands/read-model.js";
import { runStatusCommand } from "../../src/cli/commands/status.js";
import { EXIT_CODES, NotFoundError } from "../../src/cli/errors.js";
import { serializeConfig, validateAppSpec } from "../../src/config/parse.js";
import type { AppSpec, AppSpecInput } from "../../src/config/schema.js";
import { createPaths } from "../../src/platform/paths.js";
import {
  type ContainerInspect,
  type ContainerLogsOptions,
  type ContainerLogsResult,
  type ContainerPortBinding,
  type ContainerProcessState,
  type ContainerVolumeMount,
  containerLogs,
  type PodmanCommandResult,
  type PodmanRunner,
} from "../../src/platform/podman.js";
import { StateStore } from "../../src/registry/state.js";
import { type AppRecord, Registry } from "../../src/registry/store.js";

const FIXED_TIME = new Date("2026-10-30T12:00:00.000Z");
const FIXED_ISO = FIXED_TIME.toISOString();
const BLOG_IMAGE = "localhost/easy-host-blog:20261030T120000Z";
const PREVIOUS_IMAGE = "localhost/easy-host-blog:20261029T090000Z";

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

interface Fixture {
  readonly root: string;
  readonly appsDir: string;
  readonly registry: Registry;
  readonly environment: NodeJS.ProcessEnv;
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "easy-host-read-"));
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
): { record: AppRecord; spec: AppSpec } {
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
    readonly current?: string;
    readonly previous?: string | null;
    readonly health?: "healthy" | "unhealthy" | "unknown";
    readonly detail?: string;
  } = {},
): void {
  const store = new StateStore(record.directory, { clock: () => FIXED_TIME });
  store.update({
    images: {
      current: options.current ?? BLOG_IMAGE,
      previous: options.previous ?? null,
    },
    containerId: `container-${record.name}`,
    health: {
      status: options.health ?? "healthy",
      checkedAt: FIXED_ISO,
      detail: options.detail ?? "probe http://127.0.0.1:8080/ healthy after 1 attempt(s)",
    },
  });
}

class FixtureRuntime implements ReadRuntime {
  readonly inspected: string[] = [];
  readonly containers = new Map<string, ContainerInspect | Error>();

  async inspectContainer(options: { readonly app: string }): Promise<ContainerInspect> {
    this.inspected.push(options.app);

    const candidate = this.containers.get(options.app);
    if (candidate === undefined) {
      throw missingContainer(options.app);
    }
    if (candidate instanceof Error) {
      throw candidate;
    }

    return candidate;
  }
}

function missingContainer(app: string): NotFoundError {
  return new NotFoundError(`container "easy-host-${app}" does not exist`, {
    code: "CONTAINER_NOT_FOUND",
    details: { app, container: `easy-host-${app}` },
    remediation: "Run easy-host list to confirm the app is registered.",
  });
}

function runningContainer(
  app: string,
  overrides: {
    readonly ports?: readonly ContainerPortBinding[];
    readonly volumes?: readonly ContainerVolumeMount[];
    readonly image?: string;
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
    image: overrides.image ?? `localhost/easy-host-${app}:20261030T120000Z`,
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

function stoppedContainer(app: string): ContainerInspect {
  return {
    ...runningContainer(app),
    state: {
      status: "exited",
      running: false,
      paused: false,
      exitCode: 137,
      startedAt: FIXED_ISO,
      finishedAt: "2026-10-30T12:05:00.000Z",
    },
  };
}

function linesWithinWidth(text: string, width = 80): void {
  for (const line of text.split("\n")) {
    expect(line.length, JSON.stringify(line)).toBeLessThanOrEqual(width);
  }
}

function expectPlainText(text: string): void {
  expect(text).not.toContain("\u001B[");
}

describe("list", () => {
  it("shows every app, including broken, missing, and stopped entries", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080);
    addConfiguredApp(fixture, "api", 8081);
    addConfiguredApp(fixture, "worker", 8082);

    // A directory with no config.toml is a broken registry entry.
    mkdirSync(path.join(fixture.appsDir, "broken"), { recursive: true });
    writeHealthyState(blog.record);

    const runtime = new FixtureRuntime();
    runtime.containers.set("blog", runningContainer("blog"));
    // `api` is deliberately absent from the runtime map -> missing container.
    runtime.containers.set("worker", stoppedContainer("worker"));

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runListCommand({
      environment: fixture.environment,
      runtime,
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stderr.text).toBe("");

    const text = stdout.text;
    expect(text).toContain("NAME");
    expect(text).toContain("STATUS");
    expect(text).toContain("PORT");
    expect(text).toContain("REF");
    expect(text).toContain("UPDATED");
    expect(text).toContain("IMAGE");

    for (const name of ["api", "blog", "broken", "worker"]) {
      expect(text).toContain(name);
    }

    expect(text).toMatch(/blog\s+healthy/);
    expect(text).toMatch(/api\s+missing/);
    expect(text).toMatch(/worker\s+stopped/);
    expect(text).toMatch(/broken\s+broken/);
    expect(text).toContain("error:");
    expect(text).toContain("missing config.toml");
    // Last update comes from the cache, formatted as UTC YYYY-MM-DD HH:MM.
    expect(text).toContain("2026-10-30 12:00");

    expectPlainText(text);
    linesWithinWidth(text);

    // A broken directory is never handed to Podman.
    expect(runtime.inspected).not.toContain("broken");
    expect(runtime.inspected).toEqual(expect.arrayContaining(["api", "blog", "worker"]));
  });

  it("keeps the table within 80 columns for long names and refs", async () => {
    const fixture = createFixture();
    const longName = "a".repeat(32);
    addConfiguredApp(fixture, longName, 8080, {
      ref: "feature/a-very-long-branch-name-that-does-not-fit-in-the-table",
    });

    const runtime = new FixtureRuntime();
    runtime.containers.set(longName, runningContainer(longName));

    const stdout = new RecordingStream();
    const code = await runListCommand({
      environment: fixture.environment,
      runtime,
      stdout,
      stderr: new RecordingStream(),
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    linesWithinWidth(stdout.text);
    expectPlainText(stdout.text);
  });

  it("prints an explicit message when no apps are registered", async () => {
    const fixture = createFixture();
    const stdout = new RecordingStream();

    const code = await runListCommand({
      environment: fixture.environment,
      runtime: new FixtureRuntime(),
      stdout,
      stderr: new RecordingStream(),
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout.text).toBe("no apps\n");
  });

  it("emits one schemaVersion 1 document that includes broken apps", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080);
    writeHealthyState(blog.record);
    mkdirSync(path.join(fixture.appsDir, "broken"), { recursive: true });

    const runtime = new FixtureRuntime();
    runtime.containers.set("blog", runningContainer("blog"));

    const stdout = new RecordingStream();
    const code = await runListCommand({
      environment: fixture.environment,
      runtime,
      stdout,
      stderr: new RecordingStream(),
      json: true,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    const document = JSON.parse(stdout.text) as {
      schemaVersion: number;
      apps: Array<{ name: string; status: string; error: { code: string } | null }>;
    };

    expect(document.schemaVersion).toBe(1);
    expect(document.apps.map((app) => app.name)).toEqual(["blog", "broken"]);
    expect(document.apps[0]?.status).toBe("healthy");
    expect(document.apps[1]?.status).toBe("broken");
    expect(document.apps[1]?.error?.code).toBe("MISSING_CONFIG");
    expectPlainText(stdout.text);
  });
});

describe("status", () => {
  it("exits 5 for an unknown app", async () => {
    const fixture = createFixture();
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();

    const code = await runStatusCommand({
      app: "ghost",
      environment: fixture.environment,
      runtime: new FixtureRuntime(),
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_CODES.NOT_FOUND);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain('app "ghost" was not found');
    expectPlainText(stderr.text);
  });

  it("prints config, probe settings, image references, container state, and health", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080, {
      container_port: 4000,
      bind: "127.0.0.1",
      health_path: "/healthz",
      health_interval_ms: 1000,
      health_timeout_ms: 2500,
      health_startup_ms: 30000,
      volumes: { data: "/var/lib/data" },
    });
    writeHealthyState(blog.record, {
      current: BLOG_IMAGE,
      previous: PREVIOUS_IMAGE,
      detail: "probe http://127.0.0.1:8080/healthz healthy after 2 attempt(s)",
    });

    const runtime = new FixtureRuntime();
    runtime.containers.set(
      "blog",
      runningContainer("blog", {
        image: BLOG_IMAGE,
        ports: [{ containerPort: 4000, protocol: "tcp", hostIp: "127.0.0.1", hostPort: 8080 }],
        volumes: [{ name: "easy-host-blog-data", destination: "/var/lib/data" }],
      }),
    );

    const stdout = new RecordingStream();
    const code = await runStatusCommand({
      app: "blog",
      environment: fixture.environment,
      runtime,
      stdout,
      stderr: new RecordingStream(),
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    const text = stdout.text;

    expect(text).toContain("config:");
    expect(text).toContain(blog.record.configPath);
    expect(text).toContain("probe:");
    expect(text).toContain("http GET http://127.0.0.1:8080/healthz");
    expect(text).toContain("interval 1000ms");
    expect(text).toContain("timeout");
    expect(text).toContain("2500ms");
    expect(text).toContain("30000ms");
    expect(text).toContain("current");
    expect(text).toContain(BLOG_IMAGE);
    expect(text).toContain("previous");
    expect(text).toContain(PREVIOUS_IMAGE);
    expect(text).toContain("container");
    expect(text).toContain("easy-host-blog running");
    expect(text).toContain("restart");
    expect(text).toContain("always");
    expect(text).toContain("127.0.0.1:8080->4000/tcp");
    expect(text).toContain("easy-host-blog-data:/var/lib/data");
    expect(text).toContain("health");
    expect(text).toContain("healthy");
    expect(text).toContain("checked");
    expect(text).toContain("2026-10-30 12:00");
    expect(text).toContain("after 2 attempt(s)");
    expect(text).toContain("8080 -> 4000 on 127.0.0.1");

    expectPlainText(text);
    linesWithinWidth(text);
  });

  it("exits 4 and reports a stopped container", async () => {
    const fixture = createFixture();
    const worker = addConfiguredApp(fixture, "worker", 8082);
    writeHealthyState(worker.record);

    const runtime = new FixtureRuntime();
    runtime.containers.set("worker", stoppedContainer("worker"));

    const stdout = new RecordingStream();
    const code = await runStatusCommand({
      app: "worker",
      environment: fixture.environment,
      runtime,
      stdout,
      stderr: new RecordingStream(),
    });

    expect(code).toBe(EXIT_CODES.HEALTH);
    expect(stdout.text).toMatch(/status:\s+stopped/);
    expect(stdout.text).toMatch(/container:\s+easy-host-worker exited/);
    expect(stdout.text).toContain("exit 137");
  });

  it("exits 4 when the last recorded health is unhealthy", async () => {
    const fixture = createFixture();
    const api = addConfiguredApp(fixture, "api", 8081);
    writeHealthyState(api.record, {
      health: "unhealthy",
      detail: "probe http://127.0.0.1:8081/ failed: connection refused",
    });

    const runtime = new FixtureRuntime();
    runtime.containers.set("api", runningContainer("api"));

    const stdout = new RecordingStream();
    const code = await runStatusCommand({
      app: "api",
      environment: fixture.environment,
      runtime,
      stdout,
      stderr: new RecordingStream(),
    });

    expect(code).toBe(EXIT_CODES.HEALTH);
    expect(stdout.text).toMatch(/status:\s+unhealthy/);
    expect(stdout.text).toContain("connection refused");
  });

  it("reports a missing container without hiding the recorded config", async () => {
    const fixture = createFixture();
    addConfiguredApp(fixture, "api", 8081);

    const stdout = new RecordingStream();
    const code = await runStatusCommand({
      app: "api",
      environment: fixture.environment,
      runtime: new FixtureRuntime(),
      stdout,
      stderr: new RecordingStream(),
    });

    expect(code).toBe(EXIT_CODES.HEALTH);
    expect(stdout.text).toMatch(/status:\s+missing/);
    expect(stdout.text).toContain("easy-host-api missing");
    expect(stdout.text).toContain("config:");
  });

  it("reports every app, including a broken directory, when no app is named", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080);
    writeHealthyState(blog.record);
    mkdirSync(path.join(fixture.appsDir, "broken"), { recursive: true });

    const runtime = new FixtureRuntime();
    runtime.containers.set("blog", runningContainer("blog"));

    const stdout = new RecordingStream();
    const code = await runStatusCommand({
      environment: fixture.environment,
      runtime,
      stdout,
      stderr: new RecordingStream(),
    });

    expect(code).toBe(EXIT_CODES.HEALTH);
    expect(stdout.text).toMatch(/app:\s+blog/);
    expect(stdout.text).toMatch(/app:\s+broken/);
    expect(stdout.text).toContain("missing config.toml");
  });

  it("redacts [env] values in status --json", async () => {
    const fixture = createFixture();
    const api = addConfiguredApp(fixture, "api", 8081, {
      env: { API_TOKEN: "super-secret-token" },
    });
    writeHealthyState(api.record);

    const runtime = new FixtureRuntime();
    runtime.containers.set("api", runningContainer("api"));

    const stdout = new RecordingStream();
    const code = await runStatusCommand({
      app: "api",
      environment: fixture.environment,
      runtime,
      stdout,
      stderr: new RecordingStream(),
      json: true,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    const document = JSON.parse(stdout.text) as {
      schemaVersion: number;
      apps: Array<{
        name: string;
        status: string;
        configPath: string;
        spec: { env: Record<string, string> };
        health: { status: string };
        images: { current: string | null };
      }>;
    };

    expect(document.schemaVersion).toBe(1);
    expect(document.apps).toHaveLength(1);
    expect(document.apps[0]?.name).toBe("api");
    expect(document.apps[0]?.status).toBe("healthy");
    expect(document.apps[0]?.configPath).toBe(api.record.configPath);
    expect(document.apps[0]?.spec.env.API_TOKEN).toBe("[redacted]");
    expect(document.apps[0]?.images.current).toBe(BLOG_IMAGE);
    expect(stdout.text).not.toContain("super-secret-token");
    expectPlainText(stdout.text);
  });
});

describe("logs", () => {
  it("forwards -f and --tail exactly", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: PodmanRunner = {
      run(command, args): PodmanCommandResult {
        calls.push({ command, args: [...args] });
        return { exitCode: 0, stdout: "line one\n", stderr: "" };
      },
    };

    const runtime: LogsRuntime = {
      containerLogs: (options: ContainerLogsOptions) => containerLogs({ ...options, runner }),
    };

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runLogsCommand({
      app: "blog",
      follow: true,
      tail: "50",
      runtime,
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stdout.text).toBe("line one\n");
    expect(stderr.text).toBe("");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: "podman",
      args: ["logs", "-f", "--tail", "50", "easy-host-blog"],
    });
  });

  it("defaults to a 200-line tail without following", async () => {
    const received: ContainerLogsOptions[] = [];
    const runtime: LogsRuntime = {
      async containerLogs(options: ContainerLogsOptions): Promise<ContainerLogsResult> {
        received.push(options);
        return {
          app: options.app,
          container: `easy-host-${options.app}`,
          exitCode: 0,
          stdout: "",
          stderr: "",
          followed: options.follow === true,
          tail: options.tail ?? 200,
        };
      },
    };

    const code = await runLogsCommand({
      app: "blog",
      runtime,
      stdout: new RecordingStream(),
      stderr: new RecordingStream(),
    });

    expect(code).toBe(0);
    expect(received[0]?.follow).toBe(false);
    expect(received[0]?.tail).toBe(200);
  });

  it("returns Podman's exit code and passes both streams through", async () => {
    const runtime: LogsRuntime = {
      async containerLogs(options: ContainerLogsOptions): Promise<ContainerLogsResult> {
        return {
          app: options.app,
          container: `easy-host-${options.app}`,
          exitCode: 7,
          stdout: "standard output\n",
          stderr: "standard error\n",
          followed: true,
          tail: 10,
        };
      },
    };

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runLogsCommand({
      app: "blog",
      follow: true,
      tail: 10,
      runtime,
      stdout,
      stderr,
    });

    expect(code).toBe(7);
    expect(stdout.text).toBe("standard output\n");
    expect(stderr.text).toBe("standard error\n");
  });

  it("rejects an invalid --tail before calling Podman", async () => {
    let called = false;
    const runtime: LogsRuntime = {
      async containerLogs(): Promise<ContainerLogsResult> {
        called = true;
        throw new Error("should not be called");
      },
    };

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runLogsCommand({
      app: "blog",
      tail: "many",
      runtime,
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_CODES.USAGE);
    expect(called).toBe(false);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("invalid --tail");
    expect(stderr.text).toContain("next:");
  });

  it("maps a missing container to exit 5", async () => {
    const runtime: LogsRuntime = {
      async containerLogs(): Promise<ContainerLogsResult> {
        throw missingContainer("blog");
      },
    };

    const stderr = new RecordingStream();
    const code = await runLogsCommand({
      app: "blog",
      runtime,
      stdout: new RecordingStream(),
      stderr,
    });

    expect(code).toBe(EXIT_CODES.NOT_FOUND);
    expect(stderr.text).toContain("does not exist");
  });
});

describe("config", () => {
  it("prints an existing config path for --path", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080);

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runConfigCommand({
      app: "blog",
      path: true,
      environment: fixture.environment,
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout.text).toBe(`${blog.record.configPath}\n`);
    expect(stderr.text).toBe("");
    expect(existsSync(blog.record.configPath)).toBe(true);
  });

  it("validates by default and prints the path, status, source, and probe", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080);
    const before = readFileSync(blog.record.configPath, "utf8");

    const stdout = new RecordingStream();
    const code = await runConfigCommand({
      app: "blog",
      environment: fixture.environment,
      stdout,
      stderr: new RecordingStream(),
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout.text).toContain(blog.record.configPath);
    expect(stdout.text).toContain("valid");
    expect(stdout.text).toContain("source:");
    expect(stdout.text).toContain("probe:");
    expect(stdout.text).toContain("8080 -> 3000 on 0.0.0.0");
    // Validation is read-only and never rewrites the file.
    expect(readFileSync(blog.record.configPath, "utf8")).toBe(before);
    expectPlainText(stdout.text);
  });

  it("reports config validation errors with the offending key", async () => {
    const fixture = createFixture();
    const broken = fixture.registry.create("broken");
    writeFileSync(broken.configPath, 'repo = "https://example.com/broken.git"\nport = 80\n');

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runConfigCommand({
      app: "broken",
      environment: fixture.environment,
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_CODES.USAGE);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("config.toml");
    expect(stderr.text).toContain('"port"');
    expect(stderr.text).toContain("at least 1024");
    expect(stderr.text).toContain("next:");
    expectPlainText(stderr.text);
  });

  it("exits 5 for an unknown app", async () => {
    const fixture = createFixture();
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();

    const code = await runConfigCommand({
      app: "ghost",
      environment: fixture.environment,
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_CODES.NOT_FOUND);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain('app "ghost" was not found');
  });

  it("opens EDITOR and validates the saved file", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080);
    const replacement = serializeConfig(
      validateAppSpec({ repo: "https://example.com/blog.git", port: 9090 }),
    );
    const invocations: EditorInvocation[] = [];

    const editorRunner: EditorRunner = (invocation) => {
      invocations.push(invocation);
      writeFileSync(invocation.file, replacement);
      return 0;
    };

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runConfigCommand({
      app: "blog",
      edit: true,
      environment: { ...fixture.environment, EDITOR: "fake-editor --wait" },
      editorRunner,
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.command).toBe("fake-editor");
    expect(invocations[0]?.args).toEqual(["--wait"]);
    expect(invocations[0]?.file).toBe(blog.record.configPath);
    expect(stdout.text).toContain("valid");
    expect(stdout.text).toContain("9090");
    expect(stderr.text).toContain("validating");
    expect(readFileSync(blog.record.configPath, "utf8")).toBe(replacement);
  });

  it("reports an invalid edit without applying or rewriting it", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080);
    const invalid = 'repo = "https://example.com/blog.git"\nport = 80\n';

    const editorRunner: EditorRunner = (invocation) => {
      writeFileSync(invocation.file, invalid);
      return 0;
    };

    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const code = await runConfigCommand({
      app: "blog",
      edit: true,
      environment: { ...fixture.environment, EDITOR: "fake-editor" },
      editorRunner,
      stdout,
      stderr,
    });

    expect(code).toBe(EXIT_CODES.USAGE);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("config.toml");
    expect(stderr.text).toContain('"port"');
    // The handler reports the edit; it does not write a corrected file.
    expect(readFileSync(blog.record.configPath, "utf8")).toBe(invalid);
  });

  it("fails fast when EDITOR is not set", async () => {
    const fixture = createFixture();
    addConfiguredApp(fixture, "blog", 8080);
    let called = false;

    const code = await runConfigCommand({
      app: "blog",
      edit: true,
      environment: fixture.environment,
      editorRunner: () => {
        called = true;
        return 0;
      },
      stdout: new RecordingStream(),
      stderr: new RecordingStream(),
    });

    expect(code).toBe(EXIT_CODES.USAGE);
    expect(called).toBe(false);
  });

  it("rejects mutually exclusive output flags", async () => {
    const fixture = createFixture();
    addConfiguredApp(fixture, "blog", 8080);

    const stderr = new RecordingStream();
    const code = await runConfigCommand({
      app: "blog",
      path: true,
      edit: true,
      environment: fixture.environment,
      stdout: new RecordingStream(),
      stderr,
    });

    expect(code).toBe(EXIT_CODES.USAGE);
    expect(stderr.text).toContain("only one of --path, --edit, or --json");
  });

  it("emits a schemaVersion 1 document with [env] values redacted", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080, {
      env: { SESSION_SECRET: "do-not-print-me" },
    });

    const stdout = new RecordingStream();
    const code = await runConfigCommand({
      app: "blog",
      json: true,
      environment: fixture.environment,
      stdout,
      stderr: new RecordingStream(),
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    const document = JSON.parse(stdout.text) as {
      schemaVersion: number;
      app: string;
      path: string;
      valid: boolean;
      config: { port: number; env: Record<string, string> };
    };

    expect(document.schemaVersion).toBe(1);
    expect(document.app).toBe("blog");
    expect(document.path).toBe(blog.record.configPath);
    expect(document.valid).toBe(true);
    expect(document.config.port).toBe(8080);
    expect(document.config.env.SESSION_SECRET).toBe("[redacted]");
    expect(stdout.text).not.toContain("do-not-print-me");
    expectPlainText(stdout.text);
  });

  it("parses an editor command with quoted arguments but never uses a shell", () => {
    expect(parseEditorCommand(undefined)).toBeUndefined();
    expect(parseEditorCommand("   ")).toBeUndefined();
    expect(parseEditorCommand("vim")).toEqual({ command: "vim", args: [] });
    expect(parseEditorCommand('code --wait --user-data-dir "/tmp/a b"')).toEqual({
      command: "code",
      args: ["--wait", "--user-data-dir", "/tmp/a b"],
    });
  });
});

describe("read-only guarantees", () => {
  it("never creates state.json while listing or checking status", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080);
    // No state cache was written for this app.
    expect(existsSync(blog.record.statePath)).toBe(false);

    const runtime = new FixtureRuntime();
    runtime.containers.set("blog", runningContainer("blog"));

    await runListCommand({
      environment: fixture.environment,
      runtime,
      stdout: new RecordingStream(),
      stderr: new RecordingStream(),
    });
    await runStatusCommand({
      app: "blog",
      environment: fixture.environment,
      runtime,
      stdout: new RecordingStream(),
      stderr: new RecordingStream(),
    });

    expect(existsSync(blog.record.statePath)).toBe(false);
  });

  it("leaves an existing cache byte-for-byte unchanged", async () => {
    const fixture = createFixture();
    const blog = addConfiguredApp(fixture, "blog", 8080);
    writeHealthyState(blog.record);
    const before = readFileSync(blog.record.statePath, "utf8");

    const runtime = new FixtureRuntime();
    runtime.containers.set("blog", runningContainer("blog"));

    await runListCommand({
      environment: fixture.environment,
      runtime,
      stdout: new RecordingStream(),
      stderr: new RecordingStream(),
    });
    await runStatusCommand({
      app: "blog",
      environment: fixture.environment,
      runtime,
      stdout: new RecordingStream(),
      stderr: new RecordingStream(),
    });
    await runConfigCommand({
      app: "blog",
      environment: fixture.environment,
      stdout: new RecordingStream(),
      stderr: new RecordingStream(),
    });

    expect(readFileSync(blog.record.statePath, "utf8")).toBe(before);
  });
});
