/**
 * Migration note checks (`DOC-FR-07`).
 *
 * The note is the only place the old project name may appear, so this suite
 * keeps it honest: it must name both names, link to the README and the PRD,
 * state that the repository rename is manual, and never claim that rename has
 * already happened.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PODMAN_VERSION_RANGE } from "../../src/doctor/checks.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION_PATH = join(REPO_ROOT, "docs/MIGRATION.md");
const README_PATH = join(REPO_ROOT, "README.md");
const PRD_PATH = join(REPO_ROOT, "docs/PRD.md");
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");
const README = readFileSync(README_PATH, "utf8");

interface MarkdownLink {
  readonly text: string;
  readonly target: string;
}

function parseLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const pattern = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const match of markdown.matchAll(pattern)) {
    const text = match[1];
    const target = match[2];
    if (text !== undefined && target !== undefined) {
      links.push({ text, target });
    }
  }

  return links;
}

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

/** Absolute file paths named by relative links, ignoring anchors. */
function localLinkTargets(markdown: string): string[] {
  const targets: string[] = [];

  for (const link of parseLinks(markdown)) {
    if (isExternal(link.target)) {
      continue;
    }

    const [path = ""] = link.target.split("#", 1);
    if (path !== "") {
      targets.push(resolve(dirname(MIGRATION_PATH), path));
    }
  }

  return targets;
}

/**
 * Claims that the repository rename already happened. The note may say the
 * project is now easy-host; only a claim about the repository is a defect.
 */
const REPOSITORY_RENAME_CLAIMS = [
  /repository (?:has (?:already )?been|was) renamed/i,
  /repository is (?:now )?renamed/i,
  /renamed the repository/i,
  /repository is now (?:named )?`?easy-host/i,
] as const;

function repositoryRenameClaims(markdown: string): string[] {
  return REPOSITORY_RENAME_CLAIMS.filter((pattern) => pattern.test(markdown)).map(String);
}

describe("migration note", () => {
  it("exists and names the old and new project names", () => {
    expect(existsSync(MIGRATION_PATH), "docs/MIGRATION.md is missing").toBe(true);
    expect(MIGRATION).toContain("react-hoster");
    expect(MIGRATION).toContain("easy-host");
  });

  it("links to the README and the PRD", () => {
    const targets = localLinkTargets(MIGRATION);

    expect(targets, "the migration note does not link to README.md").toContain(README_PATH);
    expect(targets, "the migration note does not link to docs/PRD.md").toContain(PRD_PATH);
    expect(existsSync(README_PATH)).toBe(true);
    expect(existsSync(PRD_PATH)).toBe(true);
  });

  it("is linked from the README documentation index", () => {
    expect(README).toContain("](docs/MIGRATION.md)");
  });

  it("states that the repository rename is a manual step", () => {
    const flat = MIGRATION.replace(/\s+/g, " ");

    expect(flat).toContain("repository is still named `react-hoster`");
    expect(flat.toLowerCase()).toContain("manual step");
    expect(flat.toLowerCase()).toContain("outside this work");
  });

  it("does not claim the repository has already been renamed", () => {
    expect(repositoryRenameClaims(MIGRATION)).toEqual([]);
  });

  it("detects a synthetic repository-rename claim", () => {
    expect(repositoryRenameClaims("The repository has been renamed to easy-host.")).not.toEqual([]);
    expect(repositoryRenameClaims("The repository is now easy-host.")).not.toEqual([]);
  });

  it("lists the concrete changes for an existing user", () => {
    for (const fact of [
      "npm install -g .",
      "easy-host doctor",
      "<state-root>/apps/<app>/config.toml",
      "$EASY_HOST_HOME",
      "$XDG_DATA_HOME/easy-host",
      "~/.local/share/easy-host",
      PODMAN_VERSION_RANGE,
      "6.x",
    ]) {
      expect(MIGRATION, `migration note is missing ${fact}`).toContain(fact);
    }

    expect(MIGRATION).toContain("A podman container you can load your react app in and self host");
  });

  it("stays plain Markdown and short", () => {
    expect(MIGRATION).not.toMatch(/!\[[^\]]*\]\([^)]*\)/);
    expect(MIGRATION).not.toMatch(/<img\b/i);
    expect(MIGRATION).not.toMatch(/<script\b/i);
    expect(MIGRATION).not.toContain("\u001B[");
    expect(MIGRATION.split(/\s+/).length).toBeLessThan(800);
  });
});
