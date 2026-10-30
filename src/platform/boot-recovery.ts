import { createDefaultPodmanRunner, type PodmanRunner } from "./podman.js";

/**
 * Rootless reboot recovery.
 *
 * `--restart=always` is a *supervisor* policy: it is enforced by the
 * podman/conmon process that is already alive, and it is not a boot-time hook.
 * For a rootless user nothing is alive after a reboot until systemd starts the
 * user manager, and even then no container is started unless something replays
 * the restart policy. Lingering only starts the user manager.
 *
 * Podman ships `podman-restart.service`, a systemd *user* unit that runs
 * `podman start --all --filter restart-policy=always` at `default.target`. It is
 * not enabled by default, so `add` enables it. Enabling a user unit needs no
 * root, and it is idempotent.
 */
export const PODMAN_RESTART_SERVICE = "podman-restart.service";

/** The systemd client binary; user units are reached through `systemctl --user`. */
const SYSTEMCTL_BINARY = "systemctl";

/** Finite timeout so `add` can never block on a wedged user manager (`PRD-NF-05`). */
const BOOT_RECOVERY_TIMEOUT_MS = 15_000;

/** Outcome of asking systemd to enable the podman restart unit. */
export interface BootRecoveryResult {
  /** The unit that was enabled or attempted. */
  readonly service: string;
  /** True only when `systemctl --user enable --now` exited zero. */
  readonly enabled: boolean;
  /** One-line explanation, safe to show the operator. */
  readonly detail: string;
}

export interface BootRecoveryOptions {
  readonly runner?: PodmanRunner;
  readonly timeoutMs?: number;
}

/**
 * Enables and starts `podman-restart.service` for the invoking user.
 *
 * Never throws: a host without systemd, or a user manager that refuses the
 * operation, is reported as `enabled: false` with the reason so `add` can warn
 * instead of failing a healthy deployment.
 */
export async function enableBootRecovery(
  options: BootRecoveryOptions = {},
): Promise<BootRecoveryResult> {
  const runner = options.runner ?? createDefaultPodmanRunner();
  const timeoutMs = options.timeoutMs ?? BOOT_RECOVERY_TIMEOUT_MS;

  let result: Awaited<ReturnType<PodmanRunner["run"]>>;
  try {
    result = await Promise.resolve(
      runner.run(SYSTEMCTL_BINARY, ["--user", "enable", "--now", PODMAN_RESTART_SERVICE], {
        timeoutMs,
      }),
    );
  } catch (error) {
    return {
      service: PODMAN_RESTART_SERVICE,
      enabled: false,
      detail: `could not run systemctl: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (result.spawnError !== undefined) {
    return {
      service: PODMAN_RESTART_SERVICE,
      enabled: false,
      detail: `systemctl could not start (${result.spawnError})`,
    };
  }

  if (result.exitCode === 0) {
    return {
      service: PODMAN_RESTART_SERVICE,
      enabled: true,
      detail: `${PODMAN_RESTART_SERVICE} is enabled and running for this user.`,
    };
  }

  const reason = firstLine(result.stderr) ?? firstLine(result.stdout) ?? "no output";
  return {
    service: PODMAN_RESTART_SERVICE,
    enabled: false,
    detail: `systemctl --user enable --now ${PODMAN_RESTART_SERVICE} exited ${result.exitCode}: ${reason}`,
  };
}

function firstLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);

  return line;
}
