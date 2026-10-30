import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { PODMAN_RESTART_SERVICE } from "../platform/boot-recovery.js";
import { resolveStateRoot } from "../platform/paths.js";

/**
 * Host checks for `easy-host doctor`.
 *
 * Every check is a pure function over an injected environment: it returns one
 * {@link DoctorCheck} and never throws. The default environment uses local
 * process calls only (`podman`, `loginctl`, `git`) and the filesystem; doctor
 * must not contact the network (`PRE-NF-01`).
 */

/** The overall status of one host check. */
export type CheckStatus = "pass" | "warn" | "fail" | "skip";

/** One ordered line of the doctor report. */
export interface DoctorCheck {
  /** Stable machine-readable identifier, used by JSON consumers. */
  id: string;
  /** Human label used by the report and by later documentation. */
  label: string;
  status: CheckStatus;
  /** One-line explanation of what was found. */
  detail: string;
  /** Next command or instruction; always present for a non-pass check. */
  remediation: string | null;
}

/** A completed local process call. */
export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the executable could not be started, for example `ENOENT`. */
  spawnError?: string;
}

export interface ProcessRunOptions {
  /** Finite timeout so doctor can never block (`PRD-NF-05`). */
  timeoutMs?: number;
}

/**
 * The narrow process-runner surface doctor needs. It matches the shape a
 * shared platform runner can satisfy, and tests inject a recording
 * implementation instead of spawning real processes.
 */
export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: ProcessRunOptions): ProcessRunResult;
}

/** Free and total space for the filesystem holding a path. */
export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export type DiskSpaceReader = (target: string) => DiskSpace;

/** The parts of `/etc/os-release` doctor needs for distro-specific advice. */
export interface OsRelease {
  id: string;
  name: string;
}

/** Everything the individual checks read. Resolved once by `runDoctor`. */
export interface DoctorCheckEnvironment {
  runner: ProcessRunner;
  username: string;
  osRelease: OsRelease;
  readDiskSpace: DiskSpaceReader;
  diskPath: string;
  nodeVersion: string;
}

/** Supported rootless Podman range (`PRE-FR-02`). */
export const PODMAN_VERSION_RANGE = ">= 5.7.0, < 6.0.0";

/** Minimum rootless Podman version. */
export const PODMAN_MIN_VERSION = { major: 5, minor: 7, patch: 0 } as const;

/** First unsupported Podman major line (exclusive upper bound). */
export const PODMAN_EXCLUSIVE_MAX_MAJOR = 6;

/** Minimum git version (`PRE-FR-04`). */
export const GIT_MIN_VERSION = { major: 2, minor: 40, patch: 0 } as const;

/** Minimum supported Node.js major (`PRD` open question 1). */
export const NODE_MIN_MAJOR = 24;

/** Warn when free space drops below 5 GiB (`PRE` open question 2). */
export const DISK_WARN_BYTES = 5 * 1024 ** 3;

/** Fail when free space drops below 2 GiB. */
export const DISK_FAIL_BYTES = 2 * 1024 ** 3;

/** Finite timeout applied to every doctor process call. */
export const DOCTOR_COMMAND_TIMEOUT_MS = 1_750;

/** The healthy-host budget from `PRE-NF-01`. */
export const DOCTOR_BUDGET_MS = 2_000;

interface Version {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

interface CommandOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  spawnError: string | undefined;
  reason: string | undefined;
}

/**
 * The ordered host checks. Rotation order is part of the report contract:
 * Podman, rootless mode, lingering, git, Node.js, disk.
 */
export function runHostChecks(environment: DoctorCheckEnvironment): DoctorCheck[] {
  return [
    checkPodman(environment),
    checkPodmanRootless(environment),
    checkLinger(environment),
    checkGit(environment),
    checkNode(environment),
    checkDisk(environment),
  ];
}

/** Podman presence and version (`PRE-FR-02`). */
export function checkPodman(environment: DoctorCheckEnvironment): DoctorCheck {
  const outcome = invoke(environment, "podman", ["--version"]);

  if (!outcome.ok) {
    if (isMissing(outcome)) {
      return {
        id: "podman",
        label: "Podman",
        status: "fail",
        detail: "Podman was not found on PATH.",
        remediation: `Install Podman ${PODMAN_VERSION_RANGE} with your package manager (${podmanGuidance(environment.osRelease)}), then run easy-host doctor again.`,
      };
    }

    return {
      id: "podman",
      label: "Podman",
      status: "fail",
      detail: `Podman could not be executed: ${outcome.reason ?? "unknown error"}.`,
      remediation: `Repair the Podman installation (${podmanGuidance(environment.osRelease)}) and run easy-host doctor again.`,
    };
  }

  const version = parseVersion(outcome.stdout);
  if (version === undefined) {
    return {
      id: "podman",
      label: "Podman",
      status: "fail",
      detail: `Podman is installed but its version could not be parsed from "${firstLine(outcome.stdout)}".`,
      remediation: `Run podman --version, install Podman ${PODMAN_VERSION_RANGE}, then run easy-host doctor again.`,
    };
  }

  if (isBelow(version, PODMAN_MIN_VERSION)) {
    return {
      id: "podman",
      label: "Podman",
      status: "fail",
      detail: `Podman ${version.text} found; easy-host requires Podman ${PODMAN_VERSION_RANGE}. Upgrade starting point: ${podmanGuidance(environment.osRelease)}.`,
      remediation: `Upgrade Podman to the newest 5.8.x package (${podmanGuidance(environment.osRelease)}), then run easy-host doctor again.`,
    };
  }

  if (version.major >= PODMAN_EXCLUSIVE_MAX_MAJOR) {
    return {
      id: "podman",
      label: "Podman",
      status: "fail",
      detail: `Podman ${version.text} found; the Podman ${version.major}.x major line is unsupported (easy-host requires ${PODMAN_VERSION_RANGE}). Downgrade starting point: ${podmanGuidance(environment.osRelease)}.`,
      remediation: `Downgrade Podman to the newest 5.8.x package (${podmanGuidance(environment.osRelease)}), then run easy-host doctor again.`,
    };
  }

  return {
    id: "podman",
    label: "Podman",
    status: "pass",
    detail: `Podman ${version.text} is installed (supported: ${PODMAN_VERSION_RANGE}).`,
    remediation: null,
  };
}

/** Rootless mode (`PRE-FR-02`). */
export function checkPodmanRootless(environment: DoctorCheckEnvironment): DoctorCheck {
  const outcome = invoke(environment, "podman", [
    "info",
    "--format",
    "{{.Host.Security.Rootless}}",
  ]);

  if (!outcome.ok) {
    if (isMissing(outcome)) {
      return {
        id: "podman-rootless",
        label: "Rootless",
        status: "skip",
        detail: "Skipped because Podman was not found on PATH.",
        remediation: `Install Podman ${PODMAN_VERSION_RANGE}, then run easy-host doctor again.`,
      };
    }

    return {
      id: "podman-rootless",
      label: "Rootless",
      status: "fail",
      detail: `Rootless mode could not be confirmed: ${outcome.reason ?? "unknown error"}.`,
      remediation:
        "Run `podman info --format '{{.Host.Security.Rootless}}'` as a non-root user and confirm it prints true.",
    };
  }

  const value = outcome.stdout.trim().toLowerCase();
  if (value === "true") {
    return {
      id: "podman-rootless",
      label: "Rootless",
      status: "pass",
      detail: "Podman is running rootless.",
      remediation: null,
    };
  }

  if (value === "false") {
    return {
      id: "podman-rootless",
      label: "Rootless",
      status: "fail",
      detail: "Podman is not running rootless (Rootless=false); rootful Podman is unsupported.",
      remediation:
        "Run easy-host as a normal user without sudo so Podman selects rootless mode, then run easy-host doctor again.",
    };
  }

  return {
    id: "podman-rootless",
    label: "Rootless",
    status: "fail",
    detail: `Podman did not report a rootless value (found "${firstLine(outcome.stdout)}").`,
    remediation:
      "Run `podman info --format '{{.Host.Security.Rootless}}'` as a non-root user and confirm it prints true.",
  };
}

/**
 * A docker-compatible image loader.
 *
 * Railpack finishes a build by exporting the image through `docker load`; the
 * managed BuildKit daemon only produces the tarball. Podman does not provide a
 * `docker` command unless the `podman-docker` shim is installed, and `add`
 * cannot install packages, so a host without a loader burns a full build
 * before failing at the export step. Checking it here fails in milliseconds.
 */
export function checkDockerLoader(environment: DoctorCheckEnvironment): DoctorCheck {
  const outcome = invoke(environment, "docker", ["--version"]);

  if (outcome.ok) {
    const found =
      firstLine(outcome.stdout) ?? firstLine(outcome.stderr) ?? "docker-compatible loader";
    return {
      id: "docker-loader",
      label: "Image loader",
      status: "pass",
      detail: `A docker-compatible loader is on PATH (${found}).`,
      remediation: null,
    };
  }

  if (isMissing(outcome)) {
    return {
      id: "docker-loader",
      label: "Image loader",
      status: "fail",
      detail:
        "No docker-compatible loader was found on PATH; Railpack cannot load the image it builds into Podman.",
      remediation:
        'Install the Podman docker shim (Ubuntu/Debian: sudo apt install podman-docker), then run "easy-host doctor" again.',
    };
  }

  const found =
    firstLine(outcome.stderr) ?? firstLine(outcome.stdout) ?? `exit ${outcome.exitCode}`;
  return {
    id: "docker-loader",
    label: "Image loader",
    status: "fail",
    detail: `docker --version did not succeed (${found}).`,
    remediation:
      'Install or repair the Podman docker shim (Ubuntu/Debian: sudo apt install podman-docker), then run "easy-host doctor" again.',
  };
}

/** systemd user lingering (`PRE-FR-03`). */
export function checkLinger(environment: DoctorCheckEnvironment): DoctorCheck {
  const outcome = invoke(environment, "loginctl", [
    "show-user",
    environment.username,
    "-p",
    "Linger",
  ]);

  if (!outcome.ok) {
    if (isMissing(outcome)) {
      return {
        id: "linger",
        label: "Lingering",
        status: "fail",
        detail: `loginctl was not found on PATH; lingering for ${environment.username} could not be verified.`,
        remediation: `Enable systemd user lingering with: sudo loginctl enable-linger ${environment.username}`,
      };
    }

    return {
      id: "linger",
      label: "Lingering",
      status: "fail",
      detail: `Lingering for ${environment.username} could not be read: ${outcome.reason ?? "unknown error"}.`,
      remediation: `Enable lingering with: sudo loginctl enable-linger ${environment.username}`,
    };
  }

  const linger = /^Linger=(yes|no)$/im.exec(outcome.stdout)?.[1]?.toLowerCase();

  if (linger === "yes") {
    return {
      id: "linger",
      label: "Lingering",
      status: "pass",
      detail: `User lingering is enabled for ${environment.username}.`,
      remediation: null,
    };
  }

  if (linger === "no") {
    return {
      id: "linger",
      label: "Lingering",
      status: "fail",
      detail: `User lingering is disabled for ${environment.username}; --restart=always containers will not return after a reboot.`,
      remediation: `Enable lingering with: sudo loginctl enable-linger ${environment.username}`,
    };
  }

  return {
    id: "linger",
    label: "Lingering",
    status: "fail",
    detail: `Lingering for ${environment.username} could not be determined (found "${firstLine(outcome.stdout)}").`,
    remediation: `Enable lingering with: sudo loginctl enable-linger ${environment.username}`,
  };
}

/**
 * Boot-time replay of the container restart policy (`RBK-FR-02`).
 *
 * `--restart=always` is enforced by the podman process that is already alive;
 * it is not a boot hook. For a rootless user Podman ships
 * `podman-restart.service` but leaves it disabled, so a container that was
 * healthy before a reboot stays down. `add` enables the unit; doctor reports the
 * state so an unrepairable host stays visible.
 */
export function checkBootRestart(environment: DoctorCheckEnvironment): DoctorCheck {
  const outcome = invoke(environment, "systemctl", [
    "--user",
    "is-enabled",
    PODMAN_RESTART_SERVICE,
  ]);
  const enabled = outcome.ok && /^enabled\b/im.test(outcome.stdout);

  if (enabled) {
    return {
      id: "boot-restart",
      label: "Reboot recovery",
      status: "pass",
      detail: `${PODMAN_RESTART_SERVICE} is enabled for ${environment.username}; --restart=always containers return after a reboot.`,
      remediation: null,
    };
  }

  if (!outcome.ok && isMissing(outcome)) {
    return {
      id: "boot-restart",
      label: "Reboot recovery",
      status: "skip",
      detail:
        "systemctl was not found on PATH; whether containers return after a reboot could not be checked.",
      remediation: `Enable the Podman restart unit once systemd is present: systemctl --user enable --now ${PODMAN_RESTART_SERVICE}`,
    };
  }

  const found =
    firstLine(outcome.stdout) ??
    firstLine(outcome.stderr) ??
    `exit ${outcome.exitCode ?? "unknown"}`;

  return {
    id: "boot-restart",
    label: "Reboot recovery",
    status: "fail",
    detail: `${PODMAN_RESTART_SERVICE} is not enabled for ${environment.username} (${found}); --restart=always containers will not return after a reboot.`,
    remediation: `Run "easy-host add" again, or enable the unit directly: systemctl --user enable --now ${PODMAN_RESTART_SERVICE}`,
  };
}

/** Git presence and minimum version (`PRE-FR-04`). */ export function checkGit(
  environment: DoctorCheckEnvironment,
): DoctorCheck {
  const outcome = invoke(environment, "git", ["--version"]);

  if (!outcome.ok) {
    if (isMissing(outcome)) {
      return {
        id: "git",
        label: "git",
        status: "fail",
        detail: "git was not found on PATH.",
        remediation:
          "Install git 2.40 or newer with your package manager, then run easy-host doctor again.",
      };
    }

    return {
      id: "git",
      label: "git",
      status: "fail",
      detail: `git could not be executed: ${outcome.reason ?? "unknown error"}.`,
      remediation:
        "Install git 2.40 or newer with your package manager, then run easy-host doctor again.",
    };
  }

  const version = parseVersion(outcome.stdout);
  if (version === undefined) {
    return {
      id: "git",
      label: "git",
      status: "fail",
      detail: `git is installed but its version could not be parsed from "${firstLine(outcome.stdout)}".`,
      remediation:
        "Install git 2.40 or newer with your package manager, then run easy-host doctor again.",
    };
  }

  if (isBelow(version, GIT_MIN_VERSION)) {
    return {
      id: "git",
      label: "git",
      status: "fail",
      detail: `git ${version.text} found; git 2.40 or newer is required.`,
      remediation:
        "Install git 2.40 or newer with your package manager, then run easy-host doctor again.",
    };
  }

  return {
    id: "git",
    label: "git",
    status: "pass",
    detail: `git ${version.text} is installed (2.40 or newer required).`,
    remediation: null,
  };
}

/** Node.js presence and minimum major (`PRD` host prerequisites). */
export function checkNode(environment: DoctorCheckEnvironment): DoctorCheck {
  const version = parseVersion(environment.nodeVersion);

  if (version === undefined) {
    return {
      id: "node",
      label: "Node.js",
      status: "fail",
      detail: `Node.js version "${environment.nodeVersion}" could not be parsed.`,
      remediation: "Install Node.js 24 or newer, then run easy-host doctor again.",
    };
  }

  if (version.major < NODE_MIN_MAJOR) {
    return {
      id: "node",
      label: "Node.js",
      status: "fail",
      detail: `Node.js ${version.text} found; Node.js 24 or newer is required.`,
      remediation: "Install Node.js 24 or newer, then run easy-host doctor again.",
    };
  }

  return {
    id: "node",
    label: "Node.js",
    status: "pass",
    detail: `Node.js ${version.text} is installed (24 or newer required).`,
    remediation: null,
  };
}

/**
 * Free disk space for the state root (`PRE-FR-07`, `OBS-FR-04` thresholds).
 * Narrowed to the two facts it reads so the disk-usage group can reuse it with
 * a single measurement.
 */
export function checkDisk(
  environment: Pick<DoctorCheckEnvironment, "readDiskSpace" | "diskPath">,
): DoctorCheck {
  let space: DiskSpace;

  try {
    space = environment.readDiskSpace(environment.diskPath);
  } catch (error) {
    return {
      id: "disk",
      label: "Disk",
      status: "skip",
      detail: `Free disk space on "${environment.diskPath}" could not be measured: ${errorMessage(error)}.`,
      remediation: `Verify that "${environment.diskPath}" exists and is readable, then run easy-host doctor again.`,
    };
  }

  if (
    !Number.isFinite(space.freeBytes) ||
    !Number.isFinite(space.totalBytes) ||
    space.freeBytes < 0
  ) {
    return {
      id: "disk",
      label: "Disk",
      status: "skip",
      detail: `Free disk space on "${environment.diskPath}" returned an unusable value.`,
      remediation: `Verify that "${environment.diskPath}" exists and is readable, then run easy-host doctor again.`,
    };
  }

  const free = formatGib(space.freeBytes);

  if (space.freeBytes < DISK_FAIL_BYTES) {
    return {
      id: "disk",
      label: "Disk",
      status: "fail",
      detail: `${free} free on "${environment.diskPath}"; doctor fails below 2 GiB and warns below 5 GiB.`,
      remediation: `Free at least 2 GiB on "${environment.diskPath}" (remove unused images and build cache), then run easy-host doctor again.`,
    };
  }

  if (space.freeBytes < DISK_WARN_BYTES) {
    return {
      id: "disk",
      label: "Disk",
      status: "warn",
      detail: `${free} free on "${environment.diskPath}"; doctor warns below 5 GiB and fails below 2 GiB.`,
      remediation: `Free disk space on "${environment.diskPath}" and aim for at least 5 GiB before adding apps.`,
    };
  }

  return {
    id: "disk",
    label: "Disk",
    status: "pass",
    detail: `${free} free on "${environment.diskPath}" (warn below 5 GiB, fail below 2 GiB).`,
    remediation: null,
  };
}

/**
 * Builds the default runner with a synchronous, shell-free process call. Commands
 * and arguments always come from fixed literals, never an assembled shell
 * string (`PRD-NF-09`). A shared platform runner can replace this by injection.
 */
export function createProcessRunner(): ProcessRunner {
  return {
    run(command, args, options = {}) {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs ?? DOCTOR_COMMAND_TIMEOUT_MS,
      });

      const spawnError = result.error;
      const errorCode =
        spawnError === undefined ? undefined : (spawnError as NodeJS.ErrnoException).code;
      const startupFailed = errorCode === "ENOENT";

      return {
        exitCode: result.status ?? (startupFailed ? 127 : 1),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ...(spawnError === undefined ? {} : { spawnError: errorCode ?? spawnError.message }),
      };
    },
  };
}

/** Reads free and total bytes with `statfsSync`; no allocation or mutation. */
export function readDiskSpace(target: string): DiskSpace {
  const stats = statfsSync(target);

  return {
    freeBytes: Number(stats.bavail) * Number(stats.bsize),
    totalBytes: Number(stats.blocks) * Number(stats.bsize),
  };
}

/** Reads distro identity from `/etc/os-release`, falling back to the platform. */
export function readOsRelease(): OsRelease {
  try {
    const text = readFileSync("/etc/os-release", "utf8");
    const values = parseOsRelease(text);

    return {
      id: values.ID ?? process.platform,
      name: values.PRETTY_NAME ?? values.NAME ?? values.ID ?? process.platform,
    };
  } catch {
    return { id: process.platform, name: process.platform };
  }
}

/** The state root, narrowed to the nearest existing directory. */
export function defaultDiskPath(env: NodeJS.ProcessEnv = process.env): string {
  let current = resolveStateRoot({ env });

  for (;;) {
    if (existsSync(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }

    current = parent;
  }
}

/** The owning user for the linger check. */
export function currentUsername(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnvironment = env.USER ?? env.LOGNAME;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
    return fromEnvironment;
  }

  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/**
 * Parses the first dotted version in a command's output. Accepts
 * `podman version 5.7.0`, `git version 2.39.2 (Apple Git-143)`, and `v24.0.0`.
 */
export function parseVersion(output: string): Version | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (match === null) {
    return undefined;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);

  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return undefined;
  }

  return {
    major,
    minor,
    patch,
    text: match[3] === undefined ? `${major}.${minor}` : `${major}.${minor}.${patch}`,
  };
}

/** Distro-specific starting point for installing or changing Podman. */
export function podmanGuidance(osRelease: OsRelease): string {
  const id = osRelease.id.toLowerCase();
  const name = osRelease.name.length > 0 ? osRelease.name : id;

  switch (id) {
    case "ubuntu":
      return "install the newest Podman 5.8.x package from Ubuntu 25.04+ or the upstream Podman PPA";
    case "debian":
      return "install the newest Podman 5.8.x package from Debian 13 (trixie) or newer";
    case "fedora":
      return "install Podman 5.8.x from the Fedora 42+ repositories (sudo dnf install podman)";
    case "rhel":
    case "centos":
    case "rocky":
    case "almalinux":
      return `install Podman 5.8.x from the EPEL or ${name} repositories for your release`;
    case "arch":
    case "manjaro":
      return "install the current Podman package (sudo pacman -S podman) and confirm it stays below 6.0.0";
    case "opensuse":
    case "opensuse-leap":
    case "opensuse-tumbleweed":
    case "sles":
      return "install Podman 5.8.x from the openSUSE Tumbleweed or SLES 16 repositories";
    default:
      return `install Podman 5.8.x from ${name}'s package manager`;
  }
}

function invoke(
  environment: DoctorCheckEnvironment,
  command: string,
  args: readonly string[],
): CommandOutcome {
  try {
    const result = environment.runner.run(command, args, {
      timeoutMs: DOCTOR_COMMAND_TIMEOUT_MS,
    });
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();

    if (result.spawnError !== undefined) {
      return {
        ok: false,
        stdout,
        stderr,
        exitCode: result.exitCode,
        spawnError: result.spawnError,
        reason: `${command} could not start (${result.spawnError})`,
      };
    }

    if (result.exitCode !== 0) {
      const detail = stderr.length > 0 ? `: ${firstLine(stderr)}` : "";
      return {
        ok: false,
        stdout,
        stderr,
        exitCode: result.exitCode,
        spawnError: undefined,
        reason: `${command} exited with code ${result.exitCode}${detail}`,
      };
    }

    return {
      ok: true,
      stdout,
      stderr,
      exitCode: result.exitCode,
      spawnError: undefined,
      reason: undefined,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: undefined,
      spawnError: undefined,
      reason: `${command} could not start: ${errorMessage(error)}`,
    };
  }
}

function isMissing(outcome: CommandOutcome): boolean {
  return outcome.spawnError === "ENOENT" || outcome.exitCode === 127;
}

function isBelow(
  version: Version,
  minimum: { readonly major: number; readonly minor: number; readonly patch: number },
): boolean {
  if (version.major !== minimum.major) {
    return version.major < minimum.major;
  }

  if (version.minor !== minimum.minor) {
    return version.minor < minimum.minor;
  }

  return version.patch < minimum.patch;
}

function parseOsRelease(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator);
    const raw = trimmed.slice(separator + 1);
    values[key] = stripQuotes(raw);
  }

  return values;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0];
    if (quote !== undefined && value.endsWith(quote)) {
      return value.slice(1, -1);
    }
  }

  return value;
}

function formatGib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
