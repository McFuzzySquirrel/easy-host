import { UsageError } from "../errors.js";

/**
 * Remediation shown when an operator invokes a command that is registered but
 * not yet implemented. `PRE-FR-06` requires the ten-command surface to exist
 * before the lifecycle behavior does, so every placeholder points at the
 * commands that do work in this build.
 */
export const NOT_IMPLEMENTED_REMEDIATION =
  "Only the version and doctor commands are implemented in this build. Run easy-host --help to list the available commands.";

/**
 * Builds a commander action that fails with a usage error (exit code 1) instead
 * of silently succeeding. Lifecycle and read commands replace these handlers
 * with real implementations in later tasks.
 */
export function createNotImplementedHandler(command: string): () => never {
  return () => {
    throw new UsageError(`${command} is not implemented yet`, {
      code: "NOT_IMPLEMENTED",
      details: { command },
      remediation: NOT_IMPLEMENTED_REMEDIATION,
    });
  };
}
