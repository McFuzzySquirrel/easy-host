import {
  type DoctorOptions,
  type DoctorReport,
  formatDoctorJson,
  formatDoctorReport,
  runDoctor,
} from "../../doctor/index.js";
import { EXIT_CODES, type ExitCode } from "../errors.js";

/**
 * The `doctor` command handler.
 *
 * Human output and the `--json` document both go to stdout (`PRE-FR-07`).
 * A failed host check returns exit 2 as a prerequisite or environment failure
 * (`PRE-NF-02`); pass, warn, and skip return 0.
 */

/** A writable stream, narrowed so tests can inject a recorder. */
export interface DoctorOutputStream {
  write(chunk: string): unknown;
}

export interface DoctorCommandOptions extends DoctorOptions {
  /** Writes the JSON document instead of the human report. */
  json?: boolean;
  /** Destination for the report. Defaults to `process.stdout`. */
  stdout?: DoctorOutputStream;
}

/** The exit code for a completed report. */
export function doctorExitCode(report: DoctorReport): ExitCode {
  return report.status === "fail" ? EXIT_CODES.PREREQUISITE : EXIT_CODES.SUCCESS;
}

/**
 * Runs doctor, writes exactly one report to stdout, and returns the exit code
 * the top-level entry should use.
 */
export function runDoctorCommand(options: DoctorCommandOptions = {}): ExitCode {
  const { json = false, stdout = process.stdout, ...doctorOptions } = options;
  const report = runDoctor(doctorOptions);

  stdout.write(json ? formatDoctorJson(report) : formatDoctorReport(report));

  return doctorExitCode(report);
}
