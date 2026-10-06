import type { ApiSource, Field, Locator, Recording, Step, Target } from "@jobtrace/core";

/**
 * Pure helpers for showing and editing a recording's definition. Edits return a
 * new definition and never touch the one passed in, so React state can hold it.
 */

export type RecordingDraft = Recording;
export type SourceDraft = ApiSource;

export function isSource(definition: unknown): definition is ApiSource {
  return (
    typeof definition === "object" &&
    definition !== null &&
    (definition as { kind?: unknown }).kind === "api"
  );
}

/** The keys under which a step holds a target, by step type. */
const TARGET_KEYS = ["target", "items", "link", "next"] as const;
export type TargetKey = (typeof TARGET_KEYS)[number];

export function targetsOf(step: Step): Array<{ key: TargetKey; label: string; target: Target }> {
  const labels: Record<TargetKey, string> = {
    target: "Element",
    items: "List items",
    link: "Detail link",
    next: "Next-page control",
  };
  const found: Array<{ key: TargetKey; label: string; target: Target }> = [];
  for (const key of TARGET_KEYS) {
    const target = (step as Record<string, unknown>)[key] as Target | undefined;
    if (target) found.push({ key, label: labels[key], target });
  }
  return found;
}

export function describeLocator(locator: Locator): string {
  switch (locator.kind) {
    case "testId":
      return `test id "${locator.value}"`;
    case "role":
      return `role ${locator.role}${locator.level ? ` (level ${locator.level})` : ""}${locator.name ? ` named "${locator.name}"` : ""}`;
    case "text":
      return `text "${locator.value}"`;
    case "css":
      return `CSS ${locator.value}`;
    case "xpath":
      return `XPath ${locator.value}`;
  }
}

/** One line saying what a step does. */
export function describeStep(step: Step): string {
  switch (step.type) {
    case "navigate":
      return step.url;
    case "fill":
    case "select":
      return `"${step.value}"`;
    case "press":
      return step.key;
    case "scroll":
      return step.mode === "toBottom" ? "to the bottom" : `by ${step.amount ?? 0}px`;
    case "waitFor":
      return step.urlPattern
        ? `for URL ${step.urlPattern}`
        : step.ms !== undefined
          ? `${step.ms} ms`
          : "for an element";
    case "extract":
      return step.fields.map((field) => field.name).join(", ");
    case "forEach":
      return "each job in the list";
    case "openDetail":
      return step.strategy === "newTab"
        ? "each job's page, in a new tab"
        : "each job's page, in the same tab";
    case "paginate":
      return step.mode === "nextButton"
        ? "until there is no next page"
        : step.mode === "infiniteScroll"
          ? "by scrolling for more"
          : "through numbered pages";
    case "click":
      return "";
  }
}

function mapSteps(steps: readonly Step[], stepId: string, change: (step: Step) => Step): Step[] {
  return steps.map((step) => {
    if (step.id === stepId) return change(step);
    return "body" in step ? ({ ...step, body: mapSteps(step.body, stepId, change) } as Step) : step;
  });
}

/** Replaces one step, wherever it sits in the tree. */
export function updateStep(
  recording: Recording,
  stepId: string,
  change: (step: Step) => Step,
): Recording {
  return { ...recording, steps: mapSteps(recording.steps, stepId, change) };
}

export function findStep(steps: readonly Step[], stepId: string): Step | undefined {
  for (const step of steps) {
    if (step.id === stepId) return step;
    const nested = "body" in step ? findStep(step.body, stepId) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

/** Moves a locator one place up (-1) or down (+1) in a target's ranking. */
export function moveLocator(target: Target, index: number, direction: -1 | 1): Target {
  const to = index + direction;
  if (to < 0 || to >= target.locators.length) return target;
  const locators = [...target.locators];
  const [moved] = locators.splice(index, 1);
  locators.splice(to, 0, moved as Locator);
  return { ...target, locators };
}

/** Removes a locator; the last one cannot be removed, since a target needs one. */
export function removeLocator(target: Target, index: number): Target {
  if (target.locators.length <= 1) return target;
  return { ...target, locators: target.locators.filter((_, position) => position !== index) };
}

export function updateTarget(
  recording: Recording,
  stepId: string,
  key: TargetKey,
  change: (target: Target) => Target,
): Recording {
  return updateStep(recording, stepId, (step) => {
    const current = (step as Record<string, unknown>)[key] as Target | undefined;
    return current ? ({ ...step, [key]: change(current) } as Step) : step;
  });
}

export function updateField(
  recording: Recording,
  stepId: string,
  index: number,
  change: (field: Field) => Field,
): Recording {
  return updateStep(recording, stepId, (step) =>
    step.type === "extract"
      ? {
          ...step,
          fields: step.fields.map((field, position) =>
            position === index ? change(field) : field,
          ),
        }
      : step,
  );
}

export function removeField(recording: Recording, stepId: string, index: number): Recording {
  return updateStep(recording, stepId, (step) =>
    step.type === "extract" && step.fields.length > 1
      ? { ...step, fields: step.fields.filter((_, position) => position !== index) }
      : step,
  );
}

/** Problems that would make the server reject the draft, in words for the user. */
export function draftProblems(recording: Recording): string[] {
  const problems: string[] = [];
  if (!recording.name.trim()) problems.push("The recording needs a name.");
  const visit = (steps: readonly Step[]) => {
    for (const step of steps) {
      if (step.type === "extract") {
        const names = step.fields.map((field) => field.name.trim());
        if (names.some((name) => name === ""))
          problems.push(`Step ${step.id}: every field needs a name.`);
        const repeated = names.find((name, index) => name !== "" && names.indexOf(name) !== index);
        if (repeated) problems.push(`Step ${step.id}: the field name "${repeated}" is used twice.`);
      }
      if ("body" in step) visit(step.body);
    }
  };
  visit(recording.steps);
  if (recording.settings.minDelayMs > recording.settings.maxDelayMs) {
    problems.push("The minimum delay must not exceed the maximum delay.");
  }
  return problems;
}

export interface TimelineEntry {
  stepId: string;
  /** How often the step ran. */
  runs: number;
  warnings: string[];
  errors: string[];
}

/** Summarizes a run's log per step, in the order the steps were first reached. */
export function timeline(
  events: ReadonlyArray<{
    type: string;
    level: string;
    message: string;
    stepId?: string | undefined;
  }>,
): TimelineEntry[] {
  const entries = new Map<string, TimelineEntry>();
  for (const event of events) {
    if (!event.stepId) continue;
    let entry = entries.get(event.stepId);
    if (!entry) {
      entry = { stepId: event.stepId, runs: 0, warnings: [], errors: [] };
      entries.set(event.stepId, entry);
    }
    if (event.type === "step_start") entry.runs++;
    else if (event.level === "warn") entry.warnings.push(event.message);
    else if (event.level === "error") entry.errors.push(event.message);
  }
  return [...entries.values()];
}
