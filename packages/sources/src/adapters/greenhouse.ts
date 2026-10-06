import { decodeEntities, htmlToText } from "@jobtrace/extractor";
import { z } from "zod";
import { type Adapter, compact, mapEntries, text } from "./types.ts";

const named = z.object({ name: text }).nullish();

const job = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string().min(1),
  absolute_url: text,
  location: named,
  /** The description as HTML with its markup entity-escaped. */
  content: text,
  company_name: text,
  first_published: text,
  updated_at: text,
  requisition_id: text,
  departments: z.array(z.object({ name: text })).nullish(),
  offices: z.array(z.object({ name: text })).nullish(),
  pay_input_ranges: z
    .array(
      z.object({
        min_cents: z.number().nullish(),
        max_cents: z.number().nullish(),
        currency_type: text,
      }),
    )
    .nullish(),
});

const feed = z.object({ jobs: z.array(z.unknown()) });

function salary(ranges: z.infer<typeof job>["pay_input_ranges"]): string | null {
  const range = ranges?.find(
    (candidate) => candidate.min_cents != null || candidate.max_cents != null,
  );
  if (!range) return null;
  const amounts = [range.min_cents, range.max_cents]
    .filter((cents): cents is number => cents != null)
    .map((cents) => String(Math.round(cents / 100)));
  return `${range.currency_type ?? ""} ${[...new Set(amounts)].join(" - ")}`.trim();
}

/** Greenhouse Job Board API: `GET /v1/boards/{token}/jobs?content=true`. */
export const greenhouse: Adapter = (payload, feedUrl) =>
  mapEntries(feed.parse(payload).jobs, job, feedUrl, (entry) => {
    const html = entry.content ? decodeEntities(entry.content) : null;
    return compact({
      title: entry.title,
      url: entry.absolute_url,
      company: entry.company_name,
      location: entry.location?.name,
      description: html ? htmlToText(html) : null,
      descriptionHtml: html,
      postedAt: entry.first_published ?? entry.updated_at,
      salaryText: salary(entry.pay_input_ranges),
      department: entry.departments
        ?.map((department) => department.name)
        .filter(Boolean)
        .join(", "),
      office: entry.offices
        ?.map((office) => office.name)
        .filter(Boolean)
        .join(", "),
      requisitionId: entry.requisition_id,
      sourceId: String(entry.id),
    });
  });
