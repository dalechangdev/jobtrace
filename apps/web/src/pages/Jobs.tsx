import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, type JobSearch } from "../api.ts";
import { JobsTable } from "../components/JobsTable.tsx";
import { Button, Card, ErrorNote, Input, Loading, PageHeader, Select } from "../ui.tsx";

const PAGE_SIZE = 50;
/** A date input's value (local day) as the ISO instant where that day starts, or ends when `end`. */
const dayToIso = (day: string, end = false) => {
  const date = new Date(`${day}T00:00:00`);
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
};

export function Jobs() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get("q") ?? "");
  const recordings = useQuery({ queryKey: ["recordings"], queryFn: api.recordings.list });

  const set = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!("page" in changes)) next.delete("page");
    setParams(next, { replace: true });
  };
  // Search as the user types, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (text !== (params.get("q") ?? "")) set({ q: text });
    }, 300);
    return () => clearTimeout(timer);
  });

  const page = Number(params.get("page") ?? 1) || 1;
  const fromDay = params.get("fromDay") ?? "";
  const toDay = params.get("toDay") ?? "";
  const search: JobSearch = {
    q: params.get("q") ?? "",
    recording: params.get("recording") ?? "",
    remote: params.get("remote") ?? "",
    new: params.get("new") === "1",
    closed: params.get("closed") === "1",
    // `from` arrives as a full timestamp from the dashboard's "see all" link.
    from: fromDay ? dayToIso(fromDay) : (params.get("from") ?? ""),
    to: toDay ? dayToIso(toDay, true) : "",
    page,
    pageSize: PAGE_SIZE,
  };
  const jobs = useQuery({
    queryKey: ["jobs", search],
    queryFn: () => api.jobs.list(search),
    placeholderData: (previous) => previous,
  });
  const pages = jobs.data ? Math.max(1, Math.ceil(jobs.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle={
          jobs.data ? `${jobs.data.total} job${jobs.data.total === 1 ? "" : "s"} match` : undefined
        }
        actions={
          <>
            <a href={api.jobs.exportUrl(search, "csv")} download>
              <Button>Export CSV</Button>
            </a>
            <a href={api.jobs.exportUrl(search, "json")} download>
              <Button>Export JSON</Button>
            </a>
          </>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          type="search"
          aria-label="Search jobs"
          placeholder="Search title, company, location, description"
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="sm:col-span-2"
        />
        <Select
          aria-label="Recording"
          value={search.recording}
          onChange={(event) => set({ recording: event.target.value })}
        >
          <option value="">All recordings</option>
          {recordings.data?.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Work arrangement"
          value={search.remote}
          onChange={(event) => set({ remote: event.target.value })}
        >
          <option value="">Any work arrangement</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="onsite">On-site</option>
          <option value="unknown">Not stated</option>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-500">First seen from</span>
          <Input
            type="date"
            value={fromDay}
            onChange={(event) => set({ fromDay: event.target.value, from: "" })}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-500">to</span>
          <Input
            type="date"
            value={toDay}
            onChange={(event) => set({ toDay: event.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Input
            type="checkbox"
            checked={search.new ?? false}
            onChange={(event) => set({ new: event.target.checked ? "1" : "" })}
          />
          New in the latest run
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Input
            type="checkbox"
            checked={search.closed ?? false}
            onChange={(event) => set({ closed: event.target.checked ? "1" : "" })}
          />
          Include closed jobs
        </label>
      </div>
      <ErrorNote error={jobs.error} />
      <Card>
        {jobs.data ? <JobsTable jobs={jobs.data.items} empty="No jobs match." /> : <Loading />}
      </Card>
      {pages > 1 && (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-center gap-3 text-sm">
          <Button disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>
            Previous
          </Button>
          <span>
            Page {page} of {pages}
          </span>
          <Button disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>
            Next
          </Button>
        </nav>
      )}
    </>
  );
}
