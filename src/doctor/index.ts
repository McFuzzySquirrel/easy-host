import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { serializeJson, toDoctorDocument } from "../cli/json.js";
import { createPaths } from "../platform/paths.js";
import {
  type BuildCheckEnvironment,
  type BuildkitReachabilityProbe,
  probeBuildkitSocketSync,
  runBuildChecks,
} from "./build-checks.js";
import {
  checkBootRestart,
  checkGit,
  checkLinger,
  checkNode,
  checkPodman,
  checkPodmanRootless,
  createProcessRunner,
  currentUsername,
  type DiskSpaceReader,
  type DoctorCheck,
  type DoctorCheckEnvironment,
  defaultDiskPath,
  type OsRelease,
  type ProcessRunner,
  readDiskSpace,
  readOsRelease,
} from "./checks.js";
import {
  type DirectorySizeReader,
  type DiskUsageReport,
  readDirectorySize,
  runDiskChecks,
} from "./disk-checks.js";

/**
 * Doctor composition, human rendering, and the `--json` document.
 *
 * The report order is stable and matches `runDoctor`: Podman, rootless mode,
 * lingering, git, Node.js, Railpack, BuildKit, disk. Human output carries text
 * status labels and no ANSI escapes (`PRE-FR-07`, `PRE-NF-02`, `PRD-ACC-02`).
 * Doctor reads only local state; it never contacts the network (`PRE-NF-01`),
 * never downloads Railpack, and never starts the BuildKit daemon
 * (`BLD-FR-05`).
 */

/** The overall verdict for the host. A skip is reported as a warning. */
export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorReport {
  status: DoctorStatus;
  checks: DoctorCheck[];
  /** Approximate disk figures also carried by the JSON document (`OBS-FR-04`). */
  disk: DiskUsageReport;
  /** Wall-clock duration measured with the injectable clock. */
  durationMs: number;
}

/** Everything doctor can override. Tests inject fakes for all of it. */
export interface DoctorOptions {
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  username?: string;
  osRelease?: OsRelease;
  nodeVersion?: string;
  diskPath?: string;
  readDiskSpace?: DiskSpaceReader;
  /** `<root>/tools`; defaults to the state-root layout. */
  toolsDir?: string;
  /** `<root>/buildkit`; defaults to the state-root layout. */
  buildkitDir?: string;
  /** `<root>/apps`; defaults to the state-root layout. */
  appsDir?: string;
  /** Recursive directory-size reader for workspace and tools usage. */
  readDirectorySize?: DirectorySizeReader;
  /** Base directory for a relative Railpack override. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory for `~/` expansion. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Test seam for an explicit Railpack executable path. */
  railpackPath?: string;
  /** Managed-socket reachability probe. Defaults to the real local probe. */
  probeBuildkit?: BuildkitReachabilityProbe;
  /** Monotonic millisecond clock used for the budget report. */
  now?: () => number;
}

/** Stable shape of `doctor --json` under `schemaVersion: 1`. */
export type { DoctorDocument } from "../cli/schemas.js";
export type {
  AppDiskUsage,
  DirectorySizeReader,
  DiskUsageReport,
  WorkspaceDiskUsage,
} from "./disk-checks.js";
export { toDoctorDocument };

/** The report is required to fit an 80-column terminal (`OBS-FR-02`). */
const REPORT_WIDTH = 80;
const STATUS_LABEL_WIDTH = 4;

/**
 * Runs the ordered host checks and measures the elapsed time. Checks never
 * throw, so an unexpected process failure is a failing check rather than an
 * uncaught exception.
 */
export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const now = options.now ?? (() => performance.now());
  const env = options.env ?? process.env;
  const startedAt = now();

  const environment: DoctorCheckEnvironment = {
    runner: options.runner ?? createProcessRunner(),
    username: options.username ?? currentUsername(env),
    osRelease: options.osRelease ?? readOsRelease(),
    nodeVersion: options.nodeVersion ?? process.version,
    diskPath: options.diskPath ?? defaultDiskPath(env),
    readDiskSpace: options.readDiskSpace ?? readDiskSpace,
  };

  const paths = createPaths({
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  const buildEnvironment: BuildCheckEnvironment = {
    runner: environment.runner,
    env,
    toolsDir: options.toolsDir ?? paths.toolsDir,
    buildkitDir: options.buildkitDir ?? paths.buildkitDir,
    cwd: options.cwd ?? process.cwd(),
    homeDir: options.homeDir ?? homedir(),
    probeBuildkit: options.probeBuildkit ?? probeBuildkitSocketSync,
    ...(options.railpackPath === undefined ? {} : { railpackPath: options.railpackPath }),
  };

  const checks = [
    checkPodman(environment),
    checkPodmanRootless(environment),
    checkLinger(environment),
    checkBootRestart(environment),
    checkGit(environment),
    checkNode(environment),
    ...runBuildChecks(buildEnvironment),
  ];

  // The disk group runs last so its measurements are included in the elapsed
  // time and cannot delay the prerequisite checks ahead of it.
  const disk = runDiskChecks({
    runner: environment.runner,
    readDiskSpace: environment.readDiskSpace,
    diskPath: environment.diskPath,
    appsDir: options.appsDir ?? paths.appsDir,
    toolsDir: buildEnvironment.toolsDir,
    buildkitDir: buildEnvironment.buildkitDir,
    readDirectorySize: options.readDirectorySize ?? readDirectorySize,
  });
  checks.push(disk.check);

  return {
    status: overallStatus(checks),
    checks,
    disk: disk.usage,
    durationMs: Math.max(0, now() - startedAt),
  };
}

/**
 * A failing check always fails the host; a warning or a skipped check keeps the
 * exit at 0 but never reports `pass` (`PRE-NF-02`).
 */
export function overallStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }

  if (checks.some((check) => check.status === "warn" || check.status === "skip")) {
    return "warn";
  }

  return "pass";
}

/**
 * Renders the stable ordered human report. Every non-pass check gets its own
 * `next:` remediation line, and every line is wrapped to 80 columns.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["easy-host doctor", ""];
  const labelWidth = Math.max(4, ...report.checks.map((check) => check.id.length));

  for (const check of report.checks) {
    const marker = `${statusLabel(check.status)} ${check.id.padEnd(labelWidth)}  `;
    lines.push(...withMarker(marker, check.detail));

    if (check.remediation !== null && check.remediation.length > 0) {
      lines.push(...withMarker("  next:  ", check.remediation));
    }
  }

  lines.push("");
  lines.push(describeCounts(report.checks));
  lines.push(`Result: ${report.status}`);

  return `${lines.join("\n")}\n`;
}

/**
 * Serializes `doctor --json` as one newline-terminated document. The shape is
 * the shared contract in `src/cli/schemas.ts`.
 */
export function formatDoctorJson(report: DoctorReport): string {
  return serializeJson(toDoctorDocument(report));
}

function statusLabel(status: DoctorCheck["status"]): string {
  return status.toUpperCase().padEnd(STATUS_LABEL_WIDTH);
}

function withMarker(marker: string, text: string): string[] {
  const width = Math.max(20, REPORT_WIDTH - marker.length);
  const wrapped = wrapText(text, width);

  return wrapped.map((line, index) =>
    index === 0 ? `${marker}${line}` : `${" ".repeat(marker.length)}${line}`,
  );
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const pieces = splitLongWord(word, width);

    if (pieces.length > 1) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }

      for (const piece of pieces.slice(0, -1)) {
        lines.push(piece);
      }

      current = pieces[pieces.length - 1] ?? "";
      continue;
    }

    if (current.length === 0) {
      current = word;
      continue;
    }

    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function splitLongWord(word: string, width: number): string[] {
  if (word.length <= width) {
    return [word];
  }

  const pieces: string[] = [];
  for (let index = 0; index < word.length; index += width) {
    pieces.push(word.slice(index, index + width));
  }

  return pieces;
}

function describeCounts(checks: readonly DoctorCheck[]): string {
  const count = (status: DoctorCheck["status"]): number =>
    checks.filter((check) => check.status === status).length;

  const total = checks.length;
  const label = total === 1 ? "check" : "checks";

  return `${total} ${label}: ${count("pass")} passed, ${count("warn")} warnings, ${count(
    "fail",
  )} failed, ${count("skip")} skipped.`;
}
