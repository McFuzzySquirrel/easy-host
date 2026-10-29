import { describe, expect, it } from "vitest";
import { parseConfigToml, serializeConfig, validateAppSpec } from "../../src/config/parse.js";
import {
  APP_SPEC_DEFAULTS,
  type AppSpec,
  BIND_ADDRESSES,
  ConfigValidationError,
} from "../../src/config/schema.js";

const REPO = 'repo = "https://github.com/example/demo.git"';

function minimal(extra = ""): string {
  return `${REPO}\nport = 8080\n${extra}`;
}

function captureError(source: string, options?: { file?: string }): ConfigValidationError {
  try {
    parseConfigToml(source, options);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error;
    }
    throw error;
  }

  throw new Error("expected configuration parsing to fail");
}

function captureObjectError(input: unknown): ConfigValidationError {
  try {
    validateAppSpec(input);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error;
    }
    throw error;
  }

  throw new Error("expected configuration validation to fail");
}

describe("REG-FR-01 minimal config and defaults", () => {
  it("parses a minimal repo config and applies every documented default", () => {
    const spec = parseConfigToml(minimal());

    expect(spec.repo).toBe("https://github.com/example/demo.git");
    expect(spec.local_path).toBeUndefined();
    expect(spec.ref).toBe("main");
    expect(spec.ref).toBe(APP_SPEC_DEFAULTS.ref);

    expect(spec.port).toBe(8080);
    expect(spec.container_port).toBe(3000);
    expect(spec.container_port).toBe(APP_SPEC_DEFAULTS.container_port);

    expect(spec.bind).toBe("0.0.0.0");
    expect(spec.bind).toBe(APP_SPEC_DEFAULTS.bind);

    expect(spec.probe).toBe("http");
    expect(spec.probe).toBe(APP_SPEC_DEFAULTS.probe);

    expect(spec.health_path).toBe("/");
    expect(spec.health_path).toBe(APP_SPEC_DEFAULTS.health_path);

    expect(spec.health_interval_ms).toBe(2000);
    expect(spec.health_interval_ms).toBe(APP_SPEC_DEFAULTS.health_interval_ms);

    expect(spec.health_timeout_ms).toBe(5000);
    expect(spec.health_timeout_ms).toBe(APP_SPEC_DEFAULTS.health_timeout_ms);

    expect(spec.health_startup_ms).toBe(90_000);
    expect(spec.health_startup_ms).toBe(APP_SPEC_DEFAULTS.health_startup_ms);

    expect(spec.volumes).toEqual({});
    expect(spec.env).toEqual({});
    expect(spec.env_file).toBeUndefined();
  });

  it("accepts local_path as the mutually exclusive source and keeps defaults", () => {
    const spec = parseConfigToml('local_path = "workspace"\nport = 8080\n');

    expect(spec.local_path).toBe("workspace");
    expect(spec.repo).toBeUndefined();
    expect(spec.ref).toBe("main");
    expect(spec.container_port).toBe(3000);
    expect(spec.bind).toBe("0.0.0.0");
  });

  it("parses a fully specified config including volumes and env_file", () => {
    const source = `
local_path = "./workspace"
ref = "release/v1"
port = 9000
container_port = 8080
bind = "127.0.0.1"
probe = "tcp"
health_path = "/healthz"
health_interval_ms = 1500
health_timeout_ms = 4000
health_startup_ms = 120000
env_file = "secrets.env"

[volumes]
data = "/var/lib/app"
cache = "/tmp/cache"

[env]
NODE_ENV = "production"
`;
    const spec = parseConfigToml(source);

    expect(spec).toMatchObject({
      local_path: "./workspace",
      ref: "release/v1",
      port: 9000,
      container_port: 8080,
      bind: "127.0.0.1",
      probe: "tcp",
      health_path: "/healthz",
      health_interval_ms: 1500,
      health_timeout_ms: 4000,
      health_startup_ms: 120_000,
      env_file: "secrets.env",
      volumes: { data: "/var/lib/app", cache: "/tmp/cache" },
      env: { NODE_ENV: "production" },
    });
  });

  it("validates an already-decoded object with the same defaults", () => {
    const spec = validateAppSpec({ repo: "ssh://git@github.com/example/demo.git", port: 8080 });

    expect(spec.ref).toBe("main");
    expect(spec.health_path).toBe("/");
    expect(spec.volumes).toEqual({});
  });
});

describe("REG-FR-01 repo and local_path exclusivity", () => {
  it("rejects a config with neither repo nor local_path and names both keys", () => {
    const error = captureError("port = 8080\n");

    expect(error.setting).toBe("repo");
    expect(error.message).toContain("repo");
    expect(error.message).toContain("local_path");
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe("INVALID_CONFIG");
  });

  it("rejects a config with both repo and local_path", () => {
    const error = captureError(
      `repo = "https://example.com/demo.git"\nlocal_path = "src"\nport = 8080\n`,
    );

    expect(error.setting).toBe("repo");
    expect(error.message).toContain("repo");
    expect(error.message).toContain("local_path");
  });

  it("rejects an invalid repository URL with the key named", () => {
    const error = captureError('repo = "ftp://example.com/demo.git"\nport = 8080\n');

    expect(error.setting).toBe("repo");
    expect(error.message).toContain('"repo"');
    expect(error.message).toContain("ftp://example.com/demo.git");
  });

  it("redacts credentials embedded in an invalid repository URL", () => {
    const error = captureError(
      'repo = "ftp://deploy:super-secret-password@example.com/demo.git"\nport = 8080\n',
    );

    expect(error.message).not.toContain("super-secret-password");
    expect(error.message).toContain("[redacted]");
  });

  it("rejects URL credentials even for an otherwise supported scheme", () => {
    const error = captureError(
      'repo = "https://deploy:super-secret-password@example.com/demo.git"\nport = 8080\n',
    );

    expect(error.setting).toBe("repo");
    expect(error.message).not.toContain("super-secret-password");
  });
});

describe("REG-FR-01 port validation", () => {
  it("requires port", () => {
    const error = captureError(`${REPO}\n`);

    expect(error.setting).toBe("port");
    expect(error.message).toContain('"port"');
    expect(error.message).toContain("required");
  });

  it("accepts the inclusive host-port boundaries", () => {
    expect(parseConfigToml(minimal().replace("8080", "1024")).port).toBe(1024);
    expect(parseConfigToml(minimal().replace("8080", "65535")).port).toBe(65535);
  });

  it.each([80, 1023, 0, -1, 65536, 100_000])("rejects out-of-range host port %i", (port) => {
    const error = captureError(`${REPO}\nport = ${port}\n`);

    expect(error.setting).toBe("port");
    expect(error.message).toContain("port");
    expect(error.message).toContain(String(port));
  });

  it("rejects a non-integer host port and echoes the received value", () => {
    const error = captureError(`${REPO}\nport = 8080.5\n`);

    expect(error.setting).toBe("port");
    expect(error.message).toContain("8080.5");
  });

  it("rejects a string port with the key and value named", () => {
    const error = captureError(`${REPO}\nport = "8080"\n`);

    expect(error.setting).toBe("port");
    expect(error.message).toContain("number");
    expect(error.message).toContain('"8080"');
  });

  it("validates container_port with the same unprivileged range", () => {
    expect(parseConfigToml(minimal("container_port = 1024\n")).container_port).toBe(1024);
    expect(parseConfigToml(minimal("container_port = 65535\n")).container_port).toBe(65535);

    for (const port of [80, 1023, 0, 65536]) {
      const error = captureError(minimal(`container_port = ${port}\n`));
      expect(error.setting).toBe("container_port");
      expect(error.message).toContain(String(port));
    }
  });
});

describe("REG-FR-01 bind, probe, health, and timing validation", () => {
  it.each(BIND_ADDRESSES)("accepts bind address %s", (bind) => {
    expect(parseConfigToml(minimal(`bind = "${bind}"\n`)).bind).toBe(bind);
  });

  it.each(["localhost", "::1", "192.168.1.5", ""])(
    "rejects unsupported bind address %j",
    (bind) => {
      const error = captureError(minimal(`bind = "${bind}"\n`));

      expect(error.setting).toBe("bind");
      expect(error.message).toContain("bind");
      expect(error.message).toContain("must be one of");
    },
  );

  it("rejects an unsupported probe kind", () => {
    const error = captureError(minimal('probe = "udp"\n'));

    expect(error.setting).toBe("probe");
    expect(error.message).toContain("udp");
    expect(error.message).toContain("http, tcp");
  });

  it.each(["health", "", " /health", "/health path", "/../etc/passwd"])(
    "rejects invalid health_path %j",
    (healthPath) => {
      const error = captureError(minimal(`health_path = ${JSON.stringify(healthPath)}\n`));

      expect(error.setting).toBe("health_path");
      expect(error.message).toContain("health_path");
    },
  );

  it.each([
    ["health_interval_ms", 0],
    ["health_timeout_ms", -5],
    ["health_startup_ms", 1.5],
  ])("rejects invalid %s value %s", (key, value) => {
    const error = captureError(minimal(`${key} = ${value}\n`));

    expect(error.setting).toBe(key);
    expect(error.message).toContain(key);
  });

  it("rejects an invalid git ref", () => {
    const error = captureError(minimal('ref = "--upload-pack=evil"\n'));

    expect(error.setting).toBe("ref");
    expect(error.message).toContain("valid git ref");
  });
});

describe("REG-FR-01 unknown keys and types", () => {
  it("rejects an unknown top-level key and names it", () => {
    const error = captureError(minimal('reprot = "https://example.com/wrong.git"\n'));

    expect(error.setting).toBe("reprot");
    expect(error.message).toContain("reprot");
    expect(error.message).toContain("not a recognized config key");
    expect(error.details.setting).toBe("reprot");
  });

  it("rejects an unknown table and names it", () => {
    const error = captureError(`${minimal()}\n[health]\npath = "/"\n`);

    expect(error.setting).toBe("health");
    expect(error.message).toContain("health");
  });

  it("rejects wrong table value types with the key named", () => {
    const error = captureError(`${minimal()}\n[volumes]\ndata = 42\n`);

    expect(error.setting).toBe("volumes.data");
    expect(error.message).toContain("volumes.data");
    expect(error.message).toContain("42");
  });

  it("rejects wrong env types without echoing the value", () => {
    const error = captureError(`${minimal()}\n[env]\nPORT = 42\n`);

    expect(error.setting).toBe("env.PORT");
    expect(error.message).not.toContain("42");
  });
});

describe("REG-FR-01 path traversal defence", () => {
  it.each(['"../escape"', '"workspace/../../etc"', '".."', '"/etc/passwd"', '"C:\\\\Windows"'])(
    "rejects local_path %s",
    (value) => {
      const error = captureError(`local_path = ${value}\nport = 8080\n`);

      expect(error.setting).toBe("local_path");
      expect(error.message).toContain("local_path");
    },
  );

  it.each(['"../../secrets.env"', '"nested/../../secrets.env"', '"/etc/easy-host/secrets.env"'])(
    "rejects env_file %s",
    (value) => {
      const error = captureError(minimal(`env_file = ${value}\n`));

      expect(error.setting).toBe("env_file");
      expect(error.message).toContain("env_file");
    },
  );

  it("accepts a nested relative env_file and local_path", () => {
    const spec = parseConfigToml(
      'local_path = "src/app"\nenv_file = "secrets/runtime.env"\nport = 8080\n',
    );

    expect(spec.local_path).toBe("src/app");
    expect(spec.env_file).toBe("secrets/runtime.env");
  });

  it("rejects volume names outside the allowlist", () => {
    const error = captureError(`${minimal()}\n[volumes]\n"Bad_Name" = "/data"\n`);

    expect(error.setting).toBe("volumes.Bad_Name");
    expect(error.message).toContain("Bad_Name");
    expect(error.message).toContain("volume name");
  });

  it.each(['"relative/path"', '"/app/../etc"', '"/"', '"/data/../../root"'])(
    "rejects volume container path %s",
    (value) => {
      const error = captureError(`${minimal()}\n[volumes]\ndata = ${value}\n`);

      expect(error.setting).toBe("volumes.data");
      expect(error.message).toContain("volumes.data");
    },
  );

  it("rejects an invalid environment variable name", () => {
    const error = captureError(`${minimal()}\n[env]\n"BAD-NAME" = "value"\n`);

    expect(error.setting).toBe("env.BAD-NAME");
    expect(error.message).toContain("BAD-NAME");
  });
});

describe("REG-FR-01 secret safety", () => {
  it("never includes an [env] value in a validation error", () => {
    const error = captureError(`${REPO}\nport = 80\n\n[env]\nAPI_TOKEN = "super-secret-value"\n`);
    const rendered = `${error.message} ${JSON.stringify(error.details)}`;

    expect(rendered).not.toContain("super-secret-value");
    expect(error.setting).toBe("port");
  });

  it("never includes an [env] value in a TOML syntax error", () => {
    const error = captureError(
      `${REPO}\nport = 8080\n\n[env]\nAPI_TOKEN = "super-secret-value"\nbroken =\n`,
    );

    expect(error.message).not.toContain("super-secret-value");
    expect(error.details.file).toBe("config.toml");
    expect(error.details.line).toBeGreaterThan(0);
  });

  it("uses the supplied file name in the error summary", () => {
    const error = captureError(`${REPO}\nport = 80\n`, { file: "apps/demo/config.toml" });

    expect(error.message).toContain("apps/demo/config.toml");
  });
});

describe("REG-FR-01 comments and round-trip", () => {
  it("preserves full-line and end-of-line comments across a round-trip", () => {
    const source = `# Deployment settings
repo = "https://github.com/example/demo.git" # primary remote
port = 8080

# Port and health
container_port = 8080
health_path = "/ready"

# Named volumes
[volumes]
# application data
data = "/var/lib/app" # persistent

[env]
# runtime mode
NODE_ENV = "production"
`;

    const spec = parseConfigToml(source);
    const rendered = serializeConfig(spec);

    expect(rendered).toContain("# Deployment settings");
    expect(rendered).toContain("# primary remote");
    expect(rendered).toContain("# Port and health");
    expect(rendered).toContain("# Named volumes");
    expect(rendered).toContain("# application data");
    expect(rendered).toContain("# persistent");
    expect(rendered).toContain("# runtime mode");

    const reparsed = parseConfigToml(rendered);
    expect(reparsed).toEqual(spec);
  });

  it("keeps comments after a value is edited but drops comments for removed keys", () => {
    const source = `# keep me
repo = "https://github.com/example/demo.git"
# drop me
env_file = "secrets.env"
port = 8080
`;
    const spec = parseConfigToml(source);
    const { env_file: _removed, ...withoutEnvFile } = spec;
    const edited: AppSpec = { ...withoutEnvFile, port: 9090 };

    const rendered = serializeConfig(edited, { source });

    expect(rendered).toContain("# keep me");
    expect(rendered).not.toContain("# drop me");
    expect(rendered).toContain("port = 9090");
    expect(rendered).toContain('repo = "https://github.com/example/demo.git"');
    expect(rendered).not.toContain("env_file");
  });

  it("serializes a canonical document without comments and reparses cleanly", () => {
    const spec = parseConfigToml(minimal('env_file = "secrets.env"\n'));
    const rendered = serializeConfig(spec);

    expect(rendered).not.toContain("#");
    expect(rendered.split("\n")[0]).toBe('repo = "https://github.com/example/demo.git"');
    expect(rendered).toContain('ref = "main"');
    expect(rendered).toContain("container_port = 3000");
    expect(rendered).toContain("health_startup_ms = 90000");
    expect(parseConfigToml(rendered)).toEqual(spec);
  });

  it("does not mistake a # inside a quoted value for a comment", () => {
    const source = `${REPO}
port = 8080
health_path = "/health#ready"
`;
    const spec = parseConfigToml(source);
    const rendered = serializeConfig(spec, { source });

    expect(rendered).toContain('health_path = "/health#ready"');
    expect(parseConfigToml(rendered)).toEqual(spec);
  });
});

describe("REG-FR-01 TOML syntax errors", () => {
  it("reports the line and keeps the message free of source text", () => {
    const error = captureError(`${REPO}\nport = 8080\nthis is not toml\n`);

    expect(error.exitCode).toBe(1);
    expect(error.details.line).toBeGreaterThan(0);
    expect(error.message).toContain("TOML");
    expect(error.message).not.toContain("this is not toml");
  });
});

describe("schema object validation", () => {
  it("rejects unknown keys in an object input", () => {
    const error = captureObjectError({
      repo: "https://example.com/demo.git",
      port: 8080,
      unknown: true,
    });

    expect(error.setting).toBe("unknown");
  });
});
