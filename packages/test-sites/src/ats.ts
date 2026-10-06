import { COMPANY, type FixtureJob } from "./data.ts";

/**
 * Fixture feeds for the three ATS job-board APIs. The field names and nesting
 * follow the live responses of each API (checked October 2026); the content is
 * the usual fixture jobs. Point an API source's `baseUrl` at
 * `<origin>${ATS_PATHS[provider]}` to read them.
 */
export type AtsFixtureProvider = "greenhouse" | "lever" | "ashby";

export const ATS_PATHS: Record<AtsFixtureProvider, string> = {
  greenhouse: "/ats/greenhouse",
  lever: "/ats/lever",
  ashby: "/ats/ashby",
};

const DEPARTMENTS = ["Engineering", "Design", "Operations"];
const department = (job: FixtureJob) => DEPARTMENTS[Number(job.id) % DEPARTMENTS.length] as string;
const uuid = (job: FixtureJob) => `00000000-0000-4000-8000-000000000${job.id}`;

/** Lower and upper amount, currency and pay period of a fixture salary such as "$140k - $180k / year". */
function pay(job: FixtureJob) {
  const amounts = [...job.salary.matchAll(/(\d[\d,]*)(k)?/g)].map(
    (match) => Number((match[1] as string).replaceAll(",", "")) * (match[2] ? 1000 : 1),
  );
  const currency = job.salary.includes("€") ? "EUR" : job.salary.includes("£") ? "GBP" : "USD";
  return {
    min: amounts[0] as number,
    max: amounts[1] ?? (amounts[0] as number),
    currency,
    period: job.salary.includes("hour") ? "hour" : "year",
  };
}

const workplace = (job: FixtureJob) =>
  /remote/i.test(job.location) ? "remote" : /hybrid/i.test(job.location) ? "hybrid" : "onsite";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function greenhouseJob(job: FixtureJob) {
  const range = pay(job);
  const html = `<div class="content-intro"><p>${job.description}</p></div><ul><li>${job.employmentType}</li></ul>`;
  return {
    absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${job.id}`,
    data_compliance: [{ type: "gdpr", requires_consent: false, retention_period: null }],
    internal_job_id: Number(job.id) + 5000,
    location: { name: job.location },
    metadata: [
      { id: 1, name: "Employment Type", value: job.employmentType, value_type: "single_select" },
    ],
    id: Number(job.id),
    updated_at: `${job.postedAt}T10:38:50-04:00`,
    requisition_id: `R-${job.id}`,
    title: job.title,
    pay_input_ranges: [
      {
        min_cents: range.min * 100,
        max_cents: range.max * 100,
        currency_type: range.currency,
        title: "Salary Range",
        blurb: "<p><em>The base salary range for this role.</em></p>",
      },
    ],
    company_name: COMPANY,
    first_published: `${job.postedAt}T09:00:00-04:00`,
    language: "en",
    application_deadline: null,
    // Greenhouse delivers the description as entity-escaped HTML.
    content: escapeHtml(html),
    departments: [{ id: 10, name: department(job), child_ids: [], parent_id: null }],
    offices: [],
  };
}

function leverPosting(job: FixtureJob) {
  const range = pay(job);
  return {
    additionalPlain: `${COMPANY} is an equal opportunity employer.`,
    additional: `<div>${COMPANY} is an equal opportunity employer.</div>`,
    categories: {
      commitment: job.employmentType,
      location: job.location,
      team: department(job),
      allLocations: [job.location],
    },
    createdAt: Date.parse(`${job.postedAt}T09:00:00Z`),
    descriptionPlain: job.description,
    description: `<div>${job.description}</div>`,
    id: uuid(job),
    lists: [{ text: "Requirements", content: "<li>Curiosity</li><li>Care for detail</li>" }],
    text: job.title,
    country: "DE",
    workplaceType: workplace(job),
    salaryRange: {
      min: range.min,
      max: range.max,
      currency: range.currency,
      interval: `per-${range.period}-salary`,
    },
    hostedUrl: `https://jobs.lever.co/acme/${uuid(job)}`,
    applyUrl: `https://jobs.lever.co/acme/${uuid(job)}/apply`,
  };
}

function ashbyJob(job: FixtureJob) {
  const type = workplace(job);
  return {
    id: uuid(job),
    title: job.title,
    department: department(job),
    team: `${department(job)} Team`,
    employmentType: job.employmentType.replace(/-(\w)/, (_match, letter: string) =>
      letter.toUpperCase(),
    ),
    location: job.location,
    shouldDisplayCompensationOnJobPostings: true,
    secondaryLocations: [],
    publishedAt: `${job.postedAt}T09:00:00.000+00:00`,
    isListed: true,
    isRemote: type === "remote",
    workplaceType: type === "remote" ? "Remote" : type === "hybrid" ? "Hybrid" : "OnSite",
    address: {
      postalAddress: { addressLocality: job.location, addressRegion: "", addressCountry: "" },
    },
    jobUrl: `https://jobs.ashbyhq.com/acme/${uuid(job)}`,
    applyUrl: `https://jobs.ashbyhq.com/acme/${uuid(job)}/application`,
    descriptionHtml: `<p>${job.description}</p>`,
    descriptionPlain: job.description,
    compensation: {
      compensationTierSummary: `${job.salary} • Offers Equity`,
      scrapeableCompensationSalarySummary: job.salary,
      compensationTiers: [],
      summaryComponents: [],
    },
  };
}

export function atsFeed(
  provider: AtsFixtureProvider,
  jobs: readonly FixtureJob[],
  options: { malformedEntry?: boolean } = {},
): unknown {
  // An entry without a title, as a feed might contain after an API change.
  const malformed = options.malformedEntry ? [{ id: 999, location: { name: "Nowhere" } }] : [];
  if (provider === "greenhouse") {
    return {
      jobs: [...jobs.map(greenhouseJob), ...malformed],
      meta: { total: jobs.length + malformed.length },
    };
  }
  if (provider === "lever") return [...jobs.map(leverPosting), ...malformed];
  return {
    apiVersion: "1",
    jobs: [
      ...jobs.map(ashbyJob),
      // Ashby also returns postings that are not listed on the board.
      {
        ...ashbyJob(jobs[0] as FixtureJob),
        id: "unlisted",
        title: "Unlisted role",
        isListed: false,
      },
      ...malformed,
    ],
  };
}
