/**
 * The `list` command handler (`ADD-FR-06`).
 *
 * `list` scans the authoritative `apps/` registry, inspects each app's
 * container, and prints one compact row per app with name, status, port, ref,
 * last update, and image. Broken app directories are never hidden: they appear
 * as `broken` with their parse error below the table, and a valid app whose
 * container has disappeared appears as `missing` (PRD open question 6).
 *
 * The command is strictly read-only. It takes no lock, writes no state cache,
 * and never mutates a container. Human output is plain text with no ANSI
 * escapes and every line fits 80 columns (`PRD-ACC-02`, `PRD-ACC-03`).
 */

import { EXIT_CODES, type ExitCode, reportError } from "../errors.js";
import { createFormatter, type Formatter, type TableColumn } from "../format.js";
import { toListDocument, writeJsonDocument } from "../json.js";
import type { ListAppDocument, ListDocument } from "../schemas.js";
import {
  type AppRow,
  collectAppRows,
  formatTimestamp,
  LIST_TABLE_COLUMNS,
  type ReadDependencyOverrides,
  type ReadOutputStream,
  resolveReadDependencies,
  shortImage,
} from "./read-model.js";

export type { ListAppDocument, ListDocument };
export { toListDocument };

/** Options accepted by {@link runListCommand}. */
export interface ListCommandOptions extends ReadDependencyOverrides {
  /** Writes the machine-readable document instead of the table. */
  readonly json?: boolean;
  /** Destination for the table or JSON document. Defaults to stdout. */
  readonly stdout?: ReadOutputStream;
  /** Destination for human errors. Defaults to stderr. */
  readonly stderr?: ReadOutputStream;
}

/**
 * Runs `list`, writes the table (or JSON document), and returns 0. A broken
 * app or an unhealthy app does not fail the listing; `list` is a survey.
 */
export async function runListCommand(options: ListCommandOptions = {}): Promise<ExitCode> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.environment ?? process.env;

  try {
    const dependencies = resolveReadDependencies(options);
    const rows = await collectAppRows(dependencies.registry.list(), dependencies);

    if (options.json === true) {
      writeJsonDocument(stdout, toListDocument(rows));
    } else {
      stdout.write(formatListReport(rows, createFormatter({ stream: stdout, env: environment })));
    }

    return EXIT_CODES.SUCCESS;
  } catch (error) {
    return reportError(error, {
      stdout,
      stderr,
      env: environment,
      ...(options.json === true ? { json: true } : {}),
    });
  }
}

/**
 * Renders the PRD 12.2 table plus an indented error and remediation line for
 * every broken app. Empty registries print an explicit sentence rather than an
 * empty header, so a script can distinguish "no apps" from "scan failed".
 *
 * Colour is decided by the supplied formatter (TTY plus `NO_COLOR`), and only
 * the STATUS cell is painted; the status text is always present. Values that
 * do not fit the table appear in full on detail lines.
 */
export function formatListReport(
  rows: readonly AppRow[],
  formatter: Formatter = createFormatter(),
): string {
  if (rows.length === 0) {
    return "no apps\n";
  }

  const cells = rows.map((row) => [
    row.name,
    row.status,
    row.spec === undefined ? "-" : String(row.spec.port),
    row.spec?.ref ?? "-",
    formatTimestamp(row.state?.updatedAt),
    shortImage(row.state?.images.current ?? row.container?.image),
  ]);

  const lines = formatter.table(listColumns(formatter), cells);

  for (const row of rows) {
    if (row.status !== "broken" || row.error === undefined) {
      continue;
    }

    lines.push(...formatter.field("error", row.error.message));
    if (row.error.remediation !== undefined && row.error.remediation.length > 0) {
      lines.push(...formatter.field("next", row.error.remediation));
    }
  }

  return `${lines.join("\n")}\n`;
}

/** The PRD columns with only the status cell coloured. */
function listColumns(formatter: Formatter): readonly TableColumn[] {
  return LIST_TABLE_COLUMNS.map((column) =>
    column.header === "STATUS" ? { ...column, paint: formatter.status } : column,
  );
}
