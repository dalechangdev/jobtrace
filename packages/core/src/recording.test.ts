import { describe, expect, it } from "vitest";
import { JobTraceError } from "./errors.ts";
import { migrateRecording, parseRecording, parseRecordingJson } from "./migrations/index.ts";
import { type RecordingInput, walkSteps } from "./recording.ts";

const target = (css: string) => ({ locators: [{ kind: "css" as const, value: css }] });

function recording(overrides: Partial<RecordingInput> = {}): RecordingInput {
  return {
    schemaVersion: 2,
    id: "rec_test",
    name: "Test",
    startUrl: "https://careers.example/jobs",
    steps: [{ id: "s1", type: "navigate", url: "https://careers.example/jobs" }],
    ...overrides,
  };
}

function issuesOf(document: unknown): string {
  try {
    parseRecording(document);
  } catch (error) {
    if (error instanceof JobTraceError) return error.message;
    throw error;
  }
  throw new Error("expected the recording to be rejected");
}

describe("recording schema", () => {
  it("applies defaults", () => {
    const parsed = parseRecording(
      recording({
        steps: [
          {
            id: "s1",
            type: "extract",
            scope: "page",
            fields: [{ name: "title", target: target("h1") }],
          },
        ],
      }),
    );
    expect(parsed.settings).toMatchObject({ maxPages: 20, maxItems: 1000, stepTimeoutMs: 15_000 });
    expect(parsed.authProfileId).toBeNull();
    const step = parsed.steps[0];
    expect(step?.type === "extract" && step.fields[0]).toMatchObject({
      read: "text",
      attr: null,
      transforms: [],
      required: false,
      target: { frame: [], relativeTo: null },
    });
  });

  it("parses the nested list -> detail -> pagination example", () => {
    const parsed = parseRecording(
      recording({
        params: { keyword: { default: "engineer" } },
        steps: [
          { id: "s1", type: "navigate", url: "https://careers.example/jobs" },
          { id: "s2", type: "fill", target: target("#q"), value: "{{params.keyword}}" },
          { id: "s3", type: "press", key: "Enter" },
          {
            id: "s4",
            type: "paginate",
            mode: "nextButton",
            next: target("a.next"),
            until: "nextMissingOrDisabled",
            body: [
              {
                id: "s5",
                type: "forEach",
                items: target("li.job"),
                body: [
                  {
                    id: "s6",
                    type: "extract",
                    scope: "item",
                    fields: [
                      { name: "title", target: { ...target("a.title"), relativeTo: "item" } },
                    ],
                  },
                  {
                    id: "s7",
                    type: "openDetail",
                    link: { ...target("a.title"), relativeTo: "item" },
                    body: [
                      {
                        id: "s8",
                        type: "extract",
                        scope: "page",
                        fields: [{ name: "description", target: target(".job-body") }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect([...walkSteps(parsed.steps)].map((step) => step.id)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "s7",
      "s8",
    ]);
  });

  it("rejects unknown step types and unknown keys with a readable path", () => {
    expect(issuesOf(recording({ steps: [{ id: "s1", type: "hover" } as never] }))).toMatch(
      /steps\[0\]/,
    );
    expect(issuesOf({ ...recording(), nmae: "typo" })).toMatch(/nmae/);
  });

  it("rejects duplicate step ids, including nested ones", () => {
    const message = issuesOf(
      recording({
        steps: [
          { id: "s1", type: "navigate", url: "https://x.example" },
          {
            id: "s2",
            type: "forEach",
            items: target("li"),
            body: [{ id: "s1", type: "click", target: target("a") }],
          },
        ],
      }),
    );
    expect(message).toMatch(/step "s1": duplicate step id/);
  });

  it.each([
    [{ id: "s1", type: "waitFor" }, /exactly one of/],
    [{ id: "s1", type: "waitFor", ms: 5, urlPattern: "**/jobs" }, /exactly one of/],
    [{ id: "s1", type: "scroll", mode: "by" }, /needs an amount/],
    [{ id: "s1", type: "paginate", mode: "nextButton", body: [] }, /needs next/],
    [
      { id: "s1", type: "paginate", mode: "urlPattern", urlTemplate: "https://x/?p=1", body: [] },
      /\{\{page\}\}/,
    ],
  ])("rejects inconsistent step %j", (step, expected) => {
    expect(issuesOf(recording({ steps: [step as never] }))).toMatch(expected);
  });

  it("rejects a delay range that is upside down", () => {
    expect(issuesOf(recording({ settings: { minDelayMs: 500, maxDelayMs: 100 } }))).toMatch(
      /minDelayMs/,
    );
  });
});

describe("migrations", () => {
  it("rejects documents without a schemaVersion and versions from the future", () => {
    expect(() => migrateRecording({ name: "x" })).toThrow(/schemaVersion/);
    expect(() => migrateRecording([])).toThrow(/JSON object/);
    expect(() => migrateRecording({ schemaVersion: 99 })).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_SCHEMA_VERSION" }),
    );
  });

  it("applies migrations in order up to the target version", () => {
    const migrated = migrateRecording(
      { schemaVersion: 1, title: "Old" },
      {
        1: ({ title, ...rest }) => ({ ...rest, name: title }),
        2: (doc) => ({ ...doc, settings: {} }),
      },
      3,
    );
    expect(migrated).toEqual({ schemaVersion: 3, name: "Old", settings: {} });
  });

  it("fails when a migration step is missing", () => {
    expect(() => migrateRecording({ schemaVersion: 1 }, {}, 2)).toThrow(/No migration/);
  });

  it("parses JSON text and reports invalid JSON", () => {
    expect(parseRecordingJson(JSON.stringify(recording())).name).toBe("Test");
    expect(() => parseRecordingJson("{nope")).toThrow(/not valid JSON/);
  });
});
