import { z } from "zod";

/** Field names that map onto the core job schema; anything else lands in `custom`. */
export const CORE_FIELD_NAMES = [
  "title",
  "company",
  "location",
  "remote",
  "salaryText",
  "url",
  "description",
  "descriptionHtml",
  "postedAt",
  "employmentType",
] as const;
export type CoreFieldName = (typeof CORE_FIELD_NAMES)[number];

export const REMOTE_VALUES = ["onsite", "hybrid", "remote", "unknown"] as const;
export type RemoteKind = (typeof REMOTE_VALUES)[number];

export const SALARY_PERIODS = ["hour", "day", "week", "month", "year"] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

/**
 * Field values as read from a source, before normalization. Browser recordings
 * and ATS API sources both produce these, so nothing here may depend on a browser.
 */
export interface RawRecord {
  fields: Record<string, string | null>;
  /** URL the record was read from; base for resolving relative URLs. */
  sourceUrl: string;
}

export const jobSchema = z.strictObject({
  recordingId: z.string(),
  dedupKey: z.string(),
  contentHash: z.string(),
  title: z.string().min(1),
  company: z.string().nullable(),
  location: z.string().nullable(),
  remote: z.enum(REMOTE_VALUES),
  salaryText: z.string().nullable(),
  salaryMin: z.number().nullable(),
  salaryMax: z.number().nullable(),
  salaryCurrency: z.string().nullable(),
  salaryPeriod: z.enum(SALARY_PERIODS).nullable(),
  url: z.string().nullable(),
  description: z.string().nullable(),
  descriptionHtml: z.string().nullable(),
  /** ISO 8601 timestamp. */
  postedAt: z.string().nullable(),
  employmentType: z.string().nullable(),
  custom: z.record(z.string(), z.string().nullable()),
});
export type NormalizedJob = z.infer<typeof jobSchema>;
