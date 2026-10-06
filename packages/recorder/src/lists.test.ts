import type { Step } from "@jobtrace/core";
import {
  GROUPED_DEPARTMENTS,
  jobsFor,
  PAGINATED_PAGE_SIZE,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RecorderOptions, type RecordingSession, startRecording } from "./session.ts";
import { mark, markList, overlay, press, replay, setMode, stepOf } from "./testing.ts";

let sites: RunningTestSites;
let browser: Browser;

beforeAll(async () => {
  sites = await startTestSites();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
});

async function record(path: string, extra: Partial<RecorderOptions> = {}) {
  const session = await startRecording({
    url: sites.url(path),
    browser,
    headless: true,
    openShadow: true,
    ...extra,
  });
  // Fail fast, with a useful location, when a click cannot happen.
  session.context.setDefaultTimeout(4000);
  return session;
}

/** Compact outline of a step tree, e.g. `forEach[extract(title,url) openDetail[extract(description)]]`. */
function outline(steps: readonly Step[]): string {
  return steps
    .map((step) => {
      if (step.type === "extract")
        return `extract:${step.scope}(${step.fields.map((f) => f.name).join(",")})`;
      if (step.type === "openDetail") return `openDetail:${step.strategy}[${outline(step.body)}]`;
      if (step.type === "paginate") return `paginate:${step.mode}[${outline(step.body)}]`;
      if ("body" in step) return `${step.type}[${outline(step.body)}]`;
      return step.type;
    })
    .join(" ");
}

/** Open detail on an item, wait for the detail page, and let the caller mark fields there. */
async function openDetail(
  session: RecordingSession,
  clickLink: () => Promise<void>,
  ready: string,
) {
  await press(session, "detail");
  await expect.poll(() => session.status().mode).toBe("openDetail");
  await clickLink();
  await expect.poll(() => session.status()).toMatchObject({ scope: "detail", mode: "markField" });
  await session.page.locator(ready).waitFor();
}

async function backToList(session: RecordingSession, listPath: string) {
  await press(session, "finish");
  await expect.poll(() => session.status()).toMatchObject({ scope: "list", mode: "markField" });
  expect(session.page.url()).toBe(sites.url(listPath));
}

describe("record lists, then replay", () => {
  it("site 4: a list with detail pages", async () => {
    const session = await record(SITES.detail);
    const { page } = session;
    const first = page.locator("li.job").first();
    await markList(session, () => first.locator(".loc").click(), 8);
    await mark(session, () => first.locator("a.title").click(), "title");
    await mark(session, () => first.locator("a.title").click(), "url", "href");
    await mark(session, () => page.locator("li.job").nth(3).locator(".loc").click(), "location");

    await openDetail(session, () => first.locator("a.title").click(), ".job-body");
    await mark(session, () => page.locator(".job-body").click(), "description");
    await mark(session, () => page.locator("dd.salary").click(), "salaryText");
    await backToList(session, SITES.detail);
    await mark(session, () => first.locator(".type").click(), "employmentType");
    await press(session, "finish");
    await expect.poll(() => session.status()).toMatchObject({ scope: "none", mode: "record" });
    const { recording, samples, warnings } = await session.stop();

    expect(warnings).toEqual([]);
    expect(outline(recording.steps)).toBe(
      "navigate forEach[extract:item(title,url,location) openDetail:newTab[extract:page(description,salaryText)] extract:item(employmentType)]",
    );
    const loop = stepOf(recording.steps, "forEach");
    expect(loop?.items.locators[0]).toEqual({ kind: "css", value: "li.job" });
    const titleField = stepOf(loop?.body ?? [], "extract")?.fields[0];
    expect(titleField?.target).toMatchObject({ relativeTo: "item", frame: [] });
    expect(titleField?.target.locators).toEqual([
      { kind: "role", role: "link" },
      { kind: "css", value: "a.title" },
      { kind: "xpath", value: "./a" },
    ]);
    // The location was marked on the fourth item; its sample comes from there.
    const expected = jobsFor("detail");
    expect(samples).toMatchObject({ title: expected[0]?.title, location: expected[3]?.location });

    const result = await replay(recording, browser);
    expect(result).toMatchObject({ status: "succeeded", stats: { itemsSeen: 8, itemErrors: 0 } });
    expect(result.events.filter((event) => event.type === "locator_drift")).toEqual([]);
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.jobs.map((job) => job.location)).toEqual(expected.map((job) => job.location));
    expect(result.jobs.map((job) => job.employmentType)).toEqual(
      expected.map((job) => job.employmentType),
    );
    expect(result.jobs.map((job) => job.description)).toEqual(
      expected.map((job) => job.description),
    );
    expect(result.jobs.map((job) => job.salaryText)).toEqual(expected.map((job) => job.salary));
    expect(result.jobs.map((job) => job.url)).toEqual(
      expected.map((job) => sites.url(`${SITES.detail}jobs/${job.id}`)),
    );
  });

  it("site 2: pagination with a Next button, plus detail pages", async () => {
    const session = await record(SITES.paginated);
    const { page } = session;
    const first = page.locator("li.job").first();
    await markList(session, () => first.locator("a.title").click(), PAGINATED_PAGE_SIZE);
    await mark(session, () => first.locator("a.title").click(), "title");
    await mark(session, () => first.locator("a.title").click(), "url", "href");
    await openDetail(session, () => first.locator("a.title").click(), ".job-body");
    await mark(session, () => page.locator(".job-body").click(), "description");
    await backToList(session, SITES.paginated);

    await press(session, "next");
    await expect.poll(() => session.status().mode).toBe("markNext");
    await page.locator("button.next").click();
    await expect.poll(() => session.status().mode).toBe("markField");
    // Marking the control must not have followed it.
    expect(page.url()).toBe(sites.url(SITES.paginated));
    const { recording } = await session.stop();

    expect(outline(recording.steps)).toBe(
      "navigate paginate:nextButton[forEach[extract:item(title,url) openDetail:newTab[extract:page(description)]]]",
    );
    expect(stepOf(recording.steps, "paginate")).toMatchObject({
      until: "nextMissingOrDisabled",
      next: {
        locators: expect.arrayContaining([
          { kind: "role", role: "button", name: "Next", exact: true },
        ]),
      },
    });

    const expected = jobsFor("paginated");
    const result = await replay(recording, browser);
    expect(result).toMatchObject({
      status: "succeeded",
      stats: { pages: 3, itemsSeen: expected.length },
    });
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.jobs.map((job) => job.description)).toEqual(
      expected.map((job) => job.description),
    );
  });

  it("site 3: infinite scroll", async () => {
    const session = await record(SITES.infinite);
    const { page } = session;
    const first = page.locator("li.job").first();
    await first.waitFor();
    const visible = await page.locator("li.job").count();
    await markList(session, () => first.locator(".loc").click(), visible);
    await mark(session, () => first.locator("a.title").click(), "title");
    await mark(session, () => first.locator(".loc").click(), "location");
    await press(session, "scroll");
    const { recording } = await session.stop();

    expect(outline(recording.steps)).toBe(
      "navigate paginate:infiniteScroll[forEach[extract:item(title,location)]]",
    );
    const expected = jobsFor("infinite");
    expect(visible).toBeLessThan(expected.length);
    const result = await replay(recording, browser);
    expect(result.status).toBe("succeeded");
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.jobs.map((job) => job.location)).toEqual(expected.map((job) => job.location));
  });

  it("site 7: a list inside an iframe, with detail pages that replace the whole page", async () => {
    const session = await record(SITES.iframe);
    const board = () => session.page.frameLocator("#job-board");
    await board().locator("li.job").first().waitFor();
    await markList(session, () => board().locator("li.job").first().locator(".type").click(), 7);
    await mark(session, () => board().locator("li.job a.title").first().click(), "title");

    await openDetail(session, () => board().locator("li.job a.title").first().click(), ".job-body");
    await mark(session, () => session.page.locator(".job-body").click(), "description");
    await backToList(session, SITES.iframe);
    // The iframe was reloaded on the way back; marking inside it must still work.
    await board().locator("li.job").first().waitFor();
    await mark(session, () => board().locator("li.job .salary").nth(1).click(), "salaryText");
    const { recording } = await session.stop();

    expect(outline(recording.steps)).toBe(
      "navigate forEach[extract:item(title) openDetail:newTab[extract:page(description)] extract:item(salaryText)]",
    );
    expect(stepOf(recording.steps, "forEach")?.items.frame).toEqual(["#job-board"]);

    const expected = jobsFor("iframe");
    const result = await replay(recording, browser);
    expect(result).toMatchObject({ status: "succeeded", stats: { itemsSeen: 7, itemErrors: 0 } });
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.jobs.map((job) => job.salaryText)).toEqual(expected.map((job) => job.salary));
    expect(result.jobs.map((job) => job.description)).toEqual(
      expected.map((job) => job.description),
    );
  });

  it("site 5: detail pages in a single-page app", async () => {
    const session = await record(SITES.spa);
    const { page } = session;
    const first = page.locator("li.job").first();
    await first.waitFor();
    await markList(session, () => first.locator(".loc").click(), 6);
    await mark(session, () => first.locator("a.title").click(), "title");
    await openDetail(session, () => first.locator("a.title").click(), ".job-body");
    await mark(session, () => page.locator(".job-body").click(), "description");
    await backToList(session, SITES.spa);
    const { recording } = await session.stop();

    expect(outline(recording.steps)).toBe(
      "navigate forEach[extract:item(title) openDetail:newTab[extract:page(description)]]",
    );
    const expected = jobsFor("spa");
    const result = await replay(recording, browser);
    expect(result.status).toBe("succeeded");
    expect(result.jobs.map((job) => job.description)).toEqual(
      expected.map((job) => job.description),
    );
  });

  it("a detail link that opens its own tab", async () => {
    const session = await record(`${SITES.detail}?newtab=1`);
    const listPage = session.page;
    const first = listPage.locator("li.job").first();
    await markList(session, () => first.locator(".loc").click(), 8);
    await mark(session, () => first.locator("a.title").click(), "title");
    const popupOpened = session.context.waitForEvent("page");
    await press(session, "detail");
    await expect.poll(() => session.status().mode).toBe("openDetail");
    await first.locator("a.title").click();
    const popup = await popupOpened;
    await popup.locator(".job-body").waitFor();
    await expect.poll(() => session.page === popup).toBe(true);
    await mark(session, () => popup.locator(".job-body").click(), "description");
    await press(session, "finish");
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect.poll(() => session.status().scope).toBe("list");
    expect(session.page).toBe(listPage);
    const { recording, warnings } = await session.stop();

    expect(warnings).toEqual([]);
    expect(outline(recording.steps)).toBe(
      "navigate forEach[extract:item(title) openDetail:newTab[extract:page(description)]]",
    );
    const result = await replay(recording, browser, { settings: { maxItems: 3 } });
    expect(result.jobs.map((job) => job.description)).toEqual(
      jobsFor("detail")
        .slice(0, 3)
        .map((job) => job.description),
    );
  });
});

describe("list detection", () => {
  it("finds a list split into groups, and can be narrowed or widened", async () => {
    const session = await record(SITES.grouped);
    const { page } = session;
    const count = () => overlay(page).locator('[data-role="list-count"]').textContent();
    const total = GROUPED_DEPARTMENTS.reduce((sum, department) => sum + department.jobs.length, 0);
    await press(session, "list");
    await page.locator("li.job .loc").first().click();
    await expect.poll(count).toBe(`Found ${total} similar items`);
    await press(session, "list-narrower");
    await expect.poll(count).toBe(`Found ${GROUPED_DEPARTMENTS[0]?.jobs.length} similar items`);
    expect(await overlay(page).locator('[data-action="list-narrower"]').isDisabled()).toBe(true);
    await press(session, "list-wider");
    await press(session, "list-wider");
    await expect.poll(count).toBe(`Found ${GROUPED_DEPARTMENTS.length} similar items`);
    await press(session, "list-narrower");
    await expect.poll(count).toBe(`Found ${total} similar items`);
    await press(session, "list-use");
    await expect
      .poll(() => session.status())
      .toMatchObject({ scope: "list", list: { count: total } });
    await mark(session, () => page.locator("li.job a.title").nth(5).click(), "title");
    const { recording } = await session.stop();

    expect(stepOf(recording.steps, "forEach")?.items.locators[0]).toEqual({
      kind: "css",
      value: "li.job",
    });
    const result = await replay(recording, browser);
    expect(result.jobs.map((job) => job.title)).toEqual(
      GROUPED_DEPARTMENTS.flatMap((department) => department.jobs.map((job) => job.title)),
    );
  });

  it("can be cancelled, and reports when nothing similar is around", async () => {
    const session = await record(SITES.staticList);
    const { page } = session;
    const toast = () => overlay(page).locator(".toast").textContent();
    await press(session, "list");
    await page.locator("h1").click();
    await expect.poll(toast).toMatch(/Nothing similar/);
    await page.locator("li.job .loc").first().click();
    await overlay(page).locator('[data-role="list-dialog"].open').waitFor();
    await press(session, "list-cancel");
    expect(session.status()).toMatchObject({ scope: "none", mode: "markList" });
    const { recording } = await session.stop();
    expect(outline(recording.steps)).toBe("navigate");
  });
});

describe("scopes", () => {
  it("only accepts fields inside the list's items while a list is open", async () => {
    const session = await record(SITES.staticList);
    const { page } = session;
    await markList(session, () => page.locator("li.job .loc").first().click(), 8);
    await page.locator("h1").click();
    await expect
      .poll(() => overlay(page).locator(".toast").textContent())
      .toMatch(/inside one of the list's items/);
    expect(await overlay(page).locator(".dialog.open").count()).toBe(0);
    await press(session, "finish");
    await expect.poll(() => session.status().scope).toBe("none");
    await setMode(session, "mark");
    await mark(session, () => page.locator("header strong").click(), "company");
    const { recording } = await session.stop();
    expect(outline(recording.steps)).toBe("navigate forEach[] extract:page(company)");
  });

  it("runs actions made outside the items once, before the list", async () => {
    const session = await record(SITES.staticList);
    const { page } = session;
    await markList(session, () => page.locator("li.job .loc").first().click(), 8);
    await mark(session, () => page.locator("li.job .title").first().click(), "title");
    await setMode(session, "record");
    await page.locator('input[name="q"]').pressSequentially("designer");
    await page.locator('input[name="q"]').press("Enter");
    await page.waitForURL("**q=designer**");
    const { recording } = await session.stop();

    expect(outline(recording.steps)).toBe(
      "navigate fill press waitFor forEach[extract:item(title)]",
    );
    const result = await replay(recording, browser);
    expect(result.jobs.map((job) => job.title)).toEqual(["Product Designer"]);
  });

  it("offers only the controls that apply to the current scope", async () => {
    const session = await record(SITES.detail);
    const { page } = session;
    const visible = async () => {
      const actions = ["list", "detail", "next", "scroll", "finish"];
      const shown: string[] = [];
      for (const action of actions) {
        if (await overlay(page).locator(`[data-action="${action}"]`).isVisible())
          shown.push(action);
      }
      return shown.join(",");
    };
    expect(await visible()).toBe("list");
    await markList(session, () => page.locator("li.job .loc").first().click(), 8);
    await expect.poll(visible).toBe("detail,next,scroll,finish");
    await openDetail(session, () => page.locator("li.job a.title").first().click(), ".job-body");
    await expect.poll(visible).toBe("finish");
    await backToList(session, SITES.detail);
    await press(session, "finish");
    await expect.poll(visible).toBe("list,next,scroll");
    await session.stop();
  });
});
