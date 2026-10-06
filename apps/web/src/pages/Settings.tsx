import type { RuntimeSettings } from "@jobtrace/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { Button, Card, ErrorNote, Field, Input, Loading, Note, PageHeader } from "../ui.tsx";

export function Settings() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings.get });
  const [draft, setDraft] = useState<RuntimeSettings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data && !draft) {
      const {
        aiFallbackKeyConfigured: _key,
        dataDir: _dir,
        local: _local,
        ...editable
      } = settings.data;
      setDraft(editable);
    }
  }, [settings.data, draft]);
  const save = useMutation({
    mutationFn: (values: RuntimeSettings) => api.settings.update(values),
    onSuccess: (next) => {
      client.setQueryData(["settings"], next);
      setSaved(true);
    },
  });
  if (!settings.data || !draft)
    return settings.error ? <ErrorNote error={settings.error} /> : <Loading />;

  const number = (key: keyof RuntimeSettings, min: number) => ({
    type: "number" as const,
    min,
    required: true,
    value: draft[key] as number,
    onChange: (event: { target: { value: string } }) => {
      setSaved(false);
      setDraft({ ...draft, [key]: Number(event.target.value) });
    },
  });

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="These take effect at once and are remembered across restarts."
      />
      <form
        className="max-w-xl space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(draft);
        }}
      >
        <Card title="Running">
          <div className="space-y-4 p-4">
            <Field
              label="Runs at the same time"
              hint="Two runs never visit the same site at once, whatever this is set to."
            >
              <Input {...number("maxConcurrentRuns", 1)} max={10} />
            </Field>
            <Field label="Keep screenshots and traces for the newest … runs of each recording">
              <Input {...number("artifactRetentionRuns", 1)} />
            </Field>
          </div>
        </Card>
        <Card title="Politeness for new recordings">
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Shortest pause between actions (ms)">
              <Input {...number("defaultMinDelayMs", 0)} />
            </Field>
            <Field label="Longest pause between actions (ms)">
              <Input {...number("defaultMaxDelayMs", 0)} />
            </Field>
            <p className="text-xs text-zinc-500 sm:col-span-2">
              Runs wait a random time in this range between actions. Each recording keeps its own
              values, which you can change on its page.
            </p>
          </div>
        </Card>
        <Card title="AI locator fallback">
          <div className="space-y-3 p-4">
            <label className="flex items-center gap-2 text-sm">
              <Input
                type="checkbox"
                checked={draft.aiFallbackEnabled}
                onChange={(event) => {
                  setSaved(false);
                  setDraft({ ...draft, aiFallbackEnabled: event.target.checked });
                }}
              />
              Allow asking an AI model to find an element when every recorded locator fails
            </label>
            <p className="text-xs text-zinc-500">
              Not available yet in this version. When it is, it sends a trimmed copy of the page (no
              form values, no cookies) to the Claude API. The API key is read from the server's
              environment and is{" "}
              {settings.data.aiFallbackKeyConfigured ? "configured" : "not configured"}.
            </p>
          </div>
        </Card>
        <p className="text-xs text-zinc-500">Data is stored in {settings.data.dataDir}.</p>
        <ErrorNote error={save.error} />
        {saved && <Note>Saved.</Note>}
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save settings
        </Button>
      </form>
    </>
  );
}
