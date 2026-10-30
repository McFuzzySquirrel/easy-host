/**
 * Two-image retention (`RBK-1.2`, `RBK-FR-02`, `PRD-SP-07`).
 *
 * The image store, registry, state cache, and output are real seams: the
 * registry and `state.json` are the filesystem implementations under a
 * temporary state root, and only the image store is a recording fake. That way
 * every test proves what retention would actually do to Podman, not what a
 * stub returned.
 *
 * The suite covers the six cases the task names — two images, three images, an
 * image in use, a shared image, a missing image, an already-clean app — plus
 * the safety edges: a foreign label, an unlabelled tag that only *looks* like
 * the app, a failed removal, and an unreadable sibling app. The last group
 * exercises the production image store against a recording runner so its
 * argument array, JSON normalization, and error mapping are not left to
 * integration tests alone.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError, PrerequisiteError, UsageError } from "../../src/cli/errors.js";
import { validateAppSpec } from "../../src/config/parse.js";
import type { AppSpec, AppSpecInput } from "../../src/config/schema.js";
import {
  createDefaultRetainImageStore,
  createDefaultRetainOutput,
  RETAIN_FAILURE_CODES,
  type RetainDependencies,
  type RetainedImageEntry,
  type RetainImageListRequest,
  type RetainImageStore,
  type RetainOutput,
  type RetainPhase,
  type RetainResult,
  retainImages,
} from "../../src/lifecycle/retain.js";
import { createPaths, type Paths } from "../../src/platform/paths.js";
import {
  APP_LABEL,
  type PodmanCommandResult,
  type PodmanRunner,
} from "../../src/platform/podman.js";
import { StateStore } from "../../src/registry/state.js";
import { type AppRecord, Registry } from "../../src/registry/store.js";

const APP = "blog";
const OTHER_APP = "shop";
const REPO = "https://github.com/example/blog.git";
const CURRENT = "localhost/easy-host-blog:20261029T120000Z";
const OLDER = "localhost/easy-host-blog:20261028T120000Z";
const STALE = "localhost/easy-host-blog:20261027T120000Z";
const STALE_TWO = "localhost/easy-host-blog:20261026T120000Z";
const IN_USE = "localhost/easy-host-blog:20261025T120000Z";
const SHARED = "localhost/easy-host-blog:20261024T120000Z";
const FOREIGN = "localhost/easy-host-shop:20261023T120000Z";
const UNLABELLED = "localhost/easy-host-blog:20261022T120000Z";
const MISSING = "localhost/easy-host-blog:20261021T120000Z";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

class RecordingOutput implements RetainOutput {
  readonly phases: RetainPhase[] = [];
  readonly lines: string[] = [];

  phase(phase: RetainPhase, message: string): void {
    this.phases.push(phase);
    this.lines.push(`retain: ${phase}: ${message}`);
  }

  info(message: string): void {
    this.lines.push(`retain: ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`retain: warning: ${message}`);
  }

  get text(): string {
    return this.lines.join("\n");
  }
}

class FakeImages implements RetainImageStore {
  entries: RetainedImageEntry[] = [];
  readonly listRequests: RetainImageListRequest[] = [];
  readonly removed: string[] = [];
  listError: Error | undefined;
  readonly removeErrors = new Map<string, Error>();

  async list(request: RetainImageListRequest): Promise<readonly RetainedImageEntry[]> {
    this.listRequests.push(request);
    if (this.listError !== undefined) {
      throw this.listError;
    }

    return this.entries;
  }

  async remove(reference: string): Promise<unknown> {
    const failure = this.removeErrors.get(reference);
    if (failure !== undefined) {
      throw failure;
    }

    this.removed.push(reference);
    return { reference, removed: true };
  }
}

class RecordingRunner implements PodmanRunner {
  readonly calls: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly timeoutMs: number | undefined;
  }> = [];
  readonly results: PodmanCommandResult[] = [];

  run(
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs?: number } = {},
  ): PodmanCommandResult {
    this.calls.push({ command, args: [...args], timeoutMs: options.timeoutMs });
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error("test did not queue a podman result");
    }

    return next;
  }
}

function podman(stdout: string, exitCode = 0, stderr = ""): PodmanCommandResult {
  return { exitCode, stdout, stderr };
}

function spec(overrides: Partial<AppSpecInput> = {}): AppSpec {
  return validateAppSpec({
    repo: REPO,
    port: 8080,
    health_interval_ms: 10,
    health_timeout_ms: 10,
    health_startup_ms: 50,
    ...overrides,
  });
}

interface HarnessOptions {
  readonly seed?: "pair" | "one" | "none";
  readonly current?: string;
  readonly previous?: string | null;
  readonly spec?: Partial<AppSpecInput>;
}

class Harness {
  readonly root: string;
  readonly paths: Paths;
  readonly registry: Registry;
  readonly images = new FakeImages();
  readonly output = new RecordingOutput();
  readonly appDir: string;
  readonly record: AppRecord;

  constructor(options: HarnessOptions = {}) {
    this.root = mkdtempSync(path.join(tmpdir(), "easy-host-retain-"));
    roots.push(this.root);
    this.paths = createPaths({ env: { EASY_HOST_HOME: this.root } });
    this.paths.ensureLayout();
    this.registry = new Registry(this.paths);
    this.registry.create(APP);
    this.registry.writeConfig(APP, spec(options.spec));
    this.record = this.registry.record(APP);
    this.appDir = this.record.directory;

    const seed = options.seed ?? "pair";
    if (seed !== "none") {
      this.stateStore(this.appDir).update({
        images:
          seed === "one"
            ? { current: options.current ?? CURRENT, previous: null }
            : {
                current: options.current ?? CURRENT,
                previous: options.previous === undefined ? OLDER : options.previous,
              },
      });
    }
  }

  stateStore(appDir = this.appDir): StateStore {
    return new StateStore(appDir);
  }

  createApp(
    name: string,
    port: number,
    images: { current: string; previous?: string | null },
  ): void {
    this.registry.create(name);
    this.registry.writeConfig(name, spec({ port }));
    const record = this.registry.record(name);
    this.stateStore(record.directory).update({
      images: {
        current: images.current,
        previous: images.previous ?? null,
      },
    });
  }

  image(reference: string, overrides: Partial<RetainedImageEntry> = {}): RetainedImageEntry {
    return {
      reference,
      labels: { [APP_LABEL]: APP },
      ...overrides,
    };
  }

  dependencies(overrides: Partial<RetainDependencies> = {}): RetainDependencies {
    return {
      registry: this.registry,
      images: this.images,
      stateStore: (appDir) => this.stateStore(appDir),
      output: this.output,
      environment: {},
      ...overrides,
    };
  }

  run(
    request: { readonly current?: string | null; readonly previous?: string | null } = {},
    overrides: Partial<RetainDependencies> = {},
  ): Promise<RetainResult> {
    return retainImages({ app: APP, ...request }, this.dependencies(overrides));
  }
}

function retainedReferences(result: RetainResult): string[] {
  return result.retained.map((image) => image.reference).sort();
}

function reasonsFor(result: RetainResult, reference: string): readonly string[] {
  return result.retained.find((image) => image.reference === reference)?.reasons ?? [];
}

describe("RBK-FR-02 exactly the recorded pair survives", () => {
  it("keeps a clean app's current and previous image and removes nothing", async () => {
    const harness = new Harness();
    harness.images.entries = [harness.image(CURRENT), harness.image(OLDER)];

    const result = await harness.run();

    expect(result.status).toBe("retained");
    expect(result.examined).toBe(2);
    expect(retainedReferences(result)).toEqual([CURRENT, OLDER].sort());
    expect(reasonsFor(result, CURRENT)).toEqual(["current"]);
    expect(reasonsFor(result, OLDER)).toEqual(["previous"]);
    expect(result.removed).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(harness.images.removed).toEqual([]);
    expect(harness.images.listRequests).toEqual([{ app: APP }]);
    expect(result.phases).toEqual(["validating", "listing", "retaining", "retained"]);
    expect(result.notes.join(" ")).toContain("rollback target");
  });

  it("removes a third app image and reports it", async () => {
    const harness = new Harness();
    harness.images.entries = [harness.image(STALE), harness.image(CURRENT), harness.image(OLDER)];

    const result = await harness.run();

    expect(result.status).toBe("retained");
    expect(result.examined).toBe(3);
    expect(retainedReferences(result)).toEqual([CURRENT, OLDER].sort());
    expect(result.removed).toEqual([STALE]);
    expect(harness.images.removed).toEqual([STALE]);
    expect(result.refused).toEqual([]);
    expect(harness.output.phases).toContain("removing");
    expect(harness.output.text).toContain(`removed ${STALE}`);
    expect(result.notes.join(" ")).toContain(STALE);
  });

  it("keeps only the current image when no rollback target is recorded", async () => {
    const harness = new Harness({ seed: "one" });
    harness.images.entries = [harness.image(CURRENT), harness.image(STALE)];

    const result = await harness.run();

    expect(result.current).toBe(CURRENT);
    expect(result.previous).toBeNull();
    expect(retainedReferences(result)).toEqual([CURRENT]);
    expect(reasonsFor(result, CURRENT)).toEqual(["current"]);
    expect(result.removed).toEqual([STALE]);
    expect(result.notes.join(" ")).toContain("no previous image");
  });

  it("treats an identical current and previous reference as one image", async () => {
    const harness = new Harness({ seed: "pair", previous: CURRENT });
    harness.images.entries = [harness.image(CURRENT)];

    const result = await harness.run();

    expect(result.previous).toBeNull();
    expect(retainedReferences(result)).toEqual([CURRENT]);
    expect(result.removed).toEqual([]);
  });

  it("accepts an explicit pair instead of reading state.json", async () => {
    const harness = new Harness({ seed: "none" });
    harness.images.entries = [harness.image(CURRENT), harness.image(STALE)];

    const result = await harness.run({ current: CURRENT, previous: null });

    expect(result.current).toBe(CURRENT);
    expect(result.previous).toBeNull();
    expect(result.removed).toEqual([STALE]);
  });
});

describe("RBK-FR-02 in-use and shared images are never removed", () => {
  it("keeps an image used by a running container and still prunes the rest", async () => {
    const harness = new Harness();
    harness.images.entries = [
      harness.image(IN_USE, { containers: ["easy-host-shop"] }),
      harness.image(STALE),
      harness.image(CURRENT),
      harness.image(OLDER),
    ];

    const result = await harness.run();

    expect(retainedReferences(result)).toEqual([CURRENT, IN_USE, OLDER].sort());
    expect(reasonsFor(result, IN_USE)).toEqual(["in-use"]);
    expect(result.retained.find((image) => image.reference === IN_USE)?.containers).toEqual([
      "easy-host-shop",
    ]);
    expect(result.removed).toEqual([STALE]);
    expect(harness.images.removed).toEqual([STALE]);
  });

  it("keeps an image another app records as current or previous", async () => {
    const harness = new Harness();
    harness.createApp(OTHER_APP, 8081, { current: SHARED, previous: null });
    harness.images.entries = [
      harness.image(SHARED),
      harness.image(STALE),
      harness.image(CURRENT),
      harness.image(OLDER),
    ];

    const result = await harness.run();

    expect(retainedReferences(result)).toEqual([CURRENT, OLDER, SHARED].sort());
    expect(reasonsFor(result, SHARED)).toEqual(["shared"]);
    expect(result.retained.find((image) => image.reference === SHARED)?.sharedWith).toEqual([
      OTHER_APP,
    ]);
    expect(result.removed).toEqual([STALE]);
    expect(harness.images.removed).not.toContain(SHARED);
  });

  it("removes nothing when a sibling app's recorded images cannot be read", async () => {
    const harness = new Harness();
    harness.createApp(OTHER_APP, 8081, { current: SHARED });
    harness.images.entries = [harness.image(STALE), harness.image(CURRENT), harness.image(OLDER)];

    const result = await harness.run(
      {},
      {
        stateStore: (appDir) => {
          if (path.basename(appDir) === OTHER_APP) {
            return {
              readCache() {
                throw new Error("permission denied");
              },
            };
          }

          return harness.stateStore(appDir);
        },
      },
    );

    expect(result.removed).toEqual([]);
    expect(harness.images.removed).toEqual([]);
    expect(result.refused).toEqual([
      {
        reference: STALE,
        reason: "unverified-shared",
        detail: expect.stringContaining("another app"),
      },
    ]);
    expect(result.warnings.join(" ")).toContain("permission denied");
    expect(harness.output.text).toContain("no image will be removed");
  });
});

describe("RBK-FR-02 label-scoped removal (PRD-SP-07)", () => {
  it("reports an image labelled for another app and does not remove it", async () => {
    const harness = new Harness();
    harness.images.entries = [
      harness.image(FOREIGN, { labels: { [APP_LABEL]: OTHER_APP } }),
      harness.image(UNLABELLED, { labels: {} }),
      harness.image(CURRENT),
      harness.image(OLDER),
    ];

    const result = await harness.run();

    expect(result.removed).toEqual([]);
    expect(harness.images.removed).toEqual([]);
    expect(result.refused.map((entry) => [entry.reference, entry.reason])).toEqual([
      [UNLABELLED, "unknown-label"],
      [FOREIGN, "foreign-label"],
    ]);
    expect(result.notes.join(" ")).toContain("foreign-label");
    expect(result.notes.join(" ")).toContain("unknown-label");
  });

  it("does not remove an unlabelled tag that only looks like the app's image", async () => {
    const runner = new RecordingRunner();
    runner.results.push(
      podman(
        JSON.stringify([
          {
            Id: "sha256:aaaa",
            Names: [STALE],
            RepoTags: [STALE],
            Labels: null,
          },
        ]),
      ),
      podman("[]"),
    );

    const harness = new Harness();
    const result = await harness.run({}, { images: createDefaultRetainImageStore({ runner }) });

    expect(result.removed).toEqual([]);
    expect(result.refused).toEqual([
      expect.objectContaining({ reference: STALE, reason: "unknown-label" }),
    ]);
    expect(runner.calls.map((call) => call.args[0])).toEqual(["images", "ps"]);
    expect(runner.calls.some((call) => call.args[0] === "image")).toBe(false);
  });
});

describe("RBK-FR-02 missing images and failures are reported", () => {
  it("reports a recorded image that no longer exists and still prunes", async () => {
    const harness = new Harness({ seed: "pair", previous: MISSING });
    harness.images.entries = [harness.image(CURRENT), harness.image(STALE)];

    const result = await harness.run();

    expect(result.missing).toEqual([MISSING]);
    expect(result.retained).toEqual([{ reference: CURRENT, reasons: ["current"] }]);
    expect(result.removed).toEqual([STALE]);
    expect(result.warnings.join(" ")).toContain(MISSING);
    expect(harness.output.text).toContain("was not found");
  });

  it("treats an unlabelled image set as nothing to prune, without a warning", async () => {
    const harness = new Harness();
    harness.images.entries = [];

    const result = await harness.run();

    expect(result.status).toBe("retained");
    expect(result.examined).toBe(0);
    expect(result.missing).toEqual([CURRENT, OLDER].sort());
    expect(result.removed).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(harness.images.removed).toEqual([]);
  });

  it("keeps going when one removal fails and reports the refusal", async () => {
    const harness = new Harness();
    harness.images.entries = [
      harness.image(STALE),
      harness.image(STALE_TWO),
      harness.image(CURRENT),
      harness.image(OLDER),
    ];
    harness.images.removeErrors.set(STALE, new Error("image is in use"));

    const result = await harness.run();

    expect(harness.images.removed).toEqual([STALE_TWO]);
    expect(result.removed).toEqual([STALE_TWO]);
    expect(result.refused).toEqual([
      {
        reference: STALE,
        reason: "removal-failed",
        detail: "image is in use",
      },
    ]);
    expect(result.warnings.join(" ")).toContain("image is in use");
  });

  it("skips retention when no current image is recorded", async () => {
    const harness = new Harness({ seed: "none" });
    harness.images.entries = [harness.image(STALE)];

    const result = await harness.run();

    expect(result.status).toBe("skipped");
    expect(result.current).toBeNull();
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual(["image listing", "image removal"]);
    expect(result.phases).toEqual(["validating", "skipped"]);
    expect(harness.images.listRequests).toEqual([]);
    expect(harness.images.removed).toEqual([]);
    expect(result.notes.join(" ")).toContain("easy-host update");
  });

  it("rejects an unknown app before calling Podman", async () => {
    const harness = new Harness();

    await expect(retainImages({ app: "missing" }, harness.dependencies())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(harness.images.listRequests).toEqual([]);
  });

  it("rejects an empty app name as a usage error", async () => {
    const harness = new Harness();

    await expect(retainImages({ app: "  " }, harness.dependencies())).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(harness.images.listRequests).toEqual([]);
  });

  it("propagates a listing failure instead of guessing", async () => {
    const harness = new Harness();
    harness.images.listError = new PrerequisiteError("podman is unavailable", {
      code: "PODMAN_UNAVAILABLE",
    });

    await expect(harness.run()).rejects.toMatchObject({ exitCode: 2 });
    expect(harness.images.removed).toEqual([]);
  });
});

describe("production image store", () => {
  it("lists the app's labelled images and attributes running containers", async () => {
    const runner = new RecordingRunner();
    runner.results.push(
      podman(
        JSON.stringify([
          {
            Id: "sha256:1111",
            Names: [CURRENT],
            RepoTags: [CURRENT],
            Labels: { [APP_LABEL]: APP },
          },
          {
            Id: "sha256:2222",
            Names: [STALE],
            RepoTags: [STALE],
            Labels: { [APP_LABEL]: APP },
          },
        ]),
      ),
      podman(
        JSON.stringify([
          {
            Id: "container-1",
            Image: CURRENT,
            ImageID: "sha256:1111",
            Names: ["easy-host-blog"],
          },
          {
            Id: "container-2",
            Image: "localhost/easy-host-blog:alias",
            ImageID: "sha256:2222",
            Names: ["easy-host-blog-sidecar"],
          },
        ]),
      ),
    );

    const store = createDefaultRetainImageStore({ runner, timeoutMs: 1_234 });
    const entries = await store.list({ app: APP });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["images", "--filter", `label=${APP_LABEL}=${APP}`, "--format", "json"],
      ["ps", "--format", "json"],
    ]);
    expect(runner.calls.map((call) => call.timeoutMs)).toEqual([1_234, 1_234]);
    expect(entries).toEqual([
      {
        reference: CURRENT,
        id: "sha256:1111",
        labels: { [APP_LABEL]: APP },
        containers: ["easy-host-blog"],
      },
      {
        reference: STALE,
        id: "sha256:2222",
        labels: { [APP_LABEL]: APP },
        containers: ["easy-host-blog-sidecar"],
      },
    ]);
  });

  it("removes an image with an argument array and tolerates an absent image", async () => {
    const runner = new RecordingRunner();
    runner.results.push(podman(""), podman("", 125, "Error: image not known"));
    const store = createDefaultRetainImageStore({ runner });

    await expect(store.remove(STALE)).resolves.toEqual({ reference: STALE, removed: true });
    await expect(store.remove(STALE)).resolves.toEqual({ reference: STALE, removed: false });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["image", "rm", STALE],
      ["image", "rm", STALE],
    ]);
  });

  it("maps a failed listing to a prerequisite failure with a retention code", async () => {
    const runner = new RecordingRunner();
    runner.results.push(podman("", 125, "cannot connect to Podman"));
    const store = createDefaultRetainImageStore({ runner });

    const failure = await store.list({ app: APP }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PrerequisiteError);
    expect(failure).toMatchObject({
      exitCode: 2,
      code: RETAIN_FAILURE_CODES.LIST_FAILED,
    });
  });

  it("maps a failed removal to a prerequisite failure with a retention code", async () => {
    const runner = new RecordingRunner();
    runner.results.push(podman("", 125, "image is in use by a container"));
    const store = createDefaultRetainImageStore({ runner });

    const failure = await store.remove(STALE).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PrerequisiteError);
    expect(failure).toMatchObject({
      exitCode: 2,
      code: RETAIN_FAILURE_CODES.REMOVE_FAILED,
    });
    expect((failure as PrerequisiteError).details.image).toBe(STALE);
  });

  it("reports podman JSON that is not a list", async () => {
    const runner = new RecordingRunner();
    runner.results.push(podman("{}"), podman("[]"));
    const store = createDefaultRetainImageStore({ runner });

    await expect(store.list({ app: APP })).rejects.toMatchObject({
      code: RETAIN_FAILURE_CODES.LIST_FAILED,
    });
  });
});

describe("retention output", () => {
  it("writes every phase to the injected stream without ANSI escapes", () => {
    const chunks: string[] = [];
    const output = createDefaultRetainOutput({
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
    });

    output.phase("retained", `kept ${CURRENT}`);
    output.info(`removed ${STALE}`);
    output.warn("could not read state.json");

    expect(chunks.join("")).toBe(
      `retain: retained: kept ${CURRENT}\n` +
        `retain: removed ${STALE}\n` +
        "retain: warning: could not read state.json\n",
    );
    expect(chunks.join("")).not.toContain("\u001B[");
  });
});
