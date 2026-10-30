/**
 * CLI and configuration reference drift checks (`DOC-FR-04`, `DOC-NF-01`).
 *
 * The reference is a contract, not prose memory:
 *
 * - command sections and every registered flag and positional argument are
 *   read from the commander program in `src/cli/program.ts`;
 * - the documented exit-code table is compared with `EXIT_CODES`;
 * - the config key table is compared with `APP_SPEC_KEYS`, and every documented
 *   default with `APP_SPEC_DEFAULTS`;
 * - example invocations may only name registered commands and flags;
 * - a synthetic new flag or schema key is reported as drift, so the test fails
 *   when the CLI or schema grows without a matching reference update.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../src/cli/errors.js";
import { COMMAND_NAMES, createProgram, type ProgramOptions } from "../../src/cli/program.js";
import {
  APP_SPEC_DEFAULTS,
  APP_SPEC_KEYS,
  BIND_ADDRESSES,
  ENV_NAME_PATTERN,
  MAX_PORT,
  MIN_HOST_PORT,
  PROBE_KINDS,
  VOLUME_NAME_PATTERN,
} from "../../src/config/schema.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_REFERENCE_PATH = join(REPO_ROOT, "docs/reference/cli.md");
const CONFIG_REFERENCE_PATH = join(REPO_ROOT, "docs/reference/config.md");
const CLI_REFERENCE = readFileSync(CLI_REFERENCE_PATH, "utf8");
const CONFIG_REFERENCE = readFileSync(CONFIG_REFERENCE_PATH, "utf8");

/** A stream that accepts help and error text without writing to the terminal. */
class SilentStream {
  write(_chunk: string): boolean {
    return true;
  }
}

/** Creates the real command definitions without dispatching any action. */
function createTestProgram(): Command {
  const options: ProgramOptions = {
    stdout: new SilentStream(),
    stderr: new SilentStream(),
    env: {},
    readVersion: () => "0.1.0",
  };

  return createProgram(options);
}

/** The body under an exact ATX heading, stopping at the next peer heading. */
function sectionBody(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);

  if (headingIndex === -1) {
    return "";
  }

  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const body: string[] = [];

  for (const line of lines.slice(headingIndex + 1)) {
    const next = /^(#+)\s+/.exec(line);
    if (next !== null && (next[1]?.length ?? 1) <= level) {
      break;
    }
    body.push(line);
  }

  return body.join("\n");
}

/** Every short and long flag commander registers for a command. */
function optionFlags(command: Command): string[] {
  const flags: string[] = [];

  for (const option of command.options) {
    if (typeof option.short === "string" && option.short.length > 0) {
      flags.push(option.short);
    }
    if (typeof option.long === "string" && option.long.length > 0) {
      flags.push(option.long);
    }
  }

  return flags;
}

function commandNamed(program: Command, name: string): Command {
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (command === undefined) {
    throw new Error(`the CLI does not register "${name}"`);
  }
  return command;
}

/**
 * Command sections, flags, and positional arguments the reference does not
 * cover. A new CLI option or argument appears here until it is documented.
 */
function undocumentedCommandParts(markdown: string, program: Command): string[] {
  const missing: string[] = [];

  for (const name of COMMAND_NAMES) {
    const command = commandNamed(program, name);
    const section = sectionBody(markdown, `### ${name}`);

    if (section.length === 0) {
      missing.push(`${name} section`);
      continue;
    }

    for (const flag of optionFlags(command)) {
      if (!section.includes(`\`${flag}`)) {
        missing.push(`${name} ${flag}`);
      }
    }

    for (const argument of command.registeredArguments) {
      if (!section.includes(`\`${argument.name()}`)) {
        missing.push(`${name} <${argument.name()}>`);
      }
    }
  }

  return missing;
}

/** Parses the first cell of every Markdown table row starting with a code. */
function tableRows(markdown: string): string[][] {
  const rows: string[][] = [];

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("|")) {
      continue;
    }

    const cells = line
      .trim()
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (cells.length > 0 && !cells.every((cell) => /^-+$/.test(cell))) {
      rows.push(cells);
    }
  }

  return rows;
}

/** Exit-code rows such as ``| `0` | success | ... |``. */
function documentedExitCodes(markdown: string): Array<{ code: number; label: string }> {
  const codes: Array<{ code: number; label: string }> = [];

  for (const cells of tableRows(markdown)) {
    const codeMatch = /^`(\d+)`$/.exec(cells[0] ?? "");
    if (codeMatch?.[1] !== undefined) {
      codes.push({ code: Number(codeMatch[1]), label: (cells[1] ?? "").trim() });
    }
  }

  return codes;
}

/** Config key rows, keyed by the backticked first cell, from `## Keys`. */
function configKeyRows(markdown: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  const section = sectionBody(markdown, "## Keys");

  for (const cells of tableRows(section)) {
    const keyMatch = /^`([a-z_]+)`$/.exec(cells[0] ?? "");
    if (keyMatch?.[1] !== undefined) {
      rows.set(keyMatch[1], cells);
    }
  }

  return rows;
}

/**
 * Schema keys the config reference does not document. The optional `keys`
 * parameter lets a test inject a synthetic key to prove drift detection.
 */
function undocumentedConfigKeys(
  markdown: string,
  keys: readonly string[] = APP_SPEC_KEYS,
): string[] {
  const rows = configKeyRows(markdown);
  return keys.filter((key) => !rows.has(key));
}

interface DocumentedInvocation {
  readonly command: string;
  readonly flags: readonly string[];
}

/** `easy-host <command> ...` lines that begin an example invocation. */
function documentedInvocations(markdown: string): DocumentedInvocation[] {
  const invocations: DocumentedInvocation[] = [];

  for (const match of markdown.matchAll(
    /^\s*(?:\$\s+)?(?:[A-Z_]+="[^"]*"\s+)?easy-host\s+([a-z][a-z0-9-]*)([^\n]*)$/gm,
  )) {
    const command = match[1];
    const rest = match[2] ?? "";
    if (command === undefined) {
      continue;
    }

    const flags = [...rest.matchAll(/--[a-z][a-z0-9-]*|(?<![\w-])-[a-zA-Z](?![\w-])/g)].map(
      (flag) => flag[0],
    );

    invocations.push({ command, flags });
  }

  return invocations;
}

describe("CLI reference coverage", () => {
  it("documents every registered command as its own section", () => {
    const program = createTestProgram();

    expect(program.commands.map((command) => command.name())).toEqual([...COMMAND_NAMES]);

    for (const name of COMMAND_NAMES) {
      expect(sectionBody(CLI_REFERENCE, `### ${name}`), `missing section for ${name}`).not.toBe("");
    }
  });

  it("documents every registered flag and positional argument", () => {
    const program = createTestProgram();
    const missing = undocumentedCommandParts(CLI_REFERENCE, program);

    expect(missing, `undocumented CLI surface: ${missing.join(", ")}`).toEqual([]);
  });

  it("fails when a new flag is added to the CLI without a reference entry", () => {
    const program = createTestProgram();
    const add = commandNamed(program, "add");
    add.option("--future-flag", "synthetic drift proof");

    const missing = undocumentedCommandParts(CLI_REFERENCE, program);

    expect(missing).toContain("add --future-flag");
    expect(missing).not.toContain("add --name");
  });

  it("documents the global --json and --help flags", () => {
    const globalOptions = sectionBody(CLI_REFERENCE, "## Global options");

    expect(globalOptions).toContain("`--json`");
    expect(globalOptions).toContain("`--help`");
    expect(globalOptions).toContain("`-h`");
  });

  it("only uses registered commands and flags in examples", () => {
    const program = createTestProgram();
    const invocations = documentedInvocations(CLI_REFERENCE);

    expect(invocations.length).toBeGreaterThan(10);

    for (const invocation of invocations) {
      expect(
        COMMAND_NAMES as readonly string[],
        `example uses unregistered command "${invocation.command}"`,
      ).toContain(invocation.command);

      const allowed = new Set(optionFlags(commandNamed(program, invocation.command)));
      allowed.add("--json");
      allowed.add("--help");
      allowed.add("-h");

      for (const flag of invocation.flags) {
        expect(
          [...allowed],
          `example "easy-host ${invocation.command}" uses unregistered flag ${flag}`,
        ).toContain(flag);
      }
    }
  });
});

describe("CLI exit codes", () => {
  it("matches the error taxonomy exactly", () => {
    const documented = documentedExitCodes(sectionBody(CLI_REFERENCE, "## Exit codes"));
    const expected = Object.values(EXIT_CODES);

    expect(documented.map((entry) => entry.code).sort((left, right) => left - right)).toEqual(
      [...expected].sort((left, right) => left - right),
    );

    for (const entry of documented) {
      const taxonomyName = Object.entries(EXIT_CODES)
        .find(([, code]) => code === entry.code)?.[0]
        .toLowerCase()
        .replaceAll("_", " ");

      expect(entry.label.toLowerCase(), `exit ${entry.code} label`).toContain(taxonomyName ?? "");
    }
  });

  it("gives every command an exit-code table with documented codes", () => {
    const known = Object.values(EXIT_CODES);

    for (const name of COMMAND_NAMES) {
      const section = sectionBody(CLI_REFERENCE, `### ${name}`);
      const codes = documentedExitCodes(section).map((entry) => entry.code);

      expect(codes.length, `${name} has no exit-code table`).toBeGreaterThan(0);
      expect(codes, `${name} does not document success`).toContain(EXIT_CODES.SUCCESS);

      for (const code of codes) {
        expect(known, `${name} documents exit ${code}, which is not in EXIT_CODES`).toContain(code);
      }
    }
  });
});

describe("config reference coverage", () => {
  it("documents every schema key with a type, default, and validation rule", () => {
    const rows = configKeyRows(CONFIG_REFERENCE);

    expect([...rows.keys()].sort()).toEqual([...APP_SPEC_KEYS].sort());
    expect(undocumentedConfigKeys(CONFIG_REFERENCE)).toEqual([]);

    for (const key of APP_SPEC_KEYS) {
      const cells = rows.get(key);
      expect(cells, `missing row for ${key}`).toBeDefined();
      expect(cells?.[1] ?? "", `${key} has no TOML type`).not.toBe("");
      expect(cells?.[2] ?? "", `${key} has no default`).not.toBe("");
      expect(cells?.[3] ?? "", `${key} has no validation rule`).not.toBe("");
    }
  });

  it("matches every documented default to APP_SPEC_DEFAULTS", () => {
    const rows = configKeyRows(CONFIG_REFERENCE);

    for (const [key, value] of Object.entries(APP_SPEC_DEFAULTS)) {
      expect(rows.get(key)?.[2] ?? "", `${key} default does not match the schema`).toContain(
        String(value),
      );
    }
  });

  it("fails when a new schema key is added without a reference entry", () => {
    const missing = undocumentedConfigKeys(CONFIG_REFERENCE, [...APP_SPEC_KEYS, "future_key"]);

    expect(missing).toEqual(["future_key"]);
  });

  it("documents ports, bind addresses, and probe kinds from the schema", () => {
    for (const fact of [
      String(MIN_HOST_PORT),
      String(MAX_PORT),
      ...BIND_ADDRESSES,
      ...PROBE_KINDS,
    ]) {
      expect(CONFIG_REFERENCE, `config reference is missing ${fact}`).toContain(fact);
    }
  });

  it("documents the volume and environment name patterns", () => {
    expect(CONFIG_REFERENCE).toContain(VOLUME_NAME_PATTERN.source);
    expect(CONFIG_REFERENCE).toContain(ENV_NAME_PATTERN.source);
  });

  it("documents the volumes table, ownership label, and retention rules", () => {
    for (const fact of [
      "[volumes]",
      "easy-host-blog-data",
      "io.easy-host.app=blog",
      "io.easy-host.app",
      "--volumes",
      "host filesystem path",
    ]) {
      expect(CONFIG_REFERENCE, `config reference is missing ${fact}`).toContain(fact);
    }
  });

  it("documents the environment precedence order", () => {
    const environment = sectionBody(CONFIG_REFERENCE, "## Environment precedence");

    expect(environment).toContain("[env]");
    expect(environment).toContain("secrets file");
    expect(environment).toContain("Later layers win");

    const inline = environment.indexOf("the inline");
    const secrets = environment.indexOf("the secrets file");
    const port = environment.indexOf("`PORT`");

    expect(inline).toBeGreaterThanOrEqual(0);
    expect(secrets).toBeGreaterThan(inline);
    expect(port).toBeGreaterThan(secrets);
  });

  it("documents the config, secrets, and state-root file modes", () => {
    for (const mode of ["0700", "0644", "0600"]) {
      expect(CONFIG_REFERENCE, `config reference is missing mode ${mode}`).toContain(mode);
    }
  });
});
