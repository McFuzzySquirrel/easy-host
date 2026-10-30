import { describe, expect, it } from "vitest";
import { enableBootRecovery, PODMAN_RESTART_SERVICE } from "../../src/platform/boot-recovery.js";
import type {
  PodmanCommandOptions,
  PodmanCommandResult,
  PodmanRunner,
} from "../../src/platform/podman.js";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: PodmanCommandOptions;
}

function recordingRunner(result: PodmanCommandResult | (() => never)): {
  readonly runner: PodmanRunner;
  readonly calls: Call[];
} {
  const calls: Call[] = [];

  return {
    calls,
    runner: {
      run(command, args, options = {}) {
        calls.push({ command, args: [...args], options });
        if (typeof result === "function") {
          return result();
        }

        return result;
      },
    },
  };
}

describe("enableBootRecovery", () => {
  it("enables podman-restart.service for the invoking user", async () => {
    const { runner, calls } = recordingRunner({ exitCode: 0, stdout: "", stderr: "" });

    const result = await enableBootRecovery({ runner });

    expect(result).toEqual({
      service: PODMAN_RESTART_SERVICE,
      enabled: true,
      detail: `${PODMAN_RESTART_SERVICE} is enabled and running for this user.`,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("systemctl");
    expect(calls[0]?.args).toEqual(["--user", "enable", "--now", PODMAN_RESTART_SERVICE]);
    expect(calls[0]?.options.timeoutMs).toBeGreaterThan(0);
  });

  it("reports the first stderr line when systemctl exits non-zero", async () => {
    const { runner } = recordingRunner({
      exitCode: 1,
      stdout: "",
      stderr: "Failed to enable unit: Unit file podman-restart.service does not exist.\n",
    });

    const result = await enableBootRecovery({ runner });

    expect(result.enabled).toBe(false);
    expect(result.detail).toContain("exited 1");
    expect(result.detail).toContain("Unit file podman-restart.service does not exist.");
  });

  it("falls back to stdout when stderr is empty", async () => {
    const { runner } = recordingRunner({
      exitCode: 5,
      stdout: "The unit files have no installation config\n",
      stderr: "",
    });

    const result = await enableBootRecovery({ runner });

    expect(result.enabled).toBe(false);
    expect(result.detail).toContain("The unit files have no installation config");
  });

  it("reports a missing systemctl instead of throwing", async () => {
    const { runner } = recordingRunner({
      exitCode: 127,
      stdout: "",
      stderr: "",
      spawnError: "ENOENT",
    });

    const result = await enableBootRecovery({ runner });

    expect(result.enabled).toBe(false);
    expect(result.detail).toContain("ENOENT");
  });

  it("reports a thrown runner instead of throwing", async () => {
    const { runner } = recordingRunner(() => {
      throw new Error("user manager is not running");
    });

    const result = await enableBootRecovery({ runner });

    expect(result.enabled).toBe(false);
    expect(result.detail).toContain("user manager is not running");
  });
});
