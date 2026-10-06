import type { ApiSource, Recording } from "@jobtrace/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, type Definition } from "../api.ts";
import { RunsTable } from "../components/RunsTable.tsx";
import { StepList } from "../components/StepTree.tsx";
import { draftProblems, isSource } from "../lib/definition.ts";
import { when } from "../lib/format.ts";
import { Button, Card, ErrorNote, Field, Input, Loading, Note, PageHeader } from "../ui.tsx";

type Draft = Recording | ApiSource;

function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}

function RecordingSettings({
  draft,
  onChange,
}: {
  draft: Recording;
  onChange: (next: Recording) => void;
}) {
  const set = (patch: Partial<Recording["settings"]>) =>
    onChange({ ...draft, settings: { ...draft.settings, ...patch } });
  const params = Object.entries(draft.params);
  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField
          label="Most pages to visit"
          value={draft.settings.maxPages}
          onChange={(maxPages) => set({ maxPages })}
        />
        <NumberField
          label="Most jobs to read"
          value={draft.settings.maxItems}
          onChange={(maxItems) => set({ maxItems })}
        />
        <NumberField
          label="Give up on a step after (ms)"
          value={draft.settings.stepTimeoutMs}
          onChange={(stepTimeoutMs) => set({ stepTimeoutMs })}
        />
        <NumberField
          label="Shortest pause between actions (ms)"
          value={draft.settings.minDelayMs}
          onChange={(minDelayMs) => set({ minDelayMs })}
        />
        <NumberField
          label="Longest pause between actions (ms)"
          value={draft.settings.maxDelayMs}
          onChange={(maxDelayMs) => set({ maxDelayMs })}
        />
        <Field label="Company" hint="Used when the page does not name it.">
          <Input
            value={draft.settings.company ?? ""}
            onChange={(event) => set({ company: event.target.value || undefined })}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Input
          type="checkbox"
          checked={draft.settings.respectRobotsTxt}
          onChange={(event) => set({ respectRobotsTxt: event.target.checked })}
        />
        Respect the site's robots.txt
      </label>
      {!draft.settings.respectRobotsTxt && (
        <Note tone="amber">
          With this off, runs visit pages the site has asked automated visitors to stay away from.
          That is your decision to make and to answer for.
        </Note>
      )}
      {params.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">Parameters</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {params.map(([name, spec]) => (
              <Field key={name} label={name} hint="Default value; a run can override it.">
                <Input
                  value={spec.default ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      params: { ...draft.params, [name]: { default: event.target.value } },
                    })
                  }
                />
              </Field>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SourceSettings({
  draft,
  onChange,
}: {
  draft: ApiSource;
  onChange: (next: ApiSource) => void;
}) {
  const set = (patch: Partial<ApiSource["settings"]>) =>
    onChange({ ...draft, settings: { ...draft.settings, ...patch } });
  return (
    <div className="space-y-4 p-4">
      <p className="text-sm text-zinc-500">
        Reads the public {draft.provider} feed of the board <code>{draft.boardToken}</code>. There
        are no steps to record or edit.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company" hint="Used when the feed does not name it.">
          <Input
            value={draft.settings.company ?? ""}
            onChange={(event) => set({ company: event.target.value || undefined })}
          />
        </Field>
        <NumberField
          label="Most jobs to read"
          value={draft.settings.maxItems}
          onChange={(maxItems) => set({ maxItems })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Input
          type="checkbox"
          checked={draft.settings.respectRobotsTxt}
          onChange={(event) => set({ respectRobotsTxt: event.target.checked })}
        />
        Respect the service's robots.txt
      </label>
    </div>
  );
}

export function RecordingDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ["recording", id], queryFn: () => api.recordings.get(id) });
  const versions = useQuery({
    queryKey: ["versions", id],
    queryFn: () => api.recordings.versions(id),
  });
  const runs = useQuery({
    queryKey: ["runs", { recording: id }],
    queryFn: () => api.runs.list({ recording: id, limit: 10 }),
    refetchInterval: 5000,
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedVersion, setSavedVersion] = useState("");
  const [json, setJson] = useState<string | null>(null);
  // Load the server's copy when it changes (first load, after a save), never over unsaved edits.
  useEffect(() => {
    if (detail.data && detail.data.versionId !== savedVersion) {
      setDraft(detail.data.definition as unknown as Draft);
      setSavedVersion(detail.data.versionId);
      setJson(null);
    }
  }, [detail.data, savedVersion]);

  const dirty = useMemo(
    () =>
      draft !== null &&
      detail.data !== undefined &&
      JSON.stringify(draft) !== JSON.stringify(detail.data.definition),
    [draft, detail.data],
  );
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["recording", id] }),
      client.invalidateQueries({ queryKey: ["versions", id] }),
      client.invalidateQueries({ queryKey: ["recordings"] }),
    ]);
  const save = useMutation({
    mutationFn: (definition: Draft) =>
      api.recordings.update(id, definition as unknown as Definition),
    onSuccess: (saved) => {
      client.setQueryData(["recording", id], saved);
      return refresh();
    },
  });
  const run = useMutation({
    mutationFn: (headed: boolean) => api.recordings.run(id, headed ? { headed: true } : {}),
    onSuccess: (queued) => navigate(`/runs/${queued.id}`),
  });
  const remove = useMutation({
    mutationFn: () => api.recordings.remove(id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["recordings"] });
      navigate("/recordings");
    },
  });
  const restore = useMutation({
    mutationFn: (versionId: string) => api.recordings.version(id, versionId),
    onSuccess: (definition) => setDraft(definition as unknown as Draft),
  });

  if (!detail.data || !draft)
    return detail.error ? <ErrorNote error={detail.error} /> : <Loading />;
  const source = isSource(draft);
  const problems = source
    ? draft.name.trim()
      ? []
      : ["The feed needs a name."]
    : draftProblems(draft);
  const applyJson = () => {
    try {
      setDraft(JSON.parse(json ?? "") as Draft);
      setJson(null);
    } catch {
      window.alert("That is not valid JSON.");
    }
  };
  const exportHref = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(detail.data.definition, null, 2))}`;

  return (
    <>
      <PageHeader
        title={detail.data.name}
        subtitle={`${source ? "Feed" : "Recording"} · ${detail.data.domain} · ${detail.data.openJobs} open jobs`}
        actions={
          <>
            <Button
              variant="primary"
              disabled={dirty || run.isPending}
              title={dirty ? "Save your changes first" : undefined}
              onClick={() => run.mutate(false)}
            >
              Run now
            </Button>
            {!source && (
              <Button
                disabled={dirty || run.isPending}
                title="Run with a visible browser window on the server's computer"
                onClick={() => run.mutate(true)}
              >
                Run headed
              </Button>
            )}
            <a
              href={exportHref}
              download={`${detail.data.name.replace(/[^\w-]+/g, "-").toLowerCase()}.jobtrace.json`}
            >
              <Button>Export</Button>
            </a>
            <Button
              variant="danger"
              onClick={() => {
                if (
                  window.confirm(
                    `Delete "${detail.data.name}" with all its runs and jobs? This cannot be undone.`,
                  )
                )
                  remove.mutate();
              }}
            >
              Delete
            </Button>
          </>
        }
      />
      <div className="space-y-5">
        <ErrorNote error={run.error ?? remove.error ?? restore.error} />

        <Card
          title="Name and settings"
          actions={
            <>
              {dirty && (
                <span className="text-xs text-amber-700 dark:text-amber-400">Unsaved changes</span>
              )}
              <Button
                size="sm"
                disabled={!dirty}
                onClick={() => setDraft(detail.data.definition as unknown as Draft)}
              >
                Discard
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!dirty || problems.length > 0 || save.isPending}
                onClick={() => save.mutate(draft)}
              >
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
            </>
          }
        >
          <div className="space-y-3 border-b border-zinc-200 p-4 dark:border-zinc-800">
            <Field label="Name">
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            {problems.map((problem) => (
              <p key={problem} role="alert" className="text-sm text-red-700 dark:text-red-400">
                {problem}
              </p>
            ))}
            <ErrorNote error={save.error} />
          </div>
          {source ? (
            <SourceSettings draft={draft} onChange={setDraft} />
          ) : (
            <RecordingSettings draft={draft} onChange={setDraft} />
          )}
        </Card>

        {!source && (
          <Card
            title="Steps"
            actions={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setJson(json === null ? JSON.stringify(draft, null, 2) : null)}
              >
                {json === null ? "Edit as JSON" : "Back to the step view"}
              </Button>
            }
          >
            <div className="p-4">
              {json === null ? (
                <StepList
                  steps={draft.steps}
                  editing={{ recording: draft, onChange: setDraft, dirty }}
                />
              ) : (
                <div className="space-y-2">
                  <textarea
                    aria-label="Recording as JSON"
                    rows={24}
                    className="w-full rounded-md border border-zinc-300 bg-white p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
                    value={json}
                    onChange={(event) => setJson(event.target.value)}
                  />
                  <Button size="sm" onClick={applyJson}>
                    Apply
                  </Button>
                </div>
              )}
            </div>
          </Card>
        )}

        <Card title="Recent runs">
          {runs.data ? (
            <RunsTable runs={runs.data} empty="Not run yet. Press Run now." />
          ) : (
            <Loading />
          )}
        </Card>

        <Card title="Version history">
          {versions.data ? (
            <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
              {versions.data.map((version, index) => (
                <li key={version.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span>
                    {when(version.createdAt)}
                    {version.note && <span className="ml-2 text-zinc-500">{version.note}</span>}
                    {index === 0 && <span className="ml-2 text-zinc-500">(current)</span>}
                  </span>
                  {index > 0 && (
                    <Button
                      size="sm"
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(version.id)}
                    >
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Loading />
          )}
          <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
            Restoring loads that version here as unsaved changes; press Save changes to make it
            current.
          </p>
        </Card>
      </div>
    </>
  );
}
