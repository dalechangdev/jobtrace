# JobTrace — Engineering Plan

> Working name: **JobTrace** (placeholder; rename freely).
> An open-source, developer-run tool that records how a user navigates a career website, then replays those steps to scrape job listings, manually now and on a schedule later.

---

## 0. How to use this document (instructions for Claude Code)

- Build **one milestone at a time**, in order (Section 15). Do not start a milestone until the previous one's acceptance criteria pass.
- Each milestone ends with: passing `pnpm lint`, `pnpm typecheck`, `pnpm test`, and an updated `README.md` section for anything user-facing.
- The **recording format (Section 5) is the central contract**. Every package depends on it. Change it only deliberately, bump `schemaVersion`, and write a migration.
- Prefer small, well-named modules with unit tests over large files.
- If a decision in this plan proves unworkable, stop and propose an alternative. Do not silently diverge.
- Keep a `CLAUDE.md` at the repo root with conventions, commands, and the current milestone status. Create it in Milestone 0.

---

## 1. Goals and non-goals

Primary use: the author's own job search (tracking specific companies across hosted ATS boards, Workday-style enterprise SPAs, and custom career sites). The point-and-click recorder is the core idea; open source is a bonus, so useful data beats polish when they conflict.

### Goals
1. **Record**: Launch a browser, let the user navigate a career site, and capture actions (navigation, clicks, typing, selects, key presses) plus user-marked data to extract.
2. **Generalize**: Turn recorded actions into a reusable program. "For each job card, extract fields" and "keep clicking Next" become loops, not literal replays.
3. **Replay**: Re-run recordings headless (or headed for debugging), robust to minor site changes.
4. **Persist**: Store recordings, runs, logs, and extracted jobs in a database with dedup and change detection.
5. **Trigger**: Run manually (CLI/UI) now. Support cron schedules.
6. **UI**: A local web app to manage recordings, inspect runs, browse jobs, and edit extraction.
7. **Open source**: MIT, runnable by developers from source or Docker Compose.
8. **API sources**: For hosted ATS boards with public JSON job feeds (Greenhouse, Lever, Ashby), read the feed directly instead of driving a browser. Results flow through the same normalization, dedup, and jobs tables (Milestone M4b).

### Non-goals (v1)
- No browser extension, app store, or hosted SaaS.
- No multi-user accounts (single-user, local). The design must not preclude adding them.
- No CAPTCHA solving, stealth or fingerprint evasion, or bot-detection bypass.
- No storing raw passwords. Auth uses saved browser session state only.
- No notifications (email/Slack/webhook). Planned for later; design hooks only.

---

## 2. Key decisions

| Area | Decision |
|---|---|
| Language | TypeScript (strict), ESM, Node.js 24 LTS |
| Package manager | pnpm workspaces (monorepo) |
| Browser automation | Playwright (Chromium) |
| Recording mechanism | App launches its own headed Playwright Chromium and injects a recorder script plus overlay toolbar. No extension. |
| Extraction definition | Marked during recording via the overlay; editable afterward in the UI |
| Replay robustness | Deterministic multi-locator fallback chain, then an **optional** AI fallback plugin (Claude API), off by default |
| Loops | Recordings support `forEach`, `paginate`, and `openDetail` constructs |
| Replay mode | Headless by default; `--headed` / UI toggle for debugging |
| Auth | Saved Playwright `storageState` per "auth profile". No credentials stored. |
| Bot walls | Detect, stop, mark run `blocked`, save screenshot. Never bypass. |
| Politeness | robots.txt respected by default, randomized delays, per-domain concurrency of 1 |
| Sources | Two kinds feed one jobs pipeline: browser recordings (default) and ATS API sources (public JSON feeds). `extractor` therefore takes plain raw records and must not depend on Playwright. |
| Data model | Fixed core job schema plus per-recording custom fields (JSON) |
| Change detection | Dedup across runs; flag new and changed jobs per run |
| Database | SQLite (better-sqlite3) via Drizzle ORM. Repository layer isolates queries so Postgres can be added later. |
| API | Fastify with Zod type provider; OpenAPI generated; SSE for live run logs |
| UI | React + Vite, TanStack Query, React Router, Tailwind + shadcn/ui |
| Scheduling | In-process scheduler (`croner`, timezone-aware) plus DB-backed run queue and worker loop. `JobQueue` interface allows pg-boss later. |
| CLI | `commander` |
| Logging | `pino` (JSON); run events also persisted to DB |
| Validation | `zod` everywhere at boundaries |
| Lint/format | Biome |
| Tests | Vitest (unit/integration), Playwright against local mock career sites (e2e) |
| Packaging | Docker Compose for server + worker; recording runs on the host (needs a display) |
| License | MIT |

---

## 3. Architecture

```
                ┌───────────────────────────────────────────────┐
                │                 apps/web (React)              │
                │  recordings · runs · jobs · schedules · auth  │
                └──────────────────────┬────────────────────────┘
                                       │ HTTP + SSE
┌──────────────┐               ┌───────▼────────┐
│  apps/cli    │──────────────▶│   apps/api     │  Fastify, 127.0.0.1 by default
│ record / run │   (direct     │  REST + SSE    │
│ auth / serve │   package     └───────┬────────┘
└──────┬───────┘   imports)            │
       │                     ┌─────────▼─────────┐     ┌──────────────────┐
       │                     │ packages/scheduler│────▶│  run queue (DB)  │
       │                     │ croner → enqueue  │     └────────┬─────────┘
       │                     └───────────────────┘              │
       │                                              ┌─────────▼─────────┐
       ├─────────────────────────────────────────────▶│ packages/runner   │
       │                                              │ interpret recording│
┌──────▼──────────────┐                               │ Playwright, limits │
│ packages/recorder   │  produces Recording JSON      └──┬──────────┬─────┘
│ headed Chromium +   │─────────────┐                    │          │
│ injected overlay    │             │           ┌────────▼───┐  ┌───▼──────────────┐
└─────────────────────┘             │           │ extractor  │  │ ai-fallback      │
                           ┌────────▼───────┐   │ normalize, │  │ (optional plugin)│
                           │ packages/core  │   │ dedup keys │  └──────────────────┘
                           │ Zod schemas,   │   └────────┬───┘
                           │ types, DSL     │            │
                           └────────────────┘   ┌────────▼────────┐
                                                │ packages/db     │
                                                │ Drizzle, repos, │
                                                │ migrations      │
                                                └─────────────────┘
```

Single process in v1: `jobtrace serve` runs the API, scheduler, and worker together. The worker is a module with its own entrypoint (`jobtrace worker`) so it can be split out later.

---

## 4. Repository layout

```
jobtrace/
├─ apps/
│  ├─ api/            Fastify server: routes, SSE, worker bootstrap
│  ├─ web/            React + Vite UI
│  └─ cli/            `jobtrace` CLI (bin)
├─ packages/
│  ├─ core/           Recording DSL Zod schemas, shared types, config loader, errors
│  ├─ recorder/       Recorder: browser launch, injected script, overlay, locator generation, post-processing
│  ├─ runner/         Replay engine: step interpreter, locator resolution, loops, limits, artifacts
│  ├─ extractor/      Field transforms, normalization to core schema, dedup and content hashing
│  ├─ politeness/     robots.txt checks, delay/jitter, per-domain locks, bot-wall detection
│  ├─ db/             Drizzle schema, migrations, repositories
│  ├─ scheduler/      Cron scheduling, run queue, worker loop
│  ├─ ai-fallback/    Optional LocatorResolver using Claude API
│  └─ test-sites/     Local mock career sites for tests and demos
├─ docker/            Dockerfile(s)
├─ docker-compose.yml
├─ .github/workflows/ci.yml
├─ CLAUDE.md
├─ PLAN.md
├─ README.md
├─ CONTRIBUTING.md
├─ SECURITY.md
└─ LICENSE
```

Dependency rule: `core` depends on nothing internal. `apps/*` may depend on any package. Packages must not import from `apps/*`. Enforce with Biome or a simple lint script.

---

## 5. Recording format (central contract)

A **Recording** is versioned JSON validated by Zod in `packages/core`. Steps form a tree, because loops contain nested steps.

### 5.1 Top level

```jsonc
{
  "schemaVersion": 1,
  "id": "rec_01J...",
  "name": "Acme Careers – Engineering",
  "startUrl": "https://careers.acme.example/jobs",
  "authProfileId": null,              // or an auth profile id
  "params": {                         // optional, referenced as {{params.keyword}}
    "keyword": { "default": "engineer" }
  },
  "settings": {
    "maxPages": 20,
    "maxItems": 1000,
    "minDelayMs": 1000,
    "maxDelayMs": 3000,
    "stepTimeoutMs": 15000,
    "respectRobotsTxt": true
  },
  "steps": [ /* Step[] */ ]
}
```

### 5.2 Targets (how elements are found)

Every element reference is a `Target` with **several ranked locators** plus a **fingerprint** for healing:

```jsonc
{
  "locators": [
    { "kind": "testId", "value": "job-card-title" },
    { "kind": "role",   "role": "link", "name": "Senior Backend Engineer" },
    { "kind": "text",   "value": "Senior Backend Engineer", "exact": true },
    { "kind": "css",    "value": "ul.jobs > li:nth-child(1) a.title" },
    { "kind": "xpath",  "value": "//ul[@class='jobs']/li[1]//a" }
  ],
  "fingerprint": {
    "tag": "a",
    "text": "Senior Backend Engineer",
    "attrs": { "class": "title", "href": "/jobs/123" },
    "ancestorTrail": ["li.job", "ul.jobs", "main"]
  },
  "frame": [],          // chain of frame selectors for iframes, outermost first
  "relativeTo": null    // "item" when inside a forEach scope
}
```

Locator ranking prefers stable signals: test ids, then ARIA role and name, then stable attributes, then text, then CSS, then XPath. **Avoid** generated class names (heuristic: hashes, long random tokens) and positional `nth-child` when an alternative exists. For list items, the locator must match **all** items, not just the first one.

### 5.3 Step types

| type | Fields | Notes |
|---|---|---|
| `navigate` | `url` | Supports `{{params.*}}` templating |
| `click` | `target` | |
| `fill` | `target`, `value` | `value` may be templated. Password-type inputs are **never** recorded; see Section 7. |
| `select` | `target`, `value` | `<select>` and common custom dropdowns via click sequences |
| `press` | `target?`, `key` | e.g. `Enter` |
| `scroll` | `target?`, `mode: "toBottom" \| "by"`, `amount?` | |
| `waitFor` | `target` or `urlPattern` or `ms` | Prefer element/url waits; `ms` is a last resort |
| `extract` | `scope: "page" \| "item"`, `fields: Field[]` | |
| `forEach` | `items: Target`, `body: Step[]` | Iterates over all matches; body targets are relative to the item |
| `openDetail` | `link: Target`, `body: Step[]`, `strategy: "sameTab" \| "newTab"` | Opens an item's detail page, runs body, returns to list |
| `paginate` | `mode: "nextButton" \| "infiniteScroll" \| "urlPattern"`, `next?: Target`, `urlTemplate?`, `body: Step[]`, `until` | Stops when next is missing or disabled, when no new items load, at `maxPages`, or on a repeated page fingerprint |

### 5.4 Fields

```jsonc
{
  "name": "title",                 // core field name or custom name
  "target": { /* Target */ },
  "read": "text",                  // "text" | "innerHTML" | "attr"
  "attr": null,                    // e.g. "href" when read = "attr"
  "transforms": ["trim", "collapseWhitespace"],  // also: "absoluteUrl", "regex:<pattern>", "parseDate", "parseSalary"
  "required": false
}
```

### 5.5 Example (list → detail with pagination)

```jsonc
"steps": [
  { "id": "s1", "type": "navigate", "url": "https://careers.acme.example/jobs" },
  { "id": "s2", "type": "fill", "target": { /* search box */ }, "value": "{{params.keyword}}" },
  { "id": "s3", "type": "press", "key": "Enter" },
  { "id": "s4", "type": "paginate", "mode": "nextButton", "next": { /* Next */ },
    "until": "nextMissingOrDisabled",
    "body": [
      { "id": "s5", "type": "forEach", "items": { /* li.job */ },
        "body": [
          { "id": "s6", "type": "extract", "scope": "item", "fields": [
              { "name": "title", "target": { /* a.title */ }, "read": "text" },
              { "name": "url", "target": { /* a.title */ }, "read": "attr", "attr": "href", "transforms": ["absoluteUrl"] },
              { "name": "location", "target": { /* .loc */ }, "read": "text" }
          ]},
          { "id": "s7", "type": "openDetail", "link": { /* a.title */ }, "strategy": "sameTab",
            "body": [
              { "id": "s8", "type": "extract", "scope": "page", "fields": [
                  { "name": "description", "target": { /* .job-body */ }, "read": "text" }
              ]}
          ]}
      ]}
  ]}
]
```

### 5.6 Versioning
- `schemaVersion` is an integer. `packages/core/migrations` holds pure functions `vN → vN+1`. Loading always migrates to the latest version.
- Recordings are export/importable as `.jobtrace.json` files, so they can be shared in Git.

---

## 6. Recorder (`packages/recorder`)

### 6.1 Session flow
1. `jobtrace record <url> --name "Acme"` (or **New recording** in the UI) launches **headed** Chromium via Playwright. Use the selected auth profile's `storageState` if one is set.
2. Inject the recorder script with `context.addInitScript` and expose a binding (`context.exposeBinding('__jobtrace', ...)`) so page events reach Node.
3. Inject an **overlay toolbar** in a closed Shadow DOM so site CSS does not affect it, and exclude it from captured events. Modes:
   - **Record** (default): capture actions.
   - **Mark field**: next click marks an element as a data field and prompts for a field name (core fields offered in a dropdown, or custom).
   - **Mark list**: next click marks one item; the recorder finds structurally similar siblings, highlights all matches, and asks to confirm. Starts a `forEach` scope.
   - **Mark next page**: marks the pagination control (or chooses "infinite scroll").
   - **Open detail**: the next link click inside a list scope becomes an `openDetail` step; extraction marked on the detail page goes into its body.
   - **Finish scope / Stop**.
4. On stop, run post-processing (6.3), validate with Zod, and save to DB or file.

### 6.2 Event capture
- `click` (capture phase, ignoring synthetic events), `input`/`change` debounced into a single `fill` per field, `keydown` for Enter/Escape/Tab, `submit`, and `select` changes.
- Navigation: listen to `page.on('framenavigated')` for the main frame. Distinguish user-typed URL changes from navigations caused by clicks; the latter must not become extra `navigate` steps.
- New tabs and popups: `context.on('page')` follows into the new page and records a tab switch.
- iframes: record the frame chain into `Target.frame`. Shadow DOM: pierce open shadow roots when generating locators.
- **Sensitive input**: never record values from `input[type=password]`, or fields whose `autocomplete` contains `password`, `cc-`, or `one-time-code`. Emit a warning step that tells the user to use an auth profile instead.

### 6.2a Decisions made while building M2
- **Injected script**: authored as ordinary TypeScript modules under `packages/recorder/src/injected` and bundled into one IIFE with esbuild the first time a session starts. There is still no separate build step.
- **Typed URL vs. click-caused navigation**: decided from Chromium's own signal (CDP `Page.frameRequestedNavigation` fires only for navigations the page started), not from timing. Back, forward and reload count as typed.
- **Sensitive input**: the format has no "warning step", so warnings are returned next to the recording (`RecorderResult.warnings`), printed by the CLI and shown as a toast. Fields are also treated as sensitive when their name or id looks like a password, card or one-time-code field.
- **New tabs**: replays stay in one tab, so a click that opens a new tab is replaced by a `navigate` to that tab's URL, with a warning.
- **`submit` and `scroll` events** are not captured as steps: a submit always follows a recorded Enter or click, and scrolling arrives with infinite scroll in M3. Enter on a form field is recorded as the key press only; the click the browser then fires on the submit button is ignored.
- **`input`/`change` events** are accepted even when a script dispatched them (what matters is the resulting value); clicks and key presses must be real user input.
- **Field targets** never use text or name-based locators, because the text is what changes between runs.
- **Locator checking**: each generated locator is checked in the page, then again with the real Playwright engine while the element is still there. After a click that navigated away, the second check is not possible and the locators are kept as generated.

### 6.3 Post-processing
- Merge redundant steps (click-then-fill on the same input becomes a fill; consecutive scrolls are coalesced).
- Drop no-op clicks (e.g. on non-interactive elements with no effect) when a later step clearly supersedes them.
- Insert an implicit `waitFor` on the new URL after actions that changed the URL. The pattern generalizes what varies between runs: ids in the path, typed search terms, the query string (e.g. `**/jobs/*`, `**/search?*`). Actions that only changed the DOM get no wait; the next step's own locator wait covers them.
- Validate each locator against a DOM snapshot taken at capture time: it must resolve uniquely (or to all items for list targets).

### 6.4 Locator generation
- Implement in the injected script (it needs the live DOM) with a Node-side validator.
- Do **not** depend on Playwright codegen internals (not a public API). Write our own generator, borrowing ideas.
- Unit-test the generator heavily against fixture HTML.

---

## 7. Auth profiles

- `jobtrace auth create <name> --url <loginUrl>` opens headed Chromium. The user logs in by hand, then presses **Save** in the overlay (or Enter in the terminal). The app saves `context.storageState()` to `DATA_DIR/auth/<id>.json` with file mode `0600`.
- DB row: `auth_profiles(id, name, domain, storage_state_path, created_at, last_verified_at)`.
- Before a run, optionally verify the session with a recording-defined "logged-in check" target. If it fails, mark the run `failed` with reason `auth_expired` and tell the user to re-run `auth refresh`.
- Storage-state files and the data dir are gitignored. Document the sensitivity in `SECURITY.md`.

---

## 8. Replay engine (`packages/runner`)

### 8.1 Execution
- `runRecording(recording, options) → RunResult`, a pure library function that the CLI, API worker, and tests all call.
- Interpret the step tree recursively with an execution context: current page, scope element (inside `forEach`), params, counters, and an abort signal.
- Headless by default; `headed: true` for debugging. `slowMo` is optional.
- Use Playwright locators (auto-waiting) with `settings.stepTimeoutMs`.
- Insert a randomized delay between navigations and actions (`minDelayMs`–`maxDelayMs`).
- Enforce `maxPages`, `maxItems`, and a global run timeout. Support cancellation via `AbortSignal`.

### 8.2 Locator resolution chain
1. Try each locator in rank order. Accept the first that resolves (uniquely for single targets, ≥1 for list targets).
2. If all fail and the **ai-fallback** plugin is enabled, call `LocatorResolver.resolve(target, pageSnapshot)` (Section 12).
3. Otherwise fail the step with a clear error that lists the locators tried, and save a screenshot plus DOM snapshot.
- Record which locator succeeded (`run_events`). Surface "locator drift" in the UI when the top-ranked locator stops working.

### 8.3 Loops
- `forEach`: count items once, then iterate by index, re-querying each time (the DOM may re-render). Per-item errors are logged and skipped. The run ends `partial` instead of `failed` if some items succeed.
- `openDetail`: `sameTab` clicks, runs the body, then `goBack()` and waits for the list to be restored (verify by item count or fingerprint). If restoration fails, fall back to re-navigating to the list URL. `newTab` opens the href in a new page and closes it afterward. Prefer `newTab` when the link has an absolute href.
- `paginate`: track a hash of each page's item text to detect loops (content only, since in `urlPattern` mode the URL differs even when a site serves its last page again). After clicking Next, a changed URL or changed item text counts as a new page. Infinite scroll stops when the item count does not grow after N attempts.

### 8.4 Run statuses
`queued → running → succeeded | partial | failed | blocked | cancelled`

### 8.5 Artifacts
- Screenshot on failure or block (always). Optional full-page screenshot per page.
- Optional Playwright trace (`--trace`) saved as a zip, viewable with `npx playwright show-trace`.
- Stored under `DATA_DIR/artifacts/<runId>/`, indexed in the `artifacts` table, with retention configurable (default: keep the last 20 runs per recording).

---

## 9. Politeness and bot walls (`packages/politeness`)

- **robots.txt**: fetch and cache per origin (24h) with `robots-parser`. When `respectRobotsTxt` is true, disallowed URLs stop the run with status `failed`, reason `robots_disallowed`. Overriding requires an explicit per-recording setting, and the UI shows a warning.
- **Rate limiting**: per-domain mutex (one active run per domain), randomized delays, honor `Retry-After` on 429.
- **Bot-wall detection** (heuristics, extensible list):
  - iframes or scripts from reCAPTCHA, hCaptcha, or Cloudflare Turnstile become visible
  - HTTP 403/429 on main-frame navigations
  - known challenge page titles or text (e.g. "Just a moment", "Verify you are human")
  - On detection: screenshot, status `blocked`, stop. **No** retries that try to evade.
- User agent: Playwright's default Chromium UA. No stealth plugins. Do not spoof fingerprints.
- `README` includes a responsible-use section: respect site terms, keep volumes low, and use for personal job searching.

---

## 10. Extraction, normalization, and dedup (`packages/extractor`)

### 10.1 Core job schema
| field | type | notes |
|---|---|---|
| `title` | string | required for a job to be saved |
| `company` | string? | defaults to a recording-level `company` setting if not extracted |
| `location` | string? | raw text |
| `remote` | enum? | `onsite \| hybrid \| remote \| unknown`, inferred from text |
| `salaryText` | string? | raw |
| `salaryMin` / `salaryMax` / `salaryCurrency` / `salaryPeriod` | parsed, nullable | best-effort `parseSalary` |
| `url` | string? | absolutized, canonicalized |
| `description` | string? | plain text; optionally keep `descriptionHtml` |
| `postedAt` | date? | `parseDate` supports relative formats ("3 days ago") using run time |
| `employmentType` | string? | |
| `custom` | JSON | any non-core fields |

### 10.2 Dedup and change detection
- **Dedup key**: canonical URL (lowercased host; tracking params like `utm_*`, `gh_src`, `source`, and `ref` stripped; trailing slash normalized). If there is no URL, use `sha256(recordingId + title + company + location)`.
- Uniqueness scope: `(recording_id, dedup_key)`.
- **Content hash**: `sha256` of normalized core fields plus `custom`, **excluding `postedAt`**. A different hash on a later run marks the job **changed**. (`postedAt` is left out because sites that show relative dates such as "3 days ago" or "30+ days ago" would otherwise make every job look changed on every run.)
- Per run, every job gets a `run_jobs` row with `is_new` / `is_changed`. `jobs.first_seen_at`, `last_seen_at`, and `first_seen_run_id` are maintained.
- Optional: mark `jobs.closed_at` when a job is missing for N consecutive **successful** runs (N=3 by default). Never after partial or failed runs.

---

## 11. Database (`packages/db`)

SQLite via `better-sqlite3` with WAL mode, Drizzle ORM, and Drizzle Kit migrations. All access goes through **repository modules** (`recordingsRepo`, `runsRepo`, `jobsRepo`, …) so a Postgres implementation can be added later without touching callers.

### Tables
- `recordings(id, name, start_url, domain, definition_json, schema_version, auth_profile_id, created_at, updated_at)`
- `recording_versions(id, recording_id, definition_json, created_at, note)`: snapshot on every save, used for undo and diffs
- `auth_profiles(id, name, domain, storage_state_path, created_at, last_verified_at)`
- `schedules(id, recording_id, cron, timezone, enabled, params_json, last_run_at, next_run_at, created_at)`
- `runs(id, recording_id, recording_version_id, schedule_id, trigger, status, reason, params_json, started_at, finished_at, stats_json, error_json, created_at)`
  - `trigger`: `manual | schedule | cli`
  - `stats_json`: pages, items seen, new, changed, errors, duration
- `run_events(id, run_id, ts, level, step_id, type, message, data_json)`
- `jobs(id, recording_id, dedup_key, title, company, location, remote, salary_text, salary_min, salary_max, salary_currency, salary_period, url, description, posted_at, employment_type, custom_json, content_hash, first_seen_at, last_seen_at, first_seen_run_id, closed_at)`, unique on `(recording_id, dedup_key)`
- `run_jobs(run_id, job_id, is_new, is_changed)`, PK `(run_id, job_id)`
- `artifacts(id, run_id, type, path, created_at)`
- `settings(key, value_json)`

Indexes: `runs(recording_id, created_at)`, `runs(status)`, `jobs(last_seen_at)`, `jobs(first_seen_at)`, `run_events(run_id, ts)`. Add FTS5 on `jobs(title, company, location, description)` for search.

IDs: ULIDs with prefixes (`rec_`, `run_`, `job_`, …).

---

## 12. AI fallback plugin (`packages/ai-fallback`) — optional

- Interface in `core`: `LocatorResolver { resolve(target, ctx): Promise<ResolvedLocator | null> }`.
- Enabled only when `AI_FALLBACK_ENABLED=true` and `ANTHROPIC_API_KEY` is set. Model configurable via `AI_FALLBACK_MODEL`.
- Input: the target's fingerprint, the failed locators, and a **trimmed** accessibility or DOM snapshot of the current page (cap size, strip scripts and styles, never include input values or cookies).
- Output: a structured candidate locator (JSON schema). The runner **validates** that it resolves and roughly matches the fingerprint (tag, text similarity) before using it.
- Healed locators are stored as **suggestions** on the recording (`run_events` type `locator_suggestion`). The UI offers "accept" to prepend them to the target's locator list. Not auto-applied unless `AI_FALLBACK_AUTO_APPLY=true`.
- Per-run call cap (default 10) to bound cost.

---

## 13. Scheduling and execution (`packages/scheduler`)

- **Queue**: the `runs` table itself (`status = queued`). `JobQueue` interface with `enqueue`, `claimNext`, `complete`, and `fail`. The SQLite implementation claims atomically in a transaction.
- **Worker loop**: polls (e.g. every 2s, or wakes immediately on in-process enqueue). Concurrency is `MAX_CONCURRENT_RUNS` (default 2), always subject to the per-domain lock.
- **Scheduler**: on startup, loads enabled schedules and registers `croner` jobs with the schedule's timezone (default system TZ). Each tick enqueues a run with `trigger = schedule`. Reloads on schedule CRUD.
- **Missed runs**: not backfilled. Logged.
- **Overlap**: if a recording already has a queued or running run, skip the tick and log it.
- **Crash recovery**: on startup, runs left in `running` are marked `failed` with reason `interrupted`.
- Manual triggers (CLI or API) enqueue the same way. The CLI `run` command can also execute in-process directly (`--now`) without a server.

---

## 14. Interfaces

### 14.1 CLI (`apps/cli`, binary `jobtrace`)
```
jobtrace record <url> [--name] [--auth <profile>] [--out file.jobtrace.json]
jobtrace run <recordingId|file> [--headed] [--trace] [--param key=value] [--now]
jobtrace recordings list | show <id> | export <id> | import <file> | delete <id>
jobtrace runs list [--recording <id>] | show <runId>
jobtrace jobs list [--new] [--recording <id>] [--json]
jobtrace auth create <name> --url <loginUrl> | refresh <name> | list | delete <name>
jobtrace schedule add <recordingId> --cron "0 8 * * 1-5" [--tz Europe/Madrid] | list | remove <id>
jobtrace serve [--port 4317] [--host 127.0.0.1]
jobtrace db migrate
```

### 14.2 API (`apps/api`)
- Binds `127.0.0.1` by default. If `HOST` is not loopback, require `API_TOKEN` (bearer) and log a warning.
- Zod schemas from `core` produce the OpenAPI spec at `/api/docs`.
- Routes:
  - `GET/POST /api/recordings`, `GET/PUT/DELETE /api/recordings/:id`, `GET /api/recordings/:id/versions`
  - `POST /api/recordings/record` starts a headed recording session on the host (local only), and `GET /api/record-sessions/:id` reports its status
  - `POST /api/recordings/:id/runs` triggers a manual run (body: params, headed, trace)
  - `GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`
  - `GET /api/runs/:id/events/stream` (SSE live log)
  - `GET /api/runs/:id/artifacts/:artifactId`
  - `GET /api/jobs?recording=&new=&q=&from=&to=&page=`, `GET /api/jobs/:id`
  - `GET/POST/PUT/DELETE /api/schedules`
  - `GET/POST/DELETE /api/auth-profiles` (create starts a headed login session)
  - `GET /api/health`

### 14.3 UI (`apps/web`)
- **Dashboard**: recent runs with statuses, new jobs since last visit, upcoming scheduled runs.
- **Recordings**: list; detail shows the step tree (collapsible), lets you edit fields, rename, reorder locators, accept AI suggestions, set params and settings, view version history, and use **Run now** / **Run headed** / **Test step**.
- **Runs**: list with filters; detail shows a live SSE log, step-by-step timeline, screenshots, stats, and extracted jobs with new/changed badges.
- **Jobs**: searchable, filterable table (recording, new, date range, remote), detail drawer, CSV/JSON export.
- **Schedules**: CRUD with cron helper and human-readable preview ("Weekdays at 08:00 Europe/Madrid") plus next 5 run times.
- **Auth profiles**: create, refresh, delete, last verified.
- **Settings**: concurrency, delays, retention, AI fallback toggle (key stays in env, never stored in DB).
- Vite dev server proxies `/api` to the API. In production, the API serves the built UI as static files.

---

## 15. Milestones

Order rationale: the recording format and a replay engine come first, so the recorder has a well-tested target to produce. Persistence, API, UI, and scheduling build on top.

### M0 — Scaffold and mock sites
- pnpm monorepo, TS strict configs, Biome, Vitest, GitHub Actions CI (install, lint, typecheck, test, Playwright browsers cached).
- `packages/test-sites`: a small local server (Fastify static plus a few routes) with fixture sites:
  1. Simple static job list
  2. Paginated list with Next button (and disabled state on the last page)
  3. Infinite scroll list
  4. List → detail pages
  5. SPA with client-side routing and delayed rendering
  6. Login-gated board (fake login, cookie session)
  7. Job board embedded in an iframe
  8. Bot-wall page (fake challenge page and a 429 route)
  9. "v2" of site 4 with changed class names but same structure and text (locator-drift test)
- `CLAUDE.md`, `README.md` skeleton, `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`.
- **Accept**: `pnpm test` passes in CI; `pnpm test-sites` serves all fixtures.

### M1 — Recording format and replay engine
- `core`: Zod schemas for Section 5, types, templating, migration framework (v1 only).
- `runner`: interpreter for all step types, locator chain, loops, limits, delays, cancellation, artifacts, run status logic.
- `extractor`: transforms, normalization, dedup key and content hash.
- Hand-written recordings for test sites 1–5 and 7.
- CLI: `jobtrace run <file> [--headed] [--trace]` printing jobs as JSON.
- **Accept**: hand-written recordings extract the expected jobs from sites 1–5 and 7; site 9 still works via fallback locators (text/role) when CSS fails; unit tests cover transforms, salary/date parsing, URL canonicalization.

### M2 — Recorder: basic actions
- Headed launch, injected script, event capture, overlay (Record / Mark field / Stop), locator generator, post-processing, sensitive-input redaction.
- CLI: `jobtrace record <url> --out file.jobtrace.json`.
- Automated recorder tests: drive the headed (or headless with overlay) recorder programmatically with Playwright, perform actions on test sites, assert the generated recording, and replay it with the runner.
- **Accept**: recording on sites 1 and 5 then replaying yields the same extracted data; password values never appear in output (test).

### M3 — Recorder: lists, detail pages, pagination
- Overlay modes: Mark list (sibling detection plus highlight confirmation), Open detail, Mark next page / infinite scroll, Finish scope.
- Post-processing that produces `forEach` / `openDetail` / `paginate` trees.
- **Accept**: record → replay works end-to-end on sites 2, 3, 4, and 7; extracted counts match fixture ground truth.

### M4 — Persistence
- `db` package: schema, migrations, repositories, FTS.
- Runner integration: runs, run events, jobs, run_jobs, artifacts, dedup and new/changed flags, closed detection.
- CLI: `recordings`, `runs`, `jobs` commands; `record` saves to DB by default.
- **Accept**: two consecutive runs on a fixture where the second run has 1 added and 1 modified job produce correct `is_new` / `is_changed` flags; retention cleanup works.

### M4b — ATS API sources
- A source adapter interface (`fetchJobs(config) → RawJobRecord[]`) with adapters for the public Greenhouse, Lever, and Ashby job-board feeds. No browser involved.
- Raw records go through the same `extractor` normalization, dedup, and change detection as recorded runs, and produce ordinary `runs` / `run_jobs` rows.
- Design the storage shape at the start of this milestone (a `kind` on the recording row vs. a separate `sources` table) and record the decision here before coding.
- Politeness still applies: robots.txt, per-domain lock, delays, `Retry-After`.
- CLI: `jobtrace source add <greenhouse|lever|ashby> <boardToken> [--name]`; `jobtrace run` works on a source id.
- **Accept**: adapters tested against recorded fixture responses served by `test-sites`; two consecutive runs with 1 added and 1 modified job produce correct `is_new` / `is_changed` flags.

### M5 — Auth profiles and politeness
- Auth profile capture, storage, use in record and run, logged-in check.
- `politeness` package: robots.txt, per-domain lock, delays, 429 handling, bot-wall detection.
- **Accept**: site 6 works with a saved profile and fails cleanly with `auth_expired` after the session is invalidated; site 8 yields `blocked` with screenshot; robots-disallowed fixture yields `robots_disallowed`.

### M6 — API and worker
- Fastify app, Zod/OpenAPI, all routes in 14.2 except schedules, SSE run stream, DB-backed queue and worker, crash recovery, loopback binding and token rule.
- `jobtrace serve`.
- **Accept**: API integration tests (inject) for CRUD and triggering runs; SSE stream delivers events for a live run; cancel works.

### M7 — Web UI
- All pages in 14.3 except Schedules.
- Start recording and auth sessions from the UI (host-local).
- **Accept**: Playwright e2e against the running app: create a recording via the UI on a test site, run it, see live logs, see jobs with "new" badges, edit a field name and rerun.

### M8 — Scheduler
- `scheduler` package, schedule routes, CLI `schedule` commands, UI Schedules page.
- **Accept**: unit tests with fake timers for cron registration, overlap skipping, and timezone handling; integration test enqueues a run from a schedule tick.

### M9 — Packaging and docs
- Dockerfile (based on the official Playwright image) and `docker-compose.yml` running `jobtrace serve` with a volume for `DATA_DIR`.
- Docs: headed recording and auth sessions run on the host via CLI, while the containerized server performs scheduled headless runs against the same data volume.
- README: quickstart, concepts, recording guide, responsible-use, troubleshooting (locator drift, blocked runs).
- **Accept**: fresh clone → `docker compose up` → UI reachable → import an example recording → run succeeds against the bundled test sites.

### M10 — AI fallback plugin
- Implement Section 12, settings toggle, suggestion acceptance in UI.
- Tests use a mocked Claude client; one optional live test gated behind an env var.
- **Accept**: on site 9 with all deterministic locators deliberately broken, the plugin (mocked) heals the step; suggestions appear in the UI and can be accepted.

### Later (not scheduled)
- Postgres repositories and pg-boss `JobQueue`.
- Notifications on new jobs: desktop notification first (the author's preferred channel), then webhook, then email/Slack.
- Multi-user accounts.
- Recording diff viewer, shared recording library, ATS-specific recording presets (e.g. Workday).

---

## 16. Configuration

Loaded once in `core/config.ts`, validated with Zod, from env (with `.env` support) and CLI flags overriding env.

| Var | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `~/.jobtrace` | DB, auth states, artifacts |
| `DATABASE_URL` | `file:${DATA_DIR}/jobtrace.db` | SQLite path (Postgres later) |
| `HOST` / `PORT` | `127.0.0.1` / `4317` | API bind |
| `API_TOKEN` | — | Required when `HOST` is not loopback |
| `MAX_CONCURRENT_RUNS` | `2` | Worker concurrency |
| `DEFAULT_MIN_DELAY_MS` / `DEFAULT_MAX_DELAY_MS` | `1000` / `3000` | Politeness |
| `ARTIFACT_RETENTION_RUNS` | `20` | Per recording |
| `AI_FALLBACK_ENABLED` | `false` | Plugin toggle |
| `ANTHROPIC_API_KEY` | — | Plugin |
| `AI_FALLBACK_MODEL` | — | Plugin model id |
| `AI_FALLBACK_MAX_CALLS` | `10` | Per run |
| `LOG_LEVEL` | `info` | pino |

---

## 17. Testing strategy

- **Unit (Vitest)**: schemas and migrations, templating, locator generator (fixture HTML), transforms, salary/date parsing, URL canonicalization, dedup and hashing, robots logic, bot-wall heuristics, queue claim logic, cron logic with fake timers.
- **Integration**: runner against `test-sites` (headless), DB repositories against a temp SQLite file, API via Fastify `inject`.
- **E2E (Playwright test)**: recorder record → replay round-trips; full app flows in M7+.
- **Golden files**: expected extraction JSON per fixture site, committed; tests diff against them.
- CI runs everything headless. Recorder tests that need a headed browser run under `xvfb-run` on Linux CI.
- Coverage target: 80% for `core`, `extractor`, `runner`, `politeness`.

---

## 18. Security and responsible use

- Default loopback binding; token required otherwise.
- Auth storage states are secrets: `0600`, never logged, never sent to the AI plugin, excluded from exports.
- Recorded `fill` values: password and payment fields are never captured.
- AI plugin sends minimal, sanitized page snapshots only when explicitly enabled.
- No CAPTCHA solving, stealth, or fingerprint evasion. `SECURITY.md` and `README` state this and ask users to respect site terms and robots.txt.

---

## 19. Conventions (copy into `CLAUDE.md`)

- TypeScript strict, ESM only, no `any` without a comment explaining why.
- Validate all external input with Zod (CLI args, API bodies, recording files, env).
- Errors: typed error classes in `core/errors.ts` with stable `code` strings (e.g. `LOCATOR_NOT_FOUND`, `AUTH_EXPIRED`, `ROBOTS_DISALLOWED`, `BOT_WALL`).
- Library packages never call `process.exit` or read env directly; apps own config and process lifecycle.
- Every new step type or field transform needs: schema, runner support, recorder support (if recordable), unit tests, and a fixture-based test.
- Commands: `pnpm dev` (api + web), `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm typecheck`, `pnpm test-sites`, `pnpm db:migrate`.
