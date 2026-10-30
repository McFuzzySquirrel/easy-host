/**
 * Frozen machine-readable output contract (`OBS-FR-01`, `OBS-NF-02`).
 *
 * Every `--json` document emitted by a read-only command carries
 * {@link JSON_SCHEMA_VERSION}. Field names in this module are a compatibility
 * contract: additive fields are allowed, while a rename or removal requires a
 * schema-version bump. The types here are the single source of truth for both
 * `src/cli/json.ts` and the command handlers, so a field cannot drift between
 * the serializer and the documented shape.
 *
 * Arrays are always present (an empty registry serialises `"apps": []`), and
 * optional facts are `null` rather than omitted. Timestamps that appear in a
 * document are ISO 8601 UTC strings ending in `Z` (`src/cli/json.ts` normalises
 * them before serialization).
 */

import type { DriftActionKind, DriftClass } from "../registry/drift.js";

/** The only supported machine-readable contract version. */
export const JSON_SCHEMA_VERSION = 1;

/** The literal schema version carried by every document. */
export type JsonSchemaVersion = typeof JSON_SCHEMA_VERSION;

/**
 * A text status derived from cached health and the live container. Meaning is
 * always carried by this label, never by colour (`PRD-ACC-01`).
 */
export type AppStatusLabel = "healthy" | "unhealthy" | "stopped" | "missing" | "unknown" | "broken";

/** Last recorded health outcome; `unknown` means the app was never probed. */
export type JsonHealthStatus = "healthy" | "unhealthy" | "unknown";

/** The recommended update action carried by every drift document. */
export interface DriftActionDocument {
  readonly kind: DriftActionKind;
  /** Operator-ready command, or `null` when no command is needed. */
  readonly command: string | null;
  readonly description: string;
}

/**
 * Additive drift projection (`OBS-FR-03`). `class` is `none` when recorded
 * state and Podman agree, and `unknown` when inspect failed or drift was not
 * checked; `unknown` is never a healthy verdict.
 */
export interface DriftDocument {
  readonly class: DriftClass;
  readonly drifted: boolean;
  readonly statePresent: boolean;
  readonly recordedImage: string | null;
  readonly liveImage: string | null;
  readonly containerIdMatches: boolean | null;
  readonly summary: string;
  readonly recommendedAction: DriftActionDocument;
}

/** `version --json` (`OBS-FR-01`). */
export interface VersionDocument {
  readonly schemaVersion: JsonSchemaVersion;
  readonly name: string;
  readonly version: string;
}

/** One app in the `list --json` document. */
export interface ListAppDocument {
  readonly name: string;
  readonly status: AppStatusLabel;
  readonly port: number | null;
  readonly ref: string | null;
  readonly updatedAt: string | null;
  readonly image: string | null;
  readonly currentImage: string | null;
  readonly previousImage: string | null;
  readonly containerId: string | null;
  /** Additive in schemaVersion 1 (`OBS-NF-02`). */
  readonly drift: DriftDocument;
  readonly error: { readonly code: string; readonly summary: string } | null;
}

/** The stable `list --json` document. Empty registries keep `apps: []`. */
export interface ListDocument {
  readonly schemaVersion: JsonSchemaVersion;
  readonly apps: readonly ListAppDocument[];
}

/** The source a `status --json` app was added from. */
export type StatusSourceDocument =
  | { readonly kind: "git"; readonly repo: string | null; readonly ref: string }
  | { readonly kind: "local"; readonly path: string; readonly devOnly: true };

/** The live container projection in `status --json`. */
export interface StatusContainerDocument {
  readonly name: string;
  readonly state: string;
  readonly running: boolean;
  readonly id: string;
  readonly image: string;
  readonly restartPolicy: string | null;
  readonly startedAt: string | null;
  readonly ports: readonly string[];
  readonly volumes: readonly string[];
}

/** The last recorded health result in `status --json`. */
export interface StatusHealthDocument {
  readonly status: JsonHealthStatus;
  readonly checkedAt: string | null;
  readonly detail: string | null;
}

/** The stable per-app detail object in `status --json`. */
export interface StatusAppDocument {
  readonly name: string;
  readonly status: AppStatusLabel;
  readonly configPath: string;
  readonly directory: string;
  readonly spec: Record<string, unknown> | null;
  readonly source: StatusSourceDocument | null;
  readonly images: { readonly current: string | null; readonly previous: string | null };
  readonly container: StatusContainerDocument | null;
  readonly health: StatusHealthDocument;
  readonly updatedAt: string | null;
  /** Additive in schemaVersion 1 (`OBS-NF-02`). */
  readonly drift: DriftDocument;
  readonly error: { readonly code: string; readonly summary: string } | null;
}

/** The stable `status --json` document. Empty registries keep `apps: []`. */
export interface StatusDocument {
  readonly schemaVersion: JsonSchemaVersion;
  readonly apps: readonly StatusAppDocument[];
}

/** One ordered check in `doctor --json`. */
export interface DoctorCheckDocument {
  readonly id: string;
  readonly status: "pass" | "warn" | "fail" | "skip";
  readonly detail: string;
  readonly remediation: string | null;
}

/** The stable `doctor --json` document. `checks` is always an array. */
export interface DoctorDocument {
  readonly schemaVersion: JsonSchemaVersion;
  readonly status: "pass" | "warn" | "fail";
  readonly checks: readonly DoctorCheckDocument[];
}

/** The stable `config --json` document with every `[env]` value redacted. */
export interface ConfigDocument {
  readonly schemaVersion: JsonSchemaVersion;
  readonly app: string;
  readonly path: string;
  readonly valid: true;
  readonly config: Record<string, unknown>;
}

/** Any document a read-only command may write to stdout. */
export type JsonDocument =
  | VersionDocument
  | ListDocument
  | StatusDocument
  | DoctorDocument
  | ConfigDocument;
