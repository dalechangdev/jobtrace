import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  CHANGED_SALARY,
  changingJobs,
  jobsFor,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { duration, outline, parseSince, table } from "./format.ts";
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
    expect(missing.stderr).toMatch(/No recording matches .*no such file either/);

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

describe("stored recordings, tracked runs and jobs", () => {
  const setVersion = (version: number) =>
    fetch(sites.url(`${SITES.changing}__version/${version}`), { method: "POST" });
  /** Records the changing board through the real recorder: a list with title, url and salary. */
  const recordBoard: MainIo["onSession"] = (session) => {
    void (async () => {
      const { page } = session;
      const ui = page.locator("#__jobtrace-overlay");
      const press = (action: string) => ui.locator(`[data-action="${action}"]`).click();
      const first = page.locator("li.job").first();
      await press("list");
      await first.locator(".loc").click();
      await press("list-use");
      await expect.poll(() => session.status().scope).toBe("list");
      for (const [selector, name, read] of [
        ["a.title", "title", "text"],
        ["a.title", "url", "href"],
        [".salary", "salaryText", "text"],
      ] as const) {
        await first.locator(selector).click();
        await ui.locator('.dialog.open [data-role="name"]').selectOption(name);
        await ui.locator('[data-role="read"]').selectOption(read);
        await press("save");
        await expect.poll(() => session.status().fields).toContain(name);
      }
      await press("stop");
    })();
  };
  let recordingId = "";

  it("record stores the recording and prints its id", async () => {
    await setVersion(1);
    const recorded = await cli(["record", sites.url(SITES.changing), "--name", "Changing board"], {
      recorder: { headless: true, openShadow: true },
      onSession: recordBoard,
    });
    expect(recorded.code).toBe(0);
    recordingId = recorded.stdout.trim();
    expect(recordingId).toMatch(/^rec_/);
    expect(recorded.stderr).toContain(`Replay it with: jobtrace run ${recordingId}`);

    const list = await cli(["recordings", "list"]);
    expect(list.stdout).toMatch(/ID\s+NAME\s+SITE\s+OPEN JOBS\s+LAST RUN/);
    expect(list.stdout).toMatch(
      new RegExp(`${recordingId}\\s+Changing board\\s+127\\.0\\.0\\.1\\s+0\\s+never`),
    );

    const show = await cli(["recordings", "show", "changing board"]);
    expect(show.stdout).toContain(`id         ${recordingId}`);
    expect(show.stdout).toMatch(/s2 {2}forEach\n\s+s3 {2}extract {2}title, url, salaryText/);
  });

  it("run tracks new and changed jobs across runs", async () => {
    const first = await cli(["run", "Changing board"]);
    expect(first.code).toBe(0);
    expect(first.stderr).toMatch(/Run run_\w+ succeeded: 5 job\(s\), 5 new, 0 changed, 0 closed/);
    const firstJobs = JSON.parse(first.stdout) as Array<{
      title: string;
      isNew: boolean;
      id: string;
    }>;
    expect(firstJobs.map((job) => job.title)).toEqual(changingJobs(1).map((job) => job.title));
    expect(firstJobs.every((job) => job.isNew && job.id.startsWith("job_"))).toBe(true);

    await setVersion(2);
    const second = await cli(["run", recordingId.slice(0, 12), "--summary"]);
    expect(second.stderr).toMatch(/5 job\(s\), 1 new, 1 changed, 0 closed/);
    const summary = JSON.parse(second.stdout);
    expect(summary.run).toMatchObject({
      status: "succeeded",
      trigger: "cli",
      stats: { newJobs: 1, changedJobs: 1 },
    });
    const added = changingJobs(2).at(-1)?.title;
    expect(
      summary.jobs
        .filter((job: { isNew: boolean }) => job.isNew)
        .map((job: { title: string }) => job.title),
    ).toEqual([added]);
    expect(summary.jobs.find((job: { isChanged: boolean }) => job.isChanged)).toMatchObject({
      salaryText: CHANGED_SALARY,
    });

    const fresh = await cli(["jobs", "list", "--new"]);
    expect(fresh.stdout).toMatch(/FIRST SEEN\s+TITLE\s+COMPANY\s+LOCATION\s+URL/);
    expect(fresh.stdout.trim().split("\n")).toHaveLength(2);
    expect(fresh.stdout).toContain(added);
    expect(fresh.stderr).toContain("1 of 1 job(s)");

    const all = JSON.parse(
      (await cli(["jobs", "list", "--recording", recordingId, "--json"])).stdout,
    );
    expect(all).toHaveLength(6);
    const search = JSON.parse(
      (await cli(["jobs", "list", "--search", "frontend", "--since", "1h", "--json"])).stdout,
    );
    expect(search.map((job: { title: string }) => job.title)).toEqual(["Frontend Engineer"]);
    expect((await cli(["jobs", "list", "--search", "zzzzz"])).stderr).toContain("No jobs match");
    expect((await cli(["jobs", "list", "--since", "soon"])).stderr).toMatch(/--since expects/);
  });

  it("runs list and show report what happened", async () => {
    const list = await cli(["runs", "list", "--recording", recordingId]);
    const rows = list.stdout.trim().split("\n");
    expect(rows[0]).toMatch(/ID\s+RECORDING\s+STATUS\s+STARTED\s+TOOK\s+JOBS\s+NEW\s+CHANGED/);
    expect(rows).toHaveLength(3);
    // Newest first: the second run, with one new and one changed job.
    expect(rows[1]).toMatch(/Changing board\s+succeeded\s+.*\s5\s+1\s+1$/);
    const runId = rows[1]?.split(/\s+/)[0] ?? "";

    const show = await cli(["runs", "show", runId, "--events"]);
    expect(show.stdout).toContain("jobs       5 (1 new, 1 changed, 0 closed)");
    expect(show.stdout).toMatch(/new\s+Site Reliability Engineer/);
    expect(show.stdout).toMatch(/changed\s+Frontend Engineer/);
    expect(show.stdout).toMatch(/info {2}\[s2\] Found 5 item\(s\)/);
    const json = JSON.parse((await cli(["runs", "show", runId, "--json"])).stdout);
    expect(json.jobs).toHaveLength(5);
    expect(json).not.toHaveProperty("events");
    expect((await cli(["runs", "show", "run_nope"])).stderr).toMatch(/No run matches/);
  });

  it("exports, imports and deletes recordings", async () => {
    const exported = await cli(["recordings", "export", recordingId]);
    const definition = JSON.parse(exported.stdout);
    expect(definition).toMatchObject({ id: recordingId, name: "Changing board", schemaVersion: 1 });

    const file = join(dataDir, "copy.jobtrace.json");
    writeFileSync(file, JSON.stringify({ ...definition, id: "rec_copy", name: "Copy" }));
    const imported = await cli(["recordings", "import", file]);
    expect(imported.stdout.trim()).toBe("rec_copy");
    expect(imported.stderr).toMatch(/Imported "Copy" \(3 steps\)/);
    expect((await cli(["recordings", "import", file])).stderr).toMatch(/Updated "Copy"/);
    expect((await cli(["recordings", "export", "Copy", "--out", file])).stderr).toMatch(
      /already exists/,
    );
    expect((await cli(["recordings", "export", "Copy", "--out", file, "--force"])).code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).id).toBe("rec_copy");

    const dryRun = await cli(["recordings", "delete", recordingId]);
    expect(dryRun.code).toBe(1);
    expect(dryRun.stderr).toMatch(
      /would delete "Changing board" .*2 run\(s\) and 6 job\(s\)\. Nothing was deleted/,
    );
    const deleted = await cli(["recordings", "delete", recordingId, "--yes"]);
    expect(deleted.code).toBe(0);
    const remaining = JSON.parse((await cli(["recordings", "list", "--json"])).stdout);
    expect(remaining.map((item: { id: string }) => item.id)).toEqual(["rec_copy"]);
    expect((await cli(["jobs", "list", "--all"])).stderr).toContain("No jobs match");
    expect((await cli(["runs", "list"])).stderr).toContain("No runs yet");
    expect((await cli(["run", recordingId])).stderr).toMatch(/No recording matches/);
  });

  it("db migrate reports the database location", async () => {
    const result = await cli(["db", "migrate"]);
    expect(result).toMatchObject({ code: 0 });
    expect(result.stderr).toContain(join(dataDir, "jobtrace.db"));
  });
});

describe("helpers", () => {
  it("formats tables, durations and outlines", () => {
    expect(
      table(
        ["A", "LONG HEADER"],
        [
          ["x", 1],
          ["longer value", null],
        ],
      ),
    ).toBe("A             LONG HEADER\nx             1\nlonger value\n");
    expect(table(["A"], [["multi\n  line   text"], ["y".repeat(60)]])).toBe(
      `A\nmulti line text\n${"y".repeat(47)}…\n`,
    );
    expect([duration(250), duration(4200), duration(125_000), duration(null)]).toEqual([
      "250ms",
      "4s",
      "2m05s",
      "",
    ]);
    expect(
      outline([
        { id: "s1", type: "navigate", url: "https://x.example" },
        {
          id: "s2",
          type: "paginate",
          mode: "infiniteScroll",
          body: [{ id: "s3", type: "press", key: "End" }],
        },
      ]),
    ).toEqual([
      "s1  navigate  https://x.example",
      "s2  paginate  infiniteScroll",
      "  s3  press  End",
    ]);
  });

  it("parses --since spans and dates", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    expect(parseSince("36h", now)).toBe("2026-10-05T00:00:00.000Z");
    expect(parseSince("7d", now)).toBe("2026-09-29T12:00:00.000Z");
    expect(parseSince("2w", now)).toBe("2026-09-22T12:00:00.000Z");
    expect(parseSince("2026-10-01", now)).toBe("2026-10-01T00:00:00.000Z");
    expect(() => parseSince("yesterday-ish", now)).toThrow(/--since expects/);
  });
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
