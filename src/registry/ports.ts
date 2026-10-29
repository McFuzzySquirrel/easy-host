/**
 * Cross-app declared-port checks (REG-FR-05).
 *
 * Every app declares exactly one host port. Two apps may not declare the same
 * port even when their bind addresses differ, because the host port is the
 * shared resource (`PRD-C-03`). This module is pure: it reads an app listing the
 * caller already produced and never touches a container, so `add` can satisfy
 * `PRD-NF-03` by rejecting a conflict before its first Podman or git call.
 *
 * Ports below 1024 are rejected here as well as in the config schema, so a
 * caller that assembles a port from flags cannot skip the rootless constraint.
 */

import { ConflictError, UsageError } from "../cli/errors.js";
import { MAX_PORT, MIN_HOST_PORT } from "../config/schema.js";
import type { AppListEntry } from "./store.js";

/** Lowest host port an app may declare (REG-FR-01, PRD-C-03). */
export const MIN_DECLARED_PORT = MIN_HOST_PORT;

/** Highest host port an app may declare. */
export const MAX_DECLARED_PORT = MAX_PORT;

/** One existing app's declared port. `bind` is diagnostics only. */
export interface PortClaim {
  readonly app: string;
  readonly port: number;
  readonly bind: string;
}

/** Options shared by the conflict checks. */
export interface PortCheckOptions {
  /**
   * The app being created or updated. Its own claim is ignored, so changing an
   * app's other settings does not conflict with its current port.
   */
  readonly app?: string;
}

/** Anything that can list the registry: `Registry` satisfies this shape. */
export interface AppListReader {
  list(): readonly AppListEntry[];
}

/**
 * Validates a declared host port. Returns the port unchanged on success.
 *
 * @throws {UsageError} exit code 1 for a privileged, out-of-range, or
 * non-integer port.
 */
export function validateDeclaredPort(port: number): number {
  if (typeof port !== "number" || !Number.isInteger(port)) {
    throw new UsageError(`invalid host port ${String(port)}: must be a whole number`, {
      code: "INVALID_PORT",
      details: { port: portDetail(port), minimum: MIN_DECLARED_PORT, maximum: MAX_DECLARED_PORT },
      remediation: `Choose a whole-number port between ${MIN_DECLARED_PORT} and ${MAX_DECLARED_PORT}.`,
    });
  }

  if (port < MIN_DECLARED_PORT) {
    throw new UsageError(
      `host port ${port} is privileged: rootless Podman can only publish ports ${MIN_DECLARED_PORT}-${MAX_DECLARED_PORT}`,
      {
        code: "INVALID_PORT",
        details: {
          port,
          reason: "privileged",
          minimum: MIN_DECLARED_PORT,
          maximum: MAX_DECLARED_PORT,
        },
        remediation: `Choose a port of ${MIN_DECLARED_PORT} or higher.`,
      },
    );
  }

  if (port > MAX_DECLARED_PORT) {
    throw new UsageError(`host port ${port} is above the maximum of ${MAX_DECLARED_PORT}`, {
      code: "INVALID_PORT",
      details: {
        port,
        reason: "out-of-range",
        minimum: MIN_DECLARED_PORT,
        maximum: MAX_DECLARED_PORT,
      },
      remediation: `Choose a port between ${MIN_DECLARED_PORT} and ${MAX_DECLARED_PORT}.`,
    });
  }

  return port;
}

/**
 * Extracts the declared ports from a registry listing. Broken entries have no
 * trustworthy spec, so they contribute no claim; the caller already reports the
 * broken app separately.
 */
export function portClaimsFromEntries(entries: readonly AppListEntry[]): PortClaim[] {
  const claims: PortClaim[] = [];

  for (const entry of entries) {
    if (entry.status !== "ok") {
      continue;
    }

    claims.push({ app: entry.name, port: entry.spec.port, bind: entry.spec.bind });
  }

  return claims;
}

/**
 * Finds an existing app that declares `port`, ignoring the requesting app when
 * `options.app` names it. Equality alone is the rule: bind addresses are never
 * compared.
 *
 * @throws {UsageError} exit code 1 when `port` itself is invalid.
 */
export function findPortConflict(
  port: number,
  claims: Iterable<PortClaim>,
  options: PortCheckOptions = {},
): PortClaim | undefined {
  const validated = validateDeclaredPort(port);

  for (const claim of claims) {
    if (options.app !== undefined && claim.app === options.app) {
      continue;
    }

    if (claim.port === validated) {
      return claim;
    }
  }

  return undefined;
}

/**
 * Asserts that no other app declares `port`. Intended to run before any
 * container action so a conflict never reaches Podman (PRD-NF-03).
 *
 * @throws {UsageError} exit code 1 for an invalid port.
 * @throws {ConflictError} exit code 6 when another app already declares it.
 */
export function assertPortAvailable(
  port: number,
  claims: Iterable<PortClaim>,
  options: PortCheckOptions = {},
): void {
  const conflict = findPortConflict(port, claims, options);

  if (conflict !== undefined) {
    throw portConflictError(port, conflict, options);
  }
}

/** Convenience wrapper that turns a registry listing into claims first. */
export function assertPortAvailableForApp(
  port: number,
  entries: readonly AppListEntry[],
  options: PortCheckOptions = {},
): void {
  assertPortAvailable(port, portClaimsFromEntries(entries), options);
}

/**
 * Reads the registry and rejects a duplicate port. This is the preflight
 * `add` and update call before they create, stop, or delete anything.
 */
export function assertPortAvailableInRegistry(
  port: number,
  registry: AppListReader,
  options: PortCheckOptions = {},
): void {
  assertPortAvailableForApp(port, registry.list(), options);
}

function portConflictError(
  port: number,
  conflict: PortClaim,
  options: PortCheckOptions,
): ConflictError {
  const requestedBy = options.app === undefined ? "" : ` for app "${options.app}"`;

  return new ConflictError(
    `declared host port ${port}${requestedBy} is already used by app "${conflict.app}" (bind ${conflict.bind})`,
    {
      code: "PORT_CONFLICT",
      details: {
        port,
        app: conflict.app,
        bind: conflict.bind,
        rule: "declared ports must be unique regardless of bind address",
      },
      remediation: `Choose a different host port with --port, or change the existing app with "easy-host config ${conflict.app} --edit".`,
    },
  );
}

function portDetail(port: number): string | number {
  return Number.isFinite(port) ? port : String(port);
}
