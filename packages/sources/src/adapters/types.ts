import type { RawRecord } from "@jobtrace/core";
import { z } from "zod";

export interface AdapterResult {
  records: RawRecord[];
  /** Entries of the feed that could not be read, by position. */
  skipped: Array<{ index: number; reason: string }>;
}

/** Turns a provider's feed payload into raw job records. Throws ZodError on an unexpected shape. */
export type Adapter = (payload: unknown, feedUrl: string) => AdapterResult;

/** Feeds use null, missing and empty strings interchangeably for "no value". */
export const text = z
  .string()
  .nullish()
  .transform((value) => (value?.trim() ? value : null));

/** Maps each entry with `toFields`, collecting entries that fail validation instead of failing the feed. */
export function mapEntries<T>(
  entries: readonly unknown[],
  schema: z.ZodType<T>,
  feedUrl: string,
  toFields: (entry: T) => RawRecord["fields"] | null,
): AdapterResult {
  const result: AdapterResult = { records: [], skipped: [] };
  for (const [index, entry] of entries.entries()) {
    const parsed = schema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      result.skipped.push({
        index,
        reason: `${issue?.path.join(".") || "entry"}: ${issue?.message}`,
      });
      continue;
    }
    const fields = toFields(parsed.data);
    if (fields) result.records.push({ fields, sourceUrl: feedUrl });
  }
  return result;
}

/** Drops null values so absent custom fields do not show up as empty entries. */
export function compact(fields: Record<string, string | null | undefined>): RawRecord["fields"] {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}
