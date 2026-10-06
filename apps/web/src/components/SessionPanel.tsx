import type { ApiSession } from "@jobtrace/api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api.ts";
import { plural } from "../lib/format.ts";
import { Button, ErrorNote, Note } from "../ui.tsx";

/**
 * Follows a recorder or login window that the server opened on this computer,
 * until the user finishes in that window or stops it from here.
 */
export function SessionPanel({
  session,
  onDone,
}: {
  session: ApiSession;
  onDone: (session: ApiSession) => void;
}) {
  const live = useQuery({
    queryKey: ["session", session.id],
    queryFn: () => api.sessions.get(session.id),
    initialData: session,
    refetchInterval: (query) => (query.state.data?.status === "active" ? 1000 : false),
  });
  const stop = useMutation({
    mutationFn: () => api.sessions.stop(session.id),
    onSuccess: (data) => onDone(data),
  });
  const current = live.data;

  useEffect(() => {
    if (current.status !== "active" && !stop.isPending && !stop.isSuccess) onDone(current);
  }, [current, onDone, stop.isPending, stop.isSuccess]);

  const recording = current.kind === "recording";
  return (
    <div className="space-y-3" data-testid="session-panel">
      <Note>
        {recording
          ? "A browser window with the JobTrace toolbar is open on this computer. Mark the list of jobs and the data to extract there."
          : "A browser window is open on this computer. Log in as usual, then press Save login in its toolbar. Your password is not recorded."}
      </Note>
      {recording && current.progress && (
        <p className="text-sm" data-testid="session-progress">
          {plural(current.progress.steps, "step")} ·{" "}
          {plural(current.progress.fields.length, "field")}
          {current.progress.fields.length > 0 && `: ${current.progress.fields.join(", ")}`}
          {current.progress.scope !== "none" && ` · in ${current.progress.scope}`}
        </p>
      )}
      <ErrorNote error={stop.error ?? (current.status === "failed" ? current.error : null)} />
      <div className="flex justify-end gap-2">
        <Button
          variant={recording ? "primary" : "secondary"}
          disabled={stop.isPending || current.status !== "active"}
          onClick={() => stop.mutate()}
        >
          {recording ? "Stop and save" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}
