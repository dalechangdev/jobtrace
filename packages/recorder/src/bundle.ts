import { fileURLToPath } from "node:url";
import { build } from "esbuild";

let cached: Promise<string> | undefined;

/**
 * The recorder script that runs inside recorded pages, bundled into one
 * self-contained IIFE. It is authored as ordinary modules under ./injected and
 * bundled on first use, so there is still no separate build step.
 */
export function injectedScript(): Promise<string> {
  cached ??= build({
    entryPoints: [fileURLToPath(new URL("./injected/main.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw new Error("Bundling the recorder script produced no output");
    return output.text;
  });
  return cached;
}
