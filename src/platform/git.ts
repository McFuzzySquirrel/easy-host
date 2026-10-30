/**
 * Git workspace preparation (`ADD-FR-02`).
 *
 * `add` materializes one app's source at `<appDir>/workspace` with the system
 * git binary and checks out the declared ref. `update` reuses the same helper
 * by fetching and re-checking out an existing checkout. `--local` mode never
 * copies anything: it validates the app-relative source directory and returns
 * it in place, marked dev-only for the caller's output and status.
 *
 * Credential handling follows `PRD-SP-02`: easy-host stores nothing and relies
 * on the operator's SSH agent or git credential helper. Git is invoked with an
 * argument array and no shell (`PRD-SP-04`), with `GIT_TERMINAL_PROMPT=0` so an
 * absent credential fails instead of hanging on a prompt. Any URL credential
 * that git echoes back is redacted before it reaches an error message, detail,
 * or remediation.
 *
 * Failure mapping is deliberate:
 *
 * - missing repository, authentication failure, and unknown ref are distinct
 *   `BuildError` codes at exit 3 because they are source/network failures;
 * - a missing git binary is a host prerequisite (`PrerequisiteError`, exit 2);
 * - an invalid local path or ref is a usage failure (`UsageError`, exit 1);
 * - an occupied workspace is a conflict (`ConflictError`, exit 6).
 *
 * Every call receives a finite timeout and goes through {@link GitRunner}. The
 * default runner is shell-free; the shared platform runner can replace it by
 * injection without changing this module's interface.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  BuildError,
  ConflictError,
  type ErrorDetails,
  PrerequisiteError,
  redactText,
  UsageError,
} from "../cli/errors.js";
import { validateAppName } from "../config/name.js";
import { APP_SPEC_DEFAULTS, isValidRef } from "../config/schema.js";

/** Directory created inside the app directory for a git checkout. */
export const WORKSPACE_DIRECTORY_NAME = "workspace";

/** Bound on `git clone`, which may transfer a large repository. */
export const GIT_CLONE_TIMEOUT_MS = 300_000;

/** Bound on `git fetch` for an existing workspace. */
export const GIT_FETCH_TIMEOUT_MS = 120_000;

/** Bound on `git checkout`. */
export const GIT_CHECKOUT_TIMEOUT_MS = 60_000;

/** Bound on each ref-resolution `git rev-parse` call. */
export const GIT_REV_PARSE_TIMEOUT_MS = 15_000;

/**
 * Child environment overrides. `GIT_TERMINAL_PROMPT=0` stops git from waiting
 * for a username or password on a terminal; the operator's credential helper
 * and SSH agent are still used. `LC_ALL=C` keeps failure classification stable
 * regardless of the operator's locale.
 */
export const GIT_CHILD_ENVIRONMENT: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  LANG: "C",
};

/** A stable diagnostic code for each recognised git failure. */
export const GIT_FAILURE_CODES = {
  REPOSITORY_NOT_FOUND: "GIT_REPOSITORY_NOT_FOUND",
  AUTHENTICATION_FAILED: "GIT_AUTHENTICATION_FAILED",
  UNKNOWN_REF: "GIT_UNKNOWN_REF",
  UNAVAILABLE: "GIT_UNAVAILABLE",
  CLONE_FAILED: "GIT_CLONE_FAILED",
  FETCH_FAILED: "GIT_FETCH_FAILED",
  CHECKOUT_FAILED: "GIT_CHECKOUT_FAILED",
  REVISION_FAILED: "GIT_REVISION_FAILED",
  WORKSPACE_UNWRITABLE: "WORKSPACE_UNWRITABLE",
  WORKSPACE_OCCUPIED: "WORKSPACE_OCCUPIED",
  INVALID_REPOSITORY: "INVALID_REPOSITORY",
  INVALID_REF: "INVALID_REF",
  INVALID_LOCAL_PATH: "INVALID_LOCAL_PATH",
  LOCAL_PATH_NOT_FOUND: "LOCAL_PATH_NOT_FOUND",
  LOCAL_PATH_NOT_DIRECTORY: "LOCAL_PATH_NOT_DIRECTORY",
  MISSING_WORKSPACE_SOURCE: "MISSING_WORKSPACE_SOURCE",
  CONFLICTING_WORKSPACE_SOURCE: "CONFLICTING_WORKSPACE_SOURCE",
} as const;

/** Recognised classes of git failure. */
export type GitFailureKind = "repository-not-found" | "authentication" | "unknown-ref" | "unknown";

/** One completed git call. */
export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the executable could not be started, for example `ENOENT`. */
  spawnError?: string;
}

/** Per-call options; every call also receives a finite default timeout. */
export interface GitCommandOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * The narrow process-runner surface this module needs. It is structurally
 * satisfied by the shared platform runner, so tests inject a recording fake
 * and production can swap in the central wrapper.
 */
export interface GitRunner {
  run(
    command: string,
    args: readonly string[],
    options?: GitCommandOptions,
  ): GitCommandResult | Promise<GitCommandResult>;
}

/** The two ways an app's source can be provided. */
export type WorkspaceMode = "git" | "local";

/** Inputs that select the source for one app. */
export interface WorkspaceRequest {
  /** App name; used for diagnostics and validated before it becomes a path. */
  readonly app: string;
  /** Absolute app directory, normally `Paths.appDir(name)`. */
  readonly appDir: string;
  /** Git URL or local repository path. Mutually exclusive with `localPath`. */
  readonly repo?: string;
  /** App-relative source directory for dev-only local mode. */
  readonly localPath?: string;
  /** Branch, tag, or commit to check out. Defaults to the config default (`main`). */
  readonly ref?: string;
}

/** Options for {@link prepareWorkspace}. */
export interface PrepareWorkspaceOptions extends WorkspaceRequest {
  /** Process runner. Defaults to a shell-free `spawnSync` implementation. */
  runner?: GitRunner;
  /** Base environment for git children. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  cloneTimeoutMs?: number;
  fetchTimeoutMs?: number;
  checkoutTimeoutMs?: number;
  revParseTimeoutMs?: number;
}

/** Options shared by the individual operations. */
export interface GitWorkspaceOptions {
  readonly app: string;
  readonly appDir: string;
  runner?: GitRunner;
  env?: NodeJS.ProcessEnv;
}

/** Options for {@link cloneWorkspace}. */
export interface CloneWorkspaceOptions extends GitWorkspaceOptions {
  readonly repo: string;
  cloneTimeoutMs?: number;
}

/** Options for {@link fetchWorkspace}. */
export interface FetchWorkspaceOptions extends GitWorkspaceOptions {
  fetchTimeoutMs?: number;
}

/** Options for {@link checkoutWorkspace}. */
export interface CheckoutWorkspaceOptions extends GitWorkspaceOptions {
  readonly ref: string;
  checkoutTimeoutMs?: number;
  revParseTimeoutMs?: number;
}

/** A cloned, not-yet-populated workspace. */
export interface CloneWorkspaceResult {
  readonly app: string;
  readonly appDir: string;
  readonly workspace: string;
  /** The repository URL with any embedded credential redacted. */
  readonly repo: string;
}

/** A refreshed existing checkout. */
export interface FetchWorkspaceResult {
  readonly app: string;
  readonly workspace: string;
}

/** A populated checkout at the resolved commit. */
export interface CheckoutWorkspaceResult {
  readonly app: string;
  readonly workspace: string;
  readonly ref: string;
  readonly commit: string;
}

/** The workspace handed to the builder and recorded by the lifecycle layer. */
export interface PreparedWorkspace {
  readonly app: string;
  readonly appDir: string;
  /** Absolute path the builder should use: `<appDir>/workspace` or the local path. */
  readonly workspace: string;
  readonly mode: WorkspaceMode;
  /** Repository URL with any embedded credential redacted. */
  readonly repo: string | undefined;
  readonly ref: string | undefined;
  readonly commit: string | undefined;
  /** True for `--local` mode; output and status must label it dev-only. */
  readonly devOnly: boolean;
  /** True when this call created the checkout. */
  readonly cloned: boolean;
  /** True when this call refreshed an existing checkout. */
  readonly fetched: boolean;
}

/**
 * The canonical clone target. It is always `<appDir>/workspace`, so no repo,
 * ref, or user-supplied value can redirect the checkout outside the app
 * directory.
 */
export function workspacePath(appDir: string): string {
  return path.join(path.resolve(appDir), WORKSPACE_DIRECTORY_NAME);
}

/** Redacts credentials embedded in a git URL; safe for messages and logs. */
export function redactRepositoryUrl(repo: string): string {
  return redactText(repo);
}

/**
 * Classifies git output. Authentication is checked before the generic
 * "could not read from remote" text, and unknown-ref markers before repository
 * markers, because git reuses phrases across failures.
 */
export function classifyGitFailure(output: string): GitFailureKind {
  const text = output.toLowerCase();

  if (AUTHENTICATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return "authentication";
  }

  if (UNKNOWN_REF_PATTERNS.some((pattern) => pattern.test(text))) {
    return "unknown-ref";
  }

  if (REPOSITORY_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(text))) {
    return "repository-not-found";
  }

  return "unknown";
}

/**
 * Prepares one app's source.
 *
 * In git mode a missing or empty workspace is cloned and then checked out at
 * the declared ref; an existing checkout is fetched and re-checked out. In
 * local mode the app-relative directory is validated and returned in place.
 */
export async function prepareWorkspace(
  options: PrepareWorkspaceOptions,
): Promise<PreparedWorkspace> {
  const app = validateAppName(options.app);
  const appDir = prepareAppDir(options.appDir);
  const hasRepo = options.repo !== undefined;
  const hasLocalPath = options.localPath !== undefined;

  if (hasRepo && hasLocalPath) {
    throw new UsageError("exactly one of a repository URL or --local path is required", {
      code: GIT_FAILURE_CODES.CONFLICTING_WORKSPACE_SOURCE,
      details: { app },
      remediation: "Pass either a repository URL or --local <path>, not both.",
    });
  }

  if (!hasRepo && !hasLocalPath) {
    throw new UsageError("a repository URL or --local path is required", {
      code: GIT_FAILURE_CODES.MISSING_WORKSPACE_SOURCE,
      details: { app },
      remediation: "Pass a repository URL, or use --local <path> for a directory on this host.",
    });
  }

  if (options.localPath !== undefined) {
    const workspace = resolveLocalWorkspace(appDir, options.localPath);

    return {
      app,
      appDir,
      workspace,
      mode: "local",
      repo: undefined,
      ref: undefined,
      commit: undefined,
      devOnly: true,
      cloned: false,
      fetched: false,
    };
  }

  const repo = validateRepository(options.repo);
  const ref = validateRef(options.ref ?? APP_SPEC_DEFAULTS.ref);
  const runner = options.runner ?? createDefaultGitRunner();
  const workspace = workspacePath(appDir);
  const state = inspectWorkspace(workspace);

  if (state === "occupied") {
    throw occupiedWorkspaceError(app, workspace);
  }

  let cloned = false;
  let fetched = false;

  if (state === "git") {
    await fetchWorkspace({
      app,
      appDir,
      runner,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: options.fetchTimeoutMs }),
    });
    fetched = true;
  } else {
    await cloneWorkspace({
      app,
      appDir,
      repo,
      runner,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: options.cloneTimeoutMs }),
    });
    cloned = true;
  }

  const checkout = await checkoutWorkspace({
    app,
    appDir,
    ref,
    runner,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.checkoutTimeoutMs === undefined
      ? {}
      : { checkoutTimeoutMs: options.checkoutTimeoutMs }),
    ...(options.revParseTimeoutMs === undefined
      ? {}
      : { revParseTimeoutMs: options.revParseTimeoutMs }),
  });

  return {
    app,
    appDir,
    workspace,
    mode: "git",
    repo: redactRepositoryUrl(repo),
    ref,
    commit: checkout.commit,
    devOnly: false,
    cloned,
    fetched,
  };
}

/**
 * Clones `repo` into `<appDir>/workspace` without populating the working tree.
 * The destination is always derived from `appDir`; the repository string is
 * never treated as a path. An absent or empty workspace is accepted; a
 * populated non-checkout is refused rather than overwritten.
 */
export async function cloneWorkspace(
  options: CloneWorkspaceOptions,
): Promise<CloneWorkspaceResult> {
  const app = validateAppName(options.app);
  const appDir = prepareAppDir(options.appDir);
  const repo = validateRepository(options.repo);
  const workspace = workspacePath(appDir);
  const state = inspectWorkspace(workspace);

  if (state === "git" || state === "occupied") {
    throw occupiedWorkspaceError(app, workspace);
  }

  const runner = options.runner ?? createDefaultGitRunner();
  const env = gitEnvironment(options.env);
  const timeoutMs = normalizeTimeout(options.cloneTimeoutMs, GIT_CLONE_TIMEOUT_MS);

  const result = await runGit(runner, ["clone", "--no-checkout", "--", repo, workspace], {
    timeoutMs,
    env,
  });

  assertGitSuccess(result, {
    operation: "clone",
    app,
    workspace,
    repo: redactRepositoryUrl(repo),
    ref: undefined,
    timeoutMs,
  });

  return {
    app,
    appDir,
    workspace,
    repo: redactRepositoryUrl(repo),
  };
}

/**
 * Refreshes an existing checkout with `git fetch --prune --tags origin`.
 * Credentials come from the operator's agent or helper, never from easy-host.
 */
export async function fetchWorkspace(
  options: FetchWorkspaceOptions,
): Promise<FetchWorkspaceResult> {
  const app = validateAppName(options.app);
  const appDir = prepareAppDir(options.appDir);
  const workspace = workspacePath(appDir);
  const runner = options.runner ?? createDefaultGitRunner();
  const env = gitEnvironment(options.env);
  const timeoutMs = normalizeTimeout(options.fetchTimeoutMs, GIT_FETCH_TIMEOUT_MS);

  const result = await runGit(runner, ["-C", workspace, "fetch", "--prune", "--tags", "origin"], {
    timeoutMs,
    env,
  });

  assertGitSuccess(result, {
    operation: "fetch",
    app,
    workspace,
    repo: undefined,
    ref: undefined,
    timeoutMs,
  });

  return { app, workspace };
}

/**
 * Resolves `ref` in the checkout and detaches HEAD at that commit.
 *
 * Resolution prefers `refs/remotes/origin/<ref>` so a freshly fetched branch is
 * used, then falls back to the ref itself for tags and commit ids. An
 * unresolved ref is reported as {@link GIT_FAILURE_CODES.UNKNOWN_REF} before
 * `git checkout` runs, so an unknown ref never produces a raw pathspec error.
 */
export async function checkoutWorkspace(
  options: CheckoutWorkspaceOptions,
): Promise<CheckoutWorkspaceResult> {
  const app = validateAppName(options.app);
  const appDir = prepareAppDir(options.appDir);
  const ref = validateRef(options.ref);
  const workspace = workspacePath(appDir);
  const runner = options.runner ?? createDefaultGitRunner();
  const env = gitEnvironment(options.env);
  const revParseTimeoutMs = normalizeTimeout(options.revParseTimeoutMs, GIT_REV_PARSE_TIMEOUT_MS);
  const checkoutTimeoutMs = normalizeTimeout(options.checkoutTimeoutMs, GIT_CHECKOUT_TIMEOUT_MS);

  const commit = await resolveRefCommit(runner, workspace, ref, revParseTimeoutMs, env, app);

  if (commit === undefined) {
    throw unknownRefError({
      app,
      workspace,
      ref,
      repo: undefined,
    });
  }

  const result = await runGit(runner, ["-C", workspace, "checkout", "--detach", commit], {
    timeoutMs: checkoutTimeoutMs,
    env,
  });

  assertGitSuccess(result, {
    operation: "checkout",
    app,
    workspace,
    repo: undefined,
    ref,
    timeoutMs: checkoutTimeoutMs,
  });

  return { app, workspace, ref, commit };
}

/**
 * Validates an app-relative local source without copying it. Absolute paths,
 * `..` segments, control characters, missing directories, and plain files are
 * rejected with a usage error naming the offending value.
 */
export function resolveLocalWorkspace(appDir: string, localPath: string): string {
  const resolvedAppDir = path.resolve(appDir);

  if (
    typeof localPath !== "string" ||
    localPath.length === 0 ||
    localPath.length > 4096 ||
    CONTROL_CHARACTER_PATTERN.test(localPath) ||
    path.posix.isAbsolute(localPath) ||
    path.win32.isAbsolute(localPath) ||
    localPath.split(/[\\/]+/).includes("..")
  ) {
    throw invalidLocalPathError(localPath, "must be a relative path inside the app directory");
  }

  const resolved = path.resolve(resolvedAppDir, localPath);
  const relative = path.relative(resolvedAppDir, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw invalidLocalPathError(localPath, "resolves outside the app directory");
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolved);
  } catch (error) {
    throw new UsageError(`local path "${localPath}" does not exist`, {
      code: GIT_FAILURE_CODES.LOCAL_PATH_NOT_FOUND,
      details: { path: localPath, reason: errnoCode(error) ?? messageOf(error) },
      remediation: "Point --local at an existing directory inside the app directory.",
      cause: error,
    });
  }

  if (!stats.isDirectory()) {
    throw new UsageError(`local path "${localPath}" is not a directory`, {
      code: GIT_FAILURE_CODES.LOCAL_PATH_NOT_DIRECTORY,
      details: { path: localPath },
      remediation: "Point --local at a directory, not a file.",
    });
  }

  return resolved;
}

/**
 * The default runner. It is shell-free, finite-timeout, and bounded in output;
 * tests replace it through {@link GitRunner}.
 */
export function createDefaultGitRunner(): GitRunner {
  return {
    run(command, args, options = {}) {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        timeout: normalizeTimeout(options.timeoutMs, GIT_REV_PARSE_TIMEOUT_MS),
        maxBuffer: 8 * 1024 * 1024,
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      const spawnError = spawnErrorOf(result.error);

      return {
        exitCode: result.status ?? (spawnError === undefined ? 1 : 127),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ...(spawnError === undefined ? {} : { spawnError }),
      };
    },
  };
}

interface GitFailureContext {
  operation: "clone" | "fetch" | "checkout" | "rev-parse";
  app: string;
  workspace: string;
  /** Already redacted when present. */
  repo: string | undefined;
  ref: string | undefined;
  timeoutMs: number;
}

interface UnknownRefContext {
  app: string;
  workspace: string;
  ref: string;
  repo: string | undefined;
}

async function runGit(
  runner: GitRunner,
  args: readonly string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  try {
    return await Promise.resolve(runner.run("git", args, options));
  } catch (error) {
    throw new PrerequisiteError(`could not start git: ${messageOf(error)}`, {
      code: GIT_FAILURE_CODES.UNAVAILABLE,
      details: { reason: messageOf(error) },
      remediation:
        "Install system git 2.40 or newer, make sure `git` is on PATH, then run `easy-host doctor`.",
      cause: error,
    });
  }
}

async function resolveRefCommit(
  runner: GitRunner,
  workspace: string,
  ref: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  app: string,
): Promise<string | undefined> {
  const candidates = [`refs/remotes/origin/${ref}`, ref];

  for (const candidate of candidates) {
    const result = await runGit(
      runner,
      ["-C", workspace, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
      { timeoutMs, env },
    );

    if (result.spawnError !== undefined || result.exitCode !== 0) {
      // `--verify --quiet` uses exit 1 for an unadvertised ref and nothing on
      // stderr. Every other failure is a real repository or host problem and
      // must not be disguised as an unknown ref.
      if (result.spawnError !== undefined || result.exitCode !== 1) {
        assertGitSuccess(result, {
          operation: "rev-parse",
          app,
          workspace,
          repo: undefined,
          ref,
          timeoutMs,
        });
      }

      continue;
    }

    const commit = result.stdout.trim();
    if (commit.length > 0) {
      return commit;
    }
  }

  return undefined;
}

function assertGitSuccess(result: GitCommandResult, context: GitFailureContext): void {
  if (result.spawnError === "ENOENT") {
    throw gitUnavailableError(context);
  }

  if (result.exitCode === 0 && result.spawnError === undefined) {
    return;
  }

  const reason = summarizeGitOutput(result, context.timeoutMs);
  const kind = classifyGitFailure(`${result.stderr}\n${result.stdout}`);
  const details = gitDetails(context, reason);

  if (kind === "authentication") {
    throw new BuildError(
      `authentication failed for repository "${context.repo ?? context.workspace}": ${reason}`,
      {
        code: GIT_FAILURE_CODES.AUTHENTICATION_FAILED,
        details,
        remediation:
          "Check the operator's SSH agent or git credential helper; easy-host never stores repository credentials.",
      },
    );
  }

  if (kind === "unknown-ref") {
    throw unknownRefError({
      app: context.app,
      workspace: context.workspace,
      ref: context.ref ?? APP_SPEC_DEFAULTS.ref,
      repo: context.repo,
      reason,
    });
  }

  if (kind === "repository-not-found") {
    throw new BuildError(
      `repository "${context.repo ?? context.workspace}" was not found: ${reason}`,
      {
        code: GIT_FAILURE_CODES.REPOSITORY_NOT_FOUND,
        details,
        remediation:
          "Check the repository URL and network access, or use --local for a directory on this host.",
      },
    );
  }

  const code = genericFailureCode(context.operation);

  throw new BuildError(`${describeOperation(context.operation)} failed: ${reason}`, {
    code,
    details,
    remediation: genericRemediation(context.operation),
  });
}

function gitDetails(context: GitFailureContext, reason: string): ErrorDetails {
  return {
    app: context.app,
    operation: context.operation,
    workspace: context.workspace,
    ...(context.repo === undefined ? {} : { repo: context.repo }),
    ...(context.ref === undefined ? {} : { ref: context.ref }),
    reason,
    timeoutMs: context.timeoutMs,
  };
}

function unknownRefError(context: UnknownRefContext & { reason?: string }): BuildError {
  const subject =
    context.repo === undefined
      ? `the repository at "${context.workspace}"`
      : `repository "${context.repo}"`;
  const reason =
    context.reason === undefined
      ? `ref "${context.ref}" was not found in ${subject}`
      : `ref "${context.ref}" was not found in ${subject}: ${context.reason}`;

  return new BuildError(reason, {
    code: GIT_FAILURE_CODES.UNKNOWN_REF,
    details: {
      app: context.app,
      ref: context.ref,
      workspace: context.workspace,
      ...(context.repo === undefined ? {} : { repo: context.repo }),
    },
    remediation: `Push "${context.ref}" or choose an existing branch, tag, or commit with --ref.`,
  });
}

function gitUnavailableError(context: GitFailureContext): PrerequisiteError {
  return new PrerequisiteError("the system git executable was not found", {
    code: GIT_FAILURE_CODES.UNAVAILABLE,
    details: {
      operation: context.operation,
      workspace: context.workspace,
      reason: "git executable not found on PATH",
    },
    remediation:
      "Install system git 2.40 or newer, make sure `git` is on PATH, then run `easy-host doctor`.",
  });
}

function occupiedWorkspaceError(app: string, workspace: string): ConflictError {
  return new ConflictError(
    `workspace "${workspace}" already exists and is not an easy-host git checkout`,
    {
      code: GIT_FAILURE_CODES.WORKSPACE_OCCUPIED,
      details: { app, workspace },
      remediation: `Move or remove "${workspace}", then retry.`,
    },
  );
}

function invalidLocalPathError(localPath: string, reason: string): UsageError {
  return new UsageError(`invalid local path "${localPath}": ${reason}`, {
    code: GIT_FAILURE_CODES.INVALID_LOCAL_PATH,
    details: { path: localPath, reason },
    remediation: "Use an app-relative directory without '..' segments or a drive prefix.",
  });
}

function prepareAppDir(appDir: string): string {
  const resolved = path.resolve(appDir);

  try {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new PrerequisiteError(
      `could not create app directory "${resolved}": ${messageOf(error)}`,
      {
        code: GIT_FAILURE_CODES.WORKSPACE_UNWRITABLE,
        details: { path: resolved, reason: messageOf(error) },
        remediation: `Grant write permission on "${path.dirname(resolved)}" and retry.`,
        cause: error,
      },
    );
  }

  return resolved;
}

type WorkspaceState = "absent" | "empty" | "git" | "occupied";

function inspectWorkspace(workspace: string): WorkspaceState {
  let stats: ReturnType<typeof statSync>;

  try {
    stats = statSync(workspace);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return "absent";
    }

    throw new PrerequisiteError(`could not read workspace "${workspace}": ${messageOf(error)}`, {
      code: GIT_FAILURE_CODES.WORKSPACE_UNWRITABLE,
      details: { workspace, reason: messageOf(error) },
      remediation: `Check permissions on "${workspace}" and retry.`,
      cause: error,
    });
  }

  if (!stats.isDirectory()) {
    return "occupied";
  }

  if (existsSync(path.join(workspace, ".git"))) {
    return "git";
  }

  try {
    return readdirSync(workspace).length === 0 ? "empty" : "occupied";
  } catch (error) {
    throw new PrerequisiteError(`could not read workspace "${workspace}": ${messageOf(error)}`, {
      code: GIT_FAILURE_CODES.WORKSPACE_UNWRITABLE,
      details: { workspace, reason: messageOf(error) },
      remediation: `Check permissions on "${workspace}" and retry.`,
      cause: error,
    });
  }
}

function validateRepository(repo: string | undefined): string {
  if (
    repo === undefined ||
    repo.length === 0 ||
    repo.length > 2048 ||
    CONTROL_CHARACTER_PATTERN.test(repo) ||
    repo.startsWith("-")
  ) {
    throw new UsageError("a valid repository URL is required", {
      code: GIT_FAILURE_CODES.INVALID_REPOSITORY,
      details: { repo: repo === undefined ? null : redactRepositoryUrl(repo) },
      remediation: "Pass an https, ssh, git, or file URL without spaces or a leading '-'.",
    });
  }

  return repo;
}

function validateRef(ref: string): string {
  if (!isValidRef(ref)) {
    throw new UsageError(`invalid git ref "${ref}"`, {
      code: GIT_FAILURE_CODES.INVALID_REF,
      details: { ref },
      remediation: "Use a branch, tag, or commit without spaces, '..', or a leading '-'.",
    });
  }

  return ref;
}

function gitEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...(env ?? process.env),
    ...GIT_CHILD_ENVIRONMENT,
  };
}

function summarizeGitOutput(result: GitCommandResult, timeoutMs: number): string {
  if (result.spawnError === "ETIMEDOUT") {
    return `timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s`;
  }

  const raw = result.stderr.trim() || result.stdout.trim();
  const fallback =
    result.spawnError !== undefined
      ? `could not start git (${result.spawnError})`
      : `exit code ${result.exitCode}`;

  if (raw.length === 0) {
    return fallback;
  }

  const tail = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-6)
    .join(" ");

  const redacted = redactText(tail.length > 0 ? tail : fallback);
  return redacted.length > 600 ? `${redacted.slice(0, 597)}...` : redacted;
}

function describeOperation(operation: GitFailureContext["operation"]): string {
  switch (operation) {
    case "clone":
      return "git clone";
    case "fetch":
      return "git fetch";
    case "checkout":
      return "git checkout";
    case "rev-parse":
      return "git rev-parse";
  }
}

function genericFailureCode(operation: GitFailureContext["operation"]): string {
  switch (operation) {
    case "clone":
      return GIT_FAILURE_CODES.CLONE_FAILED;
    case "fetch":
      return GIT_FAILURE_CODES.FETCH_FAILED;
    case "checkout":
      return GIT_FAILURE_CODES.CHECKOUT_FAILED;
    case "rev-parse":
      return GIT_FAILURE_CODES.REVISION_FAILED;
  }
}

function genericRemediation(operation: GitFailureContext["operation"]): string {
  switch (operation) {
    case "clone":
      return "Check the repository URL and network access, then retry; run with EASY_HOST_DEBUG=1 for git's full output.";
    case "fetch":
      return "Check the repository URL and network access, then retry; run with EASY_HOST_DEBUG=1 for git's full output.";
    case "checkout":
      return "Check that the ref exists in the fetched repository, then retry.";
    case "rev-parse":
      return "Check that the workspace is a valid git checkout, then retry.";
  }
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.trunc(value);
}

function spawnErrorOf(error: Error | undefined): string | undefined {
  if (error === undefined) {
    return undefined;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && code.length > 0 ? code : error.message;
}

function errnoCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }

  return undefined;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return errnoCode(error) === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is intentional input hardening.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const AUTHENTICATION_PATTERNS: readonly RegExp[] = [
  /authentication failed/,
  /could not read username/,
  /could not read password/,
  /terminal prompts disabled/,
  /permission denied \(publickey/,
  /permission denied, please try again/,
  /invalid username or password/,
  /support for password authentication was removed/,
  /access denied/,
  /the requested url returned error: (401|403)/,
  /host key verification failed/,
];

const UNKNOWN_REF_PATTERNS: readonly RegExp[] = [
  /pathspec .* did not match/,
  /couldn't find remote ref/,
  /remote branch .* not found/,
  /invalid reference/,
  /reference is not a tree/,
  /unknown revision/,
  /bad revision/,
  /not a valid object name/,
  /unadvertised object/,
];

const REPOSITORY_NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /repository .* not found/,
  /repository .* does not exist/,
  /does not appear to be a git repository/,
  /could not read from remote repository/,
  /could not resolve host/,
  /failed to connect/,
  /connection refused/,
  /connection timed out/,
  /no such file or directory/,
  /unable to access .*(404|not found)/,
];
