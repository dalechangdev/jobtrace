import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { emit, type RunState } from "./state.ts";

const safeName = (value: string) => value.replace(/[^\w.-]+/g, "_").slice(0, 60);

/**
 * Saves a screenshot and DOM snapshot of the page a step failed on. Best effort:
 * the page may already be closed, and a capture problem must not mask the real error.
 */
export async function captureFailure(state: RunState, page: Page, stepId: string): Promise<void> {
  const dir = state.options.artifactsDir;
  if (!dir || state.failureCaptures >= state.tuning.maxFailureCaptures) return;
  const base = join(dir, `failure-${++state.failureCaptures}-${safeName(stepId)}`);
  try {
    await mkdir(dir, { recursive: true });
    if (page.isClosed()) return;
    await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 5000 });
    state.artifacts.push({ type: "screenshot", path: `${base}.png` });
    await writeFile(`${base}.html`, await page.content());
    state.artifacts.push({ type: "dom", path: `${base}.html` });
  } catch (error) {
    emit(
      state,
      "debug",
      "artifact_error",
      `Could not capture failure artifacts: ${(error as Error).message}`,
      {
        stepId,
      },
    );
  }
}
