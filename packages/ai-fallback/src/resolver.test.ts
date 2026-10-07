import Anthropic from "@anthropic-ai/sdk";
import { type LocatorResolverContext, loadConfig, type Target } from "@jobtrace/core";
import { describe, expect, it } from "vitest";
import { aiHealing } from "./index.ts";
import {
  type Answer,
  buildPrompt,
  createAiLocatorResolver,
  DEFAULT_AI_MODEL,
  type Suggest,
  type SuggestRequest,
  toLocator,
} from "./resolver.ts";

const target: Target = {
  locators: [
    { kind: "css", value: "a.title" },
    { kind: "role", role: "link", name: "Apply" },
  ],
  fingerprint: {
    tag: "a",
    text: "Senior Robotics Engineer",
    attrs: { class: "title", href: "/jobs/1" },
    ancestorTrail: ["ul.jobs", "li.job"],
  },
  frame: [],
  relativeTo: "item",
};

const context: LocatorResolverContext = {
  pageSnapshot: '<li class="css-9d2kq0"><a class="css-k3v1ab" href="/jobs/1">Engineer</a></li>',
  scope: "item",
  url: "https://jobs.example.com/board?session=secret-token#frag",
  stepId: "s3",
  list: false,
};

const answer = (overrides: Partial<Answer> = {}): Answer => ({
  found: true,
  kind: "css",
  value: "a.css-k3v1ab",
  name: null,
  reason: "The only link in the item.",
  ...overrides,
});

/** A stand-in for the Claude call that records what it was sent. */
function fake(reply: Partial<Awaited<ReturnType<Suggest>>> | Error = {}) {
  const requests: SuggestRequest[] = [];
  const options: Parameters<Suggest>[1][] = [];
  const suggest: Suggest = async (request, callOptions) => {
    requests.push(request);
    options.push(callOptions);
    if (reply instanceof Error) throw reply;
    return { stop_reason: "end_turn", parsed_output: answer(), ...reply };
  };
  return { suggest, requests, options };
}

describe("toLocator", () => {
  it("turns an answer into a recording locator", () => {
    expect(toLocator(answer())).toEqual({ kind: "css", value: "a.css-k3v1ab" });
    expect(toLocator(answer({ kind: "testId", value: " job-title " }))).toEqual({
      kind: "testId",
      value: "job-title",
    });
    expect(toLocator(answer({ kind: "role", value: "button", name: "Next page" }))).toEqual({
      kind: "role",
      role: "button",
      name: "Next page",
    });
    expect(toLocator(answer({ kind: "role", value: "listitem" }))).toEqual({
      kind: "role",
      role: "listitem",
    });
  });

  it("gives nothing when the element was not found or the value is empty", () => {
    expect(toLocator(answer({ found: false }))).toBeNull();
    expect(toLocator(answer({ value: "  " }))).toBeNull();
  });
});

describe("buildPrompt", () => {
  it("carries the fingerprint, the failed locators and the snapshot", () => {
    const prompt = buildPrompt(target, context);
    expect(prompt).toContain('"text": "Senior Robotics Engineer"');
    expect(prompt).toContain('"value": "a.title"');
    expect(prompt).toContain(context.pageSnapshot);
    expect(prompt).toContain("one item of a list");
    expect(prompt).toContain("exactly one element");
    expect(buildPrompt(target, { ...context, list: true, scope: "page" })).toContain(
      "every item of the list",
    );
  });

  it("sends the page address without its query string or fragment", () => {
    const prompt = buildPrompt(target, context);
    expect(prompt).toContain("<page_url>https://jobs.example.com/board</page_url>");
    expect(prompt).not.toContain("secret-token");
    expect(buildPrompt(target, { ...context, url: "not a url" })).toContain(
      "<page_url></page_url>",
    );
  });

  it("copes with a target that has no fingerprint", () => {
    const { fingerprint: _, ...bare } = target;
    expect(buildPrompt(bare, context)).toContain("none was recorded");
  });
});

describe("createAiLocatorResolver", () => {
  it("asks Claude once and returns its locator as an AI suggestion", async () => {
    const { suggest, requests, options } = fake();
    const controller = new AbortController();
    const resolver = createAiLocatorResolver({ suggest });
    expect(await resolver.resolve(target, { ...context, signal: controller.signal })).toEqual({
      locator: { kind: "css", value: "a.css-k3v1ab" },
      source: "ai",
      reason: "The only link in the item.",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: DEFAULT_AI_MODEL,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    expect(requests[0]?.messages[0].content).toBe(
      buildPrompt(target, { ...context, signal: controller.signal }),
    );
    expect(requests[0]?.system).toContain("untrusted");
    expect(options[0]?.signal).toBe(controller.signal);
  });

  it("uses the configured model", async () => {
    const { suggest, requests } = fake();
    await createAiLocatorResolver({ suggest, model: "claude-sonnet-5-5" }).resolve(target, context);
    expect(requests[0]?.model).toBe("claude-sonnet-5-5");
  });

  it("returns nothing when Claude cannot find the element", async () => {
    const { suggest } = fake({ parsed_output: answer({ found: false, value: "" }) });
    expect(await createAiLocatorResolver({ suggest }).resolve(target, context)).toBeNull();
  });

  it("stops calling at the per-run limit and says so once", async () => {
    const { suggest, requests } = fake();
    const resolver = createAiLocatorResolver({ suggest, maxCalls: 2 });
    await resolver.resolve(target, context);
    await resolver.resolve(target, context);
    await expect(resolver.resolve(target, context)).rejects.toThrow(/limit of 2 call/);
    expect(await resolver.resolve(target, context)).toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("makes no call at all with a limit of zero", async () => {
    const { suggest, requests } = fake();
    const resolver = createAiLocatorResolver({ suggest, maxCalls: 0 });
    await expect(resolver.resolve(target, context)).rejects.toThrow(/limit/);
    expect(requests).toHaveLength(0);
  });

  it("reports a refusal and an incomplete answer as errors", async () => {
    await expect(
      createAiLocatorResolver({ suggest: fake({ stop_reason: "refusal" }).suggest }).resolve(
        target,
        context,
      ),
    ).rejects.toThrow(/declined/);
    await expect(
      createAiLocatorResolver({ suggest: fake({ parsed_output: null }).suggest }).resolve(
        target,
        context,
      ),
    ).rejects.toThrow(/incomplete/);
    await expect(
      createAiLocatorResolver({ suggest: fake({ stop_reason: "max_tokens" }).suggest }).resolve(
        target,
        context,
      ),
    ).rejects.toThrow(/incomplete/);
  });

  it("explains API failures without leaking request details", async () => {
    const headers = new Headers();
    const failing = (error: Error) =>
      createAiLocatorResolver({ suggest: fake(error).suggest }).resolve(target, context);
    await expect(
      failing(new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", headers)),
    ).rejects.toThrow(/API key was rejected/);
    await expect(
      failing(new Anthropic.RateLimitError(429, undefined, "slow down", headers)),
    ).rejects.toThrow(/rate limited/);
    await expect(failing(new Anthropic.APIConnectionError({ message: "offline" }))).rejects.toThrow(
      /could not reach/,
    );
    await expect(
      failing(new Anthropic.InternalServerError(500, undefined, "boom", headers)),
    ).rejects.toThrow(/answered 500/);
    await expect(failing(new Error("odd"))).rejects.toThrow("AI fallback: odd");
  });
});

describe("aiHealing", () => {
  const config = (env: Record<string, string>) => loadConfig({ DATA_DIR: "/tmp/jobtrace", ...env });

  it("is unavailable without an API key", () => {
    expect(aiHealing(config({ AI_FALLBACK_ENABLED: "true" }))).toBeUndefined();
  });

  it("hands out no resolver while switched off", () => {
    const healing = aiHealing(config({ ANTHROPIC_API_KEY: "sk-ant-test" }));
    expect(healing?.createResolver()).toBeUndefined();
    expect(healing?.autoApply).toBe(false);
  });

  it("hands out a fresh resolver per run when enabled, with the configured limits", async () => {
    const { suggest, requests } = fake();
    const healing = aiHealing(
      config({
        AI_FALLBACK_ENABLED: "true",
        AI_FALLBACK_MODEL: "claude-haiku-4-5",
        AI_FALLBACK_MAX_CALLS: "1",
        AI_FALLBACK_AUTO_APPLY: "true",
      }),
      { suggest },
    );
    expect(healing?.autoApply).toBe(true);
    const first = healing?.createResolver();
    await first?.resolve(target, context);
    await expect(first?.resolve(target, context)).rejects.toThrow(/limit of 1/);
    // The next run starts with a full allowance.
    expect(await healing?.createResolver()?.resolve(target, context)).not.toBeNull();
    expect(requests.map((request) => request.model)).toEqual([
      "claude-haiku-4-5",
      "claude-haiku-4-5",
    ]);
  });

  it("follows a switch that is read before every run", () => {
    let on = false;
    const healing = aiHealing(config({}), { suggest: fake().suggest, enabled: () => on });
    expect(healing?.createResolver()).toBeUndefined();
    on = true;
    expect(healing?.createResolver()).toBeDefined();
  });
});
