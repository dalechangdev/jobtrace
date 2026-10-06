/** DOM helpers for the in-page recorder: stability heuristics, roles, names, deep queries. */

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * True for class names and ids that look machine-generated (CSS-in-JS hashes,
 * CSS-module suffixes, framework ids) and so are likely to change between deploys.
 */
export function looksGenerated(token: string): boolean {
  if (token.length > 40) return true;
  if (/^(css|sc|jsx|jss|emotion|styled|svelte|chakra|mui|makeStyles)-/i.test(token)) return true;
  if (/^(ember|react-select|radix|headlessui|mantine|rc|el)-?[\w:-]*\d/i.test(token)) return true;
  if (/^:r[\w]*:$/.test(token)) return true;
  if (/\d{3,}/.test(token)) return true;
  if (/(__|--|_)[A-Za-z0-9]{5,}$/.test(token) && /\d/.test(token.split(/__|--|_/).at(-1) ?? "")) {
    return true;
  }
  // Short hash-like tokens mixing letters and digits, e.g. "a1b2c3" or "x9k2".
  if (
    /^[a-z]*\d[a-z\d]*$/i.test(token) &&
    /[a-z]/i.test(token) &&
    (token.match(/\d/g) ?? []).length >= 2
  ) {
    return true;
  }
  return false;
}

export function stableClasses(element: Element): string[] {
  return [...element.classList].filter(
    (name) =>
      !looksGenerated(name) &&
      !/^(is|has)-|^(active|selected|hover|focus|open|show|hidden|disabled)$/.test(name),
  );
}

export function stableId(element: Element): string | null {
  const id = element.getAttribute("id");
  return id && !looksGenerated(id) && !/\s/.test(id) ? id : null;
}

/** All elements matching `selector` in the document and in every open shadow root. */
export function queryAllDeep(selector: string, root: Document | ShadowRoot = document): Element[] {
  const found: Element[] = [];
  const visit = (scope: Document | ShadowRoot) => {
    try {
      found.push(...scope.querySelectorAll(selector));
    } catch {
      return;
    }
    for (const element of scope.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(root);
  return found;
}

export function allElementsDeep(): Element[] {
  return queryAllDeep("*");
}

export function inShadowRoot(element: Element): boolean {
  return element.getRootNode() instanceof ShadowRoot;
}

const INPUT_ROLES: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  search: "searchbox",
  number: "spinbutton",
  text: "textbox",
  email: "textbox",
  tel: "textbox",
  url: "textbox",
};

const TAG_ROLES: Record<string, string> = {
  button: "button",
  textarea: "textbox",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  article: "article",
  main: "main",
  nav: "navigation",
  li: "listitem",
  ul: "list",
  ol: "list",
  table: "table",
  dialog: "dialog",
  summary: "button",
  option: "option",
  progress: "progressbar",
};

/** ARIA role for the common cases. Returns null when unsure, so no role locator is emitted. */
export function roleOf(element: Element): string | null {
  const explicit = normalizeText(element.getAttribute("role")).split(" ")[0];
  if (explicit) return explicit;
  const tag = element.localName;
  if (tag === "a" || tag === "area") return element.hasAttribute("href") ? "link" : null;
  if (tag === "img") return element.getAttribute("alt") ? "img" : null;
  if (tag === "select") {
    const select = element as HTMLSelectElement;
    return select.multiple || select.size > 1 ? "listbox" : "combobox";
  }
  if (tag === "input") {
    const input = element as HTMLInputElement;
    if (input.hasAttribute("list")) return "combobox";
    return INPUT_ROLES[input.type] ?? null;
  }
  return TAG_ROLES[tag] ?? null;
}

export function headingLevel(element: Element): number | undefined {
  const match = /^h([1-6])$/.exec(element.localName);
  if (match) return Number(match[1]);
  const level = Number(element.getAttribute("aria-level"));
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : undefined;
}

const NAME_FROM_CONTENT = new Set([
  "link",
  "button",
  "heading",
  "option",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
]);

/**
 * Accessible name for the simple, unambiguous cases only (aria-label, a single
 * aria-labelledby, <label>, alt, plain text content). Returns null when the
 * real algorithm would be more involved, so the role locator is skipped rather
 * than guessed wrong.
 */
export function accessibleName(element: Element, role: string): string | null {
  const label = normalizeText(element.getAttribute("aria-label"));
  if (label) return label;
  const labelledBy = normalizeText(element.getAttribute("aria-labelledby"));
  if (labelledBy) {
    if (labelledBy.includes(" ")) return null;
    const root = element.getRootNode() as Document | ShadowRoot;
    return normalizeText(root.getElementById?.(labelledBy)?.textContent) || null;
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type)
    ) {
      return normalizeText(element.value) || null;
    }
    const labels = element.labels ? [...element.labels] : [];
    if (labels.length !== 1) return null;
    // A wrapping label's text includes the control's own text (e.g. <select> options).
    const clone = labels[0]?.cloneNode(true) as HTMLElement;
    for (const control of clone.querySelectorAll("input, select, textarea, button"))
      control.remove();
    return normalizeText(clone.textContent) || null;
  }
  if (role === "img") return normalizeText(element.getAttribute("alt")) || null;
  if (!NAME_FROM_CONTENT.has(role)) return null;
  // Images, icons and hidden parts contribute to the name in ways we do not model.
  if (element.querySelector("img, svg, [aria-label], [aria-hidden], [hidden], input, select"))
    return null;
  return normalizeText(element.textContent) || null;
}

/** Text an exact text locator would match: the element's own short, single-block text. */
export function ownText(element: Element): string | null {
  if (element.children.length > 3) return null;
  if (element.querySelector("script, style, input, select, textarea, br")) return null;
  const text = normalizeText(element.textContent);
  return text.length > 0 && text.length <= 80 ? text : null;
}

const SENSITIVE_NAME = /passw(or)?d|pwd|cvv|cvc|card.?num|security.?code|\botp\b|one.?time/i;
const everSensitive = new WeakSet<Element>();

/**
 * Inputs whose values must never be read: passwords, payment card fields and
 * one-time codes. Once a field was sensitive it stays so, which covers
 * "show password" toggles that switch the input to type=text.
 */
export function isSensitive(element: Element | null): boolean {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
    return false;
  if (everSensitive.has(element)) return true;
  const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
  const sensitive =
    (element instanceof HTMLInputElement && element.type === "password") ||
    autocomplete.includes("password") ||
    autocomplete.split(/\s+/).some((token) => token.startsWith("cc-")) ||
    autocomplete.includes("one-time-code") ||
    SENSITIVE_NAME.test(`${element.name} ${element.id}`);
  if (sensitive) everSensitive.add(element);
  return sensitive;
}

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
  "",
]);

/** Elements the user types text into. */
export function isTextEntry(
  element: Element | null,
): element is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement)
    return TEXT_INPUT_TYPES.has(element.type) || element.type === "password";
  return element instanceof HTMLElement && element.isContentEditable;
}
