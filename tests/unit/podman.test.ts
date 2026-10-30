import { describe, expect, it } from "vitest";
import {
  ConflictError,
  type EasyHostError,
  EXIT_CODES,
  formatError,
  NotFoundError,
  PrerequisiteError,
  UsageError,
} from "../../src/cli/errors.js";
import {
  APP_LABEL,
  containerLogs,
  containerName,
  createVolume,
  DEFAULT_LOGS_TAIL,
  IMAGE_LABEL,
  inspectContainer,
  listVolumes,
  PODMAN_BINARY,
  PODMAN_FAILURE_CODES,
  PODMAN_INSPECT_TIMEOUT_MS,
  PODMAN_LOGS_TIMEOUT_MS,
  PODMAN_REMOVE_TIMEOUT_MS,
  PODMAN_RUN_TIMEOUT_MS,
  PODMAN_STOP_TIMEOUT_MS,
  PODMAN_VOLUME_TIMEOUT_MS,
  type PodmanCommandOptions,
  type PodmanCommandResult,
  type PodmanRunner,
  podmanRunArguments,
  publishSpec,
  ROLE_LABEL,
  removeContainer,
  removeVolume,
  runContainer,
  stopContainer,
  volumeName,
} from "../../src/platform/podman.js";

interface RecordedCall {
  command: string;
  args: string[];
  options: PodmanCommandOptions | undefined;
}

class RecordingRunner implements PodmanRunner {
  readonly calls: RecordedCall[] = [];
  readonly #results: PodmanCommandResult[];

  constructor(results: PodmanCommandResult[] = []) {
    this.#results = [...results];
  }

  run(
    command: string,
    args: readonly string[],
    options?: PodmanCommandOptions,
  ): PodmanCommandResult {
    this.calls.push({ command, args: [...args], options });

    const result = this.#results.shift();
    if (result === undefined) {
      throw new Error("the recording runner has no queued result");
    }

    return result;
  }
}

function ok(stdout = ""): PodmanCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr: string, exitCode = 125): PodmanCommandResult {
  return { exitCode, stdout: "", stderr };
}

async function capture(action: () => Promise<unknown>): Promise<EasyHostError> {
  try {
    await action();
  } catch (error) {
    return error as EasyHostError;
  }

  throw new Error("expected the promise to reject");
}

function captureSync(action: () => unknown): EasyHostError {
  try {
    action();
  } catch (error) {
    return error as EasyHostError;
  }

  throw new Error("expected the action to throw");
}

function singleCall(runner: RecordingRunner): RecordedCall {
  expect(runner.calls).toHaveLength(1);
  const call = runner.calls[0];
  if (call === undefined) {
    throw new Error("expected a recorded call");
  }

  return call;
}

const FULL_IMAGE = "localhost/easy-host-blog:20261030T120000Z";
const MINIMAL_IMAGE = "localhost/easy-host-api:20261030T120000Z";
const SECRET = "top-secret-value";

describe("container naming", () => {
  it("derives the documented container and volume names", () => {
    expect(containerName("blog")).toBe("easy-host-blog");
    expect(volumeName("blog", "data")).toBe("easy-host-blog-data");
  });

  it("brackets IPv6 bind addresses in the publish specification", () => {
    expect(publishSpec("0.0.0.0", 8080, 3000)).toBe("0.0.0.0:8080:3000");
    expect(publishSpec("127.0.0.1", 8080, 3000)).toBe("127.0.0.1:8080:3000");
    expect(publishSpec("::", 8080, 3000)).toBe("[::]:8080:3000");
  });
});

describe("podman run", () => {
  it("builds the exact full run argument array with restart, publish, port, volumes, and labels", async () => {
    const runner = new RecordingRunner([ok("container-id-123\n")]);

    const result = await runContainer({
      app: "blog",
      image: FULL_IMAGE,
      port: 8080,
      containerPort: 3000,
      bind: "0.0.0.0",
      environment: { NODE_ENV: "production", API_TOKEN: SECRET },
      volumes: { data: "/var/lib/data", cache: "/cache" },
      runner,
    });

    const call = singleCall(runner);
    expect(call.command).toBe(PODMAN_BINARY);
    expect(call.args).toEqual([
      "run",
      "--detach",
      "--name",
      "easy-host-blog",
      "--restart=always",
      "--publish",
      "0.0.0.0:8080:3000",
      "--volume",
      "easy-host-blog-cache:/cache",
      "--volume",
      "easy-host-blog-data:/var/lib/data",
      "--label",
      `${APP_LABEL}=blog`,
      "--label",
      `${ROLE_LABEL}=app`,
      "--label",
      `${IMAGE_LABEL}=${FULL_IMAGE}`,
      "--env",
      `API_TOKEN=${SECRET}`,
      "--env",
      "NODE_ENV=production",
      "--env",
      "PORT=3000",
      FULL_IMAGE,
    ]);
    expect(call.options?.timeoutMs).toBe(PODMAN_RUN_TIMEOUT_MS);
    expect(result).toEqual({
      app: "blog",
      container: "easy-host-blog",
      id: "container-id-123",
      image: FULL_IMAGE,
      port: 8080,
      containerPort: 3000,
      bind: "0.0.0.0",
      volumes: ["easy-host-blog-cache", "easy-host-blog-data"],
      environmentNames: ["API_TOKEN", "NODE_ENV", "PORT"],
    });
  });

  it("contains each required run flag exactly once", async () => {
    const runner = new RecordingRunner([ok("id\n")]);

    await runContainer({
      app: "blog",
      image: FULL_IMAGE,
      port: 8080,
      environment: { NODE_ENV: "production", API_TOKEN: SECRET },
      volumes: { data: "/var/lib/data", cache: "/cache" },
      runner,
    });

    const { args } = singleCall(runner);
    expect(args.filter((arg) => arg === "--restart=always")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--publish")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--volume")).toHaveLength(2);
    expect(args.filter((arg) => arg === "--label")).toHaveLength(3);
    expect(args.filter((arg) => arg === "PORT=3000")).toHaveLength(1);
  });

  it("builds a minimal run with defaults and no privileged, host-network, or capability flags", async () => {
    const runner = new RecordingRunner([ok("id\n")]);

    await runContainer({
      app: "api",
      image: MINIMAL_IMAGE,
      port: 9000,
      bind: "127.0.0.1",
      runner,
    });

    const { args } = singleCall(runner);
    expect(args).toEqual([
      "run",
      "--detach",
      "--name",
      "easy-host-api",
      "--restart=always",
      "--publish",
      "127.0.0.1:9000:3000",
      "--label",
      `${APP_LABEL}=api`,
      "--label",
      `${ROLE_LABEL}=app`,
      "--label",
      `${IMAGE_LABEL}=${MINIMAL_IMAGE}`,
      "--env",
      "PORT=3000",
      MINIMAL_IMAGE,
    ]);
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--network");
    expect(args).not.toContain("--net");
    expect(args).not.toContain("--cap-add");
  });

  it("mounts each declared named volume exactly once with the app-scoped name", async () => {
    const runner = new RecordingRunner([ok("id\n")]);

    await runContainer({
      app: "blog",
      image: FULL_IMAGE,
      port: 8080,
      volumes: { data: "/var/lib/data", uploads: "/srv/uploads" },
      runner,
    });

    const { args } = singleCall(runner);
    const mounts = args.flatMap((arg, index) => (arg === "--volume" ? [args[index + 1]] : []));
    expect(mounts).toEqual([
      "easy-host-blog-data:/var/lib/data",
      "easy-host-blog-uploads:/srv/uploads",
    ]);
  });

  it("overrides an app-supplied PORT with the container port exactly once", async () => {
    const runner = new RecordingRunner([ok("id\n")]);

    await runContainer({
      app: "blog",
      image: FULL_IMAGE,
      port: 8080,
      containerPort: 4000,
      environment: { PORT: "9999" },
      runner,
    });

    const { args } = singleCall(runner);
    expect(args.filter((arg) => arg.startsWith("PORT="))).toEqual(["PORT=4000"]);
  });

  it("applies a caller timeout and rejects an empty container id", async () => {
    const constrained = new RecordingRunner([ok("id\n")]);
    await runContainer({
      app: "blog",
      image: FULL_IMAGE,
      port: 8080,
      timeoutMs: 1234,
      runner: constrained,
    });
    expect(singleCall(constrained).options?.timeoutMs).toBe(1234);

    const silent = new RecordingRunner([ok("   \n")]);
    const error = await capture(() =>
      runContainer({ app: "blog", image: FULL_IMAGE, port: 8080, runner: silent }),
    );
    expect(error.code).toBe(PODMAN_FAILURE_CODES.RUN_FAILED);
  });

  it("never prints environment values in a run failure", async () => {
    const runner = new RecordingRunner([
      fail(`Error: invalid env API_TOKEN=${SECRET} while creating container`),
    ]);

    const error = await capture(() =>
      runContainer({
        app: "blog",
        image: FULL_IMAGE,
        port: 8080,
        environment: { API_TOKEN: SECRET },
        runner,
      }),
    );

    expect(error).toBeInstanceOf(PrerequisiteError);
    expect(error.code).toBe(PODMAN_FAILURE_CODES.RUN_FAILED);
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error.details)).not.toContain(SECRET);
    expect(formatError(error)).not.toContain(SECRET);
    expect(error.details.environmentNames).toEqual(["API_TOKEN", "PORT"]);
  });

  it("maps a missing podman binary to a prerequisite failure", async () => {
    const runner = new RecordingRunner([
      { exitCode: 127, stdout: "", stderr: "", spawnError: "ENOENT" },
    ]);

    const error = await capture(() =>
      runContainer({ app: "blog", image: FULL_IMAGE, port: 8080, runner }),
    );

    expect(error).toBeInstanceOf(PrerequisiteError);
    expect(error.exitCode).toBe(EXIT_CODES.PREREQUISITE);
    expect(error.code).toBe(PODMAN_FAILURE_CODES.UNAVAILABLE);
  });

  it("maps an occupied name and an occupied host port to conflicts", async () => {
    const nameRunner = new RecordingRunner([
      fail(
        'Error: creating container storage: the container name "easy-host-blog" is already in use',
      ),
    ]);
    const nameError = await capture(() =>
      runContainer({ app: "blog", image: FULL_IMAGE, port: 8080, runner: nameRunner }),
    );
    expect(nameError).toBeInstanceOf(ConflictError);
    expect(nameError.exitCode).toBe(EXIT_CODES.CONFLICT);
    expect(nameError.code).toBe(PODMAN_FAILURE_CODES.NAME_CONFLICT);
    expect(JSON.stringify(nameError.details)).not.toContain(SECRET);

    const portRunner = new RecordingRunner([
      fail("Error: rootlessport listen tcp 0.0.0.0:8080: bind: address already in use"),
    ]);
    const portError = await capture(() =>
      runContainer({ app: "blog", image: FULL_IMAGE, port: 8080, runner: portRunner }),
    );
    expect(portError).toBeInstanceOf(ConflictError);
    expect(portError.code).toBe(PODMAN_FAILURE_CODES.PORT_IN_USE);
  });

  it("maps a timeout to a prerequisite failure with finite bounds", async () => {
    const runner = new RecordingRunner([
      { exitCode: 124, stdout: "", stderr: "", spawnError: "ETIMEDOUT" },
    ]);

    const error = await capture(() =>
      runContainer({
        app: "blog",
        image: FULL_IMAGE,
        port: 8080,
        timeoutMs: 2500,
        runner,
      }),
    );

    expect(error).toBeInstanceOf(PrerequisiteError);
    expect(error.code).toBe(PODMAN_FAILURE_CODES.TIMEOUT);
    expect(error.details.timeoutMs).toBe(2500);
  });
});

describe("podman run input validation", () => {
  it("rejects privileged host ports and container ports", () => {
    const hostError = captureSync(() =>
      podmanRunArguments({ app: "blog", image: FULL_IMAGE, port: 80 }),
    );
    expect(hostError).toBeInstanceOf(UsageError);
    expect(hostError.exitCode).toBe(EXIT_CODES.USAGE);

    const containerError = captureSync(() =>
      podmanRunArguments({
        app: "blog",
        image: FULL_IMAGE,
        port: 8080,
        containerPort: 80,
      }),
    );
    expect(containerError).toBeInstanceOf(UsageError);
    expect(containerError.code).toBe(PODMAN_FAILURE_CODES.INVALID_CONTAINER_PORT);
  });

  it("rejects unsupported bind addresses and invalid images", () => {
    const bindError = captureSync(() =>
      podmanRunArguments({ app: "blog", image: FULL_IMAGE, port: 8080, bind: "10.0.0.1" }),
    );
    expect(bindError.code).toBe(PODMAN_FAILURE_CODES.INVALID_BIND);

    const imageError = captureSync(() =>
      podmanRunArguments({ app: "blog", image: "bad image", port: 8080 }),
    );
    expect(imageError.code).toBe(PODMAN_FAILURE_CODES.INVALID_IMAGE);
  });

  it("rejects invalid environment names and values without echoing the value", () => {
    const nameError = captureSync(() =>
      podmanRunArguments({
        app: "blog",
        image: FULL_IMAGE,
        port: 8080,
        environment: { "1BAD": "value" },
      }),
    );
    expect(nameError.code).toBe(PODMAN_FAILURE_CODES.INVALID_ENV_NAME);

    const valueError = captureSync(() =>
      podmanRunArguments({
        app: "blog",
        image: FULL_IMAGE,
        port: 8080,
        environment: { OK: "bad\u0000value" },
      }),
    );
    expect(valueError.code).toBe(PODMAN_FAILURE_CODES.INVALID_ENV_VALUE);
    expect(formatError(valueError)).not.toContain("bad");
  });

  it("rejects relative, root, and traversal container paths", () => {
    for (const target of ["relative", "/", "/var/../etc"]) {
      const error = captureSync(() =>
        podmanRunArguments({
          app: "blog",
          image: FULL_IMAGE,
          port: 8080,
          volumes: { data: target },
        }),
      );
      expect(error).toBeInstanceOf(UsageError);
      expect(error.code).toBe(PODMAN_FAILURE_CODES.INVALID_VOLUME_MOUNT);
    }
  });

  it("rejects invalid volume names", () => {
    const error = captureSync(() => volumeName("blog", "Bad_Name"));
    expect(error.code).toBe(PODMAN_FAILURE_CODES.INVALID_VOLUME_NAME);
  });
});

describe("podman stop and remove", () => {
  it("stops the container with a finite timeout", async () => {
    const runner = new RecordingRunner([ok("easy-host-blog\n")]);

    const result = await stopContainer({ app: "blog", runner });

    const call = singleCall(runner);
    expect(call.command).toBe(PODMAN_BINARY);
    expect(call.args).toEqual(["stop", "easy-host-blog"]);
    expect(call.options?.timeoutMs).toBe(PODMAN_STOP_TIMEOUT_MS);
    expect(result).toEqual({ app: "blog", container: "easy-host-blog", stopped: true });
  });

  it("passes an explicit stop grace period", async () => {
    const runner = new RecordingRunner([ok()]);

    await stopContainer({ app: "blog", timeSeconds: 5, runner });

    expect(singleCall(runner).args).toEqual(["stop", "--time", "5", "easy-host-blog"]);
  });

  it("reports a missing container when stopping", async () => {
    const runner = new RecordingRunner([fail("Error: no such container: easy-host-blog", 1)]);

    const error = await capture(() => stopContainer({ app: "blog", runner }));

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.exitCode).toBe(EXIT_CODES.NOT_FOUND);
    expect(error.code).toBe(PODMAN_FAILURE_CODES.CONTAINER_NOT_FOUND);
  });

  it("removes with --force and treats an absent container as cleanup success", async () => {
    const forceRunner = new RecordingRunner([ok("easy-host-blog\n")]);
    const forced = await removeContainer({ app: "blog", force: true, runner: forceRunner });

    const call = singleCall(forceRunner);
    expect(call.args).toEqual(["rm", "--force", "easy-host-blog"]);
    expect(call.options?.timeoutMs).toBe(PODMAN_REMOVE_TIMEOUT_MS);
    expect(forced.removed).toBe(true);

    const missingRunner = new RecordingRunner([
      fail("Error: no such container: easy-host-blog", 1),
    ]);
    const missing = await removeContainer({ app: "blog", runner: missingRunner });
    expect(missing).toEqual({ app: "blog", container: "easy-host-blog", removed: false });
  });

  it("surfaces an absent container when ignoreMissing is disabled", async () => {
    const runner = new RecordingRunner([fail("Error: no such container: easy-host-blog", 1)]);

    const error = await capture(() =>
      removeContainer({ app: "blog", ignoreMissing: false, runner }),
    );

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe(PODMAN_FAILURE_CODES.CONTAINER_NOT_FOUND);
  });

  it("maps a removal failure to a prerequisite failure", async () => {
    const runner = new RecordingRunner([fail("Error: container is running", 2)]);

    const error = await capture(() => removeContainer({ app: "blog", runner }));

    expect(error.code).toBe(PODMAN_FAILURE_CODES.REMOVE_FAILED);
  });
});

describe("podman inspect", () => {
  const inspectJson = JSON.stringify([
    {
      Id: "container-id-123",
      Name: "/easy-host-blog",
      Image: "sha256:image-id",
      ImageName: FULL_IMAGE,
      Created: "2026-10-30T12:00:00.000000000Z",
      State: {
        Status: "running",
        Running: true,
        Paused: false,
        ExitCode: 0,
        StartedAt: "2026-10-30T12:00:01.000000000Z",
        FinishedAt: "0001-01-01T00:00:00Z",
        Error: "",
      },
      Config: {
        Labels: { [APP_LABEL]: "blog", [ROLE_LABEL]: "app", [IMAGE_LABEL]: FULL_IMAGE },
        Env: ["PORT=3000", `API_TOKEN=${SECRET}`],
      },
      HostConfig: { RestartPolicy: { Name: "always", MaximumRetryCount: 0 } },
      NetworkSettings: {
        Ports: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
      },
      Mounts: [
        {
          Type: "volume",
          Name: "easy-host-blog-data",
          Destination: "/var/lib/data",
          Source:
            "/home/operator/.local/share/containers/storage/volumes/easy-host-blog-data/_data",
        },
        {
          Type: "bind",
          Name: "",
          Destination: "/host",
          Source: "/srv/host",
        },
      ],
    },
  ]);

  it("normalizes Podman inspect JSON into a typed, secret-free view", async () => {
    const runner = new RecordingRunner([ok(inspectJson)]);

    const view = await inspectContainer({ app: "blog", runner });

    const call = singleCall(runner);
    expect(call.args).toEqual(["inspect", "easy-host-blog"]);
    expect(call.options?.timeoutMs).toBe(PODMAN_INSPECT_TIMEOUT_MS);
    expect(view).toMatchObject({
      app: "blog",
      name: "easy-host-blog",
      id: "container-id-123",
      image: FULL_IMAGE,
      imageId: "sha256:image-id",
      createdAt: "2026-10-30T12:00:00.000000000Z",
      state: {
        status: "running",
        running: true,
        paused: false,
        exitCode: 0,
        startedAt: "2026-10-30T12:00:01.000000000Z",
        finishedAt: "0001-01-01T00:00:00Z",
      },
      restartPolicy: "always",
      ports: [{ containerPort: 3000, protocol: "tcp", hostIp: "0.0.0.0", hostPort: 8080 }],
      environmentNames: ["API_TOKEN", "PORT"],
      volumes: [{ name: "easy-host-blog-data", destination: "/var/lib/data" }],
    });
    expect(view.labels[APP_LABEL]).toBe("blog");
    expect(view.labels[ROLE_LABEL]).toBe("app");
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it("reports a missing container", async () => {
    const runner = new RecordingRunner([fail("Error: no such container: easy-host-blog", 125)]);

    const error = await capture(() => inspectContainer({ app: "blog", runner }));

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe(PODMAN_FAILURE_CODES.CONTAINER_NOT_FOUND);
  });

  it("classifies malformed inspect output as a prerequisite failure", async () => {
    const invalid = await capture(async () => {
      const runner = new RecordingRunner([ok("not json")]);
      return inspectContainer({ app: "blog", runner });
    });
    expect(invalid.code).toBe(PODMAN_FAILURE_CODES.INSPECT_FAILED);

    const wrongShape = await capture(async () => {
      const runner = new RecordingRunner([ok("[]")]);
      return inspectContainer({ app: "blog", runner });
    });
    expect(wrongShape.code).toBe(PODMAN_FAILURE_CODES.INSPECT_FAILED);
  });
});

describe("podman logs", () => {
  it("passes through -f and --tail with a finite timeout", async () => {
    const runner = new RecordingRunner([ok("line one\nline two\n")]);

    const result = await containerLogs({ app: "blog", runner });

    const call = singleCall(runner);
    expect(call.args).toEqual([
      "logs",
      "-f",
      "--tail",
      String(DEFAULT_LOGS_TAIL),
      "easy-host-blog",
    ]);
    expect(call.options?.timeoutMs).toBe(PODMAN_LOGS_TIMEOUT_MS);
    expect(result).toEqual({
      app: "blog",
      container: "easy-host-blog",
      exitCode: 0,
      stdout: "line one\nline two\n",
      stderr: "",
      followed: true,
      tail: DEFAULT_LOGS_TAIL,
    });
  });

  it("supports an explicit tail, no follow, timestamps, and since", async () => {
    const runner = new RecordingRunner([ok("log\n")]);

    await containerLogs({
      app: "blog",
      follow: false,
      tail: 10,
      timestamps: true,
      since: "10m",
      runner,
    });

    expect(singleCall(runner).args).toEqual([
      "logs",
      "--tail",
      "10",
      "--timestamps",
      "--since",
      "10m",
      "easy-host-blog",
    ]);
  });

  it("reports a missing container and invalid log options", async () => {
    const missingRunner = new RecordingRunner([
      fail("Error: no such container: easy-host-blog", 125),
    ]);
    const error = await capture(() => containerLogs({ app: "blog", runner: missingRunner }));
    expect(error).toBeInstanceOf(NotFoundError);

    const tailError = await capture(async () => {
      const runner = new RecordingRunner([]);
      return containerLogs({ app: "blog", tail: -1, runner });
    });
    expect(tailError).toBeInstanceOf(UsageError);
    expect(tailError.code).toBe(PODMAN_FAILURE_CODES.INVALID_LOG_OPTION);

    const sinceError = await capture(async () => {
      const runner = new RecordingRunner([]);
      return containerLogs({ app: "blog", since: "bad since", runner });
    });
    expect(sinceError.code).toBe(PODMAN_FAILURE_CODES.INVALID_LOG_OPTION);
  });
});

describe("podman volumes", () => {
  it("creates a labelled app volume with a finite timeout", async () => {
    const runner = new RecordingRunner([ok("easy-host-blog-data\n")]);

    const result = await createVolume({ app: "blog", volume: "data", runner });

    const call = singleCall(runner);
    expect(call.args).toEqual([
      "volume",
      "create",
      "--label",
      `${APP_LABEL}=blog`,
      "easy-host-blog-data",
    ]);
    expect(call.options?.timeoutMs).toBe(PODMAN_VOLUME_TIMEOUT_MS);
    expect(result).toEqual({ app: "blog", volume: "data", name: "easy-host-blog-data" });
  });

  it("adds --ignore only when reuse is requested", async () => {
    const runner = new RecordingRunner([ok("easy-host-blog-data\n")]);

    await createVolume({ app: "blog", volume: "data", ignoreExisting: true, runner });

    expect(singleCall(runner).args).toEqual([
      "volume",
      "create",
      "--label",
      `${APP_LABEL}=blog`,
      "--ignore",
      "easy-host-blog-data",
    ]);
  });

  it("maps an existing volume to a conflict", async () => {
    const runner = new RecordingRunner([
      fail("Error: volume with name easy-host-blog-data already exists: volume already exists"),
    ]);

    const error = await capture(() => createVolume({ app: "blog", volume: "data", runner }));

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.exitCode).toBe(EXIT_CODES.CONFLICT);
    expect(error.code).toBe(PODMAN_FAILURE_CODES.VOLUME_EXISTS);
  });

  it("lists app volumes through the label filter and normalizes the JSON", async () => {
    const runner = new RecordingRunner([
      ok(
        JSON.stringify([
          {
            Name: "easy-host-blog-data",
            Driver: "local",
            CreatedAt: "2026-10-30T12:00:00Z",
            Labels: { [APP_LABEL]: "blog" },
          },
          {
            Name: "easy-host-blog-cache",
            Labels: { [APP_LABEL]: "blog" },
          },
        ]),
      ),
    ]);

    const volumes = await listVolumes({ app: "blog", runner });

    const call = singleCall(runner);
    expect(call.args).toEqual([
      "volume",
      "ls",
      "--filter",
      `label=${APP_LABEL}=blog`,
      "--format",
      "json",
    ]);
    expect(call.options?.timeoutMs).toBe(PODMAN_VOLUME_TIMEOUT_MS);
    expect(volumes.map((volume) => volume.name)).toEqual([
      "easy-host-blog-cache",
      "easy-host-blog-data",
    ]);
    expect(volumes.every((volume) => volume.app === "blog")).toBe(true);
  });

  it("lists every volume without a filter and accepts bare names", async () => {
    const runner = new RecordingRunner([ok(JSON.stringify(["easy-host-foreign"]))]);

    const volumes = await listVolumes({ runner });

    expect(singleCall(runner).args).toEqual(["volume", "ls", "--format", "json"]);
    expect(volumes).toEqual([{ name: "easy-host-foreign", labels: {} }]);
  });

  it("classifies malformed volume listings as prerequisite failures", async () => {
    const runner = new RecordingRunner([ok("{not json")]);

    const error = await capture(() => listVolumes({ runner }));

    expect(error).toBeInstanceOf(PrerequisiteError);
    expect(error.code).toBe(PODMAN_FAILURE_CODES.VOLUME_LIST_FAILED);
  });

  it("removes a volume with a finite timeout and idempotent missing handling", async () => {
    const runner = new RecordingRunner([ok("easy-host-blog-data\n")]);
    const removed = await removeVolume({ name: "easy-host-blog-data", runner });

    expect(singleCall(runner).args).toEqual(["volume", "rm", "easy-host-blog-data"]);
    expect(singleCall(runner).options?.timeoutMs).toBe(PODMAN_VOLUME_TIMEOUT_MS);
    expect(removed).toEqual({ name: "easy-host-blog-data", removed: true });

    const forcedRunner = new RecordingRunner([ok("easy-host-blog-data\n")]);
    await removeVolume({ name: "easy-host-blog-data", force: true, runner: forcedRunner });
    expect(singleCall(forcedRunner).args).toEqual([
      "volume",
      "rm",
      "--force",
      "easy-host-blog-data",
    ]);

    const missingRunner = new RecordingRunner([
      fail("Error: no such volume: easy-host-blog-data", 125),
    ]);
    const missing = await removeVolume({
      name: "easy-host-blog-data",
      ignoreMissing: true,
      runner: missingRunner,
    });
    expect(missing).toEqual({ name: "easy-host-blog-data", removed: false });
  });

  it("reports a missing volume when ignoreMissing is disabled", async () => {
    const runner = new RecordingRunner([fail("Error: no such volume: easy-host-blog-data", 125)]);

    const error = await capture(() => removeVolume({ name: "easy-host-blog-data", runner }));

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe(PODMAN_FAILURE_CODES.VOLUME_NOT_FOUND);
  });

  it("rejects unsafe volume names and invalid stop grace periods", async () => {
    const nameError = await capture(async () => removeVolume({ name: "--all" }));
    expect(nameError).toBeInstanceOf(UsageError);
    expect(nameError.code).toBe(PODMAN_FAILURE_CODES.INVALID_VOLUME_NAME);

    const graceError = await capture(async () => stopContainer({ app: "blog", timeSeconds: 7200 }));
    expect(graceError.code).toBe(PODMAN_FAILURE_CODES.INVALID_STOP_GRACE);
  });
});
