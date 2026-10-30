/**
 * Add orchestration, prompts, and failure cleanup (`ADD-1.4`).
 *
 * Every test injects the builder, runtime, probe, workspace preparer,
 * prerequisite check, prompter, output, and state clock, so the suite runs with
 * no Podman, git, network, or terminal. The registry and state cache are the
 * real filesystem implementations under a temporary state root, which proves
 * the files and modes the lifecycle writes.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatAddResult, runAddCommand } from "../../src/cli/commands/add.js";
import {
  BuildError,
  ConflictError,
  HealthError,
  NotFoundError,
  PrerequisiteError,
  UsageError,
} from "../../src/cli/errors.js";
import {
  ADD_PROMPT_FLAGS,
  type AddInputValues,
  type Prompter,
  type PromptTextOptions,
} from "../../src/cli/prompts.js";
import { validateAppSpec } from "../../src/config/parse.js";
import { formatProbeTarget, type ProbeAppSpec, type ProbeResult } from "../../src/health/probe.js";
import {
  type AddBuilder,
  type AddBuildRequest,
  type AddDependencies,
  type AddOutput,
  type AddProber,
  type AddRuntime,
  type AddWorkspace,
  addApp,
  createDefaultAddOutput,
} from "../../src/lifecycle/add.js";
import type { PreparedWorkspace, PrepareWorkspaceOptions } from "../../src/platform/git.js";
import { Paths } from "../../src/platform/paths.js";
import {
  APP_LABEL,
  type ContainerLogsOptions,
  type ContainerLogsResult,
  type ContainerRunResult,
  type CreateVolumeOptions,
  containerName,
  type ListVolumesOptions,
  type RemoveContainerOptions,
  type RunContainerOptions,
  type StopContainerOptions,
  type VolumeSummary,
  volumeName,
} from "../../src/platform/podman.js";
import { StateStore } from "../../src/registry/state.js";
import { Registry } from "../../src/registry/store.js";

const FIXED_TIME = new Date("2026-10-30T12:00:00.000Z");
const IMAGE = "localhost/easy-host-blog:20261030T120000Z";

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

class RecordingOutput implements AddOutput {
  readonly phases: string[] = [];
  readonly lines: string[] = [];

  phase(phase: string, message: string): void {
    this.phases.push(phase);
    this.lines.push(`add: ${phase}: ${message}`);
  }

  info(message: string): void {
    this.lines.push(`add: ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`add: warning: ${message}`);
  }

  get text(): string {
    return this.lines.join("\n");
  }
}

class QueuePrompter implements Prompter {
  readonly questions: string[] = [];
  readonly options: PromptTextOptions[] = [];
  readonly #interactive: boolean;
  readonly #answers: string[];

  constructor(interactive: boolean, answers: readonly string[] = []) {
    this.#interactive = interactive;
    this.#answers = [...answers];
  }

  isInteractive(): boolean {
    return this.#interactive;
  }

  async text(options: PromptTextOptions): Promise<string | undefined> {
    this.questions.push(options.message);
    this.options.push(options);

    if (this.#answers.length === 0) {
      return options.defaultValue ?? "";
    }

    return this.#answers.shift() ?? "";
  }
}

class RecordingBuilder implements AddBuilder {
  readonly requests: AddBuildRequest[] = [];
  fail: Error | undefined;

  async build(request: AddBuildRequest): Promise<{ image: string }> {
    this.requests.push(request);
    if (this.fail !== undefined) {
      throw this.fail;
    }

    return { image: `localhost/easy-host-${request.app}:20261030T120000Z` };
  }
}

class RecordingWorkspace implements AddWorkspace {
  readonly requests: PrepareWorkspaceOptions[] = [];
  next: PreparedWorkspace | undefined;
  fail: Error | undefined;

  async prepare(options: PrepareWorkspaceOptions): Promise<PreparedWorkspace> {
    this.requests.push(options);
    if (this.fail !== undefined) {
      throw this.fail;
    }
    if (this.next === undefined) {
      throw new Error("test did not configure a prepared workspace");
    }

    return {
      ...this.next,
      app: options.app,
      appDir: options.appDir,
    };
  }
}

class RecordingRuntime implements AddRuntime {
  readonly calls: Array<{ method: string; options: unknown }> = [];
  occupied = false;
  runError: Error | undefined;
  logs = "";
  volumes: VolumeSummary[] = [];
  nextId = "container-id-1";

  async inspectContainer(options: { readonly app: string }): Promise<unknown> {
    this.calls.push({ method: "inspectContainer", options });
    if (!this.occupied) {
      throw new NotFoundError(`container "${containerName(options.app)}" does not exist`, {
        code: "CONTAINER_NOT_FOUND",
      });
    }

    return { labels: { [APP_LABEL]: options.app } };
  }

  async createVolume(options: CreateVolumeOptions): Promise<unknown> {
    this.calls.push({ method: "createVolume", options });
    return {
      app: options.app,
      volume: options.volume,
      name: volumeName(options.app, options.volume),
    };
  }

  async listVolumes(options: ListVolumesOptions = {}): Promise<readonly VolumeSummary[]> {
    this.calls.push({ method: "listVolumes", options });
    return this.volumes;
  }

  async runContainer(options: RunContainerOptions): Promise<ContainerRunResult> {
    this.calls.push({ method: "runContainer", options });
    if (this.runError !== undefined) {
      throw this.runError;
    }

    return {
      app: options.app,
      container: containerName(options.app),
      id: this.nextId,
      image: options.image,
      port: options.port,
      containerPort: options.containerPort ?? 3000,
      bind: options.bind ?? "0.0.0.0",
      volumes: Object.keys(options.volumes ?? {}).map((volume) => volumeName(options.app, volume)),
      environmentNames: Object.keys(options.environment ?? {}).sort(),
    };
  }

  async stopContainer(options: StopContainerOptions): Promise<unknown> {
    this.calls.push({ method: "stopContainer", options });
    return { app: options.app, container: containerName(options.app), stopped: true };
  }

  async removeContainer(options: RemoveContainerOptions): Promise<unknown> {
    this.calls.push({ method: "removeContainer", options });
    return { app: options.app, container: containerName(options.app), removed: true };
  }

  async containerLogs(options: ContainerLogsOptions): Promise<ContainerLogsResult> {
    this.calls.push({ method: "containerLogs", options });
    return {
      app: options.app,
      container: containerName(options.app),
      exitCode: 0,
      stdout: this.logs,
      stderr: "",
      followed: options.follow ?? true,
      tail: options.tail ?? 200,
    };
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

class RecordingProber implements AddProber {
  readonly requests: ProbeAppSpec[] = [];
  healthy = true;

  async probe(spec: ProbeAppSpec): Promise<ProbeResult> {
    this.requests.push(spec);
    return probeResult(spec, this.healthy);
  }
}

function probeResult(spec: ProbeAppSpec, healthy: boolean): ProbeResult {
  const target = formatProbeTarget(spec.probe, spec.port, spec.health_path);

  return {
    state: healthy ? "healthy" : "unhealthy",
    healthy,
    kind: spec.probe,
    port: spec.port,
    target,
    attempts: healthy ? 1 : 3,
    elapsedMs: healthy ? 25 : 6_000,
    lastStatus: healthy ? 200 : undefined,
    lastError: healthy
      ? undefined
      : {
          kind: "connection-refused",
          code: "PROBE_CONNECTION_REFUSED",
          message: "connection refused",
          status: undefined,
          timeoutMs: undefined,
          causeCode: "ECONNREFUSED",
        },
    intervalMs: spec.health_interval_ms,
    timeoutMs: spec.health_timeout_ms,
    startupMs: spec.health_startup_ms,
  };
}

interface Harness {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly paths: Paths;
  readonly registry: Registry;
  readonly builder: RecordingBuilder;
  readonly runtime: RecordingRuntime;
  readonly prober: RecordingProber;
  readonly workspace: RecordingWorkspace;
  readonly prompter: QueuePrompter;
  readonly output: RecordingOutput;
  readonly deps: AddDependencies;
}

function createHarness(overrides: Partial<AddDependencies> = {}, interactive = false): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "easy-host-add-"));
  roots.push(root);

  const env: NodeJS.ProcessEnv = { EASY_HOST_HOME: root, HOME: root };
  const paths = new Paths({ env });
  const registry = new Registry(paths);
  const builder = new RecordingBuilder();
  const runtime = new RecordingRuntime();
  const prober = new RecordingProber();
  const workspace = new RecordingWorkspace();
  const prompter = new QueuePrompter(interactive);
  const output = new RecordingOutput();
  const clock = () => FIXED_TIME;

  const deps: AddDependencies = {
    paths,
    registry,
    builder,
    runtime,
    prober,
    prerequisites: { check: () => undefined },
    prompter,
    workspace,
    output,
    stateStore: (appDir) => new StateStore(appDir, { clock }),
    environment: env,
    clock,
    ...overrides,
  };

  return {
    root,
    env,
    paths,
    registry,
    builder,
    runtime,
    prober,
    workspace,
    prompter,
    output,
    deps,
  };
}

function gitWorkspace(appDir: string): PreparedWorkspace {
  return {
    app: path.basename(appDir),
    appDir,
    workspace: path.join(appDir, "workspace"),
    mode: "git",
    repo: "https://github.com/example/blog.git",
    ref: "main",
    commit: "abcdef0123456789abcdef0123456789abcdef01",
    devOnly: false,
    cloned: true,
    fetched: false,
  };
}

function localWorkspace(appDir: string): PreparedWorkspace {
  return {
    app: path.basename(appDir),
    appDir,
    workspace: path.join(appDir, "src"),
    mode: "local",
    repo: undefined,
    ref: undefined,
    commit: undefined,
    devOnly: true,
    cloned: false,
    fetched: false,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the add operation to fail");
}

function seedApp(harness: Harness, name: string, port: number): void {
  harness.paths.ensureLayout();
  harness.registry.create(name);
  harness.registry.writeConfig(
    name,
    validateAppSpec({ repo: `https://github.com/example/${name}.git`, port }),
  );
}

describe("prompt flag parity (ADD-FR-01)", () => {
  it("gives every prompt a flag equivalent", () => {
    expect(Object.keys(ADD_PROMPT_FLAGS).sort()).toEqual(
      ["bind", "containerPort", "envFile", "healthPath", "name", "port", "ref", "source"].sort(),
    );
    expect(ADD_PROMPT_FLAGS.source).toContain("--local");
    expect(ADD_PROMPT_FLAGS.name).toBe("--name");
    expect(ADD_PROMPT_FLAGS.port).toBe("--port");
    expect(ADD_PROMPT_FLAGS.ref).toBe("--ref");
    expect(ADD_PROMPT_FLAGS.containerPort).toBe("--container-port");
    expect(ADD_PROMPT_FLAGS.bind).toBe("--bind");
    expect(ADD_PROMPT_FLAGS.healthPath).toBe("--health-path");
    expect(ADD_PROMPT_FLAGS.envFile).toBe("--env-file");
  });
});

describe("add happy path", () => {
  it("preflights, prepares, builds, runs, probes, and persists healthy state", async () => {
    const harness = createHarness();
    const appDir = harness.paths.appDir("blog");
    harness.workspace.next = gitWorkspace(appDir);

    const result = await addApp(
      {
        repo: "https://github.com/example/blog.git",
        port: "8080",
        interactive: false,
      },
      harness.deps,
    );

    expect(result.app).toBe("blog");
    expect(result.port).toBe(8080);
    expect(result.image).toBe(IMAGE);
    expect(result.devOnly).toBe(false);
    expect(result.url).toBe("http://localhost:8080/");
    expect(result.previousImage).toBeNull();
    expect(result.state?.health.status).toBe("healthy");

    expect(harness.prompter.questions).toEqual([]);
    expect(harness.builder.requests).toHaveLength(1);
    expect(harness.builder.requests[0]?.workspace).toBe(path.join(appDir, "workspace"));
    expect(harness.prober.requests).toHaveLength(1);
    expect(harness.runtime.methods()).toEqual(["inspectContainer", "runContainer"]);

    const run = harness.runtime.calls[1]?.options as RunContainerOptions;
    expect(run.containerPort).toBe(3000);
    expect(run.port).toBe(8080);
    expect(run.bind).toBe("0.0.0.0");
    expect(run.environment).toEqual({});

    expect(harness.registry.readConfig("blog").port).toBe(8080);
    expect(existsSync(harness.registry.record("blog").configPath)).toBe(true);

    const state = new StateStore(appDir).readCache();
    expect(state?.images.current).toBe(IMAGE);
    expect(state?.images.previous).toBeNull();
    expect(state?.containerId).toBe("container-id-1");
    expect(state?.health.status).toBe("healthy");
    expect(state?.health.detail).toContain("healthy after 1 attempt");

    expect(harness.output.phases).toEqual([
      "validating",
      "allocating",
      "cloning",
      "building",
      "starting",
      "probing",
      "boot",
      "recording",
      "keeping",
    ]);
    expect(harness.output.text).not.toContain("\u001B[");
  });

  it("creates one labelled volume per declared mount", async () => {
    const harness = createHarness();
    const appDir = harness.paths.appDir("blog");
    harness.workspace.next = gitWorkspace(appDir);

    const result = await addApp(
      {
        repo: "https://github.com/example/blog.git",
        port: "8080",
        volume: ["data:/var/lib/data"],
        interactive: false,
      },
      harness.deps,
    );

    expect(result.volumes).toEqual(["easy-host-blog-data"]);
    expect(harness.runtime.methods()).toEqual([
      "inspectContainer",
      "listVolumes",
      "createVolume",
      "runContainer",
    ]);
    const create = harness.runtime.calls[2]?.options as CreateVolumeOptions;
    expect(create).toMatchObject({ app: "blog", volume: "data", ignoreExisting: true });
  });
});

describe("interactive prompts (ADD-FR-01)", () => {
  it("asks only for values not supplied and applies prompt defaults", async () => {
    const harness = createHarness({}, true);
    harness.workspace.next = gitWorkspace(harness.paths.appDir("blog"));
    harness.prompter.text = async (options: PromptTextOptions) => {
      harness.prompter.questions.push(options.message);
      harness.prompter.options.push(options);
      const answers: Record<string, string> = {
        "App name": "",
        "Host port (1024-65535); easy-host never picks one": "9090",
        "Git ref to build": "",
        "Container port the app listens on": "",
        "Bind address for the published port": "",
        "Health path used by the readiness probe": "",
        "Secret file path (app-relative; leave blank for the default secrets.env)": "",
      };

      return answers[options.message];
    };

    const result = await addApp(
      {
        repo: "https://github.com/example/blog.git",
        interactive: true,
      },
      harness.deps,
    );

    expect(result.app).toBe("blog");
    expect(result.port).toBe(9090);
    expect(harness.prompter.questions[0]).toContain("App name");
    expect(harness.prompter.questions[1]).toContain("Host port");
    expect(harness.prompter.questions.some((question) => question.includes("Repository"))).toBe(
      false,
    );
    expect(harness.prompter.options[0]?.defaultValue).toBe("blog");
    expect(harness.prompter.options[1]?.defaultValue).toBeUndefined();
  });

  it("does not prompt when every value is supplied", async () => {
    const harness = createHarness({}, true);
    const appDir = harness.paths.appDir("blog");
    harness.workspace.next = gitWorkspace(appDir);

    await addApp(
      {
        repo: "https://github.com/example/blog.git",
        name: "blog",
        port: "8080",
        ref: "main",
        containerPort: "3000",
        bind: "0.0.0.0",
        healthPath: "/healthz",
        envFile: "secrets.env",
        probe: "http",
        interactive: true,
      },
      harness.deps,
    );

    expect(harness.prompter.questions).toEqual([]);
  });
});

describe("non-interactive missing flags (ADD-FR-01)", () => {
  it("names --port and mutates nothing", async () => {
    const harness = createHarness();

    const error = await rejection(
      addApp({ repo: "https://github.com/example/blog.git", interactive: false }, harness.deps),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("MISSING_FLAG");
    expect((error as UsageError).message).toContain("--port");
    expect(harness.registry.exists("blog")).toBe(false);
    expect(harness.builder.requests).toEqual([]);
    expect(harness.runtime.calls).toEqual([]);
  });

  it("names the repository/--local source and mutates nothing", async () => {
    const harness = createHarness();

    const error = await rejection(addApp({ port: "8080", interactive: false }, harness.deps));

    expect((error as UsageError).code).toBe("MISSING_FLAG");
    expect((error as UsageError).message).toContain("--local");
    expect(harness.runtime.calls).toEqual([]);
  });
});

describe("preflight rejection (ADD-FR-07, ADD-NF-01)", () => {
  it("rejects a name collision before any mutation", async () => {
    const harness = createHarness();
    seedApp(harness, "blog", 8080);

    const error = await rejection(
      addApp(
        { repo: "https://github.com/example/blog.git", port: "9090", interactive: false },
        harness.deps,
      ),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("APP_NAME_CONFLICT");
    expect(harness.builder.requests).toEqual([]);
    expect(harness.runtime.calls).toEqual([]);
    expect(harness.registry.readConfig("blog").port).toBe(8080);
  });

  it("rejects a port already declared by another app and names it", async () => {
    const harness = createHarness();
    seedApp(harness, "taken", 8080);

    const error = await rejection(
      addApp(
        { repo: "https://github.com/example/blog.git", port: "8080", interactive: false },
        harness.deps,
      ),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("PORT_CONFLICT");
    expect((error as ConflictError).message).toContain("taken");
    expect(harness.builder.requests).toEqual([]);
    expect(harness.runtime.calls).toEqual([]);
  });

  it("rejects an invalid config value with the key named", async () => {
    const harness = createHarness();

    const error = await rejection(
      addApp(
        { repo: "https://github.com/example/blog.git", port: "70000", interactive: false },
        harness.deps,
      ),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(1);
    expect((error as UsageError).message).toContain("port");
    expect(harness.registry.exists("blog")).toBe(false);
    expect(harness.runtime.calls).toEqual([]);
  });

  it("rejects an occupied container name before creating volumes or a container", async () => {
    const harness = createHarness();
    harness.runtime.occupied = true;

    const error = await rejection(
      addApp(
        { repo: "https://github.com/example/blog.git", port: "8080", interactive: false },
        harness.deps,
      ),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("CONTAINER_NAME_CONFLICT");
    expect(harness.builder.requests).toEqual([]);
    expect(harness.runtime.methods()).toEqual(["inspectContainer"]);
    expect(harness.registry.exists("blog")).toBe(false);
  });

  it("rejects an unreachable prerequisite before any resource exists", async () => {
    const harness = createHarness({
      prerequisites: {
        check: () => {
          throw new PrerequisiteError("podman is not reachable", {
            code: "PREREQUISITE_CHECK_FAILED",
          });
        },
      },
    });

    const error = await rejection(
      addApp(
        { repo: "https://github.com/example/blog.git", port: "8080", interactive: false },
        harness.deps,
      ),
    );

    expect(error).toBeInstanceOf(PrerequisiteError);
    expect((error as PrerequisiteError).exitCode).toBe(2);
    expect(harness.builder.requests).toEqual([]);
    expect(harness.registry.exists("blog")).toBe(false);
  });

  it("refuses a volume name owned by another app", async () => {
    const harness = createHarness();
    harness.runtime.volumes = [
      {
        name: "easy-host-blog-data",
        app: "someone-else",
        labels: { [APP_LABEL]: "someone-else" },
      },
    ];

    const error = await rejection(
      addApp(
        {
          repo: "https://github.com/example/blog.git",
          port: "8080",
          volume: ["data:/var/lib/data"],
          interactive: false,
        },
        harness.deps,
      ),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("VOLUME_NAME_CONFLICT");
    expect(harness.builder.requests).toEqual([]);
    expect(harness.registry.exists("blog")).toBe(false);
  });
});

describe("workspace and build failure", () => {
  it("keeps the app entry and creates no container when the ref is unknown", async () => {
    const harness = createHarness();
    harness.workspace.fail = new BuildError("unknown ref", { code: "GIT_UNKNOWN_REF" });

    const error = await rejection(
      addApp(
        { repo: "https://github.com/example/blog.git", port: "8080", interactive: false },
        harness.deps,
      ),
    );

    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).exitCode).toBe(3);
    expect(harness.registry.exists("blog")).toBe(true);
    expect(harness.builder.requests).toEqual([]);
    expect(harness.runtime.methods()).toEqual(["inspectContainer"]);
    expect(new StateStore(harness.paths.appDir("blog")).readCache()).toBeUndefined();
  });

  it("keeps the app entry and image on a build failure without starting anything", async () => {
    const harness = createHarness();
    harness.workspace.next = gitWorkspace(harness.paths.appDir("blog"));
    harness.builder.fail = new BuildError("provider build failed", {
      code: "BUILD_PROVIDER_FAILED",
    });

    const error = await rejection(
      addApp(
        { repo: "https://github.com/example/blog.git", port: "8080", interactive: false },
        harness.deps,
      ),
    );

    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).exitCode).toBe(3);
    expect(harness.registry.exists("blog")).toBe(true);
    expect(harness.runtime.methods()).toEqual(["inspectContainer"]);
    expect(harness.output.phases).toContain("failed");
  });
});

describe("probe failure cleanup (ADD-FR-05)", () => {
  it("removes only the container, keeps the image and app entry, and records unhealthy", async () => {
    const harness = createHarness();
    const appDir = harness.paths.appDir("blog");
    harness.workspace.next = gitWorkspace(appDir);
    harness.prober.healthy = false;
    harness.runtime.logs = "server starting\nboom: not listening on 3000\n";

    const error = await rejection(
      addApp(
        {
          repo: "https://github.com/example/blog.git",
          port: "8080",
          volume: ["data:/var/lib/data"],
          interactive: false,
        },
        harness.deps,
      ),
    );

    expect(error).toBeInstanceOf(HealthError);
    const health = error as HealthError;
    expect(health.exitCode).toBe(4);
    expect(health.code).toBe("HEALTH_CHECK_FAILED");
    expect(health.details.app).toBe("blog");
    expect(health.details.previous).toBe("none (first version)");
    expect(health.details.image).toBe(IMAGE);
    expect(String(health.details.logs)).toContain("boom");
    expect(health.remediation).toContain("easy-host update blog");

    expect(harness.runtime.methods()).toEqual([
      "inspectContainer",
      "listVolumes",
      "createVolume",
      "runContainer",
      "containerLogs",
      "stopContainer",
      "removeContainer",
    ]);
    const stop = harness.runtime.calls[5]?.options as StopContainerOptions;
    const remove = harness.runtime.calls[6]?.options as RemoveContainerOptions;
    expect(stop).toMatchObject({ app: "blog", timeSeconds: 10 });
    expect(remove).toMatchObject({ app: "blog", force: true, ignoreMissing: true });

    // The app directory and config survive; only the container was removed.
    expect(existsSync(harness.registry.record("blog").configPath)).toBe(true);
    expect(existsSync(path.join(appDir, "workspace"))).toBe(true);

    const state = new StateStore(appDir).readCache();
    expect(state?.health.status).toBe("unhealthy");
    expect(state?.health.detail).toContain("connection refused");
    expect(state?.images.current).toBe(IMAGE);
    expect(state?.images.previous).toBeNull();
    expect(state?.containerId).toBeNull();

    expect(harness.output.text).toContain("container logs");
    expect(harness.output.text).toContain("removing");
  });

  it("still removes the container when the probe throws unexpectedly", async () => {
    const harness = createHarness({
      prober: {
        probe: async () => {
          throw new Error("probe blew up");
        },
      },
    });
    harness.workspace.next = gitWorkspace(harness.paths.appDir("blog"));

    const error = await rejection(
      addApp(
        { repo: "https://github.com/example/blog.git", port: "8080", interactive: false },
        harness.deps,
      ),
    );

    expect((error as Error).message).toBe("probe blew up");
    expect(harness.runtime.methods()).toEqual([
      "inspectContainer",
      "runContainer",
      "containerLogs",
      "stopContainer",
      "removeContainer",
    ]);
    expect(harness.registry.exists("blog")).toBe(true);
    const state = new StateStore(harness.paths.appDir("blog")).readCache();
    expect(state?.health.status).toBe("unhealthy");
    expect(state?.containerId).toBeNull();
  });
});

describe("local mode (ADD-FR-02)", () => {
  it("marks a local-path add dev-only in output and status data", async () => {
    const harness = createHarness();
    const appDir = harness.paths.appDir("src");
    harness.workspace.next = localWorkspace(appDir);

    const result = await addApp(
      { localPath: "src", port: "8080", interactive: false },
      harness.deps,
    );

    expect(result.mode).toBe("local");
    expect(result.devOnly).toBe(true);
    expect(result.workspace).toBe(path.join(appDir, "src"));
    expect(harness.output.text).toContain("dev-only");
    expect(formatAddResult(result)).toContain("local mode: dev-only");
  });
});

describe("add command handler", () => {
  it("writes a human summary to stdout and returns 0", async () => {
    const harness = createHarness();
    harness.workspace.next = gitWorkspace(harness.paths.appDir("blog"));
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();

    const exitCode = await runAddCommand({
      url: "https://github.com/example/blog.git",
      port: "8080",
      yes: true,
      stdout,
      stderr,
      dependencies: harness.deps,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text).toContain('added "blog"');
    expect(stdout.text).toContain("http://localhost:8080/");
    expect(stdout.text).toContain(IMAGE);
    expect(stderr.text).not.toContain("\u001B[");
  });

  it("returns exit 4 and prints the probe remediation on an unhealthy add", async () => {
    const harness = createHarness();
    harness.workspace.next = gitWorkspace(harness.paths.appDir("blog"));
    harness.prober.healthy = false;
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();

    const exitCode = await runAddCommand({
      url: "https://github.com/example/blog.git",
      port: "8080",
      yes: true,
      stdout,
      stderr,
      dependencies: harness.deps,
    });

    expect(exitCode).toBe(4);
    expect(stderr.text).toContain('health check failed for "blog"');
    expect(stderr.text).toContain("easy-host update blog");
    expect(stdout.text).toBe("");
  });
});

describe("progress output", () => {
  it("uses plain text and no ANSI escapes", () => {
    const stream = new RecordingStream();
    const output = createDefaultAddOutput(stream);
    output.phase("validating", "checking");
    output.warn("dev-only");

    expect(stream.text).toBe("add: validating: checking\nadd: warning: dev-only\n");
    expect(stream.text).not.toContain("\u001B[");
  });

  it("re-exports the input type through the public lifecycle shape", () => {
    const input: AddInputValues = { port: "8080" };
    expect(input.port).toBe("8080");
  });
});

describe("reboot recovery (RBK-FR-02)", () => {
  it("enables podman-restart.service after a healthy probe", async () => {
    const harness = createHarness();
    const appDir = harness.paths.appDir("blog");
    harness.workspace.next = gitWorkspace(appDir);

    let calls = 0;
    Object.assign(harness.runtime, {
      enableBootRecovery: async () => {
        calls += 1;
        return {
          service: "podman-restart.service",
          enabled: true,
          detail: "podman-restart.service is enabled and running for this user.",
        };
      },
    });

    const result = await addApp(
      { repo: "https://github.com/example/blog.git", port: "8080", interactive: false },
      harness.deps,
    );

    expect(calls).toBe(1);
    expect(harness.output.phases).toContain("boot");
    expect(harness.output.phases.indexOf("boot")).toBeGreaterThan(
      harness.output.phases.indexOf("probing"),
    );
    expect(harness.output.phases.indexOf("boot")).toBeLessThan(
      harness.output.phases.indexOf("recording"),
    );
    expect(result.warnings).toEqual([]);
  });

  it("keeps the app and warns when the unit cannot be enabled", async () => {
    const harness = createHarness();
    const appDir = harness.paths.appDir("blog");
    harness.workspace.next = gitWorkspace(appDir);

    Object.assign(harness.runtime, {
      enableBootRecovery: async () => ({
        service: "podman-restart.service",
        enabled: false,
        detail: "systemctl could not start (ENOENT)",
      }),
    });

    const result = await addApp(
      { repo: "https://github.com/example/blog.git", port: "8080", interactive: false },
      harness.deps,
    );

    expect(result.health.healthy).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join("\n")).toContain("will not return after a reboot");
    expect(result.warnings.join("\n")).toContain("ENOENT");
    expect(harness.output.text).toContain("will not return after a reboot");
  });

  it("warns instead of failing when enableBootRecovery throws", async () => {
    const harness = createHarness();
    const appDir = harness.paths.appDir("blog");
    harness.workspace.next = gitWorkspace(appDir);

    Object.assign(harness.runtime, {
      enableBootRecovery: async () => {
        throw new Error("user manager is not running");
      },
    });

    const result = await addApp(
      { repo: "https://github.com/example/blog.git", port: "8080", interactive: false },
      harness.deps,
    );

    expect(result.health.healthy).toBe(true);
    expect(result.warnings.join("\n")).toContain("user manager is not running");
  });
});
