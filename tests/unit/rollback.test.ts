/**
 * Rollback orchestration and command (`RBK-1.1`, RBK-FR-01, RBK-FR-05,
 * RBK-NF-02).
 *
 * Every test injects the runtime, probe, output, and clock. The registry and
 * state cache are the real filesystem implementations under a temporary state
 * root, so the suite proves the file rollback actually writes: `state.json`
 * gains the swapped image pair only after a healthy candidate, and keeps the
 * pair untouched when the candidate fails.
 *
 * The safety rules get their own assertions:
 *
 * - two distinct recorded images are required, and anything less exits 5
 *   before a container is touched (`RBK-FR-01`);
 * - a second rollback returns to the newer image, proving the pair is swapped
 *   rather than overwritten;
 * - a failed candidate restarts the image that was serving before and exits 4
 *   with the pair unchanged;
 * - lock contention exits 6 and names the holding operation (`RBK-FR-05`);
 * - no builder is invoked, and no image is removed (`RBK-NF-02`).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRollbackResult, runRollbackCommand } from "../../src/cli/commands/rollback.js";
import { ConflictError, HealthError, NotFoundError, UsageError } from "../../src/cli/errors.js";
import { validateAppSpec } from "../../src/config/parse.js";
import type { AppSpec, AppSpecInput } from "../../src/config/schema.js";
import type { ProbeAppSpec, ProbeResult } from "../../src/health/probe.js";
import type { AddBuilder, AddBuildRequest } from "../../src/lifecycle/add.js";
import {
  createDefaultRollbackOutput,
  ROLLBACK_FAILURE_CODES,
  type RollbackDependencies,
  type RollbackOutput,
  type RollbackPhase,
  type RollbackStateStore,
  rollbackApp,
} from "../../src/lifecycle/rollback.js";
import type { SwapProber, SwapRuntime } from "../../src/lifecycle/swap.js";
import { acquireAppLock } from "../../src/platform/lock.js";
import { createPaths, type Paths } from "../../src/platform/paths.js";
import {
  type ContainerRunResult,
  containerName,
  type RemoveContainerOptions,
  type RunContainerOptions,
  type StopContainerOptions,
} from "../../src/platform/podman.js";
import { StateStore } from "../../src/registry/state.js";
import { Registry } from "../../src/registry/store.js";

const APP = "blog";
const REPO = "https://github.com/example/blog.git";
const CURRENT = "localhost/easy-host-blog:20261029T120000Z";
const OLDER = "localhost/easy-host-blog:20261028T120000Z";
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

class RecordingOutput implements RollbackOutput {
  readonly phases: RollbackPhase[] = [];
  readonly lines: string[] = [];

  phase(phase: RollbackPhase, message: string): void {
    this.phases.push(phase);
    this.lines.push(`rollback: ${phase}: ${message}`);
  }

  info(message: string): void {
    this.lines.push(`rollback: ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`rollback: warning: ${message}`);
  }

  get text(): string {
    return this.lines.join("\n");
  }
}

interface RuntimeCall {
  readonly method: string;
  readonly options: Record<string, unknown>;
}

class FakeRuntime implements SwapRuntime {
  readonly calls: RuntimeCall[] = [];
  readonly runQueue: Array<ContainerRunResult | Error> = [];
  readonly stopQueue: Array<Error | undefined> = [];
  readonly removeQueue: Array<Error | undefined> = [];

  async stopContainer(options: StopContainerOptions): Promise<unknown> {
    this.calls.push({ method: "stopContainer", options: { ...options } });
    const failure = this.stopQueue.shift();
    if (failure !== undefined) {
      throw failure;
    }
    return { app: options.app, container: containerName(options.app), stopped: true };
  }

  async removeContainer(options: RemoveContainerOptions): Promise<unknown> {
    this.calls.push({ method: "removeContainer", options: { ...options } });
    const failure = this.removeQueue.shift();
    if (failure !== undefined) {
      throw failure;
    }
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

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  runImages(): string[] {
    return this.calls
      .filter((call) => call.method === "runContainer")
      .map((call) => call.options.image as string);
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
        // Deliberately never settles: the swap deadline must cut it off.
      });
    }
    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}

interface BuildCall {
  readonly request: AddBuildRequest;
}

class SpyBuilder implements AddBuilder {
  readonly calls: BuildCall[] = [];

  async build(request: AddBuildRequest): Promise<{ image: string }> {
    this.calls.push({ request });
    return { image: "localhost/easy-host-blog:built-never" };
  }
}

class FailingStateStore implements RollbackStateStore {
  readonly inner: StateStore;

  constructor(inner: StateStore) {
    this.inner = inner;
  }

  readCache() {
    return this.inner.readCache();
  }

  update(): unknown {
    throw new Error("the disk is full");
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

function runResult(image: string, id = "container-restored"): ContainerRunResult {
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

type Seed = "pair" | "one" | "same" | "none";

interface HarnessOptions {
  readonly seed?: Seed;
  readonly spec?: Partial<AppSpecInput>;
}

class Harness {
  readonly root: string;
  readonly paths: Paths;
  readonly registry: Registry;
  readonly runtime = new FakeRuntime();
  readonly prober = new FakeProber();
  readonly builder = new SpyBuilder();
  readonly output = new RecordingOutput();
  readonly appDir: string;

  constructor(options: HarnessOptions = {}) {
    this.root = mkdtempSync(path.join(tmpdir(), "easy-host-rollback-"));
    roots.push(this.root);
    this.paths = createPaths({ env: { EASY_HOST_HOME: this.root } });
    this.paths.ensureLayout();
    this.registry = new Registry(this.paths);
    this.registry.create(APP);
    this.registry.writeConfig(APP, spec(options.spec));
    this.appDir = this.registry.record(APP).directory;

    const seed = options.seed ?? "pair";
    if (seed !== "none") {
      this.stateStore().update({
        images:
          seed === "one"
            ? { current: CURRENT, previous: null }
            : seed === "same"
              ? { current: CURRENT, previous: CURRENT }
              : { current: CURRENT, previous: OLDER },
        containerId: "container-current",
        health: {
          status: "healthy",
          checkedAt: FIXED_TIME.toISOString(),
          detail: "seeded by the test",
        },
      });
    }
  }

  stateStore(): StateStore {
    return new StateStore(this.appDir, { clock: () => FIXED_TIME });
  }

  state(): ReturnType<StateStore["readCache"]> {
    return this.stateStore().readCache();
  }

  dependencies(
    overrides: Partial<RollbackDependencies> = {},
    stateStore?: (appDir: string) => RollbackStateStore,
  ): RollbackDependencies {
    return {
      registry: this.registry,
      runtime: this.runtime,
      prober: this.prober,
      stateStore: stateStore ?? (() => this.stateStore()),
      output: this.output,
      environment: {},
      clock: () => FIXED_TIME,
      ...overrides,
    };
  }

  run(
    overrides: Partial<RollbackDependencies> = {},
    stateStore?: (appDir: string) => RollbackStateStore,
  ) {
    return rollbackApp({ app: APP }, this.dependencies(overrides, stateStore));
  }

  async command(
    overrides: Partial<RollbackDependencies> = {},
    stateStore?: (appDir: string) => RollbackStateStore,
  ) {
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();
    const exitCode = await runRollbackCommand({
      app: APP,
      stdout,
      stderr,
      environment: {},
      dependencies: this.dependencies(overrides, stateStore),
    });

    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  }
}

function pairOf(state: ReturnType<StateStore["readCache"]>) {
  return { current: state?.images.current, previous: state?.images.previous };
}

describe("RBK-FR-01 health-gated rollback", () => {
  it("restores the previous image and swaps the recorded pair", async () => {
    const harness = new Harness();
    harness.runtime.runQueue.push(runResult(OLDER));
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();

    expect(result.status).toBe("rolled-back");
    expect(result.image).toBe(OLDER);
    expect(result.previousImage).toBe(CURRENT);
    expect(result.restoredImage).toBe(OLDER);
    expect(result.rollbackTarget).toBe(CURRENT);
    expect(result.containerId).toBe("container-restored");
    expect(result.container).toBe(containerName(APP));

    // Stop, remove, then run: the fixed container name must be free before the
    // candidate starts, and no other container operation happens.
    expect(harness.runtime.methods()).toEqual(["stopContainer", "removeContainer", "runContainer"]);
    expect(harness.runtime.runImages()).toEqual([OLDER]);

    const state = harness.state();
    expect(pairOf(state)).toEqual({ current: OLDER, previous: CURRENT });
    expect(state?.health.status).toBe("healthy");
    expect(state?.containerId).toBe("container-restored");

    expect(harness.output.phases).toEqual([
      "validating",
      "locking",
      "inspecting",
      "stopping",
      "starting",
      "probing",
      "keeping",
      "recording",
    ]);
    expect(result.phases).toEqual(["stopping", "starting", "probing", "keeping", "recording"]);
    expect(result.skipped).toEqual(["image build"]);
    expect(result.notes.join(" ")).toContain("Railpack and BuildKit were not invoked");
    expect(result.notes.join(" ")).toContain("no image was removed");
  });

  it("returns to the original image when rolled back a second time", async () => {
    const harness = new Harness();
    harness.runtime.runQueue.push(runResult(OLDER, "container-first"), runResult(CURRENT));
    harness.prober.queue.push(healthyProbe(), healthyProbe());

    const first = await harness.run();
    expect(first.restoredImage).toBe(OLDER);
    expect(first.rollbackTarget).toBe(CURRENT);
    expect(pairOf(harness.state())).toEqual({ current: OLDER, previous: CURRENT });

    const second = await harness.run();
    expect(second.restoredImage).toBe(CURRENT);
    expect(second.rollbackTarget).toBe(OLDER);
    expect(pairOf(harness.state())).toEqual({ current: CURRENT, previous: OLDER });

    expect(harness.runtime.runImages()).toEqual([OLDER, CURRENT]);
  });

  it("reuses the recorded image and never invokes a builder", async () => {
    const harness = new Harness();
    harness.runtime.runQueue.push(runResult(OLDER));
    harness.prober.queue.push(healthyProbe());

    // Attach a spy builder the type does not require: rollback has no builder
    // dependency at all, so it must stay untouched.
    const dependencies = {
      ...harness.dependencies(),
      builder: harness.builder,
    } as RollbackDependencies;
    const result = await rollbackApp({ app: APP }, dependencies);

    expect(result.image).toBe(OLDER);
    expect(harness.builder.calls).toHaveLength(0);
    expect(harness.runtime.runImages()).toEqual([OLDER]);
    expect(harness.runtime.methods()).not.toContain("build");
  });

  it("starts the previous image with the recorded config and environment", async () => {
    const harness = new Harness({
      spec: {
        env: { LOG_LEVEL: "info", TOKEN: SECRET_VALUE },
        health_path: "/health",
        volumes: { data: "/var/lib/data" },
      },
    });
    harness.runtime.runQueue.push(runResult(OLDER));
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();

    const run = harness.runtime.calls.find((call) => call.method === "runContainer");
    expect(run?.options).toMatchObject({
      app: APP,
      image: OLDER,
      port: 8080,
      containerPort: 3000,
      bind: "0.0.0.0",
      environment: { LOG_LEVEL: "info", TOKEN: SECRET_VALUE },
      volumes: { data: "/var/lib/data" },
    });
    expect(result.url).toBe("http://localhost:8080/health");
    expect(result.bind).toBe("0.0.0.0");
  });

  it("recovers an app whose container disappeared", async () => {
    const harness = new Harness();
    harness.runtime.stopQueue.push(
      new NotFoundError(`container "${containerName(APP)}" was not found`, {
        code: "CONTAINER_NOT_FOUND",
      }),
    );
    harness.runtime.runQueue.push(runResult(OLDER));
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();

    expect(result.image).toBe(OLDER);
    expect(harness.runtime.runImages()).toEqual([OLDER]);
    expect(pairOf(harness.state())).toEqual({ current: OLDER, previous: CURRENT });
  });
});

describe("RBK-FR-01 two recorded images are required", () => {
  it("exits 5 when only one image is recorded and touches no container", async () => {
    const harness = new Harness({ seed: "one" });

    const error = await harness.run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).exitCode).toBe(5);
    expect((error as NotFoundError).code).toBe(ROLLBACK_FAILURE_CODES.ONE_IMAGE);
    expect((error as NotFoundError).details).toMatchObject({
      app: APP,
      current: CURRENT,
      previous: "none",
    });
    expect(harness.runtime.calls).toEqual([]);
    expect(pairOf(harness.state())).toEqual({ current: CURRENT, previous: null });
  });

  it("exits 5 through the command when only one image is recorded", async () => {
    const harness = new Harness({ seed: "one" });

    const { exitCode, stdout, stderr } = await harness.command();

    expect(exitCode).toBe(5);
    expect(stdout).toBe("");
    expect(stderr).toContain("fewer than two recorded images");
    expect(stderr).toContain(`easy-host update ${APP}`);
    expect(harness.runtime.calls).toEqual([]);
  });

  it("exits 5 when state.json is missing", async () => {
    const harness = new Harness({ seed: "none" });

    const error = await harness.run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).details).toMatchObject({ state: "missing" });
    expect(harness.runtime.calls).toEqual([]);
  });

  it("exits 5 when the recorded pair is the same image twice", async () => {
    const harness = new Harness({ seed: "same" });

    const error = await harness.run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).code).toBe(ROLLBACK_FAILURE_CODES.ONE_IMAGE);
    expect((error as NotFoundError).message).toContain("same image");
    expect(harness.runtime.calls).toEqual([]);
  });

  it("exits 5 for an unknown app before taking the lock or touching a container", async () => {
    const harness = new Harness();

    await expect(
      rollbackApp({ app: "does-not-exist" }, harness.dependencies()),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(harness.runtime.calls).toEqual([]);
  });

  it("exits 1 for an empty app name", async () => {
    const harness = new Harness();

    await expect(rollbackApp({ app: "  " }, harness.dependencies())).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(harness.runtime.calls).toEqual([]);
  });
});

describe("RBK-FR-01 a failed rollback leaves the serving image unchanged", () => {
  it("restarts the current image after an unhealthy candidate and exits 4", async () => {
    const harness = new Harness();
    harness.runtime.runQueue.push(runResult(OLDER, "container-candidate"), runResult(CURRENT));
    harness.prober.queue.push(unhealthyProbe(), healthyProbe());

    const error = await harness.run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HealthError);
    expect((error as HealthError).exitCode).toBe(4);
    expect((error as HealthError).code).toBe(ROLLBACK_FAILURE_CODES.CANDIDATE_FAILED);
    expect((error as HealthError).details).toMatchObject({
      app: APP,
      stage: "probe",
      candidate: OLDER,
      serving: CURRENT,
      restored: true,
      image: CURRENT,
      rollback: OLDER,
      state: "reverted",
    });

    // Candidate first, then the previously serving image.
    expect(harness.runtime.runImages()).toEqual([OLDER, CURRENT]);

    const state = harness.state();
    expect(pairOf(state)).toEqual({ current: CURRENT, previous: OLDER });
    expect(state?.health.status).toBe("healthy");
    expect(state?.containerId).toBe("container-restored");
    expect(harness.output.phases).toEqual([
      "validating",
      "locking",
      "inspecting",
      "stopping",
      "starting",
      "probing",
      "reverting",
      "reverted",
    ]);
    expect(harness.output.text).toContain("is serving again");
  });

  it("exits 4 through the command and names the restored version", async () => {
    const harness = new Harness();
    harness.runtime.runQueue.push(runResult(OLDER), runResult(CURRENT));
    harness.prober.queue.push(unhealthyProbe(), healthyProbe());

    const { exitCode, stdout, stderr } = await harness.command();

    expect(exitCode).toBe(4);
    expect(stdout).toBe("");
    expect(stderr).toContain('rollback of "blog" failed');
    expect(stderr).toContain("is serving again");
    expect(stderr).toContain(`easy-host rollback ${APP}`);
    expect(pairOf(harness.state())).toEqual({ current: CURRENT, previous: OLDER });
  });

  it("restarts the current image after a candidate start failure", async () => {
    const harness = new Harness();
    harness.runtime.runQueue.push(new Error("candidate refused to start"), runResult(CURRENT));
    harness.prober.queue.push(healthyProbe());

    const error = await harness.run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HealthError);
    expect((error as HealthError).details).toMatchObject({
      stage: "start",
      restored: true,
      serving: CURRENT,
    });
    expect(harness.runtime.runImages()).toEqual([OLDER, CURRENT]);
    expect(pairOf(harness.state())).toEqual({ current: CURRENT, previous: OLDER });
  });

  it("reports an unrestored version when the recovery probe also fails", async () => {
    const harness = new Harness();
    harness.runtime.runQueue.push(runResult(OLDER), runResult(CURRENT));
    harness.prober.queue.push(unhealthyProbe(), unhealthyProbe());

    const error = await harness.run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HealthError);
    expect((error as HealthError).details).toMatchObject({
      restored: false,
      state: "unhealthy",
      serving: CURRENT,
    });
    const state = harness.state();
    expect(pairOf(state)).toEqual({ current: CURRENT, previous: OLDER });
    expect(state?.health.status).toBe("unhealthy");
  });

  it("warns and leaves the pair unrecorded when the state write fails after a healthy keep", async () => {
    const harness = new Harness();
    harness.runtime.runQueue.push(runResult(OLDER));
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run({}, (appDir) => new FailingStateStore(new StateStore(appDir)));

    expect(result.stateRecorded).toBe(false);
    expect(result.image).toBe(OLDER);
    expect(result.warnings.join(" ")).toContain("state.json could not be updated");
    // The on-disk pair is unchanged because no write completed.
    expect(pairOf(harness.state())).toEqual({ current: CURRENT, previous: OLDER });
  });
});

describe("RBK-FR-05 locking", () => {
  it("exits 6 and names the holding operation when the app lock is taken", async () => {
    const harness = new Harness();
    const lock = acquireAppLock(harness.appDir, { operation: "update" });

    try {
      const error = await harness.run().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).exitCode).toBe(6);
      expect((error as ConflictError).details.operation).toBe("update");
      expect((error as ConflictError).details.pid).toBe(process.pid);
      expect(harness.runtime.calls).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it("exits 6 through the command with the holder on stderr", async () => {
    const harness = new Harness();
    const lock = acquireAppLock(harness.appDir, { operation: "remove" });

    try {
      const { exitCode, stdout, stderr } = await harness.command();

      expect(exitCode).toBe(6);
      expect(stdout).toBe("");
      expect(stderr).toContain("remove");
      expect(stderr).toContain(String(process.pid));
      expect(harness.runtime.calls).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it("releases the lock after a failed rollback so a retry can proceed", async () => {
    const harness = new Harness();
    harness.runtime.runQueue.push(runResult(OLDER), runResult(CURRENT));
    harness.prober.queue.push(unhealthyProbe(), healthyProbe());

    await expect(harness.run()).rejects.toBeInstanceOf(HealthError);

    const lock = acquireAppLock(harness.appDir, { operation: "retry" });
    lock.release();
  });

  it("releases the lock after a successful rollback", async () => {
    const harness = new Harness();
    harness.runtime.runQueue.push(runResult(OLDER));
    harness.prober.queue.push(healthyProbe());

    await harness.run();

    const lock = acquireAppLock(harness.appDir, { operation: "retry" });
    lock.release();
  });
});

describe("preflight and reporting", () => {
  it("fails on a missing secrets file before touching a container", async () => {
    const harness = new Harness({ spec: { env_file: "missing.env" } });

    const error = await harness.run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(1);
    expect(harness.runtime.calls).toEqual([]);
    expect(pairOf(harness.state())).toEqual({ current: CURRENT, previous: OLDER });
  });

  it("prints the restored image and the new rollback target", async () => {
    const harness = new Harness({ spec: { health_path: "/health" } });
    harness.runtime.runQueue.push(runResult(OLDER));
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();
    const report = formatRollbackResult(result);

    expect(report).toContain('rolled back "blog"');
    expect(report).toContain(`restored:   ${OLDER}`);
    expect(report).toContain(`rollback:   ${CURRENT}`);
    expect(report).toContain(`container:  ${containerName(APP)}`);
    expect(report).toContain("health:     healthy after 1 attempt(s)");
    expect(report).toContain("url:        http://localhost:8080/health");

    // The command runs a second rollback: CURRENT again after the first swap.
    harness.runtime.runQueue.push(runResult(CURRENT));
    harness.prober.queue.push(healthyProbe());

    const { exitCode, stdout, stderr } = await harness.command();
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`restored:   ${CURRENT}`);
    expect(stdout).toContain(`rollback:   ${OLDER}`);
    expect(stderr).toBe("");
  });

  it("never prints an environment value", async () => {
    const harness = new Harness({ spec: { env: { TOKEN: SECRET_VALUE } } });
    harness.runtime.runQueue.push(runResult(OLDER));
    harness.prober.queue.push(healthyProbe());

    const result = await harness.run();
    const report = formatRollbackResult(result);

    expect(report).not.toContain(SECRET_VALUE);
    expect(harness.output.text).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("exposes a default reporter that writes plain text to stderr", () => {
    const stream = new RecordingStream();
    const output = createDefaultRollbackOutput(stream);

    output.phase("starting", "starting an image");
    output.warn("a warning");

    expect(stream.text).toBe(
      "rollback: starting: starting an image\nrollback: warning: a warning\n",
    );
  });

  it("keeps state.json untouched on a one-image refusal", async () => {
    const harness = new Harness({ seed: "one" });
    writeFileSync(path.join(harness.appDir, "marker.txt"), "unchanged\n");

    await harness.run().catch(() => undefined);

    expect(pairOf(harness.state())).toEqual({ current: CURRENT, previous: null });
    expect(harness.output.phases).toEqual(["validating", "locking"]);
  });
});
