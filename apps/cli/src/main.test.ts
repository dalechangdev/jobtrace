import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { jobsFor, type RunningTestSites, startTestSites } from "@jobtrace/test-sites";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MainIo, main } from "./main.ts";
import { defaultFileName, normalizeUrl } from "./record-command.ts";
import { exitCodeFor, parseParams } from "./run-command.ts";

const example = (name: string) =>
  fileURLToPath(new URL(`../../../examples/recordings/${name}.jobtrace.json`, import.meta.url));

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

let sites: RunningTestSites;
let dataDir: string;

beforeAll(async () => {
  sites = await startTestSites();
  dataDir = mkdtempSync(join(tmpdir(), "jobtrace-cli-"));
});
afterAll(async () => {
  await sites?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function cli(argv: string[], io: MainIo = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { DATA_DIR: dataDir, LOG_LEVEL: "info" },
    cwd: dataDir,
    ...io,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe("jobtrace run", () => {
  it("prints the extracted jobs as JSON and logs to stderr", async () => {
    const result = await cli(["run", example("static-list"), "--param", `baseUrl=${sites.origin}`]);
    expect(result.code).toBe(0);
    const jobs = JSON.parse(result.stdout) as Array<{ title: string }>;
    expect(jobs.map((job) => job.title)).toEqual(jobsFor("staticList").map((job) => job.title));
    const lastLog = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "{}");
    expect(lastLog).toMatchObject({ type: "run_finished", data: { status: "succeeded" } });
  });

  it("applies limits and prints a summary on request", async () => {
    const result = await cli([
      "run",
      example("paginated"),
      "--param",
      `baseUrl=${sites.origin}`,
      "--max-items",
      "3",
      "--summary",
    ]);
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({ status: "succeeded", stats: { jobs: 3 } });
    expect(summary.jobs).toHaveLength(3);
  });

  it("exits 1 with a readable message for a missing or invalid recording", async () => {
    const missing = await cli(["run", join(dataDir, "nope.jobtrace.json")]);
    expect(missing).toMatchObject({ code: 1, stdout: "" });
    expect(missing.stderr).toMatch(/Cannot read recording file/);

    const file = join(dataDir, "bad.jobtrace.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        id: "x",
        name: "x",
        startUrl: "x",
        steps: [{ id: "a", type: "teleport" }],
      }),
    );
    const invalid = await cli(["run", file]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/Invalid recording/);
  });

  it("exits 1 and still prints JSON when the run fails", async () => {
    const result = await cli([
      "run",
      example("static-list"),
      "--param",
      `baseUrl=${sites.origin}/missing`,
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stderr).toMatch(/HTTP 404/);
  });

  it("rejects malformed options", async () => {
    expect((await cli(["run", example("static-list"), "--param", "novalue"])).stderr).toMatch(
      /key=value/,
    );
    expect((await cli(["run", example("static-list"), "--max-pages", "0"])).code).toBe(1);
    expect((await cli(["run"])).code).toBe(1);
  });
});

describe("jobtrace record", () => {
  /** Drives the recorder like a user: mark the first job's title, then press Stop. */
  const markTitleAndStop: MainIo["onSession"] = (session) => {
    void (async () => {
      const ui = session.page.locator("#__jobtrace-overlay");
      await ui.locator('[data-action="mark"]').click();
      await session.page.locator("li.job .title").first().click();
      await ui.locator('[data-action="save"]').click();
      await expect.poll(() => session.status().fields).toEqual(["title"]);
      await ui.locator('[data-action="stop"]').click();
    })();
  };
  const recorder = { headless: true, openShadow: true };

  it("saves a recording file that jobtrace run can replay", async () => {
    const out = join(dataDir, "recorded.jobtrace.json");
    const recorded = await cli(
      ["record", sites.url("/static-list/"), "--name", "My board", "--out", out],
      {
        recorder,
        onSession: markTitleAndStop,
      },
    );
    expect(recorded.code).toBe(0);
    expect(recorded.stdout.trim()).toBe(out);
    expect(recorded.stderr).toMatch(/Saved "My board": 2 step\(s\), 1 field\(s\)/);
    expect(recorded.stderr).toContain(`title: ${jobsFor("staticList")[0]?.title}`);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      schemaVersion: 1,
      name: "My board",
    });

    const replayed = await cli(["run", out]);
    expect(replayed.code).toBe(0);
    expect(JSON.parse(replayed.stdout)).toMatchObject([{ title: jobsFor("staticList")[0]?.title }]);
  });

  it("refuses to overwrite an existing file before opening a browser, unless forced", async () => {
    const out = join(dataDir, "exists.jobtrace.json");
    writeFileSync(out, "{}");
    const refused = await cli(["record", sites.url("/static-list/"), "--out", out], { recorder });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/already exists/);
    expect(readFileSync(out, "utf8")).toBe("{}");

    const forced = await cli(["record", sites.url("/static-list/"), "--out", out, "--force"], {
      recorder,
      onSession: (session) => void session.stop(),
    });
    expect(forced.code).toBe(0);
    expect(forced.stderr).toMatch(/no fields were marked/);
    expect(JSON.parse(readFileSync(out, "utf8")).steps).toHaveLength(1);
  });

  it("names the file after the recording and never overwrites without --out", async () => {
    const run = () =>
      cli(["record", sites.url("/static-list/")], {
        recorder,
        onSession: (session) => void session.stop(),
      });
    expect((await run()).stdout.trim()).toBe(join(dataDir, "jobs-at-acme-robotics.jobtrace.json"));
    expect((await run()).stdout.trim()).toBe(
      join(dataDir, "jobs-at-acme-robotics-2.jobtrace.json"),
    );
  });

  it("rejects URLs it cannot record", async () => {
    expect((await cli(["record", "ftp://example.com/jobs"])).stderr).toMatch(/Only http and https/);
    expect(normalizeUrl("careers.example.com/jobs")).toBe("https://careers.example.com/jobs");
    expect(() => normalizeUrl("http://")).toThrow(/not a valid URL/);
    expect(defaultFileName("Acme Careers – Engineering!")).toBe(
      "acme-careers-engineering.jobtrace.json",
    );
    expect(defaultFileName("???")).toBe("recording.jobtrace.json");
  });
});

describe("helpers", () => {
  it("maps statuses to exit codes", () => {
    expect([
      exitCodeFor("succeeded"),
      exitCodeFor("partial"),
      exitCodeFor("failed"),
      exitCodeFor("blocked"),
    ]).toEqual([0, 2, 1, 1]);
  });

  it("parses params, keeping '=' inside values", () => {
    expect(parseParams(["a=1", "url=https://x.example/?q=1"])).toEqual({
      a: "1",
      url: "https://x.example/?q=1",
    });
  });
});
