#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runWithErrorHandlingAsync } from "./errors.js";
import { readPackageVersion, runCli } from "./program.js";

export { readPackageVersion };

/**
 * Runs one CLI invocation from the user-supplied arguments and resolves the
 * documented exit code. Argument parsing, command dispatch, and error rendering
 * live in `program.ts`; this entry point only guards against bugs outside that
 * boundary.
 *
 * The read commands perform bounded asynchronous work (a container inspect),
 * so the entry point is asynchronous by contract.
 */
export function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
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
  void runWithErrorHandlingAsync(main, {
    json: process.argv.includes("--json"),
  }).then((code) => {
    process.exitCode = code;
  });
}
