import { JobTraceError, type Locator as LocatorSpec, type Target } from "@jobtrace/core";
import type { FrameLocator, Locator, Page } from "playwright";
import { checkAbort, emit, type RunState, type Scope, sleep } from "./state.ts";

type Root = Page | FrameLocator | Locator;
type AriaRole = Parameters<Page["getByRole"]>[0];

/** Translates one recorded locator into a Playwright locator under `root`. */
export function buildLocator(root: Root, spec: LocatorSpec): Locator {
  switch (spec.kind) {
    case "testId":
      return root.getByTestId(spec.value);
    case "role":
      return root.getByRole(spec.role as AriaRole, {
        ...(spec.name === undefined ? {} : { name: spec.name }),
        ...(spec.exact === undefined ? {} : { exact: spec.exact }),
        ...(spec.level === undefined ? {} : { level: spec.level }),
      });
    case "text":
      return root.getByText(spec.value, spec.exact === undefined ? {} : { exact: spec.exact });
    case "css":
      return root.locator(spec.value);
    case "xpath":
      return root.locator(`xpath=${spec.value}`);
  }
}

function rootFor(scope: Scope, target: Target, stepId: string): Root {
  if (target.relativeTo === "item") {
    if (!scope.item) {
      throw new JobTraceError(
        "STEP_FAILED",
        'Target has relativeTo "item" but the step is not inside a forEach item',
        { stepId },
      );
    }
    return scope.item;
  }
  let root: Page | FrameLocator = scope.page;
  for (const frame of target.frame) root = root.frameLocator(frame);
  return root;
}

export interface ResolveOptions {
  stepId: string;
  /** True when the target stands for a list: any number of matches (at least one) is fine. */
  list?: boolean;
  /** Defaults to the recording's stepTimeoutMs. */
  timeoutMs?: number;
  /** Return null instead of throwing when nothing matches. */
  optional?: boolean;
}

interface Attempt {
  locator: LocatorSpec;
  matches: number;
  error?: string;
}

/**
 * The locator resolution chain (PLAN.md 8.2). Polls the target's locators in
 * rank order until one matches (exactly one element, or at least one for list
 * targets). A lower-ranked match is only accepted after a short grace period,
 * or at once if the target already needed a fallback earlier in this run.
 * When every locator fails, the optional LocatorResolver gets a chance.
 */
export async function resolveTarget(
  state: RunState,
  scope: Scope,
  target: Target,
  options: ResolveOptions,
): Promise<Locator | null> {
  const { stepId, list = false, optional = false } = options;
  const timeoutMs = options.timeoutMs ?? state.settings.stepTimeoutMs;
  const root = rootFor(scope, target, stepId);
  const candidates = target.locators.map((spec) => buildLocator(root, spec));
  const remembered = state.locatorMemo.get(target);
  const start = Date.now();
  let attempts: Attempt[] = [];

  for (;;) {
    checkAbort(state);
    const elapsed = Date.now() - start;
    const lastTry = elapsed >= timeoutMs;
    const graceOver =
      remembered !== undefined || lastTry || elapsed >= state.tuning.fallbackGraceMs;

    attempts = [];
    let winner = -1;
    for (const [index, candidate] of candidates.entries()) {
      const spec = target.locators[index] as LocatorSpec;
      try {
        const matches = await candidate.count();
        attempts.push({ locator: spec, matches });
        if (list ? matches >= 1 : matches === 1) {
          winner = index;
          break;
        }
      } catch (error) {
        checkAbort(state);
        attempts.push({
          locator: spec,
          matches: 0,
          error: (error as Error).message.split("\n")[0],
        });
      }
    }

    if (winner === 0 || (winner > 0 && graceOver)) {
      const spec = target.locators[winner] as LocatorSpec;
      if (winner > 0 && remembered === undefined) {
        emit(
          state,
          "warn",
          "locator_drift",
          `Top-ranked locator failed; used fallback #${winner + 1} (${spec.kind})`,
          { stepId, data: { index: winner, used: spec, failed: attempts.slice(0, winner) } },
        );
      }
      if (remembered !== winner) state.locatorMemo.set(target, winner);
      return candidates[winner] as Locator;
    }
    if (lastTry) break;
    await sleep(state, Math.min(state.tuning.pollIntervalMs, timeoutMs - elapsed));
  }

  const healed = optional ? null : await heal(state, scope, target, root, { stepId, list });
  if (healed) return healed;
  if (optional) return null;
  throw new JobTraceError(
    "LOCATOR_NOT_FOUND",
    `No locator matched ${list ? "any element" : "exactly one element"} within ${timeoutMs}ms (tried ${attempts
      .map((attempt) => `${attempt.locator.kind}: ${attempt.matches} match(es)`)
      .join(", ")})`,
    { stepId, details: { tried: attempts, list, url: scope.page.url() } },
  );
}

const SNAPSHOT_LIMIT = 60_000;

/** A size-capped page snapshot with scripts, styles and form values removed. */
async function trimmedSnapshot(page: Page): Promise<string> {
  const html = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    for (const node of clone.querySelectorAll("script, style, noscript, svg, link, meta")) {
      node.remove();
    }
    for (const input of clone.querySelectorAll("input, textarea")) input.removeAttribute("value");
    for (const area of clone.querySelectorAll("textarea")) area.textContent = "";
    return clone.outerHTML;
  });
  return html.length > SNAPSHOT_LIMIT ? html.slice(0, SNAPSHOT_LIMIT) : html;
}

async function heal(
  state: RunState,
  scope: Scope,
  target: Target,
  root: Root,
  { stepId, list }: { stepId: string; list: boolean },
): Promise<Locator | null> {
  const resolver = state.options.locatorResolver;
  if (!resolver) return null;
  try {
    const suggestion = await resolver.resolve(target, {
      pageSnapshot: await trimmedSnapshot(scope.page),
      url: scope.page.url(),
      stepId,
      list,
    });
    if (!suggestion) return null;
    const candidate = buildLocator(root, suggestion.locator);
    const matches = await candidate.count();
    if (list ? matches < 1 : matches !== 1) {
      emit(
        state,
        "warn",
        "locator_suggestion_rejected",
        `Suggested locator matched ${matches} element(s)`,
        {
          stepId,
          data: { locator: suggestion.locator, source: suggestion.source, matches },
        },
      );
      return null;
    }
    emit(
      state,
      "warn",
      "locator_suggestion",
      `Healed with a ${suggestion.source} locator suggestion`,
      {
        stepId,
        data: { locator: suggestion.locator, source: suggestion.source },
      },
    );
    return candidate;
  } catch (error) {
    checkAbort(state);
    emit(state, "warn", "locator_resolver_error", (error as Error).message, { stepId });
    return null;
  }
}
