import type { ApiJob, ApiRunJob } from "@jobtrace/api";
import { useState } from "react";
import { ago, salary, when } from "../lib/format.ts";
import { Badge, Dialog, Empty, Table, Td } from "../ui.tsx";

type Row = ApiJob & Partial<Pick<ApiRunJob, "isNew" | "isChanged">>;

export function JobFlags({ job }: { job: Row }) {
  return (
    <>
      {job.isNew && <Badge tone="green">New</Badge>}
      {job.isChanged && <Badge tone="amber">Changed</Badge>}
      {job.closedAt && <Badge>Closed</Badge>}
    </>
  );
}

export function JobDetails({ job }: { job: Row }) {
  const facts: Array<[string, string | null]> = [
    ["Company", job.company],
    ["Location", job.location],
    ["Work arrangement", job.remote === "unknown" ? null : job.remote],
    ["Employment", job.employmentType],
    ["Salary", salary(job) || null],
    ["Posted", job.postedAt ? when(job.postedAt) : null],
    ["First seen", when(job.firstSeenAt)],
    ["Last seen", when(job.lastSeenAt)],
    ["Closed", job.closedAt ? when(job.closedAt) : null],
    ...Object.entries(job.custom).map(([name, value]): [string, string | null] => [name, value]),
  ];
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap gap-2">
        <JobFlags job={job} />
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {facts
          .filter(([, value]) => value)
          .map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-zinc-500">{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {job.url && (
        <p>
          <a
            className="text-blue-600 underline dark:text-blue-400"
            href={job.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open the posting
          </a>
        </p>
      )}
      {job.description && (
        <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{job.description}</p>
      )}
    </div>
  );
}

/** A table of jobs; a row opens the job's details. */
export function JobsTable({ jobs, empty = "No jobs." }: { jobs: Row[]; empty?: string }) {
  const [open, setOpen] = useState<Row | null>(null);
  if (jobs.length === 0) return <Empty>{empty}</Empty>;
  return (
    <>
      <Table head={["Title", "Company", "Location", "Salary", "First seen"]}>
        {jobs.map((job) => (
          <tr key={job.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
            <Td>
              <button
                type="button"
                className="text-left font-medium text-blue-700 hover:underline dark:text-blue-400"
                onClick={() => setOpen(job)}
              >
                {job.title}
              </button>
              <span className="ml-2 inline-flex gap-1">
                <JobFlags job={job} />
              </span>
            </Td>
            <Td>{job.company}</Td>
            <Td>{job.location}</Td>
            <Td className="whitespace-nowrap">{salary(job)}</Td>
            <Td className="whitespace-nowrap text-zinc-500">{ago(job.firstSeenAt)}</Td>
          </tr>
        ))}
      </Table>
      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open?.title ?? ""} wide>
        {open && <JobDetails job={open} />}
      </Dialog>
    </>
  );
}
