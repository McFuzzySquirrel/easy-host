import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, EXIT_CODES, PrerequisiteError } from "../../src/cli/errors.js";
import {
  BUILDKIT_CONTAINER_NAME,
  BUILDKIT_DIRECTORY_MODE,
  BUILDKIT_ROLE_LABEL,
  BUILDKIT_ROLE_VALUE,
  BUILDKIT_SOCKET_FILENAME,
  BUILDKIT_START_TIMEOUT_MS,
  BUILDKIT_STOP_TIMEOUT_MS,
  type Buildkit,
  type BuildkitCommandOptions,
  type BuildkitCommandResult,
  type BuildkitOptions,
  type BuildkitRunner,
  buildkitLayout,
  buildkitRunArguments,
  buildkitStatus,
  createBuildkit,
  probeBuildkitSocket,
} from "../../src/platform/buildkit.js";
import { BUILDKIT_IMAGE_REFERENCE } from "../../src/platform/versions.js";

const createdDirectories: string[] = [];
const startedServers: Server[] = [];

function makeRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "easy-host-buildkit-"));
  createdDirectories.push(directory);
  return directory;
}

function makeLayout(root: string) {
  return buildkitLayout(path.join(root, "buildkit"));
}

async function listenOn(socketPath: string): Promise<Server> {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => socket.destroy());
  startedServers.push(server);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });

  return server;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Leaves a bound unix socket file behind without a listener. Node unlinks the
 * path on a normal close, so the binding process is killed after it reports
 * readiness; the kernel closes the descriptor and the filesystem entry remains.
 */
async function createStaleSocketFile(socketPath: string): Promise<void> {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const script = `
    const net = require("node:net");
    const server = net.createServer();
    server.listen(process.argv[1], () => process.stdout.write("ready\\n"));
  `;
  const child = spawn(process.execPath, ["-e", script, socketPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the stale socket binding")),
        5_000,
      );

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (chunk.includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    child.kill("SIGKILL");
  }

  await exited;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(socketPath)) {
      return;
    }

    await delay(5);
  }

  throw new Error("the stale socket file was not created");
}

afterEach(async () => {
  for (const server of startedServers.splice(0)) {
    await closeServer(server);
  }

  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Call {
  command: string;
  args: readonly string[];
  timeoutMs: number | undefined;
}

interface FakeContainerState {
  exists: boolean;
  id: string;
  status: string;
  labels: Record<string, string> | null;
}

function ok(stdout = ""): BuildkitCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(exitCode: number, stderr: string): BuildkitCommandResult {
  return { exitCode, stdout: "", stderr };
}

/**
 * Recording fake for the Podman calls buildkit.ts makes. It models the small
 * slice of container state the lifecycle actually reads: existence, inspect
 * output, and the start/stop/remove transitions.
 */
class RecordingRunner implements BuildkitRunner {
  readonly calls: Call[] = [];
  readonly state: FakeContainerState;
  onRun: ((args: readonly string[]) => void) | undefined;
  runFailure: BuildkitCommandResult | undefined;
  existsFailure: BuildkitCommandResult | undefined;

  constructor(initial: Partial<FakeContainerState> = {}) {
    this.state = {
      exists: false,
      id: "container-1",
      status: "running",
      labels: { [BUILDKIT_ROLE_LABEL]: BUILDKIT_ROLE_VALUE },
      ...initial,
    };
  }

  run(
    command: string,
    args: readonly string[],
    options: BuildkitCommandOptions = {},
  ): BuildkitCommandResult {
    this.calls.push({ command, args: [...args], timeoutMs: options.timeoutMs });

    if (command !== "podman") {
      throw new Error(`unexpected executable: ${command}`);
    }

    const action = args[0];

    if (action === "container" && args[1] === "exists") {
      if (this.existsFailure !== undefined) {
        return this.existsFailure;
      }

      return this.state.exists ? ok() : failed(1, `Error: no such container: ${args[2] ?? ""}`);
    }

    if (action === "inspect") {
      if (!this.state.exists) {
        return failed(125, `Error: no such object: ${this.state.id}`);
      }

      return ok(`${this.state.id}|${this.state.status}|${JSON.stringify(this.state.labels)}\n`);
    }

    if (action === "run") {
      if (this.runFailure !== undefined) {
        return this.runFailure;
      }

      this.state.exists = true;
      this.state.status = "running";
      this.state.id = "started-container-id";
      this.state.labels = { [BUILDKIT_ROLE_LABEL]: BUILDKIT_ROLE_VALUE };
      this.onRun?.(args);
      return ok("started-container-id\n");
    }

    if (action === "stop") {
      if (!this.state.exists) {
        return failed(125, "Error: no such container");
      }

      this.state.status = "exited";
      return ok(`${this.state.id}\n`);
    }

    if (action === "rm") {
      if (!this.state.exists) {
        return failed(125, "Error: no such container");
      }

      this.state.exists = false;
      return ok(`${this.state.id}\n`);
    }

    throw new Error(`unexpected podman arguments: ${args.join(" ")}`);
  }

  runCalls(): Call[] {
    return this.calls.filter((call) => call.args[0] === "run");
  }
}

function buildkitFor(
  root: string,
  runner: BuildkitRunner,
  overrides: Partial<BuildkitOptions> = {},
): Buildkit {
  return createBuildkit({
    paths: { buildkitDir: path.join(root, "buildkit") },
    runner,
    readinessTimeoutMs: 2_000,
    pollIntervalMs: 10,
    probeTimeoutMs: 50,
    ...overrides,
  });
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error("expected the action to throw");
}

describe("buildkit layout", () => {
  it("derives the socket, state, and BUILDKIT_HOST from the buildkit directory", () => {
    const layout = buildkitLayout("/var/lib/easy-host/buildkit");

    expect(layout.root).toBe("/var/lib/easy-host/buildkit");
    expect(layout.stateDir).toBe("/var/lib/easy-host/buildkit/state");
    expect(layout.socketDir).toBe("/var/lib/easy-host/buildkit/socket");
    expect(layout.socketPath).toBe(
      `/var/lib/easy-host/buildkit/socket/${BUILDKIT_SOCKET_FILENAME}`,
    );
    expect(layout.buildkitHost).toBe(`unix://${layout.socketPath}`);
  });
});

describe("buildkit ensure", () => {
  it("reuses a running daemon whose socket accepts connections without starting another", async () => {
    const root = makeRoot();
    const layout = makeLayout(root);
    await listenOn(layout.socketPath);
    const runner = new RecordingRunner({ exists: true, id: "existing-daemon" });

    const daemon = await buildkitFor(root, runner).ensure();

    expect(daemon).toEqual({
      containerName: BUILDKIT_CONTAINER_NAME,
      containerId: "existing-daemon",
      image: BUILDKIT_IMAGE_REFERENCE,
      socketPath: layout.socketPath,
      buildkitHost: `unix://${layout.socketPath}`,
      reused: true,
      state: "running",
    });
    expect(runner.runCalls()).toHaveLength(0);
    expect(runner.calls.some((call) => call.args[0] === "stop")).toBe(false);
    expect(statSync(layout.stateDir).mode & 0o777).toBe(BUILDKIT_DIRECTORY_MODE);
    expect(statSync(layout.socketDir).mode & 0o777).toBe(BUILDKIT_DIRECTORY_MODE);
  });

  it("cold-starts the pinned image, waits for the socket, and matches the spike flags", async () => {
    const root = makeRoot();
    const layout = makeLayout(root);
    const server = createServer((socket) => socket.destroy());
    server.on("error", () => {
      // A listen failure surfaces as the readiness timeout below.
    });
    startedServers.push(server);

    const runner = new RecordingRunner();
    runner.onRun = () => {
      server.listen(layout.socketPath);
    };

    const daemon = await buildkitFor(root, runner).ensure();

    expect(daemon.reused).toBe(false);
    expect(daemon.containerId).toBe("started-container-id");
    expect(daemon.state).toBe("running");

    const [runCall] = runner.runCalls();
    expect(runCall?.command).toBe("podman");
    expect(runCall?.args).toEqual([
      "run",
      "-d",
      "--name",
      "easy-host-buildkitd",
      "--label",
      "io.easy-host.role=buildkit",
      "--user",
      "0",
      "--privileged",
      "--entrypoint",
      "/usr/bin/buildkitd",
      "-v",
      `${layout.stateDir}:/home/user/.local/share/buildkit`,
      "-v",
      `${layout.socketDir}:/run/user/1000/buildkit`,
      BUILDKIT_IMAGE_REFERENCE,
      "--addr",
      "unix:///run/user/1000/buildkit/buildkitd.sock",
      "--oci-worker-no-process-sandbox",
    ]);
    expect(runCall?.timeoutMs).toBe(BUILDKIT_START_TIMEOUT_MS);
    expect(BUILDKIT_IMAGE_REFERENCE).toContain("@sha256:");
    expect(runCall?.args).toContain("io.easy-host.role=buildkit");
    expect(runCall?.args).not.toContain("io.easy-host.role=app");
    expect(runner.calls.every((call) => call.timeoutMs !== undefined)).toBe(true);
  });

  it("fails with exit code 2 when a cold start never accepts connections", async () => {
    const root = makeRoot();
    const runner = new RecordingRunner();
    const buildkit = buildkitFor(root, runner, {
      readinessTimeoutMs: 60,
      pollIntervalMs: 5,
      probeTimeoutMs: 5,
    });

    const startedAt = Date.now();
    const error = await captureError(() => buildkit.ensure());
    const elapsed = Date.now() - startedAt;

    expect(error).toBeInstanceOf(PrerequisiteError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODES.PREREQUISITE,
      code: "BUILDKIT_SOCKET_TIMEOUT",
    });
    expect((error as Error).message).toContain("did not accept connections");
    expect(elapsed).toBeLessThan(2_000);
    expect(runner.runCalls()).toHaveLength(1);
  });

  it("refuses a socket already served by a process that is not the managed daemon", async () => {
    const root = makeRoot();
    const layout = makeLayout(root);
    await listenOn(layout.socketPath);
    const runner = new RecordingRunner();

    const error = await captureError(() => buildkitFor(root, runner).ensure());

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODES.CONFLICT,
      code: "BUILDKIT_SOCKET_CONFLICT",
    });
    expect(runner.runCalls()).toHaveLength(0);
  });

  it("refuses a container name owned by a foreign container and never removes it", async () => {
    const root = makeRoot();
    const runner = new RecordingRunner({
      exists: true,
      labels: { [BUILDKIT_ROLE_LABEL]: "app" },
    });

    const error = await captureError(() => buildkitFor(root, runner).ensure());

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODES.CONFLICT,
      code: "BUILDKIT_NAME_CONFLICT",
    });
    expect(runner.runCalls()).toHaveLength(0);
    expect(runner.calls.some((call) => call.args[0] === "rm" || call.args[0] === "stop")).toBe(
      false,
    );
  });

  it("replaces a stopped managed container and removes the stale socket file", async () => {
    const root = makeRoot();
    const layout = makeLayout(root);
    await createStaleSocketFile(layout.socketPath);
    expect(lstatSync(layout.socketPath).isSocket()).toBe(true);

    const server = createServer((socket) => socket.destroy());
    server.on("error", () => {
      // A listen failure surfaces as the readiness timeout below.
    });
    startedServers.push(server);

    const runner = new RecordingRunner({ exists: true, id: "old-daemon", status: "exited" });
    let staleSocketPresentAtStart: boolean | undefined;
    runner.onRun = () => {
      staleSocketPresentAtStart = existsSync(layout.socketPath);
      server.listen(layout.socketPath);
    };

    const daemon = await buildkitFor(root, runner).ensure();

    expect(daemon.reused).toBe(false);
    expect(staleSocketPresentAtStart).toBe(false);
    expect(runner.calls.some((call) => call.args[0] === "rm")).toBe(true);
    expect(runner.runCalls()).toHaveLength(1);
  });

  it("replaces a running managed container whose socket is not accepting connections", async () => {
    const root = makeRoot();
    const layout = makeLayout(root);
    const server = createServer((socket) => socket.destroy());
    server.on("error", () => {
      // A listen failure surfaces as the readiness timeout below.
    });
    startedServers.push(server);

    const runner = new RecordingRunner({ exists: true, id: "wedged-daemon", status: "running" });
    runner.onRun = () => {
      server.listen(layout.socketPath);
    };

    const daemon = await buildkitFor(root, runner).ensure();

    expect(daemon.reused).toBe(false);
    expect(runner.calls.some((call) => call.args[0] === "rm")).toBe(true);
    expect(runner.runCalls()).toHaveLength(1);
  });

  it("refuses a socket path occupied by a non-socket file", async () => {
    const root = makeRoot();
    const layout = makeLayout(root);
    mkdirSync(layout.socketDir, { recursive: true, mode: 0o700 });
    writeFileSync(layout.socketPath, "not a socket");

    const runner = new RecordingRunner();
    const error = await captureError(() => buildkitFor(root, runner).ensure());

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODES.CONFLICT,
      code: "BUILDKIT_SOCKET_PATH_OCCUPIED",
    });
    expect(runner.runCalls()).toHaveLength(0);
  });

  it("fails with exit code 2 when podman run fails", async () => {
    const root = makeRoot();
    const runner = new RecordingRunner();
    runner.runFailure = failed(125, "Error: unable to pull image: no matching manifest");

    const error = await captureError(() => buildkitFor(root, runner).ensure());

    expect(error).toBeInstanceOf(PrerequisiteError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODES.PREREQUISITE,
      code: "BUILDKIT_START_FAILED",
    });
    expect((error as Error).message).toContain("no matching manifest");
    expect((error as PrerequisiteError).remediation).toContain("podman logs");
  });

  it("fails with exit code 2 when podman is not installed", async () => {
    const root = makeRoot();
    const runner = new RecordingRunner();
    runner.existsFailure = {
      exitCode: 127,
      stdout: "",
      stderr: "",
      spawnError: "ENOENT",
    };

    const error = await captureError(() => buildkitFor(root, runner).ensure());

    expect(error).toBeInstanceOf(PrerequisiteError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODES.PREREQUISITE,
      code: "BUILDKIT_PODMAN_UNAVAILABLE",
    });
    expect(runner.runCalls()).toHaveLength(0);
  });
});

describe("buildkit status", () => {
  it("reports an absent daemon without starting anything", async () => {
    const root = makeRoot();
    const runner = new RecordingRunner();

    const status = await buildkitFor(root, runner).status();

    expect(status).toMatchObject({
      containerName: BUILDKIT_CONTAINER_NAME,
      state: "absent",
      socketReachable: false,
    });
    expect(status.detail).toContain("no managed buildkitd container");
    expect(runner.runCalls()).toHaveLength(0);
    expect(runner.calls.some((call) => call.args[0] === "stop")).toBe(false);
  });

  it("reports a running daemon whose socket is unreachable as unhealthy", async () => {
    const root = makeRoot();
    const runner = new RecordingRunner({ exists: true, id: "daemon-1", status: "running" });

    const status = await buildkitFor(root, runner).status();

    expect(status).toMatchObject({
      state: "unhealthy",
      socketReachable: false,
      containerId: "daemon-1",
    });
    expect(status.detail).toContain("does not accept connections");
  });

  it("reports a running daemon with a reachable socket as running", async () => {
    const root = makeRoot();
    const layout = makeLayout(root);
    await listenOn(layout.socketPath);
    const runner = new RecordingRunner({ exists: true, id: "daemon-2", status: "running" });

    const status = await buildkitStatus({
      paths: { buildkitDir: path.join(root, "buildkit") },
      runner,
      probeTimeoutMs: 50,
    });

    expect(status).toMatchObject({
      state: "running",
      socketReachable: true,
      buildkitHost: `unix://${layout.socketPath}`,
    });
  });

  it("reports a foreign container as a conflict and an unusable podman as unknown", async () => {
    const root = makeRoot();
    const foreign = new RecordingRunner({
      exists: true,
      labels: { [BUILDKIT_ROLE_LABEL]: "app" },
    });

    expect(await buildkitFor(root, foreign).status()).toMatchObject({
      state: "conflict",
    });

    const missingPodman = new RecordingRunner();
    missingPodman.existsFailure = {
      exitCode: 127,
      stdout: "",
      stderr: "",
      spawnError: "ENOENT",
    };

    const unknown = await buildkitFor(root, missingPodman).status();
    expect(unknown.state).toBe("unknown");
    expect(unknown.detail).toContain("podman");
  });
});

describe("buildkit stop", () => {
  it("stops and removes the managed daemon, then reports it absent", async () => {
    const root = makeRoot();
    const runner = new RecordingRunner({ exists: true, id: "daemon-3", status: "running" });
    const buildkit = buildkitFor(root, runner);

    const result = await buildkit.stop();

    expect(result).toEqual({
      containerName: BUILDKIT_CONTAINER_NAME,
      stopped: true,
      removed: true,
      socketPath: buildkit.layout.socketPath,
    });

    const stopCall = runner.calls.find((call) => call.args[0] === "stop");
    expect(stopCall?.args).toEqual(["stop", "--time", "10", BUILDKIT_CONTAINER_NAME]);
    expect(stopCall?.timeoutMs).toBe(BUILDKIT_STOP_TIMEOUT_MS);
    expect(runner.calls.some((call) => call.args[0] === "rm")).toBe(true);
    expect(await buildkit.status()).toMatchObject({ state: "absent" });
  });

  it("is idempotent when no managed container exists", async () => {
    const root = makeRoot();
    const runner = new RecordingRunner();

    const result = await buildkitFor(root, runner).stop();

    expect(result).toMatchObject({ stopped: false, removed: false });
    expect(runner.calls.some((call) => call.args[0] === "stop")).toBe(false);
    expect(runner.calls.some((call) => call.args[0] === "rm")).toBe(false);
  });

  it("refuses to stop a foreign container", async () => {
    const root = makeRoot();
    const runner = new RecordingRunner({
      exists: true,
      labels: { [BUILDKIT_ROLE_LABEL]: "app" },
    });

    const error = await captureError(() => buildkitFor(root, runner).stop());

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ code: "BUILDKIT_NAME_CONFLICT" });
    expect(runner.calls.some((call) => call.args[0] === "stop")).toBe(false);
  });
});

describe("buildkit socket probe", () => {
  it("accepts a live unix socket and rejects a missing path", async () => {
    const root = makeRoot();
    const layout = makeLayout(root);
    await listenOn(layout.socketPath);

    await expect(probeBuildkitSocket(layout.socketPath, 200)).resolves.toBe(true);
    await expect(
      probeBuildkitSocket(path.join(layout.socketDir, "missing.sock"), 50),
    ).resolves.toBe(false);
  });

  it("rejects a stale socket file with no listener", async () => {
    const root = makeRoot();
    const layout = makeLayout(root);
    const server = await listenOn(layout.socketPath);
    await closeServer(server);

    await expect(probeBuildkitSocket(layout.socketPath, 50)).resolves.toBe(false);
  });
});

describe("buildkit run arguments", () => {
  it("keeps the spike flags and mounts in one exported array builder", () => {
    const layout = buildkitLayout("/tmp/easy-host/buildkit");
    const args = buildkitRunArguments(layout);

    expect(args.slice(0, 11)).toEqual([
      "run",
      "-d",
      "--name",
      "easy-host-buildkitd",
      "--label",
      "io.easy-host.role=buildkit",
      "--user",
      "0",
      "--privileged",
      "--entrypoint",
      "/usr/bin/buildkitd",
    ]);
    expect(args).toContain("/tmp/easy-host/buildkit/state:/home/user/.local/share/buildkit");
    expect(args).toContain("/tmp/easy-host/buildkit/socket:/run/user/1000/buildkit");
    expect(args.at(-2)).toBe("unix:///run/user/1000/buildkit/buildkitd.sock");
    expect(args.at(-1)).toBe("--oci-worker-no-process-sandbox");
  });
});
