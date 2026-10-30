/**
 * Drift detection coverage (`OBS-1.3`, `OBS-FR-03`, `PRD-NF-06`).
 *
 * Every case supplies recorded state and an inspect observation directly, so
 * the suite exercises each drift class without Podman, a container, or a
 * network call. The one filesystem case uses a temporary app directory to
 * prove that an absent `state.json` is treated as missing history rather than
 * a crash.
 *
 * The tests also pin the three properties the feature contract cares about:
 * detection is read-only (a deeply frozen input is accepted), a failed inspect
 * is `unknown` and never `healthy`, and every non-clean report names the
 * update action that would repair it.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectDriftReports,
  compareContainerIds,
  compareImageReferences,
  type DriftContainer,
  type DriftInput,
  type DriftRecordedState,
  detectDrift,
  uncheckedDrift,
} from "../../src/registry/drift.js";
import type { HealthStatus } from "../../src/registry/state.js";
import { StateStore } from "../../src/registry/state.js";

const APP = "blog";
const CURRENT_IMAGE = "localhost/easy-host-blog:20261030T120000Z";
const PREVIOUS_IMAGE = "localhost/easy-host-blog:20261029T090000Z";
const OTHER_IMAGE = "localhost/easy-host-blog:20261031T080000Z";
const CONTAINER_ID = "4f2c9a1b7d3e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcd";
const OTHER_CONTAINER_ID = "9a8b7c6d5e4f302112031425364758697a8b9c0d1e2f3a4b5c6d7e8f90123456";
const CHECKED_AT = "2026-10-30T12:00:00.000Z";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface StateOptions {
  readonly current?: string | null;
  readonly previous?: string | null;
  readonly containerId?: string | null;
  readonly health?: HealthStatus;
  readonly checkedAt?: string | null;
  readonly detail?: string | null;
}

function recordedState(options: StateOptions = {}): DriftRecordedState {
  return {
    images: {
      current: options.current === undefined ? CURRENT_IMAGE : options.current,
      previous: options.previous === undefined ? PREVIOUS_IMAGE : options.previous,
    },
    containerId: options.containerId === undefined ? CONTAINER_ID : options.containerId,
    health: {
      status: options.health ?? "healthy",
      checkedAt: options.checkedAt === undefined ? CHECKED_AT : options.checkedAt,
      detail:
        options.detail === undefined
          ? "probe http://127.0.0.1:8080/ healthy after 1 attempt(s)"
          : options.detail,
    },
  };
}

interface ContainerOptions {
  readonly id?: string;
  readonly image?: string;
  readonly running?: boolean;
  readonly state?: string;
  readonly exitCode?: number;
}

function container(options: ContainerOptions = {}): DriftContainer {
  return {
    id: options.id ?? CONTAINER_ID,
    image: options.image ?? CURRENT_IMAGE,
    running: options.running ?? true,
    state: options.state ?? (options.running === false ? "exited" : "running"),
    exitCode: options.exitCode ?? (options.running === false ? 137 : 0),
  };
}

function observed(options: ContainerOptions = {}): DriftInput["observation"] {
  return { status: "observed", container: container(options) };
}

function detect(overrides: Partial<DriftInput> = {}) {
  return detectDrift({
    app: APP,
    state: recordedState(),
    observation: observed(),
    ...overrides,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }

  return value;
}

describe("clean app", () => {
  it("reports no drift and no update work when everything agrees", () => {
    const report = detect();

    expect(report).toMatchObject({
      app: APP,
      drift: "none",
      drifted: false,
      statePresent: true,
      recordedImage: CURRENT_IMAGE,
      liveImage: CURRENT_IMAGE,
      containerIdMatches: true,
    });
    expect(report.classes).toEqual([]);
    expect(report.summary).toContain("recorded state matches Podman");
    expect(report.recommendedAction.kind).toBe("no-op");
    expect(report.recommendedAction.command).toBeNull();
  });

  it("stays clean when only the recorded container id is stale", () => {
    const report = detect({
      state: recordedState({ containerId: OTHER_CONTAINER_ID }),
    });

    expect(report.drift).toBe("none");
    expect(report.drifted).toBe(false);
    expect(report.containerIdMatches).toBe(false);
    expect(report.notes.join(" ")).toContain("container was recreated");
  });

  it("accepts a short recorded id that prefixes the live id", () => {
    const report = detect({
      state: recordedState({ containerId: CONTAINER_ID.slice(0, 12) }),
    });

    expect(report.containerIdMatches).toBe(true);
    expect(report.drift).toBe("none");
  });

  it("treats a localhost/ prefix as the same local image", () => {
    const report = detect({
      state: recordedState({ current: "easy-host-blog:20261030T120000Z" }),
    });

    expect(report.drift).toBe("none");
    expect(
      compareImageReferences(
        "easy-host-blog:20261030T120000Z",
        "localhost/easy-host-blog:20261030T120000Z",
      ),
    ).toBe(true);
  });
});

describe("missing container", () => {
  it("classifies a vanished container and recommends a recreate", () => {
    const report = detect({ observation: { status: "missing" } });

    expect(report.drift).toBe("missing-container");
    expect(report.drifted).toBe(true);
    expect(report.classes).toEqual(["missing-container"]);
    expect(report.liveImage).toBeNull();
    expect(report.containerIdMatches).toBe(false);
    expect(report.summary).toContain("is missing");
    expect(report.summary).toContain(CURRENT_IMAGE);
    expect(report.recommendedAction.kind).toBe("config-only");
    expect(report.recommendedAction.command).toBe("easy-host update blog");
    expect(report.recommendedAction.description).toContain("without a rebuild");
  });

  it("still classifies at least one drift class when no drift is unhealthy", () => {
    const report = detect({
      state: recordedState({ health: "unhealthy", detail: "old failure" }),
      observation: { status: "missing" },
    });

    expect(report.drift).toBe("missing-container");
    expect(report.classes).toContain("unhealthy-probe");
  });
});

describe("stopped container", () => {
  it("recommends a rebuild when a stopped container also runs the wrong image", () => {
    const report = detect({
      observation: observed({ running: false, image: OTHER_IMAGE }),
    });

    expect(report.drift).toBe("stopped-container");
    expect(report.classes).toEqual(["stopped-container", "image-mismatch"]);
    expect(report.recommendedAction.kind).toBe("rebuild");
    expect(report.recommendedAction.command).toBe("easy-host update blog --rebuild");
  });

  it("classifies a stopped container and recommends a recreate", () => {
    const report = detect({
      observation: observed({ running: false, state: "exited", exitCode: 137 }),
    });

    expect(report.drift).toBe("stopped-container");
    expect(report.classes).toEqual(["stopped-container"]);
    expect(report.summary).toContain("not running");
    expect(report.summary).toContain("exit 137");
    expect(report.recommendedAction.kind).toBe("config-only");
    expect(report.recommendedAction.command).toBe("easy-host update blog");
  });
});

describe("image mismatch", () => {
  it("classifies a different running image and recommends a rebuild", () => {
    const report = detect({
      observation: observed({ image: OTHER_IMAGE }),
    });

    expect(report.drift).toBe("image-mismatch");
    expect(report.classes).toEqual(["image-mismatch"]);
    expect(report.recordedImage).toBe(CURRENT_IMAGE);
    expect(report.liveImage).toBe(OTHER_IMAGE);
    expect(report.summary).toContain(CURRENT_IMAGE);
    expect(report.summary).toContain(OTHER_IMAGE);
    expect(report.recommendedAction.kind).toBe("rebuild");
    expect(report.recommendedAction.command).toBe("easy-host update blog --rebuild");
  });

  it("orders image drift before an unhealthy probe but lists both", () => {
    const report = detect({
      state: recordedState({ health: "unhealthy", detail: "connection refused" }),
      observation: observed({ image: OTHER_IMAGE }),
    });

    expect(report.drift).toBe("image-mismatch");
    expect(report.classes).toEqual(["image-mismatch", "unhealthy-probe"]);
  });

  it("does not claim drift when Podman reports only an image id", () => {
    const report = detect({
      observation: observed({ image: `sha256:${"a".repeat(64)}` }),
    });

    expect(report.drift).toBe("none");
    expect(report.notes.join(" ")).toContain("cannot be compared");
  });
});

describe("unhealthy probe", () => {
  it("classifies the last recorded failure and recommends a recreate", () => {
    const report = detect({
      state: recordedState({
        health: "unhealthy",
        detail: "probe http://127.0.0.1:8080/ failed: connection refused",
      }),
    });

    expect(report.drift).toBe("unhealthy-probe");
    expect(report.classes).toEqual(["unhealthy-probe"]);
    expect(report.summary).toContain("connection refused");
    expect(report.recommendedAction.kind).toBe("config-only");
    expect(report.recommendedAction.command).toBe("easy-host update blog");
  });

  it("ignores a never-probed healthy container rather than inventing drift", () => {
    const report = detect({ state: recordedState({ health: "unknown" }) });

    expect(report.drift).toBe("none");
    expect(report.recommendedAction.kind).toBe("config-only");
    expect(report.recommendedAction.description).toContain("No probe result");
  });
});

describe("failed inspect", () => {
  it("reports unknown, never healthy, and points at doctor", () => {
    const report = detect({
      observation: {
        status: "failed",
        reason: "could not inspect container: connection refused",
        code: "PODMAN_INSPECT_FAILED",
      },
    });

    expect(report.drift).toBe("unknown");
    expect(report.drifted).toBe(true);
    expect(report.classes).toEqual([]);
    expect(report.liveImage).toBeNull();
    expect(report.containerIdMatches).toBeNull();
    expect(report.summary).not.toContain("matches Podman");
    expect(report.summary).toContain("could not be determined");
    expect(report.recommendedAction.kind).toBe("investigate");
    expect(report.recommendedAction.command).toBe("easy-host doctor");
    expect(report.notes.join(" ")).toContain("connection refused");
  });

  it("redacts credentials and ANSI escapes from the failure reason", () => {
    const report = detect({
      observation: {
        status: "failed",
        reason: "\u001B[31mhttps://operator:hunter2@example.com/fail\u001B[0m",
      },
    });

    const rendered = `${report.summary} ${report.notes.join(" ")}`;
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("\u001B[");
    expect(rendered).toContain("example.com");
  });

  it("does not misreport a failed inspect as a missing container", () => {
    const report = detect({
      observation: { status: "failed", reason: "podman is not installed" },
    });

    expect(report.drift).not.toBe("missing-container");
    expect(report.drift).not.toBe("none");
    expect(report.drift).toBe("unknown");
  });
});

describe("missing state cache", () => {
  it("does not crash when state.json is absent", () => {
    const report = detect({ state: null });

    expect(report.drift).toBe("none");
    expect(report.drifted).toBe(false);
    expect(report.statePresent).toBe(false);
    expect(report.recordedImage).toBeNull();
    expect(report.liveImage).toBe(CURRENT_IMAGE);
    expect(report.notes.join(" ")).toContain("state.json is missing");
    expect(report.recommendedAction.kind).toBe("rebuild");
    expect(report.recommendedAction.command).toBe("easy-host update blog --rebuild");
  });

  it("classifies a missing container even without recorded history", () => {
    const report = detect({
      state: null,
      observation: { status: "missing" },
    });

    expect(report.drift).toBe("missing-container");
    expect(report.recordedImage).toBeNull();
    expect(report.summary).toContain("no recorded image");
    expect(report.recommendedAction.kind).toBe("rebuild");
    expect(report.recommendedAction.command).toBe("easy-host update blog --rebuild");
  });

  it("treats a deleted state.json on disk as absent history", () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-host-drift-"));
    roots.push(root);
    const appDir = path.join(root, "apps", APP);
    mkdirSync(appDir, { recursive: true });

    const store = new StateStore(appDir);
    expect(store.readCache()).toBeUndefined();

    const report = detect({
      state: store.readCache() ?? null,
      observation: observed(),
    });

    expect(report.statePresent).toBe(false);
    expect(report.drift).toBe("none");
    expect(report.recommendedAction.kind).toBe("rebuild");
  });
});

describe("read-only contract", () => {
  it("accepts deeply frozen inputs and mutates nothing", () => {
    const state = deepFreeze(recordedState());
    const observation = deepFreeze(observed());

    expect(() => detectDrift({ app: APP, state, observation })).not.toThrow();
    expect(state).toEqual(recordedState());
  });

  it("builds a batch in input order", () => {
    const reports = collectDriftReports([
      { app: "blog", state: recordedState(), observation: observed() },
      {
        app: "api",
        state: recordedState(),
        observation: { status: "missing" },
      },
    ]);

    expect(reports.map((report) => report.app)).toEqual(["blog", "api"]);
    expect(reports.map((report) => report.drift)).toEqual(["none", "missing-container"]);
  });

  it("never reports an unchecked app as clean", () => {
    const report = uncheckedDrift(APP, "the app directory has no valid config.toml");

    expect(report.drift).toBe("unknown");
    expect(report.drifted).toBe(true);
    expect(report.classes).toEqual([]);
    expect(report.recommendedAction.command).toBeNull();
    expect(report.summary).toContain("not checked");
  });
});

describe("comparison helpers", () => {
  it("compares container ids by exact value or unambiguous prefix", () => {
    expect(compareContainerIds(CONTAINER_ID, CONTAINER_ID)).toBe(true);
    expect(compareContainerIds(CONTAINER_ID.slice(0, 12), CONTAINER_ID)).toBe(true);
    expect(compareContainerIds(CONTAINER_ID, CONTAINER_ID.slice(0, 12))).toBe(true);
    expect(compareContainerIds(OTHER_CONTAINER_ID, CONTAINER_ID)).toBe(false);
    expect(compareContainerIds(null, CONTAINER_ID)).toBeNull();
    expect(compareContainerIds("", CONTAINER_ID)).toBeNull();
  });

  it("refuses to compare an unnamed or id-only live image", () => {
    expect(compareImageReferences(CURRENT_IMAGE, "")).toBeNull();
    expect(compareImageReferences(CURRENT_IMAGE, "unknown")).toBeNull();
    expect(compareImageReferences(CURRENT_IMAGE, `sha256:${"b".repeat(64)}`)).toBeNull();
    expect(compareImageReferences(null, CURRENT_IMAGE)).toBeNull();
    expect(compareImageReferences(CURRENT_IMAGE, OTHER_IMAGE)).toBe(false);
  });
});
