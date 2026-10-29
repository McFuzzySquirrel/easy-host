#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  version?: unknown;
}

const PACKAGE_MANIFEST_URL = new URL("../../package.json", import.meta.url);

/**
 * Reads the version from the package manifest next to the built entry.
 * The same relative path works from `src/cli/` and `dist/cli/`.
 */
export function readPackageVersion(): string {
  const manifest = JSON.parse(readFileSync(PACKAGE_MANIFEST_URL, "utf8")) as PackageManifest;
  const { version } = manifest;

  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json does not declare a version");
  }

  return version;
}

/**
 * Writes the package version to stdout. The scaffold has no subcommands yet;
 * `PRE-1.4` replaces this entry point with the ten-command program.
 */
export function main(): number {
  process.stdout.write(`${readPackageVersion()}\n`);
  return 0;
}

function isDirectExecution(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  const modulePath = fileURLToPath(import.meta.url);
  if (invokedPath === modulePath) {
    return true;
  }

  try {
    return realpathSync(invokedPath) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = main();
}
