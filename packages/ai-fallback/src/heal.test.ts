import { suggestionsFromEvents } from "@jobtrace/core";
import { runRecording } from "@jobtrace/runner";
import {
  jobsFor,
  type RunningTestSites,
  SITES,
  startTestSites,
  V2_CLASSES,
} from "@jobtrace/test-sites";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anthropicSuggest,
  createAiLocatorResolver,
  type Suggest,
  type SuggestRequest,
} from "./resolver.ts";
import { brokenListDetail, failedLocatorsIn } from "./testing.ts";

let sites: RunningTestSites;
let browser: Browser;

beforeAll(async () => {
  sites = await startTestSites();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
});

/** What each broken selector of the example is called on site 9. */
const RENAMED: Record<string, string> = {
  "li.job": `li.${V2_CLASSES.item}`,
  "a.title": `a.${V2_CLASSES.title}`,
  ".loc": `.${V2_CLASSES.location}`,
  ".type": `.${V2_CLASSES.type}`,
  ".job-body": `.${V2_CLASSES.body}`,
  "dd.salary": `dd.${V2_CLASSES.salary}`,
  "dd.posted": `dd.${V2_CLASSES.posted}`,
};

/** Plays Claude: answers with the renamed selector for the locator that failed. */
function mockedClaude(rename: Record<string, string> = RENAMED) {
  const requests: SuggestRequest[] = [];
  const suggest: Suggest = async (request) => {
    requests.push(request);
    const failed = failedLocatorsIn(request.messages[0].content)[0]?.value ?? "";
    const value = rename[failed];
    return {
      stop_reason: "end_turn",
      parsed_output: {
        found: value !== undefined,
        kind: "css",
        value: value ?? "",
        name: null,
        reason: `${failed} was renamed.`,
      },
    };
  };
  return { suggest, requests };
}

const run = (suggest: Suggest | undefined, path: string = SITES.detailV2, maxCalls = 10) =>
  runRecording(brokenListDetail(), {
    browser,
    now: new Date("2026-10-06T12:00:00Z"),
    params: { baseUrl: sites.origin, path },
    settings: { minDelayMs: 0, maxDelayMs: 0, stepTimeoutMs: 400 },
    tuning: { pollIntervalMs: 25, fallbackGraceMs: 100, optionalFieldTimeoutMs: 150 },
    ...(suggest ? { locatorResolver: createAiLocatorResolver({ suggest, maxCalls }) } : {}),
  });

describe("site 9 with every recorded locator broken", () => {
  it("fails without the plugin", async () => {
    const result = await run(undefined);
    expect(result).toMatchObject({ status: "failed", reason: "locator_not_found" });
    expect(result.jobs).toEqual([]);
  });

  it("is healed by the plugin, reading the same jobs as the unbroken site", async () => {
    const { suggest, requests } = mockedClaude();
    const healed = await run(suggest);
    expect(healed).toMatchObject({ status: "succeeded", stats: { itemsSeen: 8, itemErrors: 0 } });

    // The same recording on site 4, where its locators still work, as the reference.
    const reference = await run(undefined, SITES.detail);
    expect(reference.status).toBe("succeeded");
    const comparable = (jobs: typeof healed.jobs) =>
      jobs.map(({ url, dedupKey, contentHash, ...rest }) => rest);
    expect(comparable(healed.jobs)).toEqual(comparable(reference.jobs));
    expect(healed.jobs.map((job) => job.title)).toEqual(jobsFor("detail").map((job) => job.title));

    // One call per broken target (nine of them), however many items the list has.
    expect(requests).toHaveLength(9);
    const suggestions = suggestionsFromEvents(healed.events);
    // Title and URL read the same link, so their two suggestions are one.
    expect(suggestions).toHaveLength(8);
    expect(suggestions[0]).toEqual({
      stepId: "s2",
      failed: [{ kind: "css", value: "li.job" }],
      locator: { kind: "css", value: `li.${V2_CLASSES.item}` },
      source: "ai",
      reason: "li.job was renamed.",
    });
    expect(new Set(suggestions.map((suggestion) => suggestion.stepId))).toEqual(
      new Set(["s2", "s3", "s4", "s5"]),
    );
  });

  it("sends only trimmed markup: no scripts, styles or page address details", async () => {
    const { suggest, requests } = mockedClaude();
    await run(suggest);
    const prompts = requests.map((request) => request.messages[0].content);
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/<script|<style/);
      expect(prompt.length).toBeLessThan(70_000);
    }
    // The list is looked up in the page; a field of an item only in that item.
    expect(prompts[0]).toContain("the whole page");
    expect(prompts[0]).toContain("<html");
    expect(prompts[1]).toContain("one item of a list");
    expect(prompts[1]).not.toContain("<html");
    expect(prompts[1]).toContain(V2_CLASSES.title);
  });

  it("rejects a suggestion that matches nothing and fails as before", async () => {
    const { suggest } = mockedClaude({ "li.job": "li.not-there" });
    const result = await run(suggest);
    expect(result).toMatchObject({ status: "failed", reason: "locator_not_found" });
    expect(
      result.events.find((event) => event.type === "locator_suggestion_rejected"),
    ).toMatchObject({ stepId: "s2", data: { matches: 0, source: "ai" } });
    expect(suggestionsFromEvents(result.events)).toEqual([]);
  });

  it("stops asking at the call limit; fields left broken stay empty", async () => {
    const { suggest, requests } = mockedClaude();
    // Enough for the list, the title and the URL; the fourth target hits the limit.
    const result = await run(suggest, SITES.detailV2, 3);
    expect(requests).toHaveLength(3);
    expect(
      result.events.filter(
        (event) => event.type === "locator_resolver_error" && /limit of 3/.test(event.message),
      ),
    ).toHaveLength(1);
    expect(result.jobs.every((job) => job.location === undefined)).toBe(true);
  });
});

// Talks to the real API, so it only runs when asked to:
//   AI_FALLBACK_LIVE_TEST=1 ANTHROPIC_API_KEY=... pnpm exec vitest run packages/ai-fallback
const live = process.env.AI_FALLBACK_LIVE_TEST === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!live)("live: Claude heals site 9", () => {
  it("finds the renamed elements", { timeout: 600_000 }, async () => {
    const result = await run(anthropicSuggest(process.env.ANTHROPIC_API_KEY ?? ""));
    expect(result.status).toBe("succeeded");
    expect(result.jobs.map((job) => job.title)).toEqual(jobsFor("detail").map((job) => job.title));
    expect(suggestionsFromEvents(result.events).length).toBeGreaterThanOrEqual(5);
  });
});
