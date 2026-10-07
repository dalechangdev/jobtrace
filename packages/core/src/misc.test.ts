import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { canOpenWindows, isLoopbackHost, loadConfig } from "./config.ts";
import { isJobTraceError, JobTraceError, toJobTraceError } from "./errors.ts";
import { newId, ulid } from "./ids.ts";
import { paramValues, renderTemplate, resolveParams } from "./templating.ts";

describe("templating", () => {
  it("renders placeholders, tolerating inner whitespace", () => {
    const values = paramValues({ keyword: "rust", city: "Berlin" });
    expect(
      renderTemplate("https://x.example/?q={{params.keyword}}&l={{ params.city }}", values),
    ).toBe("https://x.example/?q=rust&l=Berlin");
    expect(renderTemplate("no placeholders", values)).toBe("no placeholders");
  });

  it("throws on unknown placeholders", () => {
    expect(() => renderTemplate("{{params.missing}}", {})).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_ERROR" }),
    );
  });

  it("merges overrides over defaults and rejects undeclared or missing params", () => {
    const declared = { keyword: { default: "engineer" }, city: {} };
    expect(resolveParams(declared, { city: "Madrid" })).toEqual({
      keyword: "engineer",
      city: "Madrid",
    });
    expect(() => resolveParams(declared)).toThrow(/"city" has no default/);
    expect(() => resolveParams(declared, { city: "x", nope: "y" })).toThrow(/Unknown param/);
  });
});

describe("ids", () => {
  it("generates prefixed, time-sortable ULIDs", () => {
    expect(newId("recording")).toMatch(/^rec_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulid(1000) < ulid(2000)).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => ulid())).size).toBe(200);
  });
});

describe("errors", () => {
  it("serializes code, step and details", () => {
    const error = new JobTraceError("LOCATOR_NOT_FOUND", "nope", {
      stepId: "s3",
      details: { tried: 2 },
    });
    expect(error.toJSON()).toEqual({
      code: "LOCATOR_NOT_FOUND",
      message: "nope",
      stepId: "s3",
      details: { tried: 2 },
    });
    expect(isJobTraceError(error, "LOCATOR_NOT_FOUND")).toBe(true);
    expect(isJobTraceError(error, "BOT_WALL")).toBe(false);
  });

  it("wraps foreign errors and keeps its own", () => {
    const own = new JobTraceError("BOT_WALL", "blocked");
    expect(toJobTraceError(own)).toBe(own);
    expect(toJobTraceError(new Error("boom")).toJSON()).toEqual({
      code: "STEP_FAILED",
      message: "boom",
    });
    expect(toJobTraceError("text", "NAVIGATION_FAILED").code).toBe("NAVIGATION_FAILED");
  });
});

describe("config", () => {
  it("uses documented defaults", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      dataDir: `${homedir()}/.jobtrace`,
      databaseUrl: `file:${homedir()}/.jobtrace/jobtrace.db`,
      host: "127.0.0.1",
      port: 4317,
      maxConcurrentRuns: 2,
      defaultMinDelayMs: 1000,
      defaultMaxDelayMs: 3000,
      artifactRetentionRuns: 20,
      aiFallback: { enabled: false, maxCalls: 10, autoApply: false },
      logLevel: "info",
    });
  });

  it("reads overrides, resolving relative data dirs and ignoring blank values", () => {
    const config = loadConfig(
      { DATA_DIR: "data", PORT: "8080", AI_FALLBACK_ENABLED: "true", LOG_LEVEL: "" },
      "/srv/app",
    );
    expect(config.dataDir).toBe("/srv/app/data");
    expect(config.port).toBe(8080);
    expect(config.aiFallback.enabled).toBe(true);
    expect(loadConfig({ AI_FALLBACK_AUTO_APPLY: "1" }).aiFallback.autoApply).toBe(true);
    expect(config.logLevel).toBe("info");
  });

  it("requires a token for non-loopback hosts", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/API_TOKEN is required/);
    expect(loadConfig({ HOST: "0.0.0.0", API_TOKEN: "secret" }).apiToken).toBe("secret");
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  it("lets a container listen on all interfaces without a token when it only answers to localhost", () => {
    const docker = loadConfig({
      HOST: "0.0.0.0",
      ALLOWED_HOSTS: " localhost, 127.0.0.1 ",
      HEADLESS_ONLY: "true",
    });
    expect(docker).toMatchObject({
      allowedHosts: ["localhost", "127.0.0.1"],
      headlessOnly: true,
      apiToken: undefined,
    });
    // No screen there, so no browser windows, even though it is "local".
    expect(canOpenWindows(docker)).toBe(false);
    expect(canOpenWindows(loadConfig({}))).toBe(true);
    expect(canOpenWindows(loadConfig({ HOST: "0.0.0.0", API_TOKEN: "x" }))).toBe(false);
    // A public name in the list means it is exposed after all: the token is required again.
    expect(() =>
      loadConfig({ HOST: "0.0.0.0", ALLOWED_HOSTS: "localhost,jobs.example.com" }),
    ).toThrow(/API_TOKEN is required/);
    expect(
      loadConfig({ HOST: "0.0.0.0", ALLOWED_HOSTS: "jobs.example.com", API_TOKEN: "x" })
        .allowedHosts,
    ).toEqual(["jobs.example.com"]);
    expect(loadConfig({}).allowedHosts).toEqual([]);
  });

  it("rejects invalid values", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIG" }),
    );
    expect(() => loadConfig({ DEFAULT_MIN_DELAY_MS: "5000" })).toThrow(/must not exceed/);
  });
});
