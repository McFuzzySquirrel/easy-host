/**
 * Rebuildable per-app state cache (REG-FR-04, PRD-NF-06).
 *
 * `apps/<name>/state.json` is a cache, never the source of truth: the
 * directory tree decides which apps exist. This module reads the cache
 * leniently (unknown and missing fields are ignored or defaulted, and the
 * directory name always wins over a cached name) and rebuilds it from the app
 * directory plus an optional runtime snapshot when it is missing or unusable.
 * A rebuild that cannot be persisted still returns usable state, so a
 * read-only filesystem never makes an app disappear (REG-FR-04).
 *
 * Writes reuse the same-directory temporary-file-plus-rename primitive as the
 * registry (`writeFileAtomic`), so a crash leaves the previous complete cache
 * or the new complete cache (REG-NF-02). All timestamps are ISO 8601 UTC.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NotFoundError } from "../cli/errors.js";
import {
  type AtomicWriteOptions,
  type BeforeRenameHook,
  CONFIG_FILE_NAME,
  STATE_FILE_MODE,
  STATE_FILE_NAME,
  writeFileAtomic,
} from "./store.js";

/** Version of the `state.json` document this build reads and writes. */
export const STATE_SCHEMA_VERSION = 1;

/** Health outcomes recorded in the cache. `unknown` means never probed. */
export const HEALTH_STATUSES = ["healthy", "unhealthy", "unknown"] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** Current and rollback image references. */
export interface AppStateImages {
  current: string | null;
  previous: string | null;
}

/** Last health observation, re-derived on every read command. */
export interface AppStateHealth {
  status: HealthStatus;
  checkedAt: string | null;
  detail: string | null;
}

/**
 * The cached document. `name` is recorded for human debugging only; the
 * directory name is authoritative and replaces it on every read.
 */
export interface AppState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  name: string;
  images: AppStateImages;
  containerId: string | null;
  health: AppStateHealth;
  createdAt: string;
  updatedAt: string;
}

/**
 * Runtime facts used when rebuilding a missing or invalid cache. Podman is the
 * only source for these; this module never invokes it.
 */
export interface StateRuntimeSnapshot {
  images?: { current?: string | null; previous?: string | null };
  containerId?: string | null;
  health?: { status?: HealthStatus; checkedAt?: string | null; detail?: string | null };
}

/** Supplies the runtime snapshot; injected by the caller that owns Podman. */
export type StateRuntimeReader = (appDir: string) => StateRuntimeSnapshot | undefined;

export interface StateStoreOptions {
  /** Clock used for `updatedAt` and rebuild `createdAt`. Defaults to `new Date()`. */
  clock?: () => Date;
  /** Runtime reader applied on every rebuild unless a call overrides it. */
  runtime?: StateRuntimeReader;
  /** Test and crash-simulation seam forwarded to cache writes. */
  beforeRename?: BeforeRenameHook;
}

export interface StateLoadOptions {
  /** Overrides the constructor runtime reader for this rebuild only. */
  runtime?: StateRuntimeSnapshot;
  /** Test and crash-simulation seam forwarded to the rebuild write. */
  beforeRename?: BeforeRenameHook;
}

/** Why a cache had to be rebuilt, and whether the result could be persisted. */
export interface StateLoadResult {
  state: AppState;
  source: "cache" | "rebuilt";
  /** Present only when `source` is `rebuilt`. */
  reason?: "missing" | "invalid";
  /**
   * `false` when a rebuilt cache could not be written (read-only filesystem,
   * full disk). The app remains usable; the next read rebuilds again.
   */
  persisted: boolean;
}

/** Partial update applied by lifecycle actions after a confirmed state change. */
export interface AppStatePatch {
  images?: Partial<AppStateImages>;
  containerId?: string | null;
  health?: Partial<AppStateHealth>;
}

/**
 * Reads and writes the cache for one app directory.
 *
 * Construction performs no I/O and does not require the directory to exist;
 * `load`, `rebuild`, `update`, and `write` do.
 */
export class StateStore {
  readonly appDir: string;
  readonly statePath: string;
  readonly #clock: () => Date;
  readonly #runtime: StateRuntimeReader | undefined;
  readonly #beforeRename: BeforeRenameHook | undefined;

  constructor(appDir: string, options: StateStoreOptions = {}) {
    this.appDir = path.resolve(appDir);
    this.statePath = path.join(this.appDir, STATE_FILE_NAME);
    this.#clock = options.clock ?? (() => new Date());
    this.#runtime = options.runtime;
    this.#beforeRename = options.beforeRename;
  }

  /**
   * Lenient read: returns the cached state when it is usable, otherwise
   * rebuilds from the directory and the runtime and tries to persist it.
   */
  load(options: StateLoadOptions = {}): StateLoadResult {
    const now = this.now();
    const cache = readStateText(this.statePath);
    const cached =
      cache.status === "ok" ? parseStateDocument(cache.text, this.#name(), now) : undefined;

    if (cached !== undefined) {
      return { state: cached, source: "cache", persisted: true };
    }

    const state = this.rebuildState(options, now);
    let persisted = false;

    try {
      this.write(state, this.#atomicOptions(options.beforeRename));
      persisted = true;
    } catch {
      // The cache is advisory. A read-only or full filesystem must not make the
      // app unusable (REG-FR-04, PRD-NF-06); the next read rebuilds again.
    }

    return {
      state,
      source: "rebuilt",
      reason: cache.status === "missing" ? "missing" : "invalid",
      persisted,
    };
  }

  /** Parses the cache without rebuilding; `undefined` when absent or unusable. */
  readCache(): AppState | undefined {
    const cache = readStateText(this.statePath);
    return cache.status === "ok"
      ? parseStateDocument(cache.text, this.#name(), this.now())
      : undefined;
  }

  /** Rebuilds state from the directory and runtime without persisting it. */
  rebuild(options: StateLoadOptions = {}): AppState {
    return this.rebuildState(options, this.now());
  }

  /**
   * Atomically replaces `state.json`. The directory name and schema version
   * are normalized here, so a caller cannot cache a stale name or version.
   */
  write(state: AppState, options: Pick<AtomicWriteOptions, "beforeRename"> = {}): AppState {
    this.assertAppDirectory();
    const now = this.now();
    const normalized = normalizeState(state, this.#name(), now);
    const contents = `${JSON.stringify(normalized, null, 2)}\n`;
    const atomic = this.#atomicOptions(options.beforeRename);

    writeFileAtomic(this.statePath, contents, atomic);
    return normalized;
  }

  /**
   * Merges a patch into the current state (cache or rebuild), stamps
   * `updatedAt`, and persists it. Providing a health status without a
   * `checkedAt` stamps the observation time.
   */
  update(patch: AppStatePatch, options: StateLoadOptions = {}): AppState {
    const now = this.now();
    const current = this.currentState(options, now);

    const images: AppStateImages = {
      current:
        patch.images?.current === undefined
          ? current.images.current
          : stringOrNull(patch.images.current),
      previous:
        patch.images?.previous === undefined
          ? current.images.previous
          : stringOrNull(patch.images.previous),
    };

    const containerId =
      patch.containerId === undefined ? current.containerId : stringOrNull(patch.containerId);

    const health: AppStateHealth = {
      status:
        patch.health?.status === undefined
          ? current.health.status
          : healthStatusOf(patch.health.status),
      checkedAt:
        patch.health?.checkedAt === undefined
          ? current.health.checkedAt
          : timestampOrNull(patch.health.checkedAt),
      detail:
        patch.health?.detail === undefined
          ? current.health.detail
          : stringOrNull(patch.health.detail),
    };

    if (patch.health?.status !== undefined && patch.health.checkedAt === undefined) {
      health.checkedAt = now.toISOString();
    }

    return this.write(
      { ...current, images, containerId, health, updatedAt: now.toISOString() },
      this.#atomicOptions(options.beforeRename),
    );
  }

  /** Discards the cache and rebuilds it, persisting the result. */
  reset(options: StateLoadOptions = {}): AppState {
    const now = this.now();
    const state = this.rebuildState(options, now);
    return this.write(state, this.#atomicOptions(options.beforeRename));
  }

  private currentState(options: StateLoadOptions, now: Date): AppState {
    const cache = readStateText(this.statePath);

    if (cache.status === "ok") {
      const cached = parseStateDocument(cache.text, this.#name(), now);
      if (cached !== undefined) {
        return cached;
      }
    }

    return this.rebuildState(options, now);
  }

  private rebuildState(options: StateLoadOptions, now: Date): AppState {
    this.assertAppDirectory();

    const snapshot = options.runtime ?? this.#runtime?.(this.appDir);
    const config = statIfPresent(path.join(this.appDir, CONFIG_FILE_NAME));
    const createdAt =
      isoFromMilliseconds(config?.birthtimeMs) ??
      isoFromMilliseconds(config?.mtimeMs) ??
      now.toISOString();

    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      name: this.#name(),
      images: {
        current: stringOrNull(snapshot?.images?.current),
        previous: stringOrNull(snapshot?.images?.previous),
      },
      containerId: stringOrNull(snapshot?.containerId),
      health: {
        status: healthStatusOf(snapshot?.health?.status),
        checkedAt: timestampOrNull(snapshot?.health?.checkedAt),
        detail: stringOrNull(snapshot?.health?.detail),
      },
      createdAt,
      updatedAt: now.toISOString(),
    };
  }

  private assertAppDirectory(): void {
    const stats = statIfPresent(this.appDir);

    if (stats === undefined || !stats.isDirectory()) {
      throw new NotFoundError(`app directory "${this.appDir}" was not found`, {
        code: "APP_NOT_FOUND",
        details: { directory: this.appDir },
        remediation: `Run "easy-host list" to see existing apps.`,
      });
    }
  }

  private now(): Date {
    return this.#clock();
  }

  #name(): string {
    return path.basename(this.appDir);
  }

  #atomicOptions(override: BeforeRenameHook | undefined): AtomicWriteOptions {
    const beforeRename = override ?? this.#beforeRename;
    return {
      mode: STATE_FILE_MODE,
      ...(beforeRename === undefined ? {} : { beforeRename }),
    };
  }
}

/**
 * True for the ISO 8601 UTC timestamps the cache contract requires. A value
 * with an offset or a bare date is refused so output stays unambiguous.
 */
export function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

type CacheText = { status: "ok"; text: string } | { status: "missing" } | { status: "invalid" };

function readStateText(statePath: string): CacheText {
  try {
    return { status: "ok", text: readFileSync(statePath, "utf8") };
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return { status: "missing" };
    }

    // An unreadable or non-regular cache is treated as invalid, not fatal: the
    // app remains usable (REG-FR-04).
    return { status: "invalid" };
  }
}

/**
 * Lenient parser. A document is only unusable when it is not a JSON object or
 * carries a different `schemaVersion`; everything else is salvaged, because a
 * cache that is partially readable is still better than no history at all.
 */
function parseStateDocument(text: string, name: string, now: Date): AppState | undefined {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  const record = asRecord(value);
  if (record === undefined || record.schemaVersion !== STATE_SCHEMA_VERSION) {
    return undefined;
  }

  return coerceState(record, name, now);
}

function coerceState(value: Record<string, unknown>, name: string, now: Date): AppState {
  const images = asRecord(value.images);
  const health = asRecord(value.health);

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    name,
    images: {
      current: stringOrNull(images?.current),
      previous: stringOrNull(images?.previous),
    },
    containerId: stringOrNull(value.containerId),
    health: {
      status: healthStatusOf(health?.status),
      checkedAt: timestampOrNull(health?.checkedAt),
      detail: stringOrNull(health?.detail),
    },
    createdAt: timestampOrNull(value.createdAt) ?? now.toISOString(),
    updatedAt: timestampOrNull(value.updatedAt) ?? now.toISOString(),
  };
}

function normalizeState(state: AppState, name: string, now: Date): AppState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    name,
    images: {
      current: stringOrNull(state.images.current),
      previous: stringOrNull(state.images.previous),
    },
    containerId: stringOrNull(state.containerId),
    health: {
      status: healthStatusOf(state.health.status),
      checkedAt: timestampOrNull(state.health.checkedAt),
      detail: stringOrNull(state.health.detail),
    },
    createdAt: timestampOrNull(state.createdAt) ?? now.toISOString(),
    updatedAt: timestampOrNull(state.updatedAt) ?? now.toISOString(),
  };
}

function healthStatusOf(value: unknown): HealthStatus {
  return value === "healthy" || value === "unhealthy" ? value : "unknown";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestampOrNull(value: unknown): string | null {
  return isIsoTimestamp(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isoFromMilliseconds(value: number | bigint | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return undefined;
  }

  return new Date(milliseconds).toISOString();
}

function statIfPresent(target: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(target);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return undefined;
    }

    throw error;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
