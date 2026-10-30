import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { toExitCode } from "../../src/cli/errors.js";
import {
  EASY_HOST_RAILPACK_BIN,
  installRailpack,
  RAILPACK_BINARY_FILENAME,
  RAILPACK_RECEIPT_FILENAME,
  type RailpackFetch,
  type RailpackPaths,
  railpackArchitecture,
  resolveRailpack,
} from "../../src/platform/railpack.js";
import {
  BUILDKIT_DIGEST,
  BUILDKIT_IMAGE,
  BUILDKIT_IMAGE_REFERENCE,
  type PinnedRailpackRelease,
  RAILPACK_RELEASES,
  RAILPACK_SHA256,
  RAILPACK_VERSION,
  type RailpackArchitecture,
} from "../../src/platform/versions.js";

const createdDirectories: string[] = [];
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

const FAKE_RAILPACK = Buffer.from("#!/bin/sh\nprintf 'railpack 0.43.0\\n'\n");
const FAKE_LICENSE = Buffer.from("MIT License\n");

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "easy-host-railpack-"));
  createdDirectories.push(directory);
  return directory;
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

interface TarEntry {
  name: string;
  data: Buffer;
  mode?: number;
}

function buildArchive(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    blocks.push(tarHeader(entry));
    blocks.push(entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }

  blocks.push(Buffer.alloc(1024));

  return gzipSync(Buffer.concat(blocks));
}

function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512, 0);

  header.write(entry.name, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, entry.mode ?? 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, entry.data.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("easy-host", 265, 32, "ascii");
  header.write("easy-host", 297, 32, "ascii");

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

  return header;
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  header.writeUInt8(0, offset + length - 1);
}

function fakeRelease(
  archive: Buffer,
  overrides: Partial<PinnedRailpackRelease> = {},
): PinnedRailpackRelease {
  return {
    version: RAILPACK_VERSION,
    architecture: "x86_64",
    asset: `railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    url: `https://example.invalid/railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: sha256(archive),
    binary: RAILPACK_BINARY_FILENAME,
    ...overrides,
  };
}

interface FakeFetch {
  readonly calls: string[];
  readonly fetch: RailpackFetch;
}

function fakeFetch(body: Buffer, status = 200): FakeFetch {
  const calls: string[] = [];

  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Service Unavailable",
        arrayBuffer: async () => Uint8Array.from(body).buffer as ArrayBuffer,
      };
    },
  };
}

function fakePaths(toolsDir: string): { paths: RailpackPaths; layoutCalls: () => number } {
  let calls = 0;

  return {
    paths: {
      toolsDir,
      ensureLayout() {
        calls += 1;
        return undefined;
      },
    },
    layoutCalls: () => calls,
  };
}

async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the promise to reject");
}

function writeReceipt(
  toolsDir: string,
  architecture: RailpackArchitecture = "x86_64",
  overrides: Partial<Record<string, string>> = {},
): void {
  const release = RAILPACK_RELEASES[architecture];

  writeFileSync(
    path.join(toolsDir, RAILPACK_RECEIPT_FILENAME),
    `${JSON.stringify(
      {
        version: release.version,
        architecture,
        asset: release.asset,
        archiveSha256: release.sha256,
        binary: release.binary,
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

function writeExecutable(target: string): void {
  writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(target, 0o755);
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("pinned versions", () => {
  it("pins one Railpack release with a URL and SHA-256 per supported architecture", () => {
    expect(RAILPACK_VERSION).toBe("0.43.0");
    expect(Object.keys(RAILPACK_RELEASES).sort()).toEqual(["aarch64", "x86_64"]);

    for (const architecture of ["x86_64", "aarch64"] as const) {
      const release = RAILPACK_RELEASES[architecture];

      expect(release.version).toBe("0.43.0");
      expect(release.architecture).toBe(architecture);
      expect(release.url).toBe(
        `https://github.com/railwayapp/railpack/releases/download/v0.43.0/${release.asset}`,
      );
      expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(release.sha256).toBe(RAILPACK_SHA256[architecture]);
      expect(release.binary).toBe("railpack");
    }

    expect(RAILPACK_SHA256.x86_64).toBe(
      "248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb",
    );
    expect(RAILPACK_SHA256.aarch64).toBe(
      "732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9",
    );
  });

  it("pins the BuildKit rootless image by digest with the published tag", () => {
    expect(BUILDKIT_IMAGE).toBe("docker.io/moby/buildkit:v0.34.1-rootless");
    expect(BUILDKIT_DIGEST).toBe(
      "sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89",
    );
    expect(BUILDKIT_IMAGE_REFERENCE).toBe(`${BUILDKIT_IMAGE}@${BUILDKIT_DIGEST}`);
  });
});

describe("railpackArchitecture", () => {
  it("maps Node and uname architecture names onto the pinned targets", () => {
    expect(railpackArchitecture("x64")).toBe("x86_64");
    expect(railpackArchitecture("x86_64")).toBe("x86_64");
    expect(railpackArchitecture("arm64")).toBe("aarch64");
    expect(railpackArchitecture("aarch64")).toBe("aarch64");
    expect(railpackArchitecture("riscv64")).toBeUndefined();
  });
});

describe("resolveRailpack", () => {
  it("uses an executable EASY_HOST_RAILPACK_BIN without downloading or touching the state root", async () => {
    const toolsDir = makeTemporaryDirectory();
    const override = path.join(makeTemporaryDirectory(), "custom-railpack");
    writeExecutable(override);
    const fetch = fakeFetch(buildArchive([{ name: "railpack", data: FAKE_RAILPACK }]));
    const { paths, layoutCalls } = fakePaths(toolsDir);

    const binary = await resolveRailpack({
      paths,
      env: { [EASY_HOST_RAILPACK_BIN]: override },
      fetch: fetch.fetch,
    });

    expect(binary).toEqual({
      path: override,
      version: undefined,
      source: "override",
      sha256: undefined,
    });
    expect(fetch.calls).toEqual([]);
    expect(layoutCalls()).toBe(0);
    expect(existsSync(path.join(toolsDir, RAILPACK_BINARY_FILENAME))).toBe(false);
  });

  it("expands a leading ~/ in the override path", async () => {
    const home = makeTemporaryDirectory();
    const binDir = path.join(home, "bin");
    mkdirSync(binDir, { mode: 0o700 });
    writeExecutable(path.join(binDir, "railpack"));
    const { paths } = fakePaths(makeTemporaryDirectory());

    const binary = await resolveRailpack({
      paths,
      env: { [EASY_HOST_RAILPACK_BIN]: "~/bin/railpack" },
      homeDir: home,
      cwd: home,
    });

    expect(binary.path).toBe(path.join(binDir, "railpack"));
    expect(binary.source).toBe("override");
  });

  it.skipIf(runningAsRoot)("rejects an override that is not executable", async () => {
    const override = path.join(makeTemporaryDirectory(), "railpack");
    writeFileSync(override, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    chmodSync(override, 0o644);
    const { paths } = fakePaths(makeTemporaryDirectory());

    const error = await expectRejection(
      resolveRailpack({ paths, env: { [EASY_HOST_RAILPACK_BIN]: override } }),
    );

    expect(error).toMatchObject({ code: "RAILPACK_OVERRIDE_INVALID" });
    expect(toExitCode(error)).toBe(1);
  });

  it("rejects a missing override", async () => {
    const missing = path.join(makeTemporaryDirectory(), "missing-railpack");
    const { paths } = fakePaths(makeTemporaryDirectory());

    const error = await expectRejection(
      resolveRailpack({ paths, env: { [EASY_HOST_RAILPACK_BIN]: missing } }),
    );

    expect(error).toMatchObject({ code: "RAILPACK_OVERRIDE_INVALID" });
    expect(toExitCode(error)).toBe(1);
  });

  it("rejects an unsupported architecture before any download or layout work", async () => {
    const fetch = fakeFetch(buildArchive([{ name: "railpack", data: FAKE_RAILPACK }]));
    const { paths, layoutCalls } = fakePaths(makeTemporaryDirectory());

    const error = await expectRejection(
      resolveRailpack({ paths, env: {}, arch: "riscv64", platform: "linux", fetch: fetch.fetch }),
    );

    expect(error).toMatchObject({ code: "RAILPACK_UNSUPPORTED_ARCHITECTURE" });
    expect(toExitCode(error)).toBe(2);
    expect(fetch.calls).toEqual([]);
    expect(layoutCalls()).toBe(0);
  });

  it("rejects a non-Linux host even when the architecture is pinned", async () => {
    const { paths } = fakePaths(makeTemporaryDirectory());

    const error = await expectRejection(
      resolveRailpack({ paths, env: {}, arch: "x64", platform: "darwin" }),
    );

    expect(error).toMatchObject({ code: "RAILPACK_UNSUPPORTED_ARCHITECTURE" });
    expect(toExitCode(error)).toBe(2);
  });

  it("reuses a verified cached binary without a second download", async () => {
    const toolsDir = makeTemporaryDirectory();
    writeFileSync(path.join(toolsDir, RAILPACK_BINARY_FILENAME), FAKE_RAILPACK, { mode: 0o755 });
    chmodSync(path.join(toolsDir, RAILPACK_BINARY_FILENAME), 0o755);
    writeReceipt(toolsDir);
    const fetch = fakeFetch(buildArchive([{ name: "railpack", data: FAKE_RAILPACK }]));
    const { paths, layoutCalls } = fakePaths(toolsDir);

    const binary = await resolveRailpack({
      paths,
      env: {},
      arch: "x64",
      platform: "linux",
      fetch: fetch.fetch,
    });

    expect(binary).toEqual({
      path: path.join(toolsDir, RAILPACK_BINARY_FILENAME),
      version: RAILPACK_VERSION,
      source: "cache",
      sha256: RAILPACK_SHA256.x86_64,
    });
    expect(fetch.calls).toEqual([]);
    expect(layoutCalls()).toBe(1);
  });

  it("ignores a receipt from a different pinned version and requests the pinned URL", async () => {
    const toolsDir = makeTemporaryDirectory();
    writeFileSync(path.join(toolsDir, RAILPACK_BINARY_FILENAME), FAKE_RAILPACK, { mode: 0o755 });
    chmodSync(path.join(toolsDir, RAILPACK_BINARY_FILENAME), 0o755);
    writeReceipt(toolsDir, "x86_64", { version: "0.42.0" });
    const archive = buildArchive([{ name: "railpack", data: FAKE_RAILPACK }]);
    const fetch = fakeFetch(archive);
    const { paths } = fakePaths(toolsDir);

    const error = await expectRejection(
      resolveRailpack({ paths, env: {}, arch: "x64", platform: "linux", fetch: fetch.fetch }),
    );

    expect(fetch.calls).toEqual([RAILPACK_RELEASES.x86_64.url]);
    expect(error).toMatchObject({
      code: "RAILPACK_DIGEST_MISMATCH",
      details: { expected: RAILPACK_SHA256.x86_64 },
    });
    expect(toExitCode(error)).toBe(3);
  });
});

describe("installRailpack", () => {
  it("downloads once, verifies, extracts, and marks the binary executable", async () => {
    const toolsDir = makeTemporaryDirectory();
    const archive = buildArchive([
      { name: "LICENSE", data: FAKE_LICENSE },
      { name: "railpack", data: FAKE_RAILPACK, mode: 0o755 },
    ]);
    const release = fakeRelease(archive);
    const fetch = fakeFetch(archive);

    const binary = await installRailpack({
      toolsDir,
      release,
      architecture: "x86_64",
      fetch: fetch.fetch,
    });

    expect(fetch.calls).toEqual([release.url]);
    expect(binary.source).toBe("download");
    expect(binary.version).toBe(release.version);
    expect(binary.sha256).toBe(release.sha256);

    const target = path.join(toolsDir, RAILPACK_BINARY_FILENAME);
    expect(readFileSync(target)).toEqual(FAKE_RAILPACK);
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(readdirSync(toolsDir).sort()).toEqual([
      RAILPACK_BINARY_FILENAME,
      RAILPACK_RECEIPT_FILENAME,
    ]);

    const receipt = JSON.parse(
      readFileSync(path.join(toolsDir, RAILPACK_RECEIPT_FILENAME), "utf8"),
    );
    expect(receipt).toEqual({
      version: release.version,
      architecture: "x86_64",
      asset: release.asset,
      archiveSha256: release.sha256,
      binary: release.binary,
    });
  });

  it("reuses a verified cache entry without a second download", async () => {
    const toolsDir = makeTemporaryDirectory();
    const archive = buildArchive([{ name: "railpack", data: FAKE_RAILPACK }]);
    const release = fakeRelease(archive);
    const fetch = fakeFetch(archive);

    await installRailpack({ toolsDir, release, architecture: "x86_64", fetch: fetch.fetch });
    const second = await installRailpack({
      toolsDir,
      release,
      architecture: "x86_64",
      fetch: fetch.fetch,
    });

    expect(fetch.calls).toHaveLength(1);
    expect(second.source).toBe("cache");
    expect(second.path).toBe(path.join(toolsDir, RAILPACK_BINARY_FILENAME));
  });

  it("re-downloads when the receipt records a different release", async () => {
    const toolsDir = makeTemporaryDirectory();
    const archive = buildArchive([{ name: "railpack", data: FAKE_RAILPACK }]);
    const first = fakeRelease(archive);
    const secondRelease = fakeRelease(archive, { version: "0.44.0" });
    const fetch = fakeFetch(archive);

    await installRailpack({ toolsDir, release: first, architecture: "x86_64", fetch: fetch.fetch });
    const second = await installRailpack({
      toolsDir,
      release: secondRelease,
      architecture: "x86_64",
      fetch: fetch.fetch,
    });

    expect(fetch.calls).toHaveLength(2);
    expect(second.source).toBe("download");
    expect(second.version).toBe("0.44.0");
    expect(
      JSON.parse(readFileSync(path.join(toolsDir, RAILPACK_RECEIPT_FILENAME), "utf8")).version,
    ).toBe("0.44.0");
  });

  it("aborts on a digest mismatch without extracting or executing the archive", async () => {
    const toolsDir = makeTemporaryDirectory();
    const marker = path.join(toolsDir, "executed");
    const script = Buffer.from(`#!/bin/sh\ntouch "${marker}"\n`);
    const archive = buildArchive([{ name: "railpack", data: script, mode: 0o755 }]);
    const release = fakeRelease(archive, { sha256: "0".repeat(64) });
    const fetch = fakeFetch(archive);

    const error = await expectRejection(
      installRailpack({ toolsDir, release, architecture: "x86_64", fetch: fetch.fetch }),
    );

    expect(error).toMatchObject({
      code: "RAILPACK_DIGEST_MISMATCH",
      details: { expected: "0".repeat(64), actual: sha256(archive) },
    });
    expect(toExitCode(error)).toBe(3);
    expect(existsSync(path.join(toolsDir, RAILPACK_BINARY_FILENAME))).toBe(false);
    expect(existsSync(path.join(toolsDir, RAILPACK_RECEIPT_FILENAME))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(toolsDir)).toEqual([]);
  });

  it("rejects a verified archive that does not contain the railpack binary", async () => {
    const toolsDir = makeTemporaryDirectory();
    const archive = buildArchive([{ name: "LICENSE", data: FAKE_LICENSE }]);
    const release = fakeRelease(archive);
    const fetch = fakeFetch(archive);

    const error = await expectRejection(
      installRailpack({ toolsDir, release, architecture: "x86_64", fetch: fetch.fetch }),
    );

    expect(error).toMatchObject({ code: "RAILPACK_ARCHIVE_INVALID" });
    expect(toExitCode(error)).toBe(3);
    expect(existsSync(path.join(toolsDir, RAILPACK_BINARY_FILENAME))).toBe(false);
  });

  it("accepts a ./ prefixed member name inside the archive", async () => {
    const toolsDir = makeTemporaryDirectory();
    const archive = buildArchive([{ name: "./railpack", data: FAKE_RAILPACK, mode: 0o755 }]);
    const release = fakeRelease(archive);
    const fetch = fakeFetch(archive);

    const binary = await installRailpack({
      toolsDir,
      release,
      architecture: "x86_64",
      fetch: fetch.fetch,
    });

    expect(binary.source).toBe("download");
    expect(readFileSync(binary.path)).toEqual(FAKE_RAILPACK);
  });

  it("reports an HTTP failure without writing a binary", async () => {
    const toolsDir = makeTemporaryDirectory();
    const archive = buildArchive([{ name: "railpack", data: FAKE_RAILPACK }]);
    const release = fakeRelease(archive);
    const fetch = fakeFetch(archive, 503);

    const error = await expectRejection(
      installRailpack({ toolsDir, release, architecture: "x86_64", fetch: fetch.fetch }),
    );

    expect(error).toMatchObject({ code: "RAILPACK_DOWNLOAD_FAILED" });
    expect(toExitCode(error)).toBe(3);
    expect(existsSync(path.join(toolsDir, RAILPACK_BINARY_FILENAME))).toBe(false);
  });

  it("treats an expired cache binary as a cache miss", async () => {
    const toolsDir = makeTemporaryDirectory();
    const target = path.join(toolsDir, RAILPACK_BINARY_FILENAME);
    const archive = buildArchive([{ name: "railpack", data: FAKE_RAILPACK }]);
    const release = fakeRelease(archive);
    writeFileSync(target, FAKE_RAILPACK, { mode: 0o644 });
    chmodSync(target, 0o644);
    writeReceipt(toolsDir);
    const fetch = fakeFetch(archive);

    const binary = await installRailpack({
      toolsDir,
      release,
      architecture: "x86_64",
      fetch: fetch.fetch,
    });

    expect(fetch.calls).toHaveLength(1);
    expect(binary.source).toBe("download");
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });
});
