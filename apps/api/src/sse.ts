import type { RunEvent } from "@jobtrace/core";
import type { Database } from "@jobtrace/db";
import type { RunHub } from "@jobtrace/scheduler";
import type { FastifyReply, FastifyRequest } from "fastify";

const HEARTBEAT_MS = 15_000;
const FINAL = new Set(["succeeded", "partial", "failed", "blocked", "cancelled"]);

/**
 * Streams a run's log as Server-Sent Events: first everything stored so far,
 * then events as they happen, then one `end` event with the final run. Each
 * event's id is its position in the log, so a reconnecting client that sends
 * Last-Event-ID resumes without duplicates.
 */
export async function streamRunEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  { db, hub, runId }: { db: Database; hub: RunHub; runId: string },
): Promise<void> {
  const resumeAfter = Number(request.headers["last-event-id"] ?? -1);
  const live: RunEvent[] = [];
  let ended = false;
  let flush: (() => void) | undefined;

  // Read what is stored and subscribe in the same tick: the query runs when
  // called, so no event can fall between the two.
  const storedPromise = db.runs.events(runId);
  const unsubscribe = hub.subscribe(runId, {
    onEvent(event) {
      live.push(event);
      flush?.();
    },
    onFinish() {
      ended = true;
      flush?.();
    },
  });
  const stored = await storedPromise;

  reply.hijack();
  const stream = reply.raw;
  stream.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let index = 0;
  const send = (event: RunEvent) => {
    const id = index++;
    if (id > resumeAfter) stream.write(`id: ${id}\nevent: log\ndata: ${JSON.stringify(event)}\n\n`);
  };
  for (const event of stored) send(event);

  const heartbeat = setInterval(() => stream.write(": keep-alive\n\n"), HEARTBEAT_MS);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    flush = undefined;
    if (!stream.writableEnded) stream.end();
  };
  request.raw.on("close", close);

  const finish = async () => {
    const run = await db.runs.get(runId);
    stream.write(`event: end\ndata: ${JSON.stringify(run)}\n\n`);
    close();
  };
  flush = () => {
    while (live.length > 0) send(live.shift() as RunEvent);
    if (ended) void finish();
  };

  // Already over before anyone watched (or it ended while the stored log was read).
  const run = await db.runs.get(runId);
  if (run && FINAL.has(run.status)) ended = true;
  flush();
}
