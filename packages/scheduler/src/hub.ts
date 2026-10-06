import type { RunEvent } from "@jobtrace/core";

export interface RunSubscriber {
  onEvent(event: RunEvent): void;
  /** The run has ended (or was cancelled while queued); no more events follow. */
  onFinish(): void;
}

/**
 * In-process fan-out of run events to whoever is watching a run live (the
 * API's event stream). Events are also stored; this only carries them as they happen.
 */
export interface RunHub {
  publish(runId: string, event: RunEvent): void;
  finish(runId: string): void;
  /** Returns the function that unsubscribes. */
  subscribe(runId: string, subscriber: RunSubscriber): () => void;
}

export function createRunHub(): RunHub {
  const subscribers = new Map<string, Set<RunSubscriber>>();
  const each = (runId: string, call: (subscriber: RunSubscriber) => void) => {
    for (const subscriber of [...(subscribers.get(runId) ?? [])]) {
      try {
        call(subscriber);
      } catch {
        // One broken watcher must not affect the run or the other watchers.
      }
    }
  };
  return {
    publish: (runId, event) => each(runId, (subscriber) => subscriber.onEvent(event)),
    finish(runId) {
      each(runId, (subscriber) => subscriber.onFinish());
      subscribers.delete(runId);
    },
    subscribe(runId, subscriber) {
      const set = subscribers.get(runId) ?? new Set();
      subscribers.set(runId, set);
      set.add(subscriber);
      return () => {
        set.delete(subscriber);
        if (set.size === 0 && subscribers.get(runId) === set) subscribers.delete(runId);
      };
    },
  };
}
