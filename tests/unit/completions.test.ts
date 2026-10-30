import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  COMPLETION_FILES,
  COMPLETION_SHELLS,
  type CompletionCommand,
  type CompletionShell,
  DEFAULT_COMPLETIONS_DIR,
  describeProgram,
  findCompletionDrift,
  generateCompletions,
  writeCompletions,
} from "../../scripts/generate-completions.js";
import { COMMAND_NAMES, createProgram } from "../../src/cli/program.js";

/**
 * Set `EASY_HOST_WRITE_COMPLETIONS=1` to regenerate the committed files with
 * the installed toolchain, then rerun without it to verify the diff:
 *
 *   EASY_HOST_WRITE_COMPLETIONS=1 npx vitest run tests/unit/completions.test.ts
 */
const WRITE_MODE = process.env.EASY_HOST_WRITE_COMPLETIONS === "1";

const tempDirectory = mkdtempSync(join(tmpdir(), "easy-host-completions-"));

afterAll(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

function readCommittedFiles(): Record<CompletionShell, string> {
  const files = {} as Record<CompletionShell, string>;

  for (const shell of COMPLETION_SHELLS) {
    files[shell] = readFileSync(join(DEFAULT_COMPLETIONS_DIR, COMPLETION_FILES[shell]), "utf8");
  }

  return files;
}

function assertCommandListed(
  shell: CompletionShell,
  contents: string,
  command: CompletionCommand,
): void {
  switch (shell) {
    case "bash":
      // The option branch of the command dispatcher exists for every command.
      expect(contents).toContain(`      ${command.name})`);
      break;
    case "zsh":
      expect(contents).toContain(`    ${command.name})`);
      break;
    case "fish":
      expect(contents).toContain(`-a ${command.name} -d`);
      break;
  }
}

/** Fish spells flags as `-l name` and `-s f`; the other shells write the flag. */
function fileMentionsFlag(shell: CompletionShell, contents: string, flag: string): boolean {
  if (shell !== "fish") {
    return contents.includes(flag);
  }

  return flag.startsWith("--")
    ? contents.includes(`-l ${flag.slice(2)} `)
    : contents.includes(`-s ${flag.slice(1)} `);
}

describe("generated shell completions", () => {
  it("regenerates the committed files byte for byte", () => {
    if (WRITE_MODE) {
      writeCompletions(DEFAULT_COMPLETIONS_DIR);
    }

    const written = writeCompletions(tempDirectory);

    expect(written).toHaveLength(COMPLETION_SHELLS.length);

    const committed = readCommittedFiles();

    for (const shell of COMPLETION_SHELLS) {
      const regenerated = readFileSync(join(tempDirectory, COMPLETION_FILES[shell]), "utf8");

      expect(regenerated, `${COMPLETION_FILES[shell]} is out of date`).toBe(committed[shell]);
    }
  });

  it("is deterministic across repeated generations", () => {
    const first = generateCompletions();
    const second = generateCompletions(createProgram());

    expect(second).toEqual(first);

    for (const { contents } of first) {
      expect(contents).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(contents).not.toContain(process.cwd());
    }
  });

  it("contains every command and flag from the CLI definitions in every shell", () => {
    const model = describeProgram(createProgram());

    expect(model.commands.map((command) => command.name)).toEqual([...COMMAND_NAMES]);

    for (const { shell, contents } of generateCompletions()) {
      for (const command of model.commands) {
        assertCommandListed(shell, contents, command);

        for (const option of command.options) {
          for (const flag of [option.short, option.long]) {
            if (flag !== null) {
              expect(
                fileMentionsFlag(shell, contents, flag),
                `${shell} is missing ${command.name} ${flag}`,
              ).toBe(true);
            }
          }
        }
      }

      for (const option of model.globalOptions) {
        for (const flag of [option.short, option.long]) {
          if (flag !== null) {
            expect(
              fileMentionsFlag(shell, contents, flag),
              `${shell} is missing global ${flag}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("reports no drift against the committed files", () => {
    const drift = findCompletionDrift(describeProgram(createProgram()), readCommittedFiles());

    expect(drift).toEqual([]);
  });

  it("fails drift detection when the CLI gains a command the files lack", () => {
    const program = createProgram();

    program.command("prune").description("A command the PRD does not define");

    const drift = findCompletionDrift(describeProgram(program), readCommittedFiles());

    expect(drift.map((entry) => entry.shell)).toEqual([...COMPLETION_SHELLS]);

    for (const entry of drift) {
      expect(entry.missingCommands).toContain("prune");
    }
  });

  it("fails drift detection when a flag disappears from a completion file", () => {
    const model = describeProgram(createProgram());
    const files = readCommittedFiles();

    files.bash = files.bash.replaceAll("--rebuild", "");

    const drift = findCompletionDrift(model, files);

    expect(drift).toEqual([
      { shell: "bash", missingCommands: [], missingFlags: ["update --rebuild"] },
    ]);
  });

  it("registers exactly the ten documented commands and no completion command", () => {
    const names = createProgram().commands.map((command) => command.name());

    expect(names).toEqual([...COMMAND_NAMES]);
    expect(names).toHaveLength(10);
    expect(names).not.toContain("completion");
    expect(names).not.toContain("completions");

    const model = describeProgram(createProgram());

    expect(model.commands.map((command) => command.name)).not.toContain("completion");
  });

  it("documents where to install each generated file", () => {
    const files = readCommittedFiles();

    expect(files.bash).toContain("bash-completion/completions/easy-host");
    expect(files.zsh).toContain("zsh/site-functions/_easy-host");
    expect(files.fish).toContain("fish/completions/easy-host.fish");

    for (const contents of Object.values(files)) {
      expect(contents).toContain("Do not edit this file by hand");
      expect(contents.endsWith("\n")).toBe(true);
    }
  });

  it("keeps every committed completion file in the generated file set", () => {
    const generated = new Set(generateCompletions().map((entry) => entry.file));

    for (const shell of COMPLETION_SHELLS) {
      expect(generated.has(COMPLETION_FILES[shell])).toBe(true);
    }
  });
});
