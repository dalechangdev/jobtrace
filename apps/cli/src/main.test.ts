import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { type RunningServer, startServer } from "@jobtrace/api";
import { loadConfig } from "@jobtrace/core";
import { type Database, openDatabase } from "@jobtrace/db";
import {
  ATS_PATHS,
  CHANGED_SALARY,
  changingJobs,
  jobsFor,
  LOGIN_CREDENTIALS,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import type { Page } from "playwright";
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
      schemaVersion: 2,
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
    expect(list.stdout).toMatch(/ID\s+TYPE\s+NAME\s+SITE\s+OPEN JOBS\s+LAST RUN/);
    expect(list.stdout).toMatch(
      new RegExp(`${recordingId}\\s+recording\\s+Changing board\\s+127\\.0\\.0\\.1\\s+0\\s+never`),
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
    expect(definition).toMatchObject({ id: recordingId, name: "Changing board", schemaVersion: 2 });

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

describe("saved logins and politeness", () => {
  const recorder = { headless: true, openShadow: true };
  const ui = (page: Page) => page.locator("#__jobtrace-overlay");
  const logIn: MainIo["onAuthCapture"] = (capture) => {
    void (async () => {
      const { page } = capture;
      await page.locator('input[name="username"]').fill(LOGIN_CREDENTIALS.username);
      await page.locator('input[name="password"]').fill(LOGIN_CREDENTIALS.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByTestId("signed-in").waitFor();
      await ui(page).locator('[data-action="auth-save"]').click();
    })();
  };
  let boardId = "";

  it("auth create saves a login without recording the password", async () => {
    const created = await cli(
      ["auth", "create", "Acme intranet", "--url", sites.url(`${SITES.login}signin`)],
      {
        recorder,
        onAuthCapture: logIn,
      },
    );
    expect(created.code).toBe(0);
    const id = created.stdout.trim();
    expect(id).toMatch(/^auth_/);
    expect(created.stderr).toContain('Saved login "Acme intranet" for 127.0.0.1');

    const file = join(dataDir, "auth", `${id}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const state = readFileSync(file, "utf8");
    expect(state).toContain("jobtrace_session");
    expect(state + created.stderr + created.stdout).not.toContain(LOGIN_CREDENTIALS.password);

    const list = await cli(["auth", "list"]);
    expect(list.stdout).toMatch(
      /Acme intranet\s+127\.0\.0\.1\s+\S+ \S+\s+not checked yet\s+0 recordings/,
    );
    expect(
      (await cli(["auth", "create", "acme intranet", "--url", sites.url(SITES.login)])).stderr,
    ).toMatch(/already exists\. Use: jobtrace auth refresh/);
  });

  it("record --auth starts logged in and stores the logged-in check", async () => {
    const recorded = await cli(
      ["record", sites.url(SITES.login), "--auth", "Acme intranet", "--name", "Internal board"],
      {
        recorder,
        onSession: (session) => {
          void (async () => {
            const { page } = session;
            const press = (action: string) => ui(page).locator(`[data-action="${action}"]`).click();
            // Already signed in: the board is there, not the sign-in form.
            await page.locator("li.job").first().waitFor();
            await press("auth-check");
            await page.getByTestId("signed-in").click();
            await expect.poll(() => session.status().auth).toEqual({ hasCheck: true });
            await press("list");
            await page.locator("li.job .loc").first().click();
            await press("list-use");
            await expect.poll(() => session.status().scope).toBe("list");
            await page.locator("li.job .title").first().click();
            await press("save");
            await expect.poll(() => session.status().fields).toEqual(["title"]);
            await press("stop");
          })();
        },
      },
    );
    expect(recorded.code).toBe(0);
    expect(recorded.stderr).toContain('Logged in as "Acme intranet"');
    expect(recorded.stderr).not.toContain("no logged-in check");
    boardId = recorded.stdout.trim();
    const definition = JSON.parse((await cli(["recordings", "export", boardId])).stdout);
    expect(definition.authProfileId).toMatch(/^auth_/);
    expect(definition.loggedInCheck.locators[0]).toEqual({ kind: "testId", value: "signed-in" });
    expect((await cli(["auth", "list"])).stdout).toMatch(/1 recording\b/);
  });

  it("run uses the saved login, and reports an expired one with what to do", async () => {
    const working = await cli(["run", boardId]);
    expect(working.code).toBe(0);
    expect(JSON.parse(working.stdout).map((job: { title: string }) => job.title)).toEqual(
      jobsFor("login").map((job) => job.title),
    );
    expect((await cli(["auth", "list"])).stdout).not.toContain("not checked yet");

    await fetch(sites.url(`${SITES.login}__invalidate`), { method: "POST" });
    const expired = await cli(["run", boardId, "--summary"]);
    expect(expired.code).toBe(1);
    expect(JSON.parse(expired.stdout).run).toMatchObject({
      status: "failed",
      reason: "auth_expired",
    });
    expect(expired.stderr).toMatch(/saved login has expired/);
    expect(expired.stderr).toContain('Renew the login with: jobtrace auth refresh "Acme intranet"');
  }, 60_000);

  it("auth refresh renews the session, and auth delete removes it", async () => {
    const refreshed = await cli(
      ["auth", "refresh", "acme intranet", "--url", sites.url(`${SITES.login}signin`)],
      {
        recorder,
        onAuthCapture: logIn,
      },
    );
    expect(refreshed.code).toBe(0);
    expect((await cli(["run", boardId])).code).toBe(0);

    const cancelled = await cli(
      ["auth", "refresh", "Acme intranet", "--url", sites.url(SITES.login)],
      {
        recorder,
        onAuthCapture: (capture) => void capture.cancel(),
      },
    );
    expect(cancelled).toMatchObject({ code: 1, stdout: "" });
    expect(cancelled.stderr).toContain("Cancelled; nothing was saved.");

    const id = JSON.parse((await cli(["auth", "list", "--json"])).stdout)[0].id as string;
    expect((await cli(["auth", "delete", "Acme intranet"])).code).toBe(0);
    expect(existsSync(join(dataDir, "auth", `${id}.json`))).toBe(false);
    expect((await cli(["auth", "list"])).stderr).toContain("No saved logins");
    const orphaned = await cli(["run", boardId]);
    expect(orphaned.code).toBe(1);
    expect(orphaned.stderr).toMatch(/auth profile that no longer exists/);
    expect((await cli(["record", sites.url(SITES.login), "--auth", "nope"])).stderr).toMatch(
      /No auth profile matches/,
    );
  }, 60_000);

  it("run reports a robots.txt refusal and a bot wall, with the screenshot's path", async () => {
    const file = (name: string, path: string) => {
      const target = join(dataDir, `${name}.jobtrace.json`);
      writeFileSync(
        target,
        JSON.stringify({
          schemaVersion: 2,
          id: `rec_${name}`,
          name,
          startUrl: sites.url(path),
          settings: { minDelayMs: 0, maxDelayMs: 0 },
          steps: [{ id: "s1", type: "navigate", url: sites.url(path) }],
        }),
      );
      return target;
    };
    await cli(["recordings", "import", file("disallowed", SITES.robotsDisallowed)]);
    const refused = await cli(["run", "disallowed"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/failed: 0 job/);
    expect(refused.stderr).toMatch(/robots\.txt disallows \/disallowed\//);
    // The same recording as a one-off file run is refused as well.
    expect((await cli(["run", file("disallowed", SITES.robotsDisallowed)])).stderr).toMatch(
      /robots\.txt disallows/,
    );

    await cli(["recordings", "import", file("walled", SITES.botWall)]);
    const blocked = await cli(["run", "walled"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toMatch(/blocked: 0 job/);
    expect(blocked.stderr).toMatch(/anti-bot check/);
    const shot = /Screenshot: (\S+\.png)/.exec(blocked.stderr)?.[1] ?? "";
    expect(existsSync(shot)).toBe(true);
    expect((await cli(["runs", "list"])).stdout).toMatch(/walled\s+blocked \(bot_wall\)/);
  });
});

describe("jobtrace serve", () => {
  it("serves the API, executes queued runs, and shuts down on interrupt", async () => {
    await fetch(sites.url(`${SITES.changing}__version/1`), { method: "POST" });
    const file = join(dataDir, "queued.jobtrace.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        id: "rec_queued",
        name: "Queued board",
        startUrl: sites.url(SITES.changing),
        settings: { minDelayMs: 0, maxDelayMs: 0 },
        steps: [
          { id: "s1", type: "navigate", url: sites.url(SITES.changing) },
          {
            id: "s2",
            type: "forEach",
            items: { locators: [{ kind: "css", value: "li.job" }] },
            body: [
              {
                id: "s3",
                type: "extract",
                scope: "item",
                fields: [
                  {
                    name: "title",
                    target: { locators: [{ kind: "css", value: ".title" }], relativeTo: "item" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    await cli(["recordings", "import", file]);

    // Queued from the command line; nothing runs until a server is up.
    const queued = await cli(["run", "Queued board", "--queue"]);
    expect(queued.code).toBe(0);
    const runId = queued.stdout.trim();
    expect(runId).toMatch(/^run_/);
    expect(queued.stderr).toMatch(
      /Queued run run_\w+ of "Queued board"\. It starts when `jobtrace serve` is running/,
    );
    expect((await cli(["runs", "show", runId])).stdout).toContain("status     queued");

    const controller = new AbortController();
    let observed: Record<string, unknown> = {};
    const served = await cli(["serve"], {
      signal: controller.signal,
      server: { port: 0, worker: { pollIntervalMs: 50 } },
      onServer: (server) => {
        void (async () => {
          try {
            const health = await (await fetch(`${server.url}/api/health`)).json();
            await server.worker.idle();
            const run = await (await fetch(`${server.url}/api/runs/${runId}`)).json();
            const docs = await fetch(`${server.url}/api/docs/json`);
            observed = { health, run, docs: docs.status, url: server.url };
          } finally {
            controller.abort();
          }
        })();
      },
    });
    expect(served.code).toBe(0);
    expect(served.stderr).toMatch(/JobTrace is listening on http:\/\/127\.0\.0\.1:\d+/);
    expect(served.stderr).toContain("Stopping: cancelling running runs and closing.");
    expect(observed.health).toMatchObject({ status: "ok" });
    expect(observed.docs).toBe(200);
    expect(observed.run).toMatchObject({
      run: { status: "succeeded", trigger: "cli", stats: { jobs: 5 } },
    });
    // The port is released: the server really stopped.
    await expect(fetch(`${observed.url}/api/health`)).rejects.toThrow();
  }, 60_000);

  it("refuses to listen beyond localhost without a token", async () => {
    const result = await cli(["serve", "--host", "0.0.0.0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /API_TOKEN is required when HOST \(0\.0\.0\.0\) is not a loopback address/,
    );
    expect((await cli(["serve", "--port", "0"])).code).toBe(1);
  });
});

describe("jobtrace schedule", () => {
  it("adds, lists, pauses, resumes and removes schedules", async () => {
    const file = join(dataDir, "scheduled.jobtrace.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        id: "rec_scheduled",
        name: "Scheduled board",
        startUrl: sites.url(SITES.changing),
        steps: [],
      }),
    );
    await cli(["recordings", "import", file]);

    const added = await cli([
      "schedule",
      "add",
      "Scheduled board",
      "--cron",
      "0 8 * * 1-5",
      "--tz",
      "Europe/Madrid",
    ]);
    expect(added.code).toBe(0);
    const id = added.stdout.trim();
    expect(id).toMatch(/^sch_/);
    expect(added.stderr).toContain('Scheduled "Scheduled board": Weekdays at 08:00 Europe/Madrid');
    expect(added.stderr).toMatch(/Next runs: \d{4}-\d\d-\d\d \d\d:\d\d, /);
    expect(added.stderr).toContain("Schedules only fire while `jobtrace serve` is running");

    const list = await cli(["schedule", "list"]);
    expect(list.stdout).toMatch(/ID\s+RECORDING\s+WHEN\s+NEXT RUN\s+LAST RUN/);
    expect(list.stdout).toMatch(
      new RegExp(
        `${id}\\s+Scheduled board\\s+Weekdays at 08:00 Europe/Madrid\\s+\\d{4}-.*\\s+never`,
      ),
    );

    expect((await cli(["schedule", "pause", id.slice(0, 10)])).stderr).toContain(
      `Paused schedule ${id}.`,
    );
    expect((await cli(["schedule", "list"])).stdout).toMatch(/Europe\/Madrid\s+paused\s+never/);
    expect(JSON.parse((await cli(["schedule", "list", "--json"])).stdout)).toMatchObject([
      { id, enabled: false, nextRuns: [] },
    ]);
    expect((await cli(["schedule", "resume", id])).code).toBe(0);

    expect(
      (await cli(["schedule", "add", "Scheduled board", "--cron", "* * * * *"])).stderr,
    ).toMatch(/at most every 15 minutes/);
    expect(
      (await cli(["schedule", "add", "Scheduled board", "--cron", "0 8 * * *", "--tz", "Nowhere"]))
        .stderr,
    ).toMatch(/not a known time zone/);
    expect((await cli(["schedule", "add", "nope", "--cron", "0 8 * * *"])).stderr).toMatch(
      /No recording matches/,
    );
    expect((await cli(["schedule", "remove", "sch_nope"])).stderr).toMatch(/No schedule matches/);

    expect((await cli(["schedule", "remove", id])).stderr).toContain(`Removed schedule ${id}.`);
    expect((await cli(["schedule", "list"])).stderr).toContain("No schedules.");
  });

  it("a running server picks up a schedule added from the command line", async () => {
    const added = await cli(["schedule", "add", "rec_scheduled", "--cron", "0 8 * * *"]);
    const id = added.stdout.trim();
    const controller = new AbortController();
    let registered: string[] = [];
    await cli(["serve"], {
      signal: controller.signal,
      server: { port: 0, scheduleSyncMs: 50, worker: { pollIntervalMs: 50 } },
      onServer: (server) => {
        void (async () => {
          try {
            const first = server.scheduler.registered();
            // Added while the server is already running, straight into the database.
            const second = (
              await cli(["schedule", "add", "rec_scheduled", "--cron", "0 9 * * *"])
            ).stdout.trim();
            await expect
              .poll(() => server.scheduler.registered().sort())
              .toEqual([id, second].sort());
            registered = first;
          } finally {
            controller.abort();
          }
        })();
      },
    });
    expect(registered).toEqual([id]);
  }, 30_000);
});

describe("sending results to a server without a screen", () => {
  let remote: RunningServer;
  let remoteDir: string;
  let remoteDb: Database;
  const recorder = { headless: true, openShadow: true };
  const ui = (page: Page) => page.locator("#__jobtrace-overlay");

  beforeAll(async () => {
    // A second JobTrace with its own data, configured as the container is.
    remoteDir = mkdtempSync(join(tmpdir(), "jobtrace-remote-"));
    remoteDb = openDatabase(":memory:");
    remote = await startServer({
      config: loadConfig({
        DATA_DIR: remoteDir,
        HOST: "0.0.0.0",
        ALLOWED_HOSTS: "localhost,127.0.0.1",
        HEADLESS_ONLY: "true",
      }),
      db: remoteDb,
      port: 0,
      listenHost: "127.0.0.1",
      worker: { pollIntervalMs: 50, run: { settings: { minDelayMs: 0, maxDelayMs: 0 } } },
    });
  });
  afterAll(async () => {
    await remote?.close();
    remoteDb?.close();
    rmSync(remoteDir, { recursive: true, force: true });
  });

  it("auth create --server logs in here and sends the session there", async () => {
    const created = await cli(
      [
        "auth",
        "create",
        "Remote intranet",
        "--url",
        sites.url(`${SITES.login}signin`),
        "--server",
        remote.url,
      ],
      {
        recorder,
        onAuthCapture: (capture) => {
          void (async () => {
            const { page } = capture;
            await page.locator('input[name="username"]').fill(LOGIN_CREDENTIALS.username);
            await page.locator('input[name="password"]').fill(LOGIN_CREDENTIALS.password);
            await page.getByRole("button", { name: "Sign in" }).click();
            await page.getByTestId("signed-in").waitFor();
            await ui(page).locator('[data-action="auth-save"]').click();
          })();
        },
      },
    );
    expect(created.code).toBe(0);
    const id = created.stdout.trim();
    expect(created.stderr).toContain(`Sent the login "Remote intranet" to ${remote.url}.`);

    const [profile] = await remoteDb.authProfiles.list();
    expect(profile).toMatchObject({ id, name: "Remote intranet", domain: "127.0.0.1" });
    expect(profile?.storageStatePath).toBe(join(remoteDir, "auth", `${id}.json`));
    expect(statSync(profile?.storageStatePath ?? "").mode & 0o777).toBe(0o600);
    expect(readFileSync(profile?.storageStatePath ?? "", "utf8")).toContain("jobtrace_session");
    // The server lists the profile but never hands the session back.
    const listed = await (await fetch(`${remote.url}/api/auth-profiles`)).text();
    expect(listed).toContain("Remote intranet");
    expect(listed).not.toMatch(/jobtrace_session|storageState/);
  });

  it("record --server stores the recording there, where it then runs with the sent login", async () => {
    const recorded = await cli(
      [
        "record",
        sites.url(SITES.login),
        "--auth",
        "Remote intranet",
        "--name",
        "Remote board",
        "--server",
        remote.url,
      ],
      {
        recorder,
        onSession: (session) => {
          void (async () => {
            const { page } = session;
            const press = (action: string) => ui(page).locator(`[data-action="${action}"]`).click();
            await page.locator("li.job").first().waitFor();
            await press("auth-check");
            await page.getByTestId("signed-in").click();
            await expect.poll(() => session.status().auth).toEqual({ hasCheck: true });
            await press("list");
            await page.locator("li.job .loc").first().click();
            await press("list-use");
            await expect.poll(() => session.status().scope).toBe("list");
            await page.locator("li.job .title").first().click();
            await press("save");
            await expect.poll(() => session.status().fields).toEqual(["title"]);
            await press("stop");
          })();
        },
      },
    );
    expect(recorded.code).toBe(0);
    const id = recorded.stdout.trim();
    expect(recorded.stderr).toContain(
      `Stored on ${remote.url}. Run it from there: ${remote.url}/recordings/${id}`,
    );
    // Not stored on this side.
    expect((await cli(["recordings", "show", id])).stderr).toMatch(/No recording matches/);
    expect((await remoteDb.recordings.get(id))?.name).toBe("Remote board");

    const queued = await (
      await fetch(`${remote.url}/api/recordings/${id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    await remote.worker.idle();
    expect(await remoteDb.runs.get(queued.id)).toMatchObject({
      status: "succeeded",
      stats: { jobs: 5 },
    });
    expect((await remoteDb.authProfiles.list())[0]?.lastVerifiedAt).not.toBeNull();
  }, 60_000);

  it("auth push resends a login, and problems reaching the server are reported plainly", async () => {
    const pushed = await cli(["auth", "push", "Remote intranet"], {
      env: { DATA_DIR: dataDir, LOG_LEVEL: "info", JOBTRACE_SERVER: remote.url },
    });
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain("Sent the login");
    expect((await cli(["auth", "push", "Remote intranet"])).stderr).toMatch(/Say which server/);
    expect(
      (await cli(["auth", "push", "Remote intranet", "--server", "not a url"])).stderr,
    ).toMatch(/not a valid server address/);
    expect(
      (await cli(["auth", "push", "Remote intranet", "--server", "http://127.0.0.1:9"])).stderr,
    ).toMatch(/Could not reach the JobTrace server at http:\/\/127\.0\.0\.1:9\. Is it running\?/);
    // The server will not open windows itself, and says where to do it instead.
    const refused = await fetch(`${remote.url}/api/recordings/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: sites.url("/") }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toMatch(/runs in a container.*--server/);
    const headed = await fetch(`${remote.url}/api/recordings/rec_x/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headed: true }),
    });
    expect(headed.status).toBe(404);
  });
});

describe("API sources", () => {
  const baseUrl = (provider: "greenhouse" | "lever" | "ashby") => sites.url(ATS_PATHS[provider]);
  const setVersion = (version: number) =>
    fetch(sites.url(`${SITES.changing}__version/${version}`), { method: "POST" });

  it("source add checks the board, stores it, and run tracks its jobs", async () => {
    await setVersion(1);
    const added = await cli([
      "source",
      "add",
      "greenhouse",
      "acme",
      "--base-url",
      baseUrl("greenhouse"),
    ]);
    expect(added.code).toBe(0);
    const id = added.stdout.trim();
    expect(id).toMatch(/^src_/);
    expect(added.stderr).toContain("Found 5 job(s) on the board.");
    expect(added.stderr).toContain('Added "acme (Greenhouse)"');

    const first = await cli(["run", id]);
    expect(first.stderr).toMatch(/succeeded: 5 job\(s\), 5 new, 0 changed/);
    await setVersion(2);
    const second = await cli(["run", "acme (greenhouse)"]);
    expect(second.stderr).toMatch(/succeeded: 5 job\(s\), 1 new, 1 changed/);
    const jobs = JSON.parse(second.stdout) as Array<{
      title: string;
      isNew: boolean;
      company: string;
    }>;
    expect(jobs.filter((job) => job.isNew).map((job) => job.title)).toEqual([
      changingJobs(2).at(-1)?.title,
    ]);
    expect(jobs[0]?.company).toBe("Acme Robotics");

    const list = await cli(["recordings", "list"]);
    expect(list.stdout).toMatch(
      new RegExp(`${id}\\s+feed\\s+acme \\(Greenhouse\\)\\s+127\\.0\\.0\\.1\\s+6\\s+succeeded`),
    );
    const show = await cli(["recordings", "show", id]);
    expect(show.stdout).toContain('type       greenhouse feed, board "acme"');
    expect(show.stdout).toContain("/v1/boards/acme/jobs?content=true");
    expect(show.stdout).not.toContain("Steps");
  });

  it("round-trips a source through export and import, and runs a source file as a one-off", async () => {
    const added = await cli([
      "source",
      "add",
      "lever",
      "acme",
      "--name",
      "Acme Lever",
      "--company",
      "Acme Robotics",
      "--base-url",
      baseUrl("lever"),
      "--no-check",
    ]);
    expect(added.stderr).not.toContain("Found");
    const exported = JSON.parse((await cli(["recordings", "export", "Acme Lever"])).stdout);
    expect(exported).toMatchObject({
      kind: "api",
      provider: "lever",
      boardToken: "acme",
      settings: { company: "Acme Robotics" },
    });

    const file = join(dataDir, "source.jobtrace.json");
    writeFileSync(file, JSON.stringify({ ...exported, id: "src_copy", name: "Lever copy" }));
    expect((await cli(["recordings", "import", file])).stderr).toMatch(
      /Imported "Lever copy" \(lever feed\)/,
    );

    const oneOff = await cli(["run", file]);
    expect(oneOff.code).toBe(0);
    const jobs = JSON.parse(oneOff.stdout) as Array<{ company: string; isNew?: boolean }>;
    expect(jobs).toHaveLength(5);
    expect(jobs[0]?.company).toBe("Acme Robotics");
    // A file run is not tracked, so there are no flags.
    expect(jobs[0]).not.toHaveProperty("isNew");
  });

  it("does not store a board it cannot read, and rejects unknown providers", async () => {
    const before = JSON.parse((await cli(["recordings", "list", "--json"])).stdout).length;
    const missing = await cli(["source", "add", "ashby", "nope", "--base-url", baseUrl("ashby")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/Could not read .*No ashby board named "nope"/);
    expect((await cli(["source", "add", "workday", "acme"])).stderr).toMatch(
      /Unknown provider "workday"/,
    );
    expect((await cli(["source", "add", "lever", "bad/token", "--no-check"])).stderr).toMatch(
      /letters, digits/,
    );
    expect(JSON.parse((await cli(["recordings", "list", "--json"])).stdout)).toHaveLength(before);
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
    expect(
      table(
        ["A", "URL"],
        [
          ["multi\n  line   text", "u".repeat(60)],
          ["y".repeat(60), ""],
        ],
      ),
    ).toBe(
      `${"A".padEnd(48)}  URL\n${"multi line text".padEnd(48)}  ${"u".repeat(60)}\n${"y".repeat(47)}…\n`,
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
