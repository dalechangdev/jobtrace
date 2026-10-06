import type { Field, Step } from "@jobtrace/core";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A step before ids are assigned. */
export type StepDraft = DistributiveOmit<Step, "id">;

/** What the recorder captured, in the order it happened. */
export type RawItem =
  | {
      kind: "step";
      step: StepDraft;
      /** Epoch ms. */
      at: number;
      /** Identity of the element acted on, to merge steps on the same element. */
      elementKey?: string;
      /** False for clicks on elements that are not obviously interactive. */
      interactive?: boolean;
      effectId?: number;
      /** Whether the page changed shortly after a non-interactive click; undefined when unknown. */
      mutated?: boolean;
      /** Main-frame URL when the action happened. */
      urlBefore?: string;
      /** For navigate steps created because a click opened a new tab. */
      replacesClick?: boolean;
      /** Arrival order among navigation events, which can share a millisecond. */
      seq?: number;
    }
  | { kind: "field"; field: Field; at: number };

/** A navigation the page itself started (link, form, script, history API). */
export interface PageNavigation {
  url: string;
  at: number;
  /** Arrival order relative to navigate steps; see RawItem. */
  seq?: number;
}

/** A navigation is credited to the latest action at most this long before it. */
const NAVIGATION_WINDOW_MS = 10_000;
const POPUP_CLICK_WINDOW_MS = 5_000;
/** Action times come from the page's clock and navigation times from ours; they can disagree slightly. */
const CLOCK_SLACK_MS = 5;

const GLOB_SPECIALS = /[*?[\]{}\\]/;

function looksDynamic(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    /\d{4,}/.test(segment) ||
    /^[0-9a-f]{8,}$/i.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) ||
    segment.length > 40
  );
}

/**
 * A glob for "the page this action led to" that survives the parts of a URL
 * that vary between runs: ids in the path, typed search terms, query strings.
 */
export function urlWaitPattern(url: string, typedValues: readonly string[] = []): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const typed = new Set(
    typedValues.filter(Boolean).flatMap((value) => [value, encodeURIComponent(value)]),
  );
  const path = parsed.pathname
    .split("/")
    .map((segment) =>
      looksDynamic(segment) ||
      GLOB_SPECIALS.test(segment) ||
      typed.has(segment) ||
      typed.has(decodeURIComponent(segment))
        ? "*"
        : segment,
    )
    .join("/");
  if (parsed.search) return `**${path}?*`;
  if (parsed.hash.length > 1) return `**${path}#**`;
  return path.endsWith("*") ? `**${path}` : `**${path}*`;
}

/** Glob matching as used for URL waits: `**` any characters, `*` any but "/", the rest literal. */
export function globMatches(pattern: string, url: string): boolean {
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(url);
}

type StepItem = Extract<RawItem, { kind: "step" }>;
const isStep = (item: RawItem | undefined): item is StepItem => item?.kind === "step";
const isAction = (item: RawItem | undefined): item is StepItem =>
  isStep(item) && ["click", "fill", "select", "press"].includes(item.step.type);

/**
 * Turns the raw capture into a clean step list (PLAN.md 6.3):
 *  - orders everything by time
 *  - a click that only focused a field which was then typed into becomes the fill
 *  - repeated fills of one field keep the last value; consecutive scrolls are coalesced
 *  - Tab presses that merely moved focus to the next field are dropped
 *  - clicks on non-interactive elements that had no effect are dropped
 *  - a click that opened a new tab is replaced by a navigation to that tab's URL
 *  - after an action that changed the URL, a waitFor on the new URL is inserted
 *  - consecutive marked fields are grouped into one extract step
 */
export function postProcess(
  raw: readonly RawItem[],
  navigations: readonly PageNavigation[] = [],
): Step[] {
  const items = raw
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.at - b.item.at || a.index - b.index)
    .map(({ item }) => item);

  // Credit each page-initiated navigation to the action that caused it.
  const navigatedTo = new Map<RawItem, string>();
  for (const navigation of navigations) {
    let cause: StepItem | undefined;
    for (const item of items) {
      if (!isStep(item)) continue;
      if (item.step.type === "navigate") {
        const earlier =
          item.seq !== undefined && navigation.seq !== undefined
            ? item.seq < navigation.seq
            : item.at <= navigation.at;
        // Nothing after a later typed URL can have caused this navigation.
        if (!earlier) break;
        cause = undefined;
      } else if (isAction(item) && item.at <= navigation.at + CLOCK_SLACK_MS) cause = item;
    }
    if (cause && navigation.at - cause.at <= NAVIGATION_WINDOW_MS)
      navigatedTo.set(cause, navigation.url);
  }

  const kept: RawItem[] = [];
  for (const [index, item] of items.entries()) {
    const previous = kept.at(-1);
    const next = items[index + 1];
    if (!isStep(item)) {
      kept.push(item);
      continue;
    }
    const { step } = item;
    if (step.type === "navigate") {
      if (
        item.replacesClick &&
        isStep(previous) &&
        previous.step.type === "click" &&
        item.at - previous.at <= POPUP_CLICK_WINDOW_MS
      ) {
        kept.pop();
      }
      const last = kept.at(-1);
      if (isStep(last) && last.step.type === "navigate" && last.step.url === step.url) continue;
      kept.push(item);
      continue;
    }
    if (
      step.type === "click" &&
      item.interactive === false &&
      item.mutated === false &&
      !navigatedTo.has(item)
    )
      continue;
    if (
      step.type === "press" &&
      step.key === "Tab" &&
      isStep(next) &&
      "target" in next.step &&
      next.step.target
    )
      continue;
    if (
      step.type === "fill" &&
      isStep(previous) &&
      item.elementKey &&
      previous.elementKey === item.elementKey
    ) {
      // Click-to-focus, or an earlier value typed into the same field.
      if (["click", "fill"].includes(previous.step.type) && !navigatedTo.has(previous)) kept.pop();
    }
    if (
      step.type === "scroll" &&
      isStep(previous) &&
      previous.step.type === "scroll" &&
      previous.elementKey === item.elementKey
    ) {
      const before = previous.step;
      if (step.mode === "toBottom" || before.mode === "toBottom") {
        kept[kept.length - 1] = {
          ...previous,
          step: { ...before, mode: "toBottom", amount: undefined },
          at: item.at,
        };
        continue;
      }
      kept[kept.length - 1] = {
        ...previous,
        step: { ...before, amount: (before.amount ?? 0) + (step.amount ?? 0) },
        at: item.at,
      };
      continue;
    }
    kept.push(item);
  }

  const typedValues = kept.flatMap((item) =>
    isStep(item) && item.step.type === "fill" ? [item.step.value] : [],
  );
  const steps: Step[] = [];
  const nextId = () => `s${steps.length + 1}`;
  let openExtract: Extract<Step, { type: "extract" }> | undefined;
  for (const item of kept) {
    if (!isStep(item)) {
      if (!openExtract) {
        openExtract = { id: nextId(), type: "extract", scope: "page", fields: [] };
        steps.push(openExtract);
      }
      const existing = openExtract.fields.findIndex((field) => field.name === item.field.name);
      if (existing >= 0) openExtract.fields[existing] = item.field;
      else openExtract.fields.push(item.field);
      continue;
    }
    openExtract = undefined;
    steps.push({ id: nextId(), ...item.step } as Step);
    const destination = navigatedTo.get(item);
    if (destination) {
      const urlPattern = urlWaitPattern(destination, typedValues);
      // A pattern the previous URL already satisfies would not wait for anything.
      if (urlPattern && !(item.urlBefore && globMatches(urlPattern, item.urlBefore))) {
        steps.push({ id: nextId(), type: "waitFor", urlPattern });
      }
    }
  }
  return steps;
}
