import type { Config } from "@jobtrace/core";
import type { Database } from "@jobtrace/db";
import { z } from "zod";

/** Settings that can be changed while the server runs (from the Settings page). */
export const runtimeSettingsSchema = z.object({
  /** How many runs may execute at the same time. */
  maxConcurrentRuns: z.number().int().min(1).max(10),
  /** Screenshots and traces are kept for this many of a recording's newest runs. */
  artifactRetentionRuns: z.number().int().min(1).max(1000),
  /** Pause between actions given to newly made recordings, in milliseconds. */
  defaultMinDelayMs: z.number().int().min(0).max(120_000),
  defaultMaxDelayMs: z.number().int().min(0).max(120_000),
  /** Whether the optional AI locator fallback may be used. The API key itself stays in the environment. */
  aiFallbackEnabled: z.boolean(),
});
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

const KEY = "runtime";

/** The live settings. The worker and routes read `current` each time they need a value. */
export interface Runtime {
  current: RuntimeSettings;
  update(patch: Partial<RuntimeSettings>): Promise<RuntimeSettings>;
}

/** Settings saved through the UI override the environment's defaults. */
export async function loadRuntime(db: Database, config: Config): Promise<Runtime> {
  const defaults: RuntimeSettings = {
    maxConcurrentRuns: config.maxConcurrentRuns,
    artifactRetentionRuns: config.artifactRetentionRuns,
    defaultMinDelayMs: config.defaultMinDelayMs,
    defaultMaxDelayMs: config.defaultMaxDelayMs,
    aiFallbackEnabled: config.aiFallback.enabled,
  };
  const saved = runtimeSettingsSchema.partial().safeParse((await db.settings.get(KEY)) ?? {});
  const runtime: Runtime = {
    current: { ...defaults, ...(saved.success ? saved.data : {}) },
    async update(patch) {
      const next = runtimeSettingsSchema.parse({ ...runtime.current, ...patch });
      await db.settings.set(KEY, next);
      runtime.current = next;
      return next;
    },
  };
  return runtime;
}
