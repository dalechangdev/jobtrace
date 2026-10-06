import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import {
  apiSourceFeedUrl,
  isApiSource,
  parseApiSource,
  parseDefinition,
  parseDefinitionJson,
} from "./source.ts";

const source = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "api",
  id: "src_1",
  name: "Acme",
  provider: "greenhouse",
  boardToken: "acme",
  ...overrides,
});

describe("API sources", () => {
  it("applies defaults and builds each provider's feed URL", () => {
    const parsed = parseApiSource(source());
    expect(parsed.settings).toEqual({ maxItems: 5000, respectRobotsTxt: true });
    expect(apiSourceFeedUrl(parsed)).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true&pay_transparency=true",
    );
    expect(apiSourceFeedUrl({ provider: "lever", boardToken: "acme" })).toBe(
      "https://api.lever.co/v0/postings/acme?mode=json",
    );
    expect(apiSourceFeedUrl({ provider: "ashby", boardToken: "acme.co" })).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/acme.co?includeCompensation=true",
    );
    expect(
      apiSourceFeedUrl({
        provider: "lever",
        boardToken: "acme",
        baseUrl: "https://api.eu.lever.co/",
      }),
    ).toBe("https://api.eu.lever.co/v0/postings/acme?mode=json");
    expect(newId("source")).toMatch(/^src_/);
  });

  it("rejects unknown providers, unsafe board tokens and unknown keys", () => {
    expect(() => parseApiSource(source({ provider: "workday" }))).toThrow(/Invalid API source/);
    expect(() => parseApiSource(source({ boardToken: "acme/../admin" }))).toThrow(
      /letters, digits/,
    );
    expect(() => parseApiSource(source({ boardToken: "a b?x=1" }))).toThrow(/letters, digits/);
    expect(() => parseApiSource(source({ baseUrl: "not a url" }))).toThrow(/Invalid API source/);
    expect(() => parseApiSource(source({ steps: [] }))).toThrow(/steps/);
  });

  it("tells API sources and recordings apart when parsing a definition", () => {
    const api = parseDefinition(source());
    expect(isApiSource(api)).toBe(true);
    const recording = parseDefinitionJson(
      JSON.stringify({
        schemaVersion: 1,
        id: "rec_1",
        name: "R",
        startUrl: "https://x.example",
        steps: [],
      }),
    );
    expect(isApiSource(recording)).toBe(false);
    expect(() => parseDefinitionJson("{")).toThrow(/Not valid JSON/);
    expect(() => parseDefinition({ kind: "api" })).toThrow(/Invalid API source/);
  });
});
