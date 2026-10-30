import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_LABEL, createDefaultPodmanRunner, IMAGE_LABEL, type PodmanRunner } from "./podman.js";

/**
 * Applies the two easy-host labels to an image Railpack produced.
 *
 * Railpack builds through BuildKit and loads the result with `docker load`; it
 * has no label flag and the loaded image carries no metadata of ours. Retention
 * and removal both discover an app's images by `io.easy-host.app`, so an
 * unlabelled image is invisible to them: retention silently retains nothing and
 * `remove` only deletes the pair recorded in `state.json`, leaving every failed
 * candidate behind as an orphan.
 *
 * Podman cannot rewrite an image's config in place, but a derived image that
 * only adds `LABEL` instructions shares every layer with its parent and costs
 * roughly 0.1s. The sequence is: build the labelled derived image under a
 * temporary tag, move the real tag onto it, then delete the now-untagged
 * original.
 */
export const LABEL_IMAGE_TEMP_REPOSITORY = "localhost/easy-host-label";

/** Finite timeout: labelling is a local, no-op-layer build. */
const LABEL_IMAGE_TIMEOUT_MS = 60_000;

export interface LabelImageOptions {
  /** Reference of the image the build just produced, for example `localhost/easy-host-demo:2026…`. */
  readonly image: string;
  /** Validated app name, written to {@link APP_LABEL}. */
  readonly app: string;
  readonly runner?: PodmanRunner;
  readonly timeoutMs?: number;
  /** Suffix for the temporary tag; tests inject a stable value. */
  readonly tagSuffix?: string;
  readonly now?: () => number;
}

export interface LabelImageResult {
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * Thrown when the image exists but could not be labelled. The caller must treat
 * this as a build failure: proceeding would leave a container whose image can
 * never be found by retention or removal.
 */
export class ImageLabelError extends Error {
  readonly code = "IMAGE_LABEL_FAILED";
  readonly details: Readonly<Record<string, string>>;

  constructor(message: string, details: Readonly<Record<string, string>>) {
    super(message);
    this.name = "ImageLabelError";
    this.details = details;
  }
}

export async function labelImageForApp(options: LabelImageOptions): Promise<LabelImageResult> {
  const { image, app } = options;
  const runner = options.runner ?? createDefaultPodmanRunner();
  const timeoutMs = options.timeoutMs ?? LABEL_IMAGE_TIMEOUT_MS;
  const suffix = options.tagSuffix ?? `${(options.now ?? Date.now)()}`;
  const temporaryTag = `${LABEL_IMAGE_TEMP_REPOSITORY}:${app}-${suffix}`;

  const originalId = await inspectImageId(runner, image, timeoutMs);
  const directory = mkdtempSync(path.join(tmpdir(), "easy-host-label-"));

  try {
    const containerfile = path.join(directory, "Containerfile");
    writeFileSync(
      containerfile,
      ["FROM " + image, `LABEL ${APP_LABEL}="${app}" ${IMAGE_LABEL}="${image}"`, ""].join("\n"),
      "utf8",
    );

    await podman(runner, ["build", "-q", "-t", temporaryTag, "-f", containerfile, directory], {
      timeoutMs,
      image,
      app,
      step: "build",
    });

    await podman(runner, ["tag", temporaryTag, image], { timeoutMs, image, app, step: "tag" });
    await podman(runner, ["rmi", temporaryTag], { timeoutMs, image, app, step: "untag-temporary" });

    if (originalId !== undefined && originalId !== "") {
      // The original is now untagged and shares no name with the derived image.
      // A refusal here is not fatal: the name already points at the labelled
      // image, and an untagged leftover is pruned by the next retention pass.
      await runner.run("podman", ["rmi", originalId], { timeoutMs });
    }

    const labels = await inspectImageLabels(runner, image, timeoutMs);
    if (labels[APP_LABEL] !== app) {
      throw new ImageLabelError(`image "${image}" is missing ${APP_LABEL}=${app} after labelling`, {
        image,
        app,
        labels: JSON.stringify(labels),
      });
    }

    return { image, labels };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface StepContext {
  readonly timeoutMs: number;
  readonly image: string;
  readonly app: string;
  readonly step: string;
}

async function podman(
  runner: PodmanRunner,
  args: readonly string[],
  context: StepContext,
): Promise<void> {
  let result: Awaited<ReturnType<PodmanRunner["run"]>>;
  try {
    result = await Promise.resolve(runner.run("podman", args, { timeoutMs: context.timeoutMs }));
  } catch (error) {
    throw new ImageLabelError(
      `could not label image "${context.image}" at step "${context.step}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      { image: context.image, app: context.app, step: context.step },
    );
  }

  if (result.spawnError !== undefined || result.exitCode !== 0) {
    const reason =
      result.spawnError ?? firstLine(result.stderr) ?? firstLine(result.stdout) ?? "no output";
    throw new ImageLabelError(
      `could not label image "${context.image}" at step "${context.step}": ${reason}`,
      { image: context.image, app: context.app, step: context.step, reason },
    );
  }
}

async function inspectImageId(
  runner: PodmanRunner,
  image: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const result = await Promise.resolve(
    runner.run("podman", ["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs }),
  );

  if (result.spawnError !== undefined || result.exitCode !== 0) {
    return undefined;
  }

  return firstLine(result.stdout);
}

async function inspectImageLabels(
  runner: PodmanRunner,
  image: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const result = await Promise.resolve(
    runner.run("podman", ["image", "inspect", "--format", "{{json .Labels}}", image], {
      timeoutMs,
    }),
  );

  if (result.spawnError !== undefined || result.exitCode !== 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        labels[key] = value;
      }
    }

    return labels;
  } catch {
    return {};
  }
}

function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
}
