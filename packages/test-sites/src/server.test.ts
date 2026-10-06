import { afterAll, describe, expect, it } from "vitest";
import { INFINITE_BATCH_SIZE, jobsFor, PAGINATED_PAGE_SIZE } from "./data.ts";
import { createTestSites, LOGIN_CREDENTIALS, SITES } from "./server.ts";

const app = createTestSites();
afterAll(() => app.close());

const count = (body: string, needle: string) => body.split(needle).length - 1;

describe("test sites", () => {
  it.each(Object.entries(SITES))("serves %s", async (name, path) => {
    const response = await app.inject({ method: "GET", url: path });
    // The login board redirects anonymous visitors to the sign-in form.
    expect(response.statusCode).toBe(name === "login" ? 302 : 200);
  });

  it("renders every job on the static list", async () => {
    const { body } = await app.inject({ url: SITES.staticList });
    expect(count(body, 'class="job"')).toBe(jobsFor("staticList").length);
    for (const job of jobsFor("staticList")) expect(body).toContain(job.title);
  });

  it("paginates and disables Next on the last page", async () => {
    const jobs = jobsFor("paginated");
    const lastPage = Math.ceil(jobs.length / PAGINATED_PAGE_SIZE);
    const first = await app.inject({ url: `${SITES.paginated}?page=1` });
    expect(count(first.body, 'class="job"')).toBe(PAGINATED_PAGE_SIZE);
    expect(first.body).toMatch(/class="next" onclick/);
    const last = await app.inject({ url: `${SITES.paginated}?page=${lastPage}` });
    expect(last.body).toMatch(/class="next" disabled/);
    expect(last.body).toContain(jobs.at(-1)?.title);
  });

  it("serves infinite-scroll batches", async () => {
    const response = await app.inject({ url: `${SITES.infinite}api/jobs?offset=18&limit=6` });
    const payload = response.json<{ jobs: unknown[]; total: number }>();
    expect(payload.total).toBe(jobsFor("infinite").length);
    expect(payload.jobs).toHaveLength(2);
    expect(INFINITE_BATCH_SIZE).toBeLessThan(payload.total);
  });

  it("serves detail pages, and v2 keeps text while changing class names", async () => {
    const job = jobsFor("detail")[0];
    const v1 = await app.inject({ url: `${SITES.detail}jobs/${job?.id}` });
    const v2 = await app.inject({ url: `${SITES.detailV2}jobs/${job?.id}` });
    expect(v1.body).toContain('class="job-body"');
    expect(v2.body).not.toContain('class="job-body"');
    for (const body of [v1.body, v2.body]) expect(body).toContain(job?.description);
    expect((await app.inject({ url: `${SITES.detail}jobs/nope` })).statusCode).toBe(404);
  });

  it("serves the SPA shell on deep links and its JSON API", async () => {
    const shell = await app.inject({ url: `${SITES.spa}jobs/101` });
    expect(shell.body).toContain('id="app"');
    const api = await app.inject({ url: `${SITES.spa}api/jobs` });
    expect(api.json<{ jobs: unknown[] }>().jobs).toHaveLength(jobsFor("spa").length);
  });

  it("gates the login board behind a session that can be invalidated", async () => {
    const rejected = await app.inject({
      method: "POST",
      url: `${SITES.login}signin`,
      payload: "username=demo&password=wrong",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(rejected.statusCode).toBe(401);

    const signIn = await app.inject({
      method: "POST",
      url: `${SITES.login}signin`,
      payload: new URLSearchParams(LOGIN_CREDENTIALS).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const cookie = String(signIn.headers["set-cookie"]).split(";")[0] ?? "";
    const board = await app.inject({ url: SITES.login, headers: { cookie } });
    expect(board.statusCode).toBe(200);
    expect(count(board.body, 'class="job"')).toBe(jobsFor("login").length);

    await app.inject({ method: "POST", url: `${SITES.login}__invalidate` });
    expect((await app.inject({ url: SITES.login, headers: { cookie } })).statusCode).toBe(302);
  });

  it("embeds the board in an iframe", async () => {
    expect((await app.inject({ url: SITES.iframe })).body).toContain("<iframe");
    const board = await app.inject({ url: `${SITES.iframe}board` });
    expect(count(board.body, 'class="job"')).toBe(jobsFor("iframe").length);
  });

  it("serves a challenge page, a 429 and a 403", async () => {
    expect((await app.inject({ url: SITES.botWall })).body).toContain("Verify you are human");
    const limited = await app.inject({ url: `${SITES.botWall}rate-limited` });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("30");
    expect((await app.inject({ url: `${SITES.botWall}forbidden` })).statusCode).toBe(403);
  });

  it("disallows the robots fixture in robots.txt", async () => {
    expect((await app.inject({ url: "/robots.txt" })).body).toContain(
      `Disallow: ${SITES.robotsDisallowed}`,
    );
  });
});
