import { CORE_FIELD_NAMES, type Locator } from "@jobtrace/core";
import { buildLocator } from "@jobtrace/runner";
import { type RunningTestSites, SITES, startTestSites } from "@jobtrace/test-sites";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { injectedScript } from "./bundle.ts";
import { looksGenerated } from "./injected/dom.ts";
import {
  API_NAME,
  FIELD_NAME_CHOICES,
  type GeneratePurpose,
  type RecorderApi,
  type WireTarget,
} from "./injected/protocol.ts";

type ApiWindow = Record<string, RecorderApi>;

let browser: Browser;
let page: Page;
let sites: RunningTestSites;

beforeAll(async () => {
  sites = await startTestSites();
  browser = await chromium.launch();
  const context = await browser.newContext();
  // No bridge is exposed, so the script only provides its API: no overlay, no capture.
  await context.addInitScript({ content: await injectedScript() });
  page = await context.newPage();
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
});

async function setHtml(html: string) {
  await page.goto(sites.url("/robots.txt"));
  await page.setContent(html);
}

interface Generated {
  key: string;
  tag: string;
  target: WireTarget;
}

/** Generates targets in the page for every element matching `selector`. */
function generate(selector: string, purpose: GeneratePurpose): Promise<Generated[]> {
  return page.evaluate(
    ([api, css, kind]) => {
      const recorder = (window as unknown as ApiWindow)[api as string] as RecorderApi;
      const all: Element[] = [];
      const collect = (root: Document | ShadowRoot) => {
        all.push(...root.querySelectorAll(css as string));
        for (const element of root.querySelectorAll("*"))
          if (element.shadowRoot) collect(element.shadowRoot);
      };
      collect(document);
      return all.map((element) => ({
        key: recorder.register(element).key,
        tag: element.localName,
        target: recorder.generateTarget(element, kind as GeneratePurpose),
      }));
    },
    [API_NAME, selector, purpose] as const,
  );
}

async function one(selector: string, purpose: GeneratePurpose = "action"): Promise<Locator[]> {
  const generated = await generate(selector, purpose);
  expect(generated).toHaveLength(1);
  return (generated[0] as Generated).target.locators;
}

/** Resolves a locator with the real Playwright engine and checks it is exactly the element. */
async function resolvesTo(locator: Locator, key: string): Promise<boolean> {
  const found = buildLocator(page, locator);
  if ((await found.count()) !== 1) return false;
  return found.evaluate(
    (element, [api, id]) =>
      (window as unknown as ApiWindow)[api as string]?.isElement(id as string, element) === true,
    [API_NAME, key] as const,
  );
}

async function expectAllResolve(selector: string, purpose: GeneratePurpose) {
  const generated = await generate(selector, purpose);
  expect(generated.length).toBeGreaterThan(5);
  const problems: string[] = [];
  for (const { key, tag, target } of generated) {
    if (target.locators.length === 0) problems.push(`<${tag}> got no locators`);
    for (const locator of target.locators) {
      if (!(await resolvesTo(locator, key))) problems.push(`<${tag}> ${JSON.stringify(locator)}`);
    }
  }
  expect(problems).toEqual([]);
}

describe("every generated locator resolves to exactly its element", () => {
  const pages = {
    "static list": SITES.staticList,
    "paginated list": SITES.paginated,
    "detail page": `${SITES.detail}jobs/103`,
    "list with generated class names": SITES.detailV2,
    "sign-in form": `${SITES.login}signin`,
  };
  for (const [name, path] of Object.entries(pages)) {
    it.each(["action", "field"] as const)(`${name} (%s targets)`, async (purpose) => {
      await page.goto(sites.url(path));
      await expectAllResolve("body *", purpose);
    });
  }

  it("inside open shadow roots, without XPath", async () => {
    await setHtml(`<main><job-card></job-card><job-card></job-card></main>
      <script>
        for (const [index, card] of [...document.querySelectorAll("job-card")].entries()) {
          const root = card.attachShadow({ mode: "open" });
          root.innerHTML = '<h3 class="name">Engineer ' + index + '</h3><button class="apply">Apply ' + index + '</button>';
        }
      </script>`);
    const generated = await generate("h3, button", "action");
    expect(generated).toHaveLength(4);
    for (const { key, target } of generated) {
      expect(target.locators.length).toBeGreaterThan(0);
      expect(target.locators.some((locator) => locator.kind === "xpath")).toBe(false);
      for (const locator of target.locators) expect(await resolvesTo(locator, key)).toBe(true);
    }
  });
});

describe("ranking", () => {
  it("puts test ids first, then role and name, then attributes, text, CSS, XPath", async () => {
    await setHtml(`<main><form>
      <button type="button" data-testid="apply-now" name="apply" class="btn primary">Apply now</button>
      <button type="button" class="btn">Save for later</button>
    </form></main>`);
    expect(await one('[data-testid="apply-now"]')).toEqual([
      { kind: "testId", value: "apply-now" },
      { kind: "role", role: "button", name: "Apply now", exact: true },
      { kind: "css", value: 'button[name="apply"]' },
      { kind: "text", value: "Apply now", exact: true },
      { kind: "css", value: "button.btn.primary" },
      { kind: "xpath", value: "/html/body/main/form/button[1]" },
    ]);
  });

  it("uses other test-id attributes as high-ranked CSS", async () => {
    await setHtml(`<a href="/a" data-qa="next-link">Next</a><a href="/b">Previous</a>`);
    expect((await one("[data-qa]"))[0]).toEqual({ kind: "css", value: '[data-qa="next-link"]' });
  });

  it("names inputs by their label", async () => {
    await setHtml(`<label for="kw">Keywords</label><input id="kw" name="q" type="search">
      <label>Location <input name="loc"></label>`);
    expect(await one("#kw")).toEqual(
      expect.arrayContaining([
        { kind: "role", role: "searchbox", name: "Keywords", exact: true },
        { kind: "css", value: "#kw" },
        { kind: "css", value: 'input[name="q"]' },
      ]),
    );
    expect((await one('[name="loc"]'))[0]).toEqual({
      kind: "role",
      role: "textbox",
      name: "Location",
      exact: true,
    });
  });

  it("skips a role locator when the name is ambiguous or not plainly computable", async () => {
    await setHtml(`<a href="/1">Apply</a><a href="/2">Apply</a><button><svg></svg>Menu</button>`);
    const kinds = async (selector: string) => (await one(selector)).map((locator) => locator.kind);
    expect(await kinds('a[href="/1"]')).not.toContain("role");
    expect(await kinds('a[href="/1"]')).not.toContain("text");
    expect(await kinds("button")).not.toContain("role");
  });

  it("avoids generated class names and ids", async () => {
    await setHtml(`<div id="ember1234" class="css-1q8x7fz"><span class="sc-bdVaJa card__title title__3xK2a job-title">Data Engineer</span>
      <span class="css-9d2kq0">Berlin</span></div>`);
    const locators = [...(await one(".job-title")), ...(await one(".css-9d2kq0"))];
    const css = locators
      .filter((locator) => locator.kind !== "role")
      .map((locator) => ("value" in locator ? locator.value : ""));
    expect(css.join(" ")).not.toMatch(/css-|sc-|ember|3xK2a/);
    expect(css).toContain("span.card__title.job-title");
  });

  it("falls back to position only when nothing else tells siblings apart", async () => {
    await setHtml(`<ul class="jobs"><li class="job"><a class="title" href="/1">A</a></li>
      <li class="job"><a class="title" href="/2">B</a></li><li class="job featured"><a class="title" href="/3">C</a></li></ul>`);
    const cssOf = async (selector: string) =>
      (await one(selector, "field"))
        .filter((locator) => locator.kind === "css")
        .map((locator) => locator.value);
    expect(await cssOf('a[href="/2"]')).toEqual(["li.job:nth-of-type(2) > a.title"]);
    expect(await cssOf('a[href="/3"]')).toEqual(["li.job.featured > a.title"]);
  });

  it("never ties a field target to the text it is meant to extract", async () => {
    await setHtml(`<main><h1 class="job-title">Senior Backend Engineer</h1>
      <a class="apply" href="/apply/123">Apply for Senior Backend Engineer</a>
      <article class="body"><p>We are hiring.</p></article></main>`);
    const heading = await one("h1", "field");
    expect(heading[0]).toEqual({ kind: "role", role: "heading", level: 1 });
    for (const selector of ["h1", "a", "article"]) {
      const locators = await one(selector, "field");
      expect(locators.some((locator) => locator.kind === "text")).toBe(false);
      expect(JSON.stringify(locators)).not.toMatch(/Senior|hiring|123/);
    }
    expect((await one("article", "field"))[0]).toEqual({ kind: "role", role: "article" });
  });

  it("records a fingerprint without form values", async () => {
    await setHtml(
      `<main id="app"><form class="search"><input class="kw" name="q" value="typed secret" placeholder="Search"></form></main>`,
    );
    const [generated] = await generate("input", "action");
    expect(generated?.target.fingerprint).toEqual({
      tag: "input",
      attrs: { class: "kw", name: "q", placeholder: "Search" },
      ancestorTrail: ["form.search", "main#app", "body", "html"],
    });
  });
});

describe("helpers", () => {
  it.each([
    ["css-1q8x7fz", true],
    ["sc-bdVaJa", true],
    ["title__3xK2a", true],
    ["ember1234", true],
    [":r1a:", true],
    ["a1b2c3", true],
    ["job-card-88213", true],
    ["title", false],
    ["job-card", false],
    ["card__title", false],
    ["btn--primary", false],
    ["col-md-6", false],
    ["h2", false],
    ["mt-4", false],
  ])("looksGenerated(%s) is %s", (token, expected) => {
    expect(looksGenerated(token)).toBe(expected);
  });

  it("offers only core field names in the naming dialog", () => {
    for (const name of FIELD_NAME_CHOICES) expect(CORE_FIELD_NAMES).toContain(name);
  });
});
