import { describe, expect, it } from "vitest";
import { ConflictError, type EasyHostError, UsageError } from "../../src/cli/errors.js";
import { parseConfigToml } from "../../src/config/parse.js";
import {
  assertPortAvailable,
  assertPortAvailableForApp,
  assertPortAvailableInRegistry,
  findPortConflict,
  MAX_DECLARED_PORT,
  MIN_DECLARED_PORT,
  type PortClaim,
  portClaimsFromEntries,
  validateDeclaredPort,
} from "../../src/registry/ports.js";
import type { AppListEntry, BrokenAppEntry, OkAppEntry } from "../../src/registry/store.js";

function okEntry(name: string, port: number, bind = "0.0.0.0"): OkAppEntry {
  const directory = `/tmp/easy-host-ports/apps/${name}`;
  const configPath = `${directory}/config.toml`;

  return {
    status: "ok",
    name,
    directory,
    configPath,
    spec: parseConfigToml(
      `repo = "https://github.com/example/${name}.git"\nport = ${port}\nbind = "${bind}"\n`,
    ),
  };
}

function brokenEntry(name: string): BrokenAppEntry {
  const directory = `/tmp/easy-host-ports/apps/${name}`;

  return {
    status: "broken",
    name,
    directory,
    configPath: `${directory}/config.toml`,
    error: new UsageError("invalid config.toml", { code: "INVALID_CONFIG" }),
  };
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("expected the action to throw");
}

function exitCodeOf(error: unknown): number {
  return (error as EasyHostError).exitCode;
}

describe("declared port validation", () => {
  it("accepts the unprivileged range boundaries", () => {
    expect(MIN_DECLARED_PORT).toBe(1024);
    expect(MAX_DECLARED_PORT).toBe(65_535);
    expect(validateDeclaredPort(1024)).toBe(1024);
    expect(validateDeclaredPort(65_535)).toBe(65_535);
    expect(validateDeclaredPort(8080)).toBe(8080);
  });

  it("rejects privileged ports with exit code 1", () => {
    for (const port of [80, 443, 1023]) {
      const error = captureError(() => validateDeclaredPort(port));

      expect(error).toBeInstanceOf(UsageError);
      expect(exitCodeOf(error)).toBe(1);
      expect((error as UsageError).code).toBe("INVALID_PORT");
      expect((error as UsageError).details.reason).toBe("privileged");
      expect((error as UsageError).message).toContain(String(port));
    }
  });

  it("rejects ports above the maximum", () => {
    const error = captureError(() => validateDeclaredPort(65_536));

    expect(exitCodeOf(error)).toBe(1);
    expect((error as UsageError).code).toBe("INVALID_PORT");
    expect((error as UsageError).details.reason).toBe("out-of-range");
  });

  it("rejects non-integer and non-finite ports", () => {
    for (const port of [3000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = captureError(() => validateDeclaredPort(port));

      expect(exitCodeOf(error)).toBe(1);
      expect((error as UsageError).code).toBe("INVALID_PORT");
      expect((error as UsageError).message).toContain("whole number");
    }
  });
});

describe("port claims from a registry listing", () => {
  it("extracts claims from valid apps and skips broken ones", () => {
    const claims = portClaimsFromEntries([
      brokenEntry("broken"),
      okEntry("blog", 8080, "0.0.0.0"),
      okEntry("api", 8081, "127.0.0.1"),
    ]);

    expect(claims).toEqual([
      { app: "blog", port: 8080, bind: "0.0.0.0" },
      { app: "api", port: 8081, bind: "127.0.0.1" },
    ]);
  });
});

describe("cross-app port conflicts", () => {
  it("rejects a duplicate port and names the existing app", () => {
    const entries = [okEntry("blog", 8080, "0.0.0.0"), okEntry("api", 8081, "127.0.0.1")];

    const error = captureError(() => assertPortAvailableForApp(8080, entries));

    expect(error).toBeInstanceOf(ConflictError);
    expect(exitCodeOf(error)).toBe(6);
    expect((error as ConflictError).code).toBe("PORT_CONFLICT");
    expect((error as ConflictError).message).toContain("8080");
    expect((error as ConflictError).message).toContain("blog");
    expect((error as ConflictError).details).toMatchObject({
      port: 8080,
      app: "blog",
      bind: "0.0.0.0",
    });
  });

  it("treats equal ports as a conflict regardless of bind address", () => {
    for (const bind of ["0.0.0.0", "127.0.0.1", "::"]) {
      const entries = [okEntry("existing", 9090, bind)];

      const error = captureError(() => assertPortAvailableForApp(9090, entries));

      expect(exitCodeOf(error)).toBe(6);
      expect((error as ConflictError).details.bind).toBe(bind);
    }
  });

  it("allows a port no other app declares", () => {
    const entries = [okEntry("blog", 8080), okEntry("api", 8081)];

    expect(findPortConflict(8082, portClaimsFromEntries(entries))).toBeUndefined();
    expect(() => assertPortAvailableForApp(8082, entries)).not.toThrow();
  });

  it("ignores the requesting app's own claim when updating", () => {
    const entries = [okEntry("blog", 8080), okEntry("api", 8081)];

    expect(() => assertPortAvailableForApp(8080, entries, { app: "blog" })).not.toThrow();
    expect(() => assertPortAvailableForApp(8080, entries, { app: "api" })).toThrow(ConflictError);
  });

  it("validates the port before comparing claims", () => {
    expect(() => findPortConflict(80, [])).toThrow(UsageError);
  });

  it("checks the registry listing before any container action", () => {
    const entries = [okEntry("blog", 8080)];
    let listCalls = 0;
    const registry = {
      list(): readonly AppListEntry[] {
        listCalls += 1;
        return entries;
      },
    };

    const error = captureError(() => assertPortAvailableInRegistry(8080, registry));

    expect(exitCodeOf(error)).toBe(6);
    expect(listCalls).toBe(1);
  });

  it("reports the first matching claim from an iterable", () => {
    const claims: PortClaim[] = [
      { app: "blog", port: 8080, bind: "0.0.0.0" },
      { app: "api", port: 8080, bind: "::" },
    ];

    expect(findPortConflict(8080, claims)?.app).toBe("blog");
    expect(() => assertPortAvailable(8080, claims)).toThrow(ConflictError);
  });
});
