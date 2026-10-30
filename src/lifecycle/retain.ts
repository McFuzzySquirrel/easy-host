/**
 * Two-image retention (`RBK-FR-02`, `PRD-SP-07`).
 *
 * After a successful `update` or `rollback` an app owns exactly two meaningful
 * images: the one serving (`state.json` `images.current`) and the rollback
 * target (`images.previous`). Every other image that carries the app's
 * `io.easy-host.app` label is stale and is removed here, so disk use stays
 * bounded and the rollback window stays unambiguous.
 *
 * The removal decision has four safety rules, in this order:
 *
 * 1. **The recorded pair always survives**, even when an image looks stale.
 * 2. **An image used by a running container is never removed**, whichever app
 *    that container belongs to. Removing it would break a serving app.
 * 3. **An image referenced by another app is never removed** — not by its
 *    recorded current/previous pair and not by a running container.
 * 4. **Only images labelled for the named app are removed.** The listing is
 *    label-filtered (`io.easy-host.app=<app>`), and every candidate is checked
 *    again against its own labels before removal. A tag that merely looks like
 *    `localhost/easy-host-<app>:<stamp>` is never enough (`PRD-SP-07`).
 *
 * Retention is advisory work: it runs after the app is already serving, so a
 * failed removal never turns a successful update or rollback into a failure.
 * A failed removal is reported and the remaining candidates are still tried. A
 * failed listing is different — without the image set nothing can be proven, so
 * it raises `PrerequisiteError` instead of guessing.
 *
 * The caller holds the per-app lock for the whole lifecycle operation (update
 * or rollback), which is why this module takes no lock of its own. Image list,
 * image removal, registry, state store, output, and environment are injected, so
 * the unit suite runs every scenario with no Podman process.
 */

import { NotFoundError, PrerequisiteError, redactText, UsageError } from "../cli/errors.js";
import { validateAppName } from "../config/name.js";
import { createPaths } from "../platform/paths.js";
import {
  APP_LABEL,
  createDefaultPodmanRunner,
  PODMAN_BINARY,
  PODMAN_FAILURE_CODES,
  type PodmanCommandResult,
  type PodmanRunner,
} from "../platform/podman.js";
import { StateStore } from "../registry/state.js";
import { type AppListEntry, type AppRecord, Registry } from "../registry/store.js";

/** Failed outcomes retention can raise. Per-image removal failures are warnings. */
export const RETAIN_FAILURE_CODES = {
  INVALID_APP: "INVALID_APP_NAME",
  NO_RECORDED_IMAGE: "RETAIN_NO_RECORDED_IMAGE",
  LIST_FAILED: "RETAIN_IMAGE_LIST_FAILED",
  REMOVE_FAILED: "RETAIN_IMAGE_REMOVE_FAILED",
  INVALID_INPUT: "INVALID_RETAIN_INPUT",
} as const;

/** Progress phases. `skipped` is terminal for an app with nothing to anchor on. */
export const RETAIN_PHASES = [
  "validating",
  "listing",
  "retaining",
  "removing",
  "retained",
  "skipped",
] as const;

export type RetainPhase = (typeof RETAIN_PHASES)[number];

/** Why an image was kept. */
export type RetainKeepReason = "current" | "previous" | "in-use" | "shared";

/** Why an image was not removed even though it is not the recorded pair. */
export type RetainRefusedReason =
  | "foreign-label"
  | "unknown-label"
  | "unverified-shared"
  | "removal-failed"
  | "unreferenced";

/** Progress output. It always goes to stderr so stdout stays scriptable. */
export interface RetainOutput {
  phase(phase: RetainPhase, message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

/** A writable stream, narrowed so tests can record progress. */
export interface RetainOutputStream {
  write(chunk: string): unknown;
}

/**
 * One image as the image store reports it. `reference` is the name Podman uses
 * for `image rm` (the first repo tag, or the id for a dangling image).
 */
export interface RetainedImageEntry {
  readonly reference: string;
  readonly id?: string;
  /** `io.easy-host.*` labels carried by the image. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Names of running containers currently using this image. */
  readonly containers?: readonly string[];
}

export interface RetainImageListRequest {
  readonly app: string;
}

/** The image operations retention needs. The Podman adapter will satisfy it. */
export interface RetainImageStore {
  /**
   * Images labelled for `app`, with the running containers using each one.
   * Omitting `containers` asserts the image is not in use, so a store that
   * cannot prove that must report the containers it found.
   */
  list(request: RetainImageListRequest): Promise<readonly RetainedImageEntry[]>;
  /** Removes one image by reference or id. An absent image resolves without error. */
  remove(reference: string): Promise<unknown>;
}

/** The registry operations retention performs. `Registry` satisfies it. */
export interface RetainRegistry {
  list(): readonly AppListEntry[];
  record(name: string): AppRecord;
}

/** The recorded pair retention needs. `AppState` satisfies it. */
export interface RetainRecordedState {
  readonly images: {
    readonly current: string | null;
    readonly previous: string | null;
  };
}

/** The state reader seam. `StateStore` satisfies it. */
export interface RetainStateStore {
  readCache(): RetainRecordedState | undefined;
}

export interface RetainDependencies {
  readonly registry: RetainRegistry;
  readonly images: RetainImageStore;
  readonly stateStore: (appDir: string) => RetainStateStore;
  readonly output: RetainOutput;
  readonly environment: NodeJS.ProcessEnv;
}

export type RetainDependencyOverrides = Partial<RetainDependencies>;

/** Raw retention inputs. */
export interface RetainRequest {
  readonly app: string;
  /**
   * Explicit recorded pair. When either field is present the pair is used as
   * given; otherwise the pair is read from `state.json`.
   */
  readonly current?: string | null;
  readonly previous?: string | null;
  readonly environment?: NodeJS.ProcessEnv;
}

/** One image that survives, and every reason it survived. */
export interface RetainedImage {
  readonly reference: string;
  readonly reasons: readonly RetainKeepReason[];
  /** Running containers using the image, when the store reported them. */
  readonly containers?: readonly string[];
  /** Other apps whose recorded pair references the image. */
  readonly sharedWith?: readonly string[];
}

/** One image that was deliberately not removed. */
export interface RefusedImage {
  readonly reference: string;
  readonly reason: RetainRefusedReason;
  readonly detail?: string;
}

/** The outcome of one retention pass. */
export interface RetainResult {
  /** `skipped` when there is no recorded image to anchor the pair on. */
  readonly status: "retained" | "skipped";
  readonly app: string;
  readonly current: string | null;
  readonly previous: string | null;
  /** Labelled images the store reported. */
  readonly examined: number;
  /** Images that survive, with why. */
  readonly retained: readonly RetainedImage[];
  /** Images removed by this run, in removal order. */
  readonly removed: readonly string[];
  /** Images that were reported but deliberately not removed. */
  readonly refused: readonly RefusedImage[];
  /** Recorded references that no longer exist among the app's labelled images. */
  readonly missing: readonly string[];
  /** Work retention deliberately skipped. */
  readonly skipped: readonly string[];
  readonly phases: readonly RetainPhase[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

/** Options for the production image store. */
export interface RetainImageStoreOptions {
  readonly runner?: PodmanRunner;
  readonly timeoutMs?: number;
}

/** Bound on image list/remove calls. */
export const RETAIN_IMAGE_TIMEOUT_MS = 60_000;

/** The callable retention seam update and rollback depend on. */
export type RetainImages = typeof retainImages;

interface RetainContext {
  readonly app: string;
  readonly dependencies: RetainDependencies;
  readonly output: RetainOutput;
  readonly phases: RetainPhase[];
  readonly warnings: string[];
}

interface RecordedPair {
  readonly current: string;
  readonly previous: string | null;
}

interface OtherAppImages {
  /** Reference to the app names whose recorded pair uses it. */
  readonly references: ReadonlyMap<string, ReadonlySet<string>>;
  /** False when an app's cache could not be read, so sharing cannot be proven. */
  readonly complete: boolean;
}

/** Default progress reporter: plain text on stderr, no ANSI escapes. */
export function createDefaultRetainOutput(
  stream: RetainOutputStream = process.stderr,
): RetainOutput {
  return {
    phase(phase, message) {
      stream.write(`retain: ${phase}: ${message}\n`);
    },
    info(message) {
      stream.write(`retain: ${message}\n`);
    },
    warn(message) {
      stream.write(`retain: warning: ${message}\n`);
    },
  };
}

/**
 * Runs one retention pass for an app.
 *
 * The registry record is resolved first, so an unknown app raises
 * `NotFoundError` (exit 5) before Podman is called. The recorded pair is read
 * from `state.json` unless the request supplies one, and a missing current
 * image skips the pass entirely: with no anchor there is no safe image to keep.
 */
export async function retainImages(
  request: RetainRequest,
  overrides: RetainDependencyOverrides = {},
): Promise<RetainResult> {
  if (typeof request.app !== "string" || request.app.trim().length === 0) {
    throw new UsageError("retain requires an app name", {
      code: RETAIN_FAILURE_CODES.INVALID_APP,
      details: { command: "retain" },
      remediation:
        'Run "easy-host list" and pass one app name, for example "easy-host update blog".',
    });
  }

  const app = validateAppName(request.app);
  const environment = overrides.environment ?? request.environment ?? process.env;
  const dependencies = resolveDependencies(overrides, environment);
  const context: RetainContext = {
    app,
    dependencies,
    output: dependencies.output,
    phases: [],
    warnings: [],
  };
  const { registry } = dependencies;

  emit(context, "validating", `loading app "${app}"`);
  const record = registry.record(app);

  const pair = recordedPair(context, request, record);
  if (pair === undefined) {
    emit(context, "skipped", "no recorded current image; nothing is removed");
    const skipped = ["image listing", "image removal"];
    return {
      status: "skipped",
      app,
      current: null,
      previous: null,
      examined: 0,
      retained: [],
      removed: [],
      refused: [],
      missing: [],
      skipped,
      phases: [...context.phases],
      warnings: [...context.warnings],
      notes: ['retention needs a recorded current image; run "easy-host update <app>" first'],
    };
  }

  emit(
    context,
    "listing",
    `listing images labelled ${APP_LABEL}=${app} to keep ${pair.current}` +
      (pair.previous === null ? "" : ` and ${pair.previous}`),
  );
  const listed = await dependencies.images.list({ app });
  const images = [...listed].sort((left, right) => left.reference.localeCompare(right.reference));

  const otherApps = readOtherAppImages(context);
  const retained: RetainedImage[] = [];
  const removed: string[] = [];
  const refused: RefusedImage[] = [];

  emit(
    context,
    "retaining",
    `examining ${images.length} labelled image(s); ${pair.current}` +
      (pair.previous === null ? " has no rollback target" : ` and ${pair.previous} are the pair`),
  );

  for (const image of images) {
    const reasons = keepReasons(image, pair, otherApps);
    if (reasons.reasons.length > 0) {
      retained.push({
        reference: image.reference,
        reasons: reasons.reasons,
        ...(image.containers === undefined || image.containers.length === 0
          ? {}
          : { containers: [...image.containers] }),
        ...(reasons.sharedWith.length === 0 ? {} : { sharedWith: reasons.sharedWith }),
      });
      continue;
    }

    const labels = image.labels ?? {};
    const label = labels[APP_LABEL];
    if (label !== app) {
      refused.push({
        reference: image.reference,
        reason: label === undefined ? "unknown-label" : "foreign-label",
        detail: `expected ${APP_LABEL}=${app}, found ${
          label === undefined ? "no app label" : `${APP_LABEL}=${label}`
        }`,
      });
      continue;
    }

    if (!otherApps.complete) {
      refused.push({
        reference: image.reference,
        reason: "unverified-shared",
        detail: "another app's recorded images could not be read, so sharing cannot be ruled out",
      });
      continue;
    }

    if (image.reference.trim().length === 0) {
      refused.push({
        reference: image.reference,
        reason: "unreferenced",
        detail: "the image has no reference or id to remove",
      });
      continue;
    }

    emit(context, "removing", `removing stale image ${image.reference}`);
    try {
      await dependencies.images.remove(image.reference);
      removed.push(image.reference);
      info(context, `removed ${image.reference}`);
    } catch (error) {
      warn(
        context,
        `could not remove ${image.reference}: ${messageOf(error)}; keeping it and continuing`,
      );
      refused.push({
        reference: image.reference,
        reason: "removal-failed",
        detail: messageOf(error),
      });
    }
  }

  const missing = missingReferences(pair, images);
  for (const reference of missing) {
    if (images.length === 0) {
      // Nothing is labelled for the app, so there is nothing retention could
      // have removed. Build images produced before image labelling shipped are
      // invisible here; that is reported through `missing`, not as a warning.
      continue;
    }

    warn(
      context,
      `the recorded image ${reference} was not found among the app's labelled images; ` +
        `run "easy-host status ${app}" to confirm the recorded pair`,
    );
  }

  emit(
    context,
    "retained",
    `kept ${retained.length} image(s), removed ${removed.length}, refused ${refused.length}`,
  );

  return {
    status: "retained",
    app,
    current: pair.current,
    previous: pair.previous,
    examined: images.length,
    retained,
    removed,
    refused,
    missing,
    skipped: [],
    phases: [...context.phases],
    warnings: [...context.warnings],
    notes: retentionNotes(pair, retained, removed, refused),
  };
}

/**
 * The image surface production uses. `src/platform/podman.ts` does not yet
 * expose image operations, so this thin adapter reuses the shared Podman runner
 * (argument arrays, finite timeout, redacted failures) and keeps the label
 * filter in one place. It can move into the platform adapter without changing
 * `RetainImageStore`.
 */
export function createDefaultRetainImageStore(
  options: RetainImageStoreOptions = {},
): RetainImageStore {
  const runner = options.runner ?? createDefaultPodmanRunner();
  const timeoutMs = options.timeoutMs ?? RETAIN_IMAGE_TIMEOUT_MS;

  return {
    async list(request) {
      const app = validateAppName(request.app);
      const listing = await invokePodman(
        runner,
        ["images", "--filter", `label=${APP_LABEL}=${app}`, "--format", "json"],
        timeoutMs,
        `the images labelled for app "${app}" could not be listed`,
      );
      assertSucceeded(listing, {
        message: `the images labelled for app "${app}" could not be listed`,
        code: RETAIN_FAILURE_CODES.LIST_FAILED,
        app,
        timeoutMs,
      });

      const running = await invokePodman(
        runner,
        ["ps", "--format", "json"],
        timeoutMs,
        "the running containers could not be listed",
      );
      assertSucceeded(running, {
        message: "the running containers could not be listed, so image use cannot be checked",
        code: RETAIN_FAILURE_CODES.LIST_FAILED,
        app,
        timeoutMs,
      });

      return normalizeImageList(listing.stdout, running.stdout);
    },

    async remove(reference) {
      if (typeof reference !== "string" || reference.trim().length === 0) {
        throw new UsageError("retain requires a non-empty image reference", {
          code: RETAIN_FAILURE_CODES.INVALID_INPUT,
          details: { setting: "reference" },
          remediation: "Pass the image name or id reported by `podman images`.",
        });
      }

      const result = await invokePodman(
        runner,
        ["image", "rm", reference],
        timeoutMs,
        `image "${reference}" could not be removed`,
      );

      if (result.exitCode !== 0 && isMissingImage(result)) {
        return { reference, removed: false };
      }

      assertSucceeded(result, {
        message: `image "${reference}" could not be removed`,
        code: RETAIN_FAILURE_CODES.REMOVE_FAILED,
        reference,
        timeoutMs,
      });

      return { reference, removed: true };
    },
  };
}

/** Reads the recorded pair from the request or from `state.json`. */
function recordedPair(
  context: RetainContext,
  request: RetainRequest,
  record: AppRecord,
): RecordedPair | undefined {
  const explicit = request.current !== undefined || request.previous !== undefined;
  let current: string | null;
  let previous: string | null;

  if (explicit) {
    current = imageOrNull(request.current);
    previous = imageOrNull(request.previous);
  } else {
    let state: RetainRecordedState | undefined;
    try {
      state = context.dependencies.stateStore(record.directory).readCache();
    } catch (error) {
      warn(
        context,
        `state.json could not be read (${messageOf(error)}); retention skipped rather than ` +
          "risking the images that are serving",
      );
      return undefined;
    }

    current = imageOrNull(state?.images.current);
    previous = imageOrNull(state?.images.previous);
  }

  if (current === null) {
    if (explicit) {
      throw new NotFoundError(
        `retention for app "${context.app}" needs a current image reference`,
        {
          code: RETAIN_FAILURE_CODES.NO_RECORDED_IMAGE,
          details: { app: context.app, previous: previous ?? "none" },
          remediation: `Run "easy-host update ${context.app}" so a current image is recorded.`,
        },
      );
    }

    return undefined;
  }

  if (previous === current) {
    return { current, previous: null };
  }

  return { current, previous };
}

/** Collects the recorded pairs of every other app, so shared images stay. */
function readOtherAppImages(context: RetainContext): OtherAppImages {
  const references = new Map<string, Set<string>>();
  let complete = true;

  for (const entry of context.dependencies.registry.list()) {
    if (entry.name === context.app) {
      continue;
    }

    let state: RetainRecordedState | undefined;
    try {
      state = context.dependencies.stateStore(entry.directory).readCache();
    } catch (error) {
      complete = false;
      warn(
        context,
        `the recorded images of app "${entry.name}" could not be read (${messageOf(error)}); ` +
          "no image will be removed until sharing can be ruled out",
      );
      continue;
    }

    for (const reference of [state?.images.current, state?.images.previous]) {
      if (typeof reference === "string" && reference.length > 0) {
        const owners = references.get(reference) ?? new Set<string>();
        owners.add(entry.name);
        references.set(reference, owners);
      }
    }
  }

  return { references, complete };
}

function keepReasons(
  image: RetainedImageEntry,
  pair: RecordedPair,
  otherApps: OtherAppImages,
): { reasons: RetainKeepReason[]; sharedWith: string[] } {
  const reasons: RetainKeepReason[] = [];

  if (image.reference === pair.current) {
    reasons.push("current");
  }

  if (pair.previous !== null && image.reference === pair.previous) {
    reasons.push("previous");
  }

  if (image.containers !== undefined && image.containers.length > 0) {
    reasons.push("in-use");
  }

  const sharedWith = [...(otherApps.references.get(image.reference) ?? [])].sort();
  if (sharedWith.length > 0) {
    reasons.push("shared");
  }

  return { reasons, sharedWith };
}

function missingReferences(pair: RecordedPair, images: readonly RetainedImageEntry[]): string[] {
  const listed = new Set(images.map((image) => image.reference));
  const recorded = new Set<string>([pair.current]);
  if (pair.previous !== null) {
    recorded.add(pair.previous);
  }

  return [...recorded].filter((reference) => !listed.has(reference)).sort();
}

function retentionNotes(
  pair: RecordedPair,
  retained: readonly RetainedImage[],
  removed: readonly string[],
  refused: readonly RefusedImage[],
): string[] {
  const notes = [
    pair.previous === null
      ? `kept ${pair.current}; no previous image is recorded`
      : `kept ${pair.current} (current) and ${pair.previous} (rollback target)`,
  ];

  if (removed.length > 0) {
    notes.push(`removed ${removed.join(", ")}`);
  }

  if (refused.length > 0) {
    notes.push(
      `did not remove ${refused.map((entry) => `${entry.reference} (${entry.reason})`).join(", ")}`,
    );
  }

  const guarded = retained.filter(
    (image) => image.reasons.includes("in-use") || image.reasons.includes("shared"),
  );
  if (guarded.length > 0) {
    notes.push(
      `kept ${guarded
        .map((image) => {
          const why = [
            ...(image.reasons.includes("in-use") ? ["in use by a running container"] : []),
            ...(image.reasons.includes("shared") ? ["recorded by another app"] : []),
          ];
          return `${image.reference} (${why.join("; ")})`;
        })
        .join(", ")}`,
    );
  }

  return notes;
}

async function invokePodman(
  runner: PodmanRunner,
  args: readonly string[],
  timeoutMs: number,
  message: string,
): Promise<PodmanCommandResult> {
  let result: PodmanCommandResult;
  try {
    result = await Promise.resolve(runner.run(PODMAN_BINARY, args, { timeoutMs }));
  } catch (error) {
    throw new PrerequisiteError(`could not start podman: ${messageOf(error)}`, {
      code: PODMAN_FAILURE_CODES.UNAVAILABLE,
      details: { binary: PODMAN_BINARY, reason: messageOf(error), timeoutMs },
      remediation:
        "Install rootless Podman 5.7.0-5.8.x, ensure `podman` is on PATH, then run `easy-host doctor`.",
      cause: error,
    });
  }

  if (result.spawnError === "ENOENT") {
    throw new PrerequisiteError("podman is not installed or not on PATH", {
      code: PODMAN_FAILURE_CODES.UNAVAILABLE,
      details: { binary: PODMAN_BINARY, reason: "ENOENT", timeoutMs },
      remediation:
        "Install rootless Podman 5.7.0-5.8.x, ensure `podman` is on PATH, then run `easy-host doctor`.",
    });
  }

  if (result.spawnError === "ETIMEDOUT") {
    throw new PrerequisiteError(`${message}: podman did not finish within ${timeoutMs}ms`, {
      code: PODMAN_FAILURE_CODES.TIMEOUT,
      details: { binary: PODMAN_BINARY, reason: "ETIMEDOUT", timeoutMs },
      remediation: `Run "podman images" manually, then "easy-host doctor".`,
    });
  }

  return result;
}

function assertSucceeded(
  result: PodmanCommandResult,
  context: {
    readonly message: string;
    readonly code: string;
    readonly app?: string;
    readonly reference?: string;
    readonly timeoutMs: number;
  },
): void {
  if (result.exitCode === 0 && result.spawnError === undefined) {
    return;
  }

  const reason = summarizePodmanOutput(result);

  throw new PrerequisiteError(`${context.message}: ${reason}`, {
    code: context.code,
    details: {
      ...(context.app === undefined ? {} : { app: context.app }),
      ...(context.reference === undefined ? {} : { image: context.reference }),
      reason,
      timeoutMs: context.timeoutMs,
    },
    remediation: `Run "podman images" to inspect the local image set, then "easy-host doctor".`,
  });
}

/**
 * Normalizes `podman images --format json` plus `podman ps --format json`.
 * Names, ids, labels, and the running containers using each image are kept;
 * anything unreadable is ignored rather than guessed.
 */
function normalizeImageList(imagesJson: string, containersJson: string): RetainedImageEntry[] {
  const imageRecords = parseArray(imagesJson, "images");
  const containerRecords = parseArray(containersJson, "containers");
  const containers = containerRecords.flatMap((record) => {
    const id = stringOf(record.Id) ?? stringOf(record.ID);
    const image = stringOf(record.Image);
    const imageId = stringOf(record.ImageID);
    const name = firstString(record.Names) ?? id;

    if (name === undefined || (image === undefined && imageId === undefined)) {
      return [];
    }

    return [{ name, image, imageId }];
  });

  const entries: RetainedImageEntry[] = [];
  for (const record of imageRecords) {
    const id = stringOf(record.Id) ?? stringOf(record.ID);
    const names = stringList(record.Names ?? record.RepoTags);
    const reference = names[0] ?? id;
    if (reference === undefined) {
      continue;
    }

    const labels = stringRecord(record.Labels);
    const inUse = containers
      .filter(
        (container) =>
          (container.image !== undefined &&
            (container.image === reference || names.includes(container.image))) ||
          (container.imageId !== undefined &&
            id !== undefined &&
            sameImageId(container.imageId, id)),
      )
      .map((container) => container.name);

    entries.push({
      reference,
      ...(id === undefined ? {} : { id }),
      labels,
      containers: inUse,
    });
  }

  return entries;
}

function parseArray(text: string, subject: string): Record<string, unknown>[] {
  if (text.trim().length === 0) {
    return [];
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PrerequisiteError(`podman returned unreadable JSON for ${subject}`, {
      code: RETAIN_FAILURE_CODES.LIST_FAILED,
      details: { subject, reason: messageOf(error) },
      remediation: "Run `podman images` manually, then `easy-host doctor`.",
      cause: error,
    });
  }

  if (!Array.isArray(value)) {
    throw new PrerequisiteError(`podman returned a non-list document for ${subject}`, {
      code: RETAIN_FAILURE_CODES.LIST_FAILED,
      details: { subject },
      remediation: "Run `podman images` manually, then `easy-host doctor`.",
    });
  }

  return value.flatMap((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? [entry as Record<string, unknown>]
      : [],
  );
}

function isMissingImage(result: PodmanCommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    text.includes("no such image") ||
    text.includes("image not known") ||
    text.includes("not found") ||
    text.includes("unable to find") ||
    text.includes("does not exist")
  );
}

function sameImageId(left: string, right: string): boolean {
  return stripDigest(left) === stripDigest(right);
}

function stripDigest(value: string): string {
  const separator = value.indexOf(":");
  return separator === -1 ? value : value.slice(separator + 1);
}

function summarizePodmanOutput(result: PodmanCommandResult): string {
  const output = redactText(`${result.stderr}\n${result.stdout}`.trim());
  return output.length === 0 ? "podman exited without output" : output;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const text = stringOf(entry);
    return text === undefined ? [] : [text];
  });
}

function firstString(value: unknown): string | undefined {
  return stringList(value)[0];
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const text = stringOf(entry);
      return text === undefined ? [] : [[key, text] as const];
    }),
  );
}

function resolveDependencies(
  overrides: RetainDependencyOverrides,
  environment: NodeJS.ProcessEnv,
): RetainDependencies {
  const paths = createPaths({ env: environment });

  return {
    registry: overrides.registry ?? new Registry(paths),
    images: overrides.images ?? createDefaultRetainImageStore(),
    stateStore: overrides.stateStore ?? ((appDir) => new StateStore(appDir)),
    output: overrides.output ?? createDefaultRetainOutput(),
    environment,
  };
}

function emit(context: RetainContext, phase: RetainPhase, message: string): void {
  context.phases.push(phase);
  try {
    context.output.phase(phase, message);
  } catch {
    // Progress output is advisory; a broken stream must not corrupt retention.
  }
}

function info(context: RetainContext, message: string): void {
  try {
    context.output.info(message);
  } catch {
    // See emit.
  }
}

function warn(context: RetainContext, message: string): void {
  context.warnings.push(message);
  try {
    context.output.warn(message);
  } catch {
    // See emit.
  }
}

function imageOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
