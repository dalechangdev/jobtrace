import type { ApiSession } from "@jobtrace/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.ts";
import { SessionPanel } from "../components/SessionPanel.tsx";
import { ago, plural, when } from "../lib/format.ts";
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
  Table,
  Td,
} from "../ui.tsx";

export function AuthProfiles() {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["auth-profiles"], queryFn: api.auth.list });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings.get });
  const [creating, setCreating] = useState(false);
  const [session, setSession] = useState<ApiSession | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.auth.create({ name: name.trim(), url }),
    onSuccess: setSession,
  });
  const refresh = useMutation({
    mutationFn: (id: string) => api.auth.refresh(id),
    onSuccess: (started) => {
      setSession(started);
      setCreating(true);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.auth.remove(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["auth-profiles"] }),
  });
  const done = (finished: ApiSession) => {
    setSession(null);
    setCreating(false);
    setName("");
    setUrl("");
    setNotice(
      finished.status === "finished" ? "Login saved." : (finished.error ?? "Nothing was saved."),
    );
    void client.invalidateQueries({ queryKey: ["auth-profiles"] });
  };

  return (
    <>
      <PageHeader
        title="Saved logins"
        subtitle="For job boards behind a sign-in. Only the browser session is saved; your password is never seen or stored."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New login
          </Button>
        }
      />
      <div className="mb-4 space-y-3">
        {settings.data && !settings.data.local && (
          <Note tone="amber">
            This server cannot open a browser window on your screen (it runs in a container or on
            another machine). Create the login on your own computer with the jobtrace command line
            and send it here with --server.
          </Note>
        )}
        {notice && <Note>{notice}</Note>}
        <ErrorNote error={profiles.error ?? refresh.error ?? remove.error} />
      </div>
      <Card>
        {!profiles.data ? (
          <Loading />
        ) : profiles.data.length === 0 ? (
          <Empty>No saved logins. Most public job boards do not need one.</Empty>
        ) : (
          <Table head={["Name", "Site", "Created", "Last worked", "Used by", ""]}>
            {profiles.data.map((profile) => (
              <tr key={profile.id}>
                <Td className="font-medium">{profile.name}</Td>
                <Td className="text-zinc-500">{profile.domain}</Td>
                <Td className="whitespace-nowrap">{when(profile.createdAt)}</Td>
                <Td className="whitespace-nowrap">
                  {profile.lastVerifiedAt ? ago(profile.lastVerifiedAt) : "Not checked yet"}
                </Td>
                <Td>{plural(profile.usedBy, "recording")}</Td>
                <Td className="space-x-2 whitespace-nowrap text-right">
                  <Button
                    size="sm"
                    disabled={refresh.isPending}
                    onClick={() => refresh.mutate(profile.id)}
                  >
                    Log in again
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete the saved login "${profile.name}"? Recordings that use it will stop working until they are recorded again.`,
                        )
                      ) {
                        remove.mutate(profile.id);
                      }
                    }}
                  >
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Dialog
        open={creating}
        onClose={() => !session && setCreating(false)}
        title={session ? "Log in" : "New saved login"}
      >
        {session ? (
          <SessionPanel session={session} onDone={done} />
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Name" hint="For example the site's name.">
              <Input required value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Login page address">
              <Input
                type="url"
                required
                placeholder="https://careers.example.com/login"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
            <ErrorNote error={create.error} />
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={create.isPending}>
                {create.isPending ? "Opening the browser…" : "Open login window"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
