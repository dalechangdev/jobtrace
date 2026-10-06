import type { Locator } from "@jobtrace/core";
import { headingLevel, queryAllDeep, roleOf, stableClasses } from "./dom.ts";
import { cssFor, fingerprintOf, nthOfType, xpathFor } from "./locators.ts";
import type { GeneratePurpose, WireTarget } from "./protocol.ts";

const attr = (name: string, value: string) => `[${name}="${CSS.escape(value)}"]`;

function sameSet(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((element) => b.includes(element));
}

/** Siblings count as "the same kind of thing" when tag and styling agree. */
function similar(a: Element, b: Element): boolean {
  if (a.localName !== b.localName) return false;
  const classesA = stableClasses(a);
  const classesB = stableClasses(b);
  if (classesA.length === 0 || classesB.length === 0) {
    // Without stable classes to compare, fall back to shape: same child tags.
    const shape = (element: Element) =>
      [...element.children].map((child) => child.localName).join(",");
    return classesA.length === classesB.length && shape(a) === shape(b);
  }
  return classesA.some((name) => classesB.includes(name));
}

/**
 * Possible lists a clicked element could be an item of: for the element and
 * each ancestor, the siblings that look like it, then the look-alikes in
 * sibling groups across the page. Ordered from the narrowest to the widest;
 * only groups of two or more are kept.
 */
export function listCandidates(start: Element): Element[][] {
  const candidates: Element[][] = [];
  for (let node: Element | null = start; node?.parentElement; node = node.parentElement) {
    if (["body", "html"].includes(node.localName)) break;
    const current = node;
    const parent = node.parentElement;
    const group = [...parent.children].filter((sibling) => similar(current, sibling));
    if (group.length >= 2) candidates.push(group);
    // Boards often split one list into groups (per department, per location):
    // the same kind of item under the same kind of parent elsewhere on the page.
    const pattern = `${tagWithClasses(parent.localName, stableClasses(parent))} > ${tagWithClasses(node.localName, stableClasses(node))}`;
    const cousins = queryAllDeep(pattern).filter((other) => similar(current, other));
    if (cousins.length > Math.max(group.length, 1)) candidates.push(cousins);
  }
  // Small parts (a label, a tag) repeat as often as the cards containing them.
  // When real cards were found, do not offer their parts as lists at all.
  const cards = candidates.filter((group) => group.every(cardLike));
  return cards.length > 0 ? cards : candidates;
}

/** A job card or row has some structure; a lone badge or label repeated per card does not. */
function cardLike(element: Element): boolean {
  return element.querySelector("a[href]") !== null || element.querySelectorAll("*").length >= 3;
}

/** The candidate to propose first: the largest, and on equal size the outermost. */
export function bestCandidate(candidates: readonly Element[][]): number {
  let best = 0;
  for (const [index, group] of candidates.entries()) {
    if (group.length >= (candidates[best]?.length ?? 0)) best = index;
  }
  return best;
}

function commonClasses(items: readonly Element[]): string[] {
  const [first, ...rest] = items;
  if (!first) return [];
  return stableClasses(first).filter((name) => rest.every((item) => item.classList.contains(name)));
}

const tagWithClasses = (tag: string, classes: readonly string[]) =>
  tag +
  classes
    .slice(0, 2)
    .map((name) => `.${CSS.escape(name)}`)
    .join("");

/**
 * Locators that match every item of a list and nothing else. Unlike single
 * targets, a list target is accepted on replay with any number of matches, so a
 * too-broad locator would silently pick up wrong items: specific class-based
 * CSS therefore ranks above the bare role.
 */
export function generateListTarget(items: readonly Element[]): WireTarget {
  const first = items[0] as Element;
  const parent = first.parentElement as Element;
  const tag = first.localName;
  const exact = (selector: string) => sameSet(queryAllDeep(selector), items);
  const locators: Locator[] = [];

  const testId = first.getAttribute("data-testid");
  if (testId && exact(attr("data-testid", testId)))
    locators.push({ kind: "testId", value: testId });

  const item = tagWithClasses(tag, commonClasses(items));
  const specific: string[] = [];
  const structural: string[] = [];
  const add = (selector: string) => {
    if (!exact(selector)) return;
    (/[.#[]/.test(selector) ? specific : structural).push(selector);
  };
  add(item);
  let prefix = "";
  for (
    let node: Element | null = parent, depth = 0;
    node && depth < 3;
    node = node.parentElement, depth++
  ) {
    if (["body", "html"].includes(node.localName)) break;
    prefix = `${tagWithClasses(node.localName, stableClasses(node))} > ${prefix}`;
    add(prefix + item);
  }
  const parentCss = cssFor(parent);
  if (parentCss) add(`${parentCss} > ${tag}`);
  for (const selector of new Set(specific)) locators.push({ kind: "css", value: selector });

  const role = roleOf(first);
  if (role && items.every((element) => roleOf(element) === role)) {
    const sameRole = queryAllDeep("*").filter((element) => roleOf(element) === role);
    if (sameSet(sameRole, items)) locators.push({ kind: "role", role });
  }
  for (const selector of new Set(structural)) locators.push({ kind: "css", value: selector });

  const parentXpath = xpathFor(parent);
  const sameTag = [...parent.children].filter((child) => child.localName === tag);
  if (parentXpath && sameSet(sameTag, items))
    locators.push({ kind: "xpath", value: `${parentXpath}/${tag}` });

  return { locators, fingerprint: fingerprintOf(first) };
}

function xpathAll(expression: string, context: Node): Element[] {
  try {
    const result = document.evaluate(
      expression,
      context,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const found: Element[] = [];
    for (let index = 0; index < result.snapshotLength; index++) {
      const node = result.snapshotItem(index);
      if (node instanceof Element) found.push(node);
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * Finds a list's items again from its recorded locators, e.g. after the page
 * reloaded. Role locators cannot be evaluated here and are skipped.
 */
export function resolveItems(locators: readonly Locator[]): Element[] {
  for (const locator of locators) {
    let found: Element[] = [];
    if (locator.kind === "css") found = queryAllDeep(locator.value);
    else if (locator.kind === "testId") found = queryAllDeep(attr("data-testid", locator.value));
    else if (locator.kind === "xpath") found = xpathAll(locator.value, document);
    if (found.length > 0) return found;
  }
  return [];
}

/** How to count a relative locator's matches inside one item. */
type Probe = (item: Element) => Element[];

function relativeCss(element: Element, item: Element, positional: boolean): string | null {
  const parts: string[] = [];
  for (let node: Element | null = element; node && node !== item; node = node.parentElement) {
    let part = tagWithClasses(node.localName, stableClasses(node));
    if (positional && node.parentElement) {
      const twins = [...node.parentElement.children].filter((sibling) => sibling.matches(part));
      if (twins.length > 1) part += `:nth-of-type(${nthOfType(node)})`;
    }
    parts.unshift(part);
    const candidate = parts.join(" > ");
    const matches = item.querySelectorAll(`:scope ${candidate}`);
    if (matches.length === 1 && matches[0] === element) return candidate;
  }
  return null;
}

function relativeXpath(element: Element, item: Element): string | null {
  const parts: string[] = [];
  for (let node: Element | null = element; node && node !== item; node = node.parentElement) {
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || !node.parentElement) return null;
    const current = node;
    const twins = [...node.parentElement.children].filter(
      (sibling) => sibling.localName === current.localName,
    );
    parts.unshift(twins.length > 1 ? `${node.localName}[${nthOfType(node)}]` : node.localName);
  }
  return parts.length > 0 ? `./${parts.join("/")}` : null;
}

/**
 * Locators for an element relative to the list item containing it, so the same
 * step works for every item. Candidates that only work in the item that was
 * clicked (for example a locator leaning on that item's text) are dropped when
 * better ones exist.
 */
export function generateRelativeTarget(
  element: Element,
  item: Element,
  items: readonly Element[],
  purpose: GeneratePurpose,
): WireTarget {
  const candidates: Array<{ locator: Locator; probe: Probe }> = [];
  const add = (locator: Locator, probe: Probe) => {
    const here = probe(item);
    if (here.length === 1 && here[0] === element) candidates.push({ locator, probe });
  };
  const css =
    (selector: string): Probe =>
    (scope) => [...scope.querySelectorAll(`:scope ${selector}`)];

  const testId = element.getAttribute("data-testid");
  if (testId) add({ kind: "testId", value: testId }, css(attr("data-testid", testId)));

  const role = roleOf(element);
  if (role) {
    const level = role === "heading" ? headingLevel(element) : undefined;
    add({ kind: "role", role, ...(level === undefined ? {} : { level }) }, (scope) =>
      [...scope.querySelectorAll("*")].filter(
        (other) => roleOf(other) === role && (level === undefined || headingLevel(other) === level),
      ),
    );
  }
  if (purpose === "action") {
    for (const name of ["name", "aria-label", "title"]) {
      const value = element.getAttribute(name);
      if (value && value.length <= 60) {
        const selector = `${element.localName}${attr(name, value)}`;
        add({ kind: "css", value: selector }, css(selector));
      }
    }
  }
  for (const selector of new Set([
    relativeCss(element, item, false),
    relativeCss(element, item, true),
  ])) {
    if (selector) add({ kind: "css", value: selector }, css(selector));
  }
  const xpath = relativeXpath(element, item);
  if (xpath) add({ kind: "xpath", value: xpath }, (scope) => xpathAll(xpath, scope));

  const coverage = (probe: Probe) =>
    items.filter((other) => probe(other).length === 1).length / items.length;
  const general = candidates.filter(({ probe }) => coverage(probe) >= 0.6);
  const chosen = general.length > 0 ? general : candidates;
  return { locators: chosen.map(({ locator }) => locator), fingerprint: fingerprintOf(element) };
}
