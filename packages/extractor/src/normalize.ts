import { createHash } from "node:crypto";
import {
  CORE_FIELD_NAMES,
  type CoreFieldName,
  type NormalizedJob,
  type RawRecord,
  type RemoteKind,
} from "@jobtrace/core";
import { parseDate } from "./date.ts";
import { parseSalary } from "./salary.ts";
import { collapseWhitespace } from "./transforms.ts";
import { canonicalizeUrl } from "./url.ts";

export interface NormalizeContext {
  recordingId: string;
  /** Reference time for relative posting dates. */
  now: Date;
  defaults?: { company?: string | undefined };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const isCoreField = (name: string): name is CoreFieldName =>
  (CORE_FIELD_NAMES as readonly string[]).includes(name);

function line(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = collapseWhitespace(value);
  return cleaned === "" ? null : cleaned;
}

/** Multi-line text: trims each line and collapses runs of blank lines. */
function block(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((part) => part.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned === "" ? null : cleaned;
}

/** Infers the work arrangement from free text such as a location or title. */
export function inferRemote(...texts: Array<string | null | undefined>): RemoteKind {
  for (const text of texts) {
    if (!text) continue;
    if (/\bhybrid\b/i.test(text)) return "hybrid";
    if (/\bremote\b|\bwork from home\b|\bwfh\b|\btelecommut|\bdistributed\b/i.test(text)) {
      return "remote";
    }
    if (/\bon[-\s]?site\b|\bin[-\s]office\b|\bin[-\s]person\b/i.test(text)) return "onsite";
  }
  return "unknown";
}

/** Canonical URL when there is one, otherwise a hash of the identifying fields. */
export function computeDedupKey(job: {
  recordingId: string;
  url: string | null;
  title: string;
  company: string | null;
  location: string | null;
}): string {
  if (job.url) return job.url;
  const identity = [job.recordingId, job.title, job.company ?? "", job.location ?? ""];
  return `sha256:${sha256(JSON.stringify(identity.map((part) => part.toLowerCase())))}`;
}

/**
 * Hash of the job's content, used to flag changed jobs across runs. `postedAt`
 * is deliberately excluded: relative dates ("3 days ago") shift every day and
 * would make every job look changed.
 */
export function computeContentHash(
  job: Omit<NormalizedJob, "contentHash" | "dedupKey" | "recordingId">,
): string {
  const custom = Object.keys(job.custom)
    .sort()
    .map((key) => [key, job.custom[key]]);
  return sha256(
    JSON.stringify([
      job.title,
      job.company,
      job.location,
      job.remote,
      job.salaryText,
      job.salaryMin,
      job.salaryMax,
      job.salaryCurrency,
      job.salaryPeriod,
      job.url,
      job.description,
      job.descriptionHtml,
      job.employmentType,
      custom,
    ]),
  );
}

/**
 * Turns raw field values into a job in the core schema. Returns null when the
 * record has no title, which is the one field a job cannot be saved without.
 */
export function normalizeRecord(
  record: RawRecord,
  context: NormalizeContext,
): NormalizedJob | null {
  const { fields } = record;
  const title = line(fields.title);
  if (title === null) return null;

  const company = line(fields.company) ?? line(context.defaults?.company);
  const location = line(fields.location);
  const salaryText = line(fields.salaryText);
  const salary = salaryText
    ? parseSalary(salaryText)
    : { min: null, max: null, currency: null, period: null };
  const url = fields.url ? canonicalizeUrl(fields.url, record.sourceUrl) : null;
  const postedAt = fields.postedAt ? parseDate(fields.postedAt, context.now) : null;

  const custom: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!isCoreField(name)) custom[name] = value === null ? null : value.trim();
  }

  const content = {
    title,
    company,
    location,
    remote: inferRemote(fields.remote, location, title),
    salaryText,
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    salaryPeriod: salary.period,
    url,
    description: block(fields.description),
    descriptionHtml: fields.descriptionHtml?.trim() || null,
    postedAt: postedAt?.toISOString() ?? null,
    employmentType: line(fields.employmentType),
    custom,
  };
  return {
    recordingId: context.recordingId,
    dedupKey: computeDedupKey({ recordingId: context.recordingId, url, title, company, location }),
    contentHash: computeContentHash(content),
    ...content,
  };
}

/** Drops jobs whose dedup key was already seen earlier in the same run. */
export function dedupeJobs(jobs: readonly NormalizedJob[]): NormalizedJob[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (seen.has(job.dedupKey)) return false;
    seen.add(job.dedupKey);
    return true;
  });
}
