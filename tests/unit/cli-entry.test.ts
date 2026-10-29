import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { main, readPackageVersion } from "../../src/cli/index.js";

interface PackageManifest {
  version: string;
}

const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as PackageManifest;

describe("CLI entry", () => {
  it("reads the version declared by the package manifest", () => {
    expect(readPackageVersion()).toBe(packageManifest.version);
  });

  it("prints the package version to stdout and exits 0", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      expect(main()).toBe(0);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith(`${packageManifest.version}\n`);
    } finally {
      write.mockRestore();
    }
  });

  it("starts with a Node shebang", () => {
    const source = readFileSync(new URL("../../src/cli/index.ts", import.meta.url), "utf8");

    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});
