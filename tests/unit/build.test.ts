import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  EXIT_CODES,
  InternalError,
  PrerequisiteError,
  toExitCode,
  UsageError,
} from "../../src/cli/errors.js";
import { AppNameError } from "../../src/config/name.js";
import {
  BUILD_LOCK_FILENAME,
  type BuildExit,
  BuildInfrastructureError,
  type BuildOutputChunk,
  type BuildOutputSink,
  type BuildOutputStream,
  type BuildProcess,
  type BuildResult,
  type BuildRunner,
  type BuildRunnerOptions,
  type BuildWorkspaceOptions,
  buildImageTag,
  buildLockPath,
  buildWorkspace,
  formatBuildTimestamp,
  ProviderBuildError,
  railpackBuildArguments,
  UnsupportedSourceError,
} from "../../src/platform/build.js";

const BUILDKIT_HOST = "unix:///tmp/easy-host/buildkit/socket/buildkitd.sock";
const RAILPACK_PATH = "/opt/easy-host/tools/railpack";
const FIXED_NOW = new Date("2026-10-30T02:16:05.123Z");
const FIXED_IMAGE = "localhost/easy-host-demo:20261030T021605Z";

const createdDirectories: string[] = [];

function makeTemporaryDirectory(prefix = "easy-host-build-"): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

function makeWorkspace(files: Record<string, string> = {}): string {
  const directory = makeTemporaryDirectory("easy-host-build-workspace-");
  const entries = Object.keys(files).length === 0 ? { "package.json": "{}" } : files;

  for (const [name, contents] of Object.entries(entries)) {
    const target = path.join(directory, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  return directory;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeOutputQueue implements AsyncIterable<BuildOutputChunk> {
  readonly #items: BuildOutputChunk[] = [];
  readonly #waiters: Array<(result: IteratorResult<BuildOutputChunk>) => void> = [];
  #closed = false;

  push(chunk: BuildOutputChunk): void {
    if (this.#closed) {
      return;
    }

    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: chunk, done: false });
      return;
    }

    this.#items.push(chunk);
  }

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<BuildOutputChunk> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }

        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

/**
 * Fake child process with a controllable output queue and exit promise. A test
 * can assert that a line reached the sink before it resolves the exit, which is
 * exactly the streaming guarantee (`BLD-NF-01`).
 */
class FakeBuildProcess implements BuildProcess {
  readonly output = new FakeOutputQueue();
  readonly #deferred = Promise.withResolvers<BuildExit>();
  readonly exited = this.#deferred.promise;
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  #settled = false;

  push(text: string, stream: BuildOutputStream = "stdout"): void {
    this.output.push({ stream, text });
  }

  complete(exit: BuildExit = { code: 0, signal: null }): void {
    if (this.#settled) {
      return;
    }

    this.#settled = true;
    this.output.close();
    this.#deferred.resolve(exit);
  }

  kill(signal?: NodeJS.Signals): void {
    this.kills.push(signal);
    this.complete({ code: null, signal: "SIGKILL" });
  }
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: BuildRunnerOptions;
}

class FakeRunner implements BuildRunner {
  readonly calls: RecordedCall[] = [];
  readonly process: FakeBuildProcess;

  constructor(process = new FakeBuildProcess()) {
    this.process = process;
  }

  run(command: string, args: readonly string[], options: BuildRunnerOptions): BuildProcess {
    this.calls.push({ command, args: [...args], options });
    return this.process;
  }
}

class RecordingSink implements BuildOutputSink {
  readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  get lines(): string[] {
    return this.chunks.map((chunk) => (chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk));
  }
}

function optionsFor(
  workspace: string,
  runner: BuildRunner,
  overrides: Partial<BuildWorkspaceOptions> = {},
): BuildWorkspaceOptions {
  return {
    app: "demo",
    workspace,
    railpackBinaryPath: RAILPACK_PATH,
    buildkitHost: BUILDKIT_HOST,
    now: () => FIXED_NOW,
    runner,
    stderr: new RecordingSink(),
    ...overrides,
  };
}

function onlyCall(runner: FakeRunner): RecordedCall {
  const [call] = runner.calls;
  if (call === undefined) {
    throw new Error("expected the build runner to be called");
  }

  return call;
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error("expected the action to throw");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the expected build state");
    }

    await delay(5);
  }
}

describe("build tag", () => {
  it("formats the UTC timestamp and immutable image tag", () => {
    expect(formatBuildTimestamp(FIXED_NOW)).toBe("20261030T021605Z");
    expect(buildImageTag("demo", FIXED_NOW)).toBe(FIXED_IMAGE);
    expect(buildImageTag("api-2", new Date("2026-01-02T03:04:05.999Z"))).toBe(
      "localhost/easy-host-api-2:20260102T030405Z",
    );
  });

  it("rejects an app name that is not in the allowlist before it reaches a tag", () => {
    expect(() => buildImageTag("../escape", FIXED_NOW)).toThrow(AppNameError);
    expect(toExitCode(new AppNameError("invalid"))).toBe(EXIT_CODES.USAGE);
  });

  it("rejects an invalid clock value as an internal error", () => {
    expect(() => formatBuildTimestamp(new Date(Number.NaN))).toThrow(InternalError);
    expect(toExitCode(new InternalError("invalid clock"))).toBe(EXIT_CODES.INTERNAL);
  });

  it("derives the host-wide lock path from the state root", () => {
    expect(buildLockPath("/srv/easy-host")).toBe(`/srv/easy-host/${BUILD_LOCK_FILENAME}`);
    expect(() => buildLockPath("")).toThrow(UsageError);
  });
});

describe("railpack arguments", () => {
  it("uses the spike-verified --name flag and plain progress", () => {
    expect(
      railpackBuildArguments({
        workspace: "/srv/app",
        tag: "localhost/easy-host-app:20261030T021605Z",
      }),
    ).toEqual([
      "build",
      "/srv/app",
      "--name",
      "localhost/easy-host-app:20261030T021605Z",
      "--progress",
      "plain",
    ]);
  });
});

describe("buildWorkspace success", () => {
  it("streams both pipes to stderr and returns the timestamped image without a Dockerfile", async () => {
    const workspace = makeWorkspace({ "package.json": '{"name":"demo"}' });
    const runner = new FakeRunner();
    const sink = new RecordingSink();
    const parentBuildkitHost = process.env.BUILDKIT_HOST;
    const build = buildWorkspace(
      optionsFor(workspace, runner, {
        stderr: sink,
        env: { PATH: "/usr/bin", BUILDKIT_HOST: "unix:///stale.sock" },
      }),
    );

    runner.process.push("  ↳ Detected Node\n", "stdout");
    await waitFor(() => sink.chunks.length === 1);
    expect(sink.lines).toEqual(["  ↳ Detected Node"]);

    runner.process.push("#1 [internal] load build definition\n", "stderr");
    runner.process.push("  ↳ Using npm\n", "stdout");
    await waitFor(() => sink.chunks.length === 3);
    expect(sink.lines).toEqual([
      "  ↳ Detected Node",
      "#1 [internal] load build definition",
      "  ↳ Using npm",
    ]);

    runner.process.complete({ code: 0, signal: null });
    const result: BuildResult = await build;

    expect(result).toMatchObject({
      app: "demo",
      image: FIXED_IMAGE,
      timestamp: "20261030T021605Z",
      workspace,
      exitCode: 0,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(existsSync(path.join(workspace, "Dockerfile"))).toBe(false);

    const call = onlyCall(runner);
    expect(call.command).toBe(RAILPACK_PATH);
    expect(call.args).toEqual(["build", workspace, "--name", FIXED_IMAGE, "--progress", "plain"]);
    expect(call.options.cwd).toBe(workspace);
    expect(call.options.env.BUILDKIT_HOST).toBe(BUILDKIT_HOST);
    expect(call.options.env.PATH).toBe("/usr/bin");
    expect(process.env.BUILDKIT_HOST).toBe(parentBuildkitHost);
  });

  it("splits chunks into lines, preserves order, and flushes a trailing partial line", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();
    const sink = new RecordingSink();
    const build = buildWorkspace(optionsFor(workspace, runner, { stderr: sink }));

    runner.process.push("first part ", "stdout");
    runner.process.push("second part\nsecond line\r\n", "stdout");
    runner.process.push("stderr line\n", "stderr");
    runner.process.push("trailing", "stdout");
    runner.process.complete({ code: 0, signal: null });

    await build;

    expect(sink.lines).toEqual([
      "first part second part",
      "second line",
      "stderr line",
      "trailing",
    ]);
    expect(sink.chunks).toHaveLength(4);
    expect(sink.chunks.every((chunk) => chunk.endsWith("\n"))).toBe(true);
  });

  it("redacts URL credentials and strips ANSI escapes before forwarding", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();
    const sink = new RecordingSink();

    runner.process.push("clone https://user:secret@example.com/repo\n", "stdout");
    runner.process.push("\u001b[31mred line\u001b[0m\n", "stderr");
    runner.process.complete({ code: 0, signal: null });

    await buildWorkspace(optionsFor(workspace, runner, { stderr: sink }));

    expect(sink.lines).toEqual(["clone https://[redacted]@example.com/repo", "red line"]);
  });

  it("uses an injected clock for deterministic tags", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();
    const now = new Date("2027-12-31T23:59:59.000Z");

    runner.process.complete({ code: 0, signal: null });
    const result = await buildWorkspace(optionsFor(workspace, runner, { now: () => now }));

    expect(result.image).toBe("localhost/easy-host-demo:20271231T235959Z");
  });
});

describe("buildWorkspace classification", () => {
  it("classifies a missing provider as unsupported-source with exit code 3", async () => {
    const workspace = makeWorkspace({ "README.md": "no app here" });
    const runner = new FakeRunner();

    runner.process.push("  ⚠ Script start.sh not found\n", "stdout");
    runner.process.push("  ✖ Railpack could not determine how to build the app.\n", "stderr");
    runner.process.complete({ code: 1, signal: null });

    const error = await captureError(() => buildWorkspace(optionsFor(workspace, runner)));

    expect(error).toBeInstanceOf(UnsupportedSourceError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODES.BUILD,
      code: "BUILD_UNSUPPORTED_SOURCE",
      kind: "unsupported-source",
    });
    expect((error as Error).message).toContain("could not detect a supported stack");
    expect((error as UnsupportedSourceError).remediation).toContain("No Dockerfile is required");
    expect((error as UnsupportedSourceError).details.reason).toBe("no-provider-detected");
    expect((error as UnsupportedSourceError).details.output).toContain(
      "could not determine how to build",
    );
  });

  it("classifies a provider build failure as build-failure with exit code 3", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();

    runner.process.push("  ↳ Detected Node\n", "stdout");
    runner.process.push('#8 0.421 npm ERR! Missing script: "build"\n', "stderr");
    runner.process.push(
      '#8 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1\n',
      "stderr",
    );
    runner.process.complete({ code: 1, signal: null });

    const error = await captureError(() => buildWorkspace(optionsFor(workspace, runner)));

    expect(error).toBeInstanceOf(ProviderBuildError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODES.BUILD,
      code: "BUILD_PROVIDER_FAILED",
      kind: "build-failure",
    });
    expect((error as Error).message).toContain("detected a provider but the build failed");
    expect((error as ProviderBuildError).details).toMatchObject({
      reason: "provider-build-failed",
      railpackExitCode: 1,
    });
    expect((error as ProviderBuildError).remediation).toContain("streamed Railpack output");
    expect((error as Error).message).not.toContain("could not detect a supported stack");
  });

  it("classifies an unreachable buildkitd as infrastructure-failure with exit code 2", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();

    runner.process.push("  ↳ Detected Node\n", "stdout");
    runner.process.push(" ERRO failed to get buildkit information.\n", "stderr");
    runner.process.push(
      "Most likely the $BUILDKIT_HOST is not running. Here's an example of how to start the build container:\n",
      "stderr",
    );
    runner.process.complete({ code: 1, signal: null });

    const error = await captureError(() => buildWorkspace(optionsFor(workspace, runner)));

    expect(error).toBeInstanceOf(BuildInfrastructureError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODES.PREREQUISITE,
      code: "BUILD_INFRASTRUCTURE_FAILED",
      kind: "infrastructure-failure",
    });
    expect((error as BuildInfrastructureError).details).toMatchObject({
      reason: "buildkit-unreachable",
      buildkitHost: BUILDKIT_HOST,
    });
    expect((error as Error).message).toContain("buildkit-unreachable");
    expect((error as BuildInfrastructureError).remediation).toContain("easy-host doctor");
    expect((error as BuildInfrastructureError).remediation).toContain("podman ps");
  });

  it("classifies a registry pull failure as infrastructure, not a source failure", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();

    runner.process.push(
      "#5 ERROR: failed to resolve source metadata for docker.io/library/node:24-alpine: failed to authorize: 429 Too Many Requests\n",
      "stderr",
    );
    runner.process.complete({ code: 1, signal: null });

    const error = await captureError(() => buildWorkspace(optionsFor(workspace, runner)));

    expect(error).toBeInstanceOf(BuildInfrastructureError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODES.PREREQUISITE,
      code: "BUILD_INFRASTRUCTURE_FAILED",
    });
    expect((error as BuildInfrastructureError).details.reason).toBe("registry-pull-failed");
    expect((error as BuildInfrastructureError).remediation).toContain("registry");
    expect((error as BuildInfrastructureError).remediation).toContain("rate limits");
  });

  it("classifies a network failure during a pull as infrastructure", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();

    runner.process.push(
      '#4 ERROR: failed to solve: failed to do request: Head "https://registry-1.docker.io/v2/": dial tcp 1.2.3.4:443: i/o timeout\n',
      "stderr",
    );
    runner.process.complete({ code: 1, signal: null });

    const error = await captureError(() => buildWorkspace(optionsFor(workspace, runner)));

    expect(error).toBeInstanceOf(BuildInfrastructureError);
    expect((error as BuildInfrastructureError).details.reason).toBe("network-unreachable");
    expect((error as BuildInfrastructureError).remediation).toContain("outbound network");
  });

  it("classifies a spawn failure as infrastructure with a Railpack remediation", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();

    runner.process.complete({ code: null, signal: null, spawnError: "ENOENT" });

    const error = await captureError(() => buildWorkspace(optionsFor(workspace, runner)));

    expect(error).toBeInstanceOf(BuildInfrastructureError);
    expect((error as BuildInfrastructureError).details.reason).toBe("railpack-unavailable");
    expect((error as Error).message).toContain("could not start the pinned Railpack binary");
    expect((error as BuildInfrastructureError).remediation).toContain("EASY_HOST_RAILPACK_BIN");
  });

  it("classifies a signal termination as infrastructure", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();

    runner.process.complete({ code: null, signal: "SIGTERM" });

    const error = await captureError(() => buildWorkspace(optionsFor(workspace, runner)));

    expect(error).toBeInstanceOf(BuildInfrastructureError);
    expect((error as BuildInfrastructureError).details.reason).toBe("railpack-terminated");
    expect((error as Error).message).toContain("SIGTERM");
  });

  it("kills a build that exceeds its timeout and reports the docker loader when export stalled", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();

    runner.process.push("exporting to docker image format\n", "stdout");

    const error = await captureError(() =>
      buildWorkspace(optionsFor(workspace, runner, { timeoutMs: 25 })),
    );

    expect(error).toBeInstanceOf(BuildInfrastructureError);
    expect((error as BuildInfrastructureError).details.reason).toBe("docker-loader-unavailable");
    expect((error as BuildInfrastructureError).remediation).toContain("podman-docker");
    expect(runner.process.kills).toEqual(["SIGKILL"]);
  });

  it("reports a plain build timeout without claiming a loader problem", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();

    runner.process.push("  ↳ npm install\n", "stdout");

    const error = await captureError(() =>
      buildWorkspace(optionsFor(workspace, runner, { timeoutMs: 20 })),
    );

    expect(error).toBeInstanceOf(BuildInfrastructureError);
    expect((error as BuildInfrastructureError).details.reason).toBe("build-timeout");
    expect((error as Error).message).toContain("did not finish the build");
    expect(runner.process.kills).toEqual(["SIGKILL"]);
  });
});

describe("buildWorkspace validation and serialization", () => {
  it("rejects an invalid app name before starting the child", async () => {
    const workspace = makeWorkspace();
    const runner = new FakeRunner();

    const error = await captureError(() =>
      buildWorkspace(optionsFor(workspace, runner, { app: "../escape" })),
    );

    expect(error).toBeInstanceOf(AppNameError);
    expect(toExitCode(error)).toBe(EXIT_CODES.USAGE);
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a missing workspace and a regular file before starting the child", async () => {
    const root = makeTemporaryDirectory();
    const missingRunner = new FakeRunner();
    const missing = await captureError(() =>
      buildWorkspace(optionsFor(path.join(root, "missing"), missingRunner)),
    );

    expect(missing).toBeInstanceOf(UsageError);
    expect(missing).toMatchObject({ code: "BUILD_WORKSPACE_INVALID" });
    expect(missingRunner.calls).toHaveLength(0);

    const file = path.join(root, "file.txt");
    writeFileSync(file, "not a directory");
    const fileRunner = new FakeRunner();
    const notDirectory = await captureError(() => buildWorkspace(optionsFor(file, fileRunner)));

    expect(notDirectory).toBeInstanceOf(UsageError);
    expect((notDirectory as UsageError).details.reason).toBe("not-a-directory");
    expect(fileRunner.calls).toHaveLength(0);
  });

  it("rejects a non-unix BuildKit host and an empty Railpack path before starting the child", async () => {
    const workspace = makeWorkspace();
    const hostRunner = new FakeRunner();
    const host = await captureError(() =>
      buildWorkspace(optionsFor(workspace, hostRunner, { buildkitHost: "tcp://127.0.0.1:1234" })),
    );

    expect(host).toBeInstanceOf(PrerequisiteError);
    expect(host).toMatchObject({
      exitCode: EXIT_CODES.PREREQUISITE,
      code: "BUILDKIT_HOST_INVALID",
    });
    expect(hostRunner.calls).toHaveLength(0);

    const pathRunner = new FakeRunner();
    const missingBinary = await captureError(() =>
      buildWorkspace(optionsFor(workspace, pathRunner, { railpackBinaryPath: "" })),
    );

    expect(missingBinary).toBeInstanceOf(UsageError);
    expect(missingBinary).toMatchObject({ code: "BUILD_RAILPACK_PATH_INVALID" });
    expect(pathRunner.calls).toHaveLength(0);
  });

  it("serializes builds per host with the build lock", async () => {
    const workspace = makeWorkspace();
    const stateRoot = makeTemporaryDirectory("easy-host-build-state-");
    const firstRunner = new FakeRunner();
    const first = buildWorkspace(optionsFor(workspace, firstRunner, { stateRoot }));

    await waitFor(() => firstRunner.calls.length === 1);
    expect(existsSync(buildLockPath(stateRoot))).toBe(true);

    const secondRunner = new FakeRunner();
    const error = await captureError(() =>
      buildWorkspace(optionsFor(workspace, secondRunner, { stateRoot })),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ exitCode: EXIT_CODES.CONFLICT, code: "LOCK_HELD" });
    expect(secondRunner.calls).toHaveLength(0);

    firstRunner.process.complete({ code: 0, signal: null });
    await first;

    expect(existsSync(buildLockPath(stateRoot))).toBe(false);
  });

  it("releases the build lock when the build fails", async () => {
    const workspace = makeWorkspace();
    const stateRoot = makeTemporaryDirectory("easy-host-build-state-");
    const runner = new FakeRunner();

    runner.process.complete({ code: 1, signal: null });

    await captureError(() => buildWorkspace(optionsFor(workspace, runner, { stateRoot })));

    expect(existsSync(buildLockPath(stateRoot))).toBe(false);
  });
});
