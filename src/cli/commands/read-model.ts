/**
 * Shared read-only model for `list`, `status`, and `config`.
 *
 * The three read commands answer the same underlying question — what is
 * recorded, what is configured, and what is actually running — so the scan,
 * the container inspection, the cache read, and the plain-text renderers live
 * here instead of being copied into each handler.
 *
 * Every helper is read-only. The state cache is read with
 * {@link StateStore.readCache} and only rebuilt in memory when it is missing or
 * stale; this module never calls {@link StateStore.load}, {@link
 * StateStore.update}, or {@link StateStore.reset}, so a read command cannot
 * create or modify `state.json` (`ADD-FR-06` read-only constraint).
 *
 * Output is deliberately plain text unless `src/cli/format.ts` decides the
 * terminal can render colour. This module emits no ANSI escapes itself, which
 * satisfies `PRD-ACC-02` for both a TTY with `NO_COLOR` set and a non-TTY pipe.
 * Status meaning is carried by a text label, never by colour (`PRD-ACC-01`).
 */

import type { AppSpec } from "../../config/schema.js";
import { formatProbeTarget } from "../../health/probe.js";
import { createPaths, type Paths } from "../../platform/paths.js";
import {
  type ContainerInspect,
  type ContainerPortBinding,
  containerName,
  inspectContainer as inspectWithPodman,
  volumeName,
} from "../../platform/podman.js";
import {
  type DriftObservation,
  type DriftReport,
  detectDrift,
  uncheckedDrift,
} from "../../registry/drift.js";
import { type AppState, StateStore } from "../../registry/state.js";
import { type AppListEntry, type AppRecord, Registry } from "../../registry/store.js";
import {
  type EasyHostError,
  EXIT_CODES,
  type ExitCode,
  NotFoundError,
  toEasyHostError,
} from "../errors.js";
import type { TableColumn } from "../format.js";
import type { AppStatusLabel } from "../schemas.js";

export type { AppStatusLabel };

/** A writable stream, narrowed so tests can inject a recorder. */
export interface ReadOutputStream {
  write(chunk: string): unknown;
  /** Present on a real terminal; a pipe or recorder leaves it undefined. */
  readonly isTTY?: boolean;
}

/** The container operations the read commands need. */
export interface ReadRuntime {
  inspectContainer(options: { readonly app: string }): Promise<ContainerInspect>;
}

/**
 * The registry operations the read commands need. The filesystem-backed
 * {@link Registry} satisfies this interface.
 */
export interface ReadRegistry {
  list(): readonly AppListEntry[];
  record(name: string): AppRecord;
  readConfig(name: string): AppSpec;
}

/** Optional dependencies used by every read command. */
export interface ReadDependencyOverrides {
  /** Environment used for the state root and diagnostics. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Overrides the state-root layout, for tests and embedders. */
  readonly paths?: Pick<Paths, "root" | "appsDir">;
  /** Overrides the registry, for tests. */
  readonly registry?: ReadRegistry;
  /** Overrides the container runtime, for tests. */
  readonly runtime?: ReadRuntime;
  /** Builds the state cache reader for one app directory. */
  readonly stateStore?: (appDir: string) => StateStore;
  /** Clock used only when the cache has to be rebuilt in memory. */
  readonly clock?: () => Date;
}

/** Fully resolved dependencies. */
export interface ReadDependencies {
  readonly environment: NodeJS.ProcessEnv;
  readonly paths: Pick<Paths, "root" | "appsDir">;
  readonly registry: ReadRegistry;
  readonly runtime: ReadRuntime;
  readonly stateStore: (appDir: string) => StateStore;
  readonly clock: () => Date;
}

/** One app's read-only snapshot. */
export interface AppRow {
  readonly name: string;
  readonly status: AppStatusLabel;
  readonly entry: AppListEntry;
  /** Present for a healthy config; absent for a broken entry. */
  readonly spec: AppSpec | undefined;
  /** Present when the cache or an in-memory rebuild produced state. */
  readonly state: AppState | undefined;
  /** Absent when the container is missing or the entry is broken. */
  readonly container: ContainerInspect | undefined;
  /** Read-only drift classification for this row. */
  readonly drift: DriftReport;
  /**
   * Present when Podman inspect failed for a reason other than an absent
   * container. The row is then `unknown`, never `healthy` (`OBS-FR-03`).
   */
  readonly inspectionError: EasyHostError | undefined;
  /** Present for a broken entry; every other row carries `undefined`. */
  readonly error: EasyHostError | undefined;
}

const DEFAULT_READ_RUNTIME: ReadRuntime = {
  inspectContainer: (options) => inspectWithPodman(options),
};

/**
 * Resolves the read dependencies. Construction performs no I/O: creating
 * `Paths` only computes strings and the registry constructor is lazy.
 */
export function resolveReadDependencies(overrides: ReadDependencyOverrides = {}): ReadDependencies {
  const environment = overrides.environment ?? process.env;
  const paths = overrides.paths ?? createPaths({ env: environment });
  const clock = overrides.clock ?? (() => new Date());

  return {
    environment,
    paths,
    registry: overrides.registry ?? new Registry(paths.appsDir),
    runtime: overrides.runtime ?? DEFAULT_READ_RUNTIME,
    stateStore: overrides.stateStore ?? ((appDir: string) => new StateStore(appDir, { clock })),
    clock,
  };
}

/**
 * Reads the cache without ever persisting a rebuild. A missing or invalid
 * cache is rebuilt in memory from the directory and timestamps, so `list` and
 * `status` show a useful last-update value without mutating the app.
 */
export function readAppState(store: StateStore): AppState {
  return readAppStateRecord(store).state;
}

/** A state read plus whether it came from the cache or an in-memory rebuild. */
export interface ReadAppStateResult {
  readonly state: AppState;
  /** `rebuilt` means `state.json` was absent or unusable. */
  readonly source: "cache" | "rebuilt";
}

/**
 * The presence-aware form used by drift detection. A rebuilt state is useful
 * for display but is not recorded history, so drift must treat it as absent
 * (`PRD-NF-06`).
 */
export function readAppStateRecord(store: StateStore): ReadAppStateResult {
  const cached = store.readCache();
  if (cached !== undefined) {
    return { state: cached, source: "cache" };
  }

  const rebuilt = store.rebuild();
  // A cache-less app has never recorded an update. `rebuild` stamps `now` as
  // `updatedAt` for its own bookkeeping, so display the config's creation time
  // instead of pretending the app was just updated.
  return { state: { ...rebuilt, updatedAt: rebuilt.createdAt }, source: "rebuilt" };
}

/** Inspects one app container, treating a missing container as `undefined`. */
export async function inspectAppContainer(
  runtime: ReadRuntime,
  app: string,
): Promise<ContainerInspect | undefined> {
  try {
    return await runtime.inspectContainer({ app });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return undefined;
    }

    throw error;
  }
}

/**
 * Converts a live container and cached state into the documented status label.
 * The order matters: a missing or stopped container is never reported as
 * healthy just because the last probe succeeded.
 */
export function statusLabel(
  container: ContainerInspect | undefined,
  state: AppState | undefined,
): AppStatusLabel {
  if (container === undefined) {
    return "missing";
  }

  if (!container.state.running) {
    return "stopped";
  }

  if (state?.health.status === "unhealthy") {
    return "unhealthy";
  }

  if (state?.health.status === "healthy") {
    return "healthy";
  }

  return "unknown";
}

/** The documented exit code for one app's status. */
export function statusExitCode(status: AppStatusLabel): ExitCode {
  return status === "healthy" || status === "unknown" ? EXIT_CODES.SUCCESS : EXIT_CODES.HEALTH;
}

/**
 * Collects one row per registry entry, in registry (name-sorted) order.
 * Container inspection is sequential and bounded by the platform adapter's
 * own timeout, which keeps the command well inside the read budget for a
 * normal registry (`PRD-NF-01`).
 */
export async function collectAppRows(
  entries: readonly AppListEntry[],
  dependencies: ReadDependencies,
): Promise<AppRow[]> {
  const rows: AppRow[] = [];

  for (const entry of entries) {
    rows.push(await collectAppRow(entry, dependencies));
  }

  return rows;
}

/** Collects the read-only snapshot for one registry entry. */
export async function collectAppRow(
  entry: AppListEntry,
  dependencies: ReadDependencies,
): Promise<AppRow> {
  if (entry.status === "broken") {
    // A broken entry has no trustworthy app name (it may be a symlink or an
    // invalid directory name), so it is never handed to Podman.
    return {
      name: entry.name,
      status: "broken",
      entry,
      spec: undefined,
      state: undefined,
      container: undefined,
      drift: uncheckedDrift(entry.name, "the app directory has no valid config.toml"),
      inspectionError: undefined,
      error: entry.error,
    };
  }

  const record = readAppStateRecord(dependencies.stateStore(entry.directory));
  const inspected = await inspectForRow(entry.name, dependencies.runtime);

  return {
    name: entry.name,
    // A failed inspect is an unknown environment, never a serving app.
    status:
      inspected.error === undefined ? statusLabel(inspected.container, record.state) : "unknown",
    entry,
    spec: entry.spec,
    state: record.state,
    container: inspected.container,
    drift: detectDrift({
      app: entry.name,
      // A rebuilt cache is display-only: drift must not treat it as history.
      state: record.source === "cache" ? record.state : null,
      observation: inspected.observation,
    }),
    inspectionError: inspected.error,
    error: undefined,
  };
}

interface InspectedRow {
  readonly container: ContainerInspect | undefined;
  readonly observation: DriftObservation;
  readonly error: EasyHostError | undefined;
}

/**
 * Inspects one container without letting a Podman failure abort a read
 * command. An absent container is a normal `missing` observation; any other
 * failure is kept as a typed error and reported as `unknown` drift.
 */
async function inspectForRow(app: string, runtime: ReadRuntime): Promise<InspectedRow> {
  try {
    const container = await runtime.inspectContainer({ app });
    return {
      container,
      observation: {
        status: "observed",
        container: {
          id: container.id,
          image: container.image,
          running: container.state.running,
          state: container.state.status,
          exitCode: container.state.exitCode,
        },
      },
      error: undefined,
    };
  } catch (caught) {
    const error = toEasyHostError(caught);

    if (error instanceof NotFoundError) {
      return { container: undefined, observation: { status: "missing" }, error: undefined };
    }

    return {
      container: undefined,
      observation: { status: "failed", reason: error.message, code: error.code },
      error,
    };
  }
}

/**
 * A readable one-line drift description for human output. The class label is
 * always present so meaning never depends on colour (`PRD-ACC-01`).
 */
export function driftDescription(report: DriftReport): string {
  return report.drift === "none" ? "none" : `${report.drift} (${report.summary})`;
}

/**
 * The short image label shown in the list table. The full reference is always
 * available in `status`; the table keeps the tag so a row stays narrow
 * (`PRD-ACC-03`).
 */
export function shortImage(image: string | null | undefined): string {
  if (image === null || image === undefined || image.length === 0) {
    return "-";
  }

  const withoutDigest = image.includes("@") ? (image.split("@")[0] ?? image) : image;
  const lastSegment = withoutDigest.slice(withoutDigest.lastIndexOf("/") + 1);
  const colon = lastSegment.lastIndexOf(":");

  return colon > 0 ? lastSegment.slice(colon + 1) : lastSegment;
}

/** Renders an ISO timestamp as `YYYY-MM-DD HH:MM` in UTC, or `-`. */
export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) {
    return "-";
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return "-";
  }

  return new Date(milliseconds).toISOString().slice(0, 16).replace("T", " ");
}

/** A short container id for human output. */
export function shortContainerId(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    return "unknown";
  }

  return value.length > 12 ? value.slice(0, 12) : value;
}

/** A one-line description of where the app source comes from. */
export function sourceDescription(spec: AppSpec): string {
  if (spec.local_path !== undefined) {
    return `local path "${spec.local_path}" (dev-only, used in place)`;
  }

  return `${spec.repo ?? "repository"} at ${spec.ref}`;
}

/** The probe settings rendered for `status`. */
export function probeDescription(spec: AppSpec): string {
  const target = formatProbeTarget(spec.probe, spec.port, spec.health_path);
  const verb = spec.probe === "http" ? "GET" : "connect";

  return `${spec.probe} ${verb} ${target} (interval ${spec.health_interval_ms}ms, timeout ${spec.health_timeout_ms}ms, budget ${spec.health_startup_ms}ms)`;
}

/** Renders published ports as `hostIp:hostPort->containerPort/protocol`. */
export function portsDescription(ports: readonly ContainerPortBinding[]): string {
  if (ports.length === 0) {
    return "none";
  }

  return ports
    .map((binding) => {
      const host = binding.hostIp.length === 0 ? "0.0.0.0" : binding.hostIp;
      return `${host}:${binding.hostPort}->${binding.containerPort}/${binding.protocol}`;
    })
    .join(", ");
}

/**
 * Renders the mounted named volumes. When the container is missing, the
 * declared volumes are shown as declarations so the operator can still see
 * what the app expects.
 */
export function volumesDescription(
  container: ContainerInspect | undefined,
  app: string,
  spec: AppSpec,
): string {
  if (container !== undefined && container.volumes.length > 0) {
    return container.volumes.map((mount) => `${mount.name}:${mount.destination}`).join(", ");
  }

  const declared = Object.keys(spec.volumes);
  if (declared.length === 0) {
    return "none";
  }

  return declared
    .map((volume) => `${volumeName(app, volume)}:${spec.volumes[volume] ?? ""} (declared)`)
    .join(", ");
}

/**
 * Human-output primitives live in `src/cli/format.ts` so `list`, `status`, and
 * `config` share one TTY/`NO_COLOR` decision and one 80-column renderer. The
 * names stay re-exported here because this module is the shared read model and
 * existing importers use it.
 */
export {
  formatField,
  formatTable,
  OUTPUT_WIDTH as READ_OUTPUT_WIDTH,
  type TableColumn,
  type TableRow,
  type TableRowInput,
  wrapText,
} from "../format.js";

/** The canonical container name for an app, exposed for status rendering. */
export { containerName };

/**
 * The dimensions of the `list` table, from PRD 12.2.
 *
 * NAME and PORT never shrink: a long value moves wholesale to a detail line
 * rather than being truncated. REF and IMAGE are optional columns that shrink
 * and, as a last resort, move below the table.
 */
export const LIST_TABLE_COLUMNS: readonly TableColumn[] = [
  { header: "NAME", minWidth: 6, shrink: false },
  { header: "STATUS", minWidth: 9, shrink: false },
  { header: "PORT", minWidth: 5, shrink: false },
  { header: "REF", minWidth: 4, shrink: true, droppable: true },
  { header: "UPDATED", minWidth: 16, shrink: false },
  { header: "IMAGE", minWidth: 8, shrink: true, droppable: true },
];
