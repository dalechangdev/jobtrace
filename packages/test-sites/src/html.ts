import { COMPANY, type FixtureJob } from "./data.ts";

/**
 * Class names used by the list and detail markup. Site 9 ("detail-v2") swaps in
 * generated-looking names while keeping structure and text identical, which is
 * what the locator-drift tests rely on.
 */
export interface ClassNames {
  list: string;
  item: string;
  title: string;
  meta: string;
  location: string;
  type: string;
  salary: string;
  posted: string;
  detailTitle: string;
  facts: string;
  body: string;
}

export const V1_CLASSES: ClassNames = {
  list: "jobs",
  item: "job",
  title: "title",
  meta: "meta",
  location: "loc",
  type: "type",
  salary: "salary",
  posted: "posted",
  detailTitle: "job-title",
  facts: "facts",
  body: "job-body",
};

export const V2_CLASSES: ClassNames = {
  list: "css-1q8x7fz",
  item: "css-9d2kq0",
  title: "css-k3v1ab",
  meta: "css-7hh2p9",
  location: "css-0zx81m",
  type: "css-5tt9we",
  salary: "css-u4n6c2",
  posted: "css-b81ls3",
  detailTitle: "css-m0p4rd",
  facts: "css-e7y2gg",
  body: "css-w9a3vn",
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STYLE = `
  body { font-family: system-ui, sans-serif; margin: 0; color: #1c1c1c; }
  header { padding: 12px 24px; background: #14213d; color: #fff; }
  header a { color: #fff; margin-right: 16px; }
  main { padding: 24px; max-width: 760px; }
  main ul { list-style: none; padding: 0; }
  main li { border: 1px solid #ddd; border-radius: 6px; padding: 12px 16px; margin-bottom: 12px; }
  main li p { margin: 4px 0; color: #555; }
  .tall li { min-height: 160px; box-sizing: border-box; }
  .pager { display: flex; gap: 12px; align-items: center; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
  dt { font-weight: 600; }
  dd { margin: 0; }
`;

export interface PageOptions {
  title: string;
  body: string;
  /** Extra markup appended to <head>, e.g. a client script tag. */
  head?: string;
}

export function page({ title, body, head = "" }: PageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
${head}
</head>
<body>
<header><a href="/">JobTrace test sites</a><strong>${escapeHtml(COMPANY)} Careers</strong></header>
<main>
${body}
</main>
</body>
</html>`;
}

export interface ListOptions {
  classes?: ClassNames;
  /** Returns the detail URL for a job; when omitted titles render as plain headings. */
  href?: (job: FixtureJob) => string;
  linkTarget?: string;
}

export function jobItem(job: FixtureJob, options: ListOptions = {}): string {
  const c = options.classes ?? V1_CLASSES;
  const target = options.linkTarget ? ` target="${options.linkTarget}"` : "";
  const title = options.href
    ? `<a class="${c.title}" href="${escapeHtml(options.href(job))}"${target}>${escapeHtml(job.title)}</a>`
    : `<h2 class="${c.title}">${escapeHtml(job.title)}</h2>`;
  return `<li class="${c.item}" data-job-id="${job.id}">
  ${title}
  <p class="${c.meta}"><span class="${c.location}">${escapeHtml(job.location)}</span> · <span class="${c.type}">${escapeHtml(job.employmentType)}</span></p>
  <p><span class="${c.salary}">${escapeHtml(job.salary)}</span></p>
  <p><time class="${c.posted}" datetime="${job.postedAt}">Posted ${job.postedAt}</time></p>
</li>`;
}

export function jobList(jobs: readonly FixtureJob[], options: ListOptions = {}): string {
  const c = options.classes ?? V1_CLASSES;
  return `<ul class="${c.list}" aria-label="Open positions">
${jobs.map((job) => jobItem(job, options)).join("\n")}
</ul>`;
}

export function jobDetail(job: FixtureJob, backHref: string, classes = V1_CLASSES): string {
  const c = classes;
  return `<h1 class="${c.detailTitle}">${escapeHtml(job.title)}</h1>
<dl class="${c.facts}">
  <dt>Location</dt><dd class="${c.location}">${escapeHtml(job.location)}</dd>
  <dt>Employment type</dt><dd class="${c.type}">${escapeHtml(job.employmentType)}</dd>
  <dt>Salary</dt><dd class="${c.salary}">${escapeHtml(job.salary)}</dd>
  <dt>Posted</dt><dd class="${c.posted}">${job.postedAt}</dd>
</dl>
<article class="${c.body}"><p>${escapeHtml(job.description)}</p></article>
<p><a href="${escapeHtml(backHref)}">Back to all jobs</a></p>`;
}
