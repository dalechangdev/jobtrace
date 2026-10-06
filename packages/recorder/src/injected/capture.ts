import { isSensitive, isTextEntry } from "./dom.ts";
import {
  bestCandidate,
  generateListTarget,
  generateRelativeTarget,
  listCandidates,
  resolveItems,
} from "./lists.ts";
import { generateTarget } from "./locators.ts";
import type { Overlay } from "./overlay.ts";
import type {
  ElementRef,
  FieldSamples,
  GeneratePurpose,
  ListChoice,
  PageMessage,
  RecorderStatus,
  WireTarget,
} from "./protocol.ts";

export interface CaptureDeps {
  send(message: PageMessage): void;
  register(element: Element): ElementRef;
  registerGroup(elements: readonly Element[]): ElementRef;
  overlay: Overlay;
  getStatus(): RecorderStatus;
}

export interface Capture {
  /** Reports text that was typed but not yet sent. */
  flush(): void;
  /** Applies the user's answer from the list dialog to the pending candidates. */
  chooseList(choice: ListChoice): void;
  /** Redraws item outlines after the mode or scope changed. */
  refresh(): void;
}

/** Elements a click is "really" aimed at, even when it lands on a child. */
const INTERACTIVE =
  'a[href], button, input, select, textarea, label, summary, option, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [onclick], [tabindex]:not([tabindex="-1"])';
const RECORDED_KEYS = new Set(["Enter", "Escape", "Tab"]);
/** How long after a click on a non-interactive element to watch for any effect. */
const EFFECT_WINDOW_MS = 400;
/** Modes in which a click picks something and must not reach the page. */
const PICKING = new Set(["markField", "markList", "markNext"]);

function deepTarget(event: Event): Element | null {
  const first = event.composedPath()[0];
  if (first instanceof Element) return first;
  return first instanceof Node ? first.parentElement : null;
}

interface Described {
  ref: ElementRef;
  target: WireTarget;
  item?: { index: number };
}

/**
 * Listens for user actions (capture phase) and reports them. What a click
 * means depends on the mode: an action to replay, or a pick of a field, a
 * list, a detail link or the next-page control.
 */
export function installCapture({
  send,
  register,
  registerGroup,
  overlay,
  getStatus,
}: CaptureDeps): Capture {
  const fromOverlay = (event: Event) => event.composedPath().includes(overlay.host);
  const url = () => location.href;
  const mode = () => getStatus().mode;
  let pendingFill: {
    element: Element;
    value: string;
    message: PageMessage & { kind: "action" };
  } | null = null;
  let lastLabel: { control: Element | null; at: number } | null = null;
  let lastEnterAt = 0;
  let nextEffectId = 1;
  let nextPickId = 1;
  let listChoice: { candidates: Element[][]; index: number } | null = null;
  let warnedOutside = false;
  const warned = new WeakSet<Element>();

  const notice = (text: string, level: "info" | "warn" = "warn") =>
    send({ kind: "notice", text, level });

  /** The current list's items in this frame; empty when no list is open (or it lives elsewhere). */
  const listItems = (): Element[] => {
    const status = getStatus();
    return status.scope === "list" && status.list ? resolveItems(status.list.locators) : [];
  };
  const itemOf = (element: Element, items: readonly Element[]) => {
    const index = items.findIndex((item) => item !== element && item.contains(element));
    return index < 0 ? null : { item: items[index] as Element, index };
  };

  /**
   * Locators for an element: relative to its list item while a list is being
   * recorded, absolute otherwise.
   */
  function describe(element: Element, purpose: GeneratePurpose): Described {
    const items = listItems();
    const inside = itemOf(element, items);
    if (inside) {
      return {
        ref: register(element),
        target: generateRelativeTarget(element, inside.item, items, purpose),
        item: { index: inside.index },
      };
    }
    return { ref: register(element), target: generateTarget(element, purpose) };
  }

  const flush = () => {
    if (!pendingFill) return;
    const { message, value } = pendingFill;
    pendingFill = null;
    send({ ...message, value });
  };

  const warnSensitive = (element: Element) => {
    if (warned.has(element)) return;
    warned.add(element);
    send({
      kind: "sensitive",
      reason:
        "Typing into a password, payment or one-time-code field is never recorded. To scrape pages behind a login, create an auth profile instead.",
    });
  };

  /** Actions outside the items of an open list would otherwise be repeated for every item. */
  const noteOutsideList = (described: Described) => {
    if (described.item || warnedOutside || getStatus().scope !== "list" || listItems().length === 0)
      return;
    warnedOutside = true;
    notice(
      "Actions outside the list's items are replayed once, before the list. Use Finish list when you are done with it.",
      "info",
    );
  };

  function onClick(event: MouseEvent) {
    const raw = deepTarget(event);
    if (!raw) return;
    if (isSensitive(raw)) return warnSensitive(raw);
    if (pendingFill?.element === raw) return;
    flush();

    const closest = raw.closest(INTERACTIVE);
    const element = closest ?? raw;
    // <select> choices are reported by the change event.
    if (element instanceof HTMLSelectElement || element instanceof HTMLOptionElement) return;
    // Clicking a label also fires a click on its control; replaying both would toggle twice.
    if (lastLabel && lastLabel.control === element && Date.now() - lastLabel.at < 200) return;
    lastLabel =
      element instanceof HTMLLabelElement ? { control: element.control, at: Date.now() } : null;
    // Enter in a form field makes the browser click the form's submit button
    // itself. The key press is what the user did; replaying both would submit twice.
    const submitButton = element.matches('button, input[type="submit"], input[type="image"]');
    if (event.detail === 0 && submitButton && Date.now() - lastEnterAt < 500) return;

    const interactive = closest !== null;
    const described = describe(element, "action");
    noteOutsideList(described);
    const message: PageMessage = {
      kind: "action",
      action: "click",
      at: Date.now(),
      url: url(),
      interactive,
      ...described,
    };
    if (interactive) return send(message);

    const effectId = nextEffectId++;
    send({ ...message, effectId });
    let mutated = false;
    const observer = new MutationObserver((records) => {
      mutated ||= records.some(
        (record) => !overlay.host.contains(record.target) && record.target !== overlay.host,
      );
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    setTimeout(() => {
      observer.disconnect();
      send({ kind: "effect", effectId, mutated });
    }, EFFECT_WINDOW_MS);
  }

  function onInput(event: Event) {
    const element = deepTarget(event);
    if (!element || !isTextEntry(element)) return;
    if (isSensitive(element)) return warnSensitive(element);
    if (pendingFill && pendingFill.element !== element) flush();
    const value =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : (element as HTMLElement).innerText;
    if (pendingFill) pendingFill.value = value;
    else {
      const described = describe(element, "action");
      noteOutsideList(described);
      pendingFill = {
        element,
        value,
        message: { kind: "action", action: "fill", at: Date.now(), url: url(), ...described },
      };
    }
  }

  function onChange(event: Event) {
    const element = deepTarget(event);
    if (!(element instanceof HTMLSelectElement)) return;
    flush();
    send({
      kind: "action",
      action: "select",
      at: Date.now(),
      url: url(),
      value: element.value,
      ...describe(element, "action"),
    });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.isComposing || !RECORDED_KEYS.has(event.key)) return;
    const element = deepTarget(event);
    if (isSensitive(element)) return;
    const typing = isTextEntry(element);
    if (event.key === "Enter") {
      // In multi-line editors Enter is text; on buttons and links it produces a click.
      if (
        element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLElement && element.isContentEditable)
      )
        return;
      if (
        element?.closest(
          'a[href], button, summary, [role="button"], [role="link"], input[type="submit"], input[type="button"]',
        )
      )
        return;
    }
    if (event.key === "Enter" && typing) lastEnterAt = Date.now();
    flush();
    const focused =
      element && (typing || element instanceof HTMLSelectElement)
        ? describe(element, "action")
        : {};
    send({
      kind: "action",
      action: "press",
      at: Date.now(),
      url: url(),
      key: event.key,
      ...focused,
    });
  }

  function pickField(element: Element) {
    const status = getStatus();
    const items = listItems();
    const inside = itemOf(element, items);
    if (status.scope === "list" && !inside) {
      return notice(
        "Click a piece of data inside one of the list's items. To mark something else, press Finish list first.",
      );
    }
    const link = element.closest("a[href]");
    const linkInScope =
      link && (!inside || (link !== inside.item && inside.item.contains(link))) ? link : null;
    const samples: FieldSamples = {
      text: element instanceof HTMLElement ? element.innerText : (element.textContent ?? ""),
      html: element.innerHTML,
      ...(linkInScope ? { href: linkInScope.getAttribute("href") ?? "" } : {}),
    };
    const target = (node: Element) =>
      inside
        ? generateRelativeTarget(node, inside.item, items, "field")
        : generateTarget(node, "field");
    send({
      kind: "pick",
      pickId: nextPickId++,
      ref: register(element),
      target: target(element),
      ...(linkInScope ? { link: { ref: register(linkInScope), target: target(linkInScope) } } : {}),
      samples,
      ...(inside ? { item: { index: inside.index } } : {}),
    });
  }

  const showCandidates = () => {
    if (!listChoice) return;
    const group = listChoice.candidates[listChoice.index] as Element[];
    overlay.highlightAll(group.map((item) => item.getBoundingClientRect()));
    send({
      kind: "listPick",
      count: group.length,
      canNarrow: listChoice.index > 0,
      canWiden: listChoice.index < listChoice.candidates.length - 1,
    });
  };

  function pickList(element: Element) {
    const candidates = listCandidates(element);
    if (candidates.length === 0) {
      return notice(
        "Nothing similar was found next to that element. Click one whole job card or row.",
      );
    }
    listChoice = { candidates, index: bestCandidate(candidates) };
    showCandidates();
  }

  function chooseList(choice: ListChoice) {
    if (!listChoice) return;
    if (choice === "wider" || choice === "narrower") {
      const next = listChoice.index + (choice === "wider" ? 1 : -1);
      if (listChoice.candidates[next]) listChoice.index = next;
      return showCandidates();
    }
    const group = listChoice.candidates[listChoice.index] as Element[];
    listChoice = null;
    overlay.highlightAll([]);
    if (choice === "use") {
      send({
        kind: "listConfirmed",
        group: registerGroup(group),
        target: generateListTarget(group),
        count: group.length,
      });
    }
  }

  /** In openDetail mode the click is both recorded as the detail link and allowed to happen. */
  function pickDetail(event: Event, raw: Element) {
    const items = listItems();
    const inside = itemOf(raw, items);
    if (!inside) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return notice("Click a link inside one of the list's items.");
    }
    const link = raw.closest("a[href]");
    const withinItem = (node: Element | null) =>
      node && node !== inside.item && inside.item.contains(node) ? node : null;
    const element = withinItem(link) ?? withinItem(raw.closest(INTERACTIVE)) ?? raw;
    const href = element.getAttribute("href");
    send({
      kind: "detailPick",
      at: Date.now(),
      url: url(),
      item: { index: inside.index },
      ref: register(element),
      // The link's text is the job title, which differs per item: field-style locators only.
      target: generateRelativeTarget(element, inside.item, items, "field"),
      ...(href ? { href } : {}),
    });
  }

  function pickNext(raw: Element) {
    const element = raw.closest(INTERACTIVE) ?? raw;
    send({ kind: "nextPick", ref: register(element), target: generateTarget(element, "action") });
  }

  /**
   * Pointer and key events must be real user input (`isTrusted`), so a site's
   * own scripted clicks are not recorded. Value changes are accepted either
   * way: what matters there is the value the field ended up with.
   */
  const VALUE_EVENTS = new Set(["input", "change", "focusout", "submit"]);
  const listen = <K extends keyof DocumentEventMap>(
    type: K,
    handler: (event: DocumentEventMap[K]) => void,
  ) =>
    document.addEventListener(
      type,
      (event) => {
        if ((!event.isTrusted && !VALUE_EVENTS.has(type)) || fromOverlay(event)) return;
        handler(event);
      },
      true,
    );

  // While picking, the page must not react to the pointer at all.
  for (const type of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
    "auxclick",
    "dblclick",
    "contextmenu",
    "submit",
  ] as const) {
    listen(type, (event) => {
      const current = mode();
      const element = deepTarget(event);
      if (current === "openDetail") {
        if (type === "click" && element) pickDetail(event, element);
        return;
      }
      if (!PICKING.has(current)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type !== "click" || !element || isSensitive(element)) return;
      if (current === "markField") pickField(element);
      else if (current === "markList") pickList(element);
      else pickNext(element);
    });
  }
  listen("mousemove", (event) => {
    if (mode() === "record" || listChoice) return;
    const element = deepTarget(event);
    overlay.highlight(element?.getBoundingClientRect() ?? null, element?.localName);
  });
  document.addEventListener("mouseleave", () => overlay.highlight(null));

  const whenRecording =
    <E extends Event>(handler: (event: E) => void) =>
    (event: E) => {
      if (mode() === "record") handler(event);
    };
  listen("click", whenRecording(onClick));
  listen("input", whenRecording(onInput));
  listen("change", whenRecording(onChange));
  listen("keydown", (event) => {
    if (mode() !== "record") {
      if (event.key === "Escape") send({ kind: "setMode", mode: "record" });
      return;
    }
    onKeyDown(event);
  });
  listen("focusout", flush);
  listen("submit", flush);
  window.addEventListener("pagehide", flush);

  // While a list is open, keep its items outlined so it is clear what "inside an item" means.
  const refresh = () => {
    if (listChoice) {
      if (mode() !== "markList") {
        listChoice = null;
        overlay.highlightAll([]);
      }
      return;
    }
    const outlined = mode() === "markField" || mode() === "openDetail" ? listItems() : [];
    overlay.highlightAll(
      outlined.map((item) => item.getBoundingClientRect()),
      "dashed",
    );
  };
  const redraw = () => {
    if (listChoice) {
      const group = listChoice.candidates[listChoice.index] as Element[];
      overlay.highlightAll(group.map((item) => item.getBoundingClientRect()));
    } else refresh();
  };
  window.addEventListener("scroll", redraw, true);
  window.addEventListener("resize", redraw);
  setInterval(() => {
    if (listChoice || getStatus().scope === "list") redraw();
  }, 400);

  return { flush, chooseList, refresh };
}
