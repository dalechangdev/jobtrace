# Contributing

## Setup

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm --filter @jobtrace/runner exec playwright install chromium
```

## Checks

Every change must pass:

```sh
pnpm lint        # Biome plus the workspace dependency rule
pnpm typecheck
pnpm test
```

`pnpm format` applies Biome's formatting and safe fixes. Changes to the web UI or the
API also need `pnpm test:e2e`, which builds the UI and drives it in a browser against a
real server.

To work on the UI with hot reload, run `pnpm jobtrace serve` and `pnpm dev:web`
(http://localhost:5173) side by side, or `pnpm dev` for both at once.

## Conventions

- TypeScript strict, ESM only. The code runs directly on Node's type stripping, so
  relative imports use `.ts` extensions and only erasable syntax is allowed (no
  `enum`, no parameter properties).
- Validate all external input with Zod: CLI args, API bodies, recording files, env.
- Library packages never call `process.exit` or read `process.env`; apps own
  configuration and process lifecycle.
- `packages/core` depends on no other workspace package, and packages never import
  from `apps/*`. `pnpm lint` enforces this.
- The recording format (`packages/core`) is the central contract. Changing it means
  bumping `schemaVersion` and adding a migration.
- A new step type or field transform needs a schema, runner support, recorder
  support (if recordable), unit tests, and a fixture-based test.

## Mock career sites

`pnpm test-sites` serves the fixture sites on http://127.0.0.1:4400. Their job data
lives in `packages/test-sites/src/data.ts`, which tests treat as ground truth.
Golden extraction files are in `packages/runner/src/__golden__`; regenerate them
with `pnpm test -u` and review the diff.
