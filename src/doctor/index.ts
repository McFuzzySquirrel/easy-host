import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { createPaths } from "../platform/paths.js";
import {
  type BuildCheckEnvironment,
  type BuildkitReachabilityProbe,
  probeBuildkitSocketSync,
  runBuildChecks,
} from "./build-checks.js";
import {
  checkDisk,
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
export interface DoctorDocument {
  schemaVersion: 1;
  status: DoctorStatus;
  checks: Array<{
    id: string;
    status: DoctorCheck["status"];
    detail: string;
    remediation: string | null;
  }>;
}

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
    checkGit(environment),
    checkNode(environment),
    ...runBuildChecks(buildEnvironment),
    checkDisk(environment),
  ];

  return {
    status: overallStatus(checks),
    checks,
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
 * Converts the report to the stable JSON document. Exactly one document is
 * written by the caller, with empty arrays present and no ANSI escapes.
 */
export function toDoctorDocument(report: DoctorReport): DoctorDocument {
  return {
    schemaVersion: 1,
    status: report.status,
    checks: report.checks.map((check) => ({
      id: check.id,
      status: check.status,
      detail: check.detail,
      remediation: check.remediation,
    })),
  };
}

/** Serializes `doctor --json` as one newline-terminated document. */
export function formatDoctorJson(report: DoctorReport): string {
  return `${JSON.stringify(toDoctorDocument(report), null, 2)}\n`;
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
