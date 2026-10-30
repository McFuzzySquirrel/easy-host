/**
 * The `status` command handler (`ADD-FR-06`).
 *
 * With an app name, `status` prints that app's full detail: configuration,
 * source, probe settings, current and previous image references, live
 * container state, named volumes, and the last recorded health result. Without
 * an app name it prints the same block for every registered app, including
 * broken directories with their parse error.
 *
 * Exit codes follow the documented contract: an unknown app is 5 (raised by
 * the registry), and an app that is not serving — missing, stopped, or last
 * recorded unhealthy — is 4. A healthy or never-probed but running app is 0.
 * The command is read-only: it never takes a lock and never writes the state
 * cache.
 */

import type { AppSpec } from "../../config/schema.js";
import type { OkAppEntry } from "../../registry/store.js";
import { EXIT_CODES, type ExitCode, reportError } from "../errors.js";
import { toStatusDocument, writeJsonDocument } from "../json.js";
import type { StatusAppDocument, StatusDocument } from "../schemas.js";
import {
  type AppRow,
  collectAppRows,
  containerName,
  formatField,
  formatTimestamp,
  inspectAppContainer,
  portsDescription,
  probeDescription,
  type ReadDependencies,
  type ReadDependencyOverrides,
  type ReadOutputStream,
  type ReadRegistry,
  readAppState,
  resolveReadDependencies,
  shortContainerId,
  sourceDescription,
  statusExitCode,
  statusLabel,
  volumesDescription,
} from "./read-model.js";

export type { StatusAppDocument, StatusDocument };
export { toStatusDocument };

/** Options accepted by {@link runStatusCommand}. */
export interface StatusCommandOptions extends ReadDependencyOverrides {
  /** App to inspect. Omit to print every app. */
  readonly app?: string;
  /** Writes one JSON document instead of the human blocks. */
  readonly json?: boolean;
  /** Destination for the report or JSON document. Defaults to stdout. */
  readonly stdout?: ReadOutputStream;
  /** Destination for human errors. Defaults to stderr. */
  readonly stderr?: ReadOutputStream;
}

/**
 * Runs `status`, writes the report, and returns the documented exit code.
 * Unknown apps are reported by the registry as not-found (exit 5); an
 * unhealthy, stopped, or missing app returns 4.
 */
export async function runStatusCommand(options: StatusCommandOptions = {}): Promise<ExitCode> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.environment ?? process.env;

  try {
    const dependencies = resolveReadDependencies(options);
    const rows =
      options.app === undefined
        ? await collectAppRows(dependencies.registry.list(), dependencies)
        : [await collectNamedAppRow(options.app, dependencies.registry, dependencies)];

    if (options.json === true) {
      writeJsonDocument(stdout, toStatusDocument(rows));
    } else {
      stdout.write(formatStatusReport(rows));
    }

    if (options.app !== undefined) {
      const row = rows[0];
      return row === undefined ? EXIT_CODES.SUCCESS : statusExitCode(row.status);
    }

    return rows.some((row) => row.status !== "healthy" && row.status !== "unknown")
      ? EXIT_CODES.HEALTH
      : EXIT_CODES.SUCCESS;
  } catch (error) {
    return reportError(error, {
      stdout,
      stderr,
      env: environment,
      ...(options.json === true ? { json: true } : {}),
    });
  }
}

async function collectNamedAppRow(
  app: string,
  registry: ReadRegistry,
  dependencies: ReadDependencies,
): Promise<AppRow> {
  const record = registry.record(app);
  const spec = registry.readConfig(record.name);
  const state = readAppState(dependencies.stateStore(record.directory));
  const container = await inspectAppContainer(dependencies.runtime, record.name);

  const entry: OkAppEntry = {
    status: "ok",
    name: record.name,
    directory: record.directory,
    configPath: record.configPath,
    spec,
  };

  return {
    name: record.name,
    status: statusLabel(container, state),
    entry,
    spec,
    state,
    container,
    error: undefined,
  };
}

/**
 * Renders one block per app. Each block fits 80 columns, wraps long values
 * under their label, and ends with a blank line except for the last block.
 */
export function formatStatusReport(rows: readonly AppRow[]): string {
  if (rows.length === 0) {
    return "no apps\n";
  }

  const lines: string[] = [];

  for (const row of rows) {
    lines.push(...formatField("app", row.name));
    lines.push(...formatField("status", row.status));
    lines.push(...formatField("config", row.entry.configPath));

    if (row.status === "broken" || row.spec === undefined) {
      if (row.error !== undefined) {
        lines.push(...formatField("error", row.error.message));
        if (row.error.remediation !== undefined && row.error.remediation.length > 0) {
          lines.push(...formatField("next", row.error.remediation));
        }
      }

      lines.push("");
      continue;
    }

    const spec = row.spec;
    lines.push(...formatField("source", sourceDescription(spec)));
    lines.push(...formatField("port", `${spec.port} -> ${spec.container_port} on ${spec.bind}`));
    lines.push(...formatField("probe", probeDescription(spec)));
    lines.push(...formatField("current", row.state?.images.current ?? "none"));
    lines.push(...formatField("previous", row.state?.images.previous ?? "none"));
    lines.push(...formatContainer(row, spec));
    lines.push(...formatHealth(row));
    lines.push(...formatField("updated", formatTimestamp(row.state?.updatedAt)));
    lines.push("");
  }

  while (lines.at(-1) === "") {
    lines.pop();
  }

  return `${lines.join("\n")}\n`;
}

function formatContainer(row: AppRow, spec: AppSpec): string[] {
  const name = containerName(row.name);
  const container = row.container;

  if (container === undefined) {
    return [
      ...formatField("container", `${name} missing`),
      ...formatField("volumes", volumesDescription(undefined, row.name, spec)),
    ];
  }

  const state = container.state;
  const summary = state.running
    ? `${container.name} running (id ${shortContainerId(container.id)})`
    : `${container.name} ${state.status}${
        state.exitCode === 0 ? "" : ` (exit ${state.exitCode})`
      } (id ${shortContainerId(container.id)})`;

  return [
    ...formatField("container", summary),
    ...formatField("image", container.image),
    ...formatField("restart", container.restartPolicy ?? "unknown"),
    ...formatField("started", formatTimestamp(state.startedAt)),
    ...formatField("ports", portsDescription(container.ports)),
    ...formatField("volumes", volumesDescription(container, row.name, spec)),
  ];
}

function formatHealth(row: AppRow): string[] {
  const health = row.state?.health;

  return [
    ...formatField("health", health?.status ?? "unknown"),
    ...formatField("checked", formatTimestamp(health?.checkedAt)),
    ...formatField("detail", health?.detail ?? "no health result recorded"),
  ];
}
