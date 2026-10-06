import { setTimeout as delay } from "node:timers/promises";
import {
  CURRENT_SCHEMA_VERSION,
  type Field,
  JobTraceError,
  type Locator,
  newId,
  parseRecording,
  type Recording,
  type Target,
} from "@jobtrace/core";
import { buildLocator } from "@jobtrace/runner";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Frame,
  type Page,
  type Locator as PageLocator,
} from "playwright";
import { injectedScript } from "./bundle.ts";
import {
  API_NAME,
  BRIDGE_NAME,
  CONFIG_NAME,
  type ElementRef,
  type FieldSamples,
  type NodeMessage,
  type PageMessage,
  type RecorderApi,
  type RecorderConfig,
  type RecorderMode,
  type RecorderStatus,
  type WireTarget,
} from "./injected/protocol.ts";
import { pageMessageSchema } from "./messages.ts";
import { type PageNavigation, postProcess, type RawItem, type StepDraft } from "./postprocess.ts";

export interface RecorderEvent {
  level: "info" | "warn";
  /** `step`, `field`, `navigate`, `mode`, `warning`. */
  type: string;
  message: string;
}

export interface RecorderOptions {
  /** Page to open first. */
  url: string;
  /** Recording name. Defaults to the page title, then the host name. */
  name?: string;
  /** Recording id. Defaults to a new `rec_` id. */
  id?: string;
  /** Run without a window. Only useful for automated tests; default is headed. */
  headless?: boolean;
  /** Reuse a browser instead of launching one. It is left open. */
  browser?: Browser;
  /** Path to a Playwright storage state file (an auth profile). */
  storageState?: string;
  /** Id of the auth profile behind `storageState`; stored in the recording. */
  authProfileId?: string;
  /** Tests only: open the overlay's shadow root so its buttons can be clicked by a script. */
  openShadow?: boolean;
  onEvent?: (event: RecorderEvent) => void;
  /** Aborting ends the session like pressing Stop; the recording is still produced. */
  signal?: AbortSignal;
}

export interface RecorderResult {
  recording: Recording;
  /** The value each marked field had while recording, as a preview. */
  samples: Record<string, string | null>;
  warnings: string[];
}

export interface RecordingSession {
  /** The page being recorded (the most recently opened tab). */
  readonly page: Page;
  readonly context: BrowserContext;
  /** Resolves when the user presses Stop, closes the window, or `stop()` is called. */
  readonly finished: Promise<RecorderResult>;
  stop(): Promise<RecorderResult>;
  status(): RecorderStatus;
  /** Resolves once every message received so far has been processed. */
  idle(): Promise<void>;
}

type ApiWindow = Record<string, RecorderApi | undefined>;
const VERIFY_TIMEOUT_MS = 1500;

/**
 * Checks each generated locator with the real Playwright engine while the
 * element is still on the page, and drops those that do not resolve to exactly
 * that element (`root` is the frame, or a list item for item-relative locators).
 * When the page has already moved on (a click that navigated), nothing can be
 * checked and the locators are kept as generated.
 */
async function verifyLocators(
  frame: Frame,
  root: Frame | PageLocator,
  locators: readonly Locator[],
  ref: ElementRef,
): Promise<Locator[]> {
  const check = async (): Promise<Locator[] | null> => {
    const kept: Locator[] = [];
    for (const spec of locators) {
      const locator = buildLocator(root, spec);
      if ((await locator.count()) !== 1) continue;
      const same = await locator.evaluate(
        (element, [api, key]) =>
          (window as unknown as ApiWindow)[api as string]?.isElement(key as string, element) ===
          true,
        [API_NAME, ref.key],
        { timeout: 500 },
      );
      if (same) kept.push(spec);
    }
    return (await sameDocument(frame, ref)) ? kept : null;
  };
  const verified = await Promise.race([
    check().catch(() => null),
    delay(VERIFY_TIMEOUT_MS).then(() => null),
  ]);
  return verified && verified.length > 0 ? verified : [...locators];
}

async function sameDocument(frame: Frame, ref: ElementRef): Promise<boolean> {
  const nonce = await frame.evaluate(
    (api) => (window as unknown as ApiWindow)[api]?.nonce,
    API_NAME,
  );
  return nonce === ref.nonce;
}

/** Like verifyLocators, for a list: a locator must match exactly the marked items. */
async function verifyListLocators(
  frame: Frame,
  locators: readonly Locator[],
  group: ElementRef,
  count: number,
): Promise<Locator[]> {
  const check = async (): Promise<Locator[] | null> => {
    const kept: Locator[] = [];
    for (const spec of locators) {
      const locator = buildLocator(frame, spec);
      if ((await locator.count()) !== count) continue;
      const same = await locator.evaluateAll(
        (elements, [api, key]) =>
          (window as unknown as ApiWindow)[api as string]?.isGroup(key as string, elements) ===
          true,
        [API_NAME, group.key],
      );
      if (same) kept.push(spec);
    }
    return (await sameDocument(frame, group)) ? kept : null;
  };
  const verified = await Promise.race([
    check().catch(() => null),
    delay(VERIFY_TIMEOUT_MS).then(() => null),
  ]);
  return verified && verified.length > 0 ? verified : [...locators];
}

/** CSS selectors of the iframes containing `frame`, outermost first. */
async function frameChain(frame: Frame): Promise<string[]> {
  const chain: string[] = [];
  for (let current = frame; current.parentFrame(); current = current.parentFrame() as Frame) {
    const element = await current.frameElement();
    const selector = await element.evaluate(
      (node, api) => (window as unknown as ApiWindow)[api]?.cssFor(node as Element) ?? null,
      API_NAME,
    );
    if (!selector) throw new Error("Could not build a selector for an iframe");
    chain.unshift(selector);
  }
  return chain;
}

/**
 * Opens a browser on `options.url` with the recorder injected, and captures
 * what the user does until the session is stopped.
 */
export async function startRecording(options: RecorderOptions): Promise<RecordingSession> {
  const headless = options.headless ?? false;
  const browser = options.browser ?? (await chromium.launch({ headless }));
  const items: RawItem[] = [];
  const navigations: PageNavigation[] = [];
  const warnings: string[] = [];
  const samples: Record<string, string | null> = {};
  const picks = new Map<
    number,
    { target: Target; link?: Target; samples: FieldSamples; baseUrl: string }
  >();
  const pages = new Set<Page>();
  type ListScope = { kind: "list"; target: Target; count: number };
  type DetailScope = {
    kind: "detail";
    /** The tab showing the detail page: the list's own tab, or a new one the link opened. */
    page: Page;
    listPage: Page;
    listUrl: string;
    popup: boolean;
  };
  /** Open scopes, innermost last. At most a list with a detail page inside it. */
  const scopes: Array<ListScope | DetailScope> = [];
  let hasList = false;
  /** With an auth profile: the element that proves "logged in", once marked. */
  let loggedInCheck: Target | undefined;
  /** The frame that proposed list candidates and awaits the user's choice. */
  let listPickFrame: Frame | undefined;
  /** True while the recorder itself navigates (back to the list); nothing is recorded then. */
  let selfNavigating = false;
  let mode: RecorderMode = "record";
  let activePage: Page | undefined;
  let lastTitle = "";
  let pickSeq = 0;
  /** Orders navigation events exactly; several can be handled within one millisecond. */
  let navigationSeq = 0;
  let queue: Promise<void> = Promise.resolve();
  let finishing: Promise<RecorderResult> | undefined;
  /** Set once the final flush is over; anything the pages send after that is ignored. */
  let closed = false;
  let context: BrowserContext | undefined;
  const done = Promise.withResolvers<RecorderResult>();
  done.promise.catch(() => {});

  const emit = (level: RecorderEvent["level"], type: string, message: string) => {
    try {
      options.onEvent?.({ level, type, message });
    } catch {
      // A faulty listener must not break the recording.
    }
  };
  const warn = (message: string) => {
    if (warnings.includes(message)) return;
    warnings.push(message);
    emit("warn", "warning", message);
  };
  const innermost = () => scopes.at(-1);
  const status = (): RecorderStatus => {
    const scope = innermost();
    return {
      mode,
      steps: items.filter((item) => item.kind === "step").length,
      fields: [
        ...new Set(items.flatMap((item) => (item.kind === "field" ? [item.field.name] : []))),
      ],
      scope: scope?.kind ?? "none",
      ...(scope?.kind === "list"
        ? { list: { locators: scope.target.locators, count: scope.count } }
        : {}),
      hasList,
      ...(options.authProfileId ? { auth: { hasCheck: loggedInCheck !== undefined } } : {}),
    };
  };
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error) => warn(`Recorder error: ${(error as Error).message}`));
  };

  const tell = (frame: Frame, message: NodeMessage) =>
    frame
      .evaluate(
        ([api, payload]) =>
          (window as unknown as ApiWindow)[api as string]?.receive(payload as NodeMessage),
        [API_NAME, message] as const,
      )
      .catch(() => {});
  const broadcastStatus = () => {
    const message: NodeMessage = { kind: "status", ...status() };
    for (const page of pages) for (const frame of page.frames()) void tell(frame, message);
  };
  const toast = (page: Page, text: string, level: "info" | "warn" = "info") =>
    void tell(page.mainFrame(), { kind: "toast", text, level });

  const setMode = (next: RecorderMode) => {
    mode = next;
    broadcastStatus();
  };

  /**
   * Finalizes a target reported by the page. With `item`, the locators are
   * relative to that item of the open list and are checked inside it.
   */
  async function toTarget(
    frame: Frame,
    wire: WireTarget,
    ref: ElementRef,
    item?: { index: number },
  ): Promise<Target | null> {
    if (wire.locators.length === 0) return null;
    if (item) {
      // The frame object itself is not compared: it is replaced when the page reloads.
      const list = scopes.find((scope) => scope.kind === "list");
      if (!list) return null;
      const root = buildLocator(frame, list.target.locators[0] as Locator).nth(item.index);
      const locators = await verifyLocators(frame, root, wire.locators, ref);
      return { locators, fingerprint: wire.fingerprint, frame: [], relativeTo: "item" };
    }
    const locators = await verifyLocators(frame, frame, wire.locators, ref);
    return {
      locators,
      fingerprint: wire.fingerprint,
      frame: await frameChain(frame),
      relativeTo: null,
    };
  }

  async function onAction(
    frame: Frame,
    page: Page,
    message: Extract<PageMessage, { kind: "action" }>,
  ) {
    const target =
      message.target && message.ref
        ? await toTarget(frame, message.target, message.ref, message.item)
        : null;
    let step: StepDraft;
    if (message.action === "press") {
      step = { type: "press", key: message.key ?? "Enter", ...(target ? { target } : {}) };
    } else if (!target) {
      return warn(`A ${message.action} was skipped: no reliable way to find its element again.`);
    } else if (message.action === "click") {
      step = { type: "click", target };
    } else {
      step = { type: message.action, target, value: message.value ?? "" };
    }
    items.push({
      kind: "step",
      step,
      at: message.at,
      urlBefore: frame === page.mainFrame() ? message.url : page.url(),
      ...(message.ref ? { elementKey: `${message.ref.nonce}:${message.ref.key}` } : {}),
      ...(message.interactive === undefined ? {} : { interactive: message.interactive }),
      ...(message.effectId === undefined ? {} : { effectId: message.effectId }),
    });
    emit(
      "info",
      "step",
      message.action === "press"
        ? `press ${step.type === "press" ? step.key : ""}`
        : message.action,
    );
  }

  async function onPick(frame: Frame, page: Page, message: Extract<PageMessage, { kind: "pick" }>) {
    const target = await toTarget(frame, message.target, message.ref, message.item);
    if (!target)
      return toast(page, "Could not find a reliable way to locate that element.", "warn");
    const link = message.link
      ? await toTarget(frame, message.link.target, message.link.ref, message.item)
      : null;
    const pickId = ++pickSeq;
    picks.set(pickId, {
      target,
      ...(link ? { link } : {}),
      samples: message.samples,
      baseUrl: frame.url(),
    });
    await tell(page.mainFrame(), { kind: "prompt", pickId, samples: message.samples });
  }

  async function onListConfirmed(
    frame: Frame,
    page: Page,
    message: Extract<PageMessage, { kind: "listConfirmed" }>,
  ) {
    if (innermost())
      return toast(page, "Finish the current list before marking another one.", "warn");
    if (message.target.locators.length === 0) {
      return toast(page, "Could not find a reliable way to locate those items.", "warn");
    }
    const locators = await verifyListLocators(
      frame,
      message.target.locators,
      message.group,
      message.count,
    );
    const target: Target = {
      locators,
      fingerprint: message.target.fingerprint,
      frame: await frameChain(frame),
      relativeTo: null,
    };
    items.push({ kind: "listStart", items: target, at: Date.now() });
    scopes.push({ kind: "list", target, count: message.count });
    hasList = true;
    emit("info", "list", `List of ${message.count} items`);
    toast(page, `List of ${message.count} items. Now mark the data inside one of them.`);
    setMode("markField");
  }

  async function onDetailPick(frame: Frame, message: Extract<PageMessage, { kind: "detailPick" }>) {
    const link = await toTarget(frame, message.target, message.ref, message.item);
    if (!link) return warn("The detail link was skipped: no reliable way to find it in each item.");
    let followable = false;
    try {
      followable =
        message.href !== undefined && /^https?:$/.test(new URL(message.href, message.url).protocol);
    } catch {
      // Not a URL: the link has to be clicked.
    }
    // A real address can be opened in its own tab, which leaves the list page untouched.
    items.push({
      kind: "detailStart",
      link,
      strategy: followable ? "newTab" : "sameTab",
      at: message.at,
    });
    emit("info", "detail", "Opening a detail page");
  }

  async function onNextPick(
    frame: Frame,
    page: Page,
    message: Extract<PageMessage, { kind: "nextPick" }>,
  ) {
    const target = await toTarget(frame, message.target, message.ref);
    if (!target)
      return toast(page, "Could not find a reliable way to locate that control.", "warn");
    items.push({ kind: "paginate", mode: "nextButton", next: target, at: Date.now() });
    emit("info", "paginate", "Next-page control marked");
    toast(page, "Next-page control saved. Replays keep clicking it until it is gone or disabled.");
    setMode(innermost()?.kind === "list" ? "markField" : "record");
  }

  /** Finish list / Back to list. Leaving a detail page also takes the browser back. */
  async function finishScope() {
    const scope = innermost();
    if (!scope) return;
    if (scope.kind === "detail") {
      selfNavigating = true;
      try {
        if (scope.popup) await scope.page.close().catch(() => {});
        else {
          for (let attempt = 0; attempt < 3 && scope.listPage.url() !== scope.listUrl; attempt++) {
            await scope.listPage.goBack().catch(() => null);
          }
          if (scope.listPage.url() !== scope.listUrl) {
            await scope.listPage.goto(scope.listUrl).catch(() => null);
          }
        }
        await delay(100);
      } finally {
        selfNavigating = false;
      }
      activePage = scope.listPage;
    }
    // Only now: until the browser is back, the pages must keep seeing the old scope.
    scopes.pop();
    items.push({ kind: "scopeEnd", at: Date.now() });
    setMode(scope.kind === "detail" ? "markField" : "record");
  }

  function onFieldNamed(page: Page, message: Extract<PageMessage, { kind: "fieldNamed" }>) {
    const pick = picks.get(message.pickId);
    if (!pick) return;
    picks.delete(message.pickId);
    const asLink = message.read === "href" && pick.link !== undefined;
    const field: Field = {
      name: message.name,
      target: asLink ? (pick.link as Target) : pick.target,
      read: asLink ? "attr" : message.read === "innerHTML" ? "innerHTML" : "text",
      attr: asLink ? "href" : null,
      transforms: asLink ? ["absoluteUrl"] : message.read === "innerHTML" ? [] : ["trim"],
      required: message.name === "title",
    };
    let sample: string | null;
    if (asLink) {
      try {
        sample = new URL(pick.samples.href ?? "", pick.baseUrl).href;
      } catch {
        sample = pick.samples.href ?? null;
      }
    } else {
      sample = field.read === "innerHTML" ? pick.samples.html : pick.samples.text.trim();
    }
    // Marking the same field again right away replaces the earlier choice.
    const last = items.at(-1);
    if (last?.kind === "field" && last.field.name === field.name) items.pop();
    items.push({ kind: "field", field, at: Date.now() });
    samples[field.name] = sample;
    emit("info", "field", `${field.name} = ${JSON.stringify((sample ?? "").slice(0, 80))}`);
    toast(page, `Saved "${field.name}"`);
  }

  function onMessage(
    source: { page: Page; frame: Frame },
    raw: unknown,
  ): RecorderStatus | undefined {
    const parsed = pageMessageSchema.safeParse(raw);
    if (!parsed.success || closed) return undefined;
    const message = parsed.data;
    const { page, frame } = source;
    switch (message.kind) {
      case "hello":
        return status();
      case "setMode": {
        const scope = innermost()?.kind ?? "none";
        const allowed =
          message.mode === "markList"
            ? scope === "none"
            : message.mode === "openDetail"
              ? scope === "list"
              : message.mode === "markNext"
                ? hasList && scope !== "detail"
                : message.mode === "markLoggedIn"
                  ? options.authProfileId !== undefined && scope === "none"
                  : true;
        if (!allowed) return undefined;
        emit("info", "mode", message.mode);
        setMode(message.mode);
        return undefined;
      }
      case "notice":
        toast(page, message.text, message.level);
        return undefined;
      case "listPick":
        listPickFrame = frame;
        void tell(page.mainFrame(), {
          kind: "promptList",
          count: message.count,
          canWiden: message.canWiden,
          canNarrow: message.canNarrow,
        });
        return undefined;
      case "listChoice":
        if (listPickFrame) void tell(listPickFrame, { kind: "listChoice", choice: message.choice });
        if (message.choice === "cancel") listPickFrame = undefined;
        return undefined;
      case "listConfirmed":
        listPickFrame = undefined;
        enqueue(() => onListConfirmed(frame, page, message));
        return undefined;
      case "detailPick": {
        if (innermost()?.kind !== "list") return undefined;
        // Decided right away: the click is already navigating or opening a tab.
        // The page reports its own URL: by now the browser may already show the detail page.
        scopes.push({
          kind: "detail",
          page,
          listPage: page,
          listUrl: frame === page.mainFrame() ? message.url : page.url(),
          popup: false,
        });
        setMode("markField");
        enqueue(() => onDetailPick(frame, message));
        return undefined;
      }
      case "loggedInPick":
        if (!options.authProfileId) return undefined;
        enqueue(async () => {
          const target = await toTarget(frame, message.target, message.ref);
          if (!target)
            return toast(page, "Could not find a reliable way to locate that element.", "warn");
          loggedInCheck = target;
          emit("info", "auth", "Logged-in check marked");
          toast(page, "Saved. Runs will stop with a clear message when this element is missing.");
          setMode("record");
        });
        return undefined;
      case "authSave":
      case "authCancel":
        return undefined;
      case "nextPick":
        if (!hasList) return undefined;
        enqueue(() => onNextPick(frame, page, message));
        return undefined;
      case "setPagination":
        if (!hasList) return undefined;
        items.push({ kind: "paginate", mode: "infiniteScroll", at: Date.now() });
        emit("info", "paginate", "Infinite scroll");
        toast(page, "Replays will scroll this list until no more jobs load.");
        return undefined;
      case "finishScope":
        enqueue(finishScope);
        return undefined;
      case "stop":
        void finish().catch(() => {});
        return undefined;
      case "sensitive":
        warn(message.reason);
        toast(page, message.reason, "warn");
        return undefined;
      case "effect": {
        const item = items.find(
          (candidate) => candidate.kind === "step" && candidate.effectId === message.effectId,
        );
        if (item?.kind === "step") item.mutated = message.mutated;
        return undefined;
      }
      case "fieldCancelled":
        picks.delete(message.pickId);
        return undefined;
      case "action":
        enqueue(async () => {
          await onAction(frame, page, message);
          broadcastStatus();
        });
        return undefined;
      case "pick":
        enqueue(() => onPick(frame, page, message));
        return undefined;
      case "fieldNamed":
        enqueue(async () => {
          onFieldNamed(page, message);
          broadcastStatus();
        });
        return undefined;
    }
  }

  /** Watches one tab's navigations. Chromium tells page-started ones apart from typed URLs. */
  async function attachPage(page: Page, popup: boolean) {
    pages.add(page);
    activePage = page;
    let popupPending = popup;
    let navigationStart: string | undefined;
    page.on("close", () => {
      pages.delete(page);
      if (activePage === page) activePage = [...pages].at(-1);
      if (pages.size === 0) void finish().catch(() => {});
    });
    page.on("request", (request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame() &&
        !request.redirectedFrom()
      ) {
        navigationStart = request.url();
      }
    });
    page.on("domcontentloaded", () => {
      void page
        .title()
        .then((title) => {
          if (title && activePage === page) lastTitle = title;
        })
        .catch(() => {});
    });

    const pushNavigate = (url: string, replacesClick = false) => {
      items.push({
        kind: "step",
        step: { type: "navigate", url },
        at: Date.now(),
        seq: navigationSeq++,
        ...(replacesClick ? { replacesClick } : {}),
      });
      emit("info", "navigate", url);
      broadcastStatus();
    };
    const openedAsPopup = (url: string) => {
      popupPending = false;
      const scope = innermost();
      if (scope?.kind === "detail" && !scope.popup && scope.page !== page) {
        // The detail link opened its own tab: that tab is the detail page.
        scope.page = page;
        scope.popup = true;
        broadcastStatus();
        return;
      }
      warn(
        "A click opened a new tab. Replays stay in one tab, so the recording navigates to that tab's address instead.",
      );
      pushNavigate(url, true);
    };

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.enable");
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const requested = new Set<string>();
    cdp.on("Page.frameRequestedNavigation", (event) => requested.add(event.frameId));
    cdp.on("Page.frameNavigated", ({ frame }) => {
      const pageStarted = requested.delete(frame.id);
      if (frame.parentId) return;
      const url = frame.url + (frame.urlFragment ?? "");
      const typed = navigationStart;
      navigationStart = undefined;
      if (closed || selfNavigating || url === "about:blank" || url.startsWith("chrome-error:")) {
        return;
      }
      if (popupPending) openedAsPopup(url);
      else if (pageStarted) navigations.push({ url, at: Date.now(), seq: navigationSeq++ });
      else pushNavigate(typed ?? url);
    });
    cdp.on("Page.navigatedWithinDocument", (event) => {
      if (!closed && !selfNavigating && event.frameId === frameTree.frame.id)
        navigations.push({ url: event.url, at: Date.now(), seq: navigationSeq++ });
    });
    if (popupPending && page.url() !== "" && page.url() !== "about:blank")
      openedAsPopup(page.url());
  }

  async function produce(): Promise<RecorderResult> {
    // Collect text that was typed but not yet reported, then let the queue drain.
    const flushes = [...pages].flatMap((page) =>
      page
        .frames()
        .map((frame) =>
          frame
            .evaluate((api) => (window as unknown as ApiWindow)[api]?.flush(), API_NAME)
            .catch(() => {}),
        ),
    );
    await Promise.race([Promise.all(flushes), delay(1000)]);
    await delay(100);
    closed = true;
    await queue;

    const steps = postProcess(items, navigations);
    const firstUrl = steps.find((step) => step.type === "navigate");
    let host = options.url;
    try {
      host = new URL(options.url).host;
    } catch {
      // Keep the raw value as the fallback name.
    }
    try {
      const recording = parseRecording({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        id: options.id ?? newId("recording"),
        name: options.name?.trim() || lastTitle || host,
        startUrl: firstUrl?.type === "navigate" ? firstUrl.url : options.url,
        ...(options.authProfileId ? { authProfileId: options.authProfileId } : {}),
        ...(loggedInCheck ? { loggedInCheck } : {}),
        steps,
      });
      return { recording, samples, warnings };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      await context?.close().catch(() => {});
      if (!options.browser) await browser.close().catch(() => {});
    }
  }

  /** Ends the session and builds the recording. Safe to call more than once. */
  function finish(): Promise<RecorderResult> {
    if (!finishing) {
      finishing = produce();
      finishing.then(done.resolve, done.reject);
    }
    return finishing;
  }
  const onAbort = () => void finish().catch(() => {});

  try {
    context = await browser.newContext({
      viewport: headless ? { width: 1280, height: 800 } : null,
      ...(options.storageState === undefined ? {} : { storageState: options.storageState }),
    });
    await context.exposeBinding(BRIDGE_NAME, onMessage);
    const config: RecorderConfig = { openShadow: options.openShadow === true };
    await context.addInitScript({
      content: `window[${JSON.stringify(CONFIG_NAME)}] = ${JSON.stringify(config)};\n${await injectedScript()}`,
    });
    // Tabs opened by the page (target="_blank", window.open) have an opener; tabs
    // the user opens do not, and behave like the first one.
    const attached = new Map<Page, Promise<void>>();
    const attach = (page: Page) => {
      if (!attached.has(page)) {
        attached.set(
          page,
          page
            .opener()
            .then((opener) => attachPage(page, opener !== null))
            .catch(() => {}),
        );
      }
      return attached.get(page);
    };
    context.on("page", (page) => void attach(page));
    const page = await context.newPage();
    // Navigation tracking must be in place before the first page load.
    await attach(page);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    else {
      try {
        await page.goto(options.url);
      } catch (error) {
        throw new JobTraceError(
          "NAVIGATION_FAILED",
          `Could not open ${options.url}: ${(error as Error).message.split("\n")[0]}`,
          {
            cause: error,
          },
        );
      }
    }
  } catch (error) {
    await context?.close().catch(() => {});
    if (!options.browser) await browser.close().catch(() => {});
    throw error;
  }

  return {
    get page() {
      return activePage ?? ([...pages][0] as Page);
    },
    context,
    finished: done.promise,
    stop: finish,
    status,
    idle: async () => {
      await delay(50);
      await queue;
    },
  };
}
