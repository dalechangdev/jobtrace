import { createHash } from "node:crypto";
import {
  JobTraceError,
  renderTemplate,
  type Step,
  type StepOf,
  type Target,
  toJobTraceError,
} from "@jobtrace/core";
import { absoluteUrl, applyTransforms } from "@jobtrace/extractor";
import type { Locator, Page, Response } from "playwright";
import { captureFailure } from "./artifacts.ts";
import { resolveTarget } from "./locators.ts";
import {
  checkAbort,
  emit,
  isRunLevelError,
  type PendingRecord,
  pace,
  poll,
  type RunState,
  type Scope,
  StopRun,
  sleep,
} from "./state.ts";

export function newRecord(sourceUrl: string, parent?: PendingRecord): PendingRecord {
  return { fields: { ...parent?.fields }, sourceUrl, hasChildren: false };
}

/** Hands a finished record to the run, unless it is empty or was split into child records. */
export function emitRecord(state: RunState, record: PendingRecord, parent?: PendingRecord): void {
  if (record.hasChildren) {
    if (parent) parent.hasChildren = true;
    return;
  }
  if (Object.keys(record.fields).length === 0) return;
  state.records.push({ fields: record.fields, sourceUrl: record.sourceUrl });
  if (parent) parent.hasChildren = true;
}

export async function runSteps(
  state: RunState,
  scope: Scope,
  steps: readonly Step[],
): Promise<void> {
  for (const step of steps) {
    checkAbort(state);
    emit(state, "debug", "step_start", `${step.type} ${step.id}`, { stepId: step.id });
    try {
      await runStep(state, scope, step);
    } catch (thrown) {
      if (thrown instanceof StopRun) throw thrown;
      // An abort closes the browser context; report the abort, not the resulting noise.
      checkAbort(state);
      const error = toJobTraceError(thrown);
      error.stepId ??= step.id;
      if (!state.captured.has(error) && !isRunLevelError(error)) {
        state.captured.add(error);
        await captureFailure(state, scope.page, error.stepId);
      }
      throw error;
    }
  }
}

async function runStep(state: RunState, scope: Scope, step: Step): Promise<void> {
  const { page } = scope;
  const timeout = state.settings.stepTimeoutMs;
  const one = async (target: Target) =>
    (await resolveTarget(state, scope, target, { stepId: step.id })) as Locator;

  switch (step.type) {
    case "navigate":
      await goto(state, page, renderTemplate(step.url, state.values), step.id);
      return;
    case "click": {
      const element = await one(step.target);
      await pace(state);
      await element.click({ timeout });
      return;
    }
    case "fill": {
      const element = await one(step.target);
      await pace(state);
      await element.fill(renderTemplate(step.value, state.values), { timeout });
      return;
    }
    case "select": {
      const element = await one(step.target);
      await pace(state);
      await element.selectOption(renderTemplate(step.value, state.values), { timeout });
      return;
    }
    case "press": {
      if (step.target) {
        const element = await one(step.target);
        await pace(state);
        await element.press(step.key, { timeout });
      } else {
        await pace(state);
        await page.keyboard.press(step.key);
      }
      return;
    }
    case "scroll": {
      const element = step.target ? await one(step.target) : null;
      if (step.mode === "toBottom") {
        if (element) await element.evaluate((node) => node.scrollTo(0, node.scrollHeight));
        else await scrollPageToBottom(page);
      } else {
        const amount = step.amount ?? 0;
        if (element) await element.evaluate((node, dy) => node.scrollBy(0, dy), amount);
        else await page.evaluate((dy) => window.scrollBy(0, dy), amount);
      }
      return;
    }
    case "waitFor":
      if (step.target) {
        await resolveTarget(state, scope, step.target, { stepId: step.id, list: true });
      } else if (step.urlPattern !== undefined) {
        await page.waitForURL(step.urlPattern, { timeout });
      } else {
        await sleep(state, step.ms ?? 0);
      }
      return;
    case "extract":
      return extract(state, scope, step);
    case "forEach":
      return forEach(state, scope, step);
    case "openDetail":
      return openDetail(state, scope, step);
    case "paginate":
      return paginate(state, scope, step);
  }
}

async function goto(
  state: RunState,
  page: Page,
  url: string,
  stepId: string,
): Promise<Response | null> {
  await pace(state);
  let response: Response | null;
  try {
    response = await page.goto(url, { timeout: state.settings.stepTimeoutMs, waitUntil: "load" });
  } catch (error) {
    checkAbort(state);
    throw new JobTraceError(
      "NAVIGATION_FAILED",
      `Could not load ${url}: ${(error as Error).message.split("\n")[0]}`,
      {
        stepId,
        cause: error,
        details: { url },
      },
    );
  }
  const status = response?.status() ?? 0;
  if (status >= 400) {
    throw new JobTraceError("NAVIGATION_FAILED", `${url} responded with HTTP ${status}`, {
      stepId,
      details: { url, status },
    });
  }
  return response;
}

function scrollPageToBottom(page: Page): Promise<void> {
  return page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
}

async function extract(state: RunState, scope: Scope, step: StepOf<"extract">): Promise<void> {
  if (step.scope === "item" && !scope.item) {
    throw new JobTraceError("STEP_FAILED", 'extract with scope "item" must be inside a forEach', {
      stepId: step.id,
    });
  }
  const started = Date.now();
  const timeout = state.settings.stepTimeoutMs;
  // Required fields first: once they are present the page has rendered, so
  // optional fields only get a short shared budget before counting as absent.
  const ordered = [...step.fields].sort((a, b) => Number(b.required) - Number(a.required));
  for (const field of ordered) {
    const budget = Math.max(0, state.tuning.optionalFieldTimeoutMs - (Date.now() - started));
    const element = await resolveTarget(state, scope, field.target, {
      stepId: step.id,
      optional: !field.required,
      timeoutMs: field.required ? timeout : budget,
    });
    let raw: string | null = null;
    if (element) {
      if (field.read === "attr") raw = await element.getAttribute(field.attr ?? "", { timeout });
      else if (field.read === "innerHTML") raw = await element.innerHTML({ timeout });
      else raw = await element.innerText({ timeout });
    }
    const pageUrl = scope.page.url();
    let value = applyTransforms(raw, field.transforms, { baseUrl: pageUrl, now: state.now });
    // Job URLs are resolved against the page they were read on, which may be a detail page.
    if (field.name === "url" && value) value = absoluteUrl(value, pageUrl) ?? value;

    if (field.required && (value === null || value.trim() === "")) {
      throw new JobTraceError("REQUIRED_FIELD_MISSING", `Required field "${field.name}" is empty`, {
        stepId: step.id,
        details: { field: field.name, url: pageUrl },
      });
    }
    // A missing optional value must not wipe one extracted earlier (e.g. list, then detail).
    if (value !== null || !(field.name in scope.record.fields)) {
      scope.record.fields[field.name] = value;
    }
  }
}

async function forEach(state: RunState, scope: Scope, step: StepOf<"forEach">): Promise<void> {
  const items = (await resolveTarget(state, scope, step.items, {
    stepId: step.id,
    list: true,
  })) as Locator;
  const total = await items.count();
  const first = scope.processed?.get(step.id) ?? 0;
  emit(state, "info", "for_each", `Found ${total - first} item(s)`, {
    stepId: step.id,
    data: { count: total - first, offset: first },
  });

  let consecutiveErrors = 0;
  for (let index = first; index < total; index++) {
    checkAbort(state);
    if (state.records.length >= state.settings.maxItems) throw new StopRun("maxItems");
    state.stats.itemsSeen++;
    const record = newRecord(scope.page.url(), scope.record);
    const itemScope: Scope = {
      page: scope.page,
      record,
      item: items.nth(index),
      list: { items, count: total, url: scope.page.url() },
    };
    try {
      await runSteps(state, itemScope, step.body);
      emitRecord(state, record, scope.record);
      consecutiveErrors = 0;
    } catch (error) {
      if (isRunLevelError(error)) throw error;
      const failure = toJobTraceError(error);
      state.stats.itemErrors++;
      consecutiveErrors++;
      emit(
        state,
        "error",
        "item_error",
        `Item ${index + 1} of ${total} failed: ${failure.message}`,
        {
          stepId: failure.stepId ?? step.id,
          data: { index, error: failure.toJSON() },
        },
      );
      if (consecutiveErrors >= state.tuning.maxConsecutiveItemErrors) {
        throw new JobTraceError(
          "STEP_FAILED",
          `${consecutiveErrors} items in a row failed; giving up on this list. Last error: ${failure.message}`,
          { stepId: step.id, details: { lastError: failure.toJSON() } },
        );
      }
    }
  }
  scope.processed?.set(step.id, total);
}

async function openDetail(
  state: RunState,
  scope: Scope,
  step: StepOf<"openDetail">,
): Promise<void> {
  const { page } = scope;
  const timeout = state.settings.stepTimeoutMs;
  const link = (await resolveTarget(state, scope, step.link, { stepId: step.id })) as Locator;
  const href = await link.getAttribute("href", { timeout }).catch(() => null);
  const detailUrl = href ? absoluteUrl(href, page.url()) : null;
  // The detail page is a different document: no item scope, same record.
  const runBody = (detailPage: Page) =>
    runSteps(state, { page: detailPage, record: scope.record }, step.body);

  if (step.strategy === "newTab" && detailUrl) {
    const detailPage = await state.context.newPage();
    try {
      await goto(state, detailPage, detailUrl, step.id);
      await runBody(detailPage);
    } finally {
      await detailPage.close().catch(() => {});
    }
    return;
  }

  const listUrl = page.url();
  let popup: Page | undefined;
  const onPage = (opened: Page) => {
    popup = opened;
  };
  state.context.once("page", onPage);
  let opened: "popup" | "navigated" | undefined;
  try {
    await pace(state);
    await link.click({ timeout });
    opened = await poll(state, state.tuning.detailOpenMs, async () =>
      popup ? "popup" : page.url() !== listUrl ? "navigated" : undefined,
    );
  } finally {
    state.context.off("page", onPage);
  }

  if (opened === "popup" && popup) {
    try {
      await popup.waitForLoadState("domcontentloaded", { timeout });
      await runBody(popup);
    } finally {
      await popup.close().catch(() => {});
    }
    return;
  }
  if (opened === undefined) {
    emit(
      state,
      "warn",
      "detail_in_place",
      "Detail link did not change the URL; reading the detail in place",
      {
        stepId: step.id,
      },
    );
    await runBody(page);
    return;
  }
  try {
    await runBody(page);
  } finally {
    await returnToList(state, scope, listUrl, step.id);
  }
}

/** After a same-tab detail visit: go back, and make sure the list is really there again. */
async function returnToList(
  state: RunState,
  scope: Scope,
  listUrl: string,
  stepId: string,
): Promise<void> {
  const { page, list } = scope;
  const restored = () =>
    poll(state, state.tuning.listRestoreMs, async () => {
      if (list) return (await list.items.count()) >= list.count ? true : undefined;
      return page.url() === listUrl ? true : undefined;
    });

  await page.goBack({ timeout: state.settings.stepTimeoutMs }).catch(() => null);
  if (await restored()) return;
  emit(
    state,
    "warn",
    "list_restore_fallback",
    "Going back did not restore the list; reloading its URL",
    {
      stepId,
      data: { url: listUrl },
    },
  );
  await goto(state, page, listUrl, stepId);
  if (await restored()) return;
  throw new JobTraceError(
    "STEP_FAILED",
    "Could not get back to the list after opening a detail page",
    {
      stepId,
      details: { url: listUrl },
    },
  );
}

/** The list a pagination body iterates, used to tell pages apart and to count items. */
function listLoopOf(body: readonly Step[]): StepOf<"forEach"> | undefined {
  const loop = body.find((step): step is StepOf<"forEach"> => step.type === "forEach");
  return loop && loop.items.relativeTo !== "item" ? loop : undefined;
}

async function paginate(state: RunState, scope: Scope, step: StepOf<"paginate">): Promise<void> {
  const { page } = scope;
  const { maxPages, stepTimeoutMs } = state.settings;
  const listLoop = listLoopOf(step.body);
  const itemsTarget = listLoop?.items;
  const findItems = (timeoutMs: number) =>
    itemsTarget
      ? resolveTarget(state, scope, itemsTarget, {
          stepId: step.id,
          list: true,
          optional: true,
          timeoutMs,
        })
      : Promise.resolve(null);
  /** Hash of the list's text (or of the whole page when there is no list). */
  const contentHash = async (): Promise<string> => {
    const items = await findItems(0);
    const text = items
      ? (await items.allInnerTexts()).join("\n")
      : await page.evaluate(() => document.body.innerText);
    return createHash("sha256").update(text).digest("hex");
  };
  const stop = (type: string, message: string) =>
    emit(state, "info", type, message, { stepId: step.id });
  const startPage = (number: number) => {
    state.stats.pages++;
    emit(state, "info", "page", `Page ${number}`, { stepId: step.id, data: { page: number } });
  };
  const seen = new Set<string>();

  if (step.mode === "urlPattern") {
    for (let number = 1; ; number++) {
      const url = renderTemplate(step.urlTemplate ?? "", { ...state.values, page: String(number) });
      if (number === 1) {
        await goto(state, page, url, step.id);
      } else {
        try {
          await goto(state, page, url, step.id);
        } catch (error) {
          if (!(error instanceof JobTraceError) || error.code !== "NAVIGATION_FAILED") throw error;
          return stop("pagination_end", `Page ${number} could not be loaded; assuming the end`);
        }
        if (itemsTarget && !(await findItems(state.tuning.emptyPageTimeoutMs))) {
          return stop("pagination_end", `Page ${number} has no items`);
        }
      }
      // Content only: the URL differs on every page here, even when a site
      // clamps out-of-range page numbers and serves the last page again.
      const content = await contentHash();
      if (seen.has(content))
        return stop("pagination_end", `Page ${number} repeats an earlier page`);
      seen.add(content);
      startPage(number);
      await runSteps(state, scope, step.body);
      if (number >= maxPages) return stop("limit_reached", `Stopped at maxPages (${maxPages})`);
    }
  }

  if (step.mode === "infiniteScroll") {
    const processed = new Map<string, number>();
    const scrollScope: Scope = { ...scope, processed };
    const measure = async () => {
      const items = await findItems(0);
      return items ? items.count() : page.evaluate(() => document.documentElement.scrollHeight);
    };
    for (let round = 1; ; round++) {
      startPage(round);
      await runSteps(state, scrollScope, step.body);
      if (round >= maxPages) return stop("limit_reached", `Stopped at maxPages (${maxPages})`);
      // Compare against what was processed, not what is on the page now: the
      // site may have loaded more items while the body was still running.
      const before = (listLoop && processed.get(listLoop.id)) ?? (await measure());
      if ((await measure()) > before) continue;
      await pace(state);
      let grew: true | undefined;
      for (let attempt = 0; attempt < state.tuning.scrollAttempts && !grew; attempt++) {
        await scrollPageToBottom(page);
        const items = await findItems(0);
        await items
          ?.last()
          .scrollIntoViewIfNeeded({ timeout: 1000 })
          .catch(() => {});
        grew = await poll(state, state.tuning.scrollWaitMs, async () =>
          (await measure()) > before ? true : undefined,
        );
      }
      if (!grew) return stop("pagination_end", "Scrolling loaded no new items");
    }
  }

  // nextButton
  for (let number = 1; ; number++) {
    startPage(number);
    await runSteps(state, scope, step.body);
    // Hash after the body ran, when the list is known to be rendered.
    const content = await contentHash();
    if (seen.has(content)) return stop("pagination_end", `Page ${number} repeats an earlier page`);
    seen.add(content);
    const url = page.url();
    if (number >= maxPages) return stop("limit_reached", `Stopped at maxPages (${maxPages})`);

    const next = step.next
      ? await resolveTarget(state, scope, step.next, {
          stepId: step.id,
          optional: true,
          timeoutMs: state.tuning.nextTimeoutMs,
        })
      : null;
    if (!next) return stop("pagination_end", "No next-page control");
    const disabled = await next.evaluate(
      (node) =>
        node.hasAttribute("disabled") ||
        node.getAttribute("aria-disabled") === "true" ||
        node.classList.contains("disabled"),
    );
    if (disabled) return stop("pagination_end", "Next-page control is disabled");

    await pace(state);
    await next.click({ timeout: stepTimeoutMs });
    const changed = await poll(state, stepTimeoutMs, async () =>
      page.url() !== url || (await contentHash()) !== content ? true : undefined,
    );
    if (!changed) return stop("pagination_end", "The page did not change after clicking next");
  }
}
