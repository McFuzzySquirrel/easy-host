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
import {
  type AppRow,
  collectAppRows,
  formatField,
  formatTable,
  formatTimestamp,
  LIST_TABLE_COLUMNS,
  type ReadDependencyOverrides,
  type ReadOutputStream,
  resolveReadDependencies,
  shortImage,
} from "./read-model.js";

/** Options accepted by {@link runListCommand}. */
export interface ListCommandOptions extends ReadDependencyOverrides {
  /** Writes the machine-readable document instead of the table. */
  readonly json?: boolean;
  /** Destination for the table or JSON document. Defaults to stdout. */
  readonly stdout?: ReadOutputStream;
  /** Destination for human errors. Defaults to stderr. */
  readonly stderr?: ReadOutputStream;
}

/** One app in the `list --json` document. */
export interface ListAppDocument {
  readonly name: string;
  readonly status: AppRow["status"];
  readonly port: number | null;
  readonly ref: string | null;
  readonly updatedAt: string | null;
  readonly image: string | null;
  readonly currentImage: string | null;
  readonly previousImage: string | null;
  readonly containerId: string | null;
  readonly error: { readonly code: string; readonly summary: string } | null;
}

/** The stable `list --json` document (`schemaVersion: 1`). */
export interface ListDocument {
  readonly schemaVersion: 1;
  readonly apps: readonly ListAppDocument[];
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

    stdout.write(
      options.json === true
        ? `${JSON.stringify(toListDocument(rows), null, 2)}\n`
        : formatListReport(rows),
    );

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
 */
export function formatListReport(rows: readonly AppRow[]): string {
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

  const lines = formatTable(LIST_TABLE_COLUMNS, cells);

  for (const row of rows) {
    if (row.status !== "broken" || row.error === undefined) {
      continue;
    }

    lines.push(...formatField("error", row.error.message));
    if (row.error.remediation !== undefined && row.error.remediation.length > 0) {
      lines.push(...formatField("next", row.error.remediation));
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Projects rows into the stable JSON document. Fields are always present;
 * inapplicable values are `null`, and a broken app carries its error object.
 */
export function toListDocument(rows: readonly AppRow[]): ListDocument {
  return {
    schemaVersion: 1,
    apps: rows.map((row) => ({
      name: row.name,
      status: row.status,
      port: row.spec === undefined ? null : row.spec.port,
      ref: row.spec === undefined ? null : row.spec.ref,
      updatedAt: row.state?.updatedAt ?? null,
      image: row.state?.images.current ?? row.container?.image ?? null,
      currentImage: row.state?.images.current ?? null,
      previousImage: row.state?.images.previous ?? null,
      containerId: row.container?.id ?? row.state?.containerId ?? null,
      error: row.error === undefined ? null : { code: row.error.code, summary: row.error.message },
    })),
  };
}
