/**
 * Removal orchestration and command (`RBK-1.3`, RBK-FR-03, RBK-FR-04,
 * RBK-FR-05, RBK-NF-01, PRD-C-08).
 *
 * Every test uses the real filesystem registry and state cache under a
 * temporary state root, and injects the container runtime, image store, volume
 * store, output, and confirmation. That combination proves the files actually
 * disappear, while no Podman process, terminal, or network is involved.
 *
 * The safety rules get their own assertions:
 *
 * - named volumes survive a default removal and their exact `podman volume rm`
 *   command is reported;
 * - `--volumes` deletes only volumes labelled for the app, and reports an
 *   unlabelled or foreign volume instead of touching it (`RBK-FR-04`);
 * - a non-TTY without `--yes` exits 1 before the lock or any mutation;
 * - a refused interactive confirmation deletes nothing;
 * - a held lock exits 6 and deletes nothing;
 * - a missing container is already absent, and the app directory still goes;
 * - an image shared with another app or used by another container is kept.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRemoveResult, runRemoveCommand } from "../../src/cli/commands/remove.js";
import {
  ConflictError,
  EXIT_CODES,
  NotFoundError,
  PrerequisiteError,
  UsageError,
} from "../../src/cli/errors.js";
import { validateAppSpec } from "../../src/config/parse.js";
import type { AppSpecInput } from "../../src/config/schema.js";
import {
  createDefaultRemoveImageStore,
  formatRemovePreview,
  REMOVE_FAILURE_CODES,
  type RemoveDependencies,
  type RemoveFileSystem,
  type RemoveImageEntry,
  type RemoveImageStore,
  type RemoveOutput,
  type RemovePhase,
  type RemovePreview,
  type RemoveRuntime,
  type RemoveVolumeEntry,
  type RemoveVolumeStore,
  removeApp,
} from "../../src/lifecycle/remove.js";
import { acquireAppLock } from "../../src/platform/lock.js";
import { createPaths, type Paths } from "../../src/platform/paths.js";
import {
  APP_LABEL,
  type ContainerRemoveResult,
  type ContainerStopResult,
  containerName,
  type PodmanCommandResult,
  type PodmanRunner,
  type RemoveContainerOptions,
  type StopContainerOptions,
} from "../../src/platform/podman.js";
import { StateStore } from "../../src/registry/state.js";
import { Registry } from "../../src/registry/store.js";

const APP = "blog";
const OTHER_APP = "api";
const REPO = "https://github.com/example/blog.git";
const CURRENT = "localhost/easy-host-blog:20261030T120000Z";
const OLDER = "localhost/easy-host-blog:20261029T120000Z";
const UNRELATED = "localhost/other-service:1";
const DATA_VOLUME = "easy-host-blog-data";
const FIXED_TIME = new Date("2026-10-30T12:00:00.000Z");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

class RecordingStream {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }
}

class RecordingOutput implements RemoveOutput {
  readonly phases: RemovePhase[] = [];
  readonly lines: string[] = [];

  phase(phase: RemovePhase, message: string): void {
    this.phases.push(phase);
    this.lines.push(`remove: ${phase}: ${message}`);
  }

  info(message: string): void {
    this.lines.push(`remove: ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`remove: warning: ${message}`);
  }

  get text(): string {
    return this.lines.join("\n");
  }
}

interface RuntimeCall {
  readonly method: string;
  readonly options: Record<string, unknown>;
}

class FakeRuntime implements RemoveRuntime {
  readonly calls: RuntimeCall[] = [];
  stopError: Error | undefined;
  removeError: Error | undefined;
  removed = true;

  async stopContainer(options: StopContainerOptions): Promise<ContainerStopResult> {
    this.calls.push({ method: "stopContainer", options: { ...options } });
    if (this.stopError !== undefined) {
      throw this.stopError;
    }

    return { app: options.app, container: containerName(options.app), stopped: true };
  }

  async removeContainer(options: RemoveContainerOptions): Promise<ContainerRemoveResult> {
    this.calls.push({ method: "removeContainer", options: { ...options } });
    if (this.removeError !== undefined) {
      throw this.removeError;
    }

    return { app: options.app, container: containerName(options.app), removed: this.removed };
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

class FakeImages implements RemoveImageStore {
  readonly removed: string[] = [];
  entries: RemoveImageEntry[] = [];
  listError: Error | undefined;
  removeError: Error | undefined;

  async list(): Promise<readonly RemoveImageEntry[]> {
    if (this.listError !== undefined) {
      throw this.listError;
    }

    return this.entries;
  }

  async remove(reference: string): Promise<unknown> {
    if (this.removeError !== undefined) {
      throw this.removeError;
    }

    this.removed.push(reference);
    return { reference, removed: true };
  }
}

class FakeVolumes implements RemoveVolumeStore {
  readonly removed: string[] = [];
  entries: RemoveVolumeEntry[] = [];
  listError: Error | undefined;
  removeError: Error | undefined;

  async list(): Promise<readonly RemoveVolumeEntry[]> {
    if (this.listError !== undefined) {
      throw this.listError;
    }

    return this.entries;
  }

  async remove(name: string): Promise<unknown> {
    if (this.removeError !== undefined) {
      throw this.removeError;
    }

    this.removed.push(name);
    return { name, removed: true };
  }
}

class RecordingFiles implements RemoveFileSystem {
  readonly removed: string[] = [];

  exists(target: string): boolean {
    return existsSync(target);
  }

  removeDirectory(target: string): void {
    this.removed.push(target);
    rmSync(target, { recursive: true, force: true });
  }
}

class FakeConfirmer {
  readonly previews: RemovePreview[] = [];
  calls = 0;
  answer: boolean | undefined = true;
  failure: Error | undefined;

  async confirm(preview: RemovePreview): Promise<boolean | undefined> {
    this.calls += 1;
    this.previews.push(preview);
    if (this.failure !== undefined) {
      throw this.failure;
    }

    return this.answer;
  }
}

function spec(overrides: Partial<AppSpecInput> = {}) {
  return validateAppSpec({
    repo: REPO,
    port: 8080,
    volumes: { data: "/var/lib/data" },
    ...overrides,
  });
}

interface Seed {
  readonly current: string | null;
  readonly previous: string | null;
}

interface HarnessOptions {
  readonly spec?: Partial<AppSpecInput>;
  readonly state?: Seed | null;
  readonly images?: readonly RemoveImageEntry[];
  readonly volumes?: readonly RemoveVolumeEntry[];
  readonly stopError?: Error;
  readonly imageListError?: Error;
  readonly volumeListError?: Error;
  readonly confirmAnswer?: boolean | undefined;
}

class Harness {
  readonly root: string;
  readonly paths: Paths;
  readonly registry: Registry;
  readonly runtime = new FakeRuntime();
  readonly images = new FakeImages();
  readonly volumes = new FakeVolumes();
  readonly files = new RecordingFiles();
  readonly output = new RecordingOutput();
  readonly confirmer = new FakeConfirmer();
  readonly appDir: string;
  readonly environment: NodeJS.ProcessEnv;

  constructor(options: HarnessOptions = {}) {
    this.root = mkdtempSync(path.join(tmpdir(), "easy-host-remove-"));
    roots.push(this.root);
    this.environment = { EASY_HOST_HOME: this.root };
    this.paths = createPaths({ env: this.environment });
    this.paths.ensureLayout();
    this.registry = new Registry(this.paths);
    this.registry.create(APP);
    this.registry.writeConfig(APP, spec(options.spec));
    this.appDir = this.registry.record(APP).directory;

    const state =
      options.state === undefined ? { current: CURRENT, previous: OLDER } : options.state;
    if (state !== null) {
      this.stateStore().update({
        images: { current: state.current, previous: state.previous },
        containerId: "container-current",
        health: {
          status: "healthy",
          checkedAt: FIXED_TIME.toISOString(),
          detail: "seeded by the test",
        },
      });
    }

    this.images.entries = [...(options.images ?? defaultImages())];
    this.volumes.entries = [...(options.volumes ?? defaultVolumes())];
    this.runtime.stopError = options.stopError;
    this.images.listError = options.imageListError;
    this.volumes.listError = options.volumeListError;
    this.confirmer.answer = options.confirmAnswer === undefined ? true : options.confirmAnswer;
  }

  stateStore(): StateStore {
    return new StateStore(this.appDir, { clock: () => FIXED_TIME });
  }

  otherAppState(state: Seed): void {
    this.registry.create(OTHER_APP);
    this.registry.writeConfig(OTHER_APP, spec({ port: 8081 }));
    const store = new StateStore(this.registry.record(OTHER_APP).directory, {
      clock: () => FIXED_TIME,
    });
    store.update({
      images: { current: state.current, previous: state.previous },
      containerId: "container-other",
      health: {
        status: "healthy",
        checkedAt: FIXED_TIME.toISOString(),
        detail: "seeded by the test",
      },
    });
  }

  dependencies(overrides: Partial<RemoveDependencies> = {}): RemoveDependencies {
    return {
      registry: this.registry,
      runtime: this.runtime,
      images: this.images,
      volumes: this.volumes,
      stateStore: (appDir) => new StateStore(appDir, { clock: () => FIXED_TIME }),
      files: this.files,
      output: this.output,
      confirm: (preview) => this.confirmer.confirm(preview),
      environment: this.environment,
      clock: () => FIXED_TIME,
      ...overrides,
    };
  }
}

function defaultImages(): RemoveImageEntry[] {
  return [
    {
      reference: CURRENT,
      id: "sha256:current",
      labels: { [APP_LABEL]: APP },
      containers: [],
    },
    { reference: OLDER, id: "sha256:older", labels: {}, containers: [] },
    { reference: UNRELATED, id: "sha256:other", labels: {}, containers: [] },
  ];
}

function defaultVolumes(): RemoveVolumeEntry[] {
  return [
    {
      name: DATA_VOLUME,
      app: APP,
      labels: { [APP_LABEL]: APP },
    },
    {
      name: "easy-host-blog-cache",
      labels: {},
    },
  ];
}

async function failureOf(action: Promise<unknown>): Promise<Error> {
  try {
    await action;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }

    throw error;
  }

  throw new Error("the action unexpectedly succeeded");
}

describe("removeApp", () => {
  it("removes the container, images, workspace, and app directory while keeping volumes", async () => {
    const harness = new Harness();

    const result = await removeApp(
      { app: APP, yes: true, interactive: false },
      harness.dependencies(),
    );

    expect(result.status).toBe("removed");
    expect(result.container).toEqual({
      name: containerName(APP),
      present: true,
      stopped: true,
      removed: true,
    });
    expect(result.images.removed.slice().sort()).toEqual([OLDER, CURRENT].sort());
    expect(harness.images.removed.slice().sort()).toEqual([OLDER, CURRENT].sort());
    expect(result.images.removed).not.toContain(UNRELATED);

    expect(harness.runtime.methods()).toEqual(["stopContainer", "removeContainer"]);
    expect(harness.runtime.calls[1]?.options).toMatchObject({ force: true, ignoreMissing: true });

    // Volumes are untouched without --volumes and their exact delete command is reported.
    expect(harness.volumes.removed).toEqual([]);
    expect(result.volumes.deleted).toEqual([]);
    expect(result.volumes.retained).toEqual([DATA_VOLUME]);
    expect(result.volumes.deleteCommand).toBe(`podman volume rm ${DATA_VOLUME}`);
    expect(result.volumes.refused.map((volume) => volume.name)).toEqual(["easy-host-blog-cache"]);
    expect(result.volumes.refused[0]?.reason).toBe("unlabelled");
    expect(result.skipped).toContain("volume deletion (pass --volumes)");

    // Both directories really disappear, and the registry no longer lists the app.
    expect(existsSync(path.join(harness.appDir, "workspace"))).toBe(false);
    expect(existsSync(harness.appDir)).toBe(false);
    expect(harness.files.removed).toEqual([path.join(harness.appDir, "workspace"), harness.appDir]);
    expect(harness.registry.list().map((entry) => entry.name)).toEqual([]);
  });

  it("deletes only volumes labelled for the app when --volumes is passed", async () => {
    const harness = new Harness({
      volumes: [
        { name: DATA_VOLUME, labels: { [APP_LABEL]: APP } },
        { name: "easy-host-blog-shared", labels: { [APP_LABEL]: OTHER_APP } },
        { name: "easy-host-blog-extra", labels: {} },
        { name: "easy-host-api-data", labels: { [APP_LABEL]: OTHER_APP } },
      ],
    });

    const result = await removeApp(
      { app: APP, yes: true, volumes: true, interactive: false },
      harness.dependencies(),
    );

    expect(harness.volumes.removed).toEqual([DATA_VOLUME]);
    expect(result.volumes.deleted).toEqual([DATA_VOLUME]);
    expect(result.volumes.retained).toEqual([]);
    expect(result.volumes.deleteCommand).toBeNull();
    expect(result.volumes.refused).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "easy-host-blog-shared", reason: "foreign-label" }),
        expect.objectContaining({ name: "easy-host-blog-extra", reason: "unlabelled" }),
      ]),
    );
    // Another app's differently named volume is not even a candidate.
    expect(result.volumes.refused.map((volume) => volume.name)).not.toContain("easy-host-api-data");
    expect(harness.volumes.removed).not.toContain("easy-host-blog-shared");
    expect(harness.volumes.removed).not.toContain("easy-host-blog-extra");
  });

  it("reports but never deletes a foreign volume", async () => {
    const harness = new Harness({
      volumes: [{ name: DATA_VOLUME, labels: { [APP_LABEL]: OTHER_APP } }],
    });

    const result = await removeApp(
      { app: APP, yes: true, volumes: true, interactive: false },
      harness.dependencies(),
    );

    expect(harness.volumes.removed).toEqual([]);
    expect(result.volumes.deleted).toEqual([]);
    expect(result.volumes.refused).toEqual([
      expect.objectContaining({ name: DATA_VOLUME, reason: "foreign-label" }),
    ]);
  });

  it("lets --force skip confirmation without deleting volumes", async () => {
    const harness = new Harness();

    const result = await removeApp(
      { app: APP, force: true, interactive: false },
      harness.dependencies(),
    );

    expect(harness.confirmer.calls).toBe(0);
    expect(result.volumes.retained).toEqual([DATA_VOLUME]);
    expect(harness.volumes.removed).toEqual([]);
    expect(existsSync(harness.appDir)).toBe(false);
  });

  it("exits 1 on a non-TTY without --yes before touching anything", async () => {
    const harness = new Harness();

    const error = await failureOf(
      removeApp({ app: APP, interactive: false }, harness.dependencies()),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(EXIT_CODES.USAGE);
    expect((error as UsageError).code).toBe(REMOVE_FAILURE_CODES.CONFIRMATION_REQUIRED);
    expect(harness.runtime.calls).toEqual([]);
    expect(harness.images.removed).toEqual([]);
    expect(harness.volumes.removed).toEqual([]);
    expect(harness.files.removed).toEqual([]);
    expect(existsSync(harness.appDir)).toBe(true);
    expect(existsSync(path.join(harness.appDir, ".lock"))).toBe(false);
  });

  it("deletes nothing when the interactive confirmation is refused", async () => {
    const harness = new Harness({ confirmAnswer: false });

    const error = await failureOf(
      removeApp({ app: APP, interactive: true }, harness.dependencies()),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(EXIT_CODES.USAGE);
    expect((error as UsageError).code).toBe(REMOVE_FAILURE_CODES.CANCELLED);
    expect(harness.confirmer.calls).toBe(1);
    expect(harness.confirmer.previews[0]?.images).toEqual([OLDER, CURRENT].sort());
    expect(harness.runtime.calls).toEqual([]);
    expect(harness.images.removed).toEqual([]);
    expect(harness.volumes.removed).toEqual([]);
    expect(harness.files.removed).toEqual([]);
    expect(existsSync(harness.appDir)).toBe(true);
  });

  it("exits 6 on lock contention and deletes nothing", async () => {
    const harness = new Harness();
    const lock = acquireAppLock(harness.appDir, {
      operation: "update",
      pid: process.pid,
    });

    try {
      const error = await failureOf(
        removeApp({ app: APP, yes: true, interactive: false }, harness.dependencies()),
      );

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).exitCode).toBe(EXIT_CODES.CONFLICT);
      expect((error as ConflictError).code).toBe("LOCK_HELD");
      expect(error.message).toContain('running "update"');
      expect(harness.runtime.calls).toEqual([]);
      expect(harness.images.removed).toEqual([]);
      expect(existsSync(harness.appDir)).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("treats an already-absent container as successful and still cleans the app", async () => {
    const harness = new Harness({
      stopError: new NotFoundError(`container "${containerName(APP)}" does not exist`, {
        code: "CONTAINER_NOT_FOUND",
      }),
    });
    harness.runtime.removed = false;

    const result = await removeApp(
      { app: APP, yes: true, interactive: false },
      harness.dependencies(),
    );

    expect(result.container).toEqual({
      name: containerName(APP),
      present: false,
      stopped: false,
      removed: false,
    });
    expect(result.images.removed.slice().sort()).toEqual([OLDER, CURRENT].sort());
    expect(existsSync(harness.appDir)).toBe(false);
  });

  it("keeps an image recorded by another app", async () => {
    const harness = new Harness();
    harness.otherAppState({ current: CURRENT, previous: null });

    const result = await removeApp(
      { app: APP, yes: true, interactive: false },
      harness.dependencies(),
    );

    expect(result.images.kept).toEqual([
      expect.objectContaining({ reference: CURRENT, reason: "shared", sharedWith: [OTHER_APP] }),
    ]);
    expect(harness.images.removed).not.toContain(CURRENT);
    expect(harness.images.removed).toContain(OLDER);
  });

  it("keeps an image used by another running container", async () => {
    const harness = new Harness({
      images: [
        {
          reference: CURRENT,
          id: "sha256:current",
          labels: { [APP_LABEL]: APP },
          containers: ["easy-host-other"],
        },
      ],
    });

    const result = await removeApp(
      { app: APP, yes: true, interactive: false },
      harness.dependencies(),
    );

    expect(result.images.kept).toEqual([
      expect.objectContaining({
        reference: CURRENT,
        reason: "in-use",
        containers: ["easy-host-other"],
      }),
    ]);
    expect(harness.images.removed).toEqual([]);
  });

  it("does not mistake the app's own container for a foreign user of its image", async () => {
    const harness = new Harness({
      images: [
        {
          reference: CURRENT,
          id: "sha256:current",
          labels: { [APP_LABEL]: APP },
          containers: [containerName(APP)],
        },
      ],
    });

    const result = await removeApp(
      { app: APP, yes: true, interactive: false },
      harness.dependencies(),
    );

    expect(result.images.removed).toEqual([CURRENT]);
    expect(result.images.kept).toEqual([]);
  });

  it("deletes nothing when the image listing fails", async () => {
    const harness = new Harness({
      imageListError: new Error("podman is not responding"),
    });

    const error = await failureOf(
      removeApp({ app: APP, yes: true, interactive: false }, harness.dependencies()),
    );

    expect(error).toBeInstanceOf(PrerequisiteError);
    expect((error as PrerequisiteError).code).toBe(REMOVE_FAILURE_CODES.IMAGE_LIST_FAILED);
    expect(harness.runtime.calls).toEqual([]);
    expect(harness.files.removed).toEqual([]);
    expect(existsSync(harness.appDir)).toBe(true);
  });

  it("removes an app whose config.toml is broken, relying on labels and state", async () => {
    const harness = new Harness();
    writeFileSync(path.join(harness.appDir, "config.toml"), "port = nope\n", "utf8");

    const result = await removeApp(
      { app: APP, yes: true, interactive: false },
      harness.dependencies(),
    );

    expect(result.status).toBe("removed");
    expect(harness.output.text).toContain("config.toml could not be read");
    expect(existsSync(harness.appDir)).toBe(false);
  });

  it("exits 5 for an unknown app", async () => {
    const harness = new Harness();

    const error = await failureOf(
      removeApp({ app: "missing", yes: true, interactive: false }, harness.dependencies()),
    );

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).exitCode).toBe(EXIT_CODES.NOT_FOUND);
    expect(harness.runtime.calls).toEqual([]);
  });
});

describe("runRemoveCommand", () => {
  it("prints every deleted and retained resource and exits 0", async () => {
    const harness = new Harness();
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();

    const exitCode = await runRemoveCommand({
      app: APP,
      yes: true,
      stdinIsTTY: false,
      stdout,
      stderr,
      environment: harness.environment,
      dependencies: harness.dependencies(),
    });

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(stdout.text).toContain(`removed "${APP}"`);
    expect(stdout.text).toContain(`container:  ${containerName(APP)} (removed)`);
    expect(stdout.text).toContain(DATA_VOLUME);
    expect(stdout.text).toContain(`podman volume rm ${DATA_VOLUME}`);
    expect(stderr.text).toBe("");
  });

  it("exits 1 on a non-TTY without --yes and leaves the app in place", async () => {
    const harness = new Harness();
    const stdout = new RecordingStream();
    const stderr = new RecordingStream();

    const exitCode = await runRemoveCommand({
      app: APP,
      stdinIsTTY: false,
      stdout,
      stderr,
      environment: harness.environment,
      dependencies: harness.dependencies(),
    });

    expect(exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.text).toContain("requires confirmation");
    expect(stdout.text).toBe("");
    expect(harness.runtime.calls).toEqual([]);
    expect(existsSync(harness.appDir)).toBe(true);
  });
});

describe("createDefaultRemoveImageStore", () => {
  it("lists every local image with its labels and running users", async () => {
    const runner = new QueueRunner([
      ok(
        JSON.stringify([
          {
            Id: "sha256:abc",
            Names: [CURRENT],
            Labels: { [APP_LABEL]: APP },
          },
          { Id: "sha256:def", Names: [OLDER], Labels: {} },
        ]),
      ),
      ok(
        JSON.stringify([
          { Id: "c1", Names: ["easy-host-blog"], Image: CURRENT },
          { Id: "c2", Names: ["easy-host-other"], ImageID: "sha256:def" },
        ]),
      ),
    ]);
    const store = createDefaultRemoveImageStore({ runner });

    const entries = await store.list();

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      reference: CURRENT,
      labels: { [APP_LABEL]: APP },
      containers: ["easy-host-blog"],
    });
    expect(entries[1]).toMatchObject({
      reference: OLDER,
      labels: {},
      containers: ["easy-host-other"],
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["images", "--format", "json"],
      ["ps", "--format", "json"],
    ]);
  });

  it("treats an already-missing image as success", async () => {
    const runner = new QueueRunner([
      { exitCode: 125, stdout: "", stderr: `Error: ${CURRENT}: no such image` },
    ]);
    const store = createDefaultRemoveImageStore({ runner });

    const result = await store.remove(CURRENT);

    expect(result).toEqual({ reference: CURRENT, removed: false });
    expect(runner.calls[0]?.args).toEqual(["image", "rm", CURRENT]);
  });

  it("removes an existing image by reference", async () => {
    const runner = new QueueRunner([ok(`${CURRENT}\n`)]);
    const store = createDefaultRemoveImageStore({ runner });

    const result = await store.remove(CURRENT);

    expect(result).toEqual({ reference: CURRENT, removed: true });
    expect(runner.calls[0]?.args).toEqual(["image", "rm", CURRENT]);
  });

  it("fails with exit 2 when the image listing fails", async () => {
    const runner = new QueueRunner([
      { exitCode: 1, stdout: "", stderr: "cannot connect to Podman" },
    ]);
    const store = createDefaultRemoveImageStore({ runner });

    const error = await failureOf(store.list());

    expect(error).toBeInstanceOf(PrerequisiteError);
    expect((error as PrerequisiteError).code).toBe(REMOVE_FAILURE_CODES.IMAGE_LIST_FAILED);
  });
});

class QueueRunner implements PodmanRunner {
  readonly calls: Array<{ readonly args: readonly string[] }> = [];
  readonly #results: PodmanCommandResult[];

  constructor(results: readonly PodmanCommandResult[]) {
    this.#results = [...results];
  }

  run(_command: string, args: readonly string[]): PodmanCommandResult {
    this.calls.push({ args });
    const next = this.#results.shift();
    if (next === undefined) {
      throw new Error("test did not queue a podman result");
    }

    return next;
  }
}

function ok(stdout: string): PodmanCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("formatRemovePreview", () => {
  it("names the container, images, directories, kept volumes, and refused volumes", () => {
    const preview: RemovePreview = {
      app: APP,
      container: containerName(APP),
      workspace: "/state/apps/blog/workspace",
      appDirectory: "/state/apps/blog",
      images: [CURRENT],
      keptImages: [{ reference: OLDER, reason: "shared" }],
      volumes: [],
      keptVolumes: [DATA_VOLUME],
      refusedVolumes: [{ name: "easy-host-blog-extra", reason: "unlabelled" }],
      deleteVolumes: false,
    };

    const text = formatRemovePreview(preview);

    expect(text).toContain(`delete app "${APP}"?`);
    expect(text).toContain(`container:  ${containerName(APP)}`);
    expect(text).toContain(CURRENT);
    expect(text).toContain(DATA_VOLUME);
    expect(text).toContain("pass --volumes to delete");
    expect(text).toContain("easy-host-blog-extra (unlabelled)");
    expect(text).toContain(`${OLDER} (shared)`);
  });
});

describe("formatRemoveResult", () => {
  it("reports kept images and the exact volume deletion command", () => {
    const text = formatRemoveResult({
      status: "removed",
      app: APP,
      container: { name: containerName(APP), present: true, stopped: true, removed: true },
      images: { removed: [], kept: [{ reference: CURRENT, reason: "in-use" }], missing: [] },
      volumes: {
        deleted: [],
        retained: [DATA_VOLUME],
        refused: [{ name: "easy-host-blog-extra", reason: "unlabelled" }],
        deleteCommand: `podman volume rm ${DATA_VOLUME}`,
      },
      workspace: { path: "/state/apps/blog/workspace", deleted: true },
      appDirectory: { path: "/state/apps/blog", deleted: true },
      skipped: [],
      phases: [],
      warnings: [],
      notes: [],
    });

    expect(text).toContain(`${CURRENT} (in-use)`);
    expect(text).toContain("easy-host-blog-extra (unlabelled)");
    expect(text).toContain(`next:       podman volume rm ${DATA_VOLUME}`);
  });
});
