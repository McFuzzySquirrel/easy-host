/**
 * Shared human-output formatting (`OBS-FR-02`, `PRD-ACC-01`–`PRD-ACC-03`).
 *
 * Every human-facing read command renders through this module so the terminal
 * contract lives in one place:
 *
 * - colour is used only when stdout is a TTY and `NO_COLOR` is absent; a
 *   non-TTY pipe, `NO_COLOR`, or `TERM=dumb` produces plain text with no ANSI
 *   escapes (`PRD-ACC-02`);
 * - status is always a text label (`healthy`, `stopped`, `missing`, ...).
 *   Colour is additive decoration, never the carrier of meaning
 *   (`PRD-ACC-01`);
 * - every rendered line fits {@link OUTPUT_WIDTH} columns. Tables shrink
 *   optional columns, then move any value that still does not fit to a detail
 *   line instead of truncating it into ambiguity (`OBS-FR-02`);
 * - app names and ports are never truncated. A name or port that genuinely
 *   cannot fit is printed in full on a detail line.
 *
 * JSON output never passes through here; `json.ts` owns the machine-readable
 * contract and emits no ANSI escapes.
 */

import { createColors } from "picocolors";

/** The longest human line this module renders (`OBS-FR-02`). */
export const OUTPUT_WIDTH = 80;

/** Blank columns between two table cells. */
export const TABLE_GAP = 2;

/** Width reserved for a `label:` prefix, matching the PRD error shape. */
const FIELD_LABEL_WIDTH = 11;

const DEFAULT_INDENT = 2;

/** Marker kept in a cell whose full value moved to a detail line. */
const CLIP_MARKER = "…";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is intentional.
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

/** A stdout-like stream; `isTTY` is absent on a pipe or a test recorder. */
export interface TerminalStream {
  readonly isTTY?: boolean;
}

/** Inputs for the colour decision. Tests force `stream`/`color`. */
export interface FormatEnvironment {
  /** Stream whose `isTTY` decides whether ANSI is safe. Defaults to no TTY. */
  readonly stream?: TerminalStream;
  /** Environment inspected for `NO_COLOR` and `TERM=dumb`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit override for tests and embedders. `NO_COLOR` still wins. */
  readonly color?: boolean;
}

/**
 * Strips ANSI SGR and OSC sequences so width measurement and tests can look at
 * the visible text only.
 */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

/** Visible width in code points, ignoring ANSI escapes. */
export function displayWidth(value: string): number {
  return Array.from(stripAnsi(value)).length;
}

/**
 * True when the environment asks for plain text. `NO_COLOR` counts when it is
 * present and not empty (`https://no-color.org`); `TERM=dumb` is treated the
 * same way because such a terminal cannot render escapes either.
 */
export function noColorRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor.length > 0) {
    return true;
  }

  return env.TERM === "dumb";
}

/**
 * Decides whether ANSI colour may be emitted. The order is deliberate:
 * `NO_COLOR` and `TERM=dumb` always disable colour, an explicit override is
 * honoured next, and a real TTY is required last. A recorder without `isTTY`
 * (pipes, systemd timers, tests) therefore never receives escapes.
 */
export function detectColor(options: FormatEnvironment = {}): boolean {
  const env = options.env ?? process.env;

  if (noColorRequested(env)) {
    return false;
  }

  if (options.color !== undefined) {
    return options.color;
  }

  return options.stream?.isTTY === true;
}

/** A semantic colour role; the text label always carries the meaning. */
export type Tone = "success" | "danger" | "warning" | "muted" | "accent";

/**
 * Text labels mapped to a colour role. Unknown labels stay uncoloured, so a
 * new status can never be invisible or miscoloured.
 */
const STATUS_TONES: Readonly<Record<string, Tone>> = {
  healthy: "success",
  pass: "success",
  valid: "success",
  running: "success",
  unhealthy: "danger",
  fail: "danger",
  broken: "danger",
  invalid: "danger",
  stopped: "warning",
  missing: "warning",
  warn: "warning",
  unknown: "muted",
  skip: "muted",
};

/** One table column and its width policy. */
export interface TableColumn {
  readonly header: string;
  /** Floor before a column is shrunk. Header length is always honoured. */
  readonly minWidth: number;
  /** When true the column gives up width before a fixed column does. */
  readonly shrink: boolean;
  /**
   * When true the column is removed and its values move to detail lines if the
   * table still cannot fit after shrinking. Only used for optional columns
   * whose full value is also available from `status`.
   */
  readonly droppable?: boolean;
  /** Colours a cell after its visible width has been measured. */
  readonly paint?: (value: string) => string;
}

/** A table row with an optional label used by detail lines. */
export interface TableRow {
  readonly cells: readonly string[];
  /** Defaults to the first cell, which is the app name in `list`. */
  readonly label?: string;
}

/** Either a labelled row or the older plain cell array. */
export type TableRowInput = TableRow | readonly string[];

/** Options shared by the table renderer. */
export interface TableOptions {
  /** Line width; defaults to {@link OUTPUT_WIDTH}. */
  readonly width?: number;
}

/** Options for one `label: value` field. */
export interface FieldOptions {
  /** Leading spaces before the label. Defaults to 2. */
  readonly indent?: number;
  /** Line width; defaults to {@link OUTPUT_WIDTH}. */
  readonly width?: number;
  /** Colours the visible value without changing the measured width. */
  readonly paint?: (value: string) => string;
}

/**
 * The renderer the read commands use. Methods are closures, so they can be
 * passed around (`paint: formatter.status`) without losing their receiver.
 */
export interface Formatter {
  /** True when ANSI escapes may be emitted. */
  readonly color: boolean;
  /** Applies a semantic colour role, or returns the text unchanged. */
  tone(tone: Tone, value: string): string;
  /** Colours a status label while always keeping the label itself. */
  status(label: string): string;
  /** Renders one wrapped `label: value` field. */
  field(label: string, value: string, options?: FieldOptions): string[];
  /** Renders a table that fits the configured width. */
  table(
    columns: readonly TableColumn[],
    rows: readonly TableRowInput[],
    options?: TableOptions,
  ): string[];
}

/**
 * Builds a formatter for one output stream. `NO_COLOR`, `TERM=dumb`, and a
 * missing TTY all resolve to `color: false`.
 */
export function createFormatter(options: FormatEnvironment = {}): Formatter {
  const color = detectColor(options);
  const colors = createColors(color);

  const tone = (role: Tone, value: string): string => {
    if (!color) {
      return value;
    }

    switch (role) {
      case "success":
        return colors.green(value);
      case "danger":
        return colors.red(value);
      case "warning":
        return colors.yellow(value);
      case "muted":
        return colors.dim(value);
      case "accent":
        return colors.cyan(value);
    }
  };

  const status = (label: string): string => {
    const role = STATUS_TONES[label.trim().toLowerCase()];
    return role === undefined ? label : tone(role, label);
  };

  return {
    color,
    tone,
    status,
    field: formatField,
    table: formatTable,
  };
}

/**
 * Wraps `value` to `width` columns. It never returns a line wider than the
 * width, splitting a long unbroken token as a last resort so a branch name or
 * image reference is preserved in full rather than dropped.
 */
export function wrapText(value: string, width: number = OUTPUT_WIDTH): string[] {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length === 0) {
    return ["-"];
  }

  const limit = Math.max(1, Math.trunc(width));
  const lines: string[] = [];
  let current = "";

  for (const word of clean.split(" ")) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }

    while (current.length > limit) {
      lines.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

/**
 * Renders one `label: value` field, wrapping the value and aligning any
 * continuation lines under the first character of the value. Long values wrap
 * rather than truncate, so a path or probe target stays complete.
 */
export function formatField(label: string, value: string, options: FieldOptions = {}): string[] {
  const indent = options.indent ?? DEFAULT_INDENT;
  const width = options.width ?? OUTPUT_WIDTH;
  const prefix = `${" ".repeat(indent)}${label}:`.padEnd(indent + FIELD_LABEL_WIDTH);
  const available = Math.max(1, width - displayWidth(prefix));
  const wrapped = wrapText(value.length === 0 ? "-" : value, available);

  return wrapped.map((line, index) => {
    const text = options.paint === undefined ? line : options.paint(line);
    return index === 0 ? `${prefix}${text}` : `${" ".repeat(displayWidth(prefix))}${text}`;
  });
}

/**
 * Renders an aligned table.
 *
 * Width policy, in order:
 *
 * 1. use each cell's content width;
 * 2. shrink `shrink` columns down to their minimum;
 * 3. drop `droppable` columns, widest first;
 * 4. as a last resort shrink every remaining column to its minimum, then to
 *    one character.
 *
 * A cell that still does not fit is marked with `…` in the table and printed
 * in full on a detail line labelled with the row's app name and the column
 * header. App names and ports are never sliced: their whole value moves to the
 * detail line when no width is left.
 */
export function formatTable(
  columns: readonly TableColumn[],
  rows: readonly TableRowInput[],
  options: TableOptions = {},
): string[] {
  const width = Math.max(1, options.width ?? OUTPUT_WIDTH);
  const normalized = rows.map(normalizeRow);

  if (columns.length === 0) {
    return normalized.map((row) => row.cells.join(" ".repeat(TABLE_GAP)).trimEnd());
  }

  const minWidths = columns.map((column) => Math.max(column.minWidth, displayWidth(column.header)));
  const widths = minWidths.map((minWidth, index) => {
    let actual = minWidth;
    for (const row of normalized) {
      actual = Math.max(actual, displayWidth(row.cells[index] ?? ""));
    }
    return actual;
  });

  const active = columns.map(() => true);
  const activeIndices = (): number[] => {
    const indices: number[] = [];
    for (let index = 0; index < columns.length; index += 1) {
      if (active[index] === true) {
        indices.push(index);
      }
    }
    return indices;
  };
  const totalWidth = (): number => {
    const indices = activeIndices();
    let total = TABLE_GAP * Math.max(0, indices.length - 1);
    for (const index of indices) {
      total += widths[index] ?? 0;
    }
    return total;
  };

  const widest = (indices: readonly number[]): number => {
    let candidate = -1;
    for (const index of indices) {
      if (candidate < 0 || (widths[index] ?? 0) > (widths[candidate] ?? 0)) {
        candidate = index;
      }
    }
    return candidate;
  };

  // 1. Optional columns give up width first.
  while (totalWidth() > width) {
    const shrinkable = activeIndices().filter(
      (index) => columns[index]?.shrink === true && (widths[index] ?? 0) > (minWidths[index] ?? 0),
    );
    const candidate = widest(shrinkable);
    if (candidate < 0) {
      break;
    }

    widths[candidate] = (widths[candidate] ?? 1) - 1;
  }

  // 2. If space is still short, remove optional columns entirely.
  while (totalWidth() > width) {
    let candidate = -1;
    for (const index of activeIndices()) {
      if (columns[index]?.droppable !== true) {
        continue;
      }

      if (candidate < 0 || (widths[index] ?? 0) > (widths[candidate] ?? 0)) {
        candidate = index;
      }
    }

    if (candidate < 0) {
      break;
    }

    active[candidate] = false;
  }

  // 3. Last resorts: shrink fixed columns to their minimum, then to one
  // character. Their values move to detail lines instead of being truncated.
  while (totalWidth() > width) {
    const reducible = activeIndices().filter(
      (index) => (widths[index] ?? 0) > (minWidths[index] ?? 0),
    );
    const candidate = widest(reducible);
    if (candidate < 0) {
      break;
    }

    widths[candidate] = Math.max(minWidths[candidate] ?? 1, (widths[candidate] ?? 1) - 1);
  }

  while (totalWidth() > width) {
    const reducible = activeIndices().filter((index) => (widths[index] ?? 0) > 1);
    const candidate = widest(reducible);
    if (candidate < 0) {
      break;
    }

    widths[candidate] = (widths[candidate] ?? 1) - 1;
  }

  const dropped: number[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    if (active[index] !== true) {
      dropped.push(index);
    }
  }

  const detailLines: string[] = [];
  const preparedRows = normalized.map((row) => {
    const label = row.label ?? row.cells[0] ?? "row";
    const cells: PreparedCell[] = [];

    for (const index of activeIndices()) {
      const cellWidth = widths[index] ?? 0;
      const value = row.cells[index] ?? "";
      const clipped = clipCell(value, cellWidth);
      cells.push({ index, text: clipped.text });

      if (clipped.clipped) {
        detailLines.push(...formatDetail(label, columnField(columns, index), value, width));
      }
    }

    for (const index of dropped) {
      const value = row.cells[index] ?? "";
      if (value.length > 0) {
        detailLines.push(...formatDetail(label, columnField(columns, index), value, width));
      }
    }

    return { cells };
  });

  const headerCells: PreparedCell[] = activeIndices().map((index) => ({
    index,
    text: clipCell(columns[index]?.header ?? "", widths[index] ?? 0).text,
  }));

  const lines = [renderCells(headerCells, columns, widths, true)];
  for (const row of preparedRows) {
    lines.push(renderCells(row.cells, columns, widths, false));
  }

  if (detailLines.length > 0) {
    lines.push("");
    lines.push(...detailLines);
  }

  return lines;
}

/** One cell after the width decision, before colour is applied. */
interface PreparedCell {
  readonly index: number;
  readonly text: string;
}

interface ClippedCell {
  readonly text: string;
  readonly clipped: boolean;
}

function normalizeRow(row: TableRowInput): TableRow {
  return "cells" in row ? row : { cells: row };
}

function columnField(columns: readonly TableColumn[], index: number): string {
  return (columns[index]?.header ?? "").toLowerCase();
}

/**
 * Fits one value into `width`. A shorter value is returned untouched; a longer
 * one keeps its leading characters and gains `…`, and the caller prints the
 * whole value on a detail line.
 */
function clipCell(value: string, width: number): ClippedCell {
  if (width <= 0) {
    return { text: "", clipped: value.length > 0 };
  }

  if (displayWidth(value) <= width) {
    return { text: value, clipped: false };
  }

  if (width === 1) {
    return { text: CLIP_MARKER, clipped: true };
  }

  const characters = Array.from(stripAnsi(value));
  return {
    text: `${characters.slice(0, width - 1).join("")}${CLIP_MARKER}`,
    clipped: true,
  };
}

function renderCells(
  cells: readonly PreparedCell[],
  columns: readonly TableColumn[],
  widths: readonly number[],
  isHeader: boolean,
): string {
  const parts: string[] = [];

  for (const cell of cells) {
    const cellWidth = widths[cell.index] ?? 0;
    const column = columns[cell.index];
    const paint = isHeader ? undefined : column?.paint;
    const text = paint === undefined ? cell.text : paint(cell.text);
    const padding = " ".repeat(Math.max(0, cellWidth - displayWidth(cell.text)));

    parts.push(`${text}${padding}`);
  }

  return parts.join(" ".repeat(TABLE_GAP)).trimEnd();
}

/**
 * Renders one detail line for a value that did not fit a table cell. The line
 * starts with the row label and field name, and wraps without truncation.
 */
function formatDetail(label: string, field: string, value: string, width: number): string[] {
  const heading = `  ${label} ${field}:`;

  if (displayWidth(heading) + 2 > width) {
    return [heading, ...wrapText(value, Math.max(1, width - 2)).map((line) => `  ${line}`)];
  }

  const prefix = `${heading} `;
  const available = Math.max(1, width - displayWidth(prefix));

  return wrapText(value, available).map((line, index) =>
    index === 0 ? `${prefix}${line}` : `${" ".repeat(displayWidth(prefix))}${line}`,
  );
}
