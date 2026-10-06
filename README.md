# JobTrace

Record how you navigate a career website, then replay those steps to scrape its job
listings: manually now, on a schedule later. Open source (MIT), run by developers from
source.

> **Status: early.** You can record a job board with `jobtrace record`, replay it
> with `jobtrace run`, and browse what it found, including which jobs are new or
> changed since the last run (milestones M0–M4 of [PLAN.md](PLAN.md)). It is all
> command-line for now: the web UI and scheduler are not built yet.

## Quickstart

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm --filter @jobtrace/runner exec playwright install chromium

pnpm test-sites                                        # mock career sites (leave running)
pnpm jobtrace record http://127.0.0.1:4400/paginated/  # mark the list and fields, press Stop
pnpm jobtrace run "Jobs at Acme Robotics – page 1"     # by name, id or id prefix
pnpm jobtrace jobs list --new
```

`run` prints the jobs as JSON on stdout and a one-line summary on stderr. Everything
is stored in a SQLite database under `DATA_DIR` (default `~/.jobtrace`).

## Commands

| Command | What it does |
|---|---|
| `record <url>` | Record a board in a browser window and store the recording. |
| `auth create` / `refresh` / `list` / `delete` | Saved logins for boards behind a sign-in. |
| `source add <provider> <board>` | Add a Greenhouse, Lever or Ashby board, read through its public feed. |
| `run <recording>` | Run a stored recording or source and track its jobs. |
| `recordings list` / `show` / `export` / `import` / `delete` | Manage stored recordings. `export` and `import` use `.jobtrace.json` files, which can be shared or kept in Git. |
| `runs list` / `show <run>` | Past runs: status, counts, errors, artifacts; `show --events` prints the log. |
| `jobs list` | Jobs found so far, newest first. Filters: `--new`, `--recording`, `--since 7d`, `--search text`, `--all`. |
| `db migrate` | Create or upgrade the database (also happens automatically). |

Recordings and runs can be referred to by id, by the first characters of the id, or
(recordings) by name. Most listing commands take `--json`.

### Boards on Greenhouse, Lever or Ashby

Many companies host their job board on one of these services, which publish the
board as a public JSON feed. For those, skip the browser:

```sh
jobtrace source add greenhouse acme       # job-boards.greenhouse.io/acme
jobtrace source add lever acme --company "Acme Robotics"
jobtrace source add ashby acme --company "Acme Robotics"
jobtrace run "acme (Greenhouse)"
```

The board name is the last part of the board's address (`jobs.lever.co/<board>`,
`jobs.ashbyhq.com/<board>`, `job-boards.greenhouse.io/<board>`). `source add` reads the
feed once to check that the board exists. After that a source behaves like a recording:
`run`, `runs`, `jobs` and `recordings list|show|export|delete` all work on it, and its
jobs are flagged new, changed and closed in the same way.

A feed run is one HTTP request, sent with a `User-Agent` that names JobTrace. If the
service answers "slow down" the run waits as asked (up to a minute) and retries; if it
refuses, the run ends as `blocked`. Lever and Ashby feeds do not include the company
name, hence `--company`. For Lever's EU instance pass
`--base-url https://api.eu.lever.co`.

### Boards behind a login

```sh
jobtrace auth create "Acme intranet" --url https://careers.acme.example/login
jobtrace record https://careers.acme.example/internal --auth "Acme intranet"
```

`auth create` opens a browser on the login page. Log in as usual and press **Save
login**. Only the resulting browser session (cookies and local storage) is saved, to
`DATA_DIR/auth/`, readable by you alone; your password is never seen or stored.
Recordings made with `--auth` replay with that session.

While recording with `--auth`, press **Logged-in check** and click something that is
only on the page when you are logged in, such as your account menu or a "Sign out"
link. Runs then end with `auth_expired` and a clear message when the session has
expired, and `jobtrace auth refresh "Acme intranet"` renews it. `auth list` shows your
saved logins and when each last worked; `auth delete` removes one.

Anyone who can read a saved session file can act as you on that site. See
[SECURITY.md](SECURITY.md).

### New, changed and closed jobs

Each tracked run compares what it found with what earlier runs of the same recording
found:

- **new**: seen for the first time. `jobs list --new` shows the jobs that were new in
  each recording's latest run.
- **changed**: the title, location, salary, description or another field differs from
  last time. The posting date is ignored, since "3 days ago" changes daily.
- **closed**: missing from three successful runs in a row. Closed jobs are hidden
  unless you pass `--all`, and reopen if they come back. Partial or failed runs never
  close anything.

Jobs are matched by their URL (without tracking parameters), or by title, company and
location when there is no URL.

## `jobtrace record`

```
jobtrace record <url> [--name <name>] [--out <file>] [--force]
```

Opens a Chromium window on `<url>` with a small toolbar:

- **Record** (the default): browse as usual. Clicks, typed text, dropdown choices,
  Enter/Escape/Tab and the addresses you type are captured as steps.
- **Mark field**: the page stops reacting to clicks. Click a piece of data, pick what it
  is (`title`, `location`, a custom name, ...) and whether to read its text, its link
  URL or its HTML. Press Escape or **Record** to go back to browsing.
- **Mark list**: click anywhere inside one job card or row. The recorder highlights
  everything that looks like it and asks you to confirm; use **Narrower** / **Wider** if
  it picked too little or too much. From then on, **Mark field** applies to every job:
  click a piece of data inside any one of the highlighted items.
- **Open detail** (inside a list): click a job's link. The browser follows it, and the
  fields you mark there are read from every job's own page. **Back to list** returns.
- **Next page**: click the board's "Next" control. It is not followed while recording;
  on replay it is clicked until it disappears or is disabled.
- **Infinite scroll**: for boards that load more jobs as you scroll.
- **Finish list**: leave the list, for example to mark something elsewhere on the page.
- **Stop**: finish and save. Closing the window or pressing Ctrl+C in the terminal does
  the same.

A typical session: open the board, **Mark list**, mark `title` and `url` (choose "Link
URL" for the latter), **Open detail**, mark `description`, **Back to list**, **Next
page**, **Stop**.

The recording is stored in the database and its id is printed on stdout. With
`--out <file>` it is written to that `.jobtrace.json` file instead; an existing file is
never overwritten unless you pass `--force`.

Things to know:

- **Passwords are never recorded.** Text typed into password, payment-card and
  one-time-code fields is skipped, with a warning. Scraping behind a login will use auth
  profiles (not built yet).
- A field marked outside a list is one-off: it is read once per page, not per job.
- While a list is open, what you do outside its items (searching, filtering) is replayed
  once, before the list.
- One list per recording session works best; lists inside lists are not supported.
- After an action that changes the URL, the recording waits for the new URL using a
  pattern such as `**/jobs/*`. If a site's URLs change shape, delete or edit that
  `waitFor` step.
- A link that opens a new tab is recorded as a navigation to that tab's address,
  because replays stay in one tab.

## `jobtrace run`

```
jobtrace run <recording> [--headed] [--trace] [--param key=value]
                         [--max-pages <n>] [--max-items <n>] [--summary]
```

`<recording>` is a stored recording, or a path to a `.jobtrace.json` file. A file is
replayed as a one-off: its jobs are printed but nothing is stored or compared.

| Option | Effect |
|---|---|
| `--headed` | Show the browser window instead of running headless. |
| `--trace` | Save a Playwright trace; open it with `npx playwright show-trace <trace.zip>`. |
| `--param key=value` | Set a param the recording declares. Repeatable. |
| `--artifacts <dir>` | For recording files: where failure screenshots, DOM snapshots and traces go. |
| `--max-pages`, `--max-items` | Override the recording's limits for this run. |
| `--summary` | Print the run's status, stats and artifact paths along with the jobs. |

Failure screenshots, DOM snapshots and traces are saved under
`DATA_DIR/artifacts/<run>` and kept for a recording's newest 20 runs
(`ARTIFACT_RETENTION_RUNS`).

Exit code `0` means the run succeeded, `2` that it was partial (some jobs extracted,
some errors), and `1` anything else. Ctrl+C cancels the run and prints what it had.

Environment: `DATA_DIR` (default `~/.jobtrace`) and `LOG_LEVEL` (default `info`; use
`debug` to see every step).

## Concepts

- **Recording**: a versioned JSON file (`*.jobtrace.json`) describing steps to replay.
  Steps form a tree: `navigate`, `click`, `fill`, `select`, `press`, `scroll`,
  `waitFor`, `extract`, plus the loops `forEach` (each job card), `openDetail` (visit
  a job's page and come back) and `paginate` (Next button, infinite scroll or a URL
  pattern). See [PLAN.md section 5](PLAN.md) and
  [`examples/recordings`](examples/recordings).
- **Target**: how an element is found. Each target lists several locators, most stable
  first (test id, ARIA role, text, CSS, XPath). On replay the first one that matches
  wins, so a recording keeps working when a site renames its CSS classes. When a
  fallback is used the run logs a `locator_drift` warning.
- **Fields**: `extract` steps read named fields. Core names (`title`, `company`,
  `location`, `remote`, `salaryText`, `url`, `description`, `descriptionHtml`,
  `postedAt`, `employmentType`) fill the job schema; any other name is kept under
  `custom`. Salary text and posting dates are parsed on a best-effort basis.
- **Params**: a recording can declare params and use them as `{{params.name}}` in URLs
  and typed values, for example a search keyword.
- **Run status**: `succeeded`, `partial`, `failed`, `blocked` or `cancelled`.

## Responsible use

JobTrace is meant for personal job searching, and is built to be a polite visitor:

- **robots.txt is respected.** A run that would load a disallowed page ends with
  `robots_disallowed` instead. If a site asks for a pause between requests
  (`Crawl-delay`), runs slow down to it. A recording can opt out with
  `"respectRobotsTxt": false` in its settings; that is your decision to make and to
  answer for.
- **It waits between actions**, a randomized 1–3 seconds by default.
- **It stops when it is not wanted.** A CAPTCHA or "verify you are human" page, or an
  HTTP 403, ends the run as `blocked` with a screenshot. If a site answers "too many
  requests" and says how long to wait, the run waits that long (up to a minute) and
  tries once more; otherwise it stops.
- **It never tries to get past any of that.** No CAPTCHA solving, no stealth plugins,
  no fingerprint spoofing, and the browser's normal user agent.

Respect each site's terms of use and keep request volumes low. See
[SECURITY.md](SECURITY.md).

## Troubleshooting

- **`LOCATOR_NOT_FOUND`**: no locator of a target matched. The error lists each
  locator and how many elements it matched; the screenshot and DOM snapshot in the
  artifacts directory show what the page looked like. A single-element target must
  match exactly one element.
- **`locator_drift` warnings**: the top-ranked locator stopped working and a fallback
  was used. The run still succeeds, but update the recording before the fallbacks
  break too.
- **`blocked`**: the site showed an anti-bot check or refused the request. The
  screenshot shows what it looked like. JobTrace will not work around it; if the
  company's board is on Greenhouse, Lever or Ashby, `source add` reads its public
  feed instead.
- **`robots_disallowed`**: the site's robots.txt does not allow automated visits to
  that page. See "Responsible use" above.
- **`auth_expired`**: the saved login no longer works. Run `jobtrace auth refresh`.
- **A run is slow**: recordings wait `minDelayMs`–`maxDelayMs` between actions on
  purpose. Optional fields that are missing also cost a short wait each.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `pnpm lint`, `pnpm typecheck` and `pnpm test`
must pass.
