import type { Fingerprint, Locator } from "@jobtrace/core";
import {
  accessibleName,
  allElementsDeep,
  headingLevel,
  inShadowRoot,
  normalizeText,
  ownText,
  queryAllDeep,
  roleOf,
  stableClasses,
  stableId,
} from "./dom.ts";
import type { GeneratePurpose, WireTarget } from "./protocol.ts";

const TEST_ID_ATTRIBUTES = [
  "data-test-id",
  "data-test",
  "data-qa",
  "data-cy",
  "data-automation-id",
];
const STABLE_ATTRIBUTES = ["name", "aria-label", "placeholder", "title", "for", "type"];
/** Roles that identify a region well enough without a name, for field targets. */
const NAMELESS_ROLES = new Set(["heading", "article", "main", "navigation", "table", "dialog"]);
const MAX_ATTRIBUTE_LENGTH = 60;

const attr = (name: string, value: string) => `[${name}="${CSS.escape(value)}"]`;

function isOnly(element: Element, matches: readonly Element[]): boolean {
  return matches.length === 1 && matches[0] === element;
}

const uniqueCss = (element: Element, selector: string) => isOnly(element, queryAllDeep(selector));

function testIdLocators(element: Element): Locator[] {
  const locators: Locator[] = [];
  const testId = element.getAttribute("data-testid");
  if (testId && uniqueCss(element, attr("data-testid", testId))) {
    locators.push({ kind: "testId", value: testId });
  }
  for (const name of TEST_ID_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value && uniqueCss(element, attr(name, value)))
      locators.push({ kind: "css", value: attr(name, value) });
  }
  return locators;
}

function roleLocator(element: Element, purpose: GeneratePurpose): Locator | null {
  const role = roleOf(element);
  if (!role) return null;
  const level = role === "heading" ? headingLevel(element) : undefined;
  const sameRole = allElementsDeep().filter(
    (other) => roleOf(other) === role && (level === undefined || headingLevel(other) === level),
  );
  const base = { kind: "role" as const, role, ...(level === undefined ? {} : { level }) };

  // A field's content changes from run to run, so its name must not be part of the locator.
  if (purpose === "field") {
    return NAMELESS_ROLES.has(role) && isOnly(element, sameRole) ? base : null;
  }
  const name = accessibleName(element, role);
  if (!name || name.length > 80) return null;
  // If any same-role element has a name we cannot compute, uniqueness is unknowable.
  const names = sameRole.map((other) => accessibleName(other, role));
  if (names.filter((other) => other === name).length !== 1) return null;
  return { ...base, name, exact: true };
}

function attributeLocators(element: Element): Locator[] {
  const locators: Locator[] = [];
  const id = stableId(element);
  if (id && uniqueCss(element, `#${CSS.escape(id)}`))
    locators.push({ kind: "css", value: `#${CSS.escape(id)}` });
  for (const name of STABLE_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (!value || value.length > MAX_ATTRIBUTE_LENGTH) continue;
    if (name === "type" && !element.hasAttribute("name")) continue;
    const selector = `${element.localName}${attr(name, value)}`;
    if (uniqueCss(element, selector)) {
      locators.push({ kind: "css", value: selector });
      break;
    }
  }
  return locators;
}

function textLocator(element: Element): Locator | null {
  const text = ownText(element);
  if (!text) return null;
  // Mirrors an exact text match: the innermost elements whose text equals the value.
  const matches = allElementsDeep().filter(
    (other) =>
      normalizeText(other.textContent) === text &&
      ![...other.children].some((child) => normalizeText(child.textContent) === text) &&
      !["script", "style", "title", "head", "html", "body", "option"].includes(other.localName),
  );
  return isOnly(element, matches) ? { kind: "text", value: text, exact: true } : null;
}

/** Tag plus stable classes, e.g. `a.title`; an id anchors the selector on its own. */
function compound(element: Element): { selector: string; anchored: boolean } {
  const id = stableId(element);
  if (id) return { selector: `#${CSS.escape(id)}`, anchored: true };
  const classes = stableClasses(element).slice(0, 2);
  return {
    selector: element.localName + classes.map((name) => `.${CSS.escape(name)}`).join(""),
    anchored: false,
  };
}

function nthOfType(element: Element): number {
  let index = 1;
  for (
    let sibling = element.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.localName === element.localName) index++;
  }
  return index;
}

/**
 * Shortest unique selector built from stable tags, classes and ids, walking up
 * the ancestors. `positional` adds :nth-of-type where siblings are otherwise
 * indistinguishable, which is the last resort.
 */
function cssPath(element: Element, positional: boolean): string | null {
  const parts: string[] = [];
  let node: Element | null = element;
  for (let depth = 0; node && depth < 8; depth++) {
    const { selector, anchored } = compound(node);
    let part = selector;
    const parent: Element | null = node.parentElement;
    if (positional && !anchored && parent) {
      const twins = [...parent.children].filter((sibling) => sibling.matches(selector));
      if (twins.length > 1) part += `:nth-of-type(${nthOfType(node)})`;
    }
    parts.unshift(part);
    const candidate = parts.join(" > ");
    if (uniqueCss(element, candidate)) return candidate;
    if (anchored || ["html", "body"].includes(node.localName)) break;
    node = parent;
  }
  return null;
}

export function cssFor(element: Element): string | null {
  const id = stableId(element);
  if (id && uniqueCss(element, `#${CSS.escape(id)}`)) return `#${CSS.escape(id)}`;
  return cssPath(element, false) ?? cssPath(element, true);
}

/** Structural XPath from the nearest stable id, or from the document root. */
function xpathFor(element: Element): string | null {
  if (inShadowRoot(element)) return null;
  const parts: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml") return null;
    const id = stableId(node);
    if (id && !id.includes('"') && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
      parts.unshift(`//*[@id="${id}"]`);
      return parts.join("/");
    }
    const twins = node.parentElement
      ? [...node.parentElement.children].filter((sibling) => sibling.localName === node?.localName)
      : [];
    parts.unshift(twins.length > 1 ? `${node.localName}[${nthOfType(node)}]` : node.localName);
  }
  return `/${parts.join("/")}`;
}

function fingerprintOf(element: Element): Fingerprint {
  const attrs: Record<string, string> = {};
  for (const name of [
    "class",
    "id",
    "name",
    "type",
    "role",
    "href",
    "aria-label",
    "data-testid",
    "placeholder",
  ]) {
    const value = element.getAttribute(name);
    if (value) attrs[name] = value.slice(0, 200);
  }
  const ancestorTrail: string[] = [];
  for (
    let node = element.parentElement;
    node && ancestorTrail.length < 5;
    node = node.parentElement
  ) {
    const id = stableId(node);
    ancestorTrail.push(
      id
        ? `${node.localName}#${id}`
        : [node.localName, ...stableClasses(node).slice(0, 2)].join("."),
    );
  }
  const text = normalizeText(element.textContent).slice(0, 200);
  return { tag: element.localName, ...(text ? { text } : {}), attrs, ancestorTrail };
}

/**
 * Generates ranked locators for an element, most stable first: test ids, ARIA
 * role and name, stable attributes, text, CSS, XPath. Every locator returned
 * was checked to match this element and nothing else.
 *
 * For `purpose: "field"` (data to extract) locators never depend on the
 * element's text, since that is exactly what changes between runs.
 */
export function generateTarget(element: Element, purpose: GeneratePurpose): WireTarget {
  const candidates: Array<Locator | null> = [
    ...testIdLocators(element),
    roleLocator(element, purpose),
    ...attributeLocators(element),
    purpose === "action" ? textLocator(element) : null,
  ];
  const stable = cssPath(element, false);
  const positional = stable ? null : cssPath(element, true);
  for (const selector of [stable, positional]) {
    if (selector) candidates.push({ kind: "css", value: selector });
  }
  const xpath = xpathFor(element);
  if (xpath) candidates.push({ kind: "xpath", value: xpath });

  const seen = new Set<string>();
  const locators = candidates.filter((candidate): candidate is Locator => {
    if (!candidate) return false;
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { locators, fingerprint: fingerprintOf(element) };
}
