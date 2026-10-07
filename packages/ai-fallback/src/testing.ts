import { readFileSync } from "node:fs";
import { parseRecordingJson, type Recording, stepTargets, walkSteps } from "@jobtrace/core";

/**
 * The site-4 example recording ("list with detail pages") with every target
 * cut down to its first locator. Those are the class-name selectors that site 9
 * (same board, renamed classes) breaks, so nothing deterministic is left.
 */
export function brokenListDetail(): Recording {
  const file = new URL("../../../examples/recordings/list-detail.jobtrace.json", import.meta.url);
  const recording = parseRecordingJson(readFileSync(file, "utf8"));
  for (const step of walkSteps(recording.steps)) {
    for (const target of stepTargets(step)) target.locators = target.locators.slice(0, 1);
  }
  return recording;
}

/** The failed locators quoted in a prompt built by `buildPrompt`. */
export function failedLocatorsIn(prompt: string): Array<{ kind: string; value?: string }> {
  const match = /<failed_locators>\n([\s\S]*?)\n<\/failed_locators>/.exec(prompt);
  return match?.[1] ? JSON.parse(match[1]) : [];
}
