import type { ApiEvent } from "@jobtrace/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api.ts";
import { JobsTable } from "../components/JobsTable.tsx";
import { describeLocator, timeline } from "../lib/definition.ts";
import { duration, plural, reasonText, when } from "../lib/format.ts";
import {
  Badge,
  Button,
  Card,
  cx,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  StatusBadge,
} from "../ui.tsx";

const ACTIVE = new Set(["queued", "running"]);

/**
 * The run's log, live. The stream first replays what is stored and then
 * follows the run, so the same code serves finished and running runs.
 */
function useRunLog(runId: string, onEnd: () => void) {
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [live, setLive] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: onEnd is a fresh closure each render; the stream follows the run id only
  useEffect(() => {
    setEvents([]);
    setLive(true);
    const source = new EventSource(api.runs.streamUrl(runId));
    source.addEventListener("log", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as ApiEvent;
      setEvents((current) => [...current, event]);
    });
    const finish = () => {
      source.close();
      setLive(false);
      onEnd();
    };
    source.addEventListener("end", finish);
    // A dropped connection: stop here rather than reconnect and replay; the stored log is the fallback.
    source.onerror = () => {
      source.close();
      setLive(false);
      void api.runs.events(runId).then(setEvents, () => {});
    };
    return () => source.close();
  }, [runId]);
  return { events, live };
}

const LEVEL_STYLES: Record<string, string> = {
  debug: "text-zinc-400",
  info: "",
  warn: "text-amber-700 dark:text-amber-400",
  error: "text-red-700 dark:text-red-400",
};

export function RunDetail() {
  const { id = "" } = useParams();
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.runs.get(id),
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.run.status) ? 1500 : false,
  });
  const recording = useQuery({
    queryKey: ["recording", detail.data?.run.recordingId],
    queryFn: () => api.recordings.get(detail.data?.run.recordingId ?? ""),
    enabled: Boolean(detail.data),
  });
  const { events, live } = useRunLog(id, () => {
    void client.invalidateQueries({ queryKey: ["run", id] });
    void client.invalidateQueries({ queryKey: ["runs"] });
    // Job counts and "last run" elsewhere are now out of date.
    void client.invalidateQueries({ queryKey: ["recording"] });
    void client.invalidateQueries({ queryKey: ["recordings"] });
    void client.invalidateQueries({ queryKey: ["jobs"] });
  });
  const cancel = useMutation({
    mutationFn: () => api.runs.cancel(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["run", id] }),
  });
  const finished = Boolean(detail.data && !ACTIVE.has(detail.data.run.status));
  const suggestions = useQuery({
    queryKey: ["run", id, "suggestions"],
    queryFn: () => api.runs.suggestions(id),
    enabled: finished,
  });
  const accept = useMutation({
    mutationFn: (index: number) => api.runs.acceptSuggestion(id, index),
    onSuccess: (next) => {
      client.setQueryData(["run", id, "suggestions"], next);
      void client.invalidateQueries({ queryKey: ["recording"] });
    },
  });
  const [verbose, setVerbose] = useState(false);
  const steps = useMemo(() => timeline(events), [events]);

  if (!detail.data) return detail.error ? <ErrorNote error={detail.error} /> : <Loading />;
  const { run, jobs, artifacts } = detail.data;
  const stats = run.stats;
  const shown = verbose ? events : events.filter((event) => event.level !== "debug");
  const screenshots = artifacts.filter((artifact) => artifact.type === "screenshot");
  const files = artifacts.filter((artifact) => artifact.type !== "screenshot");

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Run of {recording.data?.name ?? "…"} <StatusBadge status={run.status} />
          </span>
        }
        subtitle={
          <>
            {run.trigger === "manual"
              ? "Started by hand"
              : run.trigger === "schedule"
                ? "Scheduled"
                : "Started from the command line"}
            {run.startedAt && ` · ${when(run.startedAt)}`}
            {stats && ` · took ${duration(stats.durationMs)}`}
          </>
        }
        actions={
          <>
            <Link to={`/recordings/${run.recordingId}`}>
              <Button>Open recording</Button>
            </Link>
            {ACTIVE.has(run.status) && (
              <Button variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancel run
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-5">
        <ErrorNote error={cancel.error} />
        {run.status !== "succeeded" && !ACTIVE.has(run.status) && (run.reason || run.error) && (
          <div
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
          >
            <p className="font-medium">{reasonText(run.reason)}</p>
            {run.error && (
              <p className="mt-1">
                {run.error.message}
                {run.error.stepId && ` (step ${run.error.stepId})`}
              </p>
            )}
          </div>
        )}
        {stats && (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="run-stats">
            {[
              ["Jobs", stats.jobs],
              ["New", stats.newJobs],
              ["Changed", stats.changedJobs],
              ["Closed", stats.closedJobs],
              ["Pages", stats.pages],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <dt className="text-xs text-zinc-500">{label}</dt>
                <dd className="text-xl font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        )}

        <Card
          title={
            <span className="flex items-center gap-2">
              Log {live && <Badge tone="blue">Live</Badge>}
            </span>
          }
          actions={
            <label className="flex items-center gap-1.5 text-xs text-zinc-500">
              <input
                type="checkbox"
                checked={verbose}
                onChange={(event) => setVerbose(event.target.checked)}
              />
              Show every step
            </label>
          }
        >
          {shown.length === 0 ? (
            <Empty>{live ? "Waiting for the run to start…" : "Nothing was logged."}</Empty>
          ) : (
            <ol
              className="max-h-80 overflow-y-auto px-4 py-2 font-mono text-xs leading-5"
              aria-label="Run log"
              aria-live="polite"
            >
              {shown.map((event, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the log is append-only
                <li key={index} className={cx("flex gap-3", LEVEL_STYLES[event.level])}>
                  <span className="shrink-0 text-zinc-400">{event.ts.slice(11, 19)}</span>
                  {event.stepId && <span className="shrink-0 text-zinc-400">{event.stepId}</span>}
                  <span className="min-w-0 break-words">{event.message}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        {steps.length > 0 && (
          <Card title="Steps">
            <ol className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
              {steps.map((step) => (
                <li key={step.stepId} className="px-4 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-zinc-500">{step.stepId}</span>
                    {step.runs > 0 && <span>ran {plural(step.runs, "time")}</span>}
                    {step.errors.length > 0 ? (
                      <Badge tone="red">{plural(step.errors.length, "error")}</Badge>
                    ) : step.warnings.length > 0 ? (
                      <Badge tone="amber">{plural(step.warnings.length, "warning")}</Badge>
                    ) : (
                      <Badge tone="green">OK</Badge>
                    )}
                  </div>
                  {[...step.errors, ...step.warnings].slice(0, 3).map((message) => (
                    <p key={message} className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                      {message}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
          </Card>
        )}

        {suggestions.data && suggestions.data.length > 0 && (
          <Card title="Suggested locators">
            <p className="px-4 pt-3 text-xs text-zinc-500">
              These steps could not find their element with any recorded locator. The AI fallback
              found it another way, and the run went on with that. Accept a suggestion to make it
              the step's first locator; the old ones stay as fallbacks.
            </p>
            <ErrorNote error={accept.error} />
            <ul
              className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800"
              data-testid="suggestions"
            >
              {suggestions.data.map((suggestion) => (
                <li key={suggestion.index} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p>
                      <span className="font-mono text-xs text-zinc-500">{suggestion.stepId}</span>{" "}
                      <code className="break-all rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">
                        {describeLocator(suggestion.locator)}
                      </code>
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      Instead of {suggestion.failed.map(describeLocator).join(", ")}
                    </p>
                    {suggestion.reason && (
                      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                        {suggestion.reason}
                      </p>
                    )}
                  </div>
                  {suggestion.state === "open" ? (
                    <Button
                      disabled={accept.isPending}
                      onClick={() => accept.mutate(suggestion.index)}
                    >
                      Accept
                    </Button>
                  ) : suggestion.state === "applied" ? (
                    <Badge tone="green">In the recording</Badge>
                  ) : (
                    <Badge>Step changed since</Badge>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {artifacts.length > 0 && (
          <Card title="Screenshots and files">
            <div className="space-y-3 p-4">
              {screenshots.map((artifact) => (
                <a
                  key={artifact.id}
                  href={api.runs.artifactUrl(run.id, artifact.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={api.runs.artifactUrl(run.id, artifact.id)}
                    alt="The page when the run stopped"
                    className="max-h-96 rounded border border-zinc-200 dark:border-zinc-800"
                  />
                </a>
              ))}
              <ul className="space-y-1 text-sm">
                {files.map((artifact) => (
                  <li key={artifact.id}>
                    <a
                      className="text-blue-700 hover:underline dark:text-blue-400"
                      href={api.runs.artifactUrl(run.id, artifact.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {artifact.type === "trace"
                        ? "Playwright trace (open with: npx playwright show-trace <file>)"
                        : "Page source when the run stopped (as text)"}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        )}

        <Card title={`Jobs in this run (${jobs.length})`}>
          <JobsTable
            jobs={jobs}
            empty={
              ACTIVE.has(run.status)
                ? "Jobs appear here when the run finishes."
                : "This run found no jobs."
            }
          />
        </Card>
      </div>
    </>
  );
}
