/**
 * Drift detection between the recorded state cache and Podman reality
 * (`OBS-FR-03`, `PRD-NF-06`).
 *
 * `state.json` is a cache, not the truth: it records the image pair, the
 * container id from the last successful action, and the last health result.
 * Podman is the live authority. This module compares the two and classifies
 * each divergence as one of the documented classes:
 *
 * - `missing-container` — the container has disappeared;
 * - `stopped-container` — the container exists but is not running;
 * - `image-mismatch` — the container runs an image the cache did not record;
 * - `unhealthy-probe` — the last recorded probe failed;
 * - `none` — recorded state and Podman agree;
 * - `unknown` — Podman could not be inspected, so drift cannot be proven.
 *
 * Detection is pure and read-only. It receives facts; it never reads a file,
 * invokes Podman, takes a lock, or writes `state.json`. A caller that has no
 * cache passes `state: null`: the report then skips comparisons that need
 * recorded history instead of crashing or pretending the app is healthy
 * (`PRD-NF-06`).
 *
 * Each report carries a typed {@link DriftAction} describing what `update`
 * would do about the situation. The recommendation mirrors the update diff
 * (`src/lifecycle/diff.ts`) for the same recorded facts: a running app with
 * matching image and healthy probe is a no-op, a missing/stopped/unhealthy
 * app is recreated from the recorded image (config-only), a different image
 * or a missing cache requires a rebuild, and an inspect failure cannot be
 * classified until the environment is repaired.
 */

import { redactText } from "../cli/errors.js";
import type { HealthStatus } from "./state.js";

/** Every value {@link DriftReport.drift} can take. */
export const DRIFT_CLASSES = [
  "none",
  "missing-container",
  "stopped-container",
  "image-mismatch",
  "unhealthy-probe",
  "unknown",
] as const;

export type DriftClass = (typeof DRIFT_CLASSES)[number];

/** A class that represents proven drift rather than agreement or a blind spot. */
export type DriftIssueClass = Exclude<DriftClass, "none" | "unknown">;

/** What `update` would do, or whether the environment must be repaired first. */
export type DriftActionKind = "no-op" | "config-only" | "rebuild" | "investigate";

/**
 * The recommended follow-up. `command` is an operator-ready command or `null`
 * when no command is needed (`no-op`) or no command can repair the situation.
 * `description` is a complete sentence explaining the effect.
 */
export interface DriftAction {
  readonly kind: DriftActionKind;
  readonly command: string | null;
  readonly description: string;
}

/**
 * The live container facts drift needs. {@link ContainerInspect} from the
 * Podman adapter satisfies this shape structurally, so callers do not need an
 * adapter import here.
 */
export interface DriftContainer {
  readonly id: string;
  readonly image: string;
  readonly running: boolean;
  /** Podman's state string, for example `running` or `exited`. */
  readonly state: string;
  readonly exitCode: number;
}

/**
 * The inspect outcome. `missing` is a container that Podman says does not
 * exist; `failed` is an inspect that could not answer (Podman absent, timeout,
 * malformed output). Keeping them apart is what stops a failed inspect from
 * being reported as healthy or as a missing container.
 */
export type DriftObservation =
  | { readonly status: "observed"; readonly container: DriftContainer }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly reason: string; readonly code?: string };

/**
 * The recorded facts drift reads. {@link AppState} satisfies this shape; tests
 * can pass a narrow literal.
 */
export interface DriftRecordedState {
  readonly images: {
    readonly current: string | null;
    readonly previous: string | null;
  };
  readonly containerId: string | null;
  readonly health: {
    readonly status: HealthStatus;
    readonly checkedAt: string | null;
    readonly detail: string | null;
  };
}

/** One app's inputs. `state` is `null` when `state.json` is absent or unusable. */
export interface DriftInput {
  readonly app: string;
  readonly state: DriftRecordedState | null;
  readonly observation: DriftObservation;
}

/** The typed, read-only drift result consumed by `status`, `list`, and JSON. */
export interface DriftReport {
  readonly app: string;
  /** The most severe class, or `none` when nothing diverged. */
  readonly drift: DriftClass;
  /** True for any non-`none` class, including `unknown` (attention needed). */
  readonly drifted: boolean;
  /** Every proven class, in precedence order (most severe first). */
  readonly classes: readonly DriftIssueClass[];
  /** False when the cache is absent or unusable; comparisons are then skipped. */
  readonly statePresent: boolean;
  readonly recordedImage: string | null;
  /** The live image, or `null` when the container or inspect result is absent. */
  readonly liveImage: string | null;
  /** `null` when it cannot be compared, otherwise whether the ids agree. */
  readonly containerIdMatches: boolean | null;
  /** One sentence naming the divergence, or confirming agreement. */
  readonly summary: string;
  readonly recommendedAction: DriftAction;
  /** Extra facts that do not change the class, such as a stale container id. */
  readonly notes: readonly string[];
}

/** Sentence reused wherever a missing cache changes the comparison. */
const MISSING_STATE_NOTE =
  "state.json is missing, so the recorded image and last probe cannot be compared; the app directory is still authoritative and the cache is rebuildable.";

/**
 * Classifies one app. Never throws for missing state or a failed inspect; both
 * are reported as facts in the result.
 */
export function detectDrift(input: DriftInput): DriftReport {
  const app = input.app;
  const state = input.state;
  const statePresent = state !== null;
  const recordedImage = normalizedOrNull(state?.images.current ?? null);
  const observation = input.observation;

  if (observation.status === "failed") {
    const reason = redactText(observation.reason).trim();
    const detail =
      reason.length > 0 ? `Podman inspect failed: ${reason}` : "Podman inspect failed.";

    return {
      app,
      drift: "unknown",
      drifted: true,
      classes: [],
      statePresent,
      recordedImage,
      liveImage: null,
      containerIdMatches: null,
      summary: `drift could not be determined because ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`,
      recommendedAction: investigateAction(),
      notes: statePresent ? [detail] : [detail, MISSING_STATE_NOTE],
    };
  }

  if (observation.status === "missing") {
    const classes: DriftIssueClass[] = ["missing-container"];
    if (state?.health.status === "unhealthy") {
      classes.push("unhealthy-probe");
    }

    const notes: string[] = [];
    if (!statePresent) {
      notes.push(MISSING_STATE_NOTE);
    }

    return {
      app,
      drift: "missing-container",
      drifted: true,
      classes,
      statePresent,
      recordedImage,
      liveImage: null,
      containerIdMatches:
        state?.containerId === null || state?.containerId === undefined ? null : false,
      summary:
        recordedImage === null
          ? `the container for "${app}" is missing and no recorded image is available`
          : `the container for "${app}" is missing; state.json records ${redactText(recordedImage)}`,
      recommendedAction: recreateOrRebuild(app, recordedImage, "The container is missing."),
      notes,
    };
  }

  const container = observation.container;
  const liveImage = normalizedOrNull(container.image);
  const imageMatches = compareImageReferences(recordedImage, liveImage);
  const containerIdMatches = compareContainerIds(state?.containerId ?? null, container.id);
  const classes: DriftIssueClass[] = [];

  if (!container.running) {
    classes.push("stopped-container");
  }
  if (imageMatches === false) {
    classes.push("image-mismatch");
  }
  if (state?.health.status === "unhealthy") {
    classes.push("unhealthy-probe");
  }

  const drift = classes[0] ?? "none";
  const notes = buildNotes({
    statePresent,
    recordedImage,
    liveImage,
    imageMatches,
    containerIdMatches,
  });

  return {
    app,
    drift,
    drifted: classes.length > 0,
    classes,
    statePresent,
    recordedImage,
    liveImage,
    containerIdMatches,
    summary: liveSummary({
      app,
      state,
      statePresent,
      container,
      recordedImage,
      liveImage,
      classes,
    }),
    recommendedAction: recommendAction(app, drift, classes, recordedImage, state),
    notes,
  };
}

/**
 * Classifies a batch in input order. The helper exists so a command can map
 * registry entries without duplicating the report construction; it performs no
 * I/O and starts no process.
 */
export function collectDriftReports(inputs: readonly DriftInput[]): DriftReport[] {
  return inputs.map(detectDrift);
}

/**
 * A report for an app whose drift was never checked, such as a broken app
 * directory with no parseable `config.toml`. It is deliberately not a clean
 * report: `unknown` means "not verified", never "healthy".
 */
export function uncheckedDrift(app: string, reason: string): DriftReport {
  const detail = redactText(reason).trim();

  return {
    app,
    drift: "unknown",
    drifted: true,
    classes: [],
    statePresent: false,
    recordedImage: null,
    liveImage: null,
    containerIdMatches: null,
    summary: detail.length === 0 ? "drift was not checked" : `drift was not checked: ${detail}`,
    recommendedAction: {
      kind: "investigate",
      command: null,
      description: "Fix the app directory before checking drift.",
    },
    notes: [],
  };
}

/**
 * Compares a recorded image reference with the live one. Returns `null` when
 * the live reference is missing or is a bare image id, because that cannot
 * prove a mismatch. `localhost/` is treated as an equivalent local prefix, so
 * `localhost/easy-host-blog:tag` and `easy-host-blog:tag` agree.
 */
export function compareImageReferences(
  recorded: string | null,
  live: string | null,
): boolean | null {
  if (recorded === null || live === null) {
    return null;
  }

  if (!isNamedImageReference(live)) {
    return null;
  }

  return normalizeImageReference(recorded) === normalizeImageReference(live);
}

/**
 * Compares recorded and live container ids. A full id, or a recorded short id
 * that prefixes the live id, counts as a match; `null` means one side is
 * unavailable and no conclusion can be drawn.
 */
export function compareContainerIds(recorded: string | null, live: string): boolean | null {
  const left = recorded?.trim() ?? "";
  const right = live.trim();

  if (left.length === 0 || right.length === 0) {
    return null;
  }

  if (left === right) {
    return true;
  }

  // Podman sometimes returns a 12-character id where the cache kept the full
  // id (or vice versa). A prefix of at least 12 characters is unambiguous.
  if (left.length >= 12 && right.startsWith(left)) {
    return true;
  }
  if (right.length >= 12 && left.startsWith(right)) {
    return true;
  }

  return false;
}

/** True when a live reference names an image rather than only an image id. */
function isNamedImageReference(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed === "unknown") {
    return false;
  }

  return !trimmed.startsWith("sha256:") && !/^[0-9a-f]{64}$/i.test(trimmed);
}

/** Removes the equivalent local prefix and trims whitespace. */
function normalizeImageReference(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("localhost/") ? trimmed.slice("localhost/".length) : trimmed;
}

function normalizedOrNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

interface NoteInput {
  readonly statePresent: boolean;
  readonly recordedImage: string | null;
  readonly liveImage: string | null;
  readonly imageMatches: boolean | null;
  readonly containerIdMatches: boolean | null;
}

function buildNotes(input: NoteInput): string[] {
  const notes: string[] = [];

  if (!input.statePresent) {
    notes.push(MISSING_STATE_NOTE);
  } else if (input.recordedImage === null) {
    notes.push(
      "state.json records no current image, so the running image cannot be compared; update would rebuild.",
    );
  }

  if (
    input.statePresent &&
    input.recordedImage !== null &&
    input.liveImage !== null &&
    input.imageMatches === null
  ) {
    notes.push(
      `the live image reference ${redactText(input.liveImage)} is an image id, so it cannot be compared with the recorded tag ${redactText(input.recordedImage)}`,
    );
  }

  if (input.containerIdMatches === false) {
    notes.push(
      "the recorded container id does not match the live container; the container was recreated since the last recorded update",
    );
  }

  return notes;
}

interface SummaryInput {
  readonly app: string;
  readonly state: DriftRecordedState | null;
  readonly statePresent: boolean;
  readonly container: DriftContainer;
  readonly recordedImage: string | null;
  readonly liveImage: string | null;
  readonly classes: readonly DriftIssueClass[];
}

function liveSummary(input: SummaryInput): string {
  const primary = input.classes[0];

  if (primary === "stopped-container") {
    const exit = input.container.exitCode === 0 ? "" : `, exit ${input.container.exitCode}`;
    return `the container for "${input.app}" is not running (${input.container.state}${exit})`;
  }

  if (primary === "image-mismatch") {
    return `the running container uses ${redactText(input.liveImage ?? "an unknown image")} but state.json records ${redactText(input.recordedImage ?? "no image")}`;
  }

  if (primary === "unhealthy-probe") {
    const detail = input.state?.health.detail;
    return detail === null || detail === undefined || detail.length === 0
      ? `the last recorded probe for "${input.app}" is unhealthy`
      : `the last recorded probe failed: ${redactText(detail)}`;
  }

  if (!input.statePresent) {
    return "no drift detected in the live container; state.json is missing so cached history cannot be compared";
  }

  const health =
    input.state?.health.status === "unknown"
      ? "no probe result is recorded yet"
      : "the last probe is healthy";

  return `recorded state matches Podman: the container is running ${redactText(input.liveImage ?? "an unnamed image")} and ${health}`;
}

function recreateOrRebuild(
  app: string,
  recordedImage: string | null,
  situation: string,
): DriftAction {
  if (recordedImage !== null) {
    return {
      kind: "config-only",
      command: updateCommand(app),
      description: `${situation} Update recreates the container from the recorded image ${redactText(recordedImage)} without a rebuild.`,
    };
  }

  return {
    kind: "rebuild",
    command: `${updateCommand(app)} --rebuild`,
    description: `${situation} No recorded image is available, so update rebuilds and starts a new image.`,
  };
}

function recommendAction(
  app: string,
  drift: DriftClass,
  classes: readonly DriftIssueClass[],
  recordedImage: string | null,
  state: DriftRecordedState | null,
): DriftAction {
  if (drift === "unknown") {
    return investigateAction();
  }

  // Image drift is the most expensive repair, and update rebuilds for it even
  // when the container is also stopped or the last probe failed.
  if (classes.includes("image-mismatch")) {
    return {
      kind: "rebuild",
      command: `${updateCommand(app)} --rebuild`,
      description:
        "The running image does not match the recorded image, so update rebuilds and swaps it.",
    };
  }

  if (classes.includes("missing-container")) {
    return recreateOrRebuild(app, recordedImage, "The container is missing.");
  }

  if (classes.includes("stopped-container")) {
    return recreateOrRebuild(app, recordedImage, "The container is not running.");
  }

  if (classes.includes("unhealthy-probe")) {
    return recreateOrRebuild(app, recordedImage, "The last probe failed.");
  }

  return cleanAction(app, state);
}

function cleanAction(app: string, state: DriftRecordedState | null): DriftAction {
  if (state === null) {
    return {
      kind: "rebuild",
      command: `${updateCommand(app)} --rebuild`,
      description:
        "state.json is missing, so update would rebuild and record the image history again.",
    };
  }

  if (state.health.status === "unknown") {
    return {
      kind: "config-only",
      command: updateCommand(app),
      description:
        "No probe result is recorded, so update would recreate the container and probe it again without a rebuild.",
    };
  }

  return {
    kind: "no-op",
    command: null,
    description: "Nothing changed; update would find no work to do.",
  };
}

function investigateAction(): DriftAction {
  return {
    kind: "investigate",
    command: "easy-host doctor",
    description:
      "Podman inspect failed, so an update cannot be classified until the environment is repaired.",
  };
}

function updateCommand(app: string): string {
  return `easy-host update ${app}`;
}
