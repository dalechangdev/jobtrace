import type { ApiSession } from "@jobtrace/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api.ts";
import { SessionPanel } from "../components/SessionPanel.tsx";
import { ago, reasonText } from "../lib/format.ts";
import {
  Button,
  Card,
  Dialog,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Note,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  Td,
} from "../ui.tsx";

type Open = "record" | "source" | "import" | null;

function RecordForm({ onStarted }: { onStarted: (session: ApiSession) => void }) {
  const profiles = useQuery({ queryKey: ["auth-profiles"], queryFn: api.auth.list });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings.get });
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [authProfileId, setAuthProfileId] = useState("");
  const start = useMutation({
    mutationFn: () =>
      api.recordings.record({
        url,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(authProfileId ? { authProfileId } : {}),
      }),
    onSuccess: onStarted,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    start.mutate();
  };
  return (
    <form className="space-y-3" onSubmit={submit}>
      {settings.data && !settings.data.local && (
        <Note tone="amber">
          This server is not running on your own computer, so it cannot open a recorder window for
          you. Record with the jobtrace command line instead.
        </Note>
      )}
      <Field label="Career page address" hint="The page that lists the jobs.">
        <Input
          type="url"
          required
          placeholder="https://careers.example.com/jobs"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>
      <Field label="Name" hint="Optional. Defaults to the page's title.">
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      {(profiles.data?.length ?? 0) > 0 && (
        <Field label="Saved login" hint="For boards behind a sign-in.">
          <Select value={authProfileId} onChange={(event) => setAuthProfileId(event.target.value)}>
            <option value="">None</option>
            {profiles.data?.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} ({profile.domain})
              </option>
            ))}
          </Select>
        </Field>
      )}
      <ErrorNote error={start.error} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={start.isPending}>
          {start.isPending ? "Opening the browser…" : "Start recording"}
        </Button>
      </div>
    </form>
  );
}

function SourceForm({ onAdded }: { onAdded: (id: string) => void }) {
  const [provider, setProvider] = useState("greenhouse");
  const [boardToken, setBoardToken] = useState("");
  const [company, setCompany] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api.recordings.addSource({
        provider,
        boardToken: boardToken.trim(),
        ...(company.trim() ? { company: company.trim() } : {}),
      }),
    onSuccess: (created) => onAdded(created.id),
  });
  const hosts: Record<string, string> = {
    greenhouse: "job-boards.greenhouse.io/",
    lever: "jobs.lever.co/",
    ashby: "jobs.ashbyhq.com/",
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <p className="text-sm text-zinc-500">
        For boards hosted on Greenhouse, Lever or Ashby, JobTrace reads the board's public feed
        directly. No recording needed.
      </p>
      <Field label="Service">
        <Select value={provider} onChange={(event) => setProvider(event.target.value)}>
          <option value="greenhouse">Greenhouse</option>
          <option value="lever">Lever</option>
          <option value="ashby">Ashby</option>
        </Select>
      </Field>
      <Field
        label="Board name"
        hint={`The last part of the board's address: ${hosts[provider]}<board name>`}
      >
        <Input
          required
          pattern="[A-Za-z0-9._-]+"
          value={boardToken}
          onChange={(event) => setBoardToken(event.target.value)}
        />
      </Field>
      <Field
        label="Company"
        hint={
          provider === "greenhouse"
            ? "Optional."
            : "This service's feed does not name the company, so enter it here."
        }
      >
        <Input value={company} onChange={(event) => setCompany(event.target.value)} />
      </Field>
      <ErrorNote error={add.error} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {add.isPending ? "Checking the board…" : "Add feed"}
        </Button>
      </div>
    </form>
  );
}

function ImportForm({ onImported }: { onImported: (id: string) => void }) {
  const [text, setText] = useState("");
  const create = useMutation({
    mutationFn: async () => {
      let definition: unknown;
      try {
        definition = JSON.parse(text);
      } catch {
        throw new Error("That is not valid JSON.");
      }
      return api.recordings.create(definition as Record<string, unknown>);
    },
    onSuccess: (created) => onImported(created.id),
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <Field
        label="Recording file contents"
        hint="Paste the contents of a .jobtrace.json file, or choose one."
      >
        <textarea
          required
          rows={10}
          className="w-full rounded-md border border-zinc-300 bg-white p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <input
        type="file"
        accept=".json,application/json"
        aria-label="Recording file"
        className="text-sm"
        onChange={(event) => void event.target.files?.[0]?.text().then(setText)}
      />
      <ErrorNote error={create.error} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          Import
        </Button>
      </div>
    </form>
  );
}

export function Recordings() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const recordings = useQuery({
    queryKey: ["recordings"],
    queryFn: api.recordings.list,
    refetchInterval: 10_000,
  });
  const [open, setOpen] = useState<Open>(null);
  const [session, setSession] = useState<ApiSession | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const created = (id: string) => {
    setOpen(null);
    void client.invalidateQueries({ queryKey: ["recordings"] });
    navigate(`/recordings/${id}`);
  };
  const sessionDone = (finished: ApiSession) => {
    setSession(null);
    setOpen(null);
    if (finished.status === "finished" && finished.resultId) return created(finished.resultId);
    setNotice(finished.error ?? "The recording window was closed without saving.");
  };

  return (
    <>
      <PageHeader
        title="Recordings"
        subtitle="Job boards JobTrace knows how to read: recorded in a browser, or read from a public feed."
        actions={
          <>
            <Button onClick={() => setOpen("import")}>Import</Button>
            <Button onClick={() => setOpen("source")}>Add a feed</Button>
            <Button variant="primary" onClick={() => setOpen("record")}>
              New recording
            </Button>
          </>
        }
      />
      {notice && (
        <div className="mb-4">
          <Note tone="amber">{notice}</Note>
        </div>
      )}
      <ErrorNote error={recordings.error} />
      <Card>
        {!recordings.data ? (
          <Loading />
        ) : recordings.data.length === 0 ? (
          <Empty>
            No job boards yet. Record one in a browser, or add a Greenhouse, Lever or Ashby feed.
          </Empty>
        ) : (
          <Table head={["Name", "Type", "Site", "Open jobs", "Last run"]}>
            {recordings.data.map((recording) => (
              <tr key={recording.id}>
                <Td>
                  <Link
                    className="font-medium text-blue-700 hover:underline dark:text-blue-400"
                    to={`/recordings/${recording.id}`}
                  >
                    {recording.name}
                  </Link>
                </Td>
                <Td>{recording.kind === "api" ? "Feed" : "Recording"}</Td>
                <Td className="text-zinc-500">{recording.domain}</Td>
                <Td>{recording.openJobs}</Td>
                <Td>
                  {recording.lastRun ? (
                    <Link
                      to={`/runs/${recording.lastRun.id}`}
                      className="inline-flex items-center gap-2"
                    >
                      <StatusBadge status={recording.lastRun.status} />
                      <span className="text-xs text-zinc-500">
                        {ago(recording.lastRun.startedAt ?? recording.lastRun.createdAt)}
                        {recording.lastRun.status !== "succeeded" && recording.lastRun.reason
                          ? ` · ${reasonText(recording.lastRun.reason)}`
                          : ""}
                      </span>
                    </Link>
                  ) : (
                    <span className="text-zinc-500">Never run</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Dialog
        open={open === "record"}
        onClose={() => !session && setOpen(null)}
        title="New recording"
      >
        {session ? (
          <SessionPanel session={session} onDone={sessionDone} />
        ) : (
          <RecordForm onStarted={setSession} />
        )}
      </Dialog>
      <Dialog open={open === "source"} onClose={() => setOpen(null)} title="Add a job board feed">
        <SourceForm onAdded={created} />
      </Dialog>
      <Dialog
        open={open === "import"}
        onClose={() => setOpen(null)}
        title="Import a recording"
        wide
      >
        <ImportForm onImported={created} />
      </Dialog>
    </>
  );
}
