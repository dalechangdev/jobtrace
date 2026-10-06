import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api.ts";
import { RunsTable } from "../components/RunsTable.tsx";
import { Card, ErrorNote, Loading, PageHeader, Select } from "../ui.tsx";

const STATUSES = ["queued", "running", "succeeded", "partial", "failed", "blocked", "cancelled"];

export function Runs() {
  const [params, setParams] = useSearchParams();
  const recording = params.get("recording") ?? "";
  const status = params.get("status") ?? "";
  const recordings = useQuery({ queryKey: ["recordings"], queryFn: api.recordings.list });
  const runs = useQuery({
    queryKey: ["runs", { recording, status }],
    queryFn: () =>
      api.runs.list({
        limit: 100,
        ...(recording ? { recording } : {}),
        ...(status ? { status } : {}),
      }),
    refetchInterval: 4000,
  });
  const names = useMemo(
    () => new Map((recordings.data ?? []).map((item) => [item.id, item.name])),
    [recordings.data],
  );
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title="Runs" subtitle="Every time a recording or feed was run, newest first." />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select
          aria-label="Recording"
          className="max-w-xs"
          value={recording}
          onChange={(event) => set("recording", event.target.value)}
        >
          <option value="">All recordings</option>
          {recordings.data?.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Status"
          className="max-w-[12rem]"
          value={status}
          onChange={(event) => set("status", event.target.value)}
        >
          <option value="">Any status</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </div>
      <ErrorNote error={runs.error} />
      <Card>
        {runs.data ? (
          <RunsTable runs={runs.data} names={names} empty="No runs match." />
        ) : (
          <Loading />
        )}
      </Card>
    </>
  );
}
