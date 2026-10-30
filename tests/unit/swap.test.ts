/**
 * Health-gated swap (`UPD-FR-02`, `UPD-FR-03`, `UPD-NF-01`).
 *
 * Every test injects a fake runtime, probe, reporter, state writer, and clock,
 * so no Podman process, network request, or filesystem is involved. The call
 * order assertions prove the two safety rules that matter most: the old
 * container is stopped and removed before the candidate starts, and a failed
 * candidate is stopped and removed before the previous image is restarted.
 */

import { describe, expect, it } from "vitest";
import { NotFoundError, PrerequisiteError, UsageError } from "../../src/cli/errors.js";
import { validateAppSpec } from "../../src/config/parse.js";
import type { AppSpec } from "../../src/config/schema.js";
import type { ProbeAppSpec, ProbeResult } from "../../src/health/probe.js";
import {
  createDefaultSwapReporter,
  SWAP_FAILURE_CODES,
  type SwapDependencies,
  type SwapPhase,
  type SwapProber,
  type SwapReporter,
  type SwapRequest,
  type SwapRuntime,
  type SwapStateStore,
  swapApp,
  swapProbeDeadlineMs,
} from "../../src/lifecycle/swap.js";
import {
  type ContainerRunResult,
  containerName,
  type RemoveContainerOptions,
  type RunContainerOptions,
  type StopContainerOptions,
} from "../../src/platform/podman.js";
import type { AppStatePatch } from "../../src/registry/state.js";

const APP = "blog";
const CURRENT = "localhost/easy-host-blog:20261029T120000Z";
const CANDIDATE = "localhost/easy-host-blog:20261030T120000Z";
const OLDER = "localhost/easy-host-blog:20261028T120000Z";
const FIXED_TIME = new Date("2026-10-30T12:00:00.000Z");

const SPEC: AppSpec = validateAppSpec({
  repo: "https://github.com/example/blog.git",
  port: 8080,
  container_port: 3000,
  bind: "0.0.0.0",
  probe: "http",
  health_path: "/health",
  health_interval_ms: 10,
  health_timeout_ms: 10,
  health_startup_ms: 50,
  volumes: { data: "/var/lib/data" },
});

const SECRET = "super-secret-value";

class RecordingReporter implements SwapReporter {
  readonly phases: SwapPhase[] = [];
  readonly lines: string[] = [];

  phase(phase: SwapPhase, message: string): void {
    this.phases.push(phase);
    this.lines.push(`${phase}: ${message}`);
  }

  get text(): string {
    return this.lines.join("\n");
  }
}

interface RuntimeCall {
  readonly method: "stopContainer" | "removeContainer" | "runContainer";
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

  probe(spec: ProbeAppSpec): Promise<ProbeResult> {
    this.specs.push(spec);
    const next = this.queue.shift();
    if (next === "hang") {
      return new Promise<ProbeResult>(() => {
        // Deliberately never settles: the swap deadline must cut it off.
      });
    }
    if (next === undefined) {
      return Promise.reject(new Error("test did not queue a probe result"));
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }

    return Promise.resolve(next);
  }
}

class FakeState implements SwapStateStore {
  readonly patches: AppStatePatch[] = [];
  failure: Error | undefined;

  update(patch: AppStatePatch): unknown {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.patches.push(patch);
    return { ok: true };
  }
}

function healthyProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    state: "healthy",
    healthy: true,
    kind: "http",
    port: 8080,
    target: "http://127.0.0.1:8080/health",
    attempts: 1,
    elapsedMs: 5,
    lastStatus: 200,
    lastError: undefined,
    intervalMs: 10,
    timeoutMs: 10,
    startupMs: 50,
    ...overrides,
  };
}

function unhealthyProbe(status = 500, overrides: Partial<ProbeResult> = {}): ProbeResult {
  return healthyProbe({
    state: "unhealthy",
    healthy: false,
    lastStatus: status,
    lastError: {
      kind: "http-status",
      code: "PROBE_HTTP_STATUS",
      message: `HTTP ${status}`,
      status,
      timeoutMs: undefined,
      causeCode: undefined,
    },
    ...overrides,
  });
}

function runResult(image: string, id: string): ContainerRunResult {
  return {
    app: APP,
    container: containerName(APP),
    id,
    image,
    port: 8080,
    containerPort: 3000,
    bind: "0.0.0.0",
    volumes: ["easy-host-blog-data"],
    environmentNames: ["API_KEY", "PORT"],
  };
}

function request(overrides: Partial<SwapRequest> = {}): SwapRequest {
  return {
    app: APP,
    spec: SPEC,
    candidateImage: CANDIDATE,
    currentImage: CURRENT,
    previousImage: OLDER,
    environment: { API_KEY: SECRET },
    ...overrides,
  };
}

interface Harness {
  readonly runtime: FakeRuntime;
  readonly prober: FakeProber;
  readonly reporter: RecordingReporter;
  readonly state: FakeState;
  readonly dependencies: SwapDependencies;
  readonly warnings: string[];
}

function harness(overrides: SwapDependencies = {}): Harness {
  const runtime = new FakeRuntime();
  const prober = new FakeProber();
  const reporter = new RecordingReporter();
  const state = new FakeState();

  return {
    runtime,
    prober,
    reporter,
    state,
    warnings: [],
    dependencies: {
      runtime,
      prober,
      reporter,
      state,
      clock: () => FIXED_TIME,
      ...overrides,
    },
  };
}

describe("swapApp keep path", () => {
  it("stops the old container, starts the candidate, probes, and records the new image pair", async () => {
    const context = harness();
    context.runtime.runQueue.push(runResult(CANDIDATE, "candidate-id"));
    context.prober.queue.push(healthyProbe());

    const result = await swapApp(request(), context.dependencies);

    expect(result.status).toBe("kept");
    if (result.status !== "kept") {
      throw new Error("expected a kept result");
    }

    expect(result.image).toBe(CANDIDATE);
    expect(result.candidateImage).toBe(CANDIDATE);
    expect(result.previousImage).toBe(CURRENT);
    expect(result.images).toEqual({ current: CANDIDATE, previous: CURRENT });
    expect(result.containerId).toBe("candidate-id");
    expect(result.stateRecorded).toBe(true);
    expect(result.warnings).toEqual([]);

    // One container at a time: stop and remove the old container before the run.
    expect(context.runtime.methods()).toEqual(["stopContainer", "removeContainer", "runContainer"]);
    expect(context.runtime.runImages()).toEqual([CANDIDATE]);

    const runOptions = context.runtime.calls[2]?.options as unknown as RunContainerOptions;
    expect(runOptions).toMatchObject({
      app: APP,
      image: CANDIDATE,
      port: 8080,
      containerPort: 3000,
      bind: "0.0.0.0",
      environment: { API_KEY: SECRET },
      volumes: { data: "/var/lib/data" },
    });

    expect(context.prober.specs).toEqual([SPEC]);
    expect(context.reporter.phases).toEqual(["stopping", "starting", "probing", "keeping"]);

    expect(context.state.patches).toHaveLength(1);
    expect(context.state.patches[0]).toMatchObject({
      images: { current: CANDIDATE, previous: CURRENT },
      containerId: "candidate-id",
      health: { status: "healthy" },
    });
    expect(context.state.patches[0]?.health?.checkedAt).toBe(FIXED_TIME.toISOString());
  });

  it("reports a missing current container as already stopped and still completes the swap", async () => {
    const context = harness();
    context.runtime.stopQueue.push(
      new NotFoundError(`container "${containerName(APP)}" does not exist`, {
        code: "CONTAINER_NOT_FOUND",
      }),
    );
    context.runtime.runQueue.push(runResult(CANDIDATE, "candidate-id"));
    context.prober.queue.push(healthyProbe());

    const result = await swapApp(request(), context.dependencies);

    expect(result.status).toBe("kept");
    expect(context.runtime.methods()).toEqual(["stopContainer", "removeContainer", "runContainer"]);
  });

  it("keeps the candidate when the state cache cannot be written but reports the warning", async () => {
    const context = harness();
    context.runtime.runQueue.push(runResult(CANDIDATE, "candidate-id"));
    context.prober.queue.push(healthyProbe());
    context.state.failure = new Error("disk full");

    const result = await swapApp(request(), context.dependencies);

    expect(result.status).toBe("kept");
    expect(result.stateRecorded).toBe(false);
    expect(result.warnings.join("\n")).toContain("disk full");
    expect(result.phases).toContain("keeping");
  });

  it("does not leak environment values into phase output", async () => {
    const context = harness();
    context.runtime.runQueue.push(runResult(CANDIDATE, "candidate-id"));
    context.prober.queue.push(healthyProbe());

    await swapApp(request(), context.dependencies);

    expect(context.reporter.text).not.toContain(SECRET);
  });
});

describe("swapApp revert path", () => {
  it("restarts the previous image after an unhealthy candidate and reports it serving again", async () => {
    const context = harness();
    context.runtime.runQueue.push(
      runResult(CANDIDATE, "candidate-id"),
      runResult(CURRENT, "previous-id"),
    );
    context.prober.queue.push(unhealthyProbe(500), healthyProbe());

    const result = await swapApp(request(), context.dependencies);

    expect(result.status).toBe("reverted");
    if (result.status !== "reverted") {
      throw new Error("expected a reverted result");
    }

    expect(result.image).toBe(CURRENT);
    expect(result.failure.stage).toBe("probe");
    expect(result.failure.code).toBe(SWAP_FAILURE_CODES.CANDIDATE_UNHEALTHY);
    expect(result.failure.message).toContain("HTTP 500");
    expect(result.recovery).toMatchObject({
      attempted: true,
      image: CURRENT,
      started: true,
      healthy: true,
      containerId: "previous-id",
    });
    expect(result.recovery.message).toContain("is serving again");

    // Never zero containers for long: candidate stopped and removed before the
    // previous image starts under the same fixed container name.
    expect(context.runtime.methods()).toEqual([
      "stopContainer",
      "removeContainer",
      "runContainer",
      "stopContainer",
      "removeContainer",
      "runContainer",
    ]);
    expect(context.runtime.runImages()).toEqual([CANDIDATE, CURRENT]);
    expect(context.prober.specs).toHaveLength(2);
    expect(context.reporter.phases).toEqual([
      "stopping",
      "starting",
      "probing",
      "reverting",
      "reverted",
    ]);

    // UPD-FR-03: the image pair stays exactly as it was before the command.
    expect(result.images).toEqual({ current: CURRENT, previous: OLDER });
    expect(context.state.patches).toHaveLength(1);
    expect(context.state.patches[0]).not.toHaveProperty("images");
    expect(context.state.patches[0]).toMatchObject({
      containerId: "previous-id",
      health: { status: "healthy" },
    });
    expect(context.state.patches[0]?.health?.detail).toContain(CANDIDATE);
    expect(context.state.patches[0]?.health?.detail).toContain("serving again");
  });

  it("restores the previous config and environment, not the candidate's", async () => {
    const context = harness();
    const previousSpec: AppSpec = validateAppSpec({
      ...SPEC,
      port: 9090,
      bind: "127.0.0.1",
    });
    context.runtime.runQueue.push(
      runResult(CANDIDATE, "candidate-id"),
      runResult(CURRENT, "previous-id"),
    );
    context.prober.queue.push(unhealthyProbe(500), healthyProbe());

    const result = await swapApp(
      request({
        recoverySpec: previousSpec,
        recoveryEnvironment: { API_KEY: "previous-secret" },
      }),
      context.dependencies,
    );

    expect(result.status).toBe("reverted");
    expect(context.runtime.runImages()).toEqual([CANDIDATE, CURRENT]);

    const [candidateRun, recoveryRun] = context.runtime.calls.filter(
      (call) => call.method === "runContainer",
    );
    expect(candidateRun?.options).toMatchObject({
      port: 8080,
      bind: "0.0.0.0",
      environment: { API_KEY: SECRET },
    });
    expect(recoveryRun?.options).toMatchObject({
      port: 9090,
      bind: "127.0.0.1",
      environment: { API_KEY: "previous-secret" },
    });
    expect(context.prober.specs.map((probe) => probe.port)).toEqual([8080, 9090]);
  });

  it("reports an unhealthy previous image without pretending recovery", async () => {
    const context = harness();
    context.runtime.runQueue.push(
      runResult(CANDIDATE, "candidate-id"),
      runResult(CURRENT, "previous-id"),
    );
    context.prober.queue.push(unhealthyProbe(503), unhealthyProbe(502));

    const result = await swapApp(request(), context.dependencies);

    expect(result.status).toBe("reverted");
    if (result.status !== "reverted") {
      throw new Error("expected a reverted result");
    }

    expect(result.recovery.started).toBe(true);
    expect(result.recovery.healthy).toBe(false);
    expect(result.recovery.code).toBe(SWAP_FAILURE_CODES.RECOVERY_UNHEALTHY);
    expect(result.recovery.message).toContain("did not become healthy");
    expect(result.images).toEqual({ current: CURRENT, previous: OLDER });
    expect(context.state.patches).toHaveLength(1);
    expect(context.state.patches[0]).not.toHaveProperty("images");
    expect(context.state.patches[0]?.health?.status).toBe("unhealthy");
    expect(context.reporter.phases).toEqual([
      "stopping",
      "starting",
      "probing",
      "reverting",
      "reverted",
    ]);
  });

  it("reverts when the candidate container fails to start", async () => {
    const context = harness();
    context.runtime.runQueue.push(
      new PrerequisiteError('could not start container "easy-host-blog": port in use', {
        code: "CONTAINER_RUN_FAILED",
      }),
      runResult(CURRENT, "previous-id"),
    );
    context.prober.queue.push(healthyProbe());

    const result = await swapApp(request(), context.dependencies);

    expect(result.status).toBe("reverted");
    if (result.status !== "reverted") {
      throw new Error("expected a reverted result");
    }

    expect(result.failure.stage).toBe("start");
    expect(result.failure.code).toBe("CONTAINER_RUN_FAILED");
    expect(result.recovery.healthy).toBe(true);
    expect(context.runtime.methods()).toEqual([
      "stopContainer",
      "removeContainer",
      "runContainer",
      "stopContainer",
      "removeContainer",
      "runContainer",
    ]);
    expect(context.runtime.runImages()).toEqual([CANDIDATE, CURRENT]);
    expect(context.prober.specs).toHaveLength(1);
    expect(context.reporter.phases).toEqual(["stopping", "starting", "reverting", "reverted"]);
  });

  it("still restarts the previous image when candidate cleanup fails", async () => {
    const context = harness();
    context.runtime.runQueue.push(
      new Error("candidate crashed on start"),
      runResult(CURRENT, "previous-id"),
    );
    context.prober.queue.push(healthyProbe());
    // stop old (ok), stop candidate (fails), remove candidate (fails), remove old (ok)
    context.runtime.stopQueue.push(undefined, new PrerequisiteError("stop timed out"));
    context.runtime.removeQueue.push(undefined, new PrerequisiteError("remove timed out"));

    const result = await swapApp(request(), context.dependencies);

    expect(result.status).toBe("reverted");
    if (result.status !== "reverted") {
      throw new Error("expected a reverted result");
    }

    expect(result.recovery.healthy).toBe(true);
    expect(result.warnings.join("\n")).toContain("stop timed out");
    expect(result.warnings.join("\n")).toContain("remove timed out");
    expect(context.runtime.runImages()).toEqual([CANDIDATE, CURRENT]);
  });
});

describe("swapApp probe budget", () => {
  it("cuts off a hung candidate probe at the startup budget and reverts", async () => {
    const context = harness();
    const spec = { ...SPEC, health_startup_ms: 20, health_interval_ms: 5 };
    context.runtime.runQueue.push(
      runResult(CANDIDATE, "candidate-id"),
      runResult(CURRENT, "previous-id"),
    );
    context.prober.queue.push("hang", healthyProbe());

    const startedAt = Date.now();
    const result = await swapApp(request({ spec }), context.dependencies);
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe("reverted");
    if (result.status !== "reverted") {
      throw new Error("expected a reverted result");
    }

    expect(result.failure.stage).toBe("budget");
    expect(result.failure.code).toBe(SWAP_FAILURE_CODES.PROBE_TIMEOUT);
    expect(result.failure.message).toContain(`${swapProbeDeadlineMs(spec)}ms`);
    expect(result.recovery.healthy).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(swapProbeDeadlineMs(spec));
    expect(elapsedMs).toBeLessThan(1_000);
    expect(context.reporter.phases).toEqual([
      "stopping",
      "starting",
      "probing",
      "reverting",
      "reverted",
    ]);
  });

  it("bounds the recovery probe too and reports the previous image as unhealthy", async () => {
    const context = harness();
    const spec = { ...SPEC, health_startup_ms: 20, health_interval_ms: 5 };
    context.runtime.runQueue.push(
      runResult(CANDIDATE, "candidate-id"),
      runResult(CURRENT, "previous-id"),
    );
    context.prober.queue.push(unhealthyProbe(500), "hang");

    const startedAt = Date.now();
    const result = await swapApp(request({ spec }), context.dependencies);
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe("reverted");
    if (result.status !== "reverted") {
      throw new Error("expected a reverted result");
    }

    expect(result.recovery.healthy).toBe(false);
    expect(result.recovery.code).toBe(SWAP_FAILURE_CODES.RECOVERY_PROBE_TIMEOUT);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

describe("swapApp input validation", () => {
  it("rejects an empty candidate image before stopping anything", async () => {
    const context = harness();

    await expect(
      swapApp(request({ candidateImage: "" }), context.dependencies),
    ).rejects.toBeInstanceOf(UsageError);

    expect(context.runtime.calls).toEqual([]);
  });

  it("rejects an empty current image before stopping anything", async () => {
    const context = harness();

    await expect(
      swapApp(request({ currentImage: "" }), context.dependencies),
    ).rejects.toBeInstanceOf(UsageError);

    expect(context.runtime.calls).toEqual([]);
  });

  it("does not attempt a candidate when the old container cannot be stopped", async () => {
    const context = harness();
    context.runtime.stopQueue.push(new PrerequisiteError("podman stopped responding"));

    await expect(swapApp(request(), context.dependencies)).rejects.toBeInstanceOf(
      PrerequisiteError,
    );

    expect(context.runtime.methods()).toEqual(["stopContainer"]);
    expect(context.prober.specs).toEqual([]);
  });
});

describe("createDefaultSwapReporter", () => {
  it("writes a plain-text phase line to the injected stream", () => {
    const chunks: string[] = [];
    const reporter = createDefaultSwapReporter({
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
    });

    reporter.phase("probing", "probing http://127.0.0.1:8080/health");

    expect(chunks.join("")).toBe("swap: probing: probing http://127.0.0.1:8080/health\n");
  });
});
