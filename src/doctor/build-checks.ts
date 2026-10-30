import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { BUILDKIT_CONTAINER_NAME, buildkitLayout } from "../platform/buildkit.js";
import { EASY_HOST_RAILPACK_BIN, railpackBinaryPath } from "../platform/railpack.js";
import { BUILDKIT_VERSION, RAILPACK_VERSION } from "../platform/versions.js";
import {
  DOCTOR_COMMAND_TIMEOUT_MS,
  type DoctorCheck,
  type ProcessRunner,
  type ProcessRunResult,
} from "./checks.js";

/**
 * Build prerequisite checks for `easy-host doctor` (`BLD-FR-05`).
 *
 * The group is deliberately read-only:
 *
 * - Railpack is never downloaded. Doctor only inspects an existing executable
 *   and asks it for `--version` behind a finite timeout.
 * - BuildKit is never started. Doctor only opens one connection to the managed
 *   unix socket with a short connection timeout. There is no retry loop.
 *
 * Both checks return a {@link DoctorCheck} and never throw, matching the host
 * checks they sit beside. Keeping them synchronous preserves doctor's existing
 * composition and output contract; the socket probe therefore uses a small,
 * shell-free node child process with a connection timeout rather than an
 * asynchronous socket API.
 */

/** Connection budget for the managed BuildKit socket; doctor never retries. */
export const BUILDKIT_PROBE_TIMEOUT_MS = 500;

/** First exact `major.minor.patch` token in `railpack --version` output. */
const VERSION_PATTERN = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)/;

/**
 * A synchronous reachability probe. Tests inject a recorder; production uses
 * {@link probeBuildkitSocketSync}.
 */
export type BuildkitReachabilityProbe = (socketPath: string, timeoutMs: number) => boolean;

/** Everything the build checks read. Resolved once by `runDoctor`. */
export interface BuildCheckEnvironment {
  /** Reused host runner. Doctor uses it to ask Railpack for its version. */
  runner: ProcessRunner;
  /** Environment used for `EASY_HOST_RAILPACK_BIN`. */
  env: NodeJS.ProcessEnv;
  /** `<root>/tools`, where the pinned Railpack binary is cached. */
  toolsDir: string;
  /** `<root>/buildkit`, which holds the managed socket. */
  buildkitDir: string;
  /** Base directory for a relative Railpack executable path. */
  cwd: string;
  /** Home directory for `~/` expansion in the Railpack override. */
  homeDir: string;
  /** Managed-socket reachability probe. */
  probeBuildkit: BuildkitReachabilityProbe;
  /**
   * Test seam: an explicit executable path. Production resolves
   * `EASY_HOST_RAILPACK_BIN` first, then `<root>/tools/railpack`.
   */
  railpackPath?: string;
  /** Expected pinned Railpack version. Defaults to `RAILPACK_VERSION`. */
  expectedRailpackVersion?: string;
}

/** Where the Railpack executable under test came from. */
type RailpackSource = "environment" | "managed" | "explicit";

interface RailpackCandidate {
  path: string;
  source: RailpackSource;
}

type SocketPathState = "missing" | "socket" | "other" | "unreadable";

/**
 * The ordered build checks. Order is part of the report contract: Railpack
 * before BuildKit, both ahead of disk.
 */
export function runBuildChecks(environment: BuildCheckEnvironment): DoctorCheck[] {
  return [checkRailpack(environment), checkBuildkit(environment)];
}

/**
 * Railpack presence, executable mode, and exact pinned version (`BLD-FR-05`).
 *
 * A missing binary is a failure rather than a skip: a build cannot run without
 * it, and doctor must never download it. The remediation points at the first
 * build or at the documented override instead.
 */
export function checkRailpack(environment: BuildCheckEnvironment): DoctorCheck {
  const expected = environment.expectedRailpackVersion ?? RAILPACK_VERSION;
  const candidate = resolveRailpackCandidate(environment);

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(candidate.path);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return {
        id: "railpack",
        label: "Railpack",
        status: "fail",
        detail: `Railpack ${expected} is not installed at "${candidate.path}".`,
        remediation: missingRailpackRemediation(candidate.source, expected),
      };
    }

    return {
      id: "railpack",
      label: "Railpack",
      status: "fail",
      detail: `Railpack at "${candidate.path}" could not be inspected: ${errorMessage(error)}.`,
      remediation: missingRailpackRemediation(candidate.source, expected),
    };
  }

  if (!stats.isFile()) {
    return {
      id: "railpack",
      label: "Railpack",
      status: "fail",
      detail: `Railpack path "${candidate.path}" is not a regular file.`,
      remediation: missingRailpackRemediation(candidate.source, expected),
    };
  }

  try {
    accessSync(candidate.path, constants.X_OK);
  } catch {
    return {
      id: "railpack",
      label: "Railpack",
      status: "fail",
      detail: `Railpack at "${candidate.path}" is not executable.`,
      remediation: `Make "${candidate.path}" executable (chmod +x) or ${overrideAdvice(candidate.source, expected)}`,
    };
  }

  const probe = probeRailpackVersion(environment.runner, candidate.path);
  if (!probe.ok) {
    return {
      id: "railpack",
      label: "Railpack",
      status: "fail",
      detail: `Railpack at "${candidate.path}" could not report its version: ${probe.reason}.`,
      remediation: `Reinstall the pinned Railpack ${expected} (${overrideAdvice(candidate.source, expected)}) and run easy-host doctor again.`,
    };
  }

  if (probe.version === undefined) {
    return {
      id: "railpack",
      label: "Railpack",
      status: "fail",
      detail: `Railpack at "${candidate.path}" did not report a version (found "${firstLine(probe.output)}").`,
      remediation: `Install the pinned Railpack ${expected} (${overrideAdvice(candidate.source, expected)}) and run easy-host doctor again.`,
    };
  }

  if (probe.version !== expected) {
    return {
      id: "railpack",
      label: "Railpack",
      status: "fail",
      detail: `Railpack ${probe.version} found at "${candidate.path}"; easy-host requires the pinned version ${expected}.`,
      remediation: `Install the pinned Railpack ${expected} (${overrideAdvice(candidate.source, expected)}) and run easy-host doctor again.`,
    };
  }

  return {
    id: "railpack",
    label: "Railpack",
    status: "pass",
    detail: `Railpack ${expected} is installed and executable at "${candidate.path}".`,
    remediation: null,
  };
}

/**
 * BuildKit reachability over the managed unix socket (`BLD-FR-05`).
 *
 * Exactly one connection attempt is made with {@link BUILDKIT_PROBE_TIMEOUT_MS}.
 * Doctor never starts the daemon: when the socket is absent or refuses the
 * connection, the remediation tells the operator how to start it with a build.
 */
export function checkBuildkit(environment: BuildCheckEnvironment): DoctorCheck {
  const layout = buildkitLayout(environment.buildkitDir);
  const socketState = inspectSocketPath(layout.socketPath);
  let reachable = false;
  let probeError: string | undefined;

  try {
    reachable = environment.probeBuildkit(layout.socketPath, BUILDKIT_PROBE_TIMEOUT_MS);
  } catch (error) {
    probeError = errorMessage(error);
  }

  if (reachable && probeError === undefined) {
    return {
      id: "buildkit",
      label: "BuildKit",
      status: "pass",
      detail: `BuildKit ${BUILDKIT_VERSION} is reachable at "unix://${layout.socketPath}".`,
      remediation: null,
    };
  }

  const reason =
    probeError !== undefined
      ? `the socket probe failed: ${probeError}`
      : socketState === "missing"
        ? "the managed socket does not exist"
        : socketState === "other"
          ? "the managed socket path exists but is not a unix socket"
          : socketState === "unreadable"
            ? "the managed socket path could not be inspected"
            : "the connection was refused or timed out";

  return {
    id: "buildkit",
    label: "BuildKit",
    status: "fail",
    detail: `BuildKit is not reachable at "unix://${layout.socketPath}": ${reason}.`,
    remediation: startBuildkitRemediation(),
  };
}

/**
 * A synchronous connection probe for the managed BuildKit socket.
 *
 * Doctor's composition is synchronous, so this starts a short-lived child node
 * process that connects to the unix socket with a timeout and exits immediately.
 * The command is an argument array, never a shell string (`PRD-NF-09`), and both
 * the child socket timeout and the spawn timeout are finite (`PRD-NF-05`). The
 * child only talks to a local unix socket; nothing touches the network.
 */
export function probeBuildkitSocketSync(
  socketPath: string,
  timeoutMs: number = BUILDKIT_PROBE_TIMEOUT_MS,
): boolean {
  const budget = normalizeTimeout(timeoutMs);
  const result = spawnSync(
    process.execPath,
    ["-e", SOCKET_PROBE_SCRIPT, socketPath, String(budget)],
    {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: budget + 100,
      maxBuffer: 1024,
    },
  );

  return result.error === undefined && result.status === 0 && (result.stdout ?? "").trim() === "1";
}

/**
 * Parses the first exact `major.minor.patch` token from `railpack --version`.
 * Pre-release suffixes are preserved so a pin cannot silently accept an rc.
 */
export function parseRailpackVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output)?.[1];
}

function resolveRailpackCandidate(environment: BuildCheckEnvironment): RailpackCandidate {
  if (environment.railpackPath !== undefined && environment.railpackPath.length > 0) {
    return {
      path: absolutePath(environment.railpackPath, environment),
      source: "explicit",
    };
  }

  const override = environment.env[EASY_HOST_RAILPACK_BIN];
  if (override !== undefined && override.length > 0) {
    return {
      path: absolutePath(expandHome(override, environment.homeDir), environment),
      source: "environment",
    };
  }

  return {
    path: railpackBinaryPath(environment.toolsDir),
    source: "managed",
  };
}

interface VersionProbe {
  ok: boolean;
  output: string;
  version: string | undefined;
  reason: string;
}

function probeRailpackVersion(runner: ProcessRunner, executable: string): VersionProbe {
  let result: ProcessRunResult;

  try {
    result = runner.run(executable, ["--version"], { timeoutMs: DOCTOR_COMMAND_TIMEOUT_MS });
  } catch (error) {
    return {
      ok: false,
      output: "",
      version: undefined,
      reason: errorMessage(error),
    };
  }

  const output = `${result.stdout}\n${result.stderr}`.trim();

  if (result.spawnError !== undefined) {
    return {
      ok: false,
      output,
      version: undefined,
      reason: `${executable} could not start (${result.spawnError})`,
    };
  }

  if (result.exitCode !== 0) {
    const detail = firstLine(result.stderr);
    return {
      ok: false,
      output,
      version: undefined,
      reason: `${executable} --version exited with code ${result.exitCode}${detail.length > 0 ? `: ${detail}` : ""}`,
    };
  }

  return {
    ok: true,
    output,
    version: parseRailpackVersion(result.stdout.length > 0 ? result.stdout : result.stderr),
    reason: "",
  };
}

function inspectSocketPath(target: string): SocketPathState {
  try {
    return lstatSync(target).isSocket() ? "socket" : "other";
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return "missing";
    }

    return "unreadable";
  }
}

function missingRailpackRemediation(source: RailpackSource, expected: string): string {
  switch (source) {
    case "environment":
      return `Point ${EASY_HOST_RAILPACK_BIN} at an executable Railpack ${expected}, or unset it to use the pinned download, then run easy-host doctor again.`;
    case "explicit":
      return `Set a valid railpack executable path, or ${overrideAdvice(source, expected)}`;
    case "managed":
      return `Run easy-host add <app> to download the pinned Railpack ${expected}, or set ${EASY_HOST_RAILPACK_BIN} to an executable railpack binary, then run easy-host doctor again.`;
  }
}

function overrideAdvice(source: RailpackSource, expected: string): string {
  return source === "environment"
    ? `point ${EASY_HOST_RAILPACK_BIN} at Railpack ${expected}`
    : `set ${EASY_HOST_RAILPACK_BIN} to an executable Railpack ${expected} binary or let a build install the pinned copy`;
}

function startBuildkitRemediation(): string {
  return `Start the managed BuildKit daemon with a build (easy-host add <app> or easy-host update <app>); if it is already running, check podman logs ${BUILDKIT_CONTAINER_NAME}, then run easy-host doctor again.`;
}

function absolutePath(input: string, environment: BuildCheckEnvironment): string {
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(environment.cwd, input);
}

function expandHome(input: string, homeDir: string = homedir()): string {
  if (input === "~") {
    return homeDir;
  }

  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }

  return input;
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return BUILDKIT_PROBE_TIMEOUT_MS;
  }

  return Math.trunc(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs inside a short-lived child node process. It connects once, prints `1`
 * on success or `0` on failure, and lets node exit naturally so the parent sees
 * a flushed result. The socket is always destroyed.
 */
const SOCKET_PROBE_SCRIPT = `
const net = require("node:net");
const socketPath = process.argv[1];
const timeoutMs = Number(process.argv[2]);
const socket = net.connect({ path: socketPath });
let settled = false;
function finish(reachable) {
  if (settled) {
    return;
  }
  settled = true;
  socket.destroy();
  process.stdout.write(reachable ? "1" : "0");
  process.exitCode = reachable ? 0 : 1;
}
socket.once("connect", function () {
  finish(true);
});
socket.once("error", function () {
  finish(false);
});
socket.setTimeout(timeoutMs, function () {
  finish(false);
});
`.trim();
