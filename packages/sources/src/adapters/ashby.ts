import { htmlToText } from "@jobtrace/extractor";
import { z } from "zod";
import { type Adapter, compact, mapEntries, text } from "./types.ts";

const job = z.object({
  id: text,
  title: z.string().min(1),
  jobUrl: text,
  location: text,
  secondaryLocations: z.array(z.object({ location: text })).nullish(),
  department: text,
  team: text,
  /** FullTime | PartTime | Intern | Contract | Temporary */
  employmentType: text,
  /** Remote | Hybrid | OnSite */
  workplaceType: text,
  isRemote: z.boolean().nullish(),
  isListed: z.boolean().nullish(),
  publishedAt: text,
  descriptionHtml: text,
  descriptionPlain: text,
  compensation: z
    .object({
      scrapeableCompensationSalarySummary: text,
      compensationTierSummary: text,
    })
    .nullish(),
});

const feed = z.object({ jobs: z.array(z.unknown()) });

/** "FullTime" -> "Full-time". */
const spaced = (value: string | null) =>
  value
    ? value.replace(/([a-z])([A-Z])/g, (_match, a: string, b: string) => `${a}-${b.toLowerCase()}`)
    : null;

/** Ashby Job Postings API: `GET /posting-api/job-board/{name}?includeCompensation=true`. */
export const ashby: Adapter = (payload, feedUrl) =>
  mapEntries(feed.parse(payload).jobs, job, feedUrl, (entry) => {
    // Unlisted postings are reachable by link only and are not part of the board.
    if (entry.isListed === false) return null;
    const locations = [
      entry.location,
      ...(entry.secondaryLocations ?? []).map((other) => other.location),
    ].filter(Boolean);
    return compact({
      title: entry.title,
      url: entry.jobUrl,
      location: locations.join("; "),
      employmentType: spaced(entry.employmentType),
      remote:
        entry.workplaceType === "OnSite"
          ? "on-site"
          : (entry.workplaceType ?? (entry.isRemote ? "remote" : null)),
      description:
        entry.descriptionPlain ??
        (entry.descriptionHtml ? htmlToText(entry.descriptionHtml) : null),
      descriptionHtml: entry.descriptionHtml,
      postedAt: entry.publishedAt,
      salaryText:
        entry.compensation?.scrapeableCompensationSalarySummary ??
        entry.compensation?.compensationTierSummary,
      department: entry.department,
      team: entry.team,
      sourceId: entry.id,
    });
  });
