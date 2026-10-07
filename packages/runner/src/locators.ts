import { JobTraceError, type Locator as LocatorSpec, type Target } from "@jobtrace/core";
import type { Frame, FrameLocator, Locator, Page } from "playwright";
import { checkAbort, emit, type RunState, type Scope, sleep } from "./state.ts";

type Root = Page | Frame | FrameLocator | Locator;
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
  /** Never ask the LocatorResolver about this target. */
  noHeal?: boolean;
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
  // A target healed earlier in this run is not waited for (or paid for) again.
  const healedBefore = state.healed.get(target);
  if (healedBefore) {
    const candidate = buildLocator(root, healedBefore);
    const matches = await candidate.count().catch(() => 0);
    if (list ? matches >= 1 : matches === 1) return candidate;
  }
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

  // An optional element may simply not be there, which is not worth asking about
  // for every item: such a target gets one attempt per run.
  const mayHeal = !options.noHeal && !(optional && state.healTried.has(target));
  state.healTried.add(target);
  const healed = mayHeal ? await heal(state, scope, target, root, { stepId, list }) : null;
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

/**
 * A size-capped snapshot of the area a target is looked up in, with scripts,
 * styles and everything typed into forms removed.
 */
async function trimmedSnapshot(root: Root): Promise<string> {
  const element = "count" in root ? root.first() : root.locator(":root");
  const html = await element.evaluate((node) => {
    const clone = node.cloneNode(true) as HTMLElement;
    for (const junk of clone.querySelectorAll(
      "script, style, noscript, svg, link, meta, template",
    )) {
      junk.remove();
    }
    for (const input of clone.querySelectorAll("input, textarea, select, option")) {
      input.removeAttribute("value");
      input.removeAttribute("selected");
      input.removeAttribute("checked");
    }
    for (const area of clone.querySelectorAll("textarea")) area.textContent = "";
    for (const editable of clone.querySelectorAll("[contenteditable]")) editable.textContent = "";
    return clone.outerHTML;
  });
  return html.length > SNAPSHOT_LIMIT ? html.slice(0, SNAPSHOT_LIMIT) : html;
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Share of words two texts have in common (Dice coefficient), 0 to 1. */
export function textSimilarity(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

const MIN_TEXT_SIMILARITY = 0.6;

/**
 * Whether the element a suggestion points at could be the recorded one: it is
 * the same kind of element, or it says nearly the same thing. Text alone
 * cannot be required, because an extracted field reads differently on every job.
 */
async function resemblesFingerprint(
  candidate: Locator,
  target: Target,
): Promise<{ ok: boolean; tag: string; similarity: number }> {
  const actual = await candidate.first().evaluate((node) => ({
    tag: node.tagName.toLowerCase(),
    text: (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
  }));
  const fingerprint = target.fingerprint;
  if (!fingerprint) return { ok: true, tag: actual.tag, similarity: 0 };
  const similarity = fingerprint.text ? textSimilarity(fingerprint.text, actual.text) : 0;
  const ok = fingerprint.tag.toLowerCase() === actual.tag || similarity >= MIN_TEXT_SIMILARITY;
  return { ok, tag: actual.tag, similarity: Math.round(similarity * 100) / 100 };
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
      pageSnapshot: await trimmedSnapshot(root),
      scope: target.relativeTo === "item" ? "item" : target.frame.length > 0 ? "frame" : "page",
      url: scope.page.url(),
      stepId,
      list,
      signal: state.options.signal
        ? AbortSignal.any([state.options.signal, state.timeoutSignal])
        : state.timeoutSignal,
    });
    if (!suggestion) return null;
    const described = {
      locator: suggestion.locator,
      source: suggestion.source,
      ...(suggestion.reason ? { reason: suggestion.reason } : {}),
    };
    const reject = (message: string, data: Record<string, unknown>) => {
      emit(state, "warn", "locator_suggestion_rejected", message, {
        stepId,
        data: { ...described, ...data },
      });
      return null;
    };
    const candidate = buildLocator(root, suggestion.locator);
    const matches = await candidate.count();
    if (list ? matches < 1 : matches !== 1) {
      return reject(`Suggested locator matched ${matches} element(s)`, { matches });
    }
    const likeness = await resemblesFingerprint(candidate, target);
    if (!likeness.ok) {
      return reject(
        `Suggested locator points at a <${likeness.tag}> that does not resemble the recorded <${target.fingerprint?.tag}>`,
        { matches, tag: likeness.tag, similarity: likeness.similarity },
      );
    }
    state.healed.set(target, suggestion.locator);
    emit(
      state,
      "warn",
      "locator_suggestion",
      `Healed with a ${suggestion.source} locator suggestion (${suggestion.locator.kind})`,
      // `failed` identifies the target when the suggestion is accepted later.
      { stepId, data: { ...described, failed: target.locators, similarity: likeness.similarity } },
    );
    return candidate;
  } catch (error) {
    checkAbort(state);
    emit(state, "warn", "locator_resolver_error", (error as Error).message, { stepId });
    return null;
  }
}
