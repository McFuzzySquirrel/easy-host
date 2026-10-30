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
 * Output is deliberately plain text. The module emits no ANSI escapes at all,
 * which satisfies `PRD-ACC-02` for both a TTY with `NO_COLOR` set and a
 * non-TTY pipe. Status meaning is carried by a text label, never by colour
 * (`PRD-ACC-01`).
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
import { type AppState, StateStore } from "../../registry/state.js";
import { type AppListEntry, type AppRecord, Registry } from "../../registry/store.js";
import {
  type EasyHostError,
  EXIT_CODES,
  type ExitCode,
  NotFoundError,
  REDACTED,
} from "../errors.js";

/** A writable stream, narrowed so tests can inject a recorder. */
export interface ReadOutputStream {
  write(chunk: string): unknown;
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

/** A text status derived from the cached health and the live container. */
export type AppStatusLabel = "healthy" | "unhealthy" | "stopped" | "missing" | "unknown" | "broken";

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
  const cached = store.readCache();
  if (cached !== undefined) {
    return cached;
  }

  const rebuilt = store.rebuild();
  // A cache-less app has never recorded an update. `rebuild` stamps `now` as
  // `updatedAt` for its own bookkeeping, so display the config's creation time
  // instead of pretending the app was just updated.
  return { ...rebuilt, updatedAt: rebuilt.createdAt };
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
      error: entry.error,
    };
  }

  const state = readAppState(dependencies.stateStore(entry.directory));
  const container = await inspectAppContainer(dependencies.runtime, entry.name);

  return {
    name: entry.name,
    status: statusLabel(container, state),
    entry,
    spec: entry.spec,
    state,
    container,
    error: undefined,
  };
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
 * A JSON-safe spec projection with every `[env]` value replaced by the stable
 * redaction marker. Variable names remain visible; values never do
 * (`PRD-NF-10`).
 */
export function redactedSpec(spec: AppSpec): Record<string, unknown> {
  const env: Record<string, string> = {};
  for (const name of Object.keys(spec.env)) {
    env[name] = REDACTED;
  }

  return { ...spec, env };
}

/** The fixed label column used by `status` and `config` output. */
const FIELD_LABEL_WIDTH = 11;

/** The maximum line width for human output (`PRD-ACC-03`). */
export const READ_OUTPUT_WIDTH = 80;

/**
 * Wraps `value` to `width` columns. It never returns a line wider than the
 * width, splitting a long unbroken token as a last resort.
 */
export function wrapText(value: string, width: number): string[] {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length === 0) {
    return ["-"];
  }

  const limit = Math.max(1, Math.trunc(width));
  const lines: string[] = [];
  let current = "";

  for (const word of clean.split(" ")) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }

    while (current.length > limit) {
      lines.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

/**
 * Renders one `label: value` field, wrapping the value and aligning any
 * continuation lines under the first character of the value.
 */
export function formatField(label: string, value: string, indent = 2): string[] {
  const prefix = `${" ".repeat(indent)}${label}:`.padEnd(indent + FIELD_LABEL_WIDTH);
  const width = Math.max(12, READ_OUTPUT_WIDTH - prefix.length);
  const wrapped = wrapText(value.length === 0 ? "-" : value, width);

  return wrapped.map((line, index) =>
    index === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`,
  );
}

/** One table column: header, minimum width, and whether it may shrink. */
export interface TableColumn {
  readonly header: string;
  readonly minWidth: number;
  readonly shrink: boolean;
}

/**
 * Renders an aligned table that fits {@link READ_OUTPUT_WIDTH}. Shrinkable
 * columns give up width first; the full value remains available in `status`.
 */
export function formatTable(
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
): string[] {
  const widths = columns.map((column, index) => {
    const cells = rows.map((row) => (row[index] ?? "").length);
    return Math.max(column.header.length, column.minWidth, ...cells);
  });

  const separators = Math.max(0, columns.length - 1);
  const available = READ_OUTPUT_WIDTH - separators * 2;
  let total = widths.reduce((sum, width) => sum + width, 0);

  while (total > available) {
    let candidate = -1;

    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const width = widths[index];
      if (column === undefined || width === undefined) {
        continue;
      }

      if (!column.shrink || width <= column.minWidth) {
        continue;
      }

      const candidateWidth = candidate < 0 ? undefined : widths[candidate];
      if (candidate < 0 || (candidateWidth !== undefined && width > candidateWidth)) {
        candidate = index;
      }
    }

    if (candidate < 0) {
      break;
    }

    const width = widths[candidate];
    if (width === undefined) {
      break;
    }

    widths[candidate] = width - 1;
    total -= 1;
  }

  const render = (cells: readonly string[]): string => {
    return columns
      .map((_column, index) => fitCell(cells[index] ?? "", widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  };

  return [render(columns.map((column) => column.header)), ...rows.map((row) => render(row))];
}

function fitCell(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (value.length <= width) {
    return value.padEnd(width);
  }

  if (width === 1) {
    return value.slice(0, 1);
  }

  return `${value.slice(0, width - 1)}…`;
}

/** The canonical container name for an app, exposed for status rendering. */
export { containerName };

/** The dimensions of the `list` table, from PRD 12.2. */
export const LIST_TABLE_COLUMNS: readonly TableColumn[] = [
  { header: "NAME", minWidth: 6, shrink: true },
  { header: "STATUS", minWidth: 9, shrink: false },
  { header: "PORT", minWidth: 5, shrink: false },
  { header: "REF", minWidth: 4, shrink: true },
  { header: "UPDATED", minWidth: 16, shrink: false },
  { header: "IMAGE", minWidth: 8, shrink: true },
];
