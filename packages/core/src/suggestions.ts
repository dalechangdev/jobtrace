import { isDeepStrictEqual } from "node:util";
import {
  type Locator,
  locatorSchema,
  type Recording,
  type Step,
  type Target,
} from "./recording.ts";
import type { RunEvent } from "./run.ts";

/**
 * A locator that healed a step during a run, after every recorded locator of
 * the target had failed. It lives in the run's event log (type
 * `locator_suggestion`) until someone accepts it into the recording.
 */
export interface LocatorSuggestion {
  stepId: string;
  /** The target's locators at the time, which is how the target is found again. */
  failed: Locator[];
  locator: Locator;
  /** Where the suggestion came from, e.g. "ai". */
  source: string;
  reason?: string;
}

/** Every target a step has, in a stable order. Does not descend into bodies. */
export function stepTargets(step: Step): Target[] {
  switch (step.type) {
    case "click":
    case "fill":
    case "select":
      return [step.target];
    case "press":
    case "scroll":
    case "waitFor":
      return step.target ? [step.target] : [];
    case "extract":
      return step.fields.map((field) => field.target);
    case "forEach":
      return [step.items];
    case "openDetail":
      return [step.link];
    case "paginate":
      return step.next ? [step.next] : [];
    default:
      return [];
  }
}

const sameLocator = (a: Locator, b: Locator) => isDeepStrictEqual(a, b);

function findStep(steps: readonly Step[], id: string): Step | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    const inner = "body" in step ? findStep(step.body, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

export type SuggestionState =
  /** The target still has the locators that failed: accepting would change it. */
  | "open"
  /** The target already starts with the suggested locator. */
  | "applied"
  /** The step is gone, or its target was edited since the run. */
  | "stale";

function matchingTargets(recording: Recording, suggestion: LocatorSuggestion) {
  // The logged-in check is never healed: a guess there could hide an expired login.
  const step = findStep(recording.steps, suggestion.stepId);
  const targets = step ? stepTargets(step) : [];
  const open: Target[] = [];
  let applied = false;
  for (const target of targets) {
    const [first, ...rest] = target.locators;
    if (isDeepStrictEqual(target.locators, suggestion.failed)) open.push(target);
    else if (
      first &&
      sameLocator(first, suggestion.locator) &&
      isDeepStrictEqual(rest, suggestion.failed)
    ) {
      applied = true;
    }
  }
  return { open, applied };
}

export function suggestionState(
  recording: Recording,
  suggestion: LocatorSuggestion,
): SuggestionState {
  const { open, applied } = matchingTargets(recording, suggestion);
  if (open.length > 0) return "open";
  return applied ? "applied" : "stale";
}

/**
 * Returns a copy of the recording in which the suggested locator is ranked
 * first on the target it healed, or null when that target cannot be found
 * unchanged (see `suggestionState`). The old locators stay as fallbacks.
 */
export function applyLocatorSuggestion(
  recording: Recording,
  suggestion: LocatorSuggestion,
): Recording | null {
  const next = structuredClone(recording);
  const { open } = matchingTargets(next, suggestion);
  if (open.length === 0) return null;
  for (const target of open) {
    target.locators = [
      suggestion.locator,
      ...target.locators.filter((locator) => !sameLocator(locator, suggestion.locator)),
    ];
  }
  return next;
}

/** The distinct suggestions in a run's event log, in the order they were made. */
export function suggestionsFromEvents(events: readonly RunEvent[]): LocatorSuggestion[] {
  const found: LocatorSuggestion[] = [];
  for (const event of events) {
    if (event.type !== "locator_suggestion" || !event.stepId || !event.data) continue;
    const locator = locatorSchema.safeParse(event.data.locator);
    const failed = locatorSchema.array().min(1).safeParse(event.data.failed);
    if (!locator.success || !failed.success) continue;
    const suggestion: LocatorSuggestion = {
      stepId: event.stepId,
      failed: failed.data,
      locator: locator.data,
      source: typeof event.data.source === "string" ? event.data.source : "unknown",
      ...(typeof event.data.reason === "string" ? { reason: event.data.reason } : {}),
    };
    const known = found.some(
      (other) =>
        other.stepId === suggestion.stepId &&
        isDeepStrictEqual(other.failed, suggestion.failed) &&
        sameLocator(other.locator, suggestion.locator),
    );
    if (!known) found.push(suggestion);
  }
  return found;
}
