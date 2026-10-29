import { describe, expect, it } from "vitest";
import type { DoctorCommandOptions } from "../../src/cli/commands/doctor.js";
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
  "list",
  "status",
  "logs",
  "update",
  "rollback",
  "remove",
  "config",
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
    run(argv: readonly string[]): number {
      return runCli(argv, {
        ...options,
        stdout,
        stderr,
        env,
        // Doctor probes the real host by default; unit tests inject a stub.
        runDoctor: options.runDoctor ?? (() => 0),
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

  it("accepts the global --json flag after a command that does not list it", () => {
    const { run, stdout, stderr } = createCli();

    expect(run(["add", "https://example.com/app.git", "--json"])).toBe(1);
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

  it("accepts --json on the commands that document it", () => {
    for (const name of JSON_COMMANDS) {
      const { run } = createCli();
      const argv = APP_ARGUMENT_COMMANDS.includes(name)
        ? [name, "api", "--json"]
        : [name, "--json"];

      // `version` and `doctor` succeed and emit JSON; the rest are placeholders
      // that must fail with the JSON error envelope, not an unknown-option error.
      const expected = name === "version" || name === "doctor" ? 0 : 1;
      expect(run(argv), name).toBe(expected);
    }
  });

  it("forwards --json and the doctor exit code through the program", () => {
    const calls: DoctorCommandOptions[] = [];
    const { run } = createCli({
      runDoctor: (options) => {
        calls.push(options);
        return 2;
      },
    });

    expect(run(["doctor", "--json"])).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.json).toBe(true);
  });
});

describe("help output", () => {
  it("lists every command with a description and exits 0", () => {
    const { run, stdout, stderr } = createCli();

    expect(run(["--help"])).toBe(0);
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

  it("does not list commander's built-in help command", () => {
    const { run, stdout } = createCli();

    expect(run(["--help"])).toBe(0);
    expect(stdout.text).not.toContain("help [command]");
  });

  it("shows the documented flags for a subcommand", () => {
    const { run, stdout } = createCli();

    expect(run(["logs", "--help"])).toBe(0);
    expect(stdout.text).toContain("-f, --follow");
    expect(stdout.text).toContain("--tail <n>");
  });

  it("prints help and exits 0 when no command is given", () => {
    const { run, stdout } = createCli();

    expect(run([])).toBe(0);
    expect(stdout.text).toContain("Usage: easy-host");
  });
});

describe("usage failures", () => {
  it("exits 1 and names an unknown command", () => {
    const { run, stderr, stdout } = createCli();

    expect(run(["bogus"])).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("unknown command");
    expect(stderr.text).toContain("bogus");
    expect(stderr.text).toContain("next:");
    expect(stderr.text).not.toContain("    at ");
  });

  it("exits 1 when a required argument is missing", () => {
    for (const name of APP_ARGUMENT_COMMANDS) {
      const { run, stderr } = createCli();

      expect(run([name]), name).toBe(1);
      expect(stderr.text, name).toContain("missing required argument");
      expect(stderr.text, name).toContain("'app'");
    }
  });

  it("exits 1 for an unknown flag", () => {
    const { run, stderr } = createCli();

    expect(run(["version", "--bogus"])).toBe(1);
    expect(stderr.text).toContain("unknown option");
  });

  it("emits one JSON error document for a usage failure when --json is set", () => {
    const { run, stdout, stderr } = createCli();

    expect(run(["bogus", "--json"])).toBe(1);
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
  it("exits 1 with a not-implemented usage message", () => {
    for (const name of PLACEHOLDER_COMMANDS) {
      const { run, stderr } = createCli();
      const argv = name === "add" ? [name, "https://example.com/app.git"] : [name];

      if (APP_ARGUMENT_COMMANDS.includes(name)) {
        argv.push("api");
      }

      expect(run(argv), name).toBe(1);
      expect(stderr.text, name).toContain("not implemented");
      expect(stderr.text, name).toContain("next:");
    }
  });

  it("accepts --json on a placeholder and reports the error as JSON", () => {
    const { run, stdout, stderr } = createCli();

    expect(run(["config", "api", "--json"])).toBe(1);
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
  it("prints the package version and exits 0", () => {
    const { run, stdout, stderr } = createCli();

    expect(run(["version"])).toBe(0);
    expect(stderr.text).toBe("");
    expect(stdout.text).toBe(`${readPackageVersion()}\n`);
    expect(stdout.text.trim()).toMatch(SEMVER_PATTERN);
  });

  it("accepts the global --json flag before the command", () => {
    const { run, stdout } = createCli();

    expect(run(["--json", "version"])).toBe(0);

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

  it("emits one JSON document for version --json", () => {
    const { run, stdout, stderr } = createCli();

    expect(run(["version", "--json"])).toBe(0);
    expect(stderr.text).toBe("");

    const lines = stdout.text.trim().split("\n");
    const document = JSON.parse(stdout.text) as { schemaVersion: number };

    expect(document.schemaVersion).toBe(1);
    expect(lines.length).toBeGreaterThan(1);
    expect(stdout.text.endsWith("\n")).toBe(true);
  });
});
