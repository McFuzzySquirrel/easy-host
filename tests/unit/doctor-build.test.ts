import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctorCommand } from "../../src/cli/commands/doctor.js";
import { EXIT_CODES } from "../../src/cli/errors.js";
import {
  BUILDKIT_PROBE_TIMEOUT_MS,
  type BuildCheckEnvironment,
  type BuildkitReachabilityProbe,
  checkBuildkit,
  checkRailpack,
  parseRailpackVersion,
  probeBuildkitSocketSync,
  runBuildChecks,
} from "../../src/doctor/build-checks.js";
import {
  DOCTOR_COMMAND_TIMEOUT_MS,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../../src/doctor/checks.js";
import {
  type DoctorOptions,
  type DoctorReport,
  formatDoctorJson,
  formatDoctorReport,
  runDoctor,
} from "../../src/doctor/index.js";
import { BUILDKIT_CONTAINER_NAME, buildkitLayout } from "../../src/platform/buildkit.js";
import { EASY_HOST_RAILPACK_BIN } from "../../src/platform/railpack.js";
import { BUILDKIT_VERSION, RAILPACK_VERSION } from "../../src/platform/versions.js";

const GIB = 1024 ** 3;
const HEALTHY_DISK = { freeBytes: 42 * GIB, totalBytes: 200 * GIB };
const ANSI_ESCAPE = "\u001B[";
const EXPECTED_ORDER = [
  "podman",
  "podman-rootless",
  "linger",
  "git",
  "node",
  "railpack",
  "buildkit",
  "disk",
];

const createdDirectories: string[] = [];
const createdServers: Server[] = [];

afterEach(async () => {
  for (const server of createdServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "easy-host-doctor-build-"));
  createdDirectories.push(directory);
  return directory;
}

interface Call {
  command: string;
  args: readonly string[];
  timeoutMs: number | undefined;
}

function ok(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(exitCode = 1, stderr = ""): ProcessRunResult {
  return { exitCode, stdout: "", stderr };
}

class RecordingRunner implements ProcessRunner {
  readonly calls: Call[] = [];

  constructor(
    private readonly handler: (command: string, args: readonly string[]) => ProcessRunResult,
  ) {}

  run(command: string, args: readonly string[], options: ProcessRunOptions = {}): ProcessRunResult {
    this.calls.push({ command, args: [...args], timeoutMs: options.timeoutMs });
    return this.handler(command, args);
  }
}

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

function makeRailpack(directory: string, mode = 0o755, name = "railpack"): string {
  const executable = path.join(directory, name);
  writeFileSync(executable, "#!/bin/sh\nprintf 'railpack 0.43.0\\n'\n", { mode });
  chmodSync(executable, mode);
  return executable;
}

interface HostRunnerOptions {
  railpackPath?: string;
  railpackVersion?: string;
  railpackResult?: ProcessRunResult;
}

function createHostRunner(options: HostRunnerOptions = {}): RecordingRunner {
  return new RecordingRunner((command, args) => {
    if (command === "podman" && args[0] === "--version") {
      return ok("podman version 5.7.0\n");
    }

    if (command === "podman" && args[0] === "info") {
      return ok("true\n");
    }

    if (command === "loginctl") {
      return ok("Linger=yes\n");
    }

    if (command === "git" && args[0] === "--version") {
      return ok("git version 2.43.0\n");
    }

    if (
      options.railpackPath !== undefined &&
      command === options.railpackPath &&
      args[0] === "--version"
    ) {
      return (
        options.railpackResult ?? ok(`railpack ${options.railpackVersion ?? RAILPACK_VERSION}\n`)
      );
    }

    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  });
}

interface EnvironmentOptions {
  root: string;
  runner?: ProcessRunner;
  railpackPath?: string;
  probeBuildkit?: BuildkitReachabilityProbe;
  env?: NodeJS.ProcessEnv;
  toolsDir?: string;
  buildkitDir?: string;
}

function createEnvironment(options: EnvironmentOptions): BuildCheckEnvironment {
  return {
    runner: options.runner ?? createHostRunner(),
    env: options.env ?? {},
    toolsDir: options.toolsDir ?? options.root,
    buildkitDir: options.buildkitDir ?? path.join(options.root, "buildkit"),
    cwd: options.root,
    homeDir: options.root,
    probeBuildkit: options.probeBuildkit ?? (() => true),
    ...(options.railpackPath === undefined ? {} : { railpackPath: options.railpackPath }),
  };
}

function diagnose(runner: ProcessRunner, overrides: DoctorOptions = {}): DoctorReport {
  const root = overrides.toolsDir ?? makeTemporaryDirectory();

  return runDoctor({
    runner,
    env: {},
    username: "alice",
    osRelease: { id: "ubuntu", name: "Ubuntu 24.04 LTS" },
    nodeVersion: "v24.0.0",
    diskPath: root,
    readDiskSpace: () => HEALTHY_DISK,
    toolsDir: root,
    buildkitDir: path.join(root, "buildkit"),
    probeBuildkit: () => true,
    now: () => 0,
    ...overrides,
  });
}

describe("Railpack doctor check", () => {
  it("passes when the pinned binary is present, executable, and reports its version", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const runner = createHostRunner({ railpackPath: executable });

    const check = checkRailpack(createEnvironment({ root, runner, railpackPath: executable }));

    expect(check.id).toBe("railpack");
    expect(check.status).toBe("pass");
    expect(check.detail).toContain(RAILPACK_VERSION);
    expect(check.detail).toContain(executable);
    expect(check.remediation).toBeNull();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.command).toBe(executable);
    expect(runner.calls[0]?.args).toEqual(["--version"]);
    expect(runner.calls[0]?.timeoutMs).toBe(DOCTOR_COMMAND_TIMEOUT_MS);
  });

  it("fails when the pinned binary has not been installed and points at the first build", () => {
    const root = makeTemporaryDirectory();
    const check = checkRailpack(
      createEnvironment({ root, runner: createHostRunner(), toolsDir: root }),
    );

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not installed");
    expect(check.detail).toContain(root);
    expect(check.remediation).toContain("easy-host add");
    expect(check.remediation).toContain(EASY_HOST_RAILPACK_BIN);
  });

  it("fails when the binary exists but is not executable", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root, 0o644);

    const check = checkRailpack(
      createEnvironment({
        root,
        runner: createHostRunner({ railpackPath: executable }),
        railpackPath: executable,
      }),
    );

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not executable");
    expect(check.remediation).toContain("chmod +x");
  });

  it("fails when the binary reports a different version than the pin", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const runner = createHostRunner({ railpackPath: executable, railpackVersion: "0.42.9" });

    const check = checkRailpack(createEnvironment({ root, runner, railpackPath: executable }));

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("0.42.9");
    expect(check.detail).toContain(RAILPACK_VERSION);
    expect(check.remediation).toContain(`Railpack ${RAILPACK_VERSION}`);
  });

  it("fails when the version probe exits non-zero", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const runner = createHostRunner({
      railpackPath: executable,
      railpackResult: failed(2, "unknown flag --version"),
    });

    const check = checkRailpack(createEnvironment({ root, runner, railpackPath: executable }));

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("could not report its version");
    expect(check.detail).toContain("unknown flag");
  });

  it("fails when the version output cannot be parsed", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const runner = createHostRunner({
      railpackPath: executable,
      railpackResult: ok("railpack development build\n"),
    });

    const check = checkRailpack(createEnvironment({ root, runner, railpackPath: executable }));

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("did not report a version");
  });

  it("honours EASY_HOST_RAILPACK_BIN and names it in the missing remediation", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const runner = createHostRunner({ railpackPath: executable });

    const present = checkRailpack(
      createEnvironment({
        root,
        runner,
        env: { [EASY_HOST_RAILPACK_BIN]: executable },
      }),
    );
    expect(present.status).toBe("pass");

    const missing = checkRailpack(
      createEnvironment({
        root,
        runner,
        env: { [EASY_HOST_RAILPACK_BIN]: path.join(root, "missing") },
      }),
    );
    expect(missing.status).toBe("fail");
    expect(missing.remediation).toContain(EASY_HOST_RAILPACK_BIN);
  });

  it("parses exact pinned versions and keeps pre-release suffixes", () => {
    expect(parseRailpackVersion("railpack 0.43.0")).toBe("0.43.0");
    expect(parseRailpackVersion("railpack v0.43.0\n")).toBe("0.43.0");
    expect(parseRailpackVersion("railpack 0.43.0-rc.1")).toBe("0.43.0-rc.1");
    expect(parseRailpackVersion("railpack development build")).toBeUndefined();
  });
});

describe("BuildKit doctor check", () => {
  it("passes when the managed socket accepts a connection and probes only once", () => {
    const root = makeTemporaryDirectory();
    const calls: Array<{ socketPath: string; timeoutMs: number }> = [];
    const probe: BuildkitReachabilityProbe = (socketPath, timeoutMs) => {
      calls.push({ socketPath, timeoutMs });
      return true;
    };

    const check = checkBuildkit(createEnvironment({ root, probeBuildkit: probe }));
    const layout = buildkitLayout(path.join(root, "buildkit"));

    expect(check.id).toBe("buildkit");
    expect(check.status).toBe("pass");
    expect(check.detail).toContain(`unix://${layout.socketPath}`);
    expect(check.detail).toContain(BUILDKIT_VERSION);
    expect(check.remediation).toBeNull();
    expect(calls).toEqual([
      { socketPath: layout.socketPath, timeoutMs: BUILDKIT_PROBE_TIMEOUT_MS },
    ]);
  });

  it("fails with the start remediation when the socket is unreachable", () => {
    const root = makeTemporaryDirectory();

    const check = checkBuildkit(createEnvironment({ root, probeBuildkit: () => false }));

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not reachable");
    expect(check.detail).toContain("does not exist");
    expect(check.remediation).toContain("Start the managed BuildKit daemon");
    expect(check.remediation).toContain("easy-host add");
    expect(check.remediation).toContain(BUILDKIT_CONTAINER_NAME);
  });

  it("does not retry an unreachable connection", () => {
    const root = makeTemporaryDirectory();
    let attempts = 0;

    checkBuildkit(
      createEnvironment({
        root,
        probeBuildkit: () => {
          attempts += 1;
          return false;
        },
      }),
    );

    expect(attempts).toBe(1);
  });

  it("reports an occupied non-socket path distinctly", () => {
    const root = makeTemporaryDirectory();
    const buildkitDir = path.join(root, "buildkit");
    const layout = buildkitLayout(buildkitDir);
    mkdirSync(layout.socketDir, { recursive: true });
    writeFileSync(layout.socketPath, "leftover");

    const check = checkBuildkit(
      createEnvironment({ root, buildkitDir, probeBuildkit: () => false }),
    );

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not a unix socket");
    expect(check.remediation).toContain("Start the managed BuildKit daemon");
  });

  it("fails safely when the probe throws", () => {
    const root = makeTemporaryDirectory();

    const check = checkBuildkit(
      createEnvironment({
        root,
        probeBuildkit: () => {
          throw new Error("probe exploded");
        },
      }),
    );

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("probe exploded");
    expect(check.remediation).toContain("Start the managed BuildKit daemon");
  });
});

describe("synchronous socket probe", () => {
  it("returns false for a missing socket", () => {
    const root = makeTemporaryDirectory();
    const layout = buildkitLayout(path.join(root, "buildkit"));

    expect(probeBuildkitSocketSync(layout.socketPath, 100)).toBe(false);
  });

  it("returns true for a listening unix socket", async () => {
    const root = makeTemporaryDirectory();
    const layout = buildkitLayout(path.join(root, "buildkit"));
    mkdirSync(layout.socketDir, { recursive: true });

    const server = createServer((socket) => socket.destroy());
    createdServers.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(layout.socketPath, () => resolve());
    });

    expect(server.address()).toBe(layout.socketPath);
    expect(probeBuildkitSocketSync(layout.socketPath, 500)).toBe(true);
  });
});

describe("build checks in doctor composition", () => {
  it("runs Railpack and BuildKit after Node.js and before disk in a stable order", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const report = diagnose(createHostRunner({ railpackPath: executable }), {
      toolsDir: root,
      railpackPath: executable,
    });

    expect(report.checks.map((check) => check.id)).toEqual(EXPECTED_ORDER);
    expect(report.status).toBe("pass");
  });

  it("fails doctor with exit code 2 when Railpack is missing", () => {
    const root = makeTemporaryDirectory();
    const stdout = new RecordingStream();

    const code = runDoctorCommand({
      stdout,
      env: {},
      username: "alice",
      osRelease: { id: "ubuntu", name: "Ubuntu 24.04 LTS" },
      nodeVersion: "v24.0.0",
      diskPath: root,
      readDiskSpace: () => HEALTHY_DISK,
      toolsDir: root,
      buildkitDir: path.join(root, "buildkit"),
      railpackPath: path.join(root, "missing-railpack"),
      probeBuildkit: () => true,
      runner: createHostRunner(),
    });

    expect(code).toBe(EXIT_CODES.PREREQUISITE);
    expect(stdout.text).toContain("FAIL railpack");
    expect(stdout.text).toContain("next:");
    expect(stdout.text).not.toContain(ANSI_ESCAPE);
  });

  it("fails doctor with exit code 2 and the start remediation when BuildKit is unreachable", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const stdout = new RecordingStream();

    const code = runDoctorCommand({
      stdout,
      env: {},
      username: "alice",
      osRelease: { id: "ubuntu", name: "Ubuntu 24.04 LTS" },
      nodeVersion: "v24.0.0",
      diskPath: root,
      readDiskSpace: () => HEALTHY_DISK,
      toolsDir: root,
      buildkitDir: path.join(root, "buildkit"),
      railpackPath: executable,
      probeBuildkit: () => false,
      runner: createHostRunner({ railpackPath: executable }),
    });

    expect(code).toBe(EXIT_CODES.PREREQUISITE);
    expect(stdout.text).toContain("FAIL buildkit");
    expect(stdout.text).toContain("Start the managed BuildKit daemon");
  });

  it("includes Railpack and BuildKit in the schemaVersion 1 JSON document", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const stdout = new RecordingStream();

    const code = runDoctorCommand({
      json: true,
      stdout,
      env: {},
      username: "alice",
      osRelease: { id: "ubuntu", name: "Ubuntu 24.04 LTS" },
      nodeVersion: "v24.0.0",
      diskPath: root,
      readDiskSpace: () => HEALTHY_DISK,
      toolsDir: root,
      buildkitDir: path.join(root, "buildkit"),
      railpackPath: executable,
      probeBuildkit: () => true,
      runner: createHostRunner({ railpackPath: executable }),
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout.text.match(/"schemaVersion"/g)).toHaveLength(1);
    expect(stdout.text).not.toContain(ANSI_ESCAPE);

    const document = JSON.parse(stdout.text) as {
      schemaVersion: number;
      status: string;
      checks: Array<{ id: string; status: string; detail: string; remediation: string | null }>;
    };

    expect(document.schemaVersion).toBe(1);
    expect(document.status).toBe("pass");
    expect(document.checks.map((check) => check.id)).toEqual(EXPECTED_ORDER);
    expect(Object.keys(document.checks[5] ?? {})).toEqual([
      "id",
      "status",
      "detail",
      "remediation",
    ]);
    expect(document.checks[5]?.id).toBe("railpack");
    expect(document.checks[6]?.id).toBe("buildkit");
    expect(document.checks[5]?.remediation).toBeNull();
    expect(document.checks[6]?.remediation).toBeNull();
  });

  it("renders build-check failures in both human and JSON modes", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const report = diagnose(createHostRunner({ railpackPath: executable }), {
      toolsDir: root,
      railpackPath: path.join(root, "missing-railpack"),
      probeBuildkit: () => false,
    });

    expect(report.status).toBe("fail");

    const human = formatDoctorReport(report);
    expect(human).toContain("FAIL railpack");
    expect(human).toContain("FAIL buildkit");
    expect(human).not.toContain(ANSI_ESCAPE);
    for (const line of human.split("\n")) {
      expect(line.length, line).toBeLessThanOrEqual(80);
    }

    const json = formatDoctorJson(report);
    const document = JSON.parse(json) as {
      schemaVersion: number;
      status: string;
      checks: Array<{ id: string; status: string; remediation: string | null }>;
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.status).toBe("fail");
    expect(document.checks.find((check) => check.id === "railpack")?.status).toBe("fail");
    expect(document.checks.find((check) => check.id === "buildkit")?.status).toBe("fail");
    expect(document.checks.find((check) => check.id === "buildkit")?.remediation).not.toBeNull();
  });

  it("returns both build checks from the group in order", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const checks = runBuildChecks(
      createEnvironment({
        root,
        runner: createHostRunner({ railpackPath: executable }),
        railpackPath: executable,
      }),
    );

    expect(checks.map((check) => check.id)).toEqual(["railpack", "buildkit"]);
  });

  it("keeps a healthy report inside the 2-second budget with one probe attempt", () => {
    const root = makeTemporaryDirectory();
    const executable = makeRailpack(root);
    const runner = createHostRunner({ railpackPath: executable });
    let attempts = 0;
    let nowValue = 1_000;

    const report = diagnose(runner, {
      toolsDir: root,
      railpackPath: executable,
      probeBuildkit: () => {
        attempts += 1;
        return true;
      },
      now: () => {
        nowValue += 21;
        return nowValue;
      },
    });

    expect(report.durationMs).toBeLessThan(2_000);
    expect(attempts).toBe(1);

    for (const call of runner.calls) {
      expect(call.timeoutMs).toBeLessThanOrEqual(DOCTOR_COMMAND_TIMEOUT_MS);
      for (const argument of call.args) {
        expect(argument.toLowerCase()).not.toContain("pull");
        expect(argument.toLowerCase()).not.toContain("download");
      }
    }
  });
});
