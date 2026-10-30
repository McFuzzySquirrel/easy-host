/**
 * `remove` orchestration (`RBK-FR-03`, `RBK-FR-04`, `RBK-FR-05`).
 *
 * Removal is the product's most destructive command, so the order is chosen to
 * make data loss and partial removal both impossible:
 *
 * 1. **validating** — the app name is validated and the registry record is
 *    resolved (exit 5 for an unknown app);
 * 2. **confirmation gate** — a non-interactive invocation that was not given
 *    `--yes` or `--force` fails with exit 1 *before* the lock, Podman, or the
 *    filesystem is touched, so it cannot delete anything (`RBK-FR-05`);
 * 3. **locking** — the per-app lock is taken for the whole mutation and
 *    released in `finally` on every path (exit 6 when another mutation holds
 *    it, naming the holder);
 * 4. **inspecting** — the container, workspace, app directory, images, and
 *    volumes are enumerated before the first mutation. The exact resources are
 *    printed and an interactive invocation must confirm them. A refused or
 *    cancelled confirmation deletes nothing;
 * 5. **stopping / removing** — the container is stopped (a missing container is
 *    already absent and is not an error) and removed with `--force`;
 * 6. **removing-images** — every image belonging to the app is removed. An
 *    image is a candidate when it carries `io.easy-host.app=<app>` *or* when
 *    the app's own `state.json` recorded that exact reference (Railpack-built
 *    images are not labelled yet). Images used by another running container or
 *    recorded by another app are kept and reported;
 * 7. **removing-volumes** — only with `--volumes`. Every listed volume is
 *    re-checked: only a volume whose `io.easy-host.app` label equals the app is
 *    deleted. An unlabelled volume with the app's name pattern, or one labelled
 *    for another app, is reported and never touched (`RBK-FR-04`,
 *    `PRD-SP-07`). Without `--volumes` the named volumes survive and their
 *    names plus the `podman volume rm` command are printed;
 * 8. **removing-workspace / removing-app** — the checkout and then the app
 *    directory are deleted. Both paths are asserted to be app-scoped before
 *    deletion, so no host path can ever be removed (`PRD-C-08`). The app
 *    directory goes last so a failed image or volume step leaves a registered
 *    app that can simply be removed again.
 *
 * Registry, runtime, image store, volume store, state reader, filesystem,
 * output, confirmer, clock, and lock options are injected, so the unit suite
 * runs every scenario with no Podman process, terminal, or real state root.
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  type ErrorDetails,
  NotFoundError,
  PrerequisiteError,
  redactText,
  UsageError,
} from "../cli/errors.js";
import { type Confirmer, createClackConfirmer } from "../cli/prompts.js";
import { validateAppName } from "../config/name.js";
import type { AppSpec } from "../config/schema.js";
import { acquireAppLock, type LockAcquireOptions } from "../platform/lock.js";
import { createPaths } from "../platform/paths.js";
import {
  APP_LABEL,
  type ContainerRemoveResult,
  type ContainerStopResult,
  containerName,
  createDefaultPodmanRunner,
  listVolumes,
  PODMAN_BINARY,
  PODMAN_FAILURE_CODES,
  type PodmanCommandResult,
  type PodmanRunner,
  type RemoveContainerOptions,
  type RemoveVolumeOptions,
  removeContainer,
  removeVolume,
  type StopContainerOptions,
  stopContainer,
  volumeName,
} from "../platform/podman.js";
import { StateStore } from "../registry/state.js";
import {
  type AppListEntry,
  type AppRecord,
  Registry,
  WORKSPACE_DIRECTORY_NAME,
} from "../registry/store.js";

/** Failed outcomes the remove command reports. */
export const REMOVE_FAILURE_CODES = {
  INVALID_APP: "INVALID_APP_NAME",
  CONFIRMATION_REQUIRED: "REMOVE_CONFIRMATION_REQUIRED",
  CANCELLED: "REMOVE_CANCELLED",
  CONTAINER_REMOVE_FAILED: "REMOVE_CONTAINER_FAILED",
  IMAGE_LIST_FAILED: "REMOVE_IMAGE_LIST_FAILED",
  IMAGE_REMOVE_FAILED: "REMOVE_IMAGE_REMOVE_FAILED",
  VOLUME_LIST_FAILED: "REMOVE_VOLUME_LIST_FAILED",
  VOLUME_REMOVE_FAILED: "REMOVE_VOLUME_REMOVE_FAILED",
  WORKSPACE_UNSAFE: "REMOVE_WORKSPACE_UNSAFE",
  APP_DIRECTORY_UNSAFE: "REMOVE_APP_DIRECTORY_UNSAFE",
  WORKSPACE_REMOVE_FAILED: "REMOVE_WORKSPACE_FAILED",
  APP_DIRECTORY_REMOVE_FAILED: "REMOVE_APP_DIRECTORY_FAILED",
} as const;

/** Progress phases. They are narrated in the order they occur. */
export const REMOVE_PHASES = [
  "validating",
  "locking",
  "inspecting",
  "confirming",
  "stopping",
  "removing-container",
  "removing-images",
  "removing-volumes",
  "removing-workspace",
  "removing-app",
  "removed",
] as const;

export type RemovePhase = (typeof REMOVE_PHASES)[number];

/** Why an image was deliberately kept. */
export type RemoveImageKeepReason = "in-use" | "shared" | "foreign-label" | "unreferenced";

/** Why a volume was not deleted even though its name matches the app. */
export type RemoveVolumeRefusalReason = "unlabelled" | "foreign-label";

/** Progress output. It always goes to stderr so stdout stays scriptable. */
export interface RemoveOutput {
  phase(phase: RemovePhase, message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

/** A writable stream, narrowed so tests can record progress. */
export interface RemoveOutputStream {
  write(chunk: string): unknown;
}

/** The registry operations removal performs. `Registry` satisfies it. */
export interface RemoveRegistry {
  /** The `apps/` directory, used to prove an app directory is app-scoped. */
  readonly appsDir?: string;
  list(): readonly AppListEntry[];
  record(name: string): AppRecord;
  readConfig(name: string): AppSpec;
}

/** Container operations removal performs. The Podman adapter satisfies it. */
export interface RemoveRuntime {
  stopContainer(options: StopContainerOptions): Promise<ContainerStopResult>;
  removeContainer(options: RemoveContainerOptions): Promise<ContainerRemoveResult>;
}

/** One local image as the image store reports it. */
export interface RemoveImageEntry {
  readonly reference: string;
  readonly id?: string;
  /** `io.easy-host.*` labels carried by the image. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Names of running containers currently using this image. */
  readonly containers?: readonly string[];
}

/** The image surface removal needs. */
export interface RemoveImageStore {
  /** Every local image, with its labels and running containers. */
  list(): Promise<readonly RemoveImageEntry[]>;
  /** Removes one image by reference. An absent image resolves without error. */
  remove(reference: string): Promise<unknown>;
}

/** One local volume as the volume store reports it. */
export interface RemoveVolumeEntry {
  readonly name: string;
  /** Set when the volume carries an `io.easy-host.app` label. */
  readonly app?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/** The volume surface removal needs. */
export interface RemoveVolumeStore {
  list(): Promise<readonly RemoveVolumeEntry[]>;
  /** Removes one named volume. An absent volume resolves without error. */
  remove(name: string): Promise<unknown>;
}

/** The recorded references removal reads. `AppState` satisfies it. */
export interface RemoveRecordedState {
  readonly images: {
    readonly current: string | null;
    readonly previous: string | null;
  };
}

/** The state reader seam. `StateStore` satisfies it. */
export interface RemoveStateStore {
  readCache(): RemoveRecordedState | undefined;
}

/** Filesystem operations removal performs. The default uses `node:fs`. */
export interface RemoveFileSystem {
  exists(target: string): boolean;
  removeDirectory(target: string): void;
}

/**
 * Confirmation seam. It receives the exact resources and returns `true` only
 * when the operator approved; `undefined` or `false` cancels the removal.
 */
export type RemoveConfirmer = (preview: RemovePreview) => Promise<boolean | undefined>;

export interface RemoveDependencies {
  readonly registry: RemoveRegistry;
  readonly runtime: RemoveRuntime;
  readonly images: RemoveImageStore;
  readonly volumes: RemoveVolumeStore;
  readonly stateStore: (appDir: string) => RemoveStateStore;
  readonly files: RemoveFileSystem;
  readonly output: RemoveOutput;
  readonly confirm: RemoveConfirmer;
  readonly environment: NodeJS.ProcessEnv;
  readonly clock: () => Date;
  readonly lock?: LockAcquireOptions;
}

export type RemoveDependencyOverrides = Partial<RemoveDependencies>;

/** Raw `remove` inputs. */
export interface RemoveRequest {
  readonly app: string;
  /** `--volumes`: delete named volumes labelled for the app (`RBK-FR-04`). */
  readonly volumes?: boolean;
  /** `--yes`: skip the confirmation prompt on a non-TTY. */
  readonly yes?: boolean;
  /** `--force`: skip confirmation only; it never implies `--volumes`. */
  readonly force?: boolean;
  /**
   * Whether stdin is a terminal. Defaults to `false`, so a library caller that
   * forgets it fails closed rather than prompting into a pipe.
   */
  readonly interactive?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

/** One image that removal deliberately keeps. */
export interface RemovedImageKeep {
  readonly reference: string;
  readonly reason: RemoveImageKeepReason;
  readonly detail?: string;
  readonly containers?: readonly string[];
  readonly sharedWith?: readonly string[];
}

/** One volume that removal deliberately did not touch. */
export interface RemovedVolumeRefusal {
  readonly name: string;
  readonly reason: RemoveVolumeRefusalReason;
  readonly detail?: string;
}

/** The exact resources a confirmed removal will act on. */
export interface RemovePreview {
  readonly app: string;
  readonly container: string;
  readonly workspace: string;
  readonly appDirectory: string;
  /** Images that will be removed. */
  readonly images: readonly string[];
  /** Images that will be kept, with why. */
  readonly keptImages: readonly RemovedImageKeep[];
  /** Volume names that will be deleted when `--volumes` is set. */
  readonly volumes: readonly string[];
  /** Volume names that survive. */
  readonly keptVolumes: readonly string[];
  /** Name-matching volumes that will never be deleted. */
  readonly refusedVolumes: readonly RemovedVolumeRefusal[];
  /** True when this invocation passed `--volumes`. */
  readonly deleteVolumes: boolean;
}

/** The outcome of one successful removal. */
export interface RemoveResult {
  readonly status: "removed";
  readonly app: string;
  readonly container: {
    readonly name: string;
    readonly present: boolean;
    readonly stopped: boolean;
    readonly removed: boolean;
  };
  readonly images: {
    readonly removed: readonly string[];
    readonly kept: readonly RemovedImageKeep[];
    /** Recorded references that no longer exist locally. */
    readonly missing: readonly string[];
  };
  readonly volumes: {
    readonly deleted: readonly string[];
    readonly retained: readonly string[];
    readonly refused: readonly RemovedVolumeRefusal[];
    /** The exact command that deletes the retained volumes, when any survive. */
    readonly deleteCommand: string | null;
  };
  readonly workspace: {
    readonly path: string;
    readonly deleted: boolean;
  };
  readonly appDirectory: {
    readonly path: string;
    readonly deleted: boolean;
  };
  /** Work this command deliberately did not do. */
  readonly skipped: readonly string[];
  readonly phases: readonly RemovePhase[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

/** Options for the production image store. */
export interface RemoveImageStoreOptions {
  readonly runner?: PodmanRunner;
  readonly timeoutMs?: number;
}

/** Bound on each image list/remove call. */
export const REMOVE_IMAGE_TIMEOUT_MS = 60_000;

interface RemoveContext {
  readonly app: string;
  readonly record: AppRecord;
  readonly dependencies: RemoveDependencies;
  readonly output: RemoveOutput;
  readonly phases: RemovePhase[];
  readonly warnings: string[];
  readonly container: string;
  readonly appDirectory: string;
  readonly workspace: string;
}

interface ImagePlan {
  readonly delete: readonly string[];
  readonly keep: readonly RemovedImageKeep[];
  readonly missing: readonly string[];
}

interface VolumePlan {
  readonly owned: readonly string[];
  readonly refused: readonly RemovedVolumeRefusal[];
}

/** Default progress reporter: plain text on stderr, no ANSI escapes. */
export function createDefaultRemoveOutput(
  stream: RemoveOutputStream = process.stderr,
): RemoveOutput {
  return {
    phase(phase, message) {
      stream.write(`remove: ${phase}: ${message}\n`);
    },
    info(message) {
      stream.write(`remove: ${message}\n`);
    },
    warn(message) {
      stream.write(`remove: warning: ${message}\n`);
    },
  };
}

/** The production runtime: the Podman adapter, unchanged. */
export function createDefaultRemoveRuntime(): RemoveRuntime {
  return { stopContainer, removeContainer };
}

/** The production filesystem: app-scoped recursive deletion only. */
export function createDefaultRemoveFileSystem(): RemoveFileSystem {
  return {
    exists(target) {
      return existsSync(target);
    },
    removeDirectory(target) {
      rmSync(target, { recursive: true, force: true });
    },
  };
}

/** The production volume store: the platform Podman adapter, unchanged. */
export function createDefaultRemoveVolumeStore(
  options: { readonly runner?: PodmanRunner; readonly timeoutMs?: number } = {},
): RemoveVolumeStore {
  return {
    list() {
      return listVolumes({
        ...(options.runner === undefined ? {} : { runner: options.runner }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    },
    remove(name) {
      const request: RemoveVolumeOptions = {
        name,
        ignoreMissing: true,
        ...(options.runner === undefined ? {} : { runner: options.runner }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      };

      return removeVolume(request);
    },
  };
}

/** The production confirmer: a `@clack/prompts` yes/no prompt. */
export function createDefaultRemoveConfirmer(): RemoveConfirmer {
  const confirmer: Confirmer = createClackConfirmer();

  return (preview) =>
    confirmer.confirm({
      message: formatRemovePreview(preview),
      initialValue: false,
    });
}

/**
 * Runs one removal.
 *
 * The registry record is resolved first, so an unknown app exits 5. A
 * non-interactive invocation without `--yes`/`--force` then exits 1 before the
 * lock or any resource lookup. Everything after the lock is read before the
 * first mutation, and the app directory is deleted last.
 */
export async function removeApp(
  request: RemoveRequest,
  overrides: RemoveDependencyOverrides = {},
): Promise<RemoveResult> {
  if (typeof request.app !== "string" || request.app.trim().length === 0) {
    throw new UsageError("remove requires an app name", {
      code: REMOVE_FAILURE_CODES.INVALID_APP,
      details: { command: "remove" },
      remediation:
        'Run "easy-host list" and pass one app name, for example "easy-host remove blog".',
    });
  }

  const environment = overrides.environment ?? request.environment ?? process.env;
  const clock = overrides.clock ?? (() => new Date());
  const dependencies = resolveDependencies(overrides, environment, clock);
  const { registry, output } = dependencies;
  const app = validateAppName(request.app);

  emitPhase(output, "validating", `loading app "${app}"`);
  const record = registry.record(app);

  const skipConfirmation = request.yes === true || request.force === true;
  if (!skipConfirmation && request.interactive !== true) {
    throw confirmationRequiredError(app, record);
  }

  emitPhase(output, "locking", `acquiring the app lock for "${app}"`);
  const lock = acquireAppLock(record.directory, {
    operation: "remove",
    app,
    ...(dependencies.lock ?? {}),
  });

  try {
    return await removeWhileLocked(app, record, request, dependencies);
  } finally {
    lock.release();
  }
}

async function removeWhileLocked(
  app: string,
  record: AppRecord,
  request: RemoveRequest,
  dependencies: RemoveDependencies,
): Promise<RemoveResult> {
  const context: RemoveContext = {
    app,
    record,
    dependencies,
    output: dependencies.output,
    phases: [],
    warnings: [],
    container: containerName(app),
    appDirectory: assertAppDirectory(app, record, dependencies.registry.appsDir),
    workspace: assertWorkspacePath(record),
  };

  const spec = readSpec(context);
  const state = readState(context);
  const volumePlan = await planVolumes(context, spec, request.volumes === true);
  const imagePlan = await planImages(context, state);

  const preview: RemovePreview = {
    app,
    container: context.container,
    workspace: context.workspace,
    appDirectory: context.appDirectory,
    images: imagePlan.delete,
    keptImages: imagePlan.keep,
    volumes: volumePlan.owned,
    keptVolumes: request.volumes === true ? [] : volumePlan.owned,
    refusedVolumes: volumePlan.refused,
    deleteVolumes: request.volumes === true,
  };

  emit(
    context,
    "inspecting",
    `${imagePlan.delete.length} image(s), ${volumePlan.owned.length} app volume(s), ` +
      `container ${context.container}, workspace ${context.workspace}`,
  );
  for (const line of formatRemovePreview(preview).split("\n")) {
    info(context, line);
  }

  emit(context, "confirming", confirmationMessage(request));
  await confirmRemoval(context, request, preview);

  const container = await removeContainerStep(context);
  const images = await removeImages(context, imagePlan);
  const volumes = await writeVolumeOutcome(context, volumePlan, request.volumes === true);

  const workspace = removeWorkspace(context);
  const appDirectoryDeleted = removeAppDirectory(context);
  const workspaceDeleted =
    workspace.deleted ||
    (workspace.existed && !context.dependencies.files.exists(context.workspace));

  emit(context, "removed", `removed app "${app}"`);

  return {
    status: "removed",
    app,
    container,
    images,
    volumes,
    workspace: { path: context.workspace, deleted: workspaceDeleted },
    appDirectory: { path: context.appDirectory, deleted: appDirectoryDeleted },
    skipped: buildSkipped(request.volumes === true, volumePlan.owned.length),
    phases: [...context.phases],
    warnings: [...context.warnings],
    notes: buildNotes(context, spec, request.volumes === true, preview),
  };
}

/**
 * Renders the exact resources. It is used both for progress output and as the
 * confirmation prompt, so the operator confirms the same list that is deleted.
 */
export function formatRemovePreview(preview: RemovePreview): string {
  const lines = [`delete app "${preview.app}"?`];
  lines.push(`  container:  ${preview.container}`);

  if (preview.images.length > 0) {
    lines.push(`  images:     ${preview.images.join(", ")}`);
  } else {
    lines.push("  images:     none found");
  }

  lines.push(`  workspace:  ${preview.workspace}`);
  lines.push(`  app dir:    ${preview.appDirectory}`);

  if (preview.deleteVolumes) {
    lines.push(
      preview.volumes.length === 0
        ? "  volumes:    none labelled for the app"
        : `  volumes:    ${preview.volumes.join(", ")} (deleted)`,
    );
  } else {
    lines.push(
      preview.keptVolumes.length === 0
        ? "  volumes:    none labelled for the app (never deleted without --volumes)"
        : `  volumes:    ${preview.keptVolumes.join(", ")} (kept; pass --volumes to delete)`,
    );
  }

  if (preview.refusedVolumes.length > 0) {
    lines.push(
      `  refused:    ${preview.refusedVolumes
        .map((volume) => `${volume.name} (${volume.reason})`)
        .join(", ")}`,
    );
  }

  for (const image of preview.keptImages) {
    lines.push(`  kept image: ${image.reference} (${image.reason})`);
  }

  return lines.join("\n");
}

function confirmationMessage(request: RemoveRequest): string {
  if (request.force === true) {
    return "confirmation waived by --force";
  }

  if (request.yes === true) {
    return "confirmation waived by --yes";
  }

  return "waiting for operator confirmation; nothing is deleted until it is given";
}

/** Confirms the exact preview before the first mutation (`RBK-FR-05`). */
async function confirmRemoval(
  context: RemoveContext,
  request: RemoveRequest,
  preview: RemovePreview,
): Promise<void> {
  if (request.yes === true || request.force === true) {
    return;
  }

  let approved: boolean | undefined;
  try {
    approved = await context.dependencies.confirm(preview);
  } catch (error) {
    throw new UsageError(`remove of "${context.app}" was cancelled before confirmation completed`, {
      code: REMOVE_FAILURE_CODES.CANCELLED,
      details: { app: context.app, reason: messageOf(error) },
      remediation: `Nothing was deleted. Retry "easy-host remove ${context.app}" and confirm the prompt.`,
      cause: error,
    });
  }

  if (approved !== true) {
    throw new UsageError(`remove of "${context.app}" was cancelled; nothing was deleted`, {
      code: REMOVE_FAILURE_CODES.CANCELLED,
      details: {
        app: context.app,
        container: context.container,
        appDirectory: context.appDirectory,
        volumes: preview.volumes,
      },
      remediation: `Nothing was deleted. Re-run "easy-host remove ${context.app} --yes" to proceed non-interactively.`,
    });
  }
}

/** Stops and removes the container. A missing container is already absent. */
async function removeContainerStep(context: RemoveContext): Promise<RemoveResult["container"]> {
  const { app, container, dependencies } = context;
  emit(context, "stopping", `stopping container "${container}"`);

  let present = true;
  let stopped = false;
  try {
    const result = await dependencies.runtime.stopContainer({ app, timeSeconds: 10 });
    stopped = result.stopped;
  } catch (error) {
    if (error instanceof NotFoundError) {
      present = false;
      info(context, `container "${container}" is already absent; nothing to stop`);
    } else {
      warn(
        context,
        `could not stop container "${container}": ${messageOf(error)}; trying a forced removal`,
      );
    }
  }

  emit(context, "removing-container", `removing container "${container}"`);
  let removed = false;
  try {
    const result = await dependencies.runtime.removeContainer({
      app,
      force: true,
      ignoreMissing: true,
    });
    removed = result.removed;
    if (!result.removed && present) {
      info(context, `container "${container}" was already absent`);
    }
  } catch (error) {
    throw new PrerequisiteError(
      `could not remove container "${container}": ${messageOf(error)}; ` +
        "the app directory was kept so the removal can be retried",
      {
        code: REMOVE_FAILURE_CODES.CONTAINER_REMOVE_FAILED,
        details: { app, container, reason: messageOf(error) },
        remediation: `Run "podman rm --force ${container}", then retry "easy-host remove ${app} --yes".`,
        cause: error,
      },
    );
  }

  return { name: container, present, stopped, removed };
}

/**
 * Removes every app image in the plan.
 *
 * Images deliberately kept (in use by another container, recorded by another
 * app, or labelled for another app) are reported and never removed. A removal
 * failure aborts before the app directory is deleted, so a retry starts from a
 * consistent, still-registered app.
 */
async function removeImages(
  context: RemoveContext,
  plan: ImagePlan,
): Promise<RemoveResult["images"]> {
  const { app, dependencies } = context;
  const removed: string[] = [];
  const failures: string[] = [];

  for (const reference of plan.delete) {
    emit(context, "removing-images", `removing image ${reference}`);
    try {
      await dependencies.images.remove(reference);
      removed.push(reference);
      info(context, `removed image ${reference}`);
    } catch (error) {
      failures.push(`${reference} (${messageOf(error)})`);
      warn(context, `could not remove image ${reference}: ${messageOf(error)}`);
    }
  }

  for (const image of plan.keep) {
    info(context, `kept image ${image.reference} (${image.reason})`);
  }

  if (failures.length > 0) {
    throw new PrerequisiteError(
      `could not remove ${failures.length} image(s) for app "${app}"; ` +
        "the app directory was kept so the removal can be retried",
      {
        code: REMOVE_FAILURE_CODES.IMAGE_REMOVE_FAILED,
        details: { app, failed: failures, removed },
        remediation: `Run "podman images", then retry "easy-host remove ${app} --yes".`,
      },
    );
  }

  return { removed, kept: plan.keep, missing: plan.missing };
}

/**
 * Applies the volume decision (`RBK-FR-04`, `PRD-C-08`).
 *
 * Without `--volumes` nothing is deleted and the exact `podman volume rm`
 * command is returned so the operator can decide later. With `--volumes`, only
 * the volumes from the inspected plan whose labels match the app are removed;
 * name-matching but unlabelled or foreign volumes were already filtered out.
 */
async function writeVolumeOutcome(
  context: RemoveContext,
  plan: VolumePlan,
  deleteVolumes: boolean,
): Promise<RemoveResult["volumes"]> {
  const { app, dependencies } = context;

  if (!deleteVolumes) {
    const retained = [...plan.owned].sort();
    const command = retained.length === 0 ? null : `podman volume rm ${retained.join(" ")}`;
    for (const name of retained) {
      info(context, `kept volume ${name}; delete it with "podman volume rm ${name}"`);
    }
    for (const volume of plan.refused) {
      info(context, `refused to touch volume ${volume.name} (${volume.reason})`);
    }

    return { deleted: [], retained, refused: plan.refused, deleteCommand: command };
  }

  const deleted: string[] = [];
  const failures: string[] = [];

  for (const name of plan.owned) {
    emit(context, "removing-volumes", `removing volume ${name}`);
    try {
      await dependencies.volumes.remove(name);
      deleted.push(name);
      info(context, `removed volume ${name}`);
    } catch (error) {
      failures.push(`${name} (${messageOf(error)})`);
      warn(context, `could not remove volume ${name}: ${messageOf(error)}`);
    }
  }

  for (const volume of plan.refused) {
    info(
      context,
      `refused to delete volume ${volume.name} (${volume.reason}); ` +
        "it is not labelled for this app",
    );
  }

  if (failures.length > 0) {
    throw new PrerequisiteError(
      `could not remove ${failures.length} volume(s) for app "${app}"; ` +
        "the app directory was kept so the removal can be retried",
      {
        code: REMOVE_FAILURE_CODES.VOLUME_REMOVE_FAILED,
        details: { app, failed: failures, deleted },
        remediation: `Run "podman volume ls", then retry "easy-host remove ${app} --volumes --yes".`,
      },
    );
  }

  return { deleted, retained: [], refused: plan.refused, deleteCommand: null };
}

/** Deletes the checkout, which is always `<appDir>/workspace`. */
function removeWorkspace(context: RemoveContext): { existed: boolean; deleted: boolean } {
  const target = context.workspace;

  if (!context.dependencies.files.exists(target)) {
    info(context, "no workspace directory to delete");
    return { existed: false, deleted: false };
  }

  emit(context, "removing-workspace", `deleting workspace ${target}`);
  try {
    context.dependencies.files.removeDirectory(target);
    return { existed: true, deleted: true };
  } catch (error) {
    warn(
      context,
      `could not delete workspace "${target}": ${messageOf(error)}; ` +
        "the app directory removal will remove it as well",
    );
    return { existed: true, deleted: false };
  }
}

/** Deletes the app directory last, so a failed step leaves a retryable app. */
function removeAppDirectory(context: RemoveContext): boolean {
  const target = context.appDirectory;

  emit(context, "removing-app", `deleting app directory ${target}`);
  try {
    context.dependencies.files.removeDirectory(target);
    return true;
  } catch (error) {
    throw new PrerequisiteError(`could not delete app directory "${target}": ${messageOf(error)}`, {
      code: REMOVE_FAILURE_CODES.APP_DIRECTORY_REMOVE_FAILED,
      details: { app: context.app, directory: target, reason: messageOf(error) },
      remediation: `Check permissions on "${target}", then retry "easy-host remove ${context.app} --yes".`,
      cause: error,
    });
  }
}

/** Reads `config.toml` for the declared volume names, but never blocks removal. */
function readSpec(context: RemoveContext): AppSpec | undefined {
  try {
    return context.dependencies.registry.readConfig(context.app);
  } catch (error) {
    warn(
      context,
      `config.toml could not be read (${messageOf(error)}); ` +
        "removal continues and volumes are identified by their Podman labels",
    );
    return undefined;
  }
}

/** Reads the recorded image pair; a missing or broken cache is advisory. */
function readState(context: RemoveContext): RemoveRecordedState | undefined {
  try {
    return context.dependencies.stateStore(context.record.directory).readCache();
  } catch (error) {
    warn(
      context,
      `state.json could not be read (${messageOf(error)}); ` +
        "only images labelled for the app can be identified",
    );
    return undefined;
  }
}

/**
 * Builds the volume plan. The full volume listing is inspected because an
 * unlabelled volume with the app's name pattern must be reported, not deleted;
 * a label-filtered listing could not see it (`RBK-FR-04`, `PRD-SP-07`).
 */
async function planVolumes(
  context: RemoveContext,
  spec: AppSpec | undefined,
  deleteRequested: boolean,
): Promise<VolumePlan> {
  const { app, dependencies } = context;
  const declared = declaredVolumeNames(spec, app);

  let listed: readonly RemoveVolumeEntry[];
  try {
    listed = await dependencies.volumes.list();
  } catch (error) {
    if (deleteRequested) {
      throw new PrerequisiteError(
        `could not list volumes for app "${app}": ${messageOf(error)}; nothing was deleted`,
        {
          code: REMOVE_FAILURE_CODES.VOLUME_LIST_FAILED,
          details: { app, reason: messageOf(error) },
          remediation: `Run "podman volume ls", then retry "easy-host remove ${app} --volumes --yes".`,
          cause: error,
        },
      );
    }

    warn(
      context,
      `could not list volumes (${messageOf(error)}); ` +
        "declared volumes are reported from config.toml and nothing is deleted",
    );

    return { owned: declared, refused: [] };
  }

  const owned: string[] = [];
  const refused: RemovedVolumeRefusal[] = [];

  for (const volume of [...listed].sort((left, right) => left.name.localeCompare(right.name))) {
    const owner = volume.labels?.[APP_LABEL] ?? volume.app;

    if (owner === app) {
      owned.push(volume.name);
      continue;
    }

    if (looksLikeAppVolume(app, volume.name, declared)) {
      refused.push({
        name: volume.name,
        reason: owner === undefined ? "unlabelled" : "foreign-label",
        detail:
          owner === undefined
            ? `expected ${APP_LABEL}=${app}, found no app label`
            : `expected ${APP_LABEL}=${app}, found ${APP_LABEL}=${owner}`,
      });
    }
  }

  return { owned, refused };
}

/**
 * Builds the image plan.
 *
 * An image is a candidate when it carries the app label *or* when the app's own
 * `state.json` recorded that exact reference. The recorded-reference fallback
 * is required because Railpack-built images do not carry labels yet; it is not
 * tag matching, because only the app's own recorded pair can authorize it. A
 * candidate is kept when another running container uses it, another app
 * records it, or it is labelled for another app.
 */
async function planImages(
  context: RemoveContext,
  state: RemoveRecordedState | undefined,
): Promise<ImagePlan> {
  const { app, dependencies } = context;

  let listed: readonly RemoveImageEntry[];
  try {
    listed = await dependencies.images.list();
  } catch (error) {
    throw new PrerequisiteError(
      `could not list images for app "${app}": ${messageOf(error)}; nothing was deleted`,
      {
        code: REMOVE_FAILURE_CODES.IMAGE_LIST_FAILED,
        details: { app, reason: messageOf(error) },
        remediation: `Run "podman images", then retry "easy-host remove ${app} --yes".`,
        cause: error,
      },
    );
  }

  const recorded = recordedReferences(state);
  const shared = collectSharedReferences(context);
  const images = [...listed].sort((left, right) => left.reference.localeCompare(right.reference));
  const deleteRefs: string[] = [];
  const keep: RemovedImageKeep[] = [];

  for (const image of images) {
    const owner = image.labels?.[APP_LABEL];
    const isLabelled = owner === app;
    const isRecorded = recorded.includes(image.reference);
    if (!isLabelled && !isRecorded) {
      continue;
    }

    if (owner !== undefined && owner !== app) {
      keep.push({
        reference: image.reference,
        reason: "foreign-label",
        detail: `expected ${APP_LABEL}=${app}, found ${APP_LABEL}=${owner}`,
      });
      continue;
    }

    const sharedWith = shared.get(image.reference);
    if (sharedWith !== undefined) {
      keep.push({
        reference: image.reference,
        reason: "shared",
        sharedWith: [...sharedWith].sort(),
      });
      continue;
    }

    const users = (image.containers ?? []).filter((name) => name !== context.container);
    if (users.length > 0) {
      keep.push({
        reference: image.reference,
        reason: "in-use",
        containers: users,
      });
      continue;
    }

    if (image.reference.trim().length === 0) {
      keep.push({
        reference: image.reference,
        reason: "unreferenced",
        detail: "the image has no reference or id to remove",
      });
      continue;
    }

    deleteRefs.push(image.reference);
  }

  const listedRefs = new Set(images.map((image) => image.reference));
  const missing = recorded.filter((reference) => !listedRefs.has(reference));

  return { delete: deleteRefs, keep, missing };
}

/** Recorded current/previous references, de-duplicated and non-empty. */
function recordedReferences(state: RemoveRecordedState | undefined): string[] {
  const references = [state?.images.current, state?.images.previous].filter(
    (reference): reference is string =>
      typeof reference === "string" && reference.trim().length > 0,
  );

  return [...new Set(references)].sort();
}

/**
 * Collects the recorded image pairs of every other app.
 *
 * An unreadable state cache means sharing cannot be ruled out, so the whole
 * removal stops before any mutation rather than deleting a possibly shared
 * image (`PRD-SP-07`).
 */
function collectSharedReferences(context: RemoveContext): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();

  for (const entry of context.dependencies.registry.list()) {
    if (entry.name === context.app) {
      continue;
    }

    let state: RemoveRecordedState | undefined;
    try {
      state = context.dependencies.stateStore(entry.directory).readCache();
    } catch (error) {
      throw new PrerequisiteError(
        `could not read the recorded images of app "${entry.name}": ${messageOf(error)}; ` +
          "sharing cannot be ruled out, so nothing was deleted",
        {
          code: REMOVE_FAILURE_CODES.IMAGE_LIST_FAILED,
          details: { app: context.app, otherApp: entry.name, reason: messageOf(error) },
          remediation: `Run "easy-host status ${entry.name}" and "easy-host doctor", then retry "easy-host remove ${context.app} --yes".`,
          cause: error,
        },
      );
    }

    for (const reference of recordedReferences(state)) {
      const owners = references.get(reference) ?? new Set<string>();
      owners.add(entry.name);
      references.set(reference, owners);
    }
  }

  return references;
}

/** Names declared by `config.toml`, used when the volume listing is unavailable. */
function declaredVolumeNames(spec: AppSpec | undefined, app: string): string[] {
  if (spec === undefined) {
    return [];
  }

  return Object.keys(spec.volumes)
    .map((volume) => volumeName(app, volume))
    .sort();
}

/** True for a volume name that belongs to the app's namespace. */
function looksLikeAppVolume(app: string, name: string, declared: readonly string[]): boolean {
  if (declared.includes(name)) {
    return true;
  }

  const prefix = containerName(app);
  return name === prefix || name.startsWith(`${prefix}-`);
}

/**
 * Proves the resolved app directory really is `<appsDir>/<app>`. The check
 * runs before the first mutation, so a hostile or buggy registry cannot make
 * this command delete a host path (`PRD-C-08`).
 */
function assertAppDirectory(app: string, record: AppRecord, appsDir: string | undefined): string {
  const directory = path.resolve(record.directory);

  if (path.basename(directory) !== app) {
    throw new UsageError(
      `refusing to remove app "${app}": its directory is not named after the app`,
      {
        code: REMOVE_FAILURE_CODES.APP_DIRECTORY_UNSAFE,
        details: { app, directory },
        remediation: `Inspect "${directory}" manually; easy-host only deletes apps/<name>.`,
      },
    );
  }

  if (appsDir !== undefined && path.dirname(directory) !== path.resolve(appsDir)) {
    throw new UsageError(
      `refusing to remove app "${app}": its directory is outside the apps directory`,
      {
        code: REMOVE_FAILURE_CODES.APP_DIRECTORY_UNSAFE,
        details: { app, directory, appsDirectory: path.resolve(appsDir) },
        remediation: `Inspect "${directory}" manually; easy-host only deletes apps/<name>.`,
      },
    );
  }

  return directory;
}

/** Proves the workspace is exactly `<appDir>/workspace`, never a host path. */
function assertWorkspacePath(record: AppRecord): string {
  const directory = path.resolve(record.directory);
  const workspace = path.resolve(record.workspacePath);
  const expected = path.join(directory, WORKSPACE_DIRECTORY_NAME);

  if (workspace !== expected) {
    throw new UsageError("refusing to delete a workspace outside the app directory", {
      code: REMOVE_FAILURE_CODES.WORKSPACE_UNSAFE,
      details: { workspace, expected },
      remediation: `Inspect "${workspace}" manually; easy-host only deletes "<app>/workspace".`,
    });
  }

  return workspace;
}

function buildSkipped(deleteVolumes: boolean, volumeCount: number): string[] {
  if (deleteVolumes) {
    return ["image build", "image retention"];
  }

  return volumeCount > 0
    ? ["image build", "image retention", "volume deletion (pass --volumes)"]
    : ["image build", "image retention"];
}

function buildNotes(
  context: RemoveContext,
  spec: AppSpec | undefined,
  deleteVolumes: boolean,
  preview: RemovePreview,
): string[] {
  const notes = [
    "no host path was deleted; only the app directory, its workspace, app images, and explicitly requested volumes were removed",
  ];

  if (!deleteVolumes && preview.keptVolumes.length > 0) {
    notes.push(`named volumes were kept: ${preview.keptVolumes.join(", ")}`);
  }

  if (preview.refusedVolumes.length > 0) {
    notes.push(
      `refused to delete ${preview.refusedVolumes
        .map((volume) => `${volume.name} (${volume.reason})`)
        .join(", ")}`,
    );
  }

  if (spec?.local_path !== undefined) {
    notes.push(
      `the app used local-mode source "${spec.local_path}" inside the app directory; it was deleted with the app directory`,
    );
  }

  if (context.record.workspacePath !== context.workspace) {
    notes.push("the workspace path was normalised before deletion");
  }

  return notes;
}

function confirmationRequiredError(app: string, record: AppRecord): UsageError {
  return new UsageError(
    `remove of "${app}" requires confirmation; stdin is not a terminal and --yes was not passed`,
    {
      code: REMOVE_FAILURE_CODES.CONFIRMATION_REQUIRED,
      details: {
        app,
        stdin: "not a tty",
        container: containerName(app),
        appDirectory: record.directory,
      },
      remediation: `Nothing was deleted. Re-run "easy-host remove ${app} --yes" to proceed, or "easy-host remove ${app} --yes --volumes" to also delete its named volumes.`,
    },
  );
}

function resolveDependencies(
  overrides: RemoveDependencyOverrides,
  environment: NodeJS.ProcessEnv,
  clock: () => Date,
): RemoveDependencies {
  const paths = createPaths({ env: environment });

  return {
    registry: overrides.registry ?? new Registry(paths),
    runtime: overrides.runtime ?? createDefaultRemoveRuntime(),
    images: overrides.images ?? createDefaultRemoveImageStore(),
    volumes: overrides.volumes ?? createDefaultRemoveVolumeStore(),
    stateStore: overrides.stateStore ?? ((appDir) => new StateStore(appDir, { clock })),
    files: overrides.files ?? createDefaultRemoveFileSystem(),
    output: overrides.output ?? createDefaultRemoveOutput(),
    confirm: overrides.confirm ?? createDefaultRemoveConfirmer(),
    environment,
    clock,
    ...(overrides.lock === undefined ? {} : { lock: overrides.lock }),
  };
}

/**
 * The image surface production uses. It lists every local image plus the
 * running containers, so a recorded-but-unlabelled image can still be proven
 * unused before removal. The shared Podman runner keeps argument arrays,
 * finite timeouts, and redacted failures (`PRD-SP-04`, `PRD-NF-05`,
 * `PRD-NF-10`).
 */
export function createDefaultRemoveImageStore(
  options: RemoveImageStoreOptions = {},
): RemoveImageStore {
  const runner = options.runner ?? createDefaultPodmanRunner();
  const timeoutMs = options.timeoutMs ?? REMOVE_IMAGE_TIMEOUT_MS;

  return {
    async list() {
      const images = await invokePodman(
        runner,
        ["images", "--format", "json"],
        timeoutMs,
        "the local images could not be listed",
      );
      assertSucceeded(images, {
        message: "the local images could not be listed",
        code: REMOVE_FAILURE_CODES.IMAGE_LIST_FAILED,
        timeoutMs,
      });

      const containers = await invokePodman(
        runner,
        ["ps", "--format", "json"],
        timeoutMs,
        "the running containers could not be listed",
      );
      assertSucceeded(containers, {
        message: "the running containers could not be listed",
        code: REMOVE_FAILURE_CODES.IMAGE_LIST_FAILED,
        timeoutMs,
      });

      return normalizeImageList(images.stdout, containers.stdout);
    },

    async remove(reference) {
      if (typeof reference !== "string" || reference.trim().length === 0) {
        throw new UsageError("remove requires a non-empty image reference", {
          code: REMOVE_FAILURE_CODES.INVALID_APP,
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
        code: REMOVE_FAILURE_CODES.IMAGE_REMOVE_FAILED,
        image: reference,
        timeoutMs,
      });

      return { reference, removed: true };
    },
  };
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
      remediation: 'Run "podman images" manually, then "easy-host doctor".',
    });
  }

  return result;
}

function assertSucceeded(
  result: PodmanCommandResult,
  context: {
    readonly message: string;
    readonly code: string;
    readonly image?: string;
    readonly timeoutMs: number;
  },
): void {
  if (result.exitCode === 0 && result.spawnError === undefined) {
    return;
  }

  const reason = summarizePodmanOutput(result);
  const details: ErrorDetails = {
    ...(context.image === undefined ? {} : { image: context.image }),
    reason,
    timeoutMs: context.timeoutMs,
  };

  throw new PrerequisiteError(`${context.message}: ${reason}`, {
    code: context.code,
    details,
    remediation: 'Run "podman images" to inspect the local image set, then "easy-host doctor".',
  });
}

/**
 * Normalizes `podman images --format json` and `podman ps --format json`.
 * Names, ids, labels, and the running containers using each image are kept;
 * anything unreadable is ignored rather than guessed.
 */
function normalizeImageList(imagesJson: string, containersJson: string): RemoveImageEntry[] {
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

  const entries: RemoveImageEntry[] = [];
  for (const record of imageRecords) {
    const id = stringOf(record.Id) ?? stringOf(record.ID);
    const names = stringList(record.Names ?? record.RepoTags);
    const reference = names[0] ?? id;
    if (reference === undefined) {
      continue;
    }

    const labels = stringRecord(record.Labels ?? record.labels);
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
      code: REMOVE_FAILURE_CODES.IMAGE_LIST_FAILED,
      details: { subject, reason: messageOf(error) },
      remediation: `Run "podman ${subject === "images" ? "images" : "ps"}" manually, then "easy-host doctor".`,
      cause: error,
    });
  }

  if (!Array.isArray(value)) {
    throw new PrerequisiteError(`podman returned a non-list document for ${subject}`, {
      code: REMOVE_FAILURE_CODES.IMAGE_LIST_FAILED,
      details: { subject },
      remediation: `Run "podman ${subject === "images" ? "images" : "ps"}" manually, then "easy-host doctor".`,
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

function emit(context: RemoveContext, phase: RemovePhase, message: string): void {
  context.phases.push(phase);
  try {
    context.output.phase(phase, message);
  } catch {
    // Progress output is advisory; a broken stream must not corrupt removal.
  }
}

function emitPhase(output: RemoveOutput, phase: RemovePhase, message: string): void {
  try {
    output.phase(phase, message);
  } catch {
    // See emit.
  }
}

function info(context: RemoveContext, message: string): void {
  try {
    context.output.info(message);
  } catch {
    // See emit.
  }
}

function warn(context: RemoveContext, message: string): void {
  context.warnings.push(message);
  try {
    context.output.warn(message);
  } catch {
    // See emit.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
