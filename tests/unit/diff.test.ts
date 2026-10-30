/**
 * Update diff classification (`UPD-FR-01`).
 *
 * The suite is pure: every input is a plain object and no Podman, filesystem,
 * clock, or registry is involved. Each config-only field gets its own case, the
 * three rebuild triggers are covered separately, and the state/container
 * edge cases prove that a missing cache or missing container can never produce
 * a false no-op.
 */

import { describe, expect, it } from "vitest";
import { validateAppSpec } from "../../src/config/parse.js";
import type { AppSpec, AppSpecInput } from "../../src/config/schema.js";
import {
  CONFIG_ONLY_CONFIG_FIELDS,
  classifyUpdate,
  REBUILD_CONFIG_FIELDS,
  type UpdateContainerObservation,
  type UpdateDiffInput,
  type UpdateRecordedState,
} from "../../src/lifecycle/diff.js";
import type { HealthStatus } from "../../src/registry/state.js";

const REPO = "https://github.com/example/blog.git";
const OTHER_REPO = "https://github.com/example/other.git";
const IMAGE = "localhost/easy-host-blog:20261030T120000Z";
const PREVIOUS = "localhost/easy-host-blog:20261029T120000Z";
const DRIFTED_IMAGE = "localhost/easy-host-blog:20261031T120000Z";

/** A fully-defaulted spec with an env table, a volume, and a secrets file. */
const BASE = spec({
  env: { LOG_LEVEL: "info" },
  env_file: "secrets.env",
  volumes: { data: "/var/lib/data" },
});

function spec(overrides: Partial<AppSpecInput> = {}): AppSpec {
  return validateAppSpec({ repo: REPO, port: 8080, ...overrides });
}

function localSpec(overrides: Partial<AppSpecInput> = {}): AppSpec {
  return validateAppSpec({ local_path: "workspace", port: 8080, ...overrides });
}

function specFrom(base: AppSpec, overrides: Partial<AppSpecInput>): AppSpec {
  return validateAppSpec({ ...base, ...overrides });
}

function recordedState(
  options: {
    readonly current?: string | null;
    readonly previous?: string | null;
    readonly health?: HealthStatus;
  } = {},
): UpdateRecordedState {
  return {
    images: {
      current: options.current === undefined ? IMAGE : options.current,
      previous: options.previous === undefined ? PREVIOUS : options.previous,
    },
    health: { status: options.health ?? "healthy" },
  };
}

function liveContainer(running = true, image: string | null = IMAGE): UpdateContainerObservation {
  return { state: { running }, image };
}

function input(overrides: Partial<UpdateDiffInput> = {}): UpdateDiffInput {
  return {
    current: BASE,
    desired: BASE,
    state: recordedState(),
    container: liveContainer(),
    ...overrides,
  };
}

const CONFIG_ONLY_CASES: ReadonlyArray<readonly [string, Partial<AppSpecInput>]> = [
  ["bind", { bind: "127.0.0.1" }],
  ["container_port", { container_port: 3001 }],
  ["env", { env: { LOG_LEVEL: "debug" } }],
  ["env_file", { env_file: "other.env" }],
  ["health_interval_ms", { health_interval_ms: 1000 }],
  ["health_path", { health_path: "/healthz" }],
  ["health_startup_ms", { health_startup_ms: 30_000 }],
  ["health_timeout_ms", { health_timeout_ms: 1000 }],
  ["port", { port: 8081 }],
  ["probe", { probe: "tcp" }],
  ["volumes", { volumes: { data: "/srv/data" } }],
];

describe("UPD-FR-01 no-op classification", () => {
  it("returns no-op when config, state, container, and health all agree", () => {
    const diff = classifyUpdate(input());

    expect(diff.kind).toBe("no-op");
    expect(diff.changes).toEqual([]);
    expect(diff.forced).toBe(false);
    expect(diff.reason).toContain("nothing changed");
    expect(diff.currentImage).toBe(IMAGE);
    expect(diff.previousImage).toBe(PREVIOUS);
    expect(diff.container).toBe("running");
    expect(diff.state).toBe("present");
    expect(diff.recordedHealth).toBe("healthy");
  });

  it("ignores map key order when comparing env and volumes", () => {
    const desired = specFrom(BASE, {
      env: { LOG_LEVEL: "info" },
      volumes: { data: "/var/lib/data" },
    });

    expect(classifyUpdate(input({ desired })).kind).toBe("no-op");
  });
});

describe("UPD-FR-01 config-only fields", () => {
  for (const [field, overrides] of CONFIG_ONLY_CASES) {
    it(`classifies a ${field}-only change as config-only without a build`, () => {
      const diff = classifyUpdate(input({ desired: specFrom(BASE, overrides) }));

      expect(diff.kind).toBe("config-only");
      expect(diff.changes).toHaveLength(1);
      expect(diff.changes[0]).toMatchObject({ field, kind: "config-only" });
      expect(diff.currentImage).toBe(IMAGE);
      expect(diff.previousImage).toBe(PREVIOUS);
    });
  }

  it("exposes exactly the documented config-only field set", () => {
    expect([...CONFIG_ONLY_CONFIG_FIELDS].sort()).toEqual([
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
    ]);
  });

  it("treats a secret-value change as config-only and never renders the values", () => {
    const diff = classifyUpdate(
      input({
        environment: {
          current: { API_KEY: "old-secret-value", LOG_LEVEL: "info" },
          desired: { API_KEY: "new-secret-value", LOG_LEVEL: "info" },
        },
      }),
    );

    expect(diff.kind).toBe("config-only");
    expect(diff.changes).toEqual([
      {
        field: "environment.API_KEY",
        kind: "config-only",
        reason: expect.stringContaining("API_KEY"),
      },
    ]);

    const rendered = JSON.stringify(diff);
    expect(rendered).not.toContain("old-secret-value");
    expect(rendered).not.toContain("new-secret-value");
    expect(rendered).not.toContain("LOG_LEVEL");
  });

  it("combines several config-only changes into one config-only classification", () => {
    const desired = specFrom(BASE, {
      bind: "127.0.0.1",
      env: { LOG_LEVEL: "debug" },
      health_path: "/ready",
      port: 8081,
      volumes: { data: "/srv/data" },
    });

    const diff = classifyUpdate(input({ desired }));

    expect(diff.kind).toBe("config-only");
    expect(diff.changes.map((change) => change.field)).toEqual([
      "bind",
      "env",
      "health_path",
      "port",
      "volumes",
    ]);
    expect(diff.changes.every((change) => change.kind === "config-only")).toBe(true);
  });

  it("rebuilds when only one side of the environment snapshot is supplied", () => {
    const diff = classifyUpdate(input({ environment: { current: { API_KEY: "value" } } }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.changes).toEqual([
      {
        field: "environment",
        kind: "rebuild",
        reason: expect.stringContaining("incomplete"),
      },
    ]);
  });
});

describe("UPD-FR-01 rebuild fields", () => {
  it("exposes exactly the documented rebuild field set", () => {
    expect([...REBUILD_CONFIG_FIELDS].sort()).toEqual(["local_path", "ref", "repo"]);
  });

  it("classifies a repository URL change as a rebuild", () => {
    const desired = specFrom(BASE, { repo: OTHER_REPO });

    const diff = classifyUpdate(input({ desired }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.changes).toEqual([
      { field: "repo", kind: "rebuild", reason: expect.stringContaining("repo") },
    ]);
  });

  it("classifies a ref change as a rebuild", () => {
    const diff = classifyUpdate(input({ desired: specFrom(BASE, { ref: "v2" }) }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.changes).toEqual([
      { field: "ref", kind: "rebuild", reason: expect.stringContaining("ref") },
    ]);
  });

  it("classifies a local-path change as a rebuild", () => {
    const current = localSpec();
    const desired = localSpec({ local_path: "workspace-v2" });

    const diff = classifyUpdate(input({ current, desired }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.changes).toEqual([
      {
        field: "local_path",
        kind: "rebuild",
        reason: expect.stringContaining("local_path"),
      },
    ]);
  });

  it("classifies a switch from repo mode to local mode as a rebuild", () => {
    const current = spec();
    const desired = localSpec();

    const diff = classifyUpdate(input({ current, desired }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.changes.map((change) => change.field)).toEqual(["local_path", "repo"]);
    expect(diff.changes.every((change) => change.kind === "rebuild")).toBe(true);
  });

  it("combines repository and ref changes into one rebuild classification", () => {
    const desired = specFrom(BASE, { repo: OTHER_REPO, ref: "v2" });

    const diff = classifyUpdate(input({ desired }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.changes.map((change) => change.field)).toEqual(["ref", "repo"]);
    expect(diff.changes.every((change) => change.kind === "rebuild")).toBe(true);
  });

  it("forces a rebuild for --rebuild even when nothing changed", () => {
    const diff = classifyUpdate(input({ rebuild: true }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.forced).toBe(true);
    expect(diff.changes).toEqual([]);
    expect(diff.reason).toContain("--rebuild");
  });

  it("keeps reported changes when --rebuild forces a config-only change to build", () => {
    const diff = classifyUpdate(input({ desired: specFrom(BASE, { port: 8081 }), rebuild: true }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.forced).toBe(true);
    expect(diff.changes).toEqual([
      { field: "port", kind: "config-only", reason: expect.stringContaining("port") },
    ]);
  });
});

describe("UPD-FR-01 unknown differences", () => {
  it("treats an unknown config field as a rebuild", () => {
    const desired = { ...BASE, future_setting: true } as unknown as AppSpec;

    const diff = classifyUpdate(input({ desired }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.changes).toEqual([
      {
        field: "future_setting",
        kind: "rebuild",
        reason: expect.stringContaining("unknown"),
      },
    ]);
  });

  it("treats an unexpected value shape in a config-only field as a rebuild", () => {
    const desired = { ...BASE, port: "8080" } as unknown as AppSpec;

    const diff = classifyUpdate(input({ desired }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.changes).toEqual([
      {
        field: "port",
        kind: "rebuild",
        reason: expect.stringContaining("shape"),
      },
    ]);
  });
});

describe("UPD-FR-01 missing state and container recovery", () => {
  it("does not report no-op when state.json is missing", () => {
    const diff = classifyUpdate(input({ state: null }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.state).toBe("missing");
    expect(diff.currentImage).toBeNull();
    expect(diff.previousImage).toBeNull();
    expect(diff.recordedHealth).toBeNull();
    expect(diff.reason).toContain("state.json");
    expect(diff.notes.join(" ")).toContain("state.json");
  });

  it("does not report no-op when the state input is omitted", () => {
    const diff = classifyUpdate({
      current: BASE,
      desired: BASE,
      container: liveContainer(),
    });

    expect(diff.kind).toBe("rebuild");
    expect(diff.state).toBe("missing");
    expect(diff.reason).toContain("state.json");
  });

  it("rebuilds a config-only change when state.json is missing", () => {
    const diff = classifyUpdate(input({ desired: specFrom(BASE, { port: 8081 }), state: null }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.changes).toEqual([
      { field: "port", kind: "config-only", reason: expect.stringContaining("port") },
    ]);
  });

  it("rebuilds when the state cache records no current image", () => {
    const diff = classifyUpdate(input({ state: recordedState({ current: null, previous: null }) }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.reason).toContain("no current image");
  });

  it("recreates the recorded image when the container is missing", () => {
    const diff = classifyUpdate(input({ container: null }));

    expect(diff.kind).toBe("config-only");
    expect(diff.changes).toEqual([]);
    expect(diff.container).toBe("missing");
    expect(diff.currentImage).toBe(IMAGE);
    expect(diff.reason).toContain("missing");
  });

  it("recreates the recorded image when the container is stopped", () => {
    const diff = classifyUpdate(input({ container: liveContainer(false) }));

    expect(diff.kind).toBe("config-only");
    expect(diff.container).toBe("stopped");
    expect(diff.reason).toContain("not running");
  });

  it("recreates the recorded image when the recorded health is unhealthy", () => {
    const diff = classifyUpdate(input({ state: recordedState({ health: "unhealthy" }) }));

    expect(diff.kind).toBe("config-only");
    expect(diff.recordedHealth).toBe("unhealthy");
    expect(diff.reason).toContain("unhealthy");
  });

  it("recreates the recorded image when health was never recorded", () => {
    const diff = classifyUpdate(input({ state: recordedState({ health: "unknown" }) }));

    expect(diff.kind).toBe("config-only");
    expect(diff.reason).toContain("unknown");
  });

  it("rebuilds when the running image drifts from the recorded current image", () => {
    const diff = classifyUpdate(input({ container: liveContainer(true, DRIFTED_IMAGE) }));

    expect(diff.kind).toBe("rebuild");
    expect(diff.reason).toContain(DRIFTED_IMAGE);
    expect(diff.reason).toContain(IMAGE);
    expect(diff.notes.join(" ")).toContain("disagree");
  });

  it("still allows no-op when the runtime cannot report an image", () => {
    const diff = classifyUpdate(input({ container: { state: { running: true } } }));

    expect(diff.kind).toBe("no-op");
  });
});

describe("UPD-FR-01 purity", () => {
  it("never mutates its inputs", () => {
    const current = spec();
    const desired = specFrom(current, { port: 8081 });
    const state = recordedState();
    const container = liveContainer();
    const environment = { current: { API_KEY: "one" }, desired: { API_KEY: "two" } };
    const before = JSON.stringify({ current, desired, state, container, environment });

    const diff = classifyUpdate({ current, desired, state, container, environment });

    expect(diff.kind).toBe("config-only");
    expect(JSON.stringify({ current, desired, state, container, environment })).toBe(before);
  });
});
