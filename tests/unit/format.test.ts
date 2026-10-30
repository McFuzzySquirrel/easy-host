/**
 * Human-output coverage (`OBS-1.2`, `OBS-FR-02`, `PRD-ACC-01`, `PRD-ACC-02`).
 *
 * The suite drives the production formatter with forced TTY state, a forced
 * pipe, `NO_COLOR`, and the 80-column contract. It asserts the properties that
 * matter to an operator rather than a pixel snapshot: no ANSI escapes whenever
 * colour is unavailable, a text label for every status, no line wider than 80
 * columns, and long values preserved in full on detail lines instead of being
 * silently truncated.
 */

import { describe, expect, it } from "vitest";
import { formatConfigReport } from "../../src/cli/commands/config.js";
import { formatListReport } from "../../src/cli/commands/list.js";
import type { AppRow } from "../../src/cli/commands/read-model.js";
import { LIST_TABLE_COLUMNS } from "../../src/cli/commands/read-model.js";
import { formatStatusReport } from "../../src/cli/commands/status.js";
import {
  createFormatter,
  detectColor,
  displayWidth,
  type Formatter,
  formatField,
  formatTable,
  noColorRequested,
  OUTPUT_WIDTH,
  stripAnsi,
} from "../../src/cli/format.js";
import { validateAppSpec } from "../../src/config/parse.js";
import type { AppSpec } from "../../src/config/schema.js";
import type { AppState } from "../../src/registry/state.js";
import type { OkAppEntry } from "../../src/registry/store.js";

const ANSI_ESCAPE = "\u001B[";
const WIDTH = 80;

const STATUS_LABELS = ["healthy", "unhealthy", "stopped", "missing", "broken", "unknown"] as const;

const LONG_NAME = "a".repeat(32);
const LONG_REF = `feature/${"x".repeat(23)}`;
const LONG_IMAGE_TAG = "z".repeat(20);

const FIXED_ISO = "2026-10-30T12:00:00.000Z";

function expectNoAnsi(text: string): void {
  expect(text).not.toContain(ANSI_ESCAPE);
}

function expectWithinWidth(text: string, width = WIDTH): void {
  for (const line of text.split("\n")) {
    expect(displayWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(width);
  }
}

function plainFormatter(): Formatter {
  return createFormatter({ stream: { isTTY: false }, env: {} });
}

function colorFormatter(): Formatter {
  return createFormatter({ stream: { isTTY: true }, env: {} });
}

function createSpec(): AppSpec {
  return validateAppSpec({
    repo: "https://example.com/blog.git",
    port: 8080,
  });
}

function createState(): AppState {
  return {
    schemaVersion: 1,
    name: "blog",
    images: {
      current: "localhost/easy-host-blog:20261030T120000Z",
      previous: null,
    },
    containerId: "container-0123456789abcdef",
    health: {
      status: "healthy",
      checkedAt: FIXED_ISO,
      detail: "probe http://127.0.0.1:8080/ healthy after 1 attempt(s)",
    },
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
}

function createRow(overrides: { readonly spec?: AppSpec; readonly name?: string } = {}): AppRow {
  const name = overrides.name ?? "blog";
  const spec = overrides.spec ?? createSpec();
  const entry: OkAppEntry = {
    status: "ok",
    name,
    directory: `/tmp/easy-host/apps/${name}`,
    configPath: `/tmp/easy-host/apps/${name}/config.toml`,
    spec,
  };

  return {
    name,
    status: "healthy",
    entry,
    spec,
    state: createState(),
    container: undefined,
    error: undefined,
  };
}

function columnsWith(paint: (value: string) => string) {
  return LIST_TABLE_COLUMNS.map((column) =>
    column.header === "STATUS" ? { ...column, paint } : column,
  );
}

describe("colour decisions", () => {
  it("uses colour only for a TTY without NO_COLOR", () => {
    expect(detectColor({ stream: { isTTY: true }, env: {} })).toBe(true);
    expect(detectColor({ stream: { isTTY: false }, env: {} })).toBe(false);
    expect(detectColor({ stream: {}, env: {} })).toBe(false);
    expect(detectColor({ env: {} })).toBe(false);
  });

  it("lets NO_COLOR override a TTY and an explicit colour request", () => {
    expect(detectColor({ stream: { isTTY: true }, env: { NO_COLOR: "1" } })).toBe(false);
    expect(detectColor({ color: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(detectColor({ stream: { isTTY: true }, env: { NO_COLOR: "" } })).toBe(true);
  });

  it("treats TERM=dumb as no colour", () => {
    expect(noColorRequested({ TERM: "dumb" })).toBe(true);
    expect(detectColor({ stream: { isTTY: true }, env: { TERM: "dumb" } })).toBe(false);
  });

  it("honours an explicit colour override when NO_COLOR is absent", () => {
    expect(detectColor({ color: true, env: {} })).toBe(true);
    expect(detectColor({ color: false, stream: { isTTY: true }, env: {} })).toBe(false);
  });
});

describe("status labels", () => {
  it("keeps the text label when colour is unavailable", () => {
    const formatter = plainFormatter();
    expect(formatter.color).toBe(false);

    for (const label of STATUS_LABELS) {
      expect(formatter.status(label)).toBe(label);
    }
  });

  it("pairs colour with the label instead of replacing it", () => {
    const formatter = colorFormatter();
    expect(formatter.color).toBe(true);

    for (const label of STATUS_LABELS) {
      const painted = formatter.status(label);
      expect(painted).toContain(ANSI_ESCAPE);
      expect(stripAnsi(painted)).toBe(label);
    }
  });

  it("leaves an unknown label unchanged and uncoloured", () => {
    expect(plainFormatter().status("reticulating")).toBe("reticulating");
    expect(colorFormatter().status("reticulating")).toBe("reticulating");
  });
});

describe("fields", () => {
  it("wraps a long value instead of truncating it", () => {
    const value = Array.from({ length: 40 }, () => "word").join(" ");
    const lines = formatField("source", value);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).toContain("source:");
    expect(lines.join(" ").split("word").length - 1).toBe(40);
    expectWithinWidth(lines.join("\n"));
    expectNoAnsi(lines.join("\n"));
  });

  it("paints the value without changing its visible text", () => {
    const lines = formatField("status", "healthy", {
      paint: colorFormatter().status,
    });
    const text = lines.join("\n");

    expect(text).toContain(ANSI_ESCAPE);
    expect(stripAnsi(text)).toMatch(/status:\s+healthy/);
    expectWithinWidth(text);
  });
});

describe("tables", () => {
  it("keeps a normal table plain, labelled, and inside 80 columns", () => {
    const formatter = plainFormatter();
    const lines = formatter.table(columnsWith(formatter.status), [
      ["blog", "healthy", "8080", "main", "2026-10-30 12:00", "20261030T120000Z"],
      ["api", "unhealthy", "8081", "main", "2026-10-28 09:02", "20261028T090200Z"],
    ]);
    const text = lines.join("\n");

    expect(lines[0]).toContain("NAME");
    expect(lines[0]).toContain("STATUS");
    expect(lines[0]).toContain("PORT");
    expect(lines[0]).toContain("REF");
    expect(lines[0]).toContain("UPDATED");
    expect(lines[0]).toContain("IMAGE");
    expect(text).toContain("healthy");
    expect(text).toContain("unhealthy");
    expect(text).toContain("8080");
    expectNoAnsi(text);
    expectWithinWidth(text);
  });

  it("never truncates an app name or port and moves long values to detail lines", () => {
    const formatter = plainFormatter();
    const lines = formatter.table(columnsWith(formatter.status), [
      [LONG_NAME, "unhealthy", "65535", LONG_REF, "2026-10-30 12:00", LONG_IMAGE_TAG],
    ]);
    const text = lines.join("\n");

    expect(text).toContain(LONG_NAME);
    expect(text).toContain("65535");
    expect(text).toContain(LONG_REF);
    expect(text).toContain(LONG_IMAGE_TAG);
    expect(text).toContain(`${LONG_NAME} ref:`);
    expect(text).toContain(`${LONG_NAME} image:`);
    expectNoAnsi(text);
    expectWithinWidth(text);
  });

  it("preserves a very long unbroken value in full on wrapped detail lines", () => {
    const longRef = "q".repeat(200);
    const lines = formatTable(LIST_TABLE_COLUMNS, [
      ["blog", "healthy", "8080", longRef, "2026-10-30 12:00", "20261030T120000Z"],
    ]);
    const text = lines.join("\n");
    const details = text.split("\n\n")[1] ?? "";

    expect(lines.length).toBeGreaterThan(2);
    expect(details.split("q").length - 1).toBe(longRef.length);
    expectWithinWidth(text);
    expectNoAnsi(text);
  });

  it("keeps colour inside the width budget and never colour-only", () => {
    const formatter = colorFormatter();
    const lines = formatter.table(columnsWith(formatter.status), [
      [LONG_NAME, "unhealthy", "65535", LONG_REF, "2026-10-30 12:00", LONG_IMAGE_TAG],
    ]);
    const text = lines.join("\n");

    expect(text).toContain(ANSI_ESCAPE);
    expect(stripAnsi(text)).toContain("unhealthy");
    expectWithinWidth(text);
  });

  it("fits the declared 80-column width", () => {
    expect(OUTPUT_WIDTH).toBe(80);
  });
});

describe("read command rendering", () => {
  it("renders list output plain for a pipe and for NO_COLOR", () => {
    const row = createRow();
    const piped = formatListReport([row], plainFormatter());
    const noColor = formatListReport(
      [row],
      createFormatter({ stream: { isTTY: true }, env: { NO_COLOR: "1" } }),
    );

    for (const text of [piped, noColor]) {
      expect(text).toContain("healthy");
      expect(text).toMatch(/blog\s+healthy/);
      expectNoAnsi(text);
      expectWithinWidth(text);
    }
  });

  it("adds status colour for a forced TTY without changing the label", () => {
    const row = createRow();
    const text = formatListReport([row], colorFormatter());

    expect(text).toContain(ANSI_ESCAPE);
    expect(stripAnsi(text)).toMatch(/blog\s+healthy/);
    expectWithinWidth(text);
  });

  it("keeps status output plain and legible without colour", () => {
    const row = createRow();
    const text = formatStatusReport([row], plainFormatter());

    expect(text).toMatch(/status:\s+healthy/);
    expect(text).toMatch(/health:\s+healthy/);
    expect(text).toContain("8080 -> 3000 on 0.0.0.0");
    expectNoAnsi(text);
    expectWithinWidth(text);
  });

  it("colours only the status label in status output", () => {
    const row = createRow();
    const text = formatStatusReport([row], colorFormatter());

    expect(text).toContain(ANSI_ESCAPE);
    expect(stripAnsi(text)).toMatch(/status:\s+healthy/);
    expectWithinWidth(text);
  });

  it("keeps config output plain when colour is unavailable", () => {
    const row = createRow();
    const spec = row.spec ?? createSpec();
    const text = formatConfigReport(
      {
        name: "blog",
        directory: "/tmp/easy-host/apps/blog",
        configPath: "/tmp/easy-host/apps/blog/config.toml",
        secretsPath: "/tmp/easy-host/apps/blog/secrets.env",
        statePath: "/tmp/easy-host/apps/blog/state.json",
        workspacePath: "/tmp/easy-host/apps/blog/workspace",
      },
      spec,
      plainFormatter(),
    );

    expect(text).toMatch(/status:\s+valid/);
    expectNoAnsi(text);
    expectWithinWidth(text);
  });
});
