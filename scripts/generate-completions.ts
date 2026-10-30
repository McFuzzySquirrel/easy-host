#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command, Option } from "commander";
import { createProgram } from "../src/cli/program.js";

/**
 * Completion generation for `DOC-FR-05` and `PRD-ACC-07`.
 *
 * The commander program is the single source of truth: this module walks the
 * same `Command` and `Option` definitions that produce `--help`, so a command,
 * argument, or flag can never exist in the help output and be missing from the
 * generated files. Nothing here reads the clock, the working directory, or the
 * host, so regenerating is byte-for-byte deterministic.
 *
 * The module is also the CLI entry:
 *
 *   npx tsx scripts/generate-completions.ts [output-directory]
 *
 * `tests/unit/completions.test.ts` calls {@link writeCompletions} into a
 * temporary directory and compares the result with the committed files.
 */

/** Shells with a shipped completion file. Order is stable on purpose. */
export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** Committed file name for each shell, relative to `completions/`. */
export const COMPLETION_FILES: Readonly<Record<CompletionShell, string>> = {
  bash: "easy-host.bash",
  zsh: "easy-host.zsh",
  fish: "easy-host.fish",
};

export interface CompletionOption {
  readonly short: string | null;
  readonly long: string | null;
  readonly description: string;
  /** Value placeholder from the flag definition, e.g. `port` or `http|tcp`. */
  readonly valueHint: string | null;
  readonly choices: readonly string[];
  readonly takesValue: boolean;
  /** True for options whose value is a filesystem path. */
  readonly fileCompletion: boolean;
}

export interface CompletionArgument {
  readonly name: string;
  readonly required: boolean;
  readonly variadic: boolean;
}

export interface CompletionCommand {
  readonly name: string;
  readonly description: string;
  readonly options: readonly CompletionOption[];
  readonly arguments: readonly CompletionArgument[];
}

export interface CompletionModel {
  readonly program: string;
  /** Options accepted before a subcommand, such as the global `--json`. */
  readonly globalOptions: readonly CompletionOption[];
  readonly commands: readonly CompletionCommand[];
}

/** One generated file and the text it must contain. */
export interface CompletionFile {
  readonly shell: CompletionShell;
  readonly file: string;
  readonly contents: string;
}

export interface CompletionDrift {
  readonly shell: CompletionShell;
  /** Command names defined by the CLI but absent from the completion file. */
  readonly missingCommands: readonly string[];
  /** Long flags defined for a command but absent from the completion file. */
  readonly missingFlags: readonly string[];
}

/**
 * Options whose argument is a filesystem path. Kept explicit because a value
 * placeholder alone cannot distinguish `--volume <name:container-path>` from
 * `--env-file <path>`.
 */
const FILE_OPTIONS: ReadonlySet<string> = new Set(["--local", "--env-file"]);

const HELP_OPTION: CompletionOption = {
  short: "-h",
  long: "--help",
  description: "display help for command",
  valueHint: null,
  choices: [],
  takesValue: false,
  fileCompletion: false,
};

/** Reads `<value>` or `[value]` from a commander flag string. */
export function readValueHint(flags: string): string | null {
  const match = /<([^>]+)>|\[([^\]]+)\]/.exec(flags);

  if (match === null) {
    return null;
  }

  const hint = (match[1] ?? match[2] ?? "").trim();

  return hint.length === 0 ? null : hint;
}

/** Splits `http|tcp` style placeholders into a choice list. */
export function readChoices(valueHint: string | null): readonly string[] {
  if (valueHint === null || !/^[A-Za-z0-9._-]+(?:\|[A-Za-z0-9._-]+)+$/.test(valueHint)) {
    return [];
  }

  return valueHint.split("|");
}

function toCompletionOption(option: Option): CompletionOption {
  const short = option.short ?? null;
  const long = option.long ?? null;
  const valueHint = readValueHint(option.flags);
  const choices =
    option.argChoices !== undefined && option.argChoices.length > 0
      ? [...option.argChoices]
      : readChoices(valueHint);

  return {
    short,
    long,
    description: option.description,
    valueHint,
    choices,
    takesValue: valueHint !== null,
    fileCompletion: long !== null && FILE_OPTIONS.has(long),
  };
}

/**
 * Walks a commander program into the render-neutral model every shell renderer
 * consumes. The order of commands, arguments, and options follows registration
 * order, which is the same order `--help` prints.
 */
export function describeProgram(program: Command): CompletionModel {
  return {
    program: program.name(),
    globalOptions: program.options
      .filter((option) => !option.hidden)
      .map((option) => toCompletionOption(option)),
    commands: program.commands.map((command) => ({
      name: command.name(),
      description: command.description(),
      options: command.options
        .filter((option) => !option.hidden)
        .map((option) => toCompletionOption(option)),
      arguments: command.registeredArguments.map((argument) => ({
        name: argument.name(),
        required: argument.required,
        variadic: argument.variadic,
      })),
    })),
  };
}

function flagNames(option: CompletionOption): string[] {
  return [option.short, option.long].filter((flag): flag is string => flag !== null);
}

function joinFlags(options: readonly CompletionOption[]): string {
  return options.flatMap(flagNames).join(" ");
}

function joinCommandNames(model: CompletionModel): string {
  return model.commands.map((command) => command.name).join(" ");
}

function bashValueOptions(model: CompletionModel): string[] {
  const seen = new Set<string>();
  const patterns: string[] = [];

  for (const option of model.commands.flatMap((command) => command.options)) {
    if (!option.takesValue) {
      continue;
    }

    for (const flag of flagNames(option)) {
      if (!seen.has(flag)) {
        seen.add(flag);
        patterns.push(flag);
      }
    }
  }

  return patterns;
}

function bashCommandValueCases(command: CompletionCommand): string[] {
  const cases: string[] = [];
  const fileFlags = command.options.filter((option) => option.fileCompletion).flatMap(flagNames);

  if (fileFlags.length > 0) {
    cases.push(
      [
        `        ${fileFlags.join("|")})`,
        '          COMPREPLY=( $(compgen -f -- "$cur") )',
        "          ;;",
      ].join("\n"),
    );
  }

  for (const option of command.options) {
    if (option.choices.length === 0) {
      continue;
    }

    cases.push(
      [
        `        ${flagNames(option).join("|")})`,
        `          COMPREPLY=( $(compgen -W "${option.choices.join(" ")}" -- "$cur") )`,
        "          ;;",
      ].join("\n"),
    );
  }

  return cases;
}

function renderBash(model: CompletionModel): string {
  const functionName = `_${model.program.replaceAll("-", "_")}`;
  const valueOptions = bashValueOptions(model);
  const globalFlags = joinFlags([...model.globalOptions, HELP_OPTION]);
  const lines: string[] = [
    "# easy-host bash completion",
    "#",
    "# Generated by scripts/generate-completions.ts from the commander command",
    "# definitions. Do not edit this file by hand; regenerate it instead.",
    "#",
    "# Install: copy this file to",
    `#   \${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/easy-host`,
    "# or source it from ~/.bashrc.",
    "",
    `${functionName}() {`,
    "  local cur prev cmd i skip",
    "  COMPREPLY=()",
    `  cur="\${COMP_WORDS[COMP_CWORD]}"`,
    `  prev="\${COMP_WORDS[COMP_CWORD-1]}"`,
    '  cmd=""',
    "  skip=0",
    "",
    "  for ((i = 1; i < COMP_CWORD; i++)); do",
    "    if ((skip)); then",
    "      skip=0",
    "      continue",
    "    fi",
    `    case "\${COMP_WORDS[i]}" in`,
  ];

  if (valueOptions.length > 0) {
    lines.push(`      ${valueOptions.join("|")})`, "        skip=1", "        ;;");
  }

  lines.push(
    `      ${joinCommandNames(model).replaceAll(" ", "|")})`,
    `        if [[ -z "$cmd" ]]; then`,
    `          cmd="\${COMP_WORDS[i]}"`,
    "        fi",
    "        ;;",
    "    esac",
    "  done",
    "",
    '  if [[ -z "$cmd" ]]; then',
    '    if [[ "$cur" == -* ]]; then',
    `      COMPREPLY=( $(compgen -W "${globalFlags}" -- "$cur") )`,
    "    else",
    `      COMPREPLY=( $(compgen -W "${joinCommandNames(model)}" -- "$cur") )`,
    "    fi",
    "    return 0",
    "  fi",
    "",
    '  if [[ "$cur" == -* ]]; then',
    '    case "$cmd" in',
  );

  for (const command of model.commands) {
    lines.push(
      `      ${command.name})`,
      `        COMPREPLY=( $(compgen -W "${joinFlags([...command.options, HELP_OPTION])}" -- "$cur") )`,
      "        ;;",
    );
  }

  lines.push("    esac", "    return 0", "  fi");

  const valueCases = model.commands
    .map((command) => ({ command, cases: bashCommandValueCases(command) }))
    .filter((entry) => entry.cases.length > 0);

  if (valueCases.length > 0) {
    lines.push("", '  case "$cmd" in');

    for (const { command, cases } of valueCases) {
      lines.push(
        `    ${command.name})`,
        '      case "$prev" in',
        ...cases,
        "      esac",
        "      ;;",
      );
    }

    lines.push("  esac");
  }

  lines.push("", "  return 0", "}", "", `complete -F ${functionName} easy-host`, "");

  return lines.join("\n");
}

/**
 * Escapes text for a zsh single-quoted `_arguments` spec. Brackets and colons
 * are separators in a spec, and a single quote has to close and reopen the
 * quoted word.
 */
function escapeZshText(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "'\\''")
    .replaceAll(":", "\\:")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function zshOptionSpec(option: CompletionOption): string {
  let tail = `[${escapeZshText(option.description)}]`;

  if (option.takesValue) {
    const hint = escapeZshText(option.valueHint ?? "value");
    const action = option.fileCompletion
      ? "_files"
      : option.choices.length > 0
        ? `(${option.choices.map(escapeZshText).join(" ")})`
        : "";

    tail += `:${hint}:${action}`;
  }

  if (option.short !== null && option.long !== null) {
    return `'(${option.short} ${option.long})'{${option.short},${option.long}}'${tail}'`;
  }

  return `'${option.long ?? option.short ?? ""}${tail}'`;
}

function zshArgumentSpec(argument: CompletionArgument): string {
  const position = argument.variadic ? "*" : "1";
  const optional = argument.required ? "" : ":";

  return `'${position}${optional}:${escapeZshText(argument.name)}:'`;
}

function renderZsh(model: CompletionModel): string {
  const functionName = `_${model.program.replaceAll("-", "_")}`;
  const commandArray = `${functionName}_commands`;
  const lines: string[] = [
    `#compdef ${model.program}`,
    `# ${model.program} zsh completion`,
    "#",
    "# Generated by scripts/generate-completions.ts from the commander command",
    "# definitions. Do not edit this file by hand; regenerate it instead.",
    "#",
    "# Install: copy this file to a directory on $fpath, for example",
    `#   \${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions/_easy-host`,
    "# and run compinit.",
    "",
    `${functionName}() {`,
    `  local -a ${commandArray}`,
    `  ${commandArray}=(`,
  ];

  for (const command of model.commands) {
    const description = command.description.replaceAll("'", "'\\''");

    lines.push(`    '${command.name}:${description}'`);
  }

  lines.push(
    "  )",
    "",
    '  local cmd=""',
    "  local i",
    "",
    "  for (( i = 2; i < CURRENT; i++ )); do",
    `    case "\${words[i]}" in`,
    `      ${joinCommandNames(model).replaceAll(" ", "|")})`,
    `        cmd="\${words[i]}"`,
    "        break",
    "        ;;",
    "    esac",
    "  done",
    "",
    '  if [[ -z "$cmd" ]]; then',
    "    _arguments -s \\",
  );

  const globalSpecs = [...model.globalOptions, HELP_OPTION].map(zshOptionSpec);

  globalSpecs.forEach((spec, index) => {
    const continuation = index === globalSpecs.length - 1 ? "" : " \\";

    lines.push(`      ${spec}${continuation}`);
  });

  lines.push(
    `    _describe -t commands '${model.program} command' ${commandArray}`,
    "    return",
    "  fi",
    "",
    '  case "$cmd" in',
  );

  for (const command of model.commands) {
    const specs = [
      ...command.options.map(zshOptionSpec),
      zshOptionSpec(HELP_OPTION),
      ...command.arguments.map(zshArgumentSpec),
    ];

    lines.push(`    ${command.name})`, "      _arguments -s \\");

    specs.forEach((spec, index) => {
      const continuation = index === specs.length - 1 ? "" : " \\";

      lines.push(`        ${spec}${continuation}`);
    });

    lines.push("      ;;");
  }

  lines.push(
    "  esac",
    "}",
    "",
    `if [[ "$funcstack[1]" == "${functionName}" ]]; then`,
    `  ${functionName} "$@"`,
    "fi",
    "",
  );

  return lines.join("\n");
}

function escapeFishText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function fishQuote(text: string): string {
  return `'${escapeFishText(text)}'`;
}

function fishOptionLine(commandName: string, option: CompletionOption): string {
  const condition = `__fish_seen_subcommand_from ${commandName}`;
  const parts = ["complete", "-c", "easy-host", "-n", fishQuote(condition)];

  if (option.short !== null) {
    parts.push("-s", option.short.slice(1));
  }

  if (option.long !== null) {
    parts.push("-l", option.long.slice(2));
  }

  if (option.takesValue) {
    parts.push("-r");
  }

  if (option.fileCompletion) {
    parts.push("-F");
  }

  if (option.choices.length > 0) {
    parts.push("-x", "-a", fishQuote(option.choices.join(" ")));
  }

  parts.push("-d", fishQuote(option.description));

  return parts.join(" ");
}

function renderFish(model: CompletionModel): string {
  const lines: string[] = [
    "# easy-host fish completion",
    "#",
    "# Generated by scripts/generate-completions.ts from the commander command",
    "# definitions. Do not edit this file by hand; regenerate it instead.",
    "#",
    "# Install: copy this file to",
    `#   \${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/easy-host.fish`,
    "",
    "complete -c easy-host -f",
  ];

  for (const option of model.globalOptions) {
    const flags = [
      "-c",
      "easy-host",
      "-n",
      fishQuote("__fish_use_subcommand"),
      ...(option.short === null ? [] : ["-s", option.short.slice(1)]),
      ...(option.long === null ? [] : ["-l", option.long.slice(2)]),
      "-d",
      fishQuote(option.description),
    ];

    lines.push(["complete", ...flags].join(" "));
  }

  lines.push("complete -c easy-host -s h -l help -d 'display help for command'", "");

  for (const command of model.commands) {
    lines.push(
      `complete -c easy-host -n '__fish_use_subcommand' -a ${command.name} -d ${fishQuote(command.description)}`,
    );
  }

  for (const command of model.commands) {
    lines.push("", `# ${command.name}`);

    for (const option of command.options) {
      lines.push(fishOptionLine(command.name, option));
    }
  }

  lines.push("");

  return lines.join("\n");
}

/** Renders one shell from the model. Pure: same model, same bytes. */
export function renderCompletion(shell: CompletionShell, model: CompletionModel): string {
  switch (shell) {
    case "bash":
      return renderBash(model);
    case "zsh":
      return renderZsh(model);
    case "fish":
      return renderFish(model);
  }
}

/**
 * Builds the three completion files from the commander program. No filesystem
 * access and no clock reads, so the result is stable across runs and hosts.
 */
export function generateCompletions(program: Command = createProgram()): CompletionFile[] {
  const model = describeProgram(program);

  return COMPLETION_SHELLS.map((shell) => ({
    shell,
    file: COMPLETION_FILES[shell],
    contents: renderCompletion(shell, model),
  }));
}

/** Writes the three generated files into `targetDirectory`. */
export function writeCompletions(
  targetDirectory: string,
  program: Command = createProgram(),
): string[] {
  const directory = resolve(targetDirectory);

  mkdirSync(directory, { recursive: true });

  return generateCompletions(program).map(({ file, contents }) => {
    const target = resolve(directory, file);

    writeFileSync(target, contents, { encoding: "utf8", mode: 0o644 });

    return target;
  });
}

/**
 * Compares the CLI definitions with existing completion file contents. A
 * missing command or long flag is reported per shell; this is what makes the
 * unit test fail when the surface and the generated files drift.
 */
export function findCompletionDrift(
  model: CompletionModel,
  files: Readonly<Record<CompletionShell, string>>,
): CompletionDrift[] {
  const drift: CompletionDrift[] = [];

  for (const shell of COMPLETION_SHELLS) {
    const contents = files[shell];
    const missingCommands: string[] = [];
    const missingFlags: string[] = [];

    for (const command of model.commands) {
      if (!containsToken(contents, command.name)) {
        missingCommands.push(command.name);
      }

      for (const option of command.options) {
        for (const flag of [option.short, option.long]) {
          if (flag !== null && !fileMentionsFlag(shell, contents, flag)) {
            missingFlags.push(`${command.name} ${flag}`);
          }
        }
      }
    }

    for (const option of model.globalOptions) {
      for (const flag of [option.short, option.long]) {
        if (flag !== null && !fileMentionsFlag(shell, contents, flag)) {
          missingFlags.push(`global ${flag}`);
        }
      }
    }

    if (missingCommands.length > 0 || missingFlags.length > 0) {
      drift.push({ shell, missingCommands, missingFlags });
    }
  }

  return drift;
}

function containsToken(text: string, token: string): boolean {
  return new RegExp(`(?<![\\w-])${escapeRegExp(token)}(?![\\w-])`).test(text);
}

/**
 * Fish spells long and short flags as `-l name` and `-s f`, so a literal
 * `--name` search would report false drift. Bash and zsh write the flag itself.
 */
function fileMentionsFlag(shell: CompletionShell, contents: string, flag: string): boolean {
  if (shell !== "fish") {
    return containsToken(contents, flag);
  }

  if (flag.startsWith("--")) {
    return new RegExp(`(?:^|\\s)-l ${escapeRegExp(flag.slice(2))}(?=\\s|$)`).test(contents);
  }

  return new RegExp(`(?:^|\\s)-s ${escapeRegExp(flag.slice(1))}(?=\\s|$)`).test(contents);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The committed directory is resolved from this module, so the script works
 * from any working directory.
 */
export const DEFAULT_COMPLETIONS_DIR = fileURLToPath(new URL("../completions/", import.meta.url));

function isEntryPoint(): boolean {
  const invoked = process.argv[1];

  if (invoked === undefined) {
    return false;
  }

  return pathToFileURL(resolve(invoked)).href === import.meta.url;
}

if (isEntryPoint()) {
  const target = process.argv[2] ?? DEFAULT_COMPLETIONS_DIR;
  const written = writeCompletions(target);

  process.stdout.write(`Wrote ${written.length} completion files to ${target}\n`);
}
