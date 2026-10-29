import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfigToml } from "../../src/config/parse.js";
import type { AppSpec } from "../../src/config/schema.js";
import { createPaths, type Paths } from "../../src/platform/paths.js";
import { type AppState, isIsoTimestamp, StateStore } from "../../src/registry/state.js";
import {
  APP_DIRECTORY_MODE,
  type AppListEntry,
  type BrokenAppEntry,
  CONFIG_FILE_MODE,
  type OkAppEntry,
  Registry,
  SECRETS_FILE_MODE,
  STATE_FILE_MODE,
} from "../../src/registry/store.js";

const fixedNow = new Date("2026-10-30T12:00:00.000Z");
const createdDirectories: string[] = [];

function makeWorkspace(): { parent: string; paths: Paths; registry: Registry } {
  const parent = mkdtempSync(path.join(tmpdir(), "easy-host-registry-"));
  createdDirectories.push(parent);
  const paths = createPaths({
    env: { EASY_HOST_HOME: path.join(parent, "state") },
    homeDir: parent,
  });
  paths.ensureLayout();

  return { parent, paths, registry: new Registry(paths) };
}

function specFor(port: number, repo = "https://github.com/example/blog.git"): AppSpec {
  return parseConfigToml(`repo = "${repo}"\nport = ${port}\n`);
}

function fixedClock(): Date {
  return new Date(fixedNow);
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("expected the action to throw");
}

function entryNamed(entries: readonly AppListEntry[], name: string): AppListEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`expected a list entry named ${name}`);
  }

  return entry;
}

function okEntry(entries: readonly AppListEntry[], name: string): OkAppEntry {
  const entry = entryNamed(entries, name);
  if (entry.status !== "ok") {
    throw new Error(`expected ${name} to be ok, got ${entry.error.message}`);
  }

  return entry;
}

function brokenEntry(entries: readonly AppListEntry[], name: string): BrokenAppEntry {
  const entry = entryNamed(entries, name);
  if (entry.status !== "broken") {
    throw new Error(`expected ${name} to be broken`);
  }

  return entry;
}

function temporaryFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith(".tmp"));
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("registry listing", () => {
  it("returns an empty list before the apps directory exists", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "easy-host-registry-"));
    createdDirectories.push(parent);

    const registry = new Registry(path.join(parent, "missing", "apps"));

    expect(registry.list()).toEqual([]);
  });

  it("lists valid apps sorted by name with parsed specs", () => {
    const { registry } = makeWorkspace();
    registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    registry.create("api");
    registry.writeConfig("api", specFor(8081));

    const entries = registry.list();

    expect(entries.map((entry) => entry.name)).toEqual(["api", "blog"]);
    expect(entries.map((entry) => entry.status)).toEqual(["ok", "ok"]);
    expect(okEntry(entries, "blog").spec.port).toBe(8080);
    expect(okEntry(entries, "blog").spec.ref).toBe("main");
    expect(okEntry(entries, "api").spec.port).toBe(8081);
  });

  it("reports a broken config with its parse error instead of skipping it", () => {
    const { registry } = makeWorkspace();
    registry.create("blog");
    registry.writeConfig("blog", specFor(8080));

    const broken = registry.create("api");
    writeFileSync(broken.configPath, 'repo = "https://github.com/example/api.git"\nport = 80\n');

    const entries = registry.list();

    expect(entries).toHaveLength(2);
    expect(okEntry(entries, "blog").spec.port).toBe(8080);

    const api = brokenEntry(entries, "api");
    expect(api.error.code).toBe("INVALID_CONFIG");
    expect(api.error.exitCode).toBe(1);
    expect(api.error.details.setting).toBe("port");
    expect(api.configPath).toBe(broken.configPath);
  });

  it("reports a directory without config.toml as broken", () => {
    const { registry, paths } = makeWorkspace();
    mkdirSync(path.join(paths.appsDir, "manual"), { mode: 0o700 });

    const entry = brokenEntry(registry.list(), "manual");

    expect(entry.error.code).toBe("MISSING_CONFIG");
    expect(entry.error.exitCode).toBe(1);
    expect(entry.configPath).toBe(path.join(paths.appsDir, "manual", "config.toml"));
  });

  it("reports an invalid directory name instead of hiding it", () => {
    const { registry, paths } = makeWorkspace();
    mkdirSync(path.join(paths.appsDir, "Bad-Name"), { mode: 0o700 });

    const entry = brokenEntry(registry.list(), "Bad-Name");

    expect(entry.error.code).toBe("INVALID_APP_NAME");
    expect(entry.error.exitCode).toBe(1);
  });

  it.skipIf(process.platform === "win32")("reports a symlinked app directory as broken", () => {
    const { registry, paths, parent } = makeWorkspace();
    const outside = path.join(parent, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, path.join(paths.appsDir, "linked"), "dir");

    const entry = brokenEntry(registry.list(), "linked");

    expect(entry.error.code).toBe("APP_NOT_A_DIRECTORY");
    expect(entry.directory).toBe(path.join(paths.appsDir, "linked"));
  });
});

describe("registry reads and writes", () => {
  it("reads a config back as a fully defaulted spec", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080, "git@github.com:example/blog.git"));

    const spec = registry.readConfig("blog");

    expect(spec.repo).toBe("git@github.com:example/blog.git");
    expect(spec.port).toBe(8080);
    expect(spec.container_port).toBe(3000);
    expect(spec.bind).toBe("0.0.0.0");
    expect(spec.health_path).toBe("/");
    expect(spec.env).toEqual({});
    expect(record.configPath).toBe(path.join(record.directory, "config.toml"));
  });

  it("preserves hand-written comments on an atomic rewrite", () => {
    const { registry } = makeWorkspace();
    registry.create("blog");

    const source = [
      "# Keep this note for the next operator.",
      'repo = "https://github.com/example/blog.git"',
      "port = 8080",
      "",
    ].join("\n");
    registry.writeConfig("blog", parseConfigToml(source), { source });

    const written = readFileSync(registry.record("blog").configPath, "utf8");

    expect(written).toContain("# Keep this note for the next operator.");
    expect(registry.readConfig("blog").port).toBe(8080);
  });

  it("writes config.toml with mode 0644", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");

    registry.writeConfig("blog", specFor(8080));

    expect(statSync(record.configPath).mode & 0o777).toBe(CONFIG_FILE_MODE);
    expect(CONFIG_FILE_MODE).toBe(0o644);
  });

  it("writes and reads secrets.env with mode 0600", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));

    registry.writeSecrets("blog", "API_TOKEN=super-secret-value\n");

    expect(statSync(record.secretsPath).mode & 0o777).toBe(SECRETS_FILE_MODE);
    expect(SECRETS_FILE_MODE).toBe(0o600);
    expect(registry.readSecrets("blog")).toBe("API_TOKEN=super-secret-value\n");
    expect(readFileSync(record.configPath, "utf8")).not.toContain("super-secret-value");
  });

  it("returns undefined when the optional secrets file is absent", () => {
    const { registry } = makeWorkspace();
    registry.create("blog");

    expect(registry.readSecrets("blog")).toBeUndefined();
  });

  it("keeps the previous config when a simulated write failure aborts the replace", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const before = readFileSync(record.configPath, "utf8");

    const failure = captureError(() =>
      registry.writeConfig("blog", specFor(9090), {
        beforeRename: () => {
          throw new Error("simulated ENOSPC");
        },
      }),
    );

    expect((failure as Error).message).toContain("simulated ENOSPC");
    expect(readFileSync(record.configPath, "utf8")).toBe(before);
    expect(registry.readConfig("blog").port).toBe(8080);
    expect(temporaryFiles(record.directory)).toEqual([]);
  });

  it("keeps the previous secrets file when a simulated write failure aborts the replace", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeSecrets("blog", "TOKEN=old\n");

    expect(() =>
      registry.writeSecrets("blog", "TOKEN=new\n", {
        beforeRename: () => {
          throw new Error("simulated EIO");
        },
      }),
    ).toThrow(/simulated EIO/);

    expect(readFileSync(record.secretsPath, "utf8")).toBe("TOKEN=old\n");
    expect(temporaryFiles(record.directory)).toEqual([]);
  });

  it("validates before mutating and never writes an invalid config", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    const invalid = { ...specFor(8080), port: 80 } as AppSpec;

    expect(() => registry.writeConfig("blog", invalid)).toThrow(/port/);
    expect(existsSync(record.configPath)).toBe(false);
    expect(temporaryFiles(record.directory)).toEqual([]);
  });

  it("does not leave a temporary file after a successful write", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");

    registry.writeConfig("blog", specFor(8080));

    expect(temporaryFiles(record.directory)).toEqual([]);
  });
});

describe("registry layout and deletion", () => {
  it("creates the app and workspace directories with mode 0700", () => {
    const { registry } = makeWorkspace();

    const record = registry.create("blog");

    expect(statSync(record.directory).isDirectory()).toBe(true);
    expect(statSync(record.workspacePath).isDirectory()).toBe(true);
    expect(statSync(record.directory).mode & 0o777).toBe(APP_DIRECTORY_MODE);
    expect(statSync(record.workspacePath).mode & 0o777).toBe(APP_DIRECTORY_MODE);
    expect(APP_DIRECTORY_MODE).toBe(0o700);
  });

  it("refuses to overwrite an existing app directory", () => {
    const { registry } = makeWorkspace();
    registry.create("blog");

    const error = captureError(() => registry.create("blog"));

    expect((error as { code?: string }).code).toBe("APP_NAME_CONFLICT");
    expect((error as { exitCode?: number }).exitCode).toBe(6);
  });

  it("contains every app file inside the app directory", () => {
    const { registry, paths } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    registry.writeSecrets("blog", "TOKEN=value\n");
    new StateStore(record.directory, { clock: fixedClock }).load();

    expect(readdirSync(record.directory).sort()).toEqual([
      "config.toml",
      "secrets.env",
      "state.json",
      "workspace",
    ]);
    expect(readdirSync(paths.appsDir)).toEqual(["blog"]);
  });

  it("refuses to delete without confirmation", () => {
    const { registry } = makeWorkspace();
    registry.create("blog");

    const error = captureError(() => registry.remove("blog", { confirmed: false }));

    expect((error as { code?: string }).code).toBe("CONFIRMATION_REQUIRED");
    expect((error as { exitCode?: number }).exitCode).toBe(1);
    expect(registry.exists("blog")).toBe(true);
  });

  it("deletes only the confirmed app directory", () => {
    const { registry } = makeWorkspace();
    registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    registry.create("api");
    registry.writeConfig("api", specFor(8081));

    registry.remove("blog", { confirmed: true });

    expect(registry.exists("blog")).toBe(false);
    expect(registry.exists("api")).toBe(true);
    expect(okEntry(registry.list(), "api").spec.port).toBe(8081);
  });

  it("reports a missing app with exit code 5", () => {
    const { registry } = makeWorkspace();

    const error = captureError(() => registry.readConfig("gone"));

    expect((error as { code?: string }).code).toBe("APP_NOT_FOUND");
    expect((error as { exitCode?: number }).exitCode).toBe(5);
  });
});

describe("state cache rebuild", () => {
  it("rebuilds a missing cache without losing the app", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, { clock: fixedClock });

    const result = store.load();

    expect(result.source).toBe("rebuilt");
    expect(result.reason).toBe("missing");
    expect(result.persisted).toBe(true);
    expect(result.state).toMatchObject({
      schemaVersion: 1,
      name: "blog",
      images: { current: null, previous: null },
      containerId: null,
      health: { status: "unknown", checkedAt: null, detail: null },
      updatedAt: "2026-10-30T12:00:00.000Z",
    });
    expect(isIsoTimestamp(result.state.createdAt)).toBe(true);
    expect(existsSync(record.statePath)).toBe(true);

    // Deleting the cache again does not remove the app from the listing.
    rmSync(record.statePath);
    expect(registry.list()).toHaveLength(1);
    expect(okEntry(registry.list(), "blog").spec.port).toBe(8080);
    expect(store.load().source).toBe("rebuilt");
  });

  it("reuses a valid cache instead of rewriting it", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, { clock: fixedClock });
    const first = store.load();

    const second = store.load();

    expect(second.source).toBe("cache");
    expect(second.state).toEqual(first.state);

    store.update({ images: { current: "localhost/easy-host-blog:1" } });
    const third = store.load();

    expect(third.source).toBe("cache");
    expect(third.state.images.current).toBe("localhost/easy-host-blog:1");
  });

  it("rebuilds a corrupt cache and rewrites a valid document", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, { clock: fixedClock });
    writeFileSync(record.statePath, "{ this is not json");

    const result = store.load();

    expect(result.source).toBe("rebuilt");
    expect(result.reason).toBe("invalid");
    expect(result.state.name).toBe("blog");
    expect(() => JSON.parse(readFileSync(record.statePath, "utf8"))).not.toThrow();
    expect(store.load().source).toBe("cache");
    expect(okEntry(registry.list(), "blog").status).toBe("ok");
  });

  it("rebuilds a cache written for another schema version", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, { clock: fixedClock });
    writeFileSync(
      record.statePath,
      JSON.stringify({ schemaVersion: 2, name: "blog", images: { current: "future" } }),
    );

    const result = store.load();

    expect(result.source).toBe("rebuilt");
    expect(result.reason).toBe("invalid");
    expect(result.state.schemaVersion).toBe(1);
  });

  it("reads a cache leniently and lets the directory name win", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, { clock: fixedClock });
    writeFileSync(
      record.statePath,
      JSON.stringify({
        schemaVersion: 1,
        name: "stale-name",
        images: { current: "localhost/easy-host-blog:1", previous: 42 },
        extra: "ignored",
        health: { status: "healthy" },
        createdAt: "2026-10-29T00:00:00.000Z",
        updatedAt: "not-a-timestamp",
      }),
    );

    const result = store.load();

    expect(result.source).toBe("cache");
    expect(result.state.name).toBe("blog");
    expect(result.state.images).toEqual({
      current: "localhost/easy-host-blog:1",
      previous: null,
    });
    expect(result.state.containerId).toBeNull();
    expect(result.state.health).toEqual({
      status: "healthy",
      checkedAt: null,
      detail: null,
    });
    expect(result.state.createdAt).toBe("2026-10-29T00:00:00.000Z");
    expect(result.state.updatedAt).toBe("2026-10-30T12:00:00.000Z");
    expect(JSON.stringify(result.state)).not.toContain("extra");
  });

  it("rebuilds image history from the runtime when the cache is missing", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, {
      clock: fixedClock,
      runtime: () => ({
        images: {
          current: "localhost/easy-host-blog:20261030T120000Z",
          previous: "localhost/easy-host-blog:20261029T120000Z",
        },
        containerId: "abc123",
        health: {
          status: "healthy",
          checkedAt: "2026-10-30T11:59:00.000Z",
          detail: "HTTP 200",
        },
      }),
    });

    const result = store.load();

    expect(result.state.images).toEqual({
      current: "localhost/easy-host-blog:20261030T120000Z",
      previous: "localhost/easy-host-blog:20261029T120000Z",
    });
    expect(result.state.containerId).toBe("abc123");
    expect(result.state.health).toEqual({
      status: "healthy",
      checkedAt: "2026-10-30T11:59:00.000Z",
      detail: "HTTP 200",
    });
  });
});

describe("state cache writes", () => {
  it("writes state.json with mode 0644 and ISO 8601 UTC timestamps", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, { clock: fixedClock });

    const state = store.load().state;

    expect(statSync(record.statePath).mode & 0o777).toBe(STATE_FILE_MODE);
    expect(STATE_FILE_MODE).toBe(0o644);
    expect(isIsoTimestamp(state.createdAt)).toBe(true);
    expect(isIsoTimestamp(state.updatedAt)).toBe(true);
    expect(JSON.parse(readFileSync(record.statePath, "utf8"))).toEqual(state);
  });

  it("merges a patch, stamps the health time, and persists it", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, { clock: fixedClock });
    store.load();

    const updated = store.update({
      images: { current: "localhost/easy-host-blog:20261030T120000Z" },
      containerId: "container-1",
      health: { status: "healthy", detail: "HTTP 200" },
    });

    expect(updated.images).toEqual({
      current: "localhost/easy-host-blog:20261030T120000Z",
      previous: null,
    });
    expect(updated.containerId).toBe("container-1");
    expect(updated.health).toEqual({
      status: "healthy",
      checkedAt: "2026-10-30T12:00:00.000Z",
      detail: "HTTP 200",
    });
    expect(updated.updatedAt).toBe("2026-10-30T12:00:00.000Z");
    expect(JSON.parse(readFileSync(record.statePath, "utf8"))).toEqual(updated);
  });

  it("keeps the previous cache when a simulated state write fails", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, { clock: fixedClock });
    const initial = store.load().state;
    const before = readFileSync(record.statePath, "utf8");

    expect(() =>
      store.write(
        { ...initial, images: { current: "new-image", previous: null } },
        {
          beforeRename: () => {
            throw new Error("simulated EIO");
          },
        },
      ),
    ).toThrow(/simulated EIO/);

    expect(readFileSync(record.statePath, "utf8")).toBe(before);
    expect(store.load().state.images.current).toBeNull();
    expect(temporaryFiles(record.directory)).toEqual([]);
  });

  it("still returns usable state when a rebuilt cache cannot be persisted", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, {
      clock: fixedClock,
      beforeRename: () => {
        throw new Error("read-only filesystem");
      },
    });

    const result = store.load();

    expect(result.source).toBe("rebuilt");
    expect(result.persisted).toBe(false);
    expect(result.state.name).toBe("blog");
    expect(result.state.images).toEqual({ current: null, previous: null });
    expect(existsSync(record.statePath)).toBe(false);
    expect(okEntry(registry.list(), "blog").status).toBe("ok");
  });

  it("resets a cache to the rebuilt state", () => {
    const { registry } = makeWorkspace();
    const record = registry.create("blog");
    registry.writeConfig("blog", specFor(8080));
    const store = new StateStore(record.directory, { clock: fixedClock });
    store.update({ images: { current: "old-image" } });

    const reset = store.reset();

    expect(reset.images).toEqual({ current: null, previous: null });
    expect(store.load().state.images).toEqual({ current: null, previous: null });
  });

  it("reports a missing app directory with exit code 5", () => {
    const { paths } = makeWorkspace();
    const store = new StateStore(path.join(paths.appsDir, "gone"), { clock: fixedClock });

    const error = captureError(() => store.load());

    expect((error as { code?: string }).code).toBe("APP_NOT_FOUND");
    expect((error as { exitCode?: number }).exitCode).toBe(5);
  });
});

describe("state document shape", () => {
  it("rejects an ISO timestamp with an offset so output stays UTC", () => {
    expect(isIsoTimestamp("2026-10-30T12:00:00.000Z")).toBe(true);
    expect(isIsoTimestamp("2026-10-30T12:00:00Z")).toBe(true);
    expect(isIsoTimestamp("2026-10-30T12:00:00+02:00")).toBe(false);
    expect(isIsoTimestamp("2026-10-30")).toBe(false);
    expect(isIsoTimestamp(17)).toBe(false);
  });

  it("exposes the cached document fields the read commands consume", () => {
    const state: AppState = {
      schemaVersion: 1,
      name: "blog",
      images: { current: null, previous: null },
      containerId: null,
      health: { status: "unknown", checkedAt: null, detail: null },
      createdAt: "2026-10-30T12:00:00.000Z",
      updatedAt: "2026-10-30T12:00:00.000Z",
    };

    expect(Object.keys(state).sort()).toEqual([
      "containerId",
      "createdAt",
      "health",
      "images",
      "name",
      "schemaVersion",
      "updatedAt",
    ]);
  });
});
