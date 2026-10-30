import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ImageLabelError,
  LABEL_IMAGE_TEMP_REPOSITORY,
  labelImageForApp,
} from "../../src/platform/image-label.js";
import type {
  PodmanCommandOptions,
  PodmanCommandResult,
  PodmanRunner,
} from "../../src/platform/podman.js";

const IMAGE = "localhost/easy-host-demo:20261030T120000Z";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: PodmanCommandOptions;
}

function ok(stdout = ""): PodmanCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

class FakePodman implements PodmanRunner {
  readonly calls: Call[] = [];
  containerfile: string | undefined;

  constructor(
    private readonly handler: (args: readonly string[]) => PodmanCommandResult = (args) =>
      defaultResult(args),
  ) {}

  run(
    command: string,
    args: readonly string[],
    options: PodmanCommandOptions = {},
  ): PodmanCommandResult {
    this.calls.push({ command, args: [...args], options });

    const fileIndex = args.indexOf("-f");
    if (args[0] === "build" && fileIndex >= 0) {
      const file = args[fileIndex + 1];
      if (file !== undefined) {
        this.containerfile = readFileSync(file, "utf8");
      }
    }

    return this.handler(args);
  }

  verbs(): string[] {
    return this.calls.map((call) => call.args.slice(0, 2).join(" "));
  }
}

function defaultResult(args: readonly string[]): PodmanCommandResult {
  if (args[0] === "image" && args[1] === "inspect") {
    const format = args[3] ?? "";
    if (format.includes("{{.Id}}")) {
      return ok("sha256:original\n");
    }

    return ok(JSON.stringify({ "io.easy-host.app": "demo", "io.easy-host.image": IMAGE }));
  }

  return ok();
}

describe("labelImageForApp", () => {
  it("derives a labelled image, moves the tag, and deletes the original", async () => {
    const runner = new FakePodman();

    const result = await labelImageForApp({
      image: IMAGE,
      app: "demo",
      runner,
      tagSuffix: "fixed",
    });

    expect(result.image).toBe(IMAGE);
    expect(result.labels["io.easy-host.app"]).toBe("demo");
    expect(runner.verbs()).toEqual([
      "image inspect",
      "build -q",
      "tag " + `${LABEL_IMAGE_TEMP_REPOSITORY}:demo-fixed`,
      "rmi " + `${LABEL_IMAGE_TEMP_REPOSITORY}:demo-fixed`,
      "rmi sha256:original",
      "image inspect",
    ]);
    expect(runner.calls.every((call) => call.command === "podman")).toBe(true);
  });

  it("writes a FROM/LABEL Containerfile that only adds metadata", async () => {
    const runner = new FakePodman();

    await labelImageForApp({ image: IMAGE, app: "demo", runner, tagSuffix: "fixed" });

    expect(runner.containerfile).toContain(`FROM ${IMAGE}`);
    expect(runner.containerfile).toContain('io.easy-host.app="demo"');
    expect(runner.containerfile).toContain(`io.easy-host.image="${IMAGE}"`);
  });

  it("fails with the step name when the derived build fails", async () => {
    const runner = new FakePodman((args) => {
      if (args[0] === "image") {
        return defaultResult(args);
      }

      return { exitCode: 125, stdout: "", stderr: "no space left on device\n" };
    });

    const error = await labelImageForApp({
      image: IMAGE,
      app: "demo",
      runner,
      tagSuffix: "fixed",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ImageLabelError);
    expect((error as ImageLabelError).message).toContain("no space left on device");
    expect((error as ImageLabelError).details.step).toBe("build");
  });

  it("fails when the image still has no app label afterwards", async () => {
    const runner = new FakePodman((args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return (args[3] ?? "").includes("{{.Id}}") ? ok("sha256:original\n") : ok("null");
      }

      return ok();
    });

    const error = await labelImageForApp({
      image: IMAGE,
      app: "demo",
      runner,
      tagSuffix: "fixed",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ImageLabelError);
    expect((error as ImageLabelError).message).toContain("missing io.easy-host.app=demo");
  });

  it("tolerates a missing original id instead of aborting", async () => {
    const runner = new FakePodman((args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return (args[3] ?? "").includes("{{.Id}}")
          ? { exitCode: 1, stdout: "", stderr: "" }
          : ok(JSON.stringify({ "io.easy-host.app": "demo" }));
      }

      return ok();
    });

    const result = await labelImageForApp({
      image: IMAGE,
      app: "demo",
      runner,
      tagSuffix: "fixed",
    });

    expect(result.labels["io.easy-host.app"]).toBe("demo");
    expect(runner.verbs().filter((verb) => verb.startsWith("rmi"))).toHaveLength(1);
  });
});
