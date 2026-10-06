import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { JobsTable } from "../components/JobsTable.tsx";
import { RunsTable } from "../components/RunsTable.tsx";
import { ago } from "../lib/format.ts";
import { Button, Card, ErrorNote, Loading, PageHeader } from "../ui.tsx";

const SEEN_KEY = "jobtrace.jobsSeenAt";

function readSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

export function Dashboard() {
  const [seenAt, setSeenAt] = useState(readSeen);
  const recordings = useQuery({ queryKey: ["recordings"], queryFn: api.recordings.list });
  const runs = useQuery({
    queryKey: ["runs", { limit: 8 }],
    queryFn: () => api.runs.list({ limit: 8 }),
    refetchInterval: 5000,
  });
  const fresh = useQuery({
    queryKey: ["jobs", { from: seenAt }],
    queryFn: () => api.jobs.list({ from: seenAt, pageSize: 25 }),
    refetchInterval: 10_000,
  });
  const names = useMemo(
    () => new Map((recordings.data ?? []).map((item) => [item.id, item.name])),
    [recordings.data],
  );

  const markSeen = () => {
    const now = new Date().toISOString();
    localStorage.setItem(SEEN_KEY, now);
    setSeenAt(now);
  };
  const since = seenAt.startsWith("1970") ? "so far" : `since ${ago(seenAt)}`;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={
          recordings.data
            ? `${recordings.data.length} recording${recordings.data.length === 1 ? "" : "s"} and feeds`
            : undefined
        }
        actions={
          <Link to="/recordings">
            <Button variant="primary">Add a job board</Button>
          </Link>
        }
      />
      <div className="space-y-5">
        <ErrorNote error={recordings.error ?? runs.error ?? fresh.error} />
        <Card
          title={`New jobs ${since}${fresh.data ? ` (${fresh.data.total})` : ""}`}
          actions={
            fresh.data && fresh.data.total > 0 ? (
              <Button size="sm" onClick={markSeen}>
                Mark all as seen
              </Button>
            ) : undefined
          }
        >
          {fresh.data ? (
            <JobsTable
              jobs={fresh.data.items}
              empty="Nothing new. Jobs found by future runs appear here."
            />
          ) : (
            <Loading />
          )}
          {fresh.data && fresh.data.total > fresh.data.items.length && (
            <p className="border-t border-zinc-100 px-4 py-2 text-sm dark:border-zinc-800">
              <Link
                className="text-blue-700 hover:underline dark:text-blue-400"
                to={`/jobs?from=${encodeURIComponent(seenAt)}`}
              >
                See all {fresh.data.total}
              </Link>
            </p>
          )}
        </Card>
        <Card
          title="Recent runs"
          actions={
            <Link className="text-sm text-blue-700 hover:underline dark:text-blue-400" to="/runs">
              All runs
            </Link>
          }
        >
          {runs.data ? (
            <RunsTable
              runs={runs.data}
              names={names}
              empty="No runs yet. Open a recording and press Run now."
            />
          ) : (
            <Loading />
          )}
        </Card>
      </div>
    </>
  );
}
