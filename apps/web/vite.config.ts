import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev:web` serves the UI with hot reload and forwards API calls to a
// running `jobtrace serve`. `pnpm build:web` writes dist/, which the server serves itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.PORT ?? 4317}` } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
