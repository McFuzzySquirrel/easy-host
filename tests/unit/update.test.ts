/**
 * Update orchestration and command (`UPD-1.3`, UPD-FR-04, UPD-FR-05).
 *
 * Every test injects the builder, runtime, probe, workspace source, output, and
 * clock. The registry and state cache are the real filesystem implementations
 * under a temporary state root, so the suite proves the files that update
 * writes: `config.toml` only after a success, `state.json` without touching the
 * image pair for a config-only recreate, and the disposable checkout removal
 * after a failed build.
 *
 * The safety rules get their own assertions:
 *
 * - a config-only update never invokes the builder (UPD-FR-05);
 * - a build failure happens before any container stop (UPD-NF-01, acceptance);
 * - lock contention exits 6 without calling the builder or runtime;
 * - a reverted candidate leaves the current and previous image references
 *   exactly as they were (UPD-FR-03);
 * - the report never contains an environment value.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatUpdateResult, runUpdateCommand } from "../../src/cli/commands/update.js";
import { BuildError, ConflictError, HealthError, NotFoundError } from "../../src/cli/errors.js";
import { parseConfigToml, validateAppSpec } from "../../src/config/parse.js";
import type { AppSpec, AppSpecInput } from "../../src/config/schema.js";
import type { ProbeAppSpec, ProbeResult } from "../../src/health/probe.js";
import type { AddBuilder, AddBuildRequest } from "../../src/lifecycle/add.js";
import type { UpdateContainerObservation } from "../../src/lifecycle/diff.js";
import type { RetainRequest, RetainResult } from "../../src/lifecycle/retain.js";
import type { SwapProber } from "../../src/lifecycle/swap.js";
import {
  createDefaultUpdateOutput,
  type UpdateDependencies,
  type UpdateOutput,
  type UpdatePhase,
  type UpdateRequest,
  type UpdateRuntime,
  type UpdateSource,
  updateApp,
} from "../../src/lifecycle/update.js";
import type { PreparedWorkspace, PrepareWorkspaceOptions } from "../../src/platform/git.js";
import { acquireAppLock } from "../../src/platform/lock.js";
import { createPaths, type Paths } from "../../src/platform/paths.js";
import {
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
} from "../../src/platform/podman.js";
import { StateStore } from "../../src/registry/state.js";
import { Registry } from "../../src/registry/store.js";

const APP = "blog";
const REPO = "https://github.com/example/blog.git";
const CURRENT = "localhost/easy-host-blog:20261029T120000Z";
const OLDER = "localhost/easy-host-blog:20261028T120000Z";
const CANDIDATE = "localhost/easy-host-blog:20261030T130000Z";
const STALE_IMAGE = "localhost/easy-host-blog:20261026T120000Z";
const COMMIT_ONE = "1111111111111111111111111111111111111111";
const COMMIT_TWO = "2222222222222222222222222222222222222222";
const FIXED_TIME = new Date("2026-10-30T12:00:00.000Z");
const SECRET_VALUE = "super-secret-env-value";

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

class RecordingOutput implements UpdateOutput {
  readonly phases: UpdatePhase[] = [];
  readonly lines: string[] = [];

  phase(phase: UpdatePhase, message: string): void {
    this.phases.push(phase);
    this.lines.push(`update: ${phase}: ${message}`);
  }

  info(message: string): void {
    this.lines.push(`update: ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`update: warning: ${message}`);
  }

  get text(): string {
    return this.lines.join("\n");
  }
}

interface RuntimeCall {
  readonly method: string;
  readonly options: Record<string, unknown>;
}

class FakeRuntime implements UpdateRuntime {
  readonly calls: RuntimeCall[] = [];
  readonly volumes: VolumeSummary[] = [];
  readonly runQueue: Array<ContainerRunResult | Error> = [];
  inspectResult: unknown | Error = undefined;

  async inspectContainer(options: { readonly app: string }): Promise<unknown> {
    this.calls.push({ method: "inspectContainer", options: { ...options } });
    if (this.inspectResult instanceof Error) {
      throw this.inspectResult;
    }

    if (this.inspectResult === undefined) {
      throw new NotFoundError(`container "${containerName(options.app)}" was not found`, {
        code: "CONTAINER_NOT_FOUND",
      });
    }

    return this.inspectResult;
  }

  async listVolumes(_options?: ListVolumesOptions): Promise<readonly VolumeSummary[]> {
    this.calls.push({ method: "listVolumes", options: {} });
    return this.volumes;
  }

  async createVolume(options: CreateVolumeOptions): Promise<unknown> {
    this.calls.push({ method: "createVolume", options: { ...options } });
    return { app: options.app, volume: options.volume, name: `${options.app}-${options.volume}` };
  }

  async stopContainer(options: StopContainerOptions): Promise<unknown> {
    this.calls.push({ method: "stopContainer", options: { ...options } });
    return { app: options.app, container: containerName(options.app), stopped: true };
  }

  async removeContainer(options: RemoveContainerOptions): Promise<unknown> {
    this.calls.push({ method: "removeContainer", options: { ...options } });
    return { app: options.app, container: containerName(options.app), removed: true };
  }

  async runContainer(options: RunContainerOptions): Promise<ContainerRunResult> {
    this.calls.push({ method: "runContainer", options: { ...options } });
    const next = this.runQueue.shift();
    if (next === undefined) {
      throw new Error("test did not queue a run result");
    }
    if (next instanceof Error) {
      throw next;
    }

    return next;
  }

  async containerLogs(options: ContainerLogsOptions): Promise<ContainerLogsResult> {
    this.calls.push({ method: "containerLogs", options: { ...options } });
    return {
      app: options.app,
      container: containerName(options.app),
      exitCode: 0,
      stdout: "",
      stderr: "",
      followed: false,
      tail: 200,
    };
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  /** Container mutations only; inspect and volume reads are excluded. */
  mutations(): string[] {
    return this.methods().filter(
      (method) => method !== "inspectContainer" && method !== "listVolumes",
    );
  }

  runImages(): string[] {
    return this.calls
      .filter((call) => call.method === "runContainer")
      .map((call) => call.options.image as string);
  }
}

class FakeBuilder implements AddBuilder {
  readonly requests: AddBuildRequest[] = [];
  fail: Error | undefined;
  image = CANDIDATE;

  async build(request: AddBuildRequest): Promise<{ image: string }> {
    this.requests.push(request);
    if (this.fail !== undefined) {
      throw this.fail;
    }

    return { image: this.image };
  }
}

class FakeProber implements SwapProber {
  readonly specs: ProbeAppSpec[] = [];
  readonly queue: Array<ProbeResult | Error | "hang"> = [];

  async probe(spec: ProbeAppSpec): Promise<ProbeResult> {
    this.specs.push(spec);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("test did not queue a probe result");
    }
    if (next === "hang") {
      return new Promise<ProbeResult>(() => {
        // Deliberately never settles: the first-start deadline must cut it off.
      });
    }
    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}

function emptyRetention(): RetainResult {
  return {
    status: "retained",
    app: APP,
    current: CURRENT,
    previous: OLDER,
    examined: 2,
    retained: [
      { reference: CURRENT, reasons: ["current"] },
      { reference: OLDER, reasons: ["previous"] },
    ],
    removed: [],
    refused: [],
    missing: [],
    skipped: [],
    phases: [],
    warnings: [],
    notes: [],
  };
}

class FakeRetention {
  readonly requests: RetainRequest[] = [];
  calls = 0;
  result: RetainResult = emptyRetention();
  failure: Error | undefined;

  async retain(request: RetainRequest): Promise<RetainResult> {
    this.calls += 1;
    this.requests.push(request);
    if (this.failure !== undefined) {
      throw this.failure;
    }

    return this.result;
  }
}

class FakeSource implements UpdateSource {
  readonly prepareCalls: PrepareWorkspaceOptions[] = [];
  headCalls = 0;
  headCommit: string | undefined = COMMIT_ONE;
  prepared: Partial<PreparedWorkspace> | Error | undefined;

  async head(): Promise<string | undefined> {
    this.headCalls += 1;
    return this.headCommit;
  }

  async prepare(options: PrepareWorkspaceOptions): Promise<PreparedWorkspace> {
    this.prepareCalls.push(options);
    if (this.prepared instanceof Error) {
      throw this.prepared;
    }

    const local = options.localPath !== undefined;

    return {
      app: options.app,
      appDir: options.appDir,
      workspace: local
        ? path.join(options.appDir, options.localPath ?? "")
        : path.join(options.appDir, "workspace"),
      mode: local ? "local" : "git",
      repo: local || options.repo === undefined ? undefined : REPO,
      ref: local ? undefined : options.ref,
      commit: local ? undefined : COMMIT_TWO,
      devOnly: local,
      cloned: false,
      fetched: !local,
      ...(this.prepared ?? {}),
    };
  }
}

function spec(overrides: Partial<AppSpecInput> = {}): AppSpec {
  return validateAppSpec({
    repo: REPO,
    port: 8080,
    health_interval_ms: 10,
    health_timeout_ms: 10,
    health_startup_ms: 50,
    ...overrides,
  });
}

function healthyProbe(target: AppSpec = spec(), overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    state: "healthy",
    healthy: true,
    kind: "http",
    port: target.port,
    target: `http://127.0.0.1:${target.port}${target.health_path}`,
    attempts: 1,
    elapsedMs: 5,
    lastStatus: 200,
    lastError: undefined,
    intervalMs: target.health_interval_ms,
    timeoutMs: target.health_timeout_ms,
    startupMs: target.health_startup_ms,
    ...overrides,
  };
}

function unhealthyProbe(
  target: AppSpec = spec(),
  overrides: Partial<ProbeResult> = {},
): ProbeResult {
  return {
    state: "unhealthy",
    healthy: false,
    kind: "http",
    port: target.port,
    target: `http://127.0.0.1:${target.port}${target.health_path}`,
    attempts: 3,
    elapsedMs: 50,
    lastStatus: undefined,
    lastError: {
      kind: "connection-refused",
      code: "PROBE_CONNECTION_REFUSED",
      message: "connection refused",
      status: undefined,
      timeoutMs: undefined,
      causeCode: "ECONNREFUSED",
    },
    intervalMs: target.health_interval_ms,
    timeoutMs: target.health_timeout_ms,
    startupMs: target.health_startup_ms,
    ...overrides,
  };
}

function runResult(image: string, id = "container-new"): ContainerRunResult {
  return {
    app: APP,
    container: containerName(APP),
    id,
    image,
    port: 8080,
    containerPort: 3000,
    bind: "0.0.0.0",
    volumes: [],
    environmentNames: [],
  };
}

interface HarnessOptions {
  readonly spec?: Partial<AppSpecInput>;
  readonly health?: "healthy" | "unhealthy";
  readonly container?: "running" | "stopped" | "missing";
  readonly seedState?: boolean;
  readonly runningImage?: string;
}

class Harness {
  readonly root: string;
  readonly paths: Paths;
  readonly registry: Registry;
  readonly runtime = new FakeRuntime();
  readonly builder = new FakeBuilder();
  readonly prober = new FakeProber();
  readonly source = new FakeSource();
  readonly output = new RecordingOutput();
  readonly retention = new FakeRetention();
  readonly appSpec: AppSpec;
  readonly appDir: string;

  constructor(options: HarnessOptions = {}) {
    this.root = mkdtempSync(path.join(tmpdir(), "easy-host-update-"));
    roots.push(this.root);
    this.paths = createPaths({ env: { EASY_HOST_HOME: this.root } });
    this.paths.ensureLayout();
    this.registry = new Registry(this.paths);
    this.registry.create(APP);
    this.appSpec = spec(options.spec);
    this.registry.writeConfig(APP, this.appSpec);
    this.appDir = this.registry.record(APP).directory;

    mkdirSync(path.join(this.appDir, "workspace"), { recursive: true });
    writeFileSync(path.join(this.appDir, "workspace", "marker.txt"), "checkout\n");

    const store = this.stateStore();
    if (options.seedState !== false) {
      store.update({
        images: { current: CURRENT, previous: OLDER },
        containerId: "container-old",
        health: {
          status: options.health ?? "healthy",
          checkedAt: FIXED_TIME.toISOString(),
          detail: "seeded by the test",
        },
      });
    }

    if (options.container === "missing") {
      this.runtime.inspectResult = new NotFoundError(
        `container "${containerName(APP)}" was not found`,
        {
          code: "CONTAINER_NOT_FOUND",
        },
      );
    } else {
      this.runtime.inspectResult = {
        id: "container-old",
        image: options.runningImage ?? CURRENT,
        state: { running: options.container !== "stopped" },
      };
    }

    this.runtime.runQueue.push(runResult(CURRENT, "container-new"));
    this.source.prepared = undefined;
  }

  stateStore(): StateStore {
    return new StateStore(this.appDir, { clock: () => FIXED_TIME });
  }

  state(): ReturnType<StateStore["readCache"]> {
    return this.stateStore().readCache();
  }

  config(): AppSpec {
    return parseConfigToml(readFileSync(this.registry.record(APP).configPath, "utf8"));
  }

  dependencies(overrides: Partial<UpdateDependencies> = {}): UpdateDependencies {
    return {
      paths: this.paths,
      registry: this.registry,
      runtime: this.runtime,
      builder: this.builder,
      prober: this.prober,
      source: this.source,
      stateStore: () => this.stateStore(),
      output: this.output,
      retain: (request) => this.retention.retain(request),
      environment: {},
      clock: () => FIXED_TIME,
      ...overrides,
    };
  }

  run(request: Partial<UpdateRequest> = {}, overrides: Partial<UpdateDependencies> = {}) {
    return updateApp({ app: APP, ...request }, this.dependencies(overrides));
  }

  async command(
    options: { readonly rebuild?: boolean; readonly changes?: UpdateRequest["changes"] } = {},
  ) {
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const exitCode = await runUpdateCommand({
      app: APP,
      ...(options.rebuild === undefined ? {} : { rebuild: options.rebuild }),
      ...(options.changes === undefined ? {} : { changes: options.changes }),
      stdout,
      stderr,
      environment: {},
      dependencies: this.dependencies(),
    });

    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  }
}

describe("UPD-FR-04 no-op and unhealthy apps", () => {
  it("reports an explicit no-op without a build, container change, or config write", async () => {
    const harness = new Harness();
    const before = harness.state();
    harness.source.headCommit = COMMIT_ONE;
    harness.source.prepared = { commit: COMMIT_ONE } as Partial<PreparedWorkspace>;
    const configBefore = readFileSync(harness.registry.record(APP).configPath, "utf8");

    const result = await harness.run();

    expect(result.status).toBe("no-op");
    expect(result.kind).toBe("no-op");
    expect(result.image).toBe(CURRENT);
    expect(result.previousImage).toBe(OLDER);
    expect(result.candidateImage).toBeNull();
    expect(result.changes).toEqual([]);
    expect(result.skipped).toContain("image build");
    expect(harness.builder.requests).toHaveLength(0);
    expect(harness.runtime.mutations()).toEqual([]);
    expect(readFileSync(harness.registry.record(APP).configPath, "utf8")).toBe(configBefore);
    expect(harness.state()).toEqual(before);
    expect(harness.output.phases).toContain("skipped");
    expect(harness.output.text).toContain("nothing changed");
    // The source was checked (one HEAD read and one fetch/checkout) but the
    // checkout stayed on the commit the serving image was built from.
    expect(harness.source.headCalls).toBe(1);
    expect(harness.source.prepareCalls).toHaveLength(1);
  });

  it("exits 5 for an unknown app without touching the runtime", async () => {
    const harness = new Harness();

    await expect(
      updateApp({ app: "does-not-exist" }, harness.dependencies()),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(harness.runtime.calls).toEqual([]);
    expect(harness.builder.requests).toHaveLength(0);
  });

  it("returns exit code 0 and says nothing changed through the command", async () => {
    const harness = new Harness();
    harness.source.headCommit = COMMIT_ONE;
    harness.source.prepared = { commit: COMMIT_ONE } as Partial<PreparedWorkspace>;

    const { exitCode, stdout, stderr } = await harness.command();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('no changes for "blog"');
    expect(stdout).toContain("nothing");
    expect(stdout).toContain("image build");
    expect(stderr).toBe("");
  });

  it("rebuilds when the configured ref moved instead of reporting a false no-op", async () => {
    const harness = new Harness();
    harness.source.headCommit = COMMIT_ONE;
    harness.source.prepared = { commit: COMMIT_TWO } as Partial<PreparedWorkspace>;
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();

    expect(result.status).toBe("updated");
    expect(result.kind).toBe("rebuild");
    expect(result.sourceChanged).toBe(true);
    expect(result.commit).toBe(COMMIT_TWO);
    expect(harness.builder.requests).toHaveLength(1);
    expect(harness.runtime.runImages()).toEqual([CANDIDATE]);
    expect(result.previousImage).toBe(CURRENT);

    const state = harness.state();
    expect(state?.images.current).toBe(CANDIDATE);
    expect(state?.images.previous).toBe(CURRENT);
  });

  it("updates an app whose recorded health is unhealthy by recreating the image", async () => {
    const harness = new Harness({ health: "unhealthy" });
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();

    expect(result.status).toBe("updated");
    expect(result.kind).toBe("config-only");
    expect(harness.builder.requests).toHaveLength(0);
    expect(harness.runtime.runImages()).toEqual([CURRENT]);
    expect(harness.state()?.health.status).toBe("healthy");
    expect(harness.state()?.images.current).toBe(CURRENT);
    expect(harness.state()?.images.previous).toBe(OLDER);
  });

  it("repairs an app whose container is missing from the recorded image", async () => {
    const harness = new Harness({ container: "missing" });
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();

    expect(result.status).toBe("updated");
    expect(result.kind).toBe("config-only");
    expect(harness.builder.requests).toHaveLength(0);
    expect(harness.runtime.runImages()).toEqual([CURRENT]);
    expect(harness.state()?.images.previous).toBe(OLDER);
  });
});

describe("UPD-FR-05 config-only updates", () => {
  it("recreates the container with the new settings without invoking the builder", async () => {
    const harness = new Harness({ spec: { env: { LOG_LEVEL: "info" } } });
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run({ changes: { env: { LOG_LEVEL: "debug" } } });

    expect(result.status).toBe("updated");
    expect(result.kind).toBe("config-only");
    // The inline table and the merged environment both report the same change;
    // values never appear, only the field/name.
    expect(result.changes.map((change) => change.field)).toEqual(["env", "environment.LOG_LEVEL"]);
    expect(harness.builder.requests).toHaveLength(0);
    expect(harness.runtime.runImages()).toEqual([CURRENT]);
    expect(result.configApplied).toBe(true);
    expect(harness.config().env).toEqual({ LOG_LEVEL: "debug" });

    const state = harness.state();
    expect(state?.images.current).toBe(CURRENT);
    expect(state?.images.previous).toBe(OLDER);
    expect(state?.health.status).toBe("healthy");
  });

  it("creates a newly declared volume before the recreate", async () => {
    const harness = new Harness();
    harness.prober.queue.push(healthyProbe());

    await harness.run({ changes: { volumes: { data: "/var/lib/data" } } });

    const create = harness.runtime.calls.find((call) => call.method === "createVolume");
    expect(create?.options).toMatchObject({ app: APP, volume: "data", ignoreExisting: true });
    expect(harness.builder.requests).toHaveLength(0);
  });

  it("applies a new host port on the recreated container", async () => {
    const harness = new Harness();
    harness.prober.queue.push(healthyProbe(spec({ port: 8090 })));

    const result = await harness.run({ changes: { port: 8090 } });

    expect(result.port).toBe(8090);
    expect(harness.runtime.runImages()).toEqual([CURRENT]);
    const run = harness.runtime.calls.find((call) => call.method === "runContainer");
    expect(run?.options.port).toBe(8090);
    expect(harness.config().port).toBe(8090);
  });

  it("writes an env_file change to config.toml after the recreate", async () => {
    const harness = new Harness();
    writeFileSync(path.join(harness.appDir, "other.env"), "FEATURE=on\n");
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run({ changes: { env_file: "other.env" } });

    expect(result.kind).toBe("config-only");
    expect(result.configApplied).toBe(true);
    expect(harness.config().env_file).toBe("other.env");
    expect(harness.builder.requests).toHaveLength(0);
  });
});

describe("rebuild safety and failure ordering", () => {
  it("stops before the old container is touched when the build fails", async () => {
    const harness = new Harness();
    harness.builder.fail = new BuildError("railpack could not build the app", {
      code: "BUILD_PROVIDER_FAILED",
    });
    const stateBefore = harness.state();
    const configBefore = readFileSync(harness.registry.record(APP).configPath, "utf8");

    await expect(harness.run({ changes: { ref: "v2" } })).rejects.toBeInstanceOf(BuildError);

    expect(harness.runtime.mutations()).toEqual([]);
    expect(harness.state()).toEqual(stateBefore);
    expect(readFileSync(harness.registry.record(APP).configPath, "utf8")).toBe(configBefore);
    expect(harness.output.phases).toContain("failed");
    expect(existsSync(path.join(harness.appDir, "workspace"))).toBe(false);
  });

  it("exits 4 through the command when the candidate is reverted", async () => {
    const harness = new Harness();
    harness.prober.queue.push(unhealthyProbe(), healthyProbe());
    harness.runtime.runQueue.push(runResult(CURRENT, "container-recovered"));

    const { exitCode, stdout, stderr } = await harness.command({ rebuild: true });

    expect(exitCode).toBe(4);
    expect(stdout).toBe("");
    expect(stderr).toContain("the previous version is serving again");
    expect(stderr).toContain(CURRENT);
    expect(harness.state()?.images.current).toBe(CURRENT);
    expect(harness.state()?.images.previous).toBe(OLDER);
  });

  it("exits 3 through the command for a build failure", async () => {
    const harness = new Harness();
    harness.builder.fail = new BuildError("railpack could not build the app", {
      code: "BUILD_PROVIDER_FAILED",
    });

    const { exitCode, stdout, stderr } = await harness.command({ rebuild: true });

    expect(exitCode).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).toContain("railpack could not build the app");
    expect(harness.runtime.mutations()).toEqual([]);
  });

  it("leaves the previous image serving and records no new pair when the candidate fails", async () => {
    const harness = new Harness();
    harness.prober.queue.push(unhealthyProbe(), healthyProbe());
    harness.runtime.runQueue.push(runResult(CURRENT, "container-recovered"));

    const error = await harness.run({ rebuild: true }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HealthError);
    const health = error as HealthError;
    expect(health.exitCode).toBe(4);
    expect(health.details.candidate).toBe(CANDIDATE);
    expect(health.details.image).toBe(CURRENT);
    expect(health.details.restored).toBe(true);
    expect(health.details.state).toBe("reverted");

    const state = harness.state();
    expect(state?.images.current).toBe(CURRENT);
    expect(state?.images.previous).toBe(OLDER);
    expect(state?.health.status).toBe("healthy");
    expect(harness.runtime.runImages()).toEqual([CANDIDATE, CURRENT]);
    expect(harness.config()).toEqual(harness.appSpec);
    // The checkout was ahead of the restored image; dropping it makes the next
    // update retry the same source instead of reporting a false no-op.
    expect(existsSync(path.join(harness.appDir, "workspace"))).toBe(false);

    harness.source.headCommit = undefined;
    harness.prober.queue.push(unhealthyProbe(), healthyProbe());
    harness.runtime.runQueue.push(runResult(CURRENT, "container-recovered-2"));

    await expect(harness.run({ rebuild: true })).rejects.toBeInstanceOf(HealthError);
    expect(harness.builder.requests).toHaveLength(2);
    expect(harness.state()?.images.current).toBe(CURRENT);
  });

  it("reports both failures when the previous image cannot be restored", async () => {
    const harness = new Harness();
    harness.prober.queue.push(unhealthyProbe(), unhealthyProbe());
    harness.runtime.runQueue.push(runResult(CURRENT, "container-recovered"));

    const error = await harness.run({ rebuild: true }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HealthError);
    const health = error as HealthError;
    expect(health.exitCode).toBe(4);
    expect(health.details.restored).toBe(false);
    expect(health.details.state).toBe("unhealthy");
    expect(String(health.details.previous)).toContain("not healthy");
    expect(harness.state()?.images.current).toBe(CURRENT);
    expect(harness.state()?.images.previous).toBe(OLDER);
  });

  it("restores the previous port and environment, not the failed settings", async () => {
    const harness = new Harness({ spec: { env: { MARKER: "old" } } });
    harness.prober.queue.push(unhealthyProbe(spec({ port: 8090 })), healthyProbe());
    harness.runtime.runQueue.push(runResult(CURRENT, "container-recovered"));

    await expect(
      harness.run({ changes: { port: 8090, env: { MARKER: "new" } } }),
    ).rejects.toBeInstanceOf(HealthError);

    const runs = harness.runtime.calls.filter((call) => call.method === "runContainer");
    expect(runs.map((call) => call.options.port)).toEqual([8090, 8080]);
    expect(runs.map((call) => call.options.environment)).toEqual([
      { MARKER: "new" },
      { MARKER: "old" },
    ]);
    expect(harness.prober.specs.map((probe) => probe.port)).toEqual([8090, 8080]);
    expect(harness.config().port).toBe(8080);
    expect(harness.state()?.images.current).toBe(CURRENT);
    expect(harness.state()?.images.previous).toBe(OLDER);
  });

  it("keeps config.toml unchanged when a config-changing candidate is reverted", async () => {
    const harness = new Harness({ spec: { env: { LOG_LEVEL: "info" } } });
    harness.prober.queue.push(unhealthyProbe(), healthyProbe());

    await expect(harness.run({ changes: { env: { LOG_LEVEL: "debug" } } })).rejects.toBeInstanceOf(
      HealthError,
    );

    expect(harness.config().env).toEqual({ LOG_LEVEL: "info" });
    expect(harness.runtime.runImages()).toEqual([CURRENT, CURRENT]);
  });

  it("writes the new config only after a successful rebuild", async () => {
    const harness = new Harness();
    harness.source.prepared = { commit: COMMIT_TWO, ref: "v2" } as Partial<PreparedWorkspace>;
    harness.prober.queue.push(healthyProbe(spec({ ref: "v2" })));

    const result = await harness.run({ changes: { ref: "v2" } });

    expect(result.kind).toBe("rebuild");
    expect(result.configApplied).toBe(true);
    expect(harness.config().ref).toBe("v2");
    expect(harness.state()?.images.current).toBe(CANDIDATE);
  });
});

describe("locking", () => {
  it("exits 6 without side effects when another update holds the app lock", async () => {
    const harness = new Harness();
    const lock = acquireAppLock(harness.appDir, { operation: "update" });

    try {
      const error = await harness.run().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).exitCode).toBe(6);
      expect((error as ConflictError).details.pid).toBe(process.pid);
      expect(harness.builder.requests).toHaveLength(0);
      expect(harness.runtime.mutations()).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it("exits 6 through the command when the lock is held", async () => {
    const harness = new Harness();
    const lock = acquireAppLock(harness.appDir, { operation: "update" });

    try {
      const { exitCode, stdout, stderr } = await harness.command();

      expect(exitCode).toBe(6);
      expect(stdout).toBe("");
      expect(stderr).toContain("update");
      expect(stderr).toContain(String(process.pid));
      expect(harness.runtime.mutations()).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it("releases the lock after a failed build so a retry can proceed", async () => {
    const harness = new Harness();
    harness.builder.fail = new BuildError("boom", { code: "BUILD_PROVIDER_FAILED" });

    await expect(harness.run({ rebuild: true })).rejects.toBeInstanceOf(BuildError);

    const lock = acquireAppLock(harness.appDir, { operation: "retry" });
    lock.release();
    expect(harness.runtime.mutations()).toEqual([]);
  });
});

describe("reporting", () => {
  it("reports what changed, what was skipped, and the final health", async () => {
    const harness = new Harness({ spec: { env: { LOG_LEVEL: "info" } } });
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run({ changes: { env: { LOG_LEVEL: "debug" } } });
    const report = formatUpdateResult(result);

    expect(report).toContain('updated "blog" (config-only)');
    expect(report).toContain("changed:    env (config-only)");
    expect(report).toContain("skipped:    image build");
    expect(report).toContain(`image:      ${CURRENT}`);
    expect(report).toContain(`previous:   ${OLDER}`);
    expect(report).toContain("health:     healthy after 1 attempt(s)");
    expect(report).toContain(`url:        http://localhost:8080${harness.appSpec.health_path}`);
  });

  it("never prints an environment value", async () => {
    const harness = new Harness({ spec: { env: { TOKEN: "before" } } });
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run({ changes: { env: { TOKEN: SECRET_VALUE } } });
    const report = formatUpdateResult(result);

    expect(report).toContain("env");
    expect(report).not.toContain(SECRET_VALUE);
    expect(harness.output.text).not.toContain(SECRET_VALUE);
  });

  it("reports the phase order through a rebuild and swap", async () => {
    const harness = new Harness();
    harness.source.headCommit = COMMIT_ONE;
    harness.source.prepared = { commit: COMMIT_TWO } as Partial<PreparedWorkspace>;
    harness.prober.queue.push(healthyProbe());

    await harness.run();

    expect(harness.output.phases).toEqual([
      "validating",
      "locking",
      "inspecting",
      "fetching",
      "building",
      "stopping",
      "starting",
      "probing",
      "keeping",
    ]);
  });

  it("narrates a build failure before any stop", async () => {
    const harness = new Harness();
    harness.builder.fail = new BuildError("boom", { code: "BUILD_PROVIDER_FAILED" });

    await harness.run({ rebuild: true }).catch(() => undefined);

    expect(harness.output.phases).toEqual([
      "validating",
      "locking",
      "inspecting",
      "fetching",
      "building",
      "failed",
    ]);
    expect(harness.output.phases).not.toContain("stopping");
  });

  it("can be rendered by the default output without ANSI escapes", () => {
    const stream = new RecordingStream();
    const output = createDefaultUpdateOutput(stream);
    output.phase("building", "building a candidate");

    expect(stream.text).toBe("update: building: building a candidate\n");
  });
});

describe("RBK-FR-02 post-success retention", () => {
  it("prunes old images after a successful rebuild and reports them", async () => {
    const harness = new Harness();
    harness.source.headCommit = COMMIT_ONE;
    harness.source.prepared = { commit: COMMIT_TWO } as Partial<PreparedWorkspace>;
    harness.prober.queue.push(healthyProbe());
    harness.retention.result = {
      ...emptyRetention(),
      examined: 3,
      removed: [STALE_IMAGE],
      notes: [`removed ${STALE_IMAGE}`],
    };

    const result = await harness.run();

    expect(result.status).toBe("updated");
    expect(result.kind).toBe("rebuild");
    expect(harness.retention.calls).toBe(1);
    expect(harness.retention.requests[0]?.app).toBe(APP);
    expect(harness.output.text).toContain(`retention removed 1 old image(s): ${STALE_IMAGE}`);
  });

  it("does not prune on a no-op", async () => {
    const harness = new Harness();
    harness.source.headCommit = COMMIT_ONE;
    harness.source.prepared = { commit: COMMIT_ONE } as Partial<PreparedWorkspace>;

    const result = await harness.run();

    expect(result.status).toBe("no-op");
    expect(harness.retention.calls).toBe(0);
  });

  it("treats a retention failure as a warning, not an update failure", async () => {
    const harness = new Harness();
    harness.retention.failure = new Error("podman images failed");
    harness.prober.queue.push(healthyProbe());

    const { exitCode, stdout } = await harness.command({
      changes: { env: { LOG_LEVEL: "debug" } },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('updated "blog"');
    expect(harness.output.text).toContain("old images could not be pruned");
    expect(harness.output.text).toContain("podman images failed");
  });
});

describe("state and source edge cases", () => {
  it("rebuilds when state.json is missing", async () => {
    const harness = new Harness({ seedState: false });
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();

    expect(result.kind).toBe("rebuild");
    expect(harness.builder.requests).toHaveLength(1);
    expect(harness.state()?.images.current).toBe(CANDIDATE);
    expect(harness.state()?.images.previous).toBe(CURRENT);
  });

  it("starts a first version when neither state nor a container records an image", async () => {
    const harness = new Harness({ seedState: false, container: "missing" });
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();

    expect(result.kind).toBe("rebuild");
    expect(result.previousImage).toBeNull();
    expect(harness.state()?.images.current).toBe(CANDIDATE);
    expect(harness.state()?.images.previous).toBeNull();
    expect(harness.runtime.runImages()).toEqual([CANDIDATE]);
  });

  it("removes the first candidate but keeps the image when its probe fails", async () => {
    const harness = new Harness({ seedState: false, container: "missing" });
    harness.prober.queue.push(unhealthyProbe());

    await expect(harness.run({ rebuild: true })).rejects.toBeInstanceOf(HealthError);

    expect(harness.state()?.images.current).toBe(CANDIDATE);
    expect(harness.state()?.health.status).toBe("unhealthy");
    expect(harness.runtime.mutations()).toEqual([
      "stopContainer",
      "removeContainer",
      "runContainer",
      "stopContainer",
      "removeContainer",
    ]);
  });

  it("bounds a first-version probe that never settles", async () => {
    const harness = new Harness({ seedState: false, container: "missing" });
    harness.prober.queue.push("hang");

    const error = await harness.run({ rebuild: true }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HealthError);
    expect(String((error as HealthError).details.reason)).toContain("did not finish");
    expect(harness.state()?.health.status).toBe("unhealthy");
    expect(harness.runtime.runImages()).toEqual([CANDIDATE]);
  }, 5_000);

  it("uses the running image when state.json is missing but a container exists", async () => {
    const harness = new Harness({ seedState: false, runningImage: OLDER });
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();

    expect(result.previousImage).toBe(OLDER);
    expect(harness.runtime.runImages()).toEqual([CANDIDATE]);
  });

  it("reports a no-op for an unchanged local-mode app without touching git", async () => {
    const harness = new Harness({ spec: { repo: undefined, local_path: "workspace" } });

    const result = await harness.run();

    expect(result.status).toBe("no-op");
    expect(harness.source.headCalls).toBe(0);
    expect(harness.source.prepareCalls).toHaveLength(0);
    expect(harness.builder.requests).toHaveLength(0);
  });

  it("accepts a local-mode app and never tries to inspect a git HEAD", async () => {
    const harness = new Harness({ spec: { repo: undefined, local_path: "workspace" } });
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run({ changes: { health_path: "/healthz" } });

    expect(result.kind).toBe("config-only");
    expect(harness.source.headCalls).toBe(0);
    expect(harness.builder.requests).toHaveLength(0);
  });

  it("keeps a config-only update's recorded health when the swap records nothing", async () => {
    const harness = new Harness();
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run({ changes: { bind: "127.0.0.1" } });

    expect(result.stateRecorded).toBe(true);
    expect(harness.state()?.containerId).toBe("container-new");
    expect(harness.state()?.images.current).toBe(CURRENT);
    expect(harness.state()?.images.previous).toBe(OLDER);
    expect(harness.runtime.runImages()).toEqual([CURRENT]);
  });
});

describe("diff observation mapping", () => {
  it("treats a container that reports a different image as a rebuild", async () => {
    const harness = new Harness({ runningImage: "localhost/easy-host-blog:20261027T120000Z" });
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();

    expect(result.kind).toBe("rebuild");
    expect(harness.builder.requests).toHaveLength(1);
  });

  it("maps inspect results to the narrow diff observation", () => {
    const observation: UpdateContainerObservation = {
      state: { running: true },
      image: CURRENT,
    };

    expect(observation.state.running).toBe(true);
    expect(observation.image).toBe(CURRENT);
  });
});
