/**
 * Doctor disk group (`OBS-1.4`, `OBS-FR-04`).
 *
 * The tests inject the process runner and the directory-size reader, so they
 * exercise the production composition without Podman, a real build cache, or
 * a multi-gigabyte workspace. Every filesystem path is a temporary root.
 *
 * Covered: per-app image sums, the BuildKit cache (report row and managed
 * state fallback), workspace and tools usage, the 5 GiB warning and 2 GiB
 * failure thresholds, unavailable measurements staying `null` rather than
 * zero, the identical JSON figures, read-only process calls, and the
 * 2-second budget contract.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctorCommand } from "../../src/cli/commands/doctor.js";
import { EXIT_CODES } from "../../src/cli/errors.js";
import {
  DOCTOR_BUDGET_MS,
  DOCTOR_COMMAND_TIMEOUT_MS,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../../src/doctor/checks.js";
import {
  type DirectorySizeReader,
  type DiskCheckEnvironment,
  parseApproximateSize,
  parseBuildkitCacheBytes,
  parsePodmanImagesJson,
  readDirectorySize,
  runDiskChecks,
} from "../../src/doctor/disk-checks.js";
import {
  type DoctorOptions,
  type DoctorReport,
  runDoctor,
  toDoctorDocument,
} from "../../src/doctor/index.js";
import { RAILPACK_VERSION } from "../../src/platform/versions.js";

const MiB = 1024 ** 2;
const GIB = 1024 ** 3;
const HEALTHY_SPACE = { freeBytes: 42 * GIB, totalBytes: 200 * GIB };
const ANSI_ESCAPE = "\u001B[";

const roots: string[] = [];
const railpackDirectories: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }

  for (const directory of railpackDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
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

interface Call {
  command: string;
  args: readonly string[];
  timeoutMs: number | undefined;
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

function ok(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(exitCode = 1): ProcessRunResult {
  return { exitCode, stdout: "", stderr: "boom" };
}

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "easy-host-doctor-disk-"));
  roots.push(root);
  return root;
}

function makeApp(root: string, name: string): void {
  mkdirSync(path.join(root, "apps", name, "workspace"), { recursive: true });
}

function makeRailpack(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "easy-host-doctor-disk-railpack-"));
  railpackDirectories.push(directory);
  const executable = path.join(directory, "railpack");
  writeFileSync(executable, `#!/bin/sh\nprintf 'railpack ${RAILPACK_VERSION}\\n'\n`, {
    mode: 0o755,
  });
  return executable;
}

interface RunnerOptions {
  /** `null` makes `podman images` fail. */
  images?: string | null;
  /** `null` makes `podman system df` fail. */
  systemDf?: string | null;
  railpackPath?: string;
}

function createHostRunner(options: RunnerOptions = {}): RecordingRunner {
  return new RecordingRunner((command, args) => {
    if (command === "podman" && args[0] === "--version") {
      return ok("podman version 5.7.0\n");
    }

    if (command === "podman" && args[0] === "info") {
      return ok("true\n");
    }

    if (command === "podman" && args[0] === "images") {
      return options.images === null ? failed() : ok(options.images ?? "[]\n");
    }

    if (command === "podman" && args[0] === "system" && args[1] === "df") {
      return options.systemDf === null ? failed() : ok(options.systemDf ?? "[]\n");
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
      return ok(`railpack ${RAILPACK_VERSION}\n`);
    }

    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  });
}

function sizes(entries: Readonly<Record<string, number>>): DirectorySizeReader {
  return (target) => {
    const bytes = entries[target];
    if (bytes === undefined) {
      throw new Error(`unexpected size read: ${target}`);
    }

    return bytes;
  };
}

function createEnvironment(
  root: string,
  overrides: Partial<DiskCheckEnvironment> = {},
): DiskCheckEnvironment {
  return {
    runner: createHostRunner(),
    readDiskSpace: () => HEALTHY_SPACE,
    diskPath: root,
    appsDir: path.join(root, "apps"),
    toolsDir: path.join(root, "tools"),
    buildkitDir: path.join(root, "buildkit"),
    readDirectorySize: () => 0,
    ...overrides,
  };
}

const IMAGE_LISTING = JSON.stringify([
  {
    RepoTags: ["localhost/easy-host-blog:20261030T120000Z"],
    Size: 800 * MiB,
  },
  {
    RepoTags: ["localhost/easy-host-blog:20261029T090000Z"],
    Size: 200 * MiB,
  },
  {
    RepoTags: ["localhost/easy-host-api:20261030T120000Z"],
    Size: 400 * MiB,
  },
  {
    RepoTags: ["docker.io/library/node:24"],
    Size: 999 * MiB,
  },
]);

describe("podman images parsing", () => {
  it("sums image sizes per easy-host app and ignores foreign images", () => {
    const totals = parsePodmanImagesJson(IMAGE_LISTING);

    expect(totals).toEqual(
      new Map([
        ["blog", 1000 * MiB],
        ["api", 400 * MiB],
      ]),
    );
  });

  it("counts one image once even when it carries several tags and a digest", () => {
    const totals = parsePodmanImagesJson(
      JSON.stringify([
        {
          RepoTags: [
            "localhost/easy-host-blog:20261030T120000Z",
            "localhost/easy-host-blog:latest",
          ],
          RepoDigests: [
            "localhost/easy-host-blog@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ],
          Names: ["localhost/easy-host-blog:20261030T120000Z"],
          Size: 50 * MiB,
        },
      ]),
    );

    expect(totals).toEqual(new Map([["blog", 50 * MiB]]));
  });

  it("does not double count one image repeated once per tag", () => {
    const totals = parsePodmanImagesJson(
      JSON.stringify([
        { Id: "sha256:aaa", RepoTags: ["localhost/easy-host-blog:new"], Size: 90 * MiB },
        { Id: "sha256:aaa", RepoTags: ["localhost/easy-host-blog:old"], Size: 90 * MiB },
      ]),
    );

    expect(totals).toEqual(new Map([["blog", 90 * MiB]]));
  });

  it("reads repository and tag fields when RepoTags is absent", () => {
    const totals = parsePodmanImagesJson(
      JSON.stringify([
        { Repository: "localhost/easy-host-api", Tag: "20261030T120000Z", Size: 12 * MiB },
        { Repository: "localhost/easy-host-blog", Tag: "<none>", Size: 4 * MiB },
      ]),
    );

    expect(totals).toEqual(
      new Map([
        ["blog", 4 * MiB],
        ["api", 12 * MiB],
      ]),
    );
  });

  it("returns null for an unusable listing instead of reporting zero", () => {
    expect(parsePodmanImagesJson("not json")).toBeNull();
    expect(parsePodmanImagesJson('{"unexpected":"shape"}')).toBeNull();
  });
});

describe("BuildKit cache parsing", () => {
  it("reads a build-cache row from podman system df", () => {
    expect(
      parseBuildkitCacheBytes(
        JSON.stringify([
          { Type: "Images", Total: 2, RawSize: 4_000 },
          { Type: "Build Cache", Total: 1, RawSize: 3 * GIB },
        ]),
      ),
    ).toBe(3 * GIB);
  });

  it("reads a wrapper object key and a human-readable size", () => {
    expect(parseBuildkitCacheBytes(JSON.stringify({ BuildCacheSize: 2 * GIB }))).toBe(2 * GIB);
    expect(parseBuildkitCacheBytes(JSON.stringify([{ Type: "Build Cache", Size: "1.5GiB" }]))).toBe(
      Math.round(1.5 * GIB),
    );
  });

  it("returns null when Podman 5.7 reports no build cache", () => {
    expect(
      parseBuildkitCacheBytes(
        JSON.stringify([
          { Type: "Images", RawSize: 10 },
          { Type: "Containers", RawSize: 20 },
          { Type: "Local Volumes", RawSize: 30 },
        ]),
      ),
    ).toBeNull();
  });

  it("parses approximate human sizes and rejects nonsense", () => {
    expect(parseApproximateSize("512 MiB")).toBe(512 * MiB);
    expect(parseApproximateSize("2GB")).toBe(2 * GIB);
    expect(parseApproximateSize("lots")).toBeNull();
  });
});

describe("directory size", () => {
  it("sums regular files, descends directories, and never follows a symlink", () => {
    const root = makeRoot();
    const outside = makeRoot();
    mkdirSync(path.join(root, "nested"), { recursive: true });
    writeFileSync(path.join(root, "top.bin"), Buffer.alloc(100));
    writeFileSync(path.join(root, "nested", "child.bin"), Buffer.alloc(50));
    writeFileSync(path.join(outside, "not-counted.bin"), Buffer.alloc(4096));
    symlinkSync(outside, path.join(root, "escape"));

    expect(readDirectorySize(root)).toBe(150);
  });

  it("reports a missing path as zero bytes of usage", () => {
    expect(readDirectorySize(path.join(makeRoot(), "never-created"))).toBe(0);
  });

  it("refuses to measure a symlinked root instead of escaping the state tree", () => {
    const root = makeRoot();
    const target = makeRoot();
    const link = path.join(root, "workspace-link");
    symlinkSync(target, link);

    expect(() => readDirectorySize(link)).toThrow(/symlink/);
  });
});

describe("disk group figures", () => {
  it("reports per-app image size, BuildKit cache, workspaces, and tools", () => {
    const root = makeRoot();
    makeApp(root, "blog");
    makeApp(root, "api");
    const tools = path.join(root, "tools");
    const buildkitState = path.join(root, "buildkit", "state");

    const result = runDiskChecks(
      createEnvironment(root, {
        runner: createHostRunner({ images: IMAGE_LISTING, systemDf: "[]\n" }),
        readDirectorySize: sizes({
          [path.join(root, "apps", "blog", "workspace")]: 200 * MiB,
          [path.join(root, "apps", "api", "workspace")]: 100 * MiB,
          [buildkitState]: 2 * GIB,
          [tools]: 50 * MiB,
        }),
      }),
    );

    expect(result.usage).toEqual({
      freeBytes: 42 * GIB,
      totalBytes: 200 * GIB,
      appImages: [
        { app: "api", bytes: 400 * MiB },
        { app: "blog", bytes: 1000 * MiB },
      ],
      imagesTotalBytes: 1400 * MiB,
      buildkitCacheBytes: 2 * GIB,
      workspaces: [
        { app: "api", bytes: 100 * MiB },
        { app: "blog", bytes: 200 * MiB },
      ],
      workspaceTotalBytes: 300 * MiB,
      toolsBytes: 50 * MiB,
      approximate: true,
    });

    expect(result.check.id).toBe("disk");
    expect(result.check.status).toBe("pass");
    expect(result.check.remediation).toBeNull();
    expect(result.check.detail).toContain("Approximate usage");
    expect(result.check.detail).toContain("api 400.0 MiB");
    expect(result.check.detail).toContain("blog 1000.0 MiB");
    expect(result.check.detail).toContain("BuildKit cache 2.0 GiB");
  });

  it("warns below 5 GiB free and fails below 2 GiB free", () => {
    const root = makeRoot();
    makeApp(root, "blog");

    const warning = runDiskChecks(
      createEnvironment(root, {
        readDiskSpace: () => ({ freeBytes: 4 * GIB, totalBytes: 200 * GIB }),
      }),
    );
    expect(warning.check.status).toBe("warn");
    expect(warning.check.detail).toContain("4.0 GiB");
    expect(warning.check.remediation).not.toBeNull();

    const failing = runDiskChecks(
      createEnvironment(root, {
        readDiskSpace: () => ({ freeBytes: 1 * GIB, totalBytes: 200 * GIB }),
      }),
    );
    expect(failing.check.status).toBe("fail");
    expect(failing.check.detail).toContain("1.0 GiB");
    expect(failing.check.remediation).not.toBeNull();
  });

  it("prefers the podman system df cache row over the state directory", () => {
    const root = makeRoot();
    makeApp(root, "blog");

    const result = runDiskChecks(
      createEnvironment(root, {
        runner: createHostRunner({
          images: "[]\n",
          systemDf: JSON.stringify([{ Type: "Build Cache", RawSize: 7 * GIB }]),
        }),
        readDirectorySize: () => {
          throw new Error("the state directory must not be measured");
        },
      }),
    );

    expect(result.usage.buildkitCacheBytes).toBe(7 * GIB);
    expect(result.usage.appImages).toEqual([{ app: "blog", bytes: 0 }]);
    expect(result.usage.appImages[0]?.bytes).not.toBeNull();
  });
});

describe("unavailable measurements", () => {
  it("reports every unreadable figure as unknown, never as zero", () => {
    const root = makeRoot();
    makeApp(root, "blog");

    const result = runDiskChecks(
      createEnvironment(root, {
        runner: createHostRunner({ images: null, systemDf: null }),
        readDirectorySize: () => {
          throw new Error("size is unavailable");
        },
      }),
    );

    expect(result.usage.appImages).toEqual([{ app: "blog", bytes: null }]);
    expect(result.usage.imagesTotalBytes).toBeNull();
    expect(result.usage.buildkitCacheBytes).toBeNull();
    expect(result.usage.workspaces).toEqual([{ app: "blog", bytes: null }]);
    expect(result.usage.workspaceTotalBytes).toBeNull();
    expect(result.usage.toolsBytes).toBeNull();

    expect(result.usage.imagesTotalBytes).not.toBe(0);
    expect(result.usage.buildkitCacheBytes).not.toBe(0);
    expect(result.usage.workspaceTotalBytes).not.toBe(0);
    expect(result.usage.toolsBytes).not.toBe(0);

    expect(result.check.status).toBe("pass");
    expect(result.check.detail).toContain("images unknown (blog unknown)");
    expect(result.check.detail).toContain("BuildKit cache unknown");
    expect(result.check.detail).toContain("workspaces unknown (blog unknown)");
    expect(result.check.detail).toContain("tools unknown");
  });

  it("keeps unknown figures null in the JSON document", () => {
    const root = makeRoot();
    makeApp(root, "blog");

    const result = runDiskChecks(
      createEnvironment(root, {
        runner: createHostRunner({ images: null, systemDf: null }),
        readDirectorySize: () => {
          throw new Error("size is unavailable");
        },
      }),
    );

    const document = toDoctorDocument({
      status: "pass",
      checks: [result.check],
      disk: result.usage,
      durationMs: 0,
    });

    expect(document.disk.appImages).toEqual([{ app: "blog", bytes: null }]);
    expect(document.disk.imagesTotalBytes).toBeNull();
    expect(document.disk.buildkitCacheBytes).toBeNull();
    expect(document.disk.workspaces).toEqual([{ app: "blog", bytes: null }]);
    expect(document.disk.workspaceTotalBytes).toBeNull();
    expect(document.disk.toolsBytes).toBeNull();
    expect(document.disk.approximate).toBe(true);
  });
});

describe("doctor composition", () => {
  function doctorOptions(root: string, overrides: DoctorOptions = {}): DoctorOptions {
    const railpackPath = makeRailpack();
    makeApp(root, "blog");
    makeApp(root, "api");

    return {
      env: { EASY_HOST_HOME: root },
      runner: createHostRunner({ images: IMAGE_LISTING, systemDf: "[]\n", railpackPath }),
      username: "alice",
      osRelease: { id: "ubuntu", name: "Ubuntu 24.04 LTS" },
      nodeVersion: "v24.0.0",
      diskPath: root,
      readDiskSpace: () => HEALTHY_SPACE,
      appsDir: path.join(root, "apps"),
      toolsDir: path.join(root, "tools"),
      buildkitDir: path.join(root, "buildkit"),
      railpackPath,
      probeBuildkit: () => true,
      readDirectorySize: sizes({
        [path.join(root, "apps", "blog", "workspace")]: 200 * MiB,
        [path.join(root, "apps", "api", "workspace")]: 100 * MiB,
        [path.join(root, "buildkit", "state")]: 2 * GIB,
        [path.join(root, "tools")]: 50 * MiB,
      }),
      now: () => 0,
      ...overrides,
    };
  }

  it("includes the same disk figures in the JSON payload as the report", () => {
    const root = makeRoot();
    const options = doctorOptions(root);
    const stream = new RecordingStream();

    const code = runDoctorCommand({ ...options, json: true, stdout: stream });
    expect(code).toBe(EXIT_CODES.SUCCESS);

    const document = JSON.parse(stream.text) as {
      schemaVersion: number;
      disk: Record<string, unknown>;
      checks: Array<{ id: string }>;
    };

    expect(document.schemaVersion).toBe(1);
    expect(document.checks.map((check) => check.id)).toEqual([
      "podman",
      "podman-rootless",
      "linger",
      "git",
      "node",
      "railpack",
      "buildkit",
      "disk",
    ]);

    const report = runDoctor(options);
    expect(document.disk).toEqual(toDoctorDocument(report).disk);
    expect(document.disk.appImages).toEqual([
      { app: "api", bytes: 400 * MiB },
      { app: "blog", bytes: 1000 * MiB },
    ]);
    expect(document.disk.buildkitCacheBytes).toBe(2 * GIB);
    expect(document.disk.workspaceTotalBytes).toBe(300 * MiB);
    expect(document.disk.toolsBytes).toBe(50 * MiB);
    expect(document.disk.approximate).toBe(true);
    expect(stream.text).not.toContain(ANSI_ESCAPE);
  });

  it("renders the approximate figures in the human report within 80 columns", () => {
    const root = makeRoot();
    const stream = new RecordingStream();

    const code = runDoctorCommand({ ...doctorOptions(root), stdout: stream });
    expect(code).toBe(EXIT_CODES.SUCCESS);

    const normalized = stream.text.replace(/\s+/g, " ");
    expect(normalized).toContain("Approximate usage");
    expect(normalized).toContain("blog 1000.0 MiB");
    expect(normalized).toContain("BuildKit cache 2.0 GiB");
    expect(stream.text).not.toContain(ANSI_ESCAPE);

    for (const line of stream.text.split("\n")) {
      expect(line.length, line).toBeLessThanOrEqual(80);
    }
  });

  it("stays read-only and inside the 2-second budget", () => {
    const root = makeRoot();
    const options = doctorOptions(root);
    let nowValue = 1_000;
    const report: DoctorReport = runDoctor({
      ...options,
      now: () => {
        nowValue += 250;
        return nowValue;
      },
    });

    expect(report.durationMs).toBeLessThan(DOCTOR_BUDGET_MS);

    const runner = options.runner as RecordingRunner;
    const diskCalls = runner.calls.filter(
      (call) =>
        call.command === "podman" && (call.args[0] === "images" || call.args[0] === "system"),
    );
    expect(diskCalls.map((call) => call.args)).toEqual([
      ["images", "--format", "json"],
      ["system", "df", "--format", "json"],
    ]);

    const forbidden = ["prune", "rm", "rmi", "stop", "kill", "pull"];
    for (const call of runner.calls) {
      expect(call.timeoutMs, `${call.command} ${call.args.join(" ")}`).toBe(
        DOCTOR_COMMAND_TIMEOUT_MS,
      );

      for (const argument of call.args) {
        expect(forbidden, `${call.command} ${argument}`).not.toContain(argument.toLowerCase());
      }
    }
  });

  it("keeps an unreadable measurement from turning the disk check into a failure", () => {
    const root = makeRoot();
    const options = doctorOptions(root, {
      readDirectorySize: () => {
        throw new Error("cannot read");
      },
    });
    const report = runDoctor(options);

    expect(report.checks.find((check) => check.id === "disk")?.status).toBe("pass");
    expect(report.disk.workspaceTotalBytes).toBeNull();
    expect(report.disk.toolsBytes).toBeNull();
  });
});
