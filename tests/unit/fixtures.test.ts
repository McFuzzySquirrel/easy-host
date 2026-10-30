import {
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
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * These fixtures are the only stacks v1 claims to support (`PRD-C-10`). The
 * assertions below fail loudly when an entry file Railpack needs for provider
 * detection disappears, when a server fixture hard-codes a port, or when a
 * dependency starts floating again.
 *
 * Provider detection was confirmed against the pinned Railpack 0.43.0:
 * - vite-spa   -> node provider, `nodeRuntime: vite`, output directory `dist`
 * - express-api -> node provider, start command `npm run start`
 * - fastapi-app -> python provider, `pythonRuntime: fastapi`
 */

const FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
);

interface Fixture {
  readonly name: string;
  readonly requiredFiles: readonly string[];
}

const FIXTURES: readonly Fixture[] = [
  {
    name: "vite-spa",
    requiredFiles: ["package.json", "index.html", "vite.config.ts", "src/main.tsx"],
  },
  {
    name: "express-api",
    requiredFiles: ["package.json", "server.js"],
  },
  {
    name: "fastapi-app",
    requiredFiles: ["requirements.txt", "main.py"],
  },
];

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const createdDirectories: string[] = [];

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureDirectory(fixture: Fixture, root = FIXTURES_ROOT): string {
  return path.join(root, fixture.name);
}

function readFixture(fixture: Fixture, file: string): string {
  return readFileSync(path.join(fixtureDirectory(fixture), file), "utf8");
}

function readManifest(fixture: Fixture): PackageManifest {
  return JSON.parse(readFixture(fixture, "package.json")) as PackageManifest;
}

function requireFixture(name: string): Fixture {
  const fixture = FIXTURES.find((candidate) => candidate.name === name);
  if (fixture === undefined) {
    throw new Error(`unknown fixture: ${name}`);
  }
  return fixture;
}

function walkFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function assertRequiredFiles(root: string, fixture: Fixture): void {
  for (const file of fixture.requiredFiles) {
    const filePath = path.join(fixtureDirectory(fixture, root), file);
    expect(existsSync(filePath), `missing required file ${fixture.name}/${file}`).toBe(true);
    expect(statSync(filePath).isFile(), `${fixture.name}/${file} must be a regular file`).toBe(
      true,
    );
    expect(statSync(filePath).size, `${fixture.name}/${file} must not be empty`).toBeGreaterThan(0);
  }
}

function requireExactPin(
  manifest: PackageManifest,
  section: "dependencies" | "devDependencies",
  name: string,
): string {
  const pin = manifest[section]?.[name];
  expect(pin, `${name} must be declared in ${section}`).toBeDefined();
  expect(pin, `${name} must be pinned to an exact x.y.z version`).toMatch(/^\d+\.\d+\.\d+$/);
  return pin ?? "";
}

describe("supported stack fixtures", () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      it("contains every entry file Railpack needs to detect its provider", () => {
        assertRequiredFiles(FIXTURES_ROOT, fixture);
      });

      it("contains no Dockerfile", () => {
        const dockerfiles = walkFiles(fixtureDirectory(fixture)).filter(
          (file) => path.basename(file).toLowerCase() === "dockerfile",
        );

        expect(dockerfiles).toEqual([]);
      });
    });
  }

  it("fails the required-file check when an entry file is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-host-fixture-check-"));
    createdDirectories.push(root);

    const fixture = requireFixture("vite-spa");
    for (const file of fixture.requiredFiles) {
      if (file === "index.html") {
        continue;
      }

      const target = path.join(fixtureDirectory(fixture, root), file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "placeholder\n");
    }

    expect(() => assertRequiredFiles(root, fixture)).toThrow(/index\.html/);
  });

  describe("vite-spa", () => {
    const fixture = requireFixture("vite-spa");

    it("builds static assets with Vite and React", () => {
      const manifest = readManifest(fixture);

      expect(manifest.scripts?.build).toBe("vite build");
      expect(requireExactPin(manifest, "dependencies", "react")).toBe("19.3.1");
      expect(requireExactPin(manifest, "dependencies", "react-dom")).toBe("19.3.1");
      expect(requireExactPin(manifest, "devDependencies", "vite")).toBe("8.3.5");
      expect(requireExactPin(manifest, "devDependencies", "@vitejs/plugin-react")).toBe("6.1.2");
    });

    it("mounts the React app from the Vite HTML entry point", () => {
      const html = readFixture(fixture, "index.html");
      const main = readFixture(fixture, "src/main.tsx");
      const config = readFixture(fixture, "vite.config.ts");

      expect(html).toContain('id="root"');
      expect(html).toContain('src="/src/main.tsx"');
      expect(main).toContain("react-dom/client");
      expect(main).toContain("createRoot");
      expect(config).toContain("@vitejs/plugin-react");
      expect(config).toContain("react()");
    });
  });

  describe("express-api", () => {
    const fixture = requireFixture("express-api");

    it("declares an Express start script with an exact dependency pin", () => {
      const manifest = readManifest(fixture);

      expect(manifest.scripts?.start).toBe("node server.js");
      expect(requireExactPin(manifest, "dependencies", "express")).toBe("5.3.0");
    });

    it("reads PORT from the environment instead of hard-coding a port", () => {
      const server = readFixture(fixture, "server.js");

      expect(server).toMatch(/process\.env\.PORT/);
      expect(server).not.toMatch(/\.listen\(\s*\d/);
    });

    it("serves a JSON health response at /", () => {
      const server = readFixture(fixture, "server.js");

      expect(server).toContain('app.get("/"');
      expect(server).toContain('status: "ok"');
      expect(server).toContain("response.json(");
    });
  });

  describe("fastapi-app", () => {
    const fixture = requireFixture("fastapi-app");

    it("pins FastAPI and uvicorn exactly", () => {
      const requirements = readFixture(fixture, "requirements.txt")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      expect(requirements).toContain("fastapi==0.162.0");
      expect(requirements).toContain("uvicorn==0.54.0");
    });

    it("reads PORT from the environment instead of hard-coding a port", () => {
      const main = readFixture(fixture, "main.py");

      expect(main).toMatch(
        /(?:os\.environ\[\s*["']PORT["']\s*\]|os\.getenv\(\s*["']PORT["']\s*\))/,
      );
      expect(main).not.toMatch(/uvicorn\.run\([^)]*port\s*=\s*\d/);
    });

    it("serves a JSON health response at /", () => {
      const main = readFixture(fixture, "main.py");

      expect(main).toContain("FastAPI()");
      expect(main).toContain('@app.get("/")');
      expect(main).toContain('"status": "ok"');
    });
  });
});
