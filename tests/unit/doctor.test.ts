import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDoctorCommand } from "../../src/cli/commands/doctor.js";
import { EXIT_CODES } from "../../src/cli/errors.js";
import {
  DOCTOR_BUDGET_MS,
  DOCTOR_COMMAND_TIMEOUT_MS,
  type DoctorCheck,
  GIT_MIN_VERSION,
  PODMAN_VERSION_RANGE,
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
  toDoctorDocument,
} from "../../src/doctor/index.js";
import { RAILPACK_VERSION } from "../../src/platform/versions.js";

const GIB = 1024 ** 3;
const ANSI_ESCAPE = "\u001B[";
const HEALTHY_DISK = { freeBytes: 42 * GIB, totalBytes: 200 * GIB };

let buildRoot = "";
let railpackPath = "";

beforeAll(() => {
  buildRoot = mkdtempSync(path.join(tmpdir(), "easy-host-doctor-"));
  railpackPath = path.join(buildRoot, "railpack");
  writeFileSync(railpackPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

afterAll(() => {
  if (buildRoot.length > 0) {
    rmSync(buildRoot, { recursive: true, force: true });
  }
});

/** Healthy build-check defaults so host-check tests stay focused. */
function buildCheckOptions(): DoctorOptions {
  return {
    toolsDir: buildRoot,
    buildkitDir: path.join(buildRoot, "buildkit"),
    railpackPath,
    probeBuildkit: () => true,
  };
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

function missing(): ProcessRunResult {
  return { exitCode: 127, stdout: "", stderr: "", spawnError: "ENOENT" };
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

interface HostOptions {
  podmanVersion?: string | null;
  rootless?: boolean | null;
  linger?: "yes" | "no" | null;
  gitVersion?: string | null;
  bootRestart?: "enabled" | "disabled" | null;
}

function createHost(options: HostOptions = {}): RecordingRunner {
  const {
    podmanVersion = "5.7.0",
    rootless = true,
    linger = "yes",
    gitVersion = "2.43.0",
    bootRestart = "enabled",
  } = options;

  return new RecordingRunner((command, args) => {
    if (command === "systemctl" && args[1] === "is-enabled") {
      if (bootRestart === null) {
        return missing();
      }

      return ok(`${bootRestart}\n`);
    }

    if (command === "podman" && args[0] === "--version") {
      return podmanVersion === null ? missing() : ok(`podman version ${podmanVersion}\n`);
    }

    if (command === "podman" && args[0] === "info") {
      if (podmanVersion === null) {
        return missing();
      }

      if (rootless === null) {
        return failed(125, "cannot connect to Podman");
      }

      return ok(`${rootless ? "true" : "false"}\n`);
    }

    if (command === "loginctl") {
      return linger === null ? missing() : ok(`Linger=${linger}\n`);
    }

    if (command === "git" && args[0] === "--version") {
      return gitVersion === null ? missing() : ok(`git version ${gitVersion}\n`);
    }

    if (command === railpackPath && args[0] === "--version") {
      return ok(`railpack ${RAILPACK_VERSION}\n`);
    }

    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  });
}

function diagnose(runner: ProcessRunner, overrides: DoctorOptions = {}): DoctorReport {
  return runDoctor({
    runner,
    env: {},
    username: "alice",
    osRelease: { id: "ubuntu", name: "Ubuntu 24.04 LTS" },
    nodeVersion: "v24.0.0",
    diskPath: "/var/lib/easy-host",
    readDiskSpace: () => HEALTHY_DISK,
    now: () => 0,
    ...buildCheckOptions(),
    ...overrides,
  });
}

function findCheck(report: DoctorReport, id: string): DoctorCheck {
  const check = report.checks.find((candidate) => candidate.id === id);
  if (check === undefined) {
    throw new Error(`expected a "${id}" check`);
  }

  return check;
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

function fakeClock(...values: number[]): () => number {
  let index = 0;

  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe("healthy host", () => {
  it("passes every check in the stable documented order", () => {
    const report = diagnose(createHost());

    expect(report.status).toBe("pass");
    expect(report.checks.map((check) => check.id)).toEqual([
      "podman",
      "podman-rootless",
      "linger",
      "boot-restart",
      "git",
      "node",
      "railpack",
      "buildkit",
      "disk",
    ]);

    for (const check of report.checks) {
      expect(check.status, check.id).toBe("pass");
      expect(check.remediation, check.id).toBeNull();
      expect(check.detail.length, check.id).toBeGreaterThan(0);
    }
  });

  it("returns exit code 0 and a human report for a healthy host", () => {
    const stdout = new RecordingStream();

    const code = runDoctorCommand({
      runner: createHost(),
      stdout,
      env: {},
      username: "alice",
      osRelease: { id: "ubuntu", name: "Ubuntu 24.04 LTS" },
      nodeVersion: "v24.0.0",
      diskPath: "/var/lib/easy-host",
      readDiskSpace: () => HEALTHY_DISK,
      ...buildCheckOptions(),
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout.text).toContain("easy-host doctor");
    expect(stdout.text).toContain("PASS podman");
    expect(stdout.text).toContain("PASS podman-rootless");
    expect(stdout.text).toContain("PASS linger");
    expect(stdout.text).toContain("PASS git");
    expect(stdout.text).toContain("PASS node");
    expect(stdout.text).toContain("PASS railpack");
    expect(stdout.text).toContain("PASS buildkit");
    expect(stdout.text).toContain("PASS disk");
    expect(stdout.text).toContain("Result: pass");
    expect(stdout.text).not.toContain("next:");
    expect(stdout.text).not.toContain(ANSI_ESCAPE);
  });
});

describe("Podman version range", () => {
  it("fails when Podman is missing", () => {
    const report = diagnose(createHost({ podmanVersion: null }));

    const podman = findCheck(report, "podman");
    expect(podman.status).toBe("fail");
    expect(podman.detail).toContain("not found");
    expect(podman.remediation).toContain(PODMAN_VERSION_RANGE);

    const rootless = findCheck(report, "podman-rootless");
    expect(rootless.status).toBe("skip");
    expect(rootless.remediation).not.toBeNull();

    expect(report.status).toBe("fail");

    const code = runDoctorCommand({
      runner: createHost({ podmanVersion: null }),
      stdout: new RecordingStream(),
      env: {},
      username: "alice",
      osRelease: { id: "ubuntu", name: "Ubuntu 24.04 LTS" },
      nodeVersion: "v24.0.0",
      readDiskSpace: () => HEALTHY_DISK,
      ...buildCheckOptions(),
    });
    expect(code).toBe(EXIT_CODES.PREREQUISITE);
  });

  it("distinguishes a timed-out Podman call from a missing binary", () => {
    const runner = new RecordingRunner((command, args) => {
      if (command === "podman" && args[0] === "--version") {
        return { exitCode: 1, stdout: "", stderr: "", spawnError: "ETIMEDOUT" };
      }

      return missing();
    });

    const podman = findCheck(diagnose(runner), "podman");
    expect(podman.status).toBe("fail");
    expect(podman.detail).toContain("could not be executed");
    expect(podman.detail).not.toContain("not found");
  });

  it("fails for Podman 4.9.3 and names the found and required versions", () => {
    const report = diagnose(createHost({ podmanVersion: "4.9.3" }));

    const podman = findCheck(report, "podman");
    expect(podman.status).toBe("fail");
    expect(podman.detail).toContain("4.9.3");
    expect(podman.detail).toContain(">= 5.7.0");
    expect(podman.detail).toContain("< 6.0.0");
    expect(podman.detail).toContain("Ubuntu");
    expect(podman.remediation).toContain("Upgrade");
    expect(report.status).toBe("fail");
  });

  it.each(["5.7.0", "5.8.9"])("passes for rootless Podman %s", (version) => {
    const report = diagnose(createHost({ podmanVersion: version }));

    expect(findCheck(report, "podman").status).toBe("pass");
    expect(findCheck(report, "podman").detail).toContain(version);
    expect(findCheck(report, "podman-rootless").status).toBe("pass");
    expect(report.status).toBe("pass");
  });

  it("rejects Podman 6.1.4 and names the unsupported major line", () => {
    const report = diagnose(createHost({ podmanVersion: "6.1.4" }));

    const podman = findCheck(report, "podman");
    expect(podman.status).toBe("fail");
    expect(podman.detail).toContain("6.1.4");
    expect(podman.detail).toContain("6.x");
    expect(podman.detail).toContain(">= 5.7.0");
    expect(podman.detail).toContain("< 6.0.0");
    expect(podman.detail).toContain("Ubuntu");
    expect(podman.remediation).toContain("Downgrade");
    expect(report.status).toBe("fail");
  });

  it("fails when Podman is not rootless", () => {
    const report = diagnose(createHost({ rootless: false }));

    const rootless = findCheck(report, "podman-rootless");
    expect(rootless.status).toBe("fail");
    expect(rootless.detail).toContain("rootless");
    expect(rootless.remediation).toContain("without sudo");
    expect(report.status).toBe("fail");
  });

  it("fails when rootless mode cannot be confirmed", () => {
    const report = diagnose(createHost({ rootless: null }));

    expect(findCheck(report, "podman-rootless").status).toBe("fail");
    expect(report.status).toBe("fail");
  });
});

describe("lingering", () => {
  it("fails when lingering is disabled and explains the reboot consequence", () => {
    const report = diagnose(createHost({ linger: "no" }));

    const linger = findCheck(report, "linger");
    expect(linger.status).toBe("fail");
    expect(linger.detail).toContain("--restart=always");
    expect(linger.detail).toContain("reboot");
    expect(linger.remediation).toContain("loginctl enable-linger alice");
    expect(report.status).toBe("fail");
  });

  it("fails when loginctl is unavailable", () => {
    const report = diagnose(createHost({ linger: null }));

    const linger = findCheck(report, "linger");
    expect(linger.status).toBe("fail");
    expect(linger.detail).toContain("loginctl");
    expect(linger.remediation).toContain("enable-linger");
  });
});

describe("reboot recovery", () => {
  it("passes when podman-restart.service is enabled", () => {
    const report = diagnose(createHost({ bootRestart: "enabled" }));

    const check = findCheck(report, "boot-restart");
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("reboot");
    expect(check.remediation).toBeNull();
    expect(report.status).toBe("pass");
  });

  it("fails when the unit is disabled and names the reboot consequence", () => {
    const report = diagnose(createHost({ bootRestart: "disabled" }));

    const check = findCheck(report, "boot-restart");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("--restart=always");
    expect(check.detail).toContain("will not return after a reboot");
    expect(check.remediation).toContain("systemctl --user enable --now podman-restart.service");
    expect(report.status).toBe("fail");
  });

  it("skips when systemctl is unavailable instead of claiming pass", () => {
    const report = diagnose(createHost({ bootRestart: null }));

    const check = findCheck(report, "boot-restart");
    expect(check.status).toBe("skip");
    expect(check.detail).toContain("systemctl");
  });
});

describe("git and Node.js", () => {
  it("fails for git 2.39.2 and prints the found version", () => {
    const report = diagnose(createHost({ gitVersion: "2.39.2" }));

    const git = findCheck(report, "git");
    expect(git.status).toBe("fail");
    expect(git.detail).toContain("2.39.2");
    expect(git.detail).toContain("2.40");
    expect(report.status).toBe("fail");
  });

  it("passes for git 2.40.0", () => {
    const report = diagnose(createHost({ gitVersion: "2.40.0" }));

    expect(findCheck(report, "git").status).toBe("pass");
    expect(report.status).toBe("pass");
    expect(GIT_MIN_VERSION.major).toBe(2);
  });

  it("fails when git is missing", () => {
    const report = diagnose(createHost({ gitVersion: null }));

    expect(findCheck(report, "git").status).toBe("fail");
    expect(findCheck(report, "git").detail).toContain("not found");
  });

  it("fails below Node.js 24 and passes at 24+", () => {
    const old = diagnose(createHost(), { nodeVersion: "v22.11.0" });
    expect(findCheck(old, "node").status).toBe("fail");
    expect(findCheck(old, "node").detail).toContain("22.11.0");

    const current = diagnose(createHost(), { nodeVersion: "v24.0.0" });
    expect(findCheck(current, "node").status).toBe("pass");
  });
});

describe("disk space", () => {
  it("fails below 2 GiB free", () => {
    const report = diagnose(createHost(), {
      readDiskSpace: () => ({ freeBytes: 1 * GIB, totalBytes: 200 * GIB }),
    });

    const disk = findCheck(report, "disk");
    expect(disk.status).toBe("fail");
    expect(disk.detail).toContain("1.0 GiB");
    expect(disk.remediation).not.toBeNull();
    expect(report.status).toBe("fail");
  });

  it("warns between 2 GiB and 5 GiB free without failing", () => {
    const report = diagnose(createHost(), {
      readDiskSpace: () => ({ freeBytes: 4 * GIB, totalBytes: 200 * GIB }),
    });

    expect(findCheck(report, "disk").status).toBe("warn");
    expect(report.status).toBe("warn");
  });

  it("passes above 5 GiB free", () => {
    const report = diagnose(createHost());

    expect(findCheck(report, "disk").status).toBe("pass");
  });

  it("skips when the filesystem cannot be measured and never reports pass", () => {
    const report = diagnose(createHost(), {
      readDiskSpace: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });

    const disk = findCheck(report, "disk");
    expect(disk.status).toBe("skip");
    expect(disk.remediation).not.toBeNull();
    expect(report.status).toBe("warn");
  });
});

describe("report rendering and JSON", () => {
  it("keeps a stable ordered report within 80 columns", () => {
    const report = diagnose(
      createHost({ podmanVersion: "4.9.3", rootless: false, linger: "no", gitVersion: "2.39.2" }),
      {
        nodeVersion: "v22.11.0",
        readDiskSpace: () => ({ freeBytes: 1 * GIB, totalBytes: 200 * GIB }),
      },
    );
    const text = formatDoctorReport(report);
    const lines = text.split("\n");

    const positions = [
      "podman",
      "podman-rootless",
      "linger",
      "boot-restart",
      "git",
      "node",
      "railpack",
      "buildkit",
      "disk",
    ].map((id) => lines.findIndex((line) => line.includes(id)));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));

    for (const line of lines) {
      expect(line.length, line).toBeLessThanOrEqual(80);
      expect(line).not.toContain(ANSI_ESCAPE);
    }

    const normalized = text.replace(/\s+/g, " ");
    for (const check of report.checks.filter((candidate) => candidate.status !== "pass")) {
      expect(normalized, check.id).toContain((check.remediation ?? "").replace(/\s+/g, " "));
    }
  });

  it("emits schemaVersion 1 with stable check fields and no ANSI escapes", () => {
    const report = diagnose(createHost());
    const document = toDoctorDocument(report);

    expect(document.schemaVersion).toBe(1);
    expect(document.status).toBe("pass");
    expect(Array.isArray(document.checks)).toBe(true);
    expect(document.checks).toHaveLength(9);

    for (const check of document.checks) {
      expect(Object.keys(check)).toEqual(["id", "status", "detail", "remediation"]);
      expect(check.status).toBe("pass");
      expect(check.remediation).toBeNull();
    }

    const text = formatDoctorJson(report);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain(ANSI_ESCAPE);
    expect(JSON.parse(text)).toEqual(document);
  });

  it("reports a failing overall status in JSON and exits 2", () => {
    const stdout = new RecordingStream();
    const code = runDoctorCommand({
      json: true,
      runner: createHost({ podmanVersion: "6.1.4" }),
      stdout,
      env: {},
      username: "alice",
      osRelease: { id: "fedora", name: "Fedora Linux 42" },
      nodeVersion: "v24.0.0",
      diskPath: "/var/lib/easy-host",
      readDiskSpace: () => HEALTHY_DISK,
      ...buildCheckOptions(),
    });

    expect(code).toBe(EXIT_CODES.PREREQUISITE);
    expect(stdout.text.match(/"schemaVersion"/g)).toHaveLength(1);

    const document = JSON.parse(stdout.text) as {
      schemaVersion: number;
      status: string;
      checks: Array<{ id: string; status: string }>;
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.status).toBe("fail");
    expect(document.checks.find((check) => check.id === "podman")?.status).toBe("fail");
  });
});

describe("safety and budget", () => {
  it("never reports a non-pass check as pass", () => {
    const report = diagnose(
      createHost({
        podmanVersion: "4.9.3",
        rootless: false,
        linger: "no",
        gitVersion: "2.39.2",
        bootRestart: "disabled",
      }),
      {
        nodeVersion: "v22.11.0",
        readDiskSpace: () => ({ freeBytes: 1 * GIB, totalBytes: 200 * GIB }),
        railpackPath: path.join(buildRoot, "missing-railpack"),
        probeBuildkit: () => false,
      },
    );

    expect(report.status).toBe("fail");
    for (const check of report.checks) {
      expect(check.status, check.id).not.toBe("pass");
    }
  });

  it("finishes under 2 seconds using a fake clock and stays off the network", () => {
    const runner = createHost();
    const report = diagnose(runner, { now: fakeClock(1_000, 1_042) });

    expect(report.durationMs).toBe(42);
    expect(report.durationMs).toBeLessThan(DOCTOR_BUDGET_MS);

    const localCommands = new Set(["podman", "loginctl", "systemctl", "git", railpackPath]);
    const networkArguments = ["pull", "push", "search", "login", "clone", "fetch", "http"];

    expect(runner.calls.length).toBeGreaterThan(0);

    for (const call of runner.calls) {
      expect(localCommands.has(call.command), call.command).toBe(true);
      expect(call.timeoutMs, call.command).toBe(DOCTOR_COMMAND_TIMEOUT_MS);
      expect(call.timeoutMs).toBeLessThanOrEqual(DOCTOR_BUDGET_MS);

      for (const argument of call.args) {
        for (const forbidden of networkArguments) {
          expect(argument.toLowerCase(), `${call.command} ${argument}`).not.toContain(forbidden);
        }
      }
    }
  });

  it("applies a finite timeout to every process call", () => {
    const runner = createHost();
    diagnose(runner);

    for (const call of runner.calls) {
      expect(call.timeoutMs).toBe(DOCTOR_COMMAND_TIMEOUT_MS);
    }
  });
});
