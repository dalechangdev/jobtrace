import { parseRecording, type Recording, type Target } from "@jobtrace/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHOICE, toCron } from "./cron.ts";
import {
  describeLocator,
  describeStep,
  draftProblems,
  findStep,
  isSource,
  moveLocator,
  removeField,
  removeLocator,
  targetsOf,
  timeline,
  updateField,
  updateStep,
  updateTarget,
} from "./definition.ts";
import { ago, duration, plural, reasonText, salary } from "./format.ts";

const target = (...values: string[]): Target => ({
  locators: values.map((value) => ({ kind: "css", value })),
  frame: [],
  relativeTo: null,
});

const recording: Recording = parseRecording({
  schemaVersion: 2,
  id: "rec_1",
  name: "Acme",
  startUrl: "https://x.example/jobs",
  steps: [
    { id: "s1", type: "navigate", url: "https://x.example/jobs" },
    {
      id: "s2",
      type: "paginate",
      mode: "nextButton",
      next: target("a.next", "nav a:last-child"),
      body: [
        {
          id: "s3",
          type: "forEach",
          items: target("li.job"),
          body: [
            {
              id: "s4",
              type: "extract",
              scope: "item",
              fields: [
                { name: "title", target: target("a.title", "h2", "a") },
                { name: "place", target: target(".loc") },
              ],
            },
            { id: "s5", type: "openDetail", link: target("a.title"), body: [] },
          ],
        },
      ],
    },
  ],
});

describe("definition helpers", () => {
  it("describes steps and locators in plain words", () => {
    const text = (id: string) => describeStep(findStep(recording.steps, id) as never);
    expect(text("s1")).toBe("https://x.example/jobs");
    expect(text("s2")).toBe("until there is no next page");
    expect(text("s3")).toBe("each job in the list");
    expect(text("s4")).toBe("title, place");
    expect(text("s5")).toBe("each job's page, in the same tab");
    expect(describeLocator({ kind: "role", role: "heading", level: 1 })).toBe(
      "role heading (level 1)",
    );
    expect(describeLocator({ kind: "role", role: "button", name: "Next" })).toBe(
      'role button named "Next"',
    );
    expect(describeLocator({ kind: "testId", value: "job" })).toBe('test id "job"');
    expect(describeLocator({ kind: "xpath", value: "//li" })).toBe("XPath //li");
    expect(targetsOf(findStep(recording.steps, "s2") as never).map((item) => item.label)).toEqual([
      "Next-page control",
    ]);
    expect(targetsOf(findStep(recording.steps, "s3") as never).map((item) => item.key)).toEqual([
      "items",
    ]);
    expect(findStep(recording.steps, "nope")).toBeUndefined();
  });

  it("edits a nested step without touching the original", () => {
    const renamed = updateField(recording, "s4", 1, (field) => ({ ...field, name: "location" }));
    const fields = (source: Recording) => {
      const step = findStep(source.steps, "s4");
      return step?.type === "extract" ? step.fields.map((field) => field.name) : [];
    };
    expect(fields(renamed)).toEqual(["title", "location"]);
    expect(fields(recording)).toEqual(["title", "place"]);
    expect(renamed.steps[0]).toBe(recording.steps[0]);

    expect(fields(removeField(renamed, "s4", 0))).toEqual(["location"]);
    // The last field of an extract step cannot be removed.
    expect(fields(removeField(removeField(renamed, "s4", 0), "s4", 0))).toEqual(["location"]);
    const navigated = updateStep(
      recording,
      "s1",
      (step) => ({ ...step, url: "https://x.example/all" }) as never,
    );
    expect(describeStep(navigated.steps[0] as never)).toBe("https://x.example/all");
  });

  it("reorders and removes locators, keeping at least one", () => {
    const values = (item: Target) =>
      item.locators.map((locator) => ("value" in locator ? locator.value : ""));
    const three = target("a", "b", "c");
    expect(values(moveLocator(three, 0, 1))).toEqual(["b", "a", "c"]);
    expect(values(moveLocator(three, 2, -1))).toEqual(["a", "c", "b"]);
    expect(moveLocator(three, 0, -1)).toBe(three);
    expect(moveLocator(three, 2, 1)).toBe(three);
    expect(values(removeLocator(three, 1))).toEqual(["a", "c"]);
    const one = target("a");
    expect(removeLocator(one, 0)).toBe(one);

    const reordered = updateTarget(recording, "s2", "next", (next) => moveLocator(next, 0, 1));
    const step = findStep(reordered.steps, "s2");
    expect(step?.type === "paginate" && step.next && values(step.next)).toEqual([
      "nav a:last-child",
      "a.next",
    ]);
    expect(updateTarget(recording, "s1", "target", (next) => next)).toEqual(recording);
  });

  it("explains what is wrong with a draft before it is sent", () => {
    expect(draftProblems(recording)).toEqual([]);
    const blank = updateField(recording, "s4", 1, (field) => ({ ...field, name: " " }));
    expect(draftProblems(blank)).toEqual(["Step s4: every field needs a name."]);
    const twice = updateField(recording, "s4", 1, (field) => ({ ...field, name: "title" }));
    expect(draftProblems(twice)).toEqual(['Step s4: the field name "title" is used twice.']);
    expect(
      draftProblems({
        ...recording,
        name: "",
        settings: { ...recording.settings, minDelayMs: 5000 },
      }),
    ).toEqual([
      "The recording needs a name.",
      "The minimum delay must not exceed the maximum delay.",
    ]);
    expect(isSource({ kind: "api" })).toBe(true);
    expect(isSource(recording)).toBe(false);
  });

  it("summarizes a run's log per step", () => {
    const event = (type: string, level: string, stepId?: string, message = type) => ({
      type,
      level,
      message,
      stepId,
    });
    expect(
      timeline([
        event("run_started", "info"),
        event("step_start", "debug", "s1"),
        event("step_start", "debug", "s3"),
        event("step_start", "debug", "s4"),
        event("locator_drift", "warn", "s4", "Used fallback #2"),
        event("step_start", "debug", "s4"),
        event("item_error", "error", "s4", "Item 2 failed"),
        event("for_each", "info", "s3"),
      ]),
    ).toEqual([
      { stepId: "s1", runs: 1, warnings: [], errors: [] },
      { stepId: "s3", runs: 1, warnings: [], errors: [] },
      { stepId: "s4", runs: 2, warnings: ["Used fallback #2"], errors: ["Item 2 failed"] },
    ]);
  });
});

describe("schedule form", () => {
  it("builds a cron expression from the form's choices", () => {
    expect(toCron(DEFAULT_CHOICE)).toBe("0 8 * * 1-5");
    expect(toCron({ ...DEFAULT_CHOICE, frequency: "daily", time: "07:30" })).toBe("30 7 * * *");
    expect(toCron({ ...DEFAULT_CHOICE, frequency: "weekly", time: "18:05", weekday: 0 })).toBe(
      "5 18 * * 0",
    );
    expect(toCron({ ...DEFAULT_CHOICE, frequency: "hours", everyHours: 6 })).toBe("0 */6 * * *");
    expect(toCron({ ...DEFAULT_CHOICE, frequency: "hours", everyHours: 0 })).toBe("0 */1 * * *");
    expect(toCron({ ...DEFAULT_CHOICE, frequency: "hours", everyHours: 99 })).toBe("0 */23 * * *");
    expect(toCron({ ...DEFAULT_CHOICE, frequency: "custom", cron: " 0 6 1 * * " })).toBe(
      "0 6 1 * *",
    );
    expect(toCron({ ...DEFAULT_CHOICE, frequency: "daily", time: "" })).toBe("0 0 * * *");
  });
});

describe("formatting", () => {
  it("formats durations, counts and relative times", () => {
    expect([duration(250), duration(4200), duration(125_000), duration(null)]).toEqual([
      "250 ms",
      "4 s",
      "2 min 05 s",
      "",
    ]);
    expect([plural(1, "job"), plural(3, "job")]).toEqual(["1 job", "3 jobs"]);
    const now = new Date("2026-10-06T12:00:00Z");
    expect(ago("2026-10-06T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-10-06T11:55:00Z", now)).toBe("5 minutes ago");
    expect(ago("2026-10-06T09:00:00Z", now)).toBe("3 hours ago");
    expect(ago("2026-10-05T12:00:00Z", now)).toBe("1 day ago");
    expect(ago("2026-07-01T12:00:00Z", now)).toMatch(/2026/);
    expect(ago(null, now)).toBe("");
  });

  it("formats salaries, falling back to the site's own wording", () => {
    const base = {
      salaryText: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
    };
    expect(
      salary({
        ...base,
        salaryMin: 85000,
        salaryMax: 110000,
        salaryCurrency: "EUR",
        salaryPeriod: "year",
      }),
    ).toBe("EUR 85,000–110,000 / year");
    expect(
      salary({
        ...base,
        salaryMin: 65,
        salaryMax: 65,
        salaryCurrency: "USD",
        salaryPeriod: "hour",
      }),
    ).toBe("USD 65 / hour");
    expect(salary({ ...base, salaryMax: 150000, salaryCurrency: "USD" })).toBe("USD 150,000");
    expect(salary({ ...base, salaryText: "Competitive" })).toBe("Competitive");
    expect(salary(base)).toBe("");
  });

  it("puts run failure reasons into words", () => {
    expect(reasonText("auth_expired")).toBe("The saved login has expired");
    expect(reasonText("something_new")).toBe("something new");
    expect(reasonText(null)).toBe("");
  });
});
