/**
 * Workspace builds through the pinned Railpack binary (`BLD-FR-03`, `BLD-FR-04`).
 *
 * One call validates the app name and workspace, derives the immutable
 * `localhost/easy-host-<app>:<UTC yyyymmddThhmmssZ>` tag, and runs:
 *
 * ```text
 * BUILDKIT_HOST=unix://<managed socket> railpack build <workspace> \
 *   --name localhost/easy-host-<app>:<UTC stamp> --progress plain
 * ```
 *
 * Railpack's stdout and stderr are merged in arrival order and forwarded to the
 * caller's stderr sink one line at a time. Nothing is buffered until the process
 * exits (`BLD-NF-01`): each complete line is written as soon as it is produced,
 * and a line that grows past {@link BUILD_MAX_LINE_LENGTH} is flushed in bounded
 * pieces so a runaway progress bar cannot exhaust memory.
 *
 * Failures are classified so the operator fixes the right thing:
 *
 * - `unsupported-source` (exit 3): Railpack found no provider.
 * - `build-failure` (exit 3): a provider ran and its build command failed.
 * - `infrastructure-failure` (exit 2): buildkitd is unreachable, the socket
 *   timed out, an image pull or registry request failed, the process was
 *   killed, or the pinned Railpack binary could not be started.
 *
 * The executable is started with an argument array and an explicit environment
 * (`PRD-SP-04`); no shell string is assembled and `BUILDKIT_HOST` is exported to
 * the child only, never to the parent shell. The workspace is never required to
 * contain a Dockerfile: provider detection is Railpack's job.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import {
  BuildError,
  InternalError,
  PrerequisiteError,
  redactText,
  UsageError,
} from "../cli/errors.js";
import { validateAppName } from "../config/name.js";
import { acquireLock } from "./lock.js";

/** Prefix of every image this tool builds. */
export const BUILD_IMAGE_PREFIX = "localhost/easy-host-";

/** The UTC timestamp part of a build tag (`yyyymmddThhmmssZ`). */
export const BUILD_TIMESTAMP_PATTERN = /^\d{8}T\d{6}Z$/;

/** Default budget for one build; a cold build was ~259s in the Phase 0 spike. */
export const BUILD_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Longest unterminated line held in memory before it is flushed as a chunk. */
export const BUILD_MAX_LINE_LENGTH = 64 * 1024;

/** Number of trailing output lines kept for failure diagnostics. */
export const BUILD_OUTPUT_TAIL_LINES = 20;

/** Maximum characters of trailing output attached to a failure. */
export const BUILD_OUTPUT_TAIL_MAX_CHARS = 8_000;

/** Host-wide build lock file name under the state root. */
export const BUILD_LOCK_FILENAME = "build.lock";

/** Which half of the child process produced a chunk. */
export type BuildOutputStream = "stdout" | "stderr";

/** One chunk read from the child, in the order the process produced it. */
export interface BuildOutputChunk {
  readonly stream: BuildOutputStream;
  readonly text: string;
}

/** How the child process ended. */
export interface BuildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the executable could not be started, for example `ENOENT`. */
  readonly spawnError?: string;
}

/** A started build process, narrowed so tests can inject a fake. */
export interface BuildProcess {
  /** Merged stdout/stderr chunks in arrival order. */
  readonly output: AsyncIterable<BuildOutputChunk>;
  /** Resolves once the process has exited or failed to start. */
  readonly exited: Promise<BuildExit>;
  /** Best-effort termination, used by the build timeout. */
  kill(signal?: NodeJS.Signals): void;
}

/** Inputs the build runner needs. The platform runner can implement this seam. */
export interface BuildRunnerOptions {
  /** Working directory; the resolved workspace. */
  readonly cwd: string;
  /** Complete child environment, including `BUILDKIT_HOST`. */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Starts a streaming child process. It is structurally similar to the shared
 * platform runner, but the build layer needs the output as an async iterable so
 * lines can be forwarded before the process exits.
 */
export interface BuildRunner {
  run(command: string, args: readonly string[], options: BuildRunnerOptions): BuildProcess;
}

/** Destination for forwarded build output. Defaults to `process.stderr`. */
export interface BuildOutputSink {
  write(chunk: string): unknown;
}

/** Inputs for {@link buildWorkspace}. */
export interface BuildWorkspaceOptions {
  /** App name; validated against the allowlist before it enters the tag. */
  readonly app: string;
  /** Directory used as the Railpack build context. */
  readonly workspace: string;
  /** Absolute path of the verified Railpack binary from `railpack.ts`. */
  readonly railpackBinaryPath: string;
  /** `BuildkitDaemon.buildkitHost`, for example `unix:///.../buildkitd.sock`. */
  readonly buildkitHost: string;
  /** Build output destination. Defaults to `process.stderr`. */
  readonly stderr?: BuildOutputSink;
  /** Base environment. Defaults to `process.env`; `BUILDKIT_HOST` is overridden. */
  readonly env?: NodeJS.ProcessEnv;
  /** Clock used for the tag. Defaults to `new Date()`; injected in tests. */
  readonly now?: () => Date;
  /** Process runner. Defaults to a shell-free `spawn` implementation. */
  readonly runner?: BuildRunner;
  /** Build budget. Defaults to {@link BUILD_DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * State root used for the host-wide build lock. When provided, a second build
   * fails with exit code 6 instead of running concurrently (`v1` contract).
   */
  readonly stateRoot?: string;
  /** Line redaction. Defaults to the shared URL-credential and ANSI scrubber. */
  readonly redact?: (line: string) => string;
}

/** A successful build. {@link image} is the complete immutable reference. */
export interface BuildResult {
  readonly app: string;
  readonly image: string;
  readonly timestamp: string;
  readonly workspace: string;
  readonly durationMs: number;
  readonly exitCode: 0;
}

/** The three documented failure classes. */
export type BuildFailureKind = "unsupported-source" | "build-failure" | "infrastructure-failure";

/** Railpack found no provider for the workspace. Exit 3. */
export class UnsupportedSourceError extends BuildError {
  readonly kind = "unsupported-source" as const;
}

/** A provider ran and its build step failed. Exit 3. */
export class ProviderBuildError extends BuildError {
  readonly kind = "build-failure" as const;
}

/** BuildKit, the socket, the registry, or the build process failed. Exit 2. */
export class BuildInfrastructureError extends PrerequisiteError {
  readonly kind = "infrastructure-failure" as const;
}

/** Fine-grained infrastructure reasons, exposed in error details and messages. */
export type BuildInfrastructureReason =
  | "buildkit-unreachable"
  | "registry-pull-failed"
  | "network-unreachable"
  | "docker-loader-unavailable"
  | "build-timeout"
  | "railpack-unavailable"
  | "railpack-terminated"
  | "railpack-exited-abnormally"
  | "output-stream-failed";

interface BuildSignals {
  unsupportedSource: boolean;
  buildkitUnreachable: boolean;
  registryPullFailed: boolean;
  networkUnreachable: boolean;
}

/** Absolute path of the host-wide build lock for a state root. */
export function buildLockPath(stateRoot: string): string {
  if (typeof stateRoot !== "string" || stateRoot.trim().length === 0) {
    throw new UsageError("a state root is required to locate the build lock", {
      code: "INVALID_STATE_ROOT",
      remediation:
        "Resolve the state root with src/platform/paths.ts before wiring the build lock.",
    });
  }

  return path.join(path.resolve(stateRoot), BUILD_LOCK_FILENAME);
}

/**
 * Formats a date as the tag timestamp in UTC: `20261030T021605Z`.
 * An invalid clock value is a programming error, not operator input.
 */
export function formatBuildTimestamp(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new InternalError("could not derive a build timestamp from an invalid clock value", {
      code: "BUILD_TIMESTAMP_INVALID",
    });
  }

  const iso = date.toISOString();
  const timestamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(
    11,
    13,
  )}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;

  if (!BUILD_TIMESTAMP_PATTERN.test(timestamp)) {
    throw new InternalError("could not derive a build timestamp in yyyymmddThhmmssZ form", {
      code: "BUILD_TIMESTAMP_INVALID",
      details: { timestamp },
    });
  }

  return timestamp;
}

/**
 * Builds the immutable image tag for an app. The name is validated first so no
 * unvalidated value can reach a tag or a child argument (`PRD-SP-05`).
 */
export function buildImageTag(app: string, date: Date): string {
  return imageTagFor(validateAppName(app), formatBuildTimestamp(date));
}

function imageTagFor(app: string, timestamp: string): string {
  return `${BUILD_IMAGE_PREFIX}${app}:${timestamp}`;
}

/** The exact Railpack argument array. No shell interpolation is involved. */
export function railpackBuildArguments(options: {
  readonly workspace: string;
  readonly tag: string;
}): string[] {
  return ["build", options.workspace, "--name", options.tag, "--progress", "plain"];
}

/**
 * Builds one workspace into a tagged image.
 *
 * Every complete output line is written to {@link BuildWorkspaceOptions.stderr}
 * as it arrives. A provider failure throws {@link ProviderBuildError}, a
 * missing provider throws {@link UnsupportedSourceError}, and a host problem
 * throws {@link BuildInfrastructureError}; each carries its documented exit
 * code and a distinct remediation.
 */
export async function buildWorkspace(options: BuildWorkspaceOptions): Promise<BuildResult> {
  const app = validateAppName(options.app);
  const workspace = resolveWorkspace(options.workspace);
  const railpackBinaryPath = resolveRailpackPath(options.railpackBinaryPath);
  const buildkitHost = normalizeBuildkitHost(options.buildkitHost);
  const now = options.now ?? defaultNow;
  const timestamp = formatBuildTimestamp(now());
  const image = imageTagFor(app, timestamp);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const sink = options.stderr ?? process.stderr;
  const redact = options.redact ?? defaultRedact;
  const runner = options.runner ?? createDefaultBuildRunner();

  const lock =
    options.stateRoot === undefined
      ? undefined
      : acquireLock(buildLockPath(options.stateRoot), { operation: "build", app });

  const startedAt = Date.now();
  const tail = new OutputTail(BUILD_OUTPUT_TAIL_LINES, BUILD_OUTPUT_TAIL_MAX_CHARS);
  const signals: BuildSignals = {
    unsupportedSource: false,
    buildkitUnreachable: false,
    registryPullFailed: false,
    networkUnreachable: false,
  };

  const emit = (line: string): void => {
    const safe = redact(line);
    tail.push(safe);
    detectSignals(safe, signals);
    try {
      sink.write(`${safe}\n`);
    } catch {
      // A closed stderr must not abort an otherwise healthy build.
    }
  };

  const stdout = new LineSplitter(BUILD_MAX_LINE_LENGTH, emit);
  const stderr = new LineSplitter(BUILD_MAX_LINE_LENGTH, emit);

  try {
    const environment: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      BUILDKIT_HOST: buildkitHost,
    };

    let handle: BuildProcess;
    try {
      handle = runner.run(railpackBinaryPath, railpackBuildArguments({ workspace, tag: image }), {
        cwd: workspace,
        env: environment,
      });
    } catch (error) {
      throw infrastructureError({
        app,
        image,
        workspace,
        buildkitHost,
        reason: "railpack-unavailable",
        summary: `could not start the pinned Railpack binary "${railpackBinaryPath}": ${messageOf(error)}`,
        output: "",
        remediation: remediationFor("railpack-unavailable", buildkitHost),
      });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      handle.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    let exit: BuildExit;
    try {
      for await (const chunk of handle.output) {
        const splitter = chunk.stream === "stderr" ? stderr : stdout;
        splitter.push(chunk.text);
      }
      stdout.flush();
      stderr.flush();
      exit = await handle.exited;
    } catch (error) {
      handle.kill("SIGKILL");
      throw infrastructureError({
        app,
        image,
        workspace,
        buildkitHost,
        reason: "output-stream-failed",
        summary: `could not read Railpack output for app "${app}": ${messageOf(error)}`,
        output: tail.text(),
        remediation: remediationFor("output-stream-failed", buildkitHost),
      });
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - startedAt;
    const output = tail.text();

    if (timedOut) {
      const reason = exportingThroughLoader(output) ? "docker-loader-unavailable" : "build-timeout";
      throw infrastructureError({
        app,
        image,
        workspace,
        buildkitHost,
        reason,
        summary:
          reason === "docker-loader-unavailable"
            ? `Railpack reached the image export step for app "${app}" but no docker-compatible loader finished the build within ${secondsOf(timeoutMs)}s`
            : `Railpack did not finish the build for app "${app}" within ${secondsOf(timeoutMs)}s`,
        output,
        remediation: remediationFor(reason, buildkitHost),
      });
    }

    if (exit.spawnError !== undefined) {
      throw infrastructureError({
        app,
        image,
        workspace,
        buildkitHost,
        reason: "railpack-unavailable",
        summary: `could not start the pinned Railpack binary "${railpackBinaryPath}": ${exit.spawnError}`,
        output,
        remediation: remediationFor("railpack-unavailable", buildkitHost),
      });
    }

    if (exit.code === 0) {
      return {
        app,
        image,
        timestamp,
        workspace,
        durationMs,
        exitCode: 0,
      };
    }

    if (signals.unsupportedSource) {
      throw unsupportedSourceError(app, workspace, image, exit, output);
    }

    const streamReason = infrastructureReasonOf(signals);
    if (streamReason !== undefined) {
      throw infrastructureError({
        app,
        image,
        workspace,
        buildkitHost,
        reason: streamReason,
        summary: `the build infrastructure failed for app "${app}" (${streamReason})`,
        output,
        exitCode: exit.code,
        remediation: remediationFor(streamReason, buildkitHost),
      });
    }

    if (exit.code === null && exit.signal !== null) {
      throw infrastructureError({
        app,
        image,
        workspace,
        buildkitHost,
        reason: "railpack-terminated",
        summary: `Railpack was terminated by signal ${exit.signal} while building app "${app}"`,
        output,
        exitCode: exit.code,
        remediation: remediationFor("railpack-terminated", buildkitHost),
      });
    }

    if (exit.code === null) {
      throw infrastructureError({
        app,
        image,
        workspace,
        buildkitHost,
        reason: "railpack-exited-abnormally",
        summary: `Railpack ended without an exit code while building app "${app}"`,
        output,
        exitCode: exit.code,
        remediation: remediationFor("railpack-exited-abnormally", buildkitHost),
      });
    }

    throw new ProviderBuildError(
      `Railpack detected a provider but the build failed for app "${app}"`,
      {
        code: "BUILD_PROVIDER_FAILED",
        details: {
          app,
          image,
          workspace,
          reason: "provider-build-failed",
          railpackExitCode: exit.code,
          output,
        },
        remediation: `Inspect the streamed Railpack output above and fix the failing step in "${workspace}" (usually the build command or the lockfile), then retry.`,
      },
    );
  } finally {
    lock?.release();
  }
}

/**
 * Classifies output signals. Only Railpack/BuildKit-specific wording is used,
 * so an application log line such as `connection refused` remains a provider
 * build failure rather than being promoted to infrastructure.
 */
function detectSignals(line: string, signals: BuildSignals): void {
  if (UNSUPPORTED_SOURCE_PATTERNS.some((pattern) => pattern.test(line))) {
    signals.unsupportedSource = true;
  }

  if (BUILDKIT_UNREACHABLE_PATTERNS.some((pattern) => pattern.test(line))) {
    signals.buildkitUnreachable = true;
  }

  if (REGISTRY_PULL_PATTERNS.some((pattern) => pattern.test(line))) {
    signals.registryPullFailed = true;
  }

  if (NETWORK_PATTERNS.some((pattern) => pattern.test(line))) {
    signals.networkUnreachable = true;
  }
}

const UNSUPPORTED_SOURCE_PATTERNS: readonly RegExp[] = [
  /could not determine how to build/i,
  /no (supported )?provider/i,
  /no supported (language|stack)/i,
  /unable to detect (a )?(language|provider|framework)/i,
];

const BUILDKIT_UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /failed to get buildkit information/i,
  /\$buildkit_host/i,
  /buildkit daemon/i,
  /failed to (connect|dial) to (the )?buildkit/i,
  /cannot connect to (the )?buildkit/i,
  /failed to create (a )?buildkit client/i,
  /buildkitd\.sock.*(no such file|refused)/i,
];

const REGISTRY_PULL_PATTERNS: readonly RegExp[] = [
  /failed to resolve source metadata/i,
  /failed to authorize/i,
  /pull access denied/i,
  /manifest unknown/i,
  /toomanyrequests/i,
  /pull rate limit/i,
  /repository does not exist/i,
  /failed to pull (image|access)/i,
  /unauthorized: authentication required/i,
  /denied: requested access to the resource is denied/i,
];

const NETWORK_PATTERNS: readonly RegExp[] = [
  /\bdial tcp\b/i,
  /i\/o timeout/i,
  /tls handshake timeout/i,
  /context deadline exceeded/i,
  /network is unreachable/i,
  /temporary failure in name resolution/i,
];

function infrastructureReasonOf(signals: BuildSignals): BuildInfrastructureReason | undefined {
  if (signals.buildkitUnreachable) {
    return "buildkit-unreachable";
  }

  if (signals.registryPullFailed) {
    return "registry-pull-failed";
  }

  if (signals.networkUnreachable) {
    return "network-unreachable";
  }

  return undefined;
}

function exportingThroughLoader(output: string): boolean {
  return /exporting to docker image format|sending tarball/i.test(output);
}

function unsupportedSourceError(
  app: string,
  workspace: string,
  image: string,
  exit: BuildExit,
  output: string,
): UnsupportedSourceError {
  return new UnsupportedSourceError(
    `Railpack could not detect a supported stack in "${workspace}" for app "${app}"`,
    {
      code: "BUILD_UNSUPPORTED_SOURCE",
      details: {
        app,
        image,
        workspace,
        reason: "no-provider-detected",
        railpackExitCode: exit.code,
        output,
      },
      remediation: `Add the manifest for a supported stack (Node, Python, Go, Rust, Java, Ruby, PHP, Deno, .NET, Elixir, or a static site) at the repository root. No Dockerfile is required; check the repo layout if the manifest lives in a subdirectory.`,
    },
  );
}

interface InfrastructureErrorInput {
  app: string;
  image: string;
  workspace: string;
  buildkitHost: string;
  reason: BuildInfrastructureReason;
  summary: string;
  output: string;
  exitCode?: number | null;
  remediation: string;
}

function infrastructureError(input: InfrastructureErrorInput): BuildInfrastructureError {
  return new BuildInfrastructureError(input.summary, {
    code: "BUILD_INFRASTRUCTURE_FAILED",
    details: {
      app: input.app,
      image: input.image,
      workspace: input.workspace,
      buildkitHost: input.buildkitHost,
      reason: input.reason,
      ...(input.exitCode === undefined ? {} : { railpackExitCode: input.exitCode }),
      output: input.output,
    },
    remediation: input.remediation,
  });
}

function remediationFor(reason: BuildInfrastructureReason, buildkitHost: string): string {
  switch (reason) {
    case "buildkit-unreachable":
      return `Run "easy-host doctor", then confirm the managed buildkitd is running with "podman ps --filter label=io.easy-host.role=buildkit". The build used BUILDKIT_HOST=${buildkitHost}.`;
    case "registry-pull-failed":
      return `Check network access to the image registry and Docker Hub rate limits, then run "easy-host doctor" and retry.`;
    case "network-unreachable":
      return `Check outbound network access to the image registry and to Railpack's builder images, then run "easy-host doctor" and retry.`;
    case "docker-loader-unavailable":
      return `Railpack exports through a docker-compatible loader. Install podman-docker (or put a docker-compatible loader on PATH), then run "easy-host doctor" and retry.`;
    case "build-timeout":
      return `Run "easy-host doctor" and check that buildkitd and registry access are healthy. If the streamed output shows active progress, retry with a larger timeout.`;
    case "railpack-unavailable":
      return `Run "easy-host doctor" to verify or reinstall the pinned Railpack binary, or unset EASY_HOST_RAILPACK_BIN to use the managed download.`;
    case "railpack-terminated":
      return `Retry the build. If it is terminated again, run "easy-host doctor" and check host memory and "podman logs easy-host-buildkitd".`;
    case "railpack-exited-abnormally":
      return `Retry the build. If it repeats, run "easy-host doctor" and check "podman logs easy-host-buildkitd".`;
    case "output-stream-failed":
      return `Run "easy-host doctor" and retry. If it repeats, check the managed daemon with "podman logs easy-host-buildkitd".`;
    default:
      return `Run "easy-host doctor" and retry.`;
  }
}

function resolveWorkspace(workspace: string): string {
  if (typeof workspace !== "string" || workspace.trim().length === 0) {
    throw new UsageError("a workspace directory is required to build", {
      code: "BUILD_WORKSPACE_INVALID",
      details: { reason: "empty" },
      remediation: "Pass the path of the cloned repository or local directory to build.",
    });
  }

  const resolved = path.resolve(workspace);
  let stats: ReturnType<typeof statSync>;

  try {
    stats = statSync(resolved);
  } catch (error) {
    throw new UsageError(`the build workspace "${resolved}" is not readable`, {
      code: "BUILD_WORKSPACE_INVALID",
      details: { workspace: resolved, reason: messageOf(error) },
      remediation: `Check that "${resolved}" exists and is a directory, then retry.`,
    });
  }

  if (!stats.isDirectory()) {
    throw new UsageError(`the build workspace "${resolved}" is not a directory`, {
      code: "BUILD_WORKSPACE_INVALID",
      details: { workspace: resolved, reason: "not-a-directory" },
      remediation: `Pass a directory as the build workspace, not a file.`,
    });
  }

  return resolved;
}

function resolveRailpackPath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UsageError("a verified Railpack binary path is required to build", {
      code: "BUILD_RAILPACK_PATH_INVALID",
      remediation: "Resolve Railpack with resolveRailpack() and pass its `path`.",
    });
  }

  return path.resolve(value);
}

function normalizeBuildkitHost(value: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("unix://") ||
    value.length <= "unix://".length
  ) {
    throw new PrerequisiteError(
      `the BuildKit host must be the managed unix socket, received ${JSON.stringify(value)}`,
      {
        code: "BUILDKIT_HOST_INVALID",
        details: { buildkitHost: typeof value === "string" ? value : "" },
        remediation: `Call ensureBuildkit() and pass its buildkitHost value, then run "easy-host doctor" if the daemon is unavailable.`,
      },
    );
  }

  return value;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return BUILD_DEFAULT_TIMEOUT_MS;
  }

  return Math.trunc(value);
}

function secondsOf(milliseconds: number): number {
  return Math.max(1, Math.round(milliseconds / 1000));
}

function defaultNow(): Date {
  return new Date();
}

function defaultRedact(line: string): string {
  return redactText(line);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the last N lines (and at most M characters) for failure diagnostics.
 * The stream itself is never retained, so a long build stays bounded.
 */
class OutputTail {
  readonly #lines: string[] = [];
  readonly #maxLines: number;
  readonly #maxChars: number;
  #chars = 0;

  constructor(maxLines: number, maxChars: number) {
    this.#maxLines = maxLines;
    this.#maxChars = maxChars;
  }

  push(line: string): void {
    this.#lines.push(line);
    this.#chars += line.length + 1;

    while (
      this.#lines.length > 1 &&
      (this.#lines.length > this.#maxLines || this.#chars > this.#maxChars)
    ) {
      const removed = this.#lines.shift();
      if (removed === undefined) {
        break;
      }
      this.#chars -= removed.length + 1;
    }
  }

  text(): string {
    const joined = this.#lines.join("\n");
    return joined.length > this.#maxChars ? joined.slice(joined.length - this.#maxChars) : joined;
  }
}

/**
 * Splits one stream into lines and flushes each complete line immediately. A
 * line longer than the cap is emitted in pieces so buffering stays bounded.
 */
class LineSplitter {
  readonly #emit: (line: string) => void;
  readonly #maxLength: number;
  #buffer = "";

  constructor(maxLength: number, emit: (line: string) => void) {
    this.#maxLength = maxLength;
    this.#emit = emit;
  }

  push(text: string): void {
    if (text.length === 0) {
      return;
    }

    this.#buffer += text;

    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }

      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#emit(line);
    }

    while (this.#buffer.length > this.#maxLength) {
      this.#emit(this.#buffer.slice(0, this.#maxLength));
      this.#buffer = this.#buffer.slice(this.#maxLength);
    }
  }

  flush(): void {
    if (this.#buffer.length === 0) {
      return;
    }

    const rest = this.#buffer;
    this.#buffer = "";
    this.#emit(rest);
  }
}

/** Ordered queue converting Node stream events into an async iterable. */
class OutputQueue implements AsyncIterable<BuildOutputChunk> {
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
 * Default streaming runner. It spawns without a shell and merges both pipes
 * into one ordered queue. A shared platform runner can replace it through
 * {@link BuildWorkspaceOptions.runner} without changing this module.
 */
export function createDefaultBuildRunner(): BuildRunner {
  return {
    run(command, args, options) {
      const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      };
      const child = spawn(command, [...args], spawnOptions);
      const queue = new OutputQueue();

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (text: string) => queue.push({ stream: "stdout", text }));
      child.stderr?.on("data", (text: string) => queue.push({ stream: "stderr", text }));

      let settled = false;
      const exited = new Promise<BuildExit>((resolve) => {
        const finish = (exit: BuildExit): void => {
          if (settled) {
            return;
          }

          settled = true;
          queue.close();
          resolve(exit);
        };

        child.once("error", (error) => {
          finish({ code: null, signal: null, spawnError: spawnErrorOf(error) });
        });
        child.once("close", (code, signal) => {
          finish({ code, signal });
        });
      });

      return {
        output: queue,
        exited,
        kill(signal = "SIGKILL") {
          child.kill(signal);
        },
      };
    },
  };
}

function spawnErrorOf(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && code.length > 0 ? code : error.message;
}
