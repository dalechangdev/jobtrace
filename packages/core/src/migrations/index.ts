import { z } from "zod";
import { JobTraceError } from "../errors.ts";
import { CURRENT_SCHEMA_VERSION, type Recording, recordingSchema } from "../recording.ts";

/** A pure function upgrading a recording document from version N to N + 1. */
export type Migration = (document: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations keyed by the version they upgrade *from*. Each returns the
 * document in the next version's shape; the version number is set for it.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  // 1 -> 2 only added an optional field, so version 1 documents are valid as they are.
  1: (document) => document,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Upgrades a raw recording document to the current schema version without validating it. */
export function migrateRecording(
  document: unknown,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
  targetVersion: number = CURRENT_SCHEMA_VERSION,
): Record<string, unknown> {
  if (!isRecord(document)) {
    throw new JobTraceError("INVALID_RECORDING", "A recording must be a JSON object");
  }
  const version = document.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new JobTraceError("INVALID_RECORDING", "Recording is missing an integer schemaVersion");
  }
  if (version > targetVersion) {
    throw new JobTraceError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Recording uses schema version ${version}, but this JobTrace supports up to ${targetVersion}. Upgrade JobTrace.`,
    );
  }
  let current = document;
  for (let from = version; from < targetVersion; from++) {
    const migrate = migrations[from];
    if (!migrate) {
      throw new JobTraceError(
        "UNSUPPORTED_SCHEMA_VERSION",
        `No migration from recording schema version ${from} to ${from + 1}`,
      );
    }
    current = { ...migrate(current), schemaVersion: from + 1 };
  }
  return current;
}

/** Migrates and validates a recording document. Throws INVALID_RECORDING with readable issues. */
export function parseRecording(document: unknown): Recording {
  const result = recordingSchema.safeParse(migrateRecording(document));
  if (!result.success) {
    throw new JobTraceError(
      "INVALID_RECORDING",
      `Invalid recording:\n${z.prettifyError(result.error)}`,
      { details: { issues: result.error.issues } },
    );
  }
  return result.data;
}

/** Parses recording JSON text, e.g. the contents of a `.jobtrace.json` file. */
export function parseRecordingJson(text: string): Recording {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new JobTraceError("INVALID_RECORDING", "Recording is not valid JSON", { cause: error });
  }
  return parseRecording(document);
}
