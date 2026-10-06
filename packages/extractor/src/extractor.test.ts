import type { RawRecord } from "@jobtrace/core";
import { describe, expect, it } from "vitest";
import { parseDate } from "./date.ts";
import { computeDedupKey, dedupeJobs, inferRemote, normalizeRecord } from "./normalize.ts";
import { formatSalary, parseSalary } from "./salary.ts";
import { applyTransforms } from "./transforms.ts";
import { absoluteUrl, canonicalizeUrl } from "./url.ts";

const NOW = new Date("2026-10-06T15:30:00Z");

describe("canonicalizeUrl", () => {
  it.each([
    ["https://Careers.Acme.EXAMPLE/Jobs/123/", "https://careers.acme.example/Jobs/123"],
    ["https://x.example/jobs/1?utm_source=li&utm_medium=x&id=7", "https://x.example/jobs/1?id=7"],
    ["https://x.example/jobs/1?gh_src=abc&source=feed&ref=home", "https://x.example/jobs/1"],
    ["https://x.example/jobs?b=2&a=1#apply", "https://x.example/jobs?a=1&b=2"],
    ["https://x.example:443/", "https://x.example/"],
    ["https://x.example", "https://x.example/"],
    ["http://user:pw@x.example/a//", "http://x.example/a"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it("resolves relative URLs against a base", () => {
    expect(canonicalizeUrl("/jobs/5?utm_campaign=x", "https://x.example/list?page=2")).toBe(
      "https://x.example/jobs/5",
    );
    expect(absoluteUrl("../a", "https://x.example/b/c")).toBe("https://x.example/a");
  });

  it("returns null for non-http values", () => {
    expect(canonicalizeUrl("mailto:jobs@x.example")).toBeNull();
    expect(canonicalizeUrl("javascript:void(0)")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
  });
});

describe("parseSalary", () => {
  it.each([
    ["€85,000 - €110,000 per year", [85000, 110000, "EUR", "year"]],
    ["$140k - $180k / year", [140000, 180000, "USD", "year"]],
    ["£70,000 - £90,000 per year", [70000, 90000, "GBP", "year"]],
    ["$65 - $80 per hour", [65, 80, "USD", "hour"]],
    ["€95,000 per year", [95000, 95000, "EUR", "year"]],
    ["$140-180k", [140000, 180000, "USD", "year"]],
    ["USD 120K–150K", [120000, 150000, "USD", "year"]],
    ["85.000 € – 100.000 € brutto/Jahr", [85000, 100000, "EUR", "year"]],
    ["60 000 - 75 000 PLN monthly", [60000, 75000, "PLN", "month"]],
    ["£45.50/hr", [45.5, 45.5, "GBP", "hour"]],
    ["CA$120,000.00 annually", [120000, 120000, "CAD", "year"]],
    ["Up to $150k", [null, 150000, "USD", "year"]],
    ["From €70k per annum", [70000, null, "EUR", "year"]],
    ["$100k+", [100000, null, "USD", "year"]],
    ["$1.2m a year", [1200000, 1200000, "USD", "year"]],
    ["$500 per day", [500, 500, "USD", "day"]],
    ["$30", [30, 30, "USD", null]],
  ])("%s", (text, [min, max, currency, period]) => {
    expect(parseSalary(text)).toEqual({ min, max, currency, period });
  });

  it("returns nulls for text that is not a salary", () => {
    const empty = { min: null, max: null, currency: null, period: null };
    expect(parseSalary("Competitive")).toEqual(empty);
    expect(parseSalary("5 years of experience")).toEqual(empty);
    expect(parseSalary("")).toEqual(empty);
    expect(parseSalary("Paid in EUR")).toEqual(empty);
  });

  it("formats a compact form", () => {
    expect(formatSalary(parseSalary("€85,000 - €110,000 per year"))).toBe("85000-110000 EUR/year");
    expect(formatSalary(parseSalary("Up to $150k"))).toBe("<=150000 USD/year");
    expect(formatSalary(parseSalary("Competitive"))).toBeNull();
  });
});

describe("parseDate", () => {
  it.each([
    ["2026-09-14", "2026-09-14T00:00:00.000Z"],
    ["Posted 2026-09-14", "2026-09-14T00:00:00.000Z"],
    ["2026/9/4", "2026-09-04T00:00:00.000Z"],
    ["2026-09-14T08:15:00Z", "2026-09-14T08:15:00.000Z"],
    ["2026-09-14T08:15:00+02:00", "2026-09-14T06:15:00.000Z"],
    ["Sep 14, 2026", "2026-09-14T00:00:00.000Z"],
    ["September 14th 2026", "2026-09-14T00:00:00.000Z"],
    ["14 Sept. 2026", "2026-09-14T00:00:00.000Z"],
    ["Posted on 1st January, 2026", "2026-01-01T00:00:00.000Z"],
    ["14.09.2026", "2026-09-14T00:00:00.000Z"],
    ["09/14/2026", "2026-09-14T00:00:00.000Z"],
    ["14/09/2026", "2026-09-14T00:00:00.000Z"],
    ["today", "2026-10-06T00:00:00.000Z"],
    ["Just posted", "2026-10-06T00:00:00.000Z"],
    ["Yesterday", "2026-10-05T00:00:00.000Z"],
    ["Posted 3 days ago", "2026-10-03T00:00:00.000Z"],
    ["5 hours ago", "2026-10-06T00:00:00.000Z"],
    ["2 weeks ago", "2026-09-22T00:00:00.000Z"],
    ["a month ago", "2026-09-06T00:00:00.000Z"],
    ["30+ days ago", "2026-09-06T00:00:00.000Z"],
    ["Oct 2", "2026-10-02T00:00:00.000Z"],
    ["Dec 20", "2025-12-20T00:00:00.000Z"],
  ])("%s", (text, expected) => {
    expect(parseDate(text, NOW)?.toISOString()).toBe(expected);
  });

  it("returns null for unparseable or impossible dates", () => {
    expect(parseDate("soon", NOW)).toBeNull();
    expect(parseDate("", NOW)).toBeNull();
    expect(parseDate("2026-02-31", NOW)).toBeNull();
  });
});

describe("transforms", () => {
  const context = { baseUrl: "https://x.example/jobs?page=2", now: NOW };

  it("applies transforms in order", () => {
    expect(applyTransforms("  Senior \n  Engineer ", ["trim", "collapseWhitespace"], context)).toBe(
      "Senior Engineer",
    );
    expect(applyTransforms("/jobs/9", ["absoluteUrl"], context)).toBe("https://x.example/jobs/9");
    expect(applyTransforms("Posted 2 days ago", ["parseDate"], context)).toBe(
      "2026-10-04T00:00:00.000Z",
    );
    expect(applyTransforms("$65 - $80 per hour", ["parseSalary"], context)).toBe("65-80 USD/hour");
  });

  it("regex keeps the first capture group, or the whole match", () => {
    expect(applyTransforms("Req ID: R-4471 (EU)", ["regex:R-(\\d+)"], context)).toBe("4471");
    expect(applyTransforms("Req ID: R-4471", ["regex:R-\\d+"], context)).toBe("R-4471");
  });

  it("short-circuits on null and passes null through", () => {
    expect(applyTransforms("no id here", ["regex:R-(\\d+)", "trim"], context)).toBeNull();
    expect(applyTransforms(null, ["trim"], context)).toBeNull();
  });

  it("rejects unknown transforms", () => {
    expect(() => applyTransforms("x", ["shout"], context)).toThrow(/Unknown transform/);
  });
});

describe("inferRemote", () => {
  it.each([
    ["Remote (EU)", "remote"],
    ["Hybrid - London, UK", "hybrid"],
    ["Berlin, Germany", "unknown"],
    ["On-site, Austin TX", "onsite"],
    ["Work from home", "remote"],
  ])("%s -> %s", (text, expected) => {
    expect(inferRemote(text)).toBe(expected);
  });

  it("uses the first text that says anything", () => {
    expect(inferRemote(null, "Berlin", "Remote Support Engineer")).toBe("remote");
  });
});

describe("normalizeRecord", () => {
  const context = { recordingId: "rec_1", now: NOW, defaults: { company: "Acme Robotics" } };
  const record = (fields: RawRecord["fields"]): RawRecord => ({
    fields,
    sourceUrl: "https://careers.acme.example/jobs?page=1",
  });

  it("maps core fields, parses salary and date, and keeps custom fields", () => {
    const job = normalizeRecord(
      record({
        title: "  Senior   Backend Engineer ",
        location: "Remote (EU)",
        salaryText: "€85,000 - €110,000 per year",
        url: "/jobs/123/?utm_source=x",
        description: "Line one  \r\n\r\n\r\n\r\n  Line two",
        postedAt: "Posted 3 days ago",
        employmentType: "Full-time",
        department: " Platform ",
        reqId: null,
      }),
      context,
    );
    expect(job).toEqual({
      recordingId: "rec_1",
      dedupKey: "https://careers.acme.example/jobs/123",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      title: "Senior Backend Engineer",
      company: "Acme Robotics",
      location: "Remote (EU)",
      remote: "remote",
      salaryText: "€85,000 - €110,000 per year",
      salaryMin: 85000,
      salaryMax: 110000,
      salaryCurrency: "EUR",
      salaryPeriod: "year",
      url: "https://careers.acme.example/jobs/123",
      description: "Line one\n\nLine two",
      descriptionHtml: null,
      postedAt: "2026-10-03T00:00:00.000Z",
      employmentType: "Full-time",
      custom: { department: "Platform", reqId: null },
    });
  });

  it("skips records without a title", () => {
    expect(normalizeRecord(record({ title: "   ", location: "Berlin" }), context)).toBeNull();
    expect(normalizeRecord(record({ location: "Berlin" }), context)).toBeNull();
  });

  it("prefers an extracted company over the recording default", () => {
    expect(normalizeRecord(record({ title: "T", company: "Other Co" }), context)?.company).toBe(
      "Other Co",
    );
  });

  it("falls back to a hashed dedup key when there is no URL", () => {
    const a = normalizeRecord(record({ title: "Data Engineer", location: "Madrid" }), context);
    const b = normalizeRecord(record({ title: "data engineer ", location: "Madrid" }), context);
    const c = normalizeRecord(record({ title: "Data Engineer", location: "Berlin" }), context);
    expect(a?.dedupKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b?.dedupKey).toBe(a?.dedupKey);
    expect(c?.dedupKey).not.toBe(a?.dedupKey);
    expect(
      computeDedupKey({
        recordingId: "rec_2",
        url: null,
        title: "Data Engineer",
        company: "Acme Robotics",
        location: "Madrid",
      }),
    ).not.toBe(a?.dedupKey);
  });

  it("changes the content hash when content changes, but not when only the date moves", () => {
    const base = { title: "T", url: "/jobs/1", salaryText: "$100k", postedAt: "3 days ago" };
    const hash = (fields: RawRecord["fields"]) =>
      normalizeRecord(record(fields), context)?.contentHash;
    expect(hash({ ...base, postedAt: "4 days ago" })).toBe(hash(base));
    expect(hash({ ...base, salaryText: "$110k" })).not.toBe(hash(base));
    expect(hash({ ...base, team: "Core" })).not.toBe(hash(base));
  });

  it("dedupes jobs within a run, keeping the first", () => {
    const first = normalizeRecord(record({ title: "A", url: "/jobs/1" }), context);
    const again = normalizeRecord(record({ title: "A (repost)", url: "/jobs/1?ref=x" }), context);
    const other = normalizeRecord(record({ title: "B", url: "/jobs/2" }), context);
    if (!first || !again || !other) throw new Error("expected jobs");
    expect(dedupeJobs([first, again, other])).toEqual([first, other]);
  });
});
