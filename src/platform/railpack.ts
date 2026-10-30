/**
 * Railpack acquisition (`BLD-FR-01`).
 *
 * Railpack is downloaded once from the pinned release declared in
 * `versions.ts`, verified against the per-architecture SHA-256 before anything
 * is extracted or executed, and cached under `<root>/tools`. Later builds reuse
 * the cached binary without touching the network.
 *
 * `EASY_HOST_RAILPACK_BIN` replaces the download entirely. That binary is
 * checked for existence, regular-file type, and the execute bit, but its
 * version is not probed here: probing executes operator-supplied code and is
 * the doctor's job (`BLD-FR-05`).
 *
 * The archive is parsed in-process rather than through `tar` so that no shell
 * string is assembled (`PRD-SP-04`) and no archive member other than the
 * pinned binary is ever written to disk. The SHA-256 check happens before the
 * gzip payload is decompressed, so a corrupt or tampered archive cannot
 * produce a runnable file.
 */

import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { BuildError, EasyHostError, PrerequisiteError, UsageError } from "../cli/errors.js";
import {
  type PinnedRailpackRelease,
  RAILPACK_ARCHITECTURES,
  RAILPACK_BINARY_NAME,
  RAILPACK_RELEASES,
  RAILPACK_VERSION,
  type RailpackArchitecture,
} from "./versions.js";

/** Environment variable that replaces the managed download. */
export const EASY_HOST_RAILPACK_BIN = "EASY_HOST_RAILPACK_BIN";

/** Binary name inside `<root>/tools`. */
export const RAILPACK_BINARY_FILENAME = RAILPACK_BINARY_NAME;

/** Receipt recording the verified archive a cached binary came from. */
export const RAILPACK_RECEIPT_FILENAME = "railpack.receipt.json";

/** Mode applied to the cached binary; Railpack must be executable. */
export const RAILPACK_BINARY_MODE = 0o755;

/** Finite download budget (`PRD-NF-05`); 8 MiB over a slow link still fits. */
export const RAILPACK_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Where a resolved Railpack binary came from. */
export type RailpackBinarySource = "override" | "cache" | "download";

/** A Railpack binary that is safe to execute. */
export interface RailpackBinary {
  /** Absolute path to the executable. */
  readonly path: string;
  /**
   * Release version proved by the verified archive. `undefined` for an
   * `EASY_HOST_RAILPACK_BIN` override, whose version is probed by doctor.
   */
  readonly version: string | undefined;
  readonly source: RailpackBinarySource;
  /** SHA-256 of the verified archive; `undefined` for an override. */
  readonly sha256: string | undefined;
}

/**
 * The narrow response surface used for a download. Node's `Response`
 * satisfies it, and tests can supply a plain object with a temporary dir.
 */
export interface RailpackFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Injected HTTP client. Tests count calls and return fixture archives. */
export type RailpackFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<RailpackFetchResponse>;

/** The part of `Paths` acquisition needs. */
export interface RailpackPaths {
  readonly toolsDir: string;
  ensureLayout(): unknown;
}

/** Inputs for {@link installRailpack}. */
export interface RailpackInstallOptions {
  /** `<root>/tools`; created with mode `0700` when missing. */
  toolsDir: string;
  /** Release selected from `versions.ts`. Explicit, never resolved at runtime. */
  release: PinnedRailpackRelease;
  /** Canonical architecture the release was selected for. */
  architecture: RailpackArchitecture;
  /** Injected HTTP client. Defaults to global `fetch`. */
  fetch?: RailpackFetch;
  /** Download timeout. Defaults to {@link RAILPACK_DOWNLOAD_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Inputs for {@link resolveRailpack}. */
export interface RailpackResolveOptions {
  /** State-root paths. `ensureLayout()` runs only for a managed download. */
  paths: RailpackPaths;
  /** Environment used for `EASY_HOST_RAILPACK_BIN`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Node architecture to resolve. Defaults to `process.arch`. */
  arch?: string;
  /** Node platform to resolve. Defaults to `process.platform`. */
  platform?: string;
  /** Base directory for a relative override. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory for `~/` expansion. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Injected HTTP client. Defaults to global `fetch`. */
  fetch?: RailpackFetch;
  /** Download timeout. Defaults to {@link RAILPACK_DOWNLOAD_TIMEOUT_MS}. */
  timeoutMs?: number;
}

interface RailpackReceipt {
  version: string;
  architecture: string;
  asset: string;
  archiveSha256: string;
  binary: string;
}

/** Absolute path of the managed Railpack binary inside `<root>/tools`. */
export function railpackBinaryPath(toolsDir: string): string {
  return path.join(toolsDir, RAILPACK_BINARY_FILENAME);
}

/** Absolute path of the verification receipt written next to the binary. */
export function railpackReceiptPath(toolsDir: string): string {
  return path.join(toolsDir, RAILPACK_RECEIPT_FILENAME);
}

/**
 * Maps a Node/`uname` architecture to a pinned Railpack target. Both the Node
 * names and the uname/Rust names are accepted so callers never need their own
 * translation table.
 */
export function railpackArchitecture(arch: string): RailpackArchitecture | undefined {
  switch (arch) {
    case "x64":
    case "x86_64":
      return "x86_64";
    case "arm64":
    case "aarch64":
      return "aarch64";
    default:
      return undefined;
  }
}

/**
 * Resolves the Railpack executable for this host:
 *
 * 1. `EASY_HOST_RAILPACK_BIN` when set and valid (no download, no arch checks).
 * 2. A previously verified cache entry for the pinned version and architecture.
 * 3. A single download of the pinned archive, verified before extraction.
 */
export async function resolveRailpack(options: RailpackResolveOptions): Promise<RailpackBinary> {
  const env = options.env ?? process.env;
  const override = readEnvironmentVariable(env, EASY_HOST_RAILPACK_BIN);

  if (override !== undefined) {
    return resolveOverride(override, options);
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const architecture = railpackArchitecture(arch);

  if (platform !== "linux" || architecture === undefined) {
    throw unsupportedPlatformError(platform, arch);
  }

  options.paths.ensureLayout();

  return installRailpack({
    toolsDir: options.paths.toolsDir,
    release: RAILPACK_RELEASES[architecture],
    architecture,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/**
 * Installs or reuses a verified Railpack binary for one explicit release.
 *
 * A cache entry is reused only when its receipt matches the release version,
 * architecture, asset, archive digest, and binary name, and the cached file is
 * still a regular executable. Anything else is treated as a cache miss.
 */
export async function installRailpack(options: RailpackInstallOptions): Promise<RailpackBinary> {
  const { toolsDir, release, architecture } = options;

  const cached = findVerifiedCache(toolsDir, release, architecture);
  if (cached !== undefined) {
    return cached;
  }

  try {
    mkdirSync(toolsDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw cacheDirectoryError(toolsDir, error);
  }

  let stagingDir: string;
  try {
    stagingDir = mkdtempSync(path.join(toolsDir, ".railpack-"));
  } catch (error) {
    throw cacheDirectoryError(toolsDir, error);
  }

  try {
    const archive = await downloadArchive(
      release,
      options.fetch ?? defaultFetch,
      normalizeTimeout(options.timeoutMs),
    );
    const actual = sha256(archive);

    // Verify before decompressing, extracting, or renaming anything.
    if (actual !== release.sha256.toLowerCase()) {
      throw digestMismatchError(release, actual);
    }

    let binary: Buffer;
    try {
      binary = extractTarMember(gunzipSync(archive), release.binary);
    } catch (error) {
      throw archiveInvalidError(release, error);
    }

    const target = railpackBinaryPath(toolsDir);
    const staged = path.join(stagingDir, RAILPACK_BINARY_FILENAME);

    try {
      writeFileSync(staged, binary, { mode: RAILPACK_BINARY_MODE });
      chmodSync(staged, RAILPACK_BINARY_MODE);
      renameSync(staged, target);
      chmodSync(target, RAILPACK_BINARY_MODE);
      writeReceipt(toolsDir, {
        version: release.version,
        architecture,
        asset: release.asset,
        archiveSha256: release.sha256,
        binary: release.binary,
      });
    } catch (error) {
      throw cacheDirectoryError(toolsDir, error);
    }

    return {
      path: target,
      version: release.version,
      source: "download",
      sha256: release.sha256,
    };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function resolveOverride(override: string, options: RailpackResolveOptions): RailpackBinary {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const expanded = expandHome(override, homeDir);
  const target = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(target);
  } catch (error) {
    const reason = isErrnoCode(error, "ENOENT")
      ? "the file does not exist"
      : `the file could not be read: ${errorMessage(error)}`;
    throw overrideError(target, reason);
  }

  if (!stats.isFile()) {
    throw overrideError(target, "the path is not a regular file");
  }

  try {
    accessSync(target, constants.X_OK);
  } catch {
    throw overrideError(target, "the file is not executable");
  }

  return {
    path: target,
    version: undefined,
    source: "override",
    sha256: undefined,
  };
}

function findVerifiedCache(
  toolsDir: string,
  release: PinnedRailpackRelease,
  architecture: RailpackArchitecture,
): RailpackBinary | undefined {
  const receiptPath = railpackReceiptPath(toolsDir);
  let raw: string;

  try {
    raw = readFileSync(receiptPath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isReceipt(parsed)) {
    return undefined;
  }

  const matches =
    parsed.version === release.version &&
    parsed.architecture === architecture &&
    parsed.asset === release.asset &&
    parsed.archiveSha256.toLowerCase() === release.sha256.toLowerCase() &&
    parsed.binary === release.binary;

  if (!matches) {
    return undefined;
  }

  const binaryPath = railpackBinaryPath(toolsDir);
  if (!isExecutableFile(binaryPath)) {
    return undefined;
  }

  return {
    path: binaryPath,
    version: release.version,
    source: "cache",
    sha256: release.sha256,
  };
}

function isReceipt(value: unknown): value is RailpackReceipt {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === "string" &&
    typeof candidate.architecture === "string" &&
    typeof candidate.asset === "string" &&
    typeof candidate.archiveSha256 === "string" &&
    typeof candidate.binary === "string"
  );
}

function isExecutableFile(target: string): boolean {
  try {
    if (!statSync(target).isFile()) {
      return false;
    }
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function writeReceipt(toolsDir: string, receipt: RailpackReceipt): void {
  const target = railpackReceiptPath(toolsDir);
  const temporary = `${target}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
  renameSync(temporary, target);
}

async function downloadArchive(
  release: PinnedRailpackRelease,
  fetcher: RailpackFetch,
  timeoutMs: number,
): Promise<Buffer> {
  let response: RailpackFetchResponse;

  try {
    response = await fetcher(release.url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw downloadError(release, describeFetchFailure(error, timeoutMs));
  }

  if (!response.ok) {
    const statusText = response.statusText.length > 0 ? ` ${response.statusText}` : "";
    throw downloadError(release, `the server returned HTTP ${response.status}${statusText}`);
  }

  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw downloadError(
      release,
      `the response body could not be read: ${describeFetchFailure(error, timeoutMs)}`,
    );
  }
}

function defaultFetch(
  url: string,
  init: { readonly signal: AbortSignal },
): Promise<RailpackFetchResponse> {
  return fetch(url, init);
}

function describeFetchFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `the download exceeded its ${Math.round(timeoutMs / 1000)}s timeout`;
  }

  return errorMessage(error);
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return RAILPACK_DOWNLOAD_TIMEOUT_MS;
  }

  return Math.trunc(timeoutMs);
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Extracts one regular-file member from an uncompressed tar buffer. The pinned
 * archive is a plain ustar archive (`LICENSE`, `README.md`, `railpack`), with
 * pax/GNU long-name headers supported so an upstream repack cannot silently
 * break acquisition.
 */
function extractTarMember(tar: Buffer, memberName: string): Buffer {
  const blockSize = 512;
  let offset = 0;
  let pendingName: string | undefined;

  while (offset + blockSize <= tar.length) {
    const header = tar.subarray(offset, offset + blockSize);

    if (isZeroBlock(header)) {
      break;
    }

    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = parseTarNumber(header.subarray(124, 136));
    const dataStart = offset + blockSize;
    const dataEnd = dataStart + size;

    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > tar.length) {
      throw new Error("the archive contains a truncated or impossible member size");
    }

    const data = tar.subarray(dataStart, dataEnd);
    const name = pendingName ?? tarMemberName(header);
    pendingName = undefined;

    if (typeflag === "x") {
      const paxName = parsePaxPath(data);
      if (paxName !== undefined) {
        pendingName = paxName;
      }
    } else if (typeflag === "L") {
      pendingName = cString(data);
    } else if (
      (typeflag === "0" || typeflag === "\0") &&
      normalizeMemberName(name) === memberName
    ) {
      return Buffer.from(data);
    }

    offset = dataStart + Math.ceil(size / blockSize) * blockSize;
  }

  throw new Error(`the archive does not contain a "${memberName}" regular file`);
}

function isZeroBlock(header: Buffer): boolean {
  return header.every((byte) => byte === 0);
}

function tarMemberName(header: Buffer): string {
  const name = cString(header.subarray(0, 100));
  const prefix = cString(header.subarray(345, 500));

  return prefix.length > 0 ? `${prefix}/${name}` : name;
}

function normalizeMemberName(name: string): string {
  return name.replace(/^(\.\/)+/, "");
}

function parseTarNumber(field: Buffer): number {
  if (field.length === 0) {
    return 0;
  }

  // GNU base-256 encoding for values that do not fit the octal field.
  if (((field[0] ?? 0) & 0x80) !== 0) {
    let value = (field[0] ?? 0) & 0x7f;
    for (const byte of field.subarray(1)) {
      value = value * 256 + byte;
    }
    return value;
  }

  const text = cString(field).trim();
  if (text.length === 0) {
    return 0;
  }

  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

function parsePaxPath(payload: Buffer): string | undefined {
  let offset = 0;

  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space === -1) {
      return undefined;
    }

    const length = Number.parseInt(payload.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > payload.length) {
      return undefined;
    }

    let record = payload.subarray(space + 1, offset + length);
    if (record.at(-1) === 0x0a) {
      record = record.subarray(0, record.length - 1);
    }

    const text = record.toString("utf8");
    const equals = text.indexOf("=");
    if (equals > 0 && text.slice(0, equals) === "path") {
      return text.slice(equals + 1);
    }

    offset += length;
  }

  return undefined;
}

function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return (end === -1 ? field : field.subarray(0, end)).toString("utf8");
}

function readEnvironmentVariable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return value;
}

function expandHome(input: string, homeDir: string): string {
  if (input === "~") {
    return homeDir;
  }

  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }

  return input;
}

function unsupportedPlatformError(platform: string, arch: string): PrerequisiteError {
  return new PrerequisiteError(
    `Railpack ${RAILPACK_VERSION} has no pinned asset for platform "${platform}" architecture "${arch}"`,
    {
      code: "RAILPACK_UNSUPPORTED_ARCHITECTURE",
      details: {
        platform,
        architecture: arch,
        supportedPlatforms: ["linux"],
        supportedArchitectures: [...RAILPACK_ARCHITECTURES],
      },
      remediation: `Run easy-host on Linux x86_64 or aarch64, or set ${EASY_HOST_RAILPACK_BIN} to an executable Railpack binary you provide.`,
    },
  );
}

function overrideError(target: string, reason: string): UsageError {
  return new UsageError(
    `${EASY_HOST_RAILPACK_BIN} does not point at an executable file: ${reason}`,
    {
      code: "RAILPACK_OVERRIDE_INVALID",
      details: { path: target },
      remediation: `Unset ${EASY_HOST_RAILPACK_BIN} to use the pinned Railpack ${RAILPACK_VERSION} download, or point it at an executable railpack binary.`,
    },
  );
}

function digestMismatchError(release: PinnedRailpackRelease, actual: string): BuildError {
  return new BuildError(
    `Railpack ${release.version} failed SHA-256 verification; the archive was not extracted and the binary was not executed`,
    {
      code: "RAILPACK_DIGEST_MISMATCH",
      details: {
        version: release.version,
        asset: release.asset,
        url: release.url,
        expected: release.sha256,
        actual,
      },
      remediation: `Delete the Railpack download under the state root tools directory and retry. If the mismatch repeats, review the pinned SHA-256 in src/platform/versions.ts before running the binary.`,
    },
  );
}

function downloadError(release: PinnedRailpackRelease, reason: string): BuildError {
  return new BuildError(
    `could not download Railpack ${release.version} from ${release.url}: ${reason}`,
    {
      code: "RAILPACK_DOWNLOAD_FAILED",
      details: {
        version: release.version,
        asset: release.asset,
        url: release.url,
      },
      remediation: `Check network access to github.com and retry, or set ${EASY_HOST_RAILPACK_BIN} to an executable Railpack binary.`,
    },
  );
}

function archiveInvalidError(release: PinnedRailpackRelease, error: unknown): BuildError {
  return new BuildError(
    `the verified Railpack ${release.version} archive could not provide the "${release.binary}" binary: ${errorMessage(error)}`,
    {
      code: "RAILPACK_ARCHIVE_INVALID",
      details: { version: release.version, asset: release.asset },
      remediation: `Delete the Railpack download under the state root tools directory and retry. If it repeats, review the pinned Railpack release in src/platform/versions.ts.`,
    },
  );
}

function cacheDirectoryError(toolsDir: string, error: unknown): EasyHostError {
  if (error instanceof EasyHostError) {
    return error;
  }

  return new PrerequisiteError(
    `could not prepare the Railpack cache in "${toolsDir}": ${errorMessage(error)}`,
    {
      code: "RAILPACK_CACHE_UNWRITABLE",
      details: { path: toolsDir },
      remediation: `Set EASY_HOST_HOME to a writable directory, or grant write permission on "${toolsDir}".`,
    },
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
