/**
 * Update diff classification (UPD-FR-01).
 *
 * `update` must decide, before it touches anything, whether an app needs a
 * full image rebuild, a cheap container recreate, or no work at all. This
 * module owns that decision and nothing else:
 *
 * - **rebuild** — the repository, ref, or local path changed, `--rebuild` was
 *   passed, the recorded state is missing or inconsistent, or the two specs
 *   differ in a way this module does not understand;
 * - **config-only** — only `env`, secrets, `env_file`, `bind`, the host or
 *   container port, health settings, or volumes changed, and the recorded
 *   current image can be reused;
 * - **no-op** — nothing changed and the recorded, live, and health facts all
 *   agree that the app is serving.
 *
 * The diff is pure. It receives the persisted config, the desired config, the
 * cached state, a live container observation, and an optional environment
 * snapshot. It reads no files, invokes no process, mutates no input, and never
 * writes `state.json` (`PRD-NF-06`). Callers own the I/O and pass the results
 * in; the update orchestrator can therefore classify before it takes a lock or
 * changes a container.
 *
 * Secret safety: `env` values and environment-snapshot values are compared but
 * never copied into the result. An environment change is reported by variable
 * name only, so a secret-file edit stays visible in the plan without leaking a
 * value (`PRD-NF-10`).
 */

import type { AppSpec } from "../config/schema.js";
import type { HealthStatus } from "../registry/state.js";

/** The three documented outcomes of an update classification. */
export const UPDATE_DIFF_KINDS = ["no-op", "config-only", "rebuild"] as const;

export type UpdateDiffKind = (typeof UPDATE_DIFF_KINDS)[number];

/**
 * Fields whose change invalidates the built workspace. A repository, ref, or
 * local-path edit means the bytes behind the image are different, so the image
 * must be rebuilt (`UPD-FR-01`).
 */
export const REBUILD_CONFIG_FIELDS = ["local_path", "ref", "repo"] as const;

/**
 * Fields that only affect how an existing image is run. Changing any of them
 * recreates the container on the same image without invoking Railpack or
 * BuildKit (`UPD-FR-01`, `UPD-FR-05`).
 */
export const CONFIG_ONLY_CONFIG_FIELDS = [
  "bind",
  "container_port",
  "env",
  "env_file",
  "health_interval_ms",
  "health_path",
  "health_startup_ms",
  "health_timeout_ms",
  "port",
  "probe",
  "volumes",
] as const;

const REBUILD_FIELD_SET: ReadonlySet<string> = new Set(REBUILD_CONFIG_FIELDS);
const CONFIG_ONLY_FIELD_SET: ReadonlySet<string> = new Set(CONFIG_ONLY_CONFIG_FIELDS);

/**
 * The live container facts the classification needs. `ContainerInspect` from
 * the Podman adapter satisfies this shape, so the update command can pass the
 * inspect result without an adapter import.
 */
export interface UpdateContainerObservation {
  readonly state: { readonly running: boolean };
  /** Running image reference. Omit or set `null` when the runtime cannot tell. */
  readonly image?: string | null;
}

/**
 * The cached facts the classification needs. `AppState` satisfies this shape;
 * tests and callers that only have a partial cache can pass a narrow object.
 */
export interface UpdateRecordedState {
  readonly images: {
    readonly current: string | null;
    readonly previous: string | null;
  };
  readonly health: { readonly status: HealthStatus };
}

/**
 * The merged container environment on each side of the update.
 *
 * Supplying this snapshot lets the diff notice a secrets-file edit that leaves
 * `config.toml` unchanged. Values are compared in memory and never rendered;
 * only variable names appear in {@link UpdateChange}. If one side is omitted
 * the environment cannot be compared, which is an unknown difference and
 * therefore a rebuild.
 */
export interface UpdateEnvironmentSnapshot {
  readonly current?: Readonly<Record<string, string>> | undefined;
  readonly desired?: Readonly<Record<string, string>> | undefined;
}

/** Everything the classifier needs. All inputs are read-only. */
export interface UpdateDiffInput {
  /** The config currently persisted in `config.toml`. */
  readonly current: AppSpec;
  /** The config the operator wants to run. */
  readonly desired: AppSpec;
  /** The cached state, or `null`/omitted when `state.json` is missing. */
  readonly state?: UpdateRecordedState | null;
  /** The live container, or `null`/omitted when it does not exist. */
  readonly container?: UpdateContainerObservation | null;
  /** Optional merged-environment snapshots used to detect secret changes. */
  readonly environment?: UpdateEnvironmentSnapshot;
  /** `update --rebuild`: force a build even when the diff says otherwise. */
  readonly rebuild?: boolean;
}

/** One detected difference and the class it forces. */
export interface UpdateChange {
  /** Config key, `environment.<NAME>`, or an unknown key found at runtime. */
  readonly field: string;
  /** The class this single difference requires. */
  readonly kind: Exclude<UpdateDiffKind, "no-op">;
  /** Secret-free explanation for command output. */
  readonly reason: string;
}

/** Live container presence, reduced to the three states the diff distinguishes. */
export type UpdateContainerStatus = "running" | "stopped" | "missing";

/** Whether a usable state cache was supplied. */
export type UpdateStateStatus = "present" | "missing";

/** The classification result consumed by the update orchestrator. */
export interface UpdateDiff {
  readonly kind: UpdateDiffKind;
  /** Every detected difference, in deterministic field-name order. */
  readonly changes: readonly UpdateChange[];
  /** True when `--rebuild` forced the rebuild outcome. */
  readonly forced: boolean;
  /** One-line explanation suitable for command output. */
  readonly reason: string;
  /** Live/recorded facts that influenced the classification. */
  readonly notes: readonly string[];
  /** Image recorded as current, or `null` when state is missing. */
  readonly currentImage: string | null;
  /** Image recorded as the rollback target, or `null`. */
  readonly previousImage: string | null;
  readonly container: UpdateContainerStatus;
  readonly state: UpdateStateStatus;
  /** Recorded health, or `null` when state is missing. */
  readonly recordedHealth: HealthStatus | null;
}

type FieldShape = "string" | "number" | "string-map";

const CONFIG_FIELD_SHAPES: Readonly<Record<string, FieldShape>> = {
  repo: "string",
  local_path: "string",
  ref: "string",
  port: "number",
  container_port: "number",
  bind: "string",
  probe: "string",
  health_path: "string",
  health_interval_ms: "number",
  health_timeout_ms: "number",
  health_startup_ms: "number",
  env_file: "string",
  volumes: "string-map",
  env: "string-map",
};

/**
 * Classifies an update without performing any I/O or mutation.
 *
 * Precedence matters and is deliberate:
 *
 * 1. `--rebuild` always wins;
 * 2. unknown or rebuild-triggering config fields win over a cheap recreate;
 * 3. a missing state cache or missing current image is an unknown difference
 *    and therefore a rebuild — `state.json` must never produce a false no-op;
 * 4. recorded/running image drift is an unknown difference and a rebuild;
 * 5. config-only changes recreate the recorded image;
 * 6. with no config changes, a missing/stopped/unhealthy container is repaired
 *    by recreating the recorded image, and only a running, healthy app whose
 *    image matches the cache is a no-op.
 */
export function classifyUpdate(input: UpdateDiffInput): UpdateDiff {
  const state = input.state ?? null;
  const container = input.container ?? null;
  const stateStatus: UpdateStateStatus = state === null ? "missing" : "present";
  const containerStatus: UpdateContainerStatus =
    container === null ? "missing" : container.state.running ? "running" : "stopped";
  const currentImage = state?.images.current ?? null;
  const previousImage = state?.images.previous ?? null;
  const recordedHealth = state?.health.status ?? null;
  const forced = input.rebuild === true;

  const changes = configChanges(input.current, input.desired);
  if (input.environment !== undefined) {
    changes.push(...environmentChanges(input.environment));
  }

  const finish = (
    kind: UpdateDiffKind,
    reason: string,
    notes: readonly string[] = [],
  ): UpdateDiff => ({
    kind,
    changes,
    forced,
    reason,
    notes,
    currentImage,
    previousImage,
    container: containerStatus,
    state: stateStatus,
    recordedHealth,
  });

  if (forced) {
    return finish(
      "rebuild",
      changes.length === 0
        ? "rebuild forced by --rebuild; no configuration changes were detected"
        : "rebuild forced by --rebuild; detected changes are reported separately",
    );
  }

  const rebuildChanges = changes.filter((change) => change.kind === "rebuild");
  if (rebuildChanges.length > 0) {
    return finish("rebuild", `rebuild required: ${fieldList(rebuildChanges)}`);
  }

  if (state === null) {
    return finish("rebuild", "rebuild required: state.json is missing", [
      "state.json is missing, so the recorded current image, rollback image, and health cannot be verified; a rebuild records them again",
    ]);
  }

  if (currentImage === null) {
    return finish("rebuild", "rebuild required: state.json records no current image", [
      "the state cache has no current image reference, so there is no image to recreate the container from",
    ]);
  }

  if (isImageDrift(container, currentImage)) {
    const running = (container as UpdateContainerObservation).image as string;
    return finish(
      "rebuild",
      `rebuild required: the running container uses ${running} but state.json records ${currentImage}`,
      [
        "recorded state and runtime reality disagree; a rebuild produces a new image and records it as current",
      ],
    );
  }

  if (changes.length > 0) {
    return finish("config-only", `config-only update: ${fieldList(changes)}`);
  }

  if (containerStatus === "missing") {
    return finish(
      "config-only",
      "config-only update: the container is missing and will be recreated from the recorded image",
      [`no image rebuild is needed; the recorded current image is ${currentImage}`],
    );
  }

  if (containerStatus === "stopped") {
    return finish(
      "config-only",
      "config-only update: the container is not running and will be recreated from the recorded image",
      [`no image rebuild is needed; the recorded current image is ${currentImage}`],
    );
  }

  if (recordedHealth !== "healthy") {
    return finish(
      "config-only",
      `config-only update: recorded health is ${recordedHealth ?? "unknown"} and the container will be recreated`,
      [`no image rebuild is needed; the recorded current image is ${currentImage}`],
    );
  }

  return finish(
    "no-op",
    "nothing changed: configuration and state match and the app is running and healthy",
  );
}

/**
 * True when a running container reports a different image from the one the
 * cache records. A container without an image reference cannot prove drift, so
 * it is left to the recorded health check.
 */
function isImageDrift(container: UpdateContainerObservation | null, currentImage: string): boolean {
  if (container === null || container.image === undefined || container.image === null) {
    return false;
  }

  return container.image.length > 0 && container.image !== currentImage;
}

function configChanges(current: AppSpec, desired: AppSpec): UpdateChange[] {
  const before = current as unknown as Readonly<Record<string, unknown>>;
  const after = desired as unknown as Readonly<Record<string, unknown>>;
  const changes: UpdateChange[] = [];

  for (const field of fieldNames(before, after)) {
    const kind = fieldKind(field);

    if (kind === undefined) {
      changes.push({
        field,
        kind: "rebuild",
        reason: `unknown configuration field "${field}"; assuming a rebuild`,
      });
      continue;
    }

    const previous = before[field];
    const next = after[field];

    if (valuesEqual(previous, next)) {
      continue;
    }

    const shape = CONFIG_FIELD_SHAPES[field];
    if (shape === undefined || !matchesShape(previous, shape) || !matchesShape(next, shape)) {
      changes.push({
        field,
        kind: "rebuild",
        reason: `unexpected value shape for "${field}"; assuming a rebuild`,
      });
      continue;
    }

    changes.push({ field, kind, reason: changeReason(field, kind) });
  }

  return changes;
}

function environmentChanges(snapshot: UpdateEnvironmentSnapshot): UpdateChange[] {
  const { current, desired } = snapshot;

  if (current === undefined || desired === undefined) {
    return [
      {
        field: "environment",
        kind: "rebuild",
        reason:
          "the environment snapshot is incomplete, so secret-file changes cannot be verified; assuming a rebuild",
      },
    ];
  }

  const changes: UpdateChange[] = [];
  for (const name of sortedNames(current, desired)) {
    if (Object.is(current[name], desired[name])) {
      continue;
    }

    changes.push({
      field: `environment.${name}`,
      kind: "config-only",
      // Only the variable name is rendered; the value stays out of the result.
      reason: `environment variable "${name}" changed; the container is recreated without a build`,
    });
  }

  return changes;
}

function fieldKind(field: string): Exclude<UpdateDiffKind, "no-op"> | undefined {
  if (REBUILD_FIELD_SET.has(field)) {
    return "rebuild";
  }

  if (CONFIG_ONLY_FIELD_SET.has(field)) {
    return "config-only";
  }

  return undefined;
}

function changeReason(field: string, kind: Exclude<UpdateDiffKind, "no-op">): string {
  if (kind === "rebuild") {
    return `${field} changed; an image rebuild is required`;
  }

  if (field === "env" || field === "env_file") {
    return `${field} changed; the container is recreated without a build`;
  }

  return `${field} changed; the container is recreated without a build`;
}

function matchesShape(value: unknown, shape: FieldShape): boolean {
  if (value === undefined) {
    return true;
  }

  switch (shape) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string-map":
      return isStringMap(value);
  }
}

function isStringMap(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Structural equality for config values. `env` and `volumes` are maps, so key
 * order must not count as a change; arrays and nested objects are handled for
 * forward compatibility even though the current schema has none.
 */
function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((entry, index) => valuesEqual(entry, right[index]))
    );
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]))
    );
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldNames(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
}

function sortedNames(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
}

function fieldList(changes: readonly UpdateChange[]): string {
  return changes.map((change) => change.field).join(", ");
}
