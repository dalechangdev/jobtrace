# JobTrace

Record how you browse a company's career site once, then let JobTrace replay it to
collect the job listings: on demand or on a schedule, telling you which jobs are new,
changed or gone. Open source (MIT), run by you on your own computer.

- **Point and click.** A browser window with a small toolbar: mark the list of jobs,
  the data you want, the "Next" button. No selectors to write.
- **Keeps working.** Every element is remembered several ways, so a renamed CSS class
  does not break a recording.
- **Feeds where they exist.** Boards hosted on Greenhouse, Lever or Ashby are read
  from their public feed, without a browser.
- **A polite visitor.** Respects robots.txt, waits between actions, and stops at a
  CAPTCHA instead of trying to get past it.

> **Status: early but usable.** Every milestone in [PLAN.md](PLAN.md) is built.
> Notifications about new jobs are not.

## Contents

- [Quickstart](#quickstart) · [with Docker](#quickstart-with-docker)
- [Concepts](#concepts)
- [Recording guide](#recording-guide)
- [Boards on Greenhouse, Lever or Ashby](#boards-on-greenhouse-lever-or-ashby)
- [Running and tracking jobs](#running-and-tracking-jobs)
- [The web UI and the HTTP API](#the-web-ui-and-the-http-api)
- [When a site changes: the AI fallback](#when-a-site-changes-the-ai-fallback)
- [Docker](#docker)
- [Command reference](#command-reference) · [Configuration](#configuration)
- [Responsible use](#responsible-use)
- [Troubleshooting](#troubleshooting)

## Quickstart

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm --filter @jobtrace/runner exec playwright install chromium
pnpm build:web

pnpm jobtrace serve          # then open http://127.0.0.1:4317
```

In the web UI: **Recordings → New recording**, enter a career page's address, and a
recorder window opens. Follow the [recording guide](#recording-guide), press **Stop**,
then **Run now**.

To try it without touching a real site, JobTrace ships the mock career sites its own
tests use:

```sh
pnpm test-sites              # http://127.0.0.1:4400, leave running
```

and record, for example, `http://127.0.0.1:4400/paginated/`.

Everything also works from the command line alone:

```sh
pnpm jobtrace record http://127.0.0.1:4400/paginated/
pnpm jobtrace run "Jobs at Acme Robotics – page 1"     # by name, id or id prefix
pnpm jobtrace jobs list --new
```

Data (a SQLite database, saved logins, screenshots) lives in `~/.jobtrace`; set
`DATA_DIR` to put it elsewhere.

## Quickstart with Docker

```sh
docker compose --profile demo up -d --build
```

Open http://127.0.0.1:4317. The `demo` profile also starts the mock career sites at
http://127.0.0.1:4400, so you can see a run straight away: **Recordings → Import**,
choose `examples/recordings/list-detail.jobtrace.json`, then **Run now**.

A container has no screen, so recording happens on your own computer and is sent to
the container. See [Docker](#docker).

## Concepts

- **Recording**: the steps to replay on one job board, stored as versioned JSON. Steps
  form a tree: plain actions (`navigate`, `click`, `fill`, `select`, `press`, `scroll`,
  `waitFor`), `extract` (read fields), and three loops: `forEach` (every job in a
  list), `openDetail` (visit each job's own page) and `paginate` (a Next button,
  infinite scroll, or numbered pages). Recordings export to `.jobtrace.json` files that
  can be shared or kept in Git; [`examples/recordings`](examples/recordings) has
  hand-written ones, and [PLAN.md section 5](PLAN.md) is the full format.
- **Feed** (API source): a board on Greenhouse, Lever or Ashby, read from its public
  JSON feed. It sits next to recordings and behaves the same everywhere else.
- **Locators**: each element is remembered several ways, most stable first (test id,
  ARIA role, stable attributes, text, CSS, XPath). A replay uses the first one that
  works, and logs a `locator_drift` warning when it had to fall back.
- **Fields**: what `extract` reads. The names `title`, `company`, `location`, `remote`,
  `salaryText`, `url`, `description`, `descriptionHtml`, `postedAt` and
  `employmentType` fill the job's standard fields; any other name is kept as a custom
  field. Salary text and posting dates are parsed on a best-effort basis.
- **Run**: one replay of a recording or one read of a feed. It ends `succeeded`,
  `partial` (some jobs read, some errors), `failed`, `blocked` (the site refused or
  showed an anti-bot check) or `cancelled`.
- **New, changed, closed**: each run compares what it found with earlier runs. See
  [Running and tracking jobs](#running-and-tracking-jobs).
- **Saved login** (auth profile): a browser session saved after you log in by hand, for
  boards behind a sign-in. Never your password.
- **Params**: a recording can declare params and use them as `{{params.name}}` in
  addresses and typed text, for example a search keyword.

## Recording guide

Start from the web UI (**Recordings → New recording**) or with
`jobtrace record <url>`. A Chromium window opens with a toolbar:

| Button | What the next click does |
|---|---|
| **Record** (default) | Nothing special: browse as usual. Clicks, typed text, dropdown choices, Enter/Escape/Tab and addresses you type become steps. |
| **Mark list** | Click anywhere inside one job card or row. Everything that looks like it is highlighted; confirm, or use **Narrower** / **Wider** if it picked too little or too much. |
| **Mark field** | Click a piece of data and say what it is (`title`, `location`, a custom name…) and whether to read its text, its link address or its HTML. Inside a list, this applies to every job. |
| **Open detail** | Inside a list: click a job's link. The browser follows it; fields you mark there are read from every job's own page. **Back to list** returns. |
| **Next page** | Click the board's "Next" control. It is not followed now; on replay it is clicked until it is gone or disabled. |
| **Infinite scroll** | For boards that load more jobs as you scroll. |
| **Logged-in check** | Only when recording with a saved login: click something only shown while logged in. |
| **Finish list** / **Stop** | Leave the list / finish and save. Closing the window does the same as Stop. |

While picking (any mode but Record) the page does not react to clicks, so marking a
link does not follow it. Escape returns to Record.

**A typical session**

1. Open the board. If needed, search or filter in **Record** mode first.
2. **Mark list**, click one job, confirm the highlighted jobs.
3. **Mark field**: click the title → `title`. Click the title again → `url`, read
   "Link URL". Add `location` and whatever else the list shows.
4. **Open detail**, click the job's title. On its page, mark `description`, and salary
   or posting date if shown. **Back to list**.
5. **Next page**, click the Next control (or **Infinite scroll**).
6. **Stop**.

**Good to know**

- **Always mark `url`.** Jobs are matched across runs by their address. Without it they
  are matched by title, company and location, and editing any of those later makes
  every job look new.
- **Passwords are never recorded.** Text typed into password, payment-card and
  one-time-code fields is skipped, with a warning. For boards behind a login, see below.
- A field marked outside a list is read once per page, not per job.
- What you do outside the list's items while a list is open (searching, filtering) is
  replayed once, before the list.
- One list with one level of detail pages per recording; lists inside lists are not
  supported.
- A link that opens a new tab is recorded as going to that tab's address, because
  replays stay in one tab.
- After an action that changes the address, the recording waits for the new address
  using a pattern such as `**/jobs/*`. If a site's addresses change shape, edit or
  remove that `waitFor` step.

**After recording**, the recording's page in the web UI lets you rename it, rename
fields and change how they are read, reorder or remove locators, adjust limits and
delays, try a single step (**Test step**), and restore an earlier version. Adding new
steps means recording again, or editing the JSON.

### Boards behind a login

```sh
jobtrace auth create "Acme intranet" --url https://careers.acme.example/login
jobtrace record https://careers.acme.example/internal --auth "Acme intranet"
```

`auth create` (or **Saved logins → New login** in the UI) opens the login page. Log in
as usual and press **Save login**. Only the resulting browser session (cookies and
local storage) is saved, in `DATA_DIR/auth/`, readable by you alone. Nothing you type
is observed during login.

While recording with a saved login, use **Logged-in check** on something only visible
when logged in (your account menu, a "Sign out" link). When the session later expires,
runs end with `auth_expired` and say so, and `jobtrace auth refresh "Acme intranet"`
renews it.

Anyone who can read a saved session file can act as you on that site. See
[SECURITY.md](SECURITY.md).

## Boards on Greenhouse, Lever or Ashby

Many companies host their board on one of these services, which publish it as a
public JSON feed. For those there is nothing to record:

```sh
jobtrace source add greenhouse acme       # job-boards.greenhouse.io/acme
jobtrace source add lever acme --company "Acme Robotics"
jobtrace source add ashby acme --company "Acme Robotics"
```

or **Recordings → Add a feed** in the UI. The board name is the last part of the
board's address (`jobs.lever.co/<board>`, `jobs.ashbyhq.com/<board>`,
`job-boards.greenhouse.io/<board>`). The feed is read once to check that the board
exists; after that it runs, schedules and tracks jobs like a recording.

A feed run is a single request, sent with a `User-Agent` that names JobTrace. Lever
and Ashby feeds do not include the company name, hence `--company`. For Lever's EU
instance pass `--base-url https://api.eu.lever.co`.

## Running and tracking jobs

```sh
jobtrace run "Acme board"          # or Run now in the UI
jobtrace jobs list --new
jobtrace runs list
```

Each run compares what it found with earlier runs of the same recording:

- **New**: seen for the first time.
- **Changed**: the title, location, salary, description or another field differs from
  last time. The posting date is ignored, since "3 days ago" changes every day.
- **Closed**: missing from three successful runs in a row. Closed jobs are hidden unless
  you ask for them, and reopen if they come back. Partial or failed runs never close
  anything.

### On a schedule

```sh
jobtrace schedule add "Acme board" --cron "0 8 * * 1-5" --tz Europe/Madrid
```

or the **Schedules** page, which offers "every weekday at…" choices and shows what a
schedule means and when it will next run before you save it.

- **Schedules only fire while `jobtrace serve` is running** (or the Docker container).
  Runs that were due while it was off are skipped, not caught up.
- A schedule may fire at most every 15 minutes.
- If a recording's previous run is still going when the next is due, that one is
  skipped rather than stacked up.
- Without a time zone, times are in the zone of the computer running the server.

## The web UI and the HTTP API

`jobtrace serve` runs the web UI, the HTTP API, the worker that executes runs, and the
scheduler, in one process on http://127.0.0.1:4317.

- **Dashboard**: jobs found since you last looked, upcoming scheduled runs, recent runs.
- **Recordings**: record a board, add a feed, import a file; edit, test and run.
- **Runs**: a run's live log, per-step summary, screenshots, and its jobs with **New**
  and **Changed** badges.
- **Jobs**: search and filter everything found so far; export as CSV or JSON.
- **Schedules**, **Saved logins**, **Settings**.

Every route of the API is documented interactively at `/api/docs`. A few to start with:

```sh
curl http://127.0.0.1:4317/api/recordings
curl -X POST http://127.0.0.1:4317/api/recordings/<id>/runs -H 'content-type: application/json' -d '{}'
curl -N http://127.0.0.1:4317/api/runs/<runId>/events/stream     # live log
curl 'http://127.0.0.1:4317/api/jobs?new=true&q=engineer'
```

Runs started through the UI or API are queued and executed by the worker, at most two
at a time and never two on the same site.

**Who can reach it.** By default only this computer: the server listens on localhost,
answers only requests addressed to a localhost name, and refuses requests coming from
other websites' pages. To use it from another machine, set `HOST` and an `API_TOKEN`;
every request must then send `Authorization: Bearer <token>` (the web UI asks for the
token once).

## When a site changes: the AI fallback

Optional, and off by default. A recording keeps several locators per element, so most
redesigns are survived without help. When *every* locator of a step fails, JobTrace can
ask Claude where the element went instead of failing the run.

To use it, set an Anthropic API key and switch it on:

```sh
# .env
ANTHROPIC_API_KEY=sk-ant-...
AI_FALLBACK_ENABLED=true     # or tick the box on the Settings page
```

What then happens when a step cannot find its element:

1. JobTrace sends Claude the recorded description of the element (tag, text,
   attributes), the locators that failed, and a trimmed copy of the part of the page the
   element is looked up in: the list item for a field of a job card, otherwise the page.
2. Claude answers with one locator. JobTrace checks it against the live page: it must
   match exactly one element (or at least one, for a list), and that element must be the
   same kind of element as the recorded one or say nearly the same thing. A suggestion
   that fails the check is dropped and the step fails as it would have.
3. The run goes on with the healed locator. The run's page lists it under **Suggested
   locators**; **Accept** makes it the step's first locator and keeps the old ones as
   fallbacks. Until you accept, the recording is unchanged and the next run asks again.

What is sent, and what never is:

- Sent: page markup without scripts, styles and anything typed into forms, capped at
  60,000 characters, and the page's address without its query string.
- Never sent: cookies, saved logins, form values, passwords, your job list.
- Remember that on a board behind a login, the page markup itself may show your name or
  other account details. Leave the fallback off for recordings where that matters.

Cost is bounded: one question per broken element per run (not per job), and at most
`AI_FALLBACK_MAX_CALLS` (default 10) per run. An optional field that is simply absent
costs one question per run, and so does a "next page" control missing on the first page.
The logged-in check of a recording is never healed, so an expired login is still
reported as one.

`AI_FALLBACK_AUTO_APPLY=true` saves healed locators into the recording by itself, but
only after a run that fully succeeded. Leave it off if you would rather review them.

The same variables work for `jobtrace run` on the command line. A server started
without `ANTHROPIC_API_KEY` ignores the Settings switch.

## Docker

```sh
docker compose up -d --build       # http://127.0.0.1:4317
docker compose logs -f jobtrace
docker compose down                # data is kept in the jobtrace-data volume
```

The container runs the same server: web UI, API, worker and scheduler, with headless
Chromium. It restarts with Docker, which makes it the natural home for scheduled runs.

**Recording and logging in happen on your computer.** A container has no screen to
show a browser window on, so the UI's "New recording" and "New login" are unavailable
there. Use the command line on your own computer and send the result to the container:

```sh
pnpm jobtrace record https://careers.example.com/jobs --server http://127.0.0.1:4317

pnpm jobtrace auth create "Acme intranet" --url https://careers.example.com/login \
     --server http://127.0.0.1:4317
pnpm jobtrace record https://careers.example.com/internal --auth "Acme intranet" \
     --server http://127.0.0.1:4317
```

Set `JOBTRACE_SERVER=http://127.0.0.1:4317` to avoid repeating `--server`. A saved
login can be sent to the container but is never handed back by it. Feeds
(Greenhouse, Lever, Ashby) and imported recordings need no browser window and can be
added in the container's UI directly.

**Where the data is.** In the Docker volume `jobtrace-data` (database, saved logins,
screenshots). It is deliberately not a folder shared with your computer: the database
is SQLite, which is not safe to open from the container and from your computer at the
same time through Docker's file sharing on macOS and Windows. Back it up with:

```sh
docker run --rm -v jobtrace_jobtrace-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/jobtrace-data.tgz -C /data .
```

**Who can reach it.** The compose file publishes the port on `127.0.0.1` only, and the
server answers only to localhost names (`ALLOWED_HOSTS`). To reach it from other
machines, change the published address **and** set `API_TOKEN` and `ALLOWED_HOSTS`
yourself; without a token it will refuse to start for any non-localhost name.

**Time zone.** Schedules without their own time zone use the container's, which is
UTC unless you start it with `TZ=Europe/Madrid docker compose up -d`.

**Updating.** `git pull && docker compose up -d --build`. The database is upgraded
automatically on start.

## Command reference

| Command | What it does |
|---|---|
| `serve [--port] [--host]` | Run the web UI, HTTP API, worker and scheduler. |
| `record <url> [--name] [--auth <login>] [--server <url>] [--out <file>]` | Record a board in a browser window. Stored in the database, on `--server`, or in a file. |
| `run <recording> [--headed] [--trace] [--param k=v] [--max-pages n] [--max-items n] [--summary] [--queue]` | Run a stored recording or feed and track its jobs. Given a `.jobtrace.json` file, replays it once without storing anything. |
| `source add <greenhouse\|lever\|ashby> <board> [--name] [--company] [--base-url] [--no-check]` | Add a board read through its public feed. |
| `recordings list \| show \| export \| import \| delete` | Manage stored recordings and feeds. `delete` needs `--yes`. |
| `runs list [--recording] \| show <run> [--events]` | Past runs: status, counts, errors, artifacts, log. |
| `jobs list [--new] [--recording] [--since 7d] [--search text] [--all]` | Jobs found so far, newest first. |
| `schedule add <recording> --cron "…" [--tz] \| list \| pause \| resume \| remove` | Run a recording or feed automatically. |
| `auth create <name> --url <login page> \| refresh \| push \| list \| delete` | Saved logins. `push` sends one to a `--server`. |
| `db migrate` | Create or upgrade the database (also happens automatically). |

Recordings, runs and schedules can be referred to by id or by the first characters of
the id; recordings and saved logins also by name. Most listing commands take `--json`.

`run` prints the jobs as JSON on stdout and a one-line summary on stderr. Its exit code
is `0` for a successful run, `2` for a partial one, and `1` otherwise. `--trace` saves a
Playwright trace (open it with `npx playwright show-trace <trace.zip>`); `--queue`
hands the run to a running `jobtrace serve` instead of executing it now.

## Configuration

Environment variables, or a `.env` file in the directory you start `jobtrace` from
(variables already set in the environment win):

| Variable | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `~/.jobtrace` | Database, saved logins, run artifacts, robots.txt cache. |
| `HOST` / `PORT` | `127.0.0.1` / `4317` | Where `serve` listens. |
| `API_TOKEN` | none | Required when the server is reachable beyond localhost. |
| `ALLOWED_HOSTS` | none | Host names the server answers to when `HOST` is not a localhost address (used by the Docker image). |
| `HEADLESS_ONLY` | `false` | Set where there is no screen (the Docker image): no browser windows are opened. |
| `MAX_CONCURRENT_RUNS` | `2` | Runs at the same time. Also on the Settings page. |
| `ARTIFACT_RETENTION_RUNS` | `20` | Screenshots and traces are kept for this many of a recording's newest runs. Also on the Settings page. |
| `DEFAULT_MIN_DELAY_MS` / `DEFAULT_MAX_DELAY_MS` | `1000` / `3000` | Pause between actions for new recordings. Also on the Settings page. |
| `LOG_LEVEL` | `info` | `debug` shows every step of a run. |
| `JOBTRACE_SERVER` / `JOBTRACE_TOKEN` | none | For the command line: the server to send recordings and logins to, and its token. |
| `ANTHROPIC_API_KEY` | none | Needed for the [AI fallback](#when-a-site-changes-the-ai-fallback). Read from the environment only; never stored or shown. |
| `AI_FALLBACK_ENABLED` | `false` | Ask Claude when every locator of a step fails. Also on the Settings page. |
| `AI_FALLBACK_MODEL` | `claude-opus-5-5` | The Claude model to ask. |
| `AI_FALLBACK_MAX_CALLS` | `10` | Most questions per run. |
| `AI_FALLBACK_AUTO_APPLY` | `false` | Save healed locators into the recording after a successful run, without asking. |

Values saved on the Settings page are stored in the database and take precedence over
the environment.

## Responsible use

JobTrace is meant for personal job searching, and is built to be a polite visitor:

- **robots.txt is respected.** A run that would load a disallowed page ends with
  `robots_disallowed` instead. If a site asks for a pause between requests
  (`Crawl-delay`), runs slow down to it. A recording can opt out in its settings; that
  is your decision to make and to answer for.
- **It waits between actions**, a randomized 1–3 seconds by default, and scheduled runs
  are limited to one every 15 minutes.
- **It stops when it is not wanted.** A CAPTCHA or "verify you are human" page, or an
  HTTP 403, ends the run as `blocked` with a screenshot. If a site answers "too many
  requests" and says how long to wait, the run waits that long (up to a minute) and
  tries once more; otherwise it stops.
- **It never tries to get past any of that.** No CAPTCHA solving, no stealth plugins,
  no fingerprint spoofing, and the browser's normal user agent.

Respect each site's terms of use and keep request volumes low. See
[SECURITY.md](SECURITY.md) for what is stored and how it is protected.

## Troubleshooting

- **A run ended `blocked`.** The site showed an anti-bot check or refused the request;
  the run's page shows a screenshot. JobTrace will not work around it. If the company's
  board is on Greenhouse, Lever or Ashby, add it as a feed instead.
- **A run failed with "an element could not be found" (`LOCATOR_NOT_FOUND`).** The page
  no longer has what the recording looks for. The error lists each locator and how many
  elements it matched, and the screenshot shows the page. Open the recording, use
  **Test step** to find the step that breaks, then reorder or remove locators, or
  record that board again. The [AI fallback](#when-a-site-changes-the-ai-fallback) can
  repair such steps by itself.
- **`locator_resolver_error` or "Suggested locator … rejected" in a run's log.** The AI
  fallback was asked and could not help: the message says why (key rejected, rate
  limit, call limit used up, or a suggestion that did not fit the page). The run
  continues as if the fallback were off.
- **Locator warnings (`locator_drift`).** The preferred locator stopped working and a
  fallback was used. The run still succeeds; re-record before the fallbacks break too.
- **`robots_disallowed`.** The site's robots.txt does not allow automated visits to that
  page. See [Responsible use](#responsible-use).
- **`auth_expired`.** The saved login no longer works: `jobtrace auth refresh <name>`
  (add `--server …` when the server runs in Docker).
- **Every job shows up as new after I edited the recording.** The recording does not
  extract `url`, so jobs are matched by title, company and location, and one of those
  changed. Mark the job's link as `url`.
- **A scheduled run did not happen.** Schedules fire only while the server is running;
  missed ones are not caught up. Check `jobtrace schedule list` for the next run and
  the server log for "skipped" or "was due while JobTrace was not running".
- **A run is slow.** Recordings wait between actions on purpose. Missing optional fields
  also cost a short wait each.
- **The UI says the server cannot open a browser window.** It runs in Docker or on
  another machine. Record on your own computer with `--server`; see [Docker](#docker).
- **"The web UI has not been built yet."** Run `pnpm build:web`.
- **Nothing happens after `jobtrace run … --queue`.** Queued runs wait for a running
  `jobtrace serve`.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `pnpm lint`, `pnpm typecheck`, `pnpm test` and
`pnpm test:e2e` must pass. [PLAN.md](PLAN.md) is the engineering plan, including the
decisions made along the way.
