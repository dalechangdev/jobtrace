import { describe, expect, it } from "vitest";
import { parseRecording } from "./migrations/index.ts";
import type { Recording } from "./recording.ts";
import type { RunEvent } from "./run.ts";
import {
  applyLocatorSuggestion,
  type LocatorSuggestion,
  stepTargets,
  suggestionState,
  suggestionsFromEvents,
} from "./suggestions.ts";

const css = (value: string) => ({ kind: "css" as const, value });

const recording: Recording = parseRecording({
  schemaVersion: 2,
  id: "rec_s",
  name: "Suggestions",
  startUrl: "https://example.com/jobs",
  steps: [
    { id: "nav", type: "navigate", url: "https://example.com/jobs" },
    {
      id: "each",
      type: "forEach",
      items: { locators: [css("li.job")] },
      body: [
        {
          id: "read",
          type: "extract",
          scope: "item",
          fields: [
            { name: "title", target: { locators: [css(".title")], relativeTo: "item" } },
            { name: "url", target: { locators: [css(".title")], relativeTo: "item" } },
            { name: "location", target: { locators: [css(".loc")], relativeTo: "item" } },
          ],
        },
      ],
    },
  ],
});

const suggestion: LocatorSuggestion = {
  stepId: "read",
  failed: [css(".title")],
  locator: css(".posting-title"),
  source: "ai",
};

const locatorsOf = (target: Recording, stepId: string) => {
  const each = target.steps[1];
  const steps = each && "body" in each ? [each, ...each.body] : [];
  const step = steps.find((candidate) => candidate.id === stepId);
  return step ? stepTargets(step).map((item) => item.locators) : [];
};

describe("applyLocatorSuggestion", () => {
  it("ranks the suggestion first on every target of the step that had the failed locators", () => {
    const next = applyLocatorSuggestion(recording, suggestion);
    expect(next && locatorsOf(next, "read")).toEqual([
      [css(".posting-title"), css(".title")],
      [css(".posting-title"), css(".title")],
      [css(".loc")],
    ]);
    // The original is left alone.
    expect(locatorsOf(recording, "read")[0]).toEqual([css(".title")]);
    expect(next && parseRecording(next)).toEqual(next);
  });

  it("reaches targets of loop steps", () => {
    const next = applyLocatorSuggestion(recording, {
      stepId: "each",
      failed: [css("li.job")],
      locator: { kind: "role", role: "listitem" },
      source: "ai",
    });
    expect(next && locatorsOf(next, "each")).toEqual([
      [{ kind: "role", role: "listitem" }, css("li.job")],
    ]);
  });

  it("returns null when the step is gone or its target changed", () => {
    expect(applyLocatorSuggestion(recording, { ...suggestion, stepId: "gone" })).toBeNull();
    expect(
      applyLocatorSuggestion(recording, { ...suggestion, failed: [css(".other")] }),
    ).toBeNull();
  });
});

describe("suggestionState", () => {
  it("tells open, applied and stale apart", () => {
    expect(suggestionState(recording, suggestion)).toBe("open");
    const applied = applyLocatorSuggestion(recording, suggestion) as Recording;
    expect(suggestionState(applied, suggestion)).toBe("applied");
    expect(applyLocatorSuggestion(applied, suggestion)).toBeNull();
    expect(suggestionState(recording, { ...suggestion, stepId: "gone" })).toBe("stale");
  });
});

describe("suggestionsFromEvents", () => {
  const event = (data: Record<string, unknown>, extra: Partial<RunEvent> = {}): RunEvent => ({
    ts: "2026-10-06T12:00:00.000Z",
    level: "warn",
    type: "locator_suggestion",
    message: "healed",
    stepId: "read",
    data,
    ...extra,
  });

  it("reads suggestions, drops repeats and ignores malformed events", () => {
    const data = {
      locator: css(".posting-title"),
      failed: [css(".title")],
      source: "ai",
      reason: "Same link, renamed class.",
    };
    expect(
      suggestionsFromEvents([
        event(data),
        event(data),
        event({ ...data, locator: { kind: "nope" } }),
        event({ ...data, failed: [] }),
        event(data, { type: "locator_drift" }),
        event({ ...data, failed: [css(".loc")], locator: css(".place") }),
      ]),
    ).toEqual([
      { stepId: "read", ...data },
      {
        stepId: "read",
        failed: [css(".loc")],
        locator: css(".place"),
        source: "ai",
        reason: data.reason,
      },
    ]);
  });
});
