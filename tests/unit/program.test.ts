import { describe, expect, it } from "vitest";
import type { ConfigCommandOptions } from "../../src/cli/commands/config.js";
import type { DoctorCommandOptions } from "../../src/cli/commands/doctor.js";
import type { ListCommandOptions } from "../../src/cli/commands/list.js";
import type { StatusCommandOptions } from "../../src/cli/commands/status.js";
import {
  COMMAND_NAMES,
  type CommandName,
  createProgram,
  type ProgramOptions,
  readPackageVersion,
  runCli,
} from "../../src/cli/program.js";

const ANSI_ESCAPE = "\u001B[";
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const DOCUMENTED_FLAGS: Readonly<Record<CommandName, readonly string[]>> = {
  add: [
    "--local",
    "--name",
    "--ref",
    "--port",
    "--container-port",
    "--bind",
    "--env-file",
    "--health-path",
    "--probe",
    "--volume",
    "--yes",
  ],
  list: [],
  status: [],
  logs: ["--follow", "--tail"],
  update: ["--rebuild"],
  rollback: [],
  remove: ["--volumes", "--force"],
  config: ["--path", "--edit"],
  doctor: [],
  version: [],
};

const JSON_COMMANDS: readonly CommandName[] = ["list", "status", "config", "doctor", "version"];
const APP_ARGUMENT_COMMANDS: readonly CommandName[] = [
  "logs",
  "update",
  "rollback",
  "remove",
  "config",
];
const PLACEHOLDER_COMMANDS: readonly CommandName[] = [
  "add",
  "logs",
  "update",
  "rollback",
  "remove",
];

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

function createCli(options: ProgramOptions = {}) {
  const stdout = new RecordingStream();
  const stderr = new RecordingStream();
  const env = options.env ?? {};

  return {
    stdout,
    stderr,
    run(argv: readonly string[]): Promise<number> {
      return runCli(argv, {
        ...options,
        stdout,
        stderr,
        env,
        // Doctor probes the real host by default; unit tests inject a stub.
        runDoctor: options.runDoctor ?? (() => 0),
        // The read commands are asynchronous and would inspect the host by
        // default; this suite stays off the host unless it injects a wrapper.
        runList: options.runList ?? (() => 0),
        runStatus: options.runStatus ?? (() => 0),
        runConfig: options.runConfig ?? (() => 0),
      });
    },
  };
}

function commandNames(): string[] {
  return createProgram({
    stdout: new RecordingStream(),
    stderr: new RecordingStream(),
    env: {},
  }).commands.map((command) => command.name());
}

describe("command registration", () => {
  it("registers exactly the ten documented commands in PRD order", () => {
    expect(commandNames()).toEqual([...COMMAND_NAMES]);
    expect(COMMAND_NAMES).toHaveLength(10);
  });

  it("does not register extra lifecycle, completion, or daemon commands", () => {
    const names = commandNames();

    for (const forbidden of ["start", "stop", "restart", "prune", "completion", "daemon"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("declares every documented flag for each command", () => {
    const program = createProgram({
      stdout: new RecordingStream(),
      stderr: new RecordingStream(),
      env: {},
    });

    for (const name of COMMAND_NAMES) {
      const command = program.commands.find((candidate) => candidate.name() === name);
      expect(command, name).toBeDefined();

      const longs = (command?.options ?? []).map((option) => option.long);
      for (const flag of DOCUMENTED_FLAGS[name]) {
        expect(longs, `${name} ${flag}`).toContain(flag);
      }
    }

    for (const name of JSON_COMMANDS) {
      const command = program.commands.find((candidate) => candidate.name() === name);
      expect(
        command?.options.map((option) => option.long),
        `${name} --json`,
      ).toContain("--json");
    }
  });

  it("accepts the global --json flag after a command that does not list it", async () => {
    const { run, stdout, stderr } = createCli();

    expect(await run(["add", "https://example.com/app.git", "--json"])).toBe(1);
    expect(stderr.text).toBe("");

    const document = JSON.parse(stdout.text) as {
      schemaVersion: number;
      error: { code: string };
    };

    expect(document.schemaVersion).toBe(1);
    expect(document.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("declares the global --json flag", () => {
    const program = createProgram({
      stdout: new RecordingStream(),
      stderr: new RecordingStream(),
      env: {},
    });

    expect(program.options.map((option) => option.long)).toContain("--json");
  });

  it("accepts --json on the commands that document it", async () => {
    for (const name of JSON_COMMANDS) {
      const { run } = createCli();
      const argv = APP_ARGUMENT_COMMANDS.includes(name)
        ? [name, "api", "--json"]
        : [name, "--json"];

      // Every JSON command is implemented; doctor and the read handlers are
      // stubbed by `createCli` so this unit test never probes the host.
      expect(await run(argv), name).toBe(0);
    }
  });

  it("forwards --json and the exit code through the read handlers", async () => {
    const listCalls: ListCommandOptions[] = [];
    const statusCalls: StatusCommandOptions[] = [];
    const configCalls: ConfigCommandOptions[] = [];
    const { run } = createCli({
      runList: (options) => {
        listCalls.push(options);
        return 0;
      },
      runStatus: (options) => {
        statusCalls.push(options);
        return 4;
      },
      runConfig: (options) => {
        configCalls.push(options);
        return 0;
      },
    });

    expect(await run(["list", "--json"])).toBe(0);
    expect(await run(["status", "reports", "--json"])).toBe(4);
    expect(await run(["config", "reports", "--json"])).toBe(0);
    expect(await run(["config", "reports", "--path"])).toBe(0);

    expect(listCalls[0]?.json).toBe(true);
    expect(statusCalls[0]?.app).toBe("reports");
    expect(statusCalls[0]?.json).toBe(true);
    expect(configCalls[0]?.app).toBe("reports");
    expect(configCalls[0]?.json).toBe(true);
    expect(configCalls[1]?.path).toBe(true);
    expect(configCalls[1]?.json).toBe(false);
  });

  it("forwards --json and the doctor exit code through the program", async () => {
    const calls: DoctorCommandOptions[] = [];
    const { run } = createCli({
      runDoctor: (options) => {
        calls.push(options);
        return 2;
      },
    });

    expect(await run(["doctor", "--json"])).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.json).toBe(true);
  });
});

describe("help output", () => {
  it("lists every command with a description and exits 0", async () => {
    const { run, stdout, stderr } = createCli();

    expect(await run(["--help"])).toBe(0);
    expect(stderr.text).toBe("");

    const help = stdout.text;
    expect(help).toContain("Usage: easy-host");

    for (const name of COMMAND_NAMES) {
      expect(help).toContain(`  ${name}`);
    }

    expect(help).toContain("Add an app from a git repository or local path");
    expect(help).toContain("Check host prerequisites");
    expect(help).toContain("Print the easy-host version");
    expect(help).toContain("--json");
  });

  it("does not list commander's built-in help command", async () => {
    const { run, stdout } = createCli();

    expect(await run(["--help"])).toBe(0);
    expect(stdout.text).not.toContain("help [command]");
  });

  it("shows the documented flags for a subcommand", async () => {
    const { run, stdout } = createCli();

    expect(await run(["logs", "--help"])).toBe(0);
    expect(stdout.text).toContain("-f, --follow");
    expect(stdout.text).toContain("--tail <n>");
  });

  it("prints help and exits 0 when no command is given", async () => {
    const { run, stdout } = createCli();

    expect(await run([])).toBe(0);
    expect(stdout.text).toContain("Usage: easy-host");
  });
});

describe("usage failures", () => {
  it("exits 1 and names an unknown command", async () => {
    const { run, stderr, stdout } = createCli();

    expect(await run(["bogus"])).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("unknown command");
    expect(stderr.text).toContain("bogus");
    expect(stderr.text).toContain("next:");
    expect(stderr.text).not.toContain("    at ");
  });

  it("exits 1 when a required argument is missing", async () => {
    for (const name of APP_ARGUMENT_COMMANDS) {
      const { run, stderr } = createCli();

      expect(await run([name]), name).toBe(1);
      expect(stderr.text, name).toContain("missing required argument");
      expect(stderr.text, name).toContain("'app'");
    }
  });

  it("exits 1 for an unknown flag", async () => {
    const { run, stderr } = createCli();

    expect(await run(["version", "--bogus"])).toBe(1);
    expect(stderr.text).toContain("unknown option");
  });

  it("emits one JSON error document for a usage failure when --json is set", async () => {
    const { run, stdout, stderr } = createCli();

    expect(await run(["bogus", "--json"])).toBe(1);
    expect(stderr.text).toBe("");

    const document = JSON.parse(stdout.text) as {
      schemaVersion: number;
      error: { code: string; exitCode: number; summary: string };
    };

    expect(document.schemaVersion).toBe(1);
    expect(document.error.exitCode).toBe(1);
    expect(document.error.code).toBe("UNKNOWN_COMMAND");
    expect(document.error.summary).toContain("unknown command");
    expect(stdout.text).not.toContain(ANSI_ESCAPE);
  });
});

describe("placeholder handlers", () => {
  it("exits 1 with a not-implemented usage message", async () => {
    for (const name of PLACEHOLDER_COMMANDS) {
      const { run, stderr } = createCli();
      const argv = name === "add" ? [name, "https://example.com/app.git"] : [name];

      if (APP_ARGUMENT_COMMANDS.includes(name)) {
        argv.push("api");
      }

      expect(await run(argv), name).toBe(1);
      expect(stderr.text, name).toContain("not implemented");
      expect(stderr.text, name).toContain("next:");
    }
  });

  it("accepts --json on a placeholder and reports the error as JSON", async () => {
    const { run, stdout, stderr } = createCli();

    expect(await run(["logs", "api", "--json"])).toBe(1);
    expect(stderr.text).toBe("");

    const document = JSON.parse(stdout.text) as {
      schemaVersion: number;
      error: { code: string; exitCode: number };
    };

    expect(document.schemaVersion).toBe(1);
    expect(document.error.code).toBe("NOT_IMPLEMENTED");
    expect(document.error.exitCode).toBe(1);
  });
});

describe("version command", () => {
  it("prints the package version and exits 0", async () => {
    const { run, stdout, stderr } = createCli();

    expect(await run(["version"])).toBe(0);
    expect(stderr.text).toBe("");
    expect(stdout.text).toBe(`${readPackageVersion()}\n`);
    expect(stdout.text.trim()).toMatch(SEMVER_PATTERN);
  });

  it("accepts the global --json flag before the command", async () => {
    const { run, stdout } = createCli();

    expect(await run(["--json", "version"])).toBe(0);

    const document = JSON.parse(stdout.text) as {
      schemaVersion: number;
      name: string;
      version: string;
    };

    expect(document).toEqual({
      schemaVersion: 1,
      name: "easy-host",
      version: readPackageVersion(),
    });
    expect(document.version).toMatch(SEMVER_PATTERN);
    expect(stdout.text).not.toContain(ANSI_ESCAPE);
  });

  it("emits one JSON document for version --json", async () => {
    const { run, stdout, stderr } = createCli();

    expect(await run(["version", "--json"])).toBe(0);
    expect(stderr.text).toBe("");

    const lines = stdout.text.trim().split("\n");
    const document = JSON.parse(stdout.text) as { schemaVersion: number };

    expect(document.schemaVersion).toBe(1);
    expect(lines.length).toBeGreaterThan(1);
    expect(stdout.text.endsWith("\n")).toBe(true);
  });
});
