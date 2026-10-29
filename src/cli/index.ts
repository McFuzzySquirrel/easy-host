#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runWithErrorHandling } from "./errors.js";
import { readPackageVersion, runCli } from "./program.js";

export { readPackageVersion };

/**
 * Runs one CLI invocation from the user-supplied arguments and returns the
 * documented exit code. Argument parsing, command dispatch, and error rendering
 * live in `program.ts`; this entry point only guards against bugs outside that
 * boundary.
 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  return runCli(argv);
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
  process.exitCode = runWithErrorHandling(main, {
    json: process.argv.includes("--json"),
  });
}
