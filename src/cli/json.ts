/**
 * Serializers for the frozen machine-readable contract (`OBS-FR-01`).
 *
 * One function per read-only command turns its in-memory result into the
 * document declared in `schemas.ts`. Serialization is deliberately boring:
 *
 * - exactly one newline-terminated JSON document is produced;
 * - `schemaVersion` is always `1` and every documented array is present;
 * - booleans and numbers keep their JSON types and unknown facts are `null`;
 * - timestamps are normalised to ISO 8601 UTC (`Z`), never local offsets;
 * - every string passes through {@link redactText}, and every `[env]` value is
 *   replaced by the stable marker, so ANSI escapes, URL credentials, and
 *   secret values never reach stdout (`OBS-NF-01`, `PRD-NF-10`).
 *
 * Human narration stays with the command handlers and goes to stderr; callers
 * use {@link writeJsonDocument} only for the machine-readable result.
 */

import type { AppSpec } from "../config/schema.js";
import type { DoctorReport } from "../doctor/index.js";
import type { DriftReport } from "../registry/drift.js";
import type { AppRow } from "./commands/read-model.js";
import { REDACTED, redactText } from "./errors.js";
import {
  type ConfigDocument,
  type DoctorDocument,
  type DriftDocument,
  JSON_SCHEMA_VERSION,
  type JsonDocument,
  type ListAppDocument,
  type ListDocument,
  type StatusAppDocument,
  type StatusDocument,
  type VersionDocument,
} from "./schemas.js";

/** The one executable name used by the version document. */
const PROGRAM_NAME = "easy-host";

/** A writable stream, narrowed so tests can inject a recorder. */
export interface JsonOutputStream {
  write(chunk: string): unknown;
}

/** ISO 8601 UTC with a `Z` suffix and optional milliseconds. */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Normalises a timestamp to ISO 8601 UTC. A `Date`, an ISO string with an
 * offset, and an already-UTC string all become `...Z`; anything unparseable
 * becomes `null` so a consumer never has to guess about a malformed value.
 */
export function toIsoUtc(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return null;
  }

  const iso = new Date(milliseconds).toISOString();
  return ISO_UTC_PATTERN.test(iso) ? iso : null;
}

/**
 * A JSON-safe spec projection with every `[env]` value replaced by the stable
 * redaction marker. Variable names remain visible; values never do
 * (`PRD-NF-10`). Nested strings are sanitised so an ANSI escape or a
 * credential embedded in a repository URL cannot enter the document.
 */
export function redactedSpec(spec: AppSpec): Record<string, unknown> {
  const projected: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(spec)) {
    if (key === "env") {
      continue;
    }

    projected[redactText(key)] = redactValue(value);
  }

  const env: Record<string, string> = {};
  for (const name of Object.keys(spec.env).sort()) {
    env[redactText(name)] = REDACTED;
  }
  projected.env = env;

  return projected;
}

/** The stable `version --json` document. */
export function toVersionDocument(version: string): VersionDocument {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    name: PROGRAM_NAME,
    version: redactText(version),
  };
}

/**
 * Projects rows into the stable `list --json` document. Fields are always
 * present; inapplicable values are `null`, and a broken app keeps its error
 * object rather than disappearing from the array (feature 07 open question 1).
 */
export function toListDocument(rows: readonly AppRow[]): ListDocument {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    apps: rows.map(toListAppDocument),
  };
}

function toListAppDocument(row: AppRow): ListAppDocument {
  const image = row.state?.images.current ?? row.container?.image;

  return {
    name: text(row.name),
    status: row.status,
    port: row.spec === undefined ? null : row.spec.port,
    ref: nullableText(row.spec?.ref),
    updatedAt: toIsoUtc(row.state?.updatedAt),
    image: nullableText(image),
    currentImage: nullableText(row.state?.images.current),
    previousImage: nullableText(row.state?.images.previous),
    containerId: nullableText(row.container?.id ?? row.state?.containerId),
    drift: toDriftDocument(row.drift),
    error: errorDocument(row),
  };
}

/**
 * Projects rows into the stable `status --json` document. Broken apps keep
 * their error object and `null` detail fields, so consumers can rely on every
 * field being present.
 */
export function toStatusDocument(rows: readonly AppRow[]): StatusDocument {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    apps: rows.map(toStatusAppDocument),
  };
}

function toStatusAppDocument(row: AppRow): StatusAppDocument {
  const spec = row.spec;
  const state = row.state;
  const container = row.container;

  return {
    name: text(row.name),
    status: row.status,
    configPath: text(row.entry.configPath),
    directory: text(row.entry.directory),
    spec: spec === undefined ? null : redactedSpec(spec),
    source: spec === undefined ? null : sourceDocument(spec),
    images: {
      current: nullableText(state?.images.current),
      previous: nullableText(state?.images.previous),
    },
    container:
      container === undefined
        ? null
        : {
            name: text(container.name),
            state: text(container.state.status),
            running: container.state.running,
            id: text(container.id),
            image: text(container.image),
            restartPolicy: nullableText(container.restartPolicy),
            startedAt: toIsoUtc(container.state.startedAt),
            ports: container.ports.map((binding) => {
              const host = binding.hostIp.length === 0 ? "0.0.0.0" : binding.hostIp;
              return text(
                `${host}:${binding.hostPort}->${binding.containerPort}/${binding.protocol}`,
              );
            }),
            volumes: container.volumes.map((mount) => text(`${mount.name}:${mount.destination}`)),
          },
    health: {
      status: state?.health.status ?? "unknown",
      checkedAt: toIsoUtc(state?.health.checkedAt),
      detail: nullableText(state?.health.detail),
    },
    updatedAt: toIsoUtc(state?.updatedAt),
    drift: toDriftDocument(row.drift),
    error: errorDocument(row),
  };
}

/**
 * Projects the typed drift report into the additive document. Every field is
 * present, and all strings pass through {@link redactText} so a credential in
 * a recorded probe detail cannot reach stdout (`PRD-NF-10`).
 */
export function toDriftDocument(report: DriftReport): DriftDocument {
  return {
    class: report.drift,
    drifted: report.drifted,
    statePresent: report.statePresent,
    recordedImage: nullableText(report.recordedImage),
    liveImage: nullableText(report.liveImage),
    containerIdMatches: report.containerIdMatches,
    summary: text(report.summary),
    recommendedAction: {
      kind: report.recommendedAction.kind,
      command: nullableText(report.recommendedAction.command),
      description: text(report.recommendedAction.description),
    },
  };
}

function sourceDocument(spec: AppSpec): StatusAppDocument["source"] {
  if (spec.local_path !== undefined) {
    return { kind: "local", path: text(spec.local_path), devOnly: true };
  }

  return { kind: "git", repo: nullableText(spec.repo), ref: text(spec.ref) };
}

/**
 * Converts a doctor report into the stable `doctor --json` document. The
 * check order is preserved, `checks` and `disk` are always present, and a
 * passing check carries `remediation: null`. Disk figures are additive in
 * `schemaVersion: 1` (`OBS-FR-04`) and keep `null` for an unmeasurable value.
 */
export function toDoctorDocument(report: DoctorReport): DoctorDocument {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    status: report.status,
    checks: report.checks.map((check) => ({
      id: text(check.id),
      status: check.status,
      detail: text(check.detail),
      remediation: nullableText(check.remediation),
    })),
    disk: {
      freeBytes: byteCount(report.disk.freeBytes),
      totalBytes: byteCount(report.disk.totalBytes),
      appImages: report.disk.appImages.map((entry) => ({
        app: text(entry.app),
        bytes: byteCount(entry.bytes),
      })),
      imagesTotalBytes: byteCount(report.disk.imagesTotalBytes),
      buildkitCacheBytes: byteCount(report.disk.buildkitCacheBytes),
      workspaces: report.disk.workspaces.map((entry) => ({
        app: text(entry.app),
        bytes: byteCount(entry.bytes),
      })),
      workspaceTotalBytes: byteCount(report.disk.workspaceTotalBytes),
      toolsBytes: byteCount(report.disk.toolsBytes),
      approximate: true,
    },
  };
}

/** A finite, non-negative byte count; anything else is unknown (`null`). */
function byteCount(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/**
 * Builds the `config --json` document with every `[env]` value redacted. The
 * command validates before this is called, so `valid` is the literal `true`.
 */
export function toConfigDocument(
  record: { readonly name: string; readonly configPath: string },
  spec: AppSpec,
): ConfigDocument {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    app: text(record.name),
    path: text(record.configPath),
    valid: true,
    config: redactedSpec(spec),
  };
}

/**
 * Serializes exactly one JSON document. Two-space indentation keeps the
 * document readable for humans piping it through `jq`, and the trailing
 * newline makes it a well-formed line-oriented stream.
 */
export function serializeJson(document: JsonDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Writes exactly one document to the machine-readable stream. Callers pass
 * stdout; no human text is ever written through this helper (`OBS-NF-01`).
 */
export function writeJsonDocument(stream: JsonOutputStream, document: JsonDocument): void {
  stream.write(serializeJson(document));
}

function errorDocument(row: AppRow): { code: string; summary: string } | null {
  return row.error === undefined
    ? null
    : { code: text(row.error.code), summary: text(row.error.message) };
}

/** Redacts and strips control sequences from a required string field. */
function text(value: string): string {
  return redactText(value);
}

/** Redacts a nullable string field; an empty value is `null`, never omitted. */
function nullableText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const cleaned = redactText(value);
  return cleaned.length === 0 ? null : cleaned;
}

/** Recursively sanitises string values while preserving JSON primitives. */
function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (value !== null && typeof value === "object") {
    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[redactText(key)] = redactValue(entry);
    }
    return record;
  }

  return value;
}
