import { type Dirent, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { BUILD_IMAGE_PREFIX } from "../platform/build.js";
import { BUILDKIT_STATE_DIRECTORY } from "../platform/buildkit.js";
import { APP_NAME_PATTERN } from "../platform/paths.js";
import {
  checkDisk,
  type DiskSpace,
  type DiskSpaceReader,
  DOCTOR_COMMAND_TIMEOUT_MS,
  type DoctorCheck,
  type ProcessRunner,
} from "./checks.js";

/**
 * Disk-usage reporting for `easy-host doctor` (`OBS-FR-04`).
 *
 * The group answers one question: where did the host's disk go? It reports
 *
 * - the summed size of every `localhost/easy-host-<app>` image, per app and in
 *   total, read from `podman images --format json`;
 * - the BuildKit cache size, preferring a build-cache row in
 *   `podman system df --format json` and otherwise measuring the managed
 *   `<root>/buildkit/state` directory the daemon writes to;
 * - each app's `workspace/` size and the `<root>/tools` size, measured on the
 *   local filesystem.
 *
 * Every figure is approximate by nature: image `Size` may share layers, and
 * directory walks race with builds. Output therefore labels usage as
 * approximate ("Approximate usage" in the report, `approximate: true` in
 * JSON). An unreadable measurement is `null` ("unknown"), never `0`, so a
 * consumer cannot mistake a failed probe for an empty directory.
 *
 * Everything here is read-only and local. There is no network access and no
 * automatic pruning, no matter how low free space is: the operator decides
 * what to remove (`PRE-NF-01`, `PRD-NF-05`).
 */

/** Budget for one recursive size walk; exceeding it reports unknown. */
export const DIRECTORY_SIZE_BUDGET_MS = 750;

/** Entry cap for one recursive size walk; exceeding it reports unknown. */
export const DIRECTORY_SIZE_MAX_ENTRIES = 200_000;

/** Measured size of one app's images, or `null` when it could not be read. */
export interface AppDiskUsage {
  readonly app: string;
  readonly bytes: number | null;
}

/** Measured size of one app's workspace, or `null` when it could not be read. */
export interface WorkspaceDiskUsage {
  readonly app: string;
  readonly bytes: number | null;
}

/**
 * The stable disk figures carried by `doctor` and by `doctor --json`.
 * `null` means "could not be measured" and is never rendered as zero.
 */
export interface DiskUsageReport {
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
  readonly appImages: readonly AppDiskUsage[];
  readonly imagesTotalBytes: number | null;
  readonly buildkitCacheBytes: number | null;
  readonly workspaces: readonly WorkspaceDiskUsage[];
  readonly workspaceTotalBytes: number | null;
  readonly toolsBytes: number | null;
  /** Always `true`; every figure is an approximation, never a quota. */
  readonly approximate: true;
}

/** Recursive byte counter. Tests inject a recorder; production walks the tree. */
export type DirectorySizeReader = (target: string) => number;

/** Everything the disk group reads. Resolved once by `runDoctor`. */
export interface DiskCheckEnvironment {
  runner: ProcessRunner;
  readDiskSpace: DiskSpaceReader;
  diskPath: string;
  /** `<root>/apps`, whose children hold each app's `workspace/`. */
  appsDir: string;
  /** `<root>/tools`, where pinned tools such as Railpack are cached. */
  toolsDir: string;
  /** `<root>/buildkit`, whose `state/` holds the BuildKit cache. */
  buildkitDir: string;
  readDirectorySize: DirectorySizeReader;
}

/** One ordered disk check plus the structured figures it reports. */
export interface DiskCheckResult {
  check: DoctorCheck;
  usage: DiskUsageReport;
}

/**
 * Runs the disk group. Free-space thresholds come from `checkDisk`; this
 * function adds the approximate usage figures to its detail line and returns
 * the same figures for the JSON document.
 */
export function runDiskChecks(environment: DiskCheckEnvironment): DiskCheckResult {
  const space = measureDiskSpace(environment);
  const spaceCheck = checkDisk({
    diskPath: environment.diskPath,
    // Reuse the single measurement so the report and the check cannot disagree.
    readDiskSpace: () => {
      if (space === null) {
        throw new Error("disk space could not be measured");
      }

      return space.value;
    },
  });

  const apps = listAppNames(environment.appsDir);
  const imageSizes = readImageSizes(environment);
  const reportCacheBytes = readSystemDfBuildkitCache(environment);

  // One budget for every filesystem walk in this group: a host with many large
  // workspaces reports later values as unknown instead of letting doctor
  // overrun its 2-second budget (`PRE-NF-01`). The Podman calls above are
  // bounded separately by `DOCTOR_COMMAND_TIMEOUT_MS`.
  const deadline = Date.now() + DIRECTORY_SIZE_BUDGET_MS;
  const readWithinBudget = (target: string): number => {
    if (Date.now() > deadline) {
      throw new Error(`disk usage measurement exceeded ${DIRECTORY_SIZE_BUDGET_MS}ms`);
    }

    return environment.readDirectorySize(target);
  };

  const appImages = projectAppImages(apps, imageSizes);
  const workspaces = measureWorkspaces(environment.appsDir, apps, readWithinBudget);
  const buildkitCacheBytes =
    reportCacheBytes ??
    measureDirectory(
      readWithinBudget,
      path.join(environment.buildkitDir, BUILDKIT_STATE_DIRECTORY),
    );
  const toolsBytes = measureDirectory(readWithinBudget, environment.toolsDir);

  const usage: DiskUsageReport = {
    freeBytes: space === null ? null : byteCount(space.value.freeBytes),
    totalBytes: space === null ? null : byteCount(space.value.totalBytes),
    appImages,
    imagesTotalBytes: imageSizes === null ? null : sumImageSizes(imageSizes),
    buildkitCacheBytes,
    workspaces,
    workspaceTotalBytes: apps.readable ? totalWorkspaceBytes(workspaces) : null,
    toolsBytes,
    approximate: true,
  };

  return {
    check: {
      ...spaceCheck,
      detail: `${spaceCheck.detail} ${describeDiskUsage(usage)}`,
    },
    usage,
  };
}

/**
 * A recursive byte count that never leaves the state root and never follows a
 * symlink (`PRD-SP-05`). A missing path is a genuine zero bytes of usage; a
 * read error, an entry cap, or the {@link DIRECTORY_SIZE_BUDGET_MS} deadline
 * throws so the caller reports unknown rather than a misleading partial sum.
 */
export function readDirectorySize(target: string): number {
  const info = lstatIfPresent(target);
  if (info === undefined) {
    return 0;
  }

  if (info.isSymbolicLink()) {
    throw new Error(`refusing to measure symlink "${target}"`);
  }

  if (!info.isDirectory()) {
    return Number(info.size);
  }

  const deadline = Date.now() + DIRECTORY_SIZE_BUDGET_MS;
  const pending: string[] = [target];
  let total = 0;
  let entries = 0;

  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }

    let children: Dirent[];
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
        continue;
      }

      throw error;
    }

    for (const child of children) {
      if (child.isSymbolicLink()) {
        continue;
      }

      const childPath = path.join(directory, child.name);

      if (child.isDirectory()) {
        pending.push(childPath);
        continue;
      }

      if (!child.isFile()) {
        continue;
      }

      try {
        total += Number(lstatSync(childPath).size);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
          continue;
        }

        throw error;
      }

      entries += 1;
      if (entries > DIRECTORY_SIZE_MAX_ENTRIES) {
        throw new Error(
          `directory "${target}" has more than ${DIRECTORY_SIZE_MAX_ENTRIES} files; size is unknown`,
        );
      }
    }

    if (Date.now() > deadline) {
      throw new Error(
        `directory "${target}" took longer than ${DIRECTORY_SIZE_BUDGET_MS}ms to measure`,
      );
    }
  }

  return total;
}

/**
 * Parses `podman images --format json` into a per-app byte map. Each image is
 * counted once, even when it carries several tags. Entries without an
 * `easy-host` repository are ignored. `null` means the listing was not usable.
 */
export function parsePodmanImagesJson(output: string): Map<string, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const totals = new Map<string, number>();
  const counted = new Set<string>();

  for (const entry of parsed) {
    if (!isRecord(entry)) {
      continue;
    }

    // Podman can repeat one image once per tag; count the image, not the tag.
    const id = readString(entry, ["Id", "ID", "id"]);
    if (id !== undefined) {
      if (counted.has(id)) {
        continue;
      }
      counted.add(id);
    }

    const size = readSize(entry);
    if (size === null) {
      continue;
    }

    const app = appOfImage(entry);
    if (app === undefined) {
      continue;
    }

    totals.set(app, (totals.get(app) ?? 0) + size);
  }

  return totals;
}

/**
 * Reads a BuildKit cache size from `podman system df --format json`. Podman
 * 5.7 emits only Images, Containers, and Local Volumes rows; a future row (or
 * a wrapper object) that names a build cache is honoured here. `null` means
 * the report carried no build-cache figure, so the caller falls back to the
 * managed state directory.
 */
export function parseBuildkitCacheBytes(output: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];

  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }

    const label = readString(row, ["Type", "type", "Name", "name", "Kind", "kind"]);
    if (label !== undefined && /build\s*-?\s*cache/i.test(label)) {
      const size = readSize(row);
      if (size !== null) {
        return size;
      }
    }

    for (const [key, value] of Object.entries(row)) {
      if (!/build\s*-?\s*cache/i.test(key)) {
        continue;
      }

      const direct = numberValue(value) ?? (isRecord(value) ? readSize(value) : null);
      if (direct !== null) {
        return direct;
      }
    }
  }

  return null;
}

/** The compact, approximate usage line appended to the `disk` check. */
export function describeDiskUsage(usage: DiskUsageReport): string {
  const imageBreakdown = breakdown(usage.appImages.map((entry) => [entry.app, entry.bytes]));
  const workspaceBreakdown = breakdown(usage.workspaces.map((entry) => [entry.app, entry.bytes]));

  return [
    "Approximate usage:",
    `images ${formatApproximateBytes(usage.imagesTotalBytes)}${imageBreakdown};`,
    `BuildKit cache ${formatApproximateBytes(usage.buildkitCacheBytes)};`,
    `workspaces ${formatApproximateBytes(usage.workspaceTotalBytes)}${workspaceBreakdown};`,
    `tools ${formatApproximateBytes(usage.toolsBytes)}.`,
  ].join(" ");
}

/** Human-friendly approximate bytes; `null` renders as `unknown`, never zero. */
export function formatApproximateBytes(bytes: number | null): string {
  const value = byteCount(bytes);
  if (value === null) {
    return "unknown";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let scaled = value / 1024;
  let index = 0;

  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }

  return `${scaled.toFixed(1)} ${units[index] ?? "B"}`;
}

/**
 * Parses a human-readable size such as `24.64GB`. Approximate by design: one
 * binary factor is used for every suffix, which is why the output is labelled.
 */
export function parseApproximateSize(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgtp]?i?b)?\s*$/i.exec(value);
  if (match === null) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  const unit = (match[2] ?? "b").toLowerCase();
  const powers: Readonly<Record<string, number>> = {
    b: 0,
    kb: 1,
    kib: 1,
    mb: 2,
    mib: 2,
    gb: 3,
    gib: 3,
    tb: 4,
    tib: 4,
    pb: 5,
    pib: 5,
  };
  const power = powers[unit];
  if (power === undefined) {
    return null;
  }

  return Math.round(amount * 1024 ** power);
}

interface MeasuredSpace {
  value: DiskSpace;
}

function measureDiskSpace(environment: DiskCheckEnvironment): MeasuredSpace | null {
  try {
    return { value: environment.readDiskSpace(environment.diskPath) };
  } catch {
    return null;
  }
}

interface AppNames {
  names: string[];
  /** `false` when `apps/` exists but could not be listed. */
  readable: boolean;
}

function listAppNames(appsDir: string): AppNames {
  let children: Dirent[];
  try {
    children = readdirSync(appsDir, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return { names: [], readable: true };
    }

    return { names: [], readable: false };
  }

  const names = children
    .filter((child) => child.isDirectory() && !child.isSymbolicLink())
    .map((child) => child.name)
    .filter((name) => APP_NAME_PATTERN.test(name))
    .sort();

  return { names, readable: true };
}

function readImageSizes(environment: DiskCheckEnvironment): Map<string, number> | null {
  const output = runPodman(environment, ["images", "--format", "json"]);
  return output === null ? null : parsePodmanImagesJson(output);
}

function measureWorkspaces(
  appsDir: string,
  apps: AppNames,
  readSize: DirectorySizeReader,
): WorkspaceDiskUsage[] {
  return apps.names.map((app) => ({
    app,
    bytes: measureDirectory(readSize, path.join(appsDir, app, "workspace")),
  }));
}

/**
 * Reads a build-cache row from `podman system df` when the Podman version
 * reports one. Podman 5.7 does not, so `null` falls back to the managed
 * `<root>/buildkit/state` directory the daemon writes to.
 */
function readSystemDfBuildkitCache(environment: DiskCheckEnvironment): number | null {
  const output = runPodman(environment, ["system", "df", "--format", "json"]);
  return output === null ? null : parseBuildkitCacheBytes(output);
}

function runPodman(environment: DiskCheckEnvironment, args: readonly string[]): string | null {
  try {
    const result = environment.runner.run("podman", args, {
      timeoutMs: DOCTOR_COMMAND_TIMEOUT_MS,
    });

    if (result.spawnError !== undefined || result.exitCode !== 0) {
      return null;
    }

    return result.stdout;
  } catch {
    return null;
  }
}

function measureDirectory(reader: DirectorySizeReader, target: string): number | null {
  try {
    return byteCount(reader(target));
  } catch {
    return null;
  }
}

function projectAppImages(apps: AppNames, imageSizes: Map<string, number> | null): AppDiskUsage[] {
  const names = new Set(apps.names);
  if (imageSizes !== null) {
    for (const app of imageSizes.keys()) {
      names.add(app);
    }
  }

  return [...names].sort().map((app) => ({
    app,
    bytes: imageSizes === null ? null : (imageSizes.get(app) ?? 0),
  }));
}

function totalWorkspaceBytes(workspaces: readonly WorkspaceDiskUsage[]): number | null {
  if (workspaces.some((entry) => entry.bytes === null)) {
    return null;
  }

  return workspaces.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
}

function sumImageSizes(totals: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const bytes of totals.values()) {
    sum += bytes;
  }

  return sum;
}

function breakdown(entries: readonly (readonly [string, number | null])[]): string {
  if (entries.length === 0) {
    return "";
  }

  return ` (${entries.map(([app, bytes]) => `${app} ${formatApproximateBytes(bytes)}`).join(", ")})`;
}

function appOfImage(entry: Record<string, unknown>): string | undefined {
  for (const reference of imageReferences(entry)) {
    const repository = repositoryOf(reference);
    if (repository === undefined || !repository.startsWith(BUILD_IMAGE_PREFIX)) {
      continue;
    }

    const candidate = repository.slice(BUILD_IMAGE_PREFIX.length);
    if (APP_NAME_PATTERN.test(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function imageReferences(entry: Record<string, unknown>): string[] {
  const references: string[] = [];

  for (const key of ["RepoTags", "Names", "RepoDigests"]) {
    const value = entry[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.length > 0) {
          references.push(item);
        }
      }
    }
  }

  for (const key of ["Name", "name", "Image", "image"]) {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) {
      references.push(value);
    }
  }

  const repository = readString(entry, ["Repository", "repository"]);
  const tag = readString(entry, ["Tag", "tag"]);
  if (repository !== undefined) {
    references.push(tag === undefined || tag === "<none>" ? repository : `${repository}:${tag}`);
  }

  return references;
}

/** Strips a digest and then a trailing tag, tolerating a registry port. */
function repositoryOf(reference: string): string | undefined {
  const withoutDigest = reference.split("@")[0] ?? "";
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const repository = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;

  return repository.length > 0 ? repository : undefined;
}

function readSize(entry: Record<string, unknown>): number | null {
  for (const key of ["RawSize", "rawSize", "Size", "size", "Bytes", "bytes"]) {
    const direct = numberValue(entry[key]);
    if (direct !== null) {
      return direct;
    }

    const value = entry[key];
    if (typeof value === "string") {
      const parsed = parseApproximateSize(value);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

function readString(entry: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") {
    return byteCount(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return byteCount(Number(value));
  }

  return null;
}

function byteCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.trunc(value);
}

function lstatIfPresent(target: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return undefined;
    }

    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
