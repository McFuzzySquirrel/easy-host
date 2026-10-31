/**
 * Documentation drift checks (`DOC-FR-01`, `DOC-FR-02`, `DOC-FR-03`,
 * `DOC-NF-02`, `PRD-ACC-06`).
 *
 * The README and the two operations guides are the operator's front door, so
 * this suite treats them as a contract rather than prose:
 *
 * - every relative link resolves (and a Markdown anchor names a real heading);
 * - the README's required sections and four success scenarios exist as real
 *   ATX headings, not bold text or images;
 * - the prerequisite guide keeps a verification command and a doctor check for
 *   every prerequisite, the code's Podman window, and the explicit 4.9 upgrade;
 * - the timer guide keeps complete user units, the journal log location, the
 *   app-lock overlap rule, and every public exit code;
 * - every `easy-host <command>` example names a command registered by
 *   `src/cli/program.ts`;
 * - the old React-only branding is gone outside an explicit migration section.
 *
 * Later documentation tasks add their pages to `DOCUMENTED_MARKDOWN` (or a
 * sibling test) and this suite keeps checking that every link they publish
 * resolves.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../src/cli/errors.js";
import { COMMAND_NAMES } from "../../src/cli/program.js";
import { MAX_PORT, MIN_HOST_PORT } from "../../src/config/schema.js";
import {
  GIT_MIN_VERSION,
  NODE_MIN_MAJOR,
  PODMAN_EXCLUSIVE_MAX_MAJOR,
  PODMAN_VERSION_RANGE,
} from "../../src/doctor/checks.js";
import { PODMAN_RESTART_SERVICE } from "../../src/platform/boot-recovery.js";
import { APP_LOCK_FILE_NAME, LOCK_FILE_MODE } from "../../src/platform/lock.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every markdown file this suite owns. DOC-1.5 and DOC-1.6 extend this. */
const DOCUMENTED_MARKDOWN = [
  "README.md",
  "CHANGELOG.md",
  "docs/user-guide.md",
  "docs/admin-guide.md",
  "docs/operations/prerequisites.md",
  "docs/operations/systemd-timer.md",
  "docs/operations/tailscale.md",
  "docs/reference/cli.md",
  "docs/reference/config.md",
  "docs/adr/README.md",
  "docs/adr/0001-rootless-podman-runtime.md",
  "docs/adr/0002-filesystem-registry-derived-state.md",
  "docs/adr/0003-pinned-railpack-buildkit-build-layer.md",
  "docs/adr/0004-fixed-port-health-gated-swap.md",
  "docs/adr/0005-two-image-retention.md",
  "docs/adr/0006-label-scoped-volume-deletion.md",
  "docs/adr/0007-ten-command-surface.md",
  "docs/adr/0008-exit-codes-and-json-contract.md",
  "docs/releases/v0.1.0.md",
  "docs/MIGRATION.md",
] as const;

const README_PATH = join(REPO_ROOT, "README.md");
const README = readFileSync(README_PATH, "utf8");
const PREREQUISITES_PATH = join(REPO_ROOT, "docs/operations/prerequisites.md");
const PREREQUISITES = readFileSync(PREREQUISITES_PATH, "utf8");
const TIMER_PATH = join(REPO_ROOT, "docs/operations/systemd-timer.md");
const TIMER = readFileSync(TIMER_PATH, "utf8");
const TAILSCALE_PATH = join(REPO_ROOT, "docs/operations/tailscale.md");
const TAILSCALE = readFileSync(TAILSCALE_PATH, "utf8");

/**
 * Headings the README must carry. Exact text keeps the check honest: renaming a
 * section is a deliberate documentation change, not an accident.
 */
const REQUIRED_HEADINGS = [
  "# easy-host",
  "## Supported stacks",
  "## Prerequisites",
  "## Install",
  "## Quickstart",
  "## Success scenarios",
  "## Volume safety",
  "## Documentation",
] as const;

const SCENARIO_HEADINGS = [
  "### 1. The app is reachable from another machine",
  "### 2. The app returns after a reboot",
  "### 3. A broken update keeps the previous version serving",
  "### 4. Rollback restores the previous image",
] as const;

/** Headings the prerequisite guide must keep (`DOC-FR-02`). */
const PREREQUISITE_HEADINGS = [
  "# Host prerequisites",
  "## Summary",
  "## Rootless Podman",
  "### Upgrade from Podman 4.9 on Ubuntu 24.04",
  "### Upgrade from Podman 4.9 on Debian 12",
  "### If you are already on Podman 6.x",
  "## User lingering",
  "## git 2.40 or newer",
  "## Node.js 24 or newer",
  "## A host port at or above 1024",
  "## Other doctor checks",
] as const;

/** Headings the timer guide must keep (`DOC-FR-03`). */
const TIMER_HEADINGS = [
  "# Scheduled updates with a systemd user timer",
  "## Before you start",
  "## Unit files",
  "## Enable and verify",
  "## Where the output goes",
  "## Overlapping runs and the app lock",
  "## What each exit code means for the timer",
  "## Disable or remove the schedule",
  "## What this timer is not",
] as const;

/** Headings the Tailscale guide must keep. */
const TAILSCALE_HEADINGS = [
  "# Reaching an app from outside the LAN with Tailscale",
  "## Two supported layouts",
  "## Before you start",
  "## Publish one app with TLS (recommended)",
  "## Several apps on one host",
  "## The `0.0.0.0` shortcut",
  "## Exposing to the public internet",
  "## Access control",
  "## Reboot and persistence",
  "## Troubleshooting",
  "## What this guide is not",
  "## Tailscale documentation",
] as const;

/** The ten checks `runDoctor` reports, in report order. */
const DOCTOR_CHECK_IDS = [
  "podman",
  "podman-rootless",
  "docker-loader",
  "linger",
  "boot-restart",
  "git",
  "node",
  "railpack",
  "buildkit",
  "disk",
] as const;

/** One verification command per documented prerequisite. */
const PREREQUISITE_VERIFICATIONS = [
  "podman --version",
  "podman info --format '{{.Host.Security.Rootless}}'",
  'loginctl show-user "$USER" -p Linger',
  'sudo loginctl enable-linger "$USER"',
  "git --version",
  "node --version",
  'ss -ltnH "sport = :$PORT"',
  "docker --version",
  "easy-host doctor",
] as const;

/** Commands that must never appear, even in an example (`PRD-C-01`, `PRD-C-04`). */
const FORBIDDEN_COMMAND_NAMES = [
  "start",
  "stop",
  "restart",
  "prune",
  "completion",
  "daemon",
] as const;

interface MarkdownLink {
  readonly text: string;
  readonly target: string;
  readonly line: number;
}

function parseLinks(markdown: string, lineOffset = 0): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const lines = markdown.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const pattern = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const match of line.matchAll(pattern)) {
      const text = match[1];
      const target = match[2];
      if (text !== undefined && target !== undefined) {
        links.push({ text, target, line: lineOffset + index + 1 });
      }
    }
  }

  return links;
}

/** Extracts the body under an exact heading, stopping at the next peer heading. */
function sectionBody(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);

  if (headingIndex === -1) {
    return "";
  }

  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const body: string[] = [];

  for (const line of lines.slice(headingIndex + 1)) {
    const nextHeading = /^(#+)\s+/.exec(line);
    if (nextHeading !== null && (nextHeading[1]?.length ?? 1) <= level) {
      break;
    }
    body.push(line);
  }

  return body.join("\n");
}

/** 1-based line of a heading, used to keep link diagnostics in file coordinates. */
function sectionStartLine(markdown: string, heading: string): number {
  const index = markdown.split(/\r?\n/).findIndex((line) => line.trim() === heading);
  return index === -1 ? 0 : index + 1;
}

/**
 * GitHub-style heading anchors. This intentionally ignores code formatting and
 * punctuation; anchored links to the PRD sections are checked against the
 * target document's real headings.
 */
function slugifyHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const heading = match?.[2];
    if (heading !== undefined) {
      slugs.add(slugifyHeading(heading));
    }
  }

  return slugs;
}

/** ATX headings outside fenced code blocks, in document order. */
function markdownHeadings(markdown: string): string[] {
  const headings: string[] = [];
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && /^#{1,6}\s+/.test(line)) {
      headings.push(line.trim());
    }
  }

  return headings;
}

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

function assertLinkResolves(sourcePath: string, link: MarkdownLink): void {
  if (isExternal(link.target)) {
    return;
  }

  const [rawPath = "", anchor] = link.target.split("#", 2);
  const path = rawPath === "" ? basename(sourcePath) : rawPath;
  const targetPath = path.startsWith("/")
    ? join(REPO_ROOT, path.slice(1))
    : resolve(dirname(sourcePath), path);
  const source = relative(REPO_ROOT, sourcePath);

  expect(
    existsSync(targetPath),
    `${source}:${link.line} link "${link.text}" -> ${link.target} does not exist`,
  ).toBe(true);
  expect(
    statSync(targetPath).isFile(),
    `${source}:${link.line} link "${link.text}" -> ${link.target} is not a file`,
  ).toBe(true);

  if (anchor === undefined || anchor === "" || !targetPath.endsWith(".md")) {
    return;
  }

  const targetMarkdown = readFileSync(targetPath, "utf8");
  const expectedSlug = decodeURIComponent(anchor).toLowerCase();

  expect(
    headingSlugs(targetMarkdown).has(expectedSlug),
    `${source}:${link.line} anchor "${anchor}" is missing from ${path}`,
  ).toBe(true);
}

/** Fenced blocks plus inline code spans: the only places a command example lives. */
function codeSnippets(markdown: string): string[] {
  const snippets: string[] = [];

  for (const match of markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    if (match[1] !== undefined) {
      snippets.push(match[1]);
    }
  }

  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    if (match[1] !== undefined) {
      snippets.push(match[1]);
    }
  }

  return snippets;
}

/**
 * Command names used in examples. The match starts at the beginning of a line
 * so a directory name such as `cd easy-host` is not mistaken for a command.
 */
function commandInvocations(markdown: string): string[] {
  const names: string[] = [];

  for (const snippet of codeSnippets(markdown)) {
    for (const match of snippet.matchAll(/^\s*(?:\$\s+)?easy-host\s+([a-z][a-z0-9-]*)/gm)) {
      if (match[1] !== undefined) {
        names.push(match[1]);
      }
    }
  }

  return names;
}

/**
 * Removes an explicit migration or rename section, plus any line that links to
 * the migration note, before the React-only branding scan. Everywhere else the
 * old name is a documentation defect.
 */
function stripMigrationNote(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let skipLevel = 0;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);

    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const text = (heading[2] ?? "").toLowerCase();

      if (skipLevel > 0 && level <= skipLevel) {
        skipLevel = 0;
      }

      if (skipLevel === 0 && /\bmigration\b|\brename\b/.test(text)) {
        skipLevel = level;
        continue;
      }
    }

    if (skipLevel > 0 || /MIGRATION\.md/.test(line)) {
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n");
}

describe("README structure", () => {
  it("contains every required section as a real heading", () => {
    const headings = README.split(/\r?\n/).map((line) => line.trim());

    for (const heading of REQUIRED_HEADINGS) {
      expect(headings, `missing heading: ${heading}`).toContain(heading);
    }
  });

  it("lists the three supported stacks and no others as supported", () => {
    const stacks = sectionBody(README, "## Supported stacks");

    for (const stack of ["Vite/React", "Node/Express", "Python/FastAPI"]) {
      expect(stacks, `supported-stack section is missing ${stack}`).toContain(stack);
    }

    expect(stacks.toLowerCase()).toContain("only for the stacks");
  });

  it("summarizes every host prerequisite with its supported range", () => {
    const prerequisites = sectionBody(README, "## Prerequisites");

    for (const requirement of ["5.7.0", "6.0.0", "Linger", "2.40", "24", "1024"]) {
      expect(prerequisites, `prerequisite section is missing ${requirement}`).toContain(
        requirement,
      );
    }

    expect(prerequisites.toLowerCase()).toContain("mandatory");
    expect(prerequisites.toLowerCase()).toContain("privileged ports are unsupported");
  });

  it("documents exactly four success scenarios under the scenario section", () => {
    const scenarios = sectionBody(README, "## Success scenarios");
    const headings = scenarios
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("### "));

    expect(headings).toEqual([...SCENARIO_HEADINGS]);
  });

  it("documents the three install paths and the five-command quickstart", () => {
    const install = sectionBody(README, "## Install");
    for (const path of ["From a clone", "From a release tag", "From a packed tarball"]) {
      expect(install, `install section is missing: ${path}`).toContain(path);
    }
    expect(install).toContain("npm install -g .");
    expect(install).toContain("npm install -g ./easy-host-0.1.0.tgz");

    const quickstart = sectionBody(README, "## Quickstart");
    const commands = commandInvocations(quickstart);

    expect(new Set(commands)).toEqual(new Set(["doctor", "add", "status", "logs", "update"]));
    expect(commands).toHaveLength(5);
  });

  it("states the volume safety rule without contradicting it", () => {
    const safety = sectionBody(README, "## Volume safety");

    expect(safety).toContain("--volumes");
    expect(safety).toContain("--force");
    expect(safety).toContain("io.easy-host.app");
    expect(safety.toLowerCase()).toContain("named volume");
    expect(safety.toLowerCase()).toContain("host filesystem path");
  });

  it("carries a documentation index with working references", () => {
    const documentation = sectionBody(README, "## Documentation");
    const links = parseLinks(documentation, sectionStartLine(README, "## Documentation"));

    expect(
      links.length,
      "the documentation index should link at least ten documents",
    ).toBeGreaterThanOrEqual(10);
    for (const link of links) {
      assertLinkResolves(README_PATH, link);
    }
  });
});

describe("README links", () => {
  it("resolves every relative link", () => {
    const links = parseLinks(README);

    expect(links.length, "README should contain relative documentation links").toBeGreaterThan(10);

    for (const link of links) {
      assertLinkResolves(README_PATH, link);
    }
  });
});

describe("README commands", () => {
  it("only names commands that the CLI registers", () => {
    const names = new Set(commandInvocations(README));

    expect(
      names.size,
      "README should include at least one easy-host command example",
    ).toBeGreaterThan(0);

    for (const name of names) {
      expect(COMMAND_NAMES as readonly string[], `"${name}" is not a registered command`).toContain(
        name,
      );
    }
  });

  it("does not document a forbidden command", () => {
    const invoked = new Set(commandInvocations(README));

    for (const forbidden of FORBIDDEN_COMMAND_NAMES) {
      expect([...invoked]).not.toContain(forbidden);
    }
  });
});

describe("README branding", () => {
  it("does not keep the old React-only branding outside a migration note", () => {
    const outsideMigration = stripMigrationNote(README).toLowerCase();

    expect(outsideMigration).not.toContain("react-hoster");
    expect(outsideMigration).not.toMatch(/\breact[- ]only\b/);
    expect(outsideMigration).not.toContain("load your react app");
  });

  it("does not use images, scripts, or color-only meaning", () => {
    expect(README).not.toMatch(/!\[[^\]]*\]\([^)]*\)/);
    expect(README).not.toMatch(/<img\b/i);
    expect(README).not.toMatch(/<script\b/i);
    expect(README).not.toContain("\u001B[");
  });
});

describe("operations guides", () => {
  it("keeps the prerequisite guide's required sections", () => {
    const headings = markdownHeadings(PREREQUISITES);

    for (const heading of PREREQUISITE_HEADINGS) {
      expect(headings, `missing heading: ${heading}`).toContain(heading);
    }
  });

  it("gives every prerequisite a verification command and a doctor check", () => {
    for (const command of PREREQUISITE_VERIFICATIONS) {
      expect(PREREQUISITES, `missing verification command: ${command}`).toContain(command);
    }

    for (const id of DOCTOR_CHECK_IDS) {
      expect(PREREQUISITES, `missing doctor check: ${id}`).toContain(`\`${id}\``);
    }
  });

  it("documents the code's Podman window and the 6.x exclusion", () => {
    expect(PREREQUISITES).toContain(PODMAN_VERSION_RANGE);
    expect(PREREQUISITES).toContain(`${PODMAN_EXCLUSIVE_MAX_MAJOR}.0.0`);
    expect(PREREQUISITES).toContain("6.x");
    expect(PREREQUISITES.toLowerCase()).toContain("unstable");
    expect(PREREQUISITES.toLowerCase()).toContain("downgrade");
  });

  it("documents the explicit 4.9 upgrade path on Ubuntu 24.04 and Debian 12", () => {
    for (const fact of [
      "Ubuntu 24.04",
      "Debian 12",
      "4.9.3",
      "Ubuntu 25.04",
      "Debian 13",
      "trixie",
      "sudo apt install --only-upgrade podman",
    ]) {
      expect(PREREQUISITES, `missing upgrade fact: ${fact}`).toContain(fact);
    }

    expect(PREREQUISITES.toLowerCase()).toContain("not verified by this project");
  });

  it("ties lingering to reboot recovery", () => {
    expect(PREREQUISITES).toContain('sudo loginctl enable-linger "$USER"');
    expect(PREREQUISITES).toContain(PODMAN_RESTART_SERVICE);
    expect(PREREQUISITES).toContain("Linger=yes");
    expect(PREREQUISITES.toLowerCase()).toContain("mandatory");
    expect(PREREQUISITES.toLowerCase()).toContain("reboot");
  });

  it("states the documented git, Node, and port minimums", () => {
    expect(PREREQUISITES).toContain(`${GIT_MIN_VERSION.major}.${GIT_MIN_VERSION.minor}`);
    expect(PREREQUISITES).toContain(`Node.js ${NODE_MIN_MAJOR}`);
    expect(PREREQUISITES).toContain(String(MIN_HOST_PORT));
    expect(PREREQUISITES).toContain(String(MAX_PORT));
  });

  it("keeps the timer guide's required sections", () => {
    const headings = markdownHeadings(TIMER);

    for (const heading of TIMER_HEADINGS) {
      expect(headings, `missing heading: ${heading}`).toContain(heading);
    }
  });

  it("ships complete user units, enable commands, and a journal log location", () => {
    for (const literal of [
      "[Unit]",
      "[Service]",
      "[Timer]",
      "Type=oneshot",
      "ExecStart=%h/.local/bin/easy-host update blog",
      "OnCalendar=daily",
      "Persistent=true",
      "WantedBy=timers.target",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now easy-host-update-blog.timer",
      "journalctl --user -u easy-host-update-blog.service",
    ]) {
      expect(TIMER, `missing timer literal: ${literal}`).toContain(literal);
    }

    expect(TIMER).toContain("ships no daemon");
    expect(TIMER).toContain("scheduler");
  });

  it("explains the app lock for overlapping runs", () => {
    const lockMode = `0${LOCK_FILE_MODE.toString(8)}`;

    expect(TIMER).toContain(APP_LOCK_FILE_NAME);
    expect(TIMER).toContain(`<state-root>/apps/blog/${APP_LOCK_FILE_NAME}`);
    expect(TIMER).toContain(`mode \`${lockMode}\``);
    expect(TIMER).toContain("LOCK_HELD");
    expect(TIMER.toLowerCase()).toContain("non-blocking");
    expect(TIMER).toContain("exits **`6`**");
  });

  it("maps every public exit code in the timer guide", () => {
    const documented = new Set<number>();

    for (const match of TIMER.matchAll(/^\|\s*`(\d+)`\s*\|/gm)) {
      const code = match[1];
      if (code !== undefined) {
        documented.add(Number(code));
      }
    }

    expect([...documented].sort((left, right) => left - right)).toEqual(
      [...Object.values(EXIT_CODES)].sort((left, right) => left - right),
    );
  });

  it("keeps the Tailscale guide's sections and its loopback layout", () => {
    const headings = markdownHeadings(TAILSCALE);

    for (const heading of TAILSCALE_HEADINGS) {
      expect(headings, `missing heading: ${heading}`).toContain(heading);
    }

    for (const literal of [
      'bind = "127.0.0.1"',
      "tailscale serve --bg --https=443 http://127.0.0.1:8080",
      "tailscale funnel --bg --https=443 http://127.0.0.1:8080",
      "tailscale serve status",
      "https://tailscale.com/docs/reference/tailscale-cli/serve",
      "https://tailscale.com/docs/features/tailscale-funnel",
    ]) {
      expect(TAILSCALE, `missing Tailscale literal: ${literal}`).toContain(literal);
    }

    expect(TAILSCALE.toLowerCase()).toContain("not supported");
    expect(TAILSCALE.toLowerCase()).toContain("does not run tailscale inside the app container");
  });

  it("only names registered commands and no forbidden command", () => {
    for (const [filePath, markdown] of [
      [PREREQUISITES_PATH, PREREQUISITES],
      [TIMER_PATH, TIMER],
      [TAILSCALE_PATH, TAILSCALE],
    ] as const) {
      const invoked = commandInvocations(markdown);
      const source = relative(REPO_ROOT, filePath);

      expect(invoked.length, `${source} has no command example`).toBeGreaterThan(0);

      for (const name of invoked) {
        expect(
          COMMAND_NAMES as readonly string[],
          `"${name}" in ${source} is not a registered command`,
        ).toContain(name);
      }

      for (const forbidden of FORBIDDEN_COMMAND_NAMES) {
        expect(invoked, `${source} documents "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it("uses plain markdown for every guide", () => {
    for (const markdown of [PREREQUISITES, TIMER, TAILSCALE]) {
      expect(markdown).not.toMatch(/!\[[^\]]*\]\([^)]*\)/);
      expect(markdown).not.toMatch(/<img\b/i);
      expect(markdown).not.toMatch(/<script\b/i);
      expect(markdown).not.toContain("\u001B[");
      expect(markdown).not.toContain("react-hoster");
    }
  });

  it("is linked from the README documentation index", () => {
    const documentation = sectionBody(README, "## Documentation");

    for (const target of [
      "docs/operations/prerequisites.md",
      "docs/operations/systemd-timer.md",
      "docs/operations/tailscale.md",
      "docs/reference/cli.md",
      "docs/reference/config.md",
    ]) {
      expect(documentation, `README documentation index is missing ${target}`).toContain(
        `](${target})`,
      );
    }
  });
});

describe("documented markdown files", () => {
  it("exist and resolve their relative links", () => {
    for (const relativePath of DOCUMENTED_MARKDOWN) {
      const filePath = join(REPO_ROOT, relativePath);
      expect(existsSync(filePath), `${relativePath} is missing`).toBe(true);

      for (const link of parseLinks(readFileSync(filePath, "utf8"))) {
        assertLinkResolves(filePath, link);
      }
    }
  });
});
