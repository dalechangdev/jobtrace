import { htmlToText } from "@jobtrace/extractor";
import { z } from "zod";
import { type Adapter, compact, mapEntries, text } from "./types.ts";

const posting = z.object({
  id: z.string(),
  /** The job title. */
  text: z.string().min(1),
  hostedUrl: text,
  createdAt: z.number().nullish(),
  categories: z
    .object({
      location: text,
      commitment: text,
      team: text,
      department: text,
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
  /** remote | hybrid | onsite | unspecified */
  workplaceType: text,
  description: text,
  descriptionPlain: text,
  lists: z.array(z.object({ text: text, content: text })).nullish(),
  additional: text,
  additionalPlain: text,
  salaryDescriptionPlain: text,
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: text,
      /** e.g. `per-year-salary`, `per-hour-wage` */
      interval: text,
    })
    .nullish(),
});

function salary(entry: z.infer<typeof posting>): string | null {
  const range = entry.salaryRange;
  if (range && (range.min != null || range.max != null)) {
    const amounts = [range.min, range.max].filter((amount): amount is number => amount != null);
    const period = /per-(hour|day|week|month|year)/.exec(range.interval ?? "")?.[1];
    return `${range.currency ?? ""} ${[...new Set(amounts)].join(" - ")}${period ? ` per ${period}` : ""}`.trim();
  }
  return entry.salaryDescriptionPlain;
}

/** Lever Postings API: `GET /v0/postings/{site}?mode=json`. */
export const lever: Adapter = (payload, feedUrl) =>
  mapEntries(z.array(z.unknown()).parse(payload), posting, feedUrl, (entry) => {
    const lists = entry.lists ?? [];
    const html = [
      entry.description,
      ...lists.map((list) => `<h3>${list.text ?? ""}</h3><ul>${list.content ?? ""}</ul>`),
      entry.additional,
    ]
      .filter(Boolean)
      .join("\n");
    const plain = [
      entry.descriptionPlain,
      ...lists.map((list) => `${list.text ?? ""}\n${htmlToText(`<ul>${list.content ?? ""}</ul>`)}`),
      entry.additionalPlain,
    ]
      .filter(Boolean)
      .join("\n\n");
    const locations = entry.categories?.allLocations?.filter(Boolean) ?? [];
    return compact({
      title: entry.text,
      url: entry.hostedUrl,
      location: locations.length > 1 ? locations.join("; ") : entry.categories?.location,
      employmentType: entry.categories?.commitment,
      remote: entry.workplaceType === "unspecified" ? null : entry.workplaceType,
      description: plain || (html ? htmlToText(html) : null),
      descriptionHtml: html || null,
      postedAt: entry.createdAt == null ? null : new Date(entry.createdAt).toISOString(),
      salaryText: salary(entry),
      team: entry.categories?.team,
      department: entry.categories?.department,
      sourceId: entry.id,
    });
  });
