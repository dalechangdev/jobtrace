import { join } from "node:path";
import { type Config, isLoopbackHost, JobTraceError, newId } from "@jobtrace/core";
import type { Database } from "@jobtrace/db";
import {
  type AuthCapture,
  captureAuth,
  type RecorderOptions,
  type RecordingSession,
  startRecording,
} from "@jobtrace/recorder";
import type { z } from "zod";
import type { Runtime } from "./runtime.ts";
import type { sessionSchema } from "./schemas.ts";

export type SessionView = z.infer<typeof sessionSchema>;

export interface SessionHooks {
  /** Recorder overrides; tests run headless with a shared browser. */
  recorder?: Pick<RecorderOptions, "headless" | "openShadow" | "browser">;
  onRecording?: (session: RecordingSession) => void;
  onAuthCapture?: (capture: AuthCapture) => void;
}

interface Entry {
  view: SessionView;
  recording?: RecordingSession;
  auth?: AuthCapture;
}

/**
 * Browser windows opened on the machine the server runs on: recording a board
 * or capturing a login. One at a time, and only when the server is bound to
 * loopback, since the window appears on the host's screen.
 */
export function createSessions(
  db: Database,
  config: Config,
  runtime: Runtime,
  hooks: SessionHooks = {},
) {
  const entries = new Map<string, Entry>();

  function begin(kind: SessionView["kind"], url: string): Entry {
    if (!isLoopbackHost(config.host)) {
      throw new JobTraceError(
        "INVALID_ARGUMENT",
        "Recording and login windows open on the server's own screen, so they are only available when the server is bound to localhost.",
      );
    }
    if ([...entries.values()].some((entry) => entry.view.status === "active")) {
      throw new JobTraceError(
        "INVALID_ARGUMENT",
        "Another recording or login window is still open. Finish it first.",
      );
    }
    const entry: Entry = {
      view: {
        id: newId("event").replace(/^evt_/, "ses_"),
        kind,
        status: "active",
        url,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        progress: null,
        resultId: null,
        warnings: [],
        error: null,
      },
    };
    entries.set(entry.view.id, entry);
    return entry;
  }
  const settle = (entry: Entry, patch: Partial<SessionView>) => {
    entry.view = { ...entry.view, ...patch, finishedAt: new Date().toISOString(), progress: null };
  };
  const failed = (entry: Entry) => (error: unknown) =>
    settle(entry, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });

  return {
    async startRecording(input: {
      url: string;
      name?: string;
      authProfileId?: string;
    }): Promise<SessionView> {
      const profile = input.authProfileId ? await db.authProfiles.get(input.authProfileId) : null;
      if (input.authProfileId && !profile) {
        throw new JobTraceError("NOT_FOUND", `No auth profile ${input.authProfileId}`);
      }
      const entry = begin("recording", input.url);
      try {
        const session = await startRecording({
          url: input.url,
          ...(input.name ? { name: input.name } : {}),
          ...(profile ? { storageState: profile.storageStatePath, authProfileId: profile.id } : {}),
          ...hooks.recorder,
        });
        entry.recording = session;
        session.finished
          .then(async ({ recording, warnings }) => {
            // New recordings start with the pause between actions set on the Settings page.
            recording.settings.minDelayMs = runtime.current.defaultMinDelayMs;
            recording.settings.maxDelayMs = runtime.current.defaultMaxDelayMs;
            await db.recordings.save(recording, "recorded");
            settle(entry, { status: "finished", resultId: recording.id, warnings });
          })
          .catch(failed(entry));
        hooks.onRecording?.(session);
      } catch (error) {
        failed(entry)(error);
        throw error;
      }
      return this.get(entry.view.id) as SessionView;
    },

    /** Opens a login window. With `profileId`, refreshes that profile; otherwise creates `name`. */
    async startAuth(input: {
      url: string;
      name: string;
      profileId?: string;
    }): Promise<SessionView> {
      const existing = input.profileId ? await db.authProfiles.get(input.profileId) : null;
      if (input.profileId && !existing)
        throw new JobTraceError("NOT_FOUND", `No auth profile ${input.profileId}`);
      if (
        !existing &&
        (await db.authProfiles.list()).some(
          (p) => p.name.toLowerCase() === input.name.toLowerCase(),
        )
      ) {
        throw new JobTraceError(
          "INVALID_ARGUMENT",
          `An auth profile named "${input.name}" already exists`,
        );
      }
      const id = existing?.id ?? newId("authProfile");
      const statePath = existing?.storageStatePath ?? join(config.dataDir, "auth", `${id}.json`);
      const entry = begin("auth", input.url);
      try {
        const capture = await captureAuth({
          url: input.url,
          statePath,
          ...(existing ? { existingState: statePath } : {}),
          ...hooks.recorder,
        });
        entry.auth = capture;
        capture.finished
          .then(async ({ saved, domain }) => {
            if (!saved) return settle(entry, { status: "cancelled" });
            await db.authProfiles.save({
              id,
              name: existing?.name ?? input.name,
              domain,
              storageStatePath: statePath,
            });
            settle(entry, { status: "finished", resultId: id });
          })
          .catch(failed(entry));
        hooks.onAuthCapture?.(capture);
      } catch (error) {
        failed(entry)(error);
        throw error;
      }
      return entry.view;
    },

    get(id: string): SessionView | null {
      const entry = entries.get(id);
      if (!entry) return null;
      if (entry.view.status === "active" && entry.recording) {
        const { mode, steps, fields, scope } = entry.recording.status();
        return { ...entry.view, progress: { mode, steps, fields, scope } };
      }
      return entry.view;
    },

    /** Ends an active session: a recording is saved, a login capture is cancelled. */
    async stop(id: string): Promise<SessionView | null> {
      const entry = entries.get(id);
      if (!entry) return null;
      if (entry.view.status === "active") {
        await entry.recording?.stop().catch(() => {});
        await entry.auth?.cancel().catch(() => {});
        // Let the save that follows the session's end settle.
        for (let waited = 0; waited < 2000 && entry.view.status === "active"; waited += 20) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      return entry.view;
    },

    async closeAll(): Promise<void> {
      await Promise.all([...entries.keys()].map((id) => this.stop(id)));
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;
