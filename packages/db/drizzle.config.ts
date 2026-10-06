import { defineConfig } from "drizzle-kit";

// Used only to generate SQL migrations: `pnpm --filter @jobtrace/db generate`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
