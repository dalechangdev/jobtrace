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
- [ ] M5 — Auth profiles and politeness  ← next
- [ ] M6 — API and worker
- [ ] M7 — Web UI
- [ ] M8 — Scheduler
- [ ] M9 — Packaging and docs
- [ ] M10 — AI fallback plugin

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

Not available yet (later milestones): `pnpm dev`, `pnpm test:e2e`.

## Layout

- `packages/core` — recording Zod schemas and types, migrations, templating, errors, ids, config
- `packages/extractor` — transforms, salary/date parsing, URL canonicalization, normalization, dedup. No browser dependency: ATS API sources will reuse it.
- `packages/runner` — replay engine. `runRecording(recording, options)` is the one entry point.
- `packages/recorder` — `startRecording(options)` runs a session. `src/injected/` is the
  script that runs inside recorded pages (locator generator, event capture, overlay),
  bundled with esbuild at session start; `postprocess.ts` turns the raw capture into steps.
- `packages/db` — Drizzle schema, SQL migrations (`migrations/`), and the `Database`
  interface with its SQLite implementation. `openDatabase(url)` migrates on open.
- `packages/sources` — API sources: adapters mapping the Greenhouse, Lever and Ashby
  feeds to raw job records, and `fetchSource(source, options)`, which returns the same
  `RunResult` as a browser replay. No browser dependency.
- `packages/scheduler` — `executeRun(db, recordingId, options)`: replay or feed fetch, plus persistence
  (run, events, jobs with new/changed flags, artifacts, closing, retention). The worker
  and cron scheduling will be added here.
- `packages/test-sites` — mock career sites; `src/data.ts` is the ground truth tests compare against
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
- CLI commands live in `apps/cli/src/commands`, get a `CliContext`, print results on
  stdout and messages on stderr, and take `--json` where they list things.
- A row in `recordings` is either a browser recording or an API source (`kind`);
  `StoredRecording` is a union, so check `stored.kind` before using `.recording` or
  `.source`. Anything that should work for both takes a `Definition`.
- Feed payloads are external input: adapters validate them with lenient Zod schemas
  (unknown fields ignored, absent ones tolerated) and skip unreadable entries.
- Tests never use real websites. Use the mock sites with `fastOptions()` from
  `packages/runner/src/testing.ts` (no delays, short waits, fixed clock).
- No CAPTCHA solving, stealth plugins or fingerprint spoofing, ever.
