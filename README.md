# JobTrace

Record how you navigate a career website, then replay those steps to scrape its job
listings: manually now, on a schedule later. Open source (MIT), run by developers from
source.

> **Status: early.** You can record basic actions and single fields with
> `jobtrace record` and replay them with `jobtrace run` (milestones M0–M2 of
> [PLAN.md](PLAN.md)). Recording lists of jobs, detail pages and pagination comes next;
> until then those loops are written by hand (see `examples/recordings`). The database,
> web UI, scheduler and ATS API sources are not built yet.

## Quickstart

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm --filter @jobtrace/runner exec playwright install chromium

pnpm test-sites        # mock career sites on http://127.0.0.1:4400 (leave running)
pnpm jobtrace run examples/recordings/list-detail.jobtrace.json
```

The jobs are printed as JSON on stdout; the run log goes to stderr.

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
- **Stop**: finish and save. Closing the window or pressing Ctrl+C in the terminal does
  the same.

The recording is written to `--out`, or to `<name>.jobtrace.json` in the current
directory, and its path is printed on stdout. An existing file is never overwritten
unless you pass `--force`.

Things to know:

- **Passwords are never recorded.** Text typed into password, payment-card and
  one-time-code fields is skipped, with a warning. Scraping behind a login will use auth
  profiles (not built yet).
- Marked fields are one-off for now: marking the first job's title extracts the first
  job's title. Repeating that for every job on the page is the next milestone.
- After an action that changes the URL, the recording waits for the new URL using a
  pattern such as `**/jobs/*`. If a site's URLs change shape, delete or edit that
  `waitFor` step.
- A link that opens a new tab is recorded as a navigation to that tab's address,
  because replays stay in one tab.

## `jobtrace run`

```
jobtrace run <file> [--headed] [--trace] [--param key=value] [--artifacts <dir>]
                    [--max-pages <n>] [--max-items <n>] [--summary]
```

| Option | Effect |
|---|---|
| `--headed` | Show the browser window instead of running headless. |
| `--trace` | Save a Playwright trace; open it with `npx playwright show-trace <trace.zip>`. |
| `--param key=value` | Set a param the recording declares. Repeatable. |
| `--artifacts <dir>` | Where failure screenshots, DOM snapshots and traces go. Default: `DATA_DIR/artifacts/<run>`. |
| `--max-pages`, `--max-items` | Override the recording's limits for this run. |
| `--summary` | Print status, stats and artifact paths along with the jobs. |

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

JobTrace is meant for personal job searching. It waits a randomized delay between
actions, does not solve CAPTCHAs, and does not use stealth or fingerprint-evasion
techniques; when a site blocks automation, the run stops. Respect each site's terms
of use and `robots.txt`, and keep request volumes low. See [SECURITY.md](SECURITY.md).

## Troubleshooting

- **`LOCATOR_NOT_FOUND`**: no locator of a target matched. The error lists each
  locator and how many elements it matched; the screenshot and DOM snapshot in the
  artifacts directory show what the page looked like. A single-element target must
  match exactly one element.
- **`locator_drift` warnings**: the top-ranked locator stopped working and a fallback
  was used. The run still succeeds, but update the recording before the fallbacks
  break too.
- **A run is slow**: recordings wait `minDelayMs`–`maxDelayMs` between actions on
  purpose. Optional fields that are missing also cost a short wait each.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `pnpm lint`, `pnpm typecheck` and `pnpm test`
must pass.
