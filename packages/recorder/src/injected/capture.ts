import { isSensitive, isTextEntry } from "./dom.ts";
import { generateTarget } from "./locators.ts";
import type { Overlay } from "./overlay.ts";
import type { ElementRef, FieldSamples, PageMessage, RecorderMode } from "./protocol.ts";

export interface CaptureDeps {
  send(message: PageMessage): void;
  register(element: Element): ElementRef;
  overlay: Overlay;
  getMode(): RecorderMode;
}

/** Elements a click is "really" aimed at, even when it lands on a child. */
const INTERACTIVE =
  'a[href], button, input, select, textarea, label, summary, option, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [onclick], [tabindex]:not([tabindex="-1"])';
const RECORDED_KEYS = new Set(["Enter", "Escape", "Tab"]);
/** How long after a click on a non-interactive element to watch for any effect. */
const EFFECT_WINDOW_MS = 400;

function deepTarget(event: Event): Element | null {
  const first = event.composedPath()[0];
  if (first instanceof Element) return first;
  return first instanceof Node ? first.parentElement : null;
}

/**
 * Listens for user actions (capture phase, trusted events only) and reports
 * them. In "markField" mode clicks never reach the page; they pick data instead.
 * Returns `flush`, which reports text that was typed but not yet sent.
 */
export function installCapture({ send, register, overlay, getMode }: CaptureDeps): {
  flush(): void;
} {
  const fromOverlay = (event: Event) => event.composedPath().includes(overlay.host);
  const url = () => location.href;
  let pendingFill: {
    element: Element;
    value: string;
    message: PageMessage & { kind: "action" };
  } | null = null;
  let lastLabel: { control: Element | null; at: number } | null = null;
  let lastEnterAt = 0;
  let nextEffectId = 1;
  let nextPickId = 1;
  const warned = new WeakSet<Element>();

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

  const describe = (element: Element) => ({
    ref: register(element),
    target: generateTarget(element, "action"),
  });

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
    const message: PageMessage = {
      kind: "action",
      action: "click",
      at: Date.now(),
      url: url(),
      interactive,
      ...describe(element),
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
      pendingFill = {
        element,
        value,
        message: {
          kind: "action",
          action: "fill",
          at: Date.now(),
          url: url(),
          ...describe(element),
        },
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
      ...describe(element),
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
      element && (typing || element instanceof HTMLSelectElement) ? describe(element) : {};
    send({
      kind: "action",
      action: "press",
      at: Date.now(),
      url: url(),
      key: event.key,
      ...focused,
    });
  }

  function pick(element: Element) {
    const link = element.closest("a[href]");
    const samples: FieldSamples = {
      text: element instanceof HTMLElement ? element.innerText : (element.textContent ?? ""),
      html: element.innerHTML,
      ...(link ? { href: link.getAttribute("href") ?? "" } : {}),
    };
    send({
      kind: "pick",
      pickId: nextPickId++,
      ref: register(element),
      target: generateTarget(element, "field"),
      ...(link ? { link: { ref: register(link), target: generateTarget(link, "field") } } : {}),
      samples,
    });
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

  // While marking fields, the page must not react to the pointer at all.
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
      if (getMode() !== "markField") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type !== "click") return;
      const element = deepTarget(event);
      if (element && !isSensitive(element)) pick(element);
    });
  }
  listen("mousemove", (event) => {
    if (getMode() !== "markField") return;
    const element = deepTarget(event);
    overlay.highlight(element?.getBoundingClientRect() ?? null, element?.localName);
  });
  document.addEventListener("mouseleave", () => overlay.highlight(null));

  const whenRecording =
    <E extends Event>(handler: (event: E) => void) =>
    (event: E) => {
      if (getMode() === "record") handler(event);
    };
  listen("click", whenRecording(onClick));
  listen("input", whenRecording(onInput));
  listen("change", whenRecording(onChange));
  listen("keydown", (event) => {
    if (getMode() === "markField") {
      if (event.key === "Escape") send({ kind: "setMode", mode: "record" });
      return;
    }
    onKeyDown(event);
  });
  listen("focusout", flush);
  listen("submit", flush);
  window.addEventListener("pagehide", flush);

  return { flush };
}
