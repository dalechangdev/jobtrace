# JobTrace

Records how a user navigates a career site, then replays the steps to scrape job
listings. `PLAN.md` is the engineering plan: build one milestone at a time, in order,
and if a decision in it proves unworkable, stop and propose an alternative instead of
silently diverging. Record agreed changes in `PLAN.md` itself.

## Milestone status

- [x] M0 — Scaffold and mock sites
- [x] M1 — Recording format and replay engine
- [x] M2 — Recorder: basic actions
- [x] M3 — Recorder: lists, detail pages, pagination
- [x] M4 — Persistence
- [x] M4b — ATS API sources (Greenhouse, Lever, Ashby)
- [x] M5 — Auth profiles and politeness
- [x] M6 — API and worker
- [x] M7 — Web UI
- [x] M8 — Scheduler
- [x] M9 — Packaging and docs
- [x] M10 — AI fallback plugin

All planned milestones are built. What is left is under "Later" in `PLAN.md`.

A milestone is done when its acceptance criteria in `PLAN.md` pass, along with
`pnpm lint`, `pnpm typecheck`, `pnpm test`, and `README.md` covers anything user-facing.

## Commands

- `pnpm lint` — Biome, plus the workspace dependency rule (`scripts/check-deps.ts`)
- `pnpm format` — apply Biome formatting and safe fixes
- `pnpm typecheck` — one `tsc --noEmit` over the whole repo
- `pnpm test` — Vitest; runner and CLI tests launch headless Chromium against the mock sites
- `pnpm test -u` — also rewrite golden files (`packages/runner/src/__golden__`); review the diff
- `pnpm exec vitest run packages/runner` — one package
- `pnpm test-sites` — mock career sites on http://127.0.0.1:4400
- `pnpm jobtrace <command>` — the CLI (`record`, `run`, `recordings`, `runs`, `jobs`, `db migrate`)
- `pnpm db:migrate` — create or upgrade the database (also happens on first use)
- `pnpm --filter @jobtrace/db generate` — generate a SQL migration after editing `packages/db/src/schema.ts`

- `pnpm build:web` — build the web UI into `apps/web/dist`, which `jobtrace serve` serves
- `pnpm test:e2e` — build the UI, then drive it in a browser against a real server
- `docker compose --profile demo up -d --build` — the server in a container plus the mock sites; `docker compose down` stops it (data stays in the `jobtrace_jobtrace-data` volume)
- `pnpm dev:web` — the UI with hot reload on :5173, proxying `/api` to a running `jobtrace serve`; `pnpm dev` starts both

## Layout

- `packages/core` — recording Zod schemas and types, migrations, templating, errors, ids, config
- `packages/extractor` — transforms, salary/date parsing, URL canonicalization, normalization, dedup. No browser dependency: ATS API sources will reuse it.
- `packages/runner` — replay engine. `runRecording(recording, options)` is the one entry point.
- `packages/recorder` — `startRecording(options)` runs a session. `src/injected/` is the
  script that runs inside recorded pages (locator generator, event capture, overlay),
  bundled with esbuild at session start; `postprocess.ts` turns the raw capture into steps.
- `packages/db` — Drizzle schema, SQL migrations (`migrations/`), and the `Database`
  interface with its SQLite implementation. `openDatabase(url)` migrates on open.
- `packages/politeness` — robots.txt checks with a cache, per-domain locks, bot-wall
  detection (pure functions over a page snapshot) and Retry-After parsing. No browser
  dependency; the runner collects the snapshots.
- `packages/sources` — API sources: adapters mapping the Greenhouse, Lever and Ashby
  feeds to raw job records, and `fetchSource(source, options)`, which returns the same
  `RunResult` as a browser replay. No browser dependency.
- `packages/scheduler` — run execution and queueing: `executeRun` (replay or feed fetch, plus persistence),
  the `JobQueue` over the `runs` table, the `Worker` that executes queued runs, and the
  `RunHub` that carries live events to watchers, and the `Scheduler` that turns stored
  schedules into queued runs (`cron.ts` validates and describes cron expressions).
- `packages/ai-fallback` — the optional `LocatorResolver` that asks Claude (official
  `@anthropic-ai/sdk`, structured output). `aiHealing(config)` is what apps wire in; the
  runner validates every suggestion (`heal` in `packages/runner/src/locators.ts`). Tests
  replace the one `Suggest` function; nothing in the default test run calls the API.
- `packages/test-sites` — mock career sites; `src/data.ts` is the ground truth tests compare against
- `apps/api` — the HTTP API (Fastify with Zod schemas and OpenAPI). `buildApp(deps)`
  assembles routes; `startServer(options)` adds the worker and listens, and is what
  `jobtrace serve` calls. Routes are in `src/routes`, shapes in `src/schemas.ts`.
- `apps/web` — the React UI (Vite, TanStack Query, React Router, Tailwind). Pages in
  `src/pages`, shared pieces in `src/components`, primitives in `src/ui.tsx`, the API
  client in `src/api.ts`, pure helpers (with unit tests) in `src/lib`. End-to-end tests
  in `e2e/`.
- `apps/cli` — the `jobtrace` binary
- `examples/recordings` — hand-written recordings for the mock sites, also used by tests

## Conventions

- TypeScript strict, ESM only. There is no build step: Node 24 runs the `.ts` sources
  directly, so relative imports use `.ts` extensions and only erasable syntax is
  allowed (no `enum`, no constructor parameter properties, no namespaces).
- No `any` without a comment explaining why.
- Validate all external input with Zod (CLI args, API bodies, recording files, env).
- Errors: `JobTraceError` from `core/errors.ts` with a stable `code`
  (`LOCATOR_NOT_FOUND`, `AUTH_EXPIRED`, ...). Codes are persisted; never rename one.
- Library packages never call `process.exit` or read `process.env`; apps own config
  and process lifecycle.
- `core` depends on no workspace package. Packages never import from `apps/*`.
- The recording format (PLAN.md section 5) is the central contract. Changing it means
  bumping `CURRENT_SCHEMA_VERSION` and adding a migration in `core/src/migrations`.
- Every new step type or field transform needs: schema, runner support, recorder
  support (if recordable), unit tests, and a fixture-based test.
- `runRecording` never throws for run problems; it reports them through `status`,
  `reason` and `error`. Run-level errors (cancel, timeout, bot wall, auth, robots)
  must not be swallowed as per-item failures; see `isRunLevelError`.
- Code under `packages/recorder/src/injected` runs in the browser: no Node APIs, and
  only `import type` from `@jobtrace/core` (a value import would bundle Node code into
  the page). No `innerHTML` or inline styles there either; strict-CSP sites reject them.
- Messages from recorded pages are untrusted input; they are validated in
  `recorder/src/messages.ts` before use.
- The recorder keeps its state in Node (`session.ts`): mode, open scopes, captured
  items. Pages are stateless and ask for the status on every load, so anything a page
  needs after a reload (such as the open list's locators) must travel in the status.
- Recorder tests run headless with `openShadow: true` so they can click the overlay's
  buttons; drive the page with real input (`click`, `pressSequentially`), since scripted
  clicks and key presses are ignored on purpose.
- All database access goes through the `Database` interface in `packages/db`; no SQL or
  Drizzle outside that package. Methods are async and each is one transaction.
- Never edit an applied migration; change `schema.ts` and generate a new one. Raw SQL
  that Drizzle cannot express (the FTS table and its triggers) goes in a custom
  migration (`drizzle-kit generate --custom`).
- API routes declare Zod schemas for params, query, body and every response; responses
  are serialized through them, so a field missing from a schema is a 500 in tests, not
  a silent leak. Errors are `{ error: { code, message } }`; throw `JobTraceError` and
  let the error handler map it (`NOT_FOUND` 404, `INVALID_*` 400).
- The API must stay safe on localhost: keep the Host and Origin checks in
  `api/src/security.ts`, and never serve captured page HTML as HTML.
- The web UI talks to the server only through `apps/web/src/api.ts`, typed with the
  `Api*` types exported by `@jobtrace/api`; it imports nothing but types from other
  workspace packages. Editing logic belongs in `src/lib` as pure functions with tests.
- UI text is plain language for a job seeker, not internals: say what happened and what
  to do. Every form control has a visible label; dialogs use the `Dialog` primitive.
- CLI commands live in `apps/cli/src/commands`, get a `CliContext`, print results on
  stdout and messages on stderr, and take `--json` where they list things.
- A row in `recordings` is either a browser recording or an API source (`kind`);
  `StoredRecording` is a union, so check `stored.kind` before using `.recording` or
  `.source`. Anything that should work for both takes a `Definition`.
- Feed payloads are external input: adapters validate them with lenient Zod schemas
  (unknown fields ignored, absent ones tolerated) and skip unreadable entries.
- Time-based code is tested with Vitest fake timers (`vi.useFakeTimers`), as in
  `scheduler/src/schedules.test.ts`; never with real waits for a cron tick. Do not use
  fake timers in tests that drive a browser.
- The Docker image's Playwright base tag (`docker/Dockerfile`) must match the
  `playwright` version in the lockfile; bump them together.
- Never have two processes on different sides of a Docker file-sharing boundary open
  the same SQLite database. The host CLI talks to a containerized server through its
  API (`--server`), not through its files.
- Tests never use real websites. Use the mock sites with `fastOptions()` from
  `packages/runner/src/testing.ts` (no delays, short waits, fixed clock).
- No CAPTCHA solving, stealth plugins or fingerprint spoofing, ever. Guards in
  `runner/src/guards.ts` only ever stop a run; never add a retry that works around a
  refusal. Waiting out a `Retry-After` once is the only retry.
- Saved logins are secrets: session files are written `0600`, and their contents must
  never be logged, exported, or put in an event or error message.
- Changing the recording format means bumping `CURRENT_SCHEMA_VERSION`, adding a
  migration (even an identity one) and a line to the version history in `recording.ts`.
