/**
 * Packaging install smoke (`DOC-FR-06`, `DOC-NF-08`, `PRD-C-12`).
 *
 * This suite exercises the release-time install path exactly as an operator
 * would: `npm pack` the repository, install the tarball into a clean temporary
 * prefix, and run the installed `easy-host` binary. It is gated behind
 * `EASY_HOST_PACKAGING=1` because it needs the npm registry for runtime
 * dependencies (open question 2 in `docs/features/08-docs-and-packaging.md`);
 * runtime operation itself stays offline.
 *
 * The pack step deliberately removes `dist` first. `npm pack` then has to run
 * the `prepare` script to rebuild it, which proves that a packed artifact is
 * never published from a stale or hand-built output directory.
 */

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface PackageManifest {
  version: string;
  private?: boolean;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
}

const MANIFEST_PATH = fileURLToPath(new URL("../../package.json", import.meta.url));
const REPO_ROOT = dirname(MANIFEST_PATH);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as PackageManifest;
const VERSION = manifest.version;

/** The ten-command surface from PRD 12.1; packaging must not change it. */
const EXPECTED_COMMANDS = [
  "add",
  "list",
  "status",
  "logs",
  "update",
  "rollback",
  "remove",
  "config",
  "doctor",
  "version",
] as const;

const FORBIDDEN_COMMANDS = ["start", "stop", "restart", "prune", "completion", "daemon"] as const;

/**
 * Every packaging failure must tell the operator how to install from the three
 * supported paths (`DOC-FR-06`). The text is appended to assertion messages and
 * to setup failures so a broken release is diagnosable without the source.
 */
const INSTALL_PATHS = [
  "easy-host supports three install paths:",
  "  1. From a clone:    git clone <repository-url> easy-host && cd easy-host && npm install && npm install -g .",
  `  2. From a git tag:  git clone --branch v${VERSION} <repository-url> easy-host && cd easy-host && npm install && npm install -g .`,
  `  3. From a tarball:  npm install && npm pack && npm install -g ./easy-host-${VERSION}.tgz`,
].join("\n");

const PACK_TIMEOUT = 600_000;
const INSTALL_TIMEOUT = 600_000;
const RUN_TIMEOUT = 60_000;

interface CommandResult {
  stdout: string;
  stderr: string;
}

function withInstallPaths(message: string): string {
  return `${message}\n\n${INSTALL_PATHS}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one command without a shell and rejects with the full command, exit
 * status, stdout, and stderr so a packaging failure is actionable.
 *
 * Inherited `npm_config_local_prefix`/`prefix` values can point a nested npm
 * invocation at an unrelated project (for example when this suite runs inside
 * an editor or agent shell), so they are removed; every npm call names its own
 * `--prefix` or working directory explicitly.
 */
function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeout: number },
): Promise<CommandResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.npm_config_local_prefix;
  delete env.npm_config_prefix;
  delete env.npm_config_global_prefix;

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeout);

    const fail = (message: string, cause?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(withInstallPaths(message), { cause }));
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      fail(`could not start "${command}": ${error.message}`, error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      const invocation = [command, ...args].join(" ");
      if (code !== 0) {
        const status = timedOut
          ? `timed out after ${options.timeout}ms`
          : signal === null
            ? `exit ${String(code)}`
            : signal;
        reject(
          new Error(
            withInstallPaths(
              [
                `command failed (${status}): ${invocation}`,
                stdout === "" ? "" : `stdout:\n${stdout}`,
                stderr === "" ? "" : `stderr:\n${stderr}`,
              ]
                .filter((part) => part !== "")
                .join("\n"),
            ),
          ),
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

/** Lists tarball entries with npm's `package/` prefix removed. */
async function listTarball(tarballPath: string): Promise<string[]> {
  const result = await run("tar", ["-tzf", tarballPath], {
    cwd: dirname(tarballPath),
    timeout: RUN_TIMEOUT,
  });

  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => entry.replace(/^package\//, ""));
}

/**
 * Extracts the command names from `easy-host --help`. Commander indents each
 * command with exactly two spaces and wraps descriptions further to the right,
 * so a line with more than two leading spaces is a continuation, not a command.
 */
function parseCommandNames(help: string): string[] {
  const lines = help.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === "Commands:");
  if (heading === -1) {
    return [];
  }

  const names: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    const match = /^ {2}([a-z][a-z0-9-]*)\b/.exec(line);
    if (match?.[1] === undefined) {
      continue;
    }
    names.push(match[1]);
  }

  return names;
}

let tempRoot = "";
let packDir = "";
let prefix = "";
let prefixExistedBeforeInstall = true;
let tarballPath = "";
let tarballEntries: string[] = [];
let preparedDist = false;
let installedBinary = "";
let installedVersion = "";
let installedHelp = "";

beforeAll(
  async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "easy-host-packaging-"));
    packDir = join(tempRoot, "pack");
    prefix = join(tempRoot, "prefix");
    mkdirSync(packDir, { recursive: true });
    prefixExistedBeforeInstall = existsSync(prefix);

    const distDir = join(REPO_ROOT, "dist");
    const distBackup = join(tempRoot, "dist-backup");
    const hadDist = existsSync(distDir);

    try {
      // Force `prepare` to prove the packed entry is built, not inherited. The
      // build output is copied rather than renamed because the temporary root
      // may live on another filesystem.
      if (hadDist) {
        cpSync(distDir, distBackup, { recursive: true });
        rmSync(distDir, { recursive: true, force: true });
      }

      await run(
        "npm",
        [
          "pack",
          "--pack-destination",
          packDir,
          "--ignore-scripts=false",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: REPO_ROOT, timeout: PACK_TIMEOUT },
      );

      preparedDist = existsSync(join(distDir, "cli", "index.js"));

      const packed = readdirSync(packDir).filter((entry) => entry.endsWith(".tgz"));
      if (packed.length !== 1 || packed[0] === undefined) {
        throw new Error(
          `expected exactly one packed tarball in ${packDir}, found ${packed.length}`,
        );
      }
      tarballPath = join(packDir, packed[0]);
      tarballEntries = await listTarball(tarballPath);

      const install = await run(
        "npm",
        ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", tarballPath],
        { cwd: tempRoot, timeout: INSTALL_TIMEOUT },
      );

      installedBinary = join(prefix, "bin", "easy-host");
      if (!existsSync(installedBinary)) {
        throw new Error(
          [
            `npm reported a successful install but ${installedBinary} is missing`,
            `stdout:\n${install.stdout}`,
            `stderr:\n${install.stderr}`,
          ].join("\n"),
        );
      }

      installedVersion = (
        await run(installedBinary, ["version"], { cwd: tempRoot, timeout: RUN_TIMEOUT })
      ).stdout.trim();
      installedHelp = (
        await run(installedBinary, ["--help"], { cwd: tempRoot, timeout: RUN_TIMEOUT })
      ).stdout;
    } catch (error) {
      throw new Error(withInstallPaths(`packaging setup failed\n${describeError(error)}`), {
        cause: error,
      });
    } finally {
      // Restore the developer's build output; the tarball already owns its copy.
      // If the backup could not be created, leave the original tree untouched.
      if (hadDist && existsSync(distBackup)) {
        if (existsSync(distDir)) {
          rmSync(distDir, { recursive: true, force: true });
        }
        cpSync(distBackup, distDir, { recursive: true });
      } else if (!hadDist && existsSync(distDir)) {
        rmSync(distDir, { recursive: true, force: true });
      }
    }
  },
  PACK_TIMEOUT + INSTALL_TIMEOUT + RUN_TIMEOUT,
);

afterAll(() => {
  if (tempRoot !== "") {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 60_000);

describe("package manifest", () => {
  it("declares the DOC-FR-06 packaging fields", () => {
    expect(
      manifest.files,
      withInstallPaths("package.json files list is missing a runtime file"),
    ).toEqual(
      expect.arrayContaining([
        "dist",
        "completions",
        "README.md",
        "LICENSE",
        "docs/operations",
        "docs/reference",
      ]),
    );
    expect(manifest.bin, withInstallPaths("package.json bin mapping")).toEqual({
      "easy-host": "dist/cli/index.js",
    });
    expect(manifest.engines?.node, withInstallPaths("package.json engines.node")).toBe(">=24");
    expect(manifest.scripts?.prepare, withInstallPaths("package.json prepare script")).toBe(
      "npm run build",
    );
    expect(
      manifest.scripts?.["test:packaging"],
      withInstallPaths("package.json test:packaging script"),
    ).toBeDefined();
    expect(
      manifest.scripts?.["test:packaging"],
      withInstallPaths("package.json test:packaging must enable the packaging gate"),
    ).toContain("EASY_HOST_PACKAGING=1");
    expect(
      manifest.scripts?.["test:packaging"],
      withInstallPaths("package.json test:packaging must scope tests/packaging"),
    ).toContain("tests/packaging");
  });

  it("declares no install hook that could download binaries", () => {
    for (const hook of ["preinstall", "install", "postinstall"]) {
      expect(
        manifest.scripts?.[hook],
        withInstallPaths(`package.json must not declare a ${hook} script`),
      ).toBeUndefined();
    }
  });

  it("keeps the package private so no npm registry publish can occur", () => {
    expect(manifest.private, withInstallPaths("package.json private flag")).toBe(true);
  });
});

describe("packed tarball", () => {
  it("rebuilds the built entry through prepare before packing", () => {
    expect(preparedDist, withInstallPaths("prepare did not produce dist/cli/index.js")).toBe(true);
    expect(tarballEntries, withInstallPaths("tarball is missing the built CLI entry")).toContain(
      "dist/cli/index.js",
    );
  });

  it("excludes source test files", () => {
    const testFiles = tarballEntries.filter(
      (entry) => /(^|\/)tests\//.test(entry) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry),
    );

    expect(
      testFiles,
      withInstallPaths(`tarball contains test files: ${testFiles.join(", ")}`),
    ).toEqual([]);
  });

  it("excludes secrets files", () => {
    const secrets = tarballEntries.filter(
      (entry) => /(^|\/)secrets?\.env$/i.test(entry) || /(^|\/)secrets\//i.test(entry),
    );

    expect(secrets, withInstallPaths(`tarball contains secrets: ${secrets.join(", ")}`)).toEqual(
      [],
    );
  });

  it("contains no package source tree or test configuration", () => {
    const forbidden = tarballEntries.filter(
      (entry) => entry.startsWith("src/") || entry === "vitest.config.ts",
    );

    expect(
      forbidden,
      withInstallPaths(`tarball contains source files: ${forbidden.join(", ")}`),
    ).toEqual([]);
  });
});

describe("clean-prefix install", () => {
  it("installs into a prefix that did not exist before the install", () => {
    expect(prefixExistedBeforeInstall, withInstallPaths("install prefix was not clean")).toBe(
      false,
    );
  });

  it("runs the installed binary and prints the package version", () => {
    expect(installedVersion, withInstallPaths("installed easy-host version")).toBe(VERSION);
  });

  it("lists exactly the ten documented commands", () => {
    const names = parseCommandNames(installedHelp);

    expect(names, withInstallPaths(`installed help listed: ${names.join(", ")}`)).toEqual([
      ...EXPECTED_COMMANDS,
    ]);
    expect(names, withInstallPaths("installed help command count")).toHaveLength(10);

    for (const forbidden of FORBIDDEN_COMMANDS) {
      expect(names, withInstallPaths(`installed help must not list "${forbidden}"`)).not.toContain(
        forbidden,
      );
    }
  });
});
