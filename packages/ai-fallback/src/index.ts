import type { Config, Healing } from "@jobtrace/core";
import { anthropicSuggest, createAiLocatorResolver, type Suggest } from "./resolver.ts";

export * from "./resolver.ts";

export interface AiHealingOptions {
  /** Read before every run, so the Settings switch works without a restart. */
  enabled?: () => boolean;
  /** Replaces the Claude call (tests). */
  suggest?: Suggest;
}

/**
 * The AI fallback as configured, or undefined when it cannot run at all: it
 * needs an API key. Nothing is sent anywhere unless it is also switched on.
 */
export function aiHealing(
  config: Pick<Config, "aiFallback">,
  options: AiHealingOptions = {},
): Healing | undefined {
  const { apiKey, model, maxCalls, autoApply } = config.aiFallback;
  const suggest = options.suggest ?? (apiKey ? anthropicSuggest(apiKey) : undefined);
  if (!suggest) return undefined;
  const enabled = options.enabled ?? (() => config.aiFallback.enabled);
  return {
    autoApply,
    createResolver: () =>
      enabled()
        ? createAiLocatorResolver({ suggest, maxCalls, ...(model ? { model } : {}) })
        : undefined,
  };
}
