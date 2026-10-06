import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ATS_PATHS, type AtsFixtureProvider, atsFeed } from "./ats.ts";
import {
  COMPANY,
  changingJobs,
  type FixtureJob,
  GROUPED_DEPARTMENTS,
  INFINITE_BATCH_SIZE,
  jobsFor,
  PAGINATED_PAGE_SIZE,
  SPA_API_DELAY_MS,
} from "./data.ts";
import {
  type ClassNames,
  escapeHtml,
  jobDetail,
  jobList,
  page,
  V1_CLASSES,
  V2_CLASSES,
} from "./html.ts";

/** Path prefix of each fixture site, numbered as in PLAN.md (M0). */
export const SITES = {
  staticList: "/static-list/",
  paginated: "/paginated/",
  infinite: "/infinite/",
  detail: "/detail/",
  spa: "/spa/",
  login: "/login/",
  iframe: "/iframe/",
  botWall: "/botwall/",
  detailV2: "/detail-v2/",
  robotsDisallowed: "/disallowed/",
  grouped: "/grouped/",
  changing: "/changing/",
} as const;

export const LOGIN_CREDENTIALS = { username: "demo", password: "correct-horse-battery" } as const;
const SESSION_COOKIE = "jobtrace_session";

const clientScript = (name: string) =>
  readFileSync(new URL(`./client/${name}`, import.meta.url), "utf8");

function html(reply: FastifyReply, body: string, status = 200): FastifyReply {
  return reply.code(status).type("text/html; charset=utf-8").send(body);
}

function notFound(reply: FastifyReply): FastifyReply {
  return html(reply, page({ title: "Not found", body: "<h1>Not found</h1>" }), 404);
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTestSites(): FastifyInstance {
  const app = Fastify({ logger: false });
  const sessions = new Set<string>();

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );

  /** Registers `/<prefix>jobs/:id` detail pages for the given jobs. */
  function detailRoutes(prefix: string, jobs: readonly FixtureJob[], classes?: ClassNames) {
    app.get<{ Params: { id: string } }>(`${prefix}jobs/:id`, (request, reply) => {
      const job = jobs.find((candidate) => candidate.id === request.params.id);
      if (!job) return notFound(reply);
      return html(
        reply,
        page({ title: `${job.title} – ${COMPANY}`, body: jobDetail(job, prefix, classes) }),
      );
    });
  }

  app.get("/", (_request, reply) => {
    const links = Object.entries(SITES)
      .map(([name, path]) => `<p><a href="${path}">${name}</a> <code>${path}</code></p>`)
      .join("\n");
    return html(
      reply,
      page({ title: "JobTrace test sites", body: `<h1>Fixture sites</h1>${links}` }),
    );
  });

  app.get("/robots.txt", (_request, reply) =>
    reply.type("text/plain").send(`User-agent: *\nDisallow: ${SITES.robotsDisallowed}\n`),
  );

  // 1. Simple static job list (titles are headings, so jobs have no URL).
  // It also has a GET search form (keyword and employment type) for fill/select/press steps.
  app.get<{ Querystring: { q?: string; type?: string } }>(SITES.staticList, (request, reply) => {
    const keyword = (request.query.q ?? "").trim().toLowerCase();
    const type = request.query.type ?? "";
    const jobs = jobsFor("staticList").filter(
      (job) =>
        job.title.toLowerCase().includes(keyword) && (type === "" || job.employmentType === type),
    );
    const types = [...new Set(jobsFor("staticList").map((job) => job.employmentType))];
    const options = types
      .map((name) => `<option value="${name}"${name === type ? " selected" : ""}>${name}</option>`)
      .join("");
    const form = `<form role="search" method="get" action="${SITES.staticList}">
  <input type="search" name="q" aria-label="Search jobs" placeholder="Search jobs" value="${escapeHtml(request.query.q ?? "")}">
  <select name="type" aria-label="Employment type"><option value="">All types</option>${options}</select>
  <button type="submit">Search</button>
</form>
<p class="result-count">${jobs.length} job(s)</p>`;
    return html(
      reply,
      page({ title: `Jobs at ${COMPANY}`, body: `<h1>Open positions</h1>${form}${jobList(jobs)}` }),
    );
  });

  // 2. Paginated list with a Next button that is disabled on the last page.
  app.get<{ Querystring: { page?: string } }>(SITES.paginated, (request, reply) => {
    const jobs = jobsFor("paginated");
    const pageCount = Math.ceil(jobs.length / PAGINATED_PAGE_SIZE);
    const current = Math.min(Math.max(Number(request.query.page ?? 1) || 1, 1), pageCount);
    const slice = jobs.slice((current - 1) * PAGINATED_PAGE_SIZE, current * PAGINATED_PAGE_SIZE);
    const go = (target: number) => `onclick="location.href='${SITES.paginated}?page=${target}'"`;
    const prev = current > 1 ? go(current - 1) : "disabled";
    const next = current < pageCount ? go(current + 1) : "disabled";
    const body = `<h1>Open positions</h1>
${jobList(slice, { href: (job) => `${SITES.paginated}jobs/${job.id}` })}
<nav class="pager" aria-label="Pagination">
  <button type="button" class="prev" ${prev}>Previous</button>
  <span class="page-status">Page ${current} of ${pageCount}</span>
  <button type="button" class="next" ${next}>Next</button>
</nav>`;
    return html(reply, page({ title: `Jobs at ${COMPANY} – page ${current}`, body }));
  });
  detailRoutes(SITES.paginated, jobsFor("paginated"));

  // 3. Infinite scroll list, filled client-side in batches.
  app.get(SITES.infinite, (_request, reply) =>
    html(
      reply,
      page({
        title: `Jobs at ${COMPANY}`,
        body: `<h1>Open positions</h1>
<div class="tall"><ul id="jobs" class="jobs" aria-label="Open positions" data-batch-size="${INFINITE_BATCH_SIZE}"></ul></div>
<p id="sentinel">Loading more…</p>
<script type="module" src="${SITES.infinite}app.js"></script>`,
      }),
    ),
  );
  app.get(`${SITES.infinite}app.js`, (_request, reply) =>
    reply.type("text/javascript").send(clientScript("infinite.js")),
  );
  app.get<{ Querystring: { offset?: string; limit?: string } }>(
    `${SITES.infinite}api/jobs`,
    (request) => {
      const jobs = jobsFor("infinite");
      const offset = Number(request.query.offset ?? 0) || 0;
      const limit = Number(request.query.limit ?? INFINITE_BATCH_SIZE) || INFINITE_BATCH_SIZE;
      return { jobs: jobs.slice(offset, offset + limit), total: jobs.length };
    },
  );

  // 4. List -> detail pages. 9. Same site with changed class names.
  for (const [prefix, classes] of [
    [SITES.detail, V1_CLASSES],
    [SITES.detailV2, V2_CLASSES],
  ] as const) {
    // `?newtab=1` renders the links with target="_blank", as some boards do.
    app.get<{ Querystring: { newtab?: string } }>(prefix, (request, reply) =>
      html(
        reply,
        page({
          title: `Jobs at ${COMPANY}`,
          body: `<h1>Open positions</h1>${jobList(jobsFor("detail"), {
            classes,
            href: (job) => `${prefix}jobs/${job.id}`,
            ...(request.query.newtab ? { linkTarget: "_blank" } : {}),
          })}`,
        }),
      ),
    );
    // Site 3 links into /detail/, so every job needs a detail page there.
    detailRoutes(
      prefix,
      prefix === SITES.detail ? jobsFor("infinite") : jobsFor("detail"),
      classes,
    );
  }

  // 5. SPA with client-side routing and delayed rendering.
  app.get(`${SITES.spa}app.js`, (_request, reply) =>
    reply.type("text/javascript").send(clientScript("spa.js")),
  );
  app.get(`${SITES.spa}api/jobs`, async () => {
    await delay(SPA_API_DELAY_MS);
    return { jobs: jobsFor("spa") };
  });
  app.get<{ Params: { id: string } }>(`${SITES.spa}api/jobs/:id`, async (request, reply) => {
    await delay(SPA_API_DELAY_MS);
    const job = jobsFor("spa").find((candidate) => candidate.id === request.params.id);
    return job ?? reply.code(404).send({ error: "not_found" });
  });
  const spaShell = (_request: FastifyRequest, reply: FastifyReply) =>
    html(
      reply,
      page({
        title: `Jobs at ${COMPANY}`,
        body: `<div id="app"></div><script type="module" src="${SITES.spa}app.js"></script>`,
      }),
    );
  app.get(SITES.spa, spaShell);
  app.get(`${SITES.spa}jobs/:id`, spaShell);

  // 6. Login-gated board with a fake login and a cookie session.
  const loggedIn = (request: FastifyRequest) => {
    const token = readCookie(request, SESSION_COOKIE);
    return token !== undefined && sessions.has(token);
  };
  const signInForm = (error = "") =>
    page({
      title: "Sign in",
      body: `<h1>Sign in</h1>${error ? `<p role="alert">${error}</p>` : ""}
<form method="post" action="${SITES.login}signin">
  <p><label>Username <input name="username" autocomplete="username"></label></p>
  <p><label>Password <input name="password" type="password" autocomplete="current-password"></label></p>
  <button type="submit">Sign in</button>
</form>`,
    });
  app.get(`${SITES.login}signin`, (_request, reply) => html(reply, signInForm()));
  app.post<{ Body: { username?: string; password?: string } }>(
    `${SITES.login}signin`,
    (request, reply) => {
      const { username, password } = request.body ?? {};
      if (username !== LOGIN_CREDENTIALS.username || password !== LOGIN_CREDENTIALS.password) {
        return html(reply, signInForm("Invalid username or password"), 401);
      }
      const token = randomUUID();
      sessions.add(token);
      return reply
        .header("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`)
        .redirect(SITES.login);
    },
  );
  app.get(`${SITES.login}logout`, (request, reply) => {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) sessions.delete(token);
    return reply.redirect(`${SITES.login}signin`);
  });
  // Test hook: expire every session server-side, as if the login had timed out.
  app.post(`${SITES.login}__invalidate`, () => {
    sessions.clear();
    return { ok: true };
  });
  app.get(SITES.login, (request, reply) => {
    if (!loggedIn(request)) return reply.redirect(`${SITES.login}signin`);
    return html(
      reply,
      page({
        title: `Internal jobs at ${COMPANY}`,
        body: `<h1>Internal positions</h1><p data-testid="signed-in">Signed in as ${LOGIN_CREDENTIALS.username} · <a href="${SITES.login}logout">Sign out</a></p>
${jobList(jobsFor("login"))}`,
      }),
    );
  });

  // 7. Job board embedded in an iframe.
  app.get(SITES.iframe, (_request, reply) =>
    html(
      reply,
      page({
        title: `Careers at ${COMPANY}`,
        body: `<h1>Work with us</h1>
<iframe id="job-board" title="Job board" src="${SITES.iframe}board" width="100%" height="1400"></iframe>`,
      }),
    ),
  );
  app.get(`${SITES.iframe}board`, (_request, reply) =>
    html(
      reply,
      page({
        title: "Job board",
        body: `<h1>Open positions</h1>${jobList(jobsFor("iframe"), {
          href: (job) => `${SITES.detail}jobs/${job.id}`,
          linkTarget: "_top",
        })}`,
      }),
    ),
  );

  // 8. Bot wall: a fake challenge page plus 429 and 403 routes.
  app.get(SITES.botWall, (_request, reply) =>
    html(
      reply,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Just a moment...</title></head>
<body><h1>Verify you are human</h1>
<p>${COMPANY} needs to review the security of your connection before proceeding.</p>
<iframe title="Widget containing a security challenge" data-fake-challenge="turnstile" src="${SITES.botWall}challenge-frame" width="300" height="65"></iframe>
</body></html>`,
    ),
  );
  app.get(`${SITES.botWall}challenge-frame`, (_request, reply) =>
    html(reply, "<!doctype html><title>Challenge</title><p>Checking your browser…</p>"),
  );
  app.get(`${SITES.botWall}rate-limited`, (_request, reply) =>
    reply.code(429).header("retry-after", "30").type("text/plain").send("Too Many Requests"),
  );
  app.get(`${SITES.botWall}forbidden`, (_request, reply) =>
    reply.code(403).type("text/plain").send("Forbidden"),
  );

  // 10. One list split into groups per department, as many job boards do.
  app.get(SITES.grouped, (_request, reply) => {
    const sections = GROUPED_DEPARTMENTS.map(
      ({ name, jobs }) =>
        `<section class="dept"><h2>${name}</h2>${jobList(jobs, {
          href: (job) => `${SITES.detail}jobs/${job.id}`,
        })}</section>`,
    ).join("\n");
    return html(
      reply,
      page({ title: `Jobs at ${COMPANY}`, body: `<h1>Open positions</h1>${sections}` }),
    );
  });

  // 11. A board whose content changes between visits, for new/changed/closed detection.
  let changingVersion = 1;
  app.get(SITES.changing, (_request, reply) =>
    html(
      reply,
      page({
        title: `Jobs at ${COMPANY}`,
        body: `<h1>Open positions</h1>${jobList(changingJobs(changingVersion), {
          href: (job) => `${SITES.detail}jobs/${job.id}`,
        })}`,
      }),
    ),
  );
  // Test hook: switch the board to another version of its content.
  app.post<{ Params: { version: string } }>(`${SITES.changing}__version/:version`, (request) => {
    changingVersion = Number(request.params.version) || 1;
    atsRequests.clear();
    return { version: changingVersion };
  });

  // ATS job-board APIs (Greenhouse, Lever, Ashby), shaped like the real feeds.
  // The board "acme" follows the same versions as site 11.
  const atsRequests = new Map<string, number>();
  const atsReply = (provider: AtsFixtureProvider, token: string, reply: FastifyReply) => {
    const key = `${provider}/${token}`;
    const count = (atsRequests.get(key) ?? 0) + 1;
    atsRequests.set(key, count);
    if (token === "forbidden") return reply.code(403).send({ error: "Forbidden" });
    // Rate limited on the first request only, to exercise Retry-After.
    if (token === "limited" && count === 1) {
      return reply.code(429).header("retry-after", "1").send({ error: "Too Many Requests" });
    }
    if (token === "always-limited") return reply.code(429).header("retry-after", "1").send({});
    if (token === "broken") return reply.send({ unexpected: true });
    if (!["acme", "limited", "partial"].includes(token))
      return reply.code(404).send({ status: 404, error: "Not found" });
    return reply.send(
      atsFeed(provider, changingJobs(changingVersion), { malformedEntry: token === "partial" }),
    );
  };
  app.get<{ Params: { token: string } }>(
    `${ATS_PATHS.greenhouse}/v1/boards/:token/jobs`,
    (request, reply) => atsReply("greenhouse", request.params.token, reply),
  );
  app.get<{ Params: { token: string } }>(
    `${ATS_PATHS.lever}/v0/postings/:token`,
    (request, reply) => atsReply("lever", request.params.token, reply),
  );
  app.get<{ Params: { token: string } }>(
    `${ATS_PATHS.ashby}/posting-api/job-board/:token`,
    (request, reply) => atsReply("ashby", request.params.token, reply),
  );

  // Disallowed by /robots.txt, for the robots_disallowed fixture.
  app.get(SITES.robotsDisallowed, (_request, reply) =>
    html(
      reply,
      page({
        title: `Jobs at ${COMPANY}`,
        body: `<h1>Open positions</h1>${jobList(jobsFor("staticList"))}`,
      }),
    ),
  );

  return app;
}

export interface RunningTestSites {
  /** Origin without a trailing slash, e.g. `http://127.0.0.1:4400`. */
  origin: string;
  url: (path: string) => string;
  close: () => Promise<void>;
}

/** Starts the fixture server. Port 0 picks a free port, which is what tests use. */
export async function startTestSites(port = 0, host = "127.0.0.1"): Promise<RunningTestSites> {
  const app = createTestSites();
  await app.listen({ port, host });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test-sites server has no TCP address");
  }
  const origin = `http://${host}:${address.port}`;
  return { origin, url: (path) => new URL(path, origin).href, close: () => app.close() };
}
