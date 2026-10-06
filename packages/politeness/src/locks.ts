import { JobTraceError } from "@jobtrace/core";

/**
 * One run per domain at a time. `acquire` resolves with a release function once
 * every earlier holder of the same domain has released, in arrival order.
 */
export class DomainLocks {
  readonly #tails = new Map<string, Promise<void>>();

  /** True when a run currently holds, or waits for, the domain. */
  isBusy(domain: string): boolean {
    return this.#tails.has(domain.toLowerCase());
  }

  async acquire(domain: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new JobTraceError("RUN_CANCELLED", "Run was cancelled while waiting for its turn");
    }
    const key = domain.toLowerCase();
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.#tails.set(key, tail);
    const done = () => {
      release();
      // Forget the domain once nobody queued up behind this holder.
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    };

    if (!signal) {
      await previous;
      return done;
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () =>
        reject(new JobTraceError("RUN_CANCELLED", "Run was cancelled while waiting for its turn"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    try {
      await Promise.race([previous, aborted]);
    } catch (error) {
      // Give the turn up without blocking those behind.
      void previous.then(done);
      throw error;
    }
    return done;
  }
}
