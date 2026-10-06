# JobTrace

Record how you navigate a career website, then replay those steps to scrape its job
listings: manually now, on a schedule later. Open source (MIT), run by developers from
source.

> **Status: early.** The recording format, the replay engine and `jobtrace run` work
> (milestones M0–M1 of [PLAN.md](PLAN.md)). The point-and-click recorder, database,
> web UI, scheduler and ATS API sources are not built yet, so for now recordings are
> written by hand.

## Quickstart

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm --filter @jobtrace/runner exec playwright install chromium

pnpm test-sites        # mock career sites on http://127.0.0.1:4400 (leave running)
pnpm jobtrace run examples/recordings/list-detail.jobtrace.json
```

The jobs are printed as JSON on stdout; the run log goes to stderr.

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
