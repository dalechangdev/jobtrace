import type { Field, Target } from "@jobtrace/core";
import { describe, expect, it } from "vitest";
import {
  globMatches,
  postProcess,
  type RawItem,
  type StepDraft,
  urlWaitPattern,
} from "./postprocess.ts";

const target = (css: string): Target => ({
  locators: [{ kind: "css", value: css }],
  frame: [],
  relativeTo: null,
});
let clock = 0;
const tick = () => {
  clock += 1000;
  return clock;
};
const step = (
  draft: StepDraft,
  extra: Partial<Extract<RawItem, { kind: "step" }>> = {},
): RawItem => ({
  kind: "step",
  step: draft,
  at: tick(),
  ...extra,
});
const field = (name: string, css = `.${name}`): RawItem => ({
  kind: "field",
  at: tick(),
  field: {
    name,
    target: target(css),
    read: "text",
    attr: null,
    transforms: ["trim"],
    required: false,
  } satisfies Field,
});
const navigate = (url: string, extra = {}) => step({ type: "navigate", url }, extra);
const click = (css: string, extra = {}) => step({ type: "click", target: target(css) }, extra);
const fill = (css: string, value: string, extra = {}) =>
  step({ type: "fill", target: target(css), value }, extra);
const summary = (items: RawItem[], navigations: Parameters<typeof postProcess>[1] = []) =>
  postProcess(items, navigations).map((result) =>
    result.type === "navigate"
      ? `navigate ${result.url}`
      : result.type === "fill"
        ? `fill ${result.value}`
        : result.type === "waitFor"
          ? `waitFor ${result.urlPattern}`
          : result.type === "press"
            ? `press ${result.key}`
            : result.type === "extract"
              ? `extract ${result.fields.map((f) => f.name).join(",")}`
              : result.type === "scroll"
                ? `scroll ${result.mode} ${result.amount ?? ""}`.trim()
                : result.type,
  );

describe("postProcess", () => {
  it("assigns sequential ids and keeps plain steps as they are", () => {
    const steps = postProcess([navigate("https://x.example/"), click("a")]);
    expect(steps.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("merges click-then-fill and repeated fills on the same element", () => {
    expect(
      summary([
        click("#q", { elementKey: "q" }),
        fill("#q", "eng", { elementKey: "q" }),
        fill("#q", "engineer", { elementKey: "q" }),
        click("#other", { elementKey: "other" }),
        fill("#loc", "Berlin", { elementKey: "loc" }),
      ]),
    ).toEqual(["fill engineer", "click", "fill Berlin"]);
  });

  it("drops Tab presses that only moved focus to the next field", () => {
    expect(
      summary([
        fill("#a", "1", { elementKey: "a" }),
        step({ type: "press", key: "Tab" }),
        fill("#b", "2", { elementKey: "b" }),
        step({ type: "press", key: "Tab" }),
        step({ type: "press", key: "Enter" }),
      ]),
    ).toEqual(["fill 1", "fill 2", "press Tab", "press Enter"]);
  });

  it("drops clicks on non-interactive elements that had no effect", () => {
    const items = [
      click("p", { interactive: false, mutated: false }),
      click("div.accordion", { interactive: false, mutated: true }),
      click("div.unknown", { interactive: false }),
      click("button", { interactive: true }),
    ];
    const effective = click("div.card", {
      interactive: false,
      mutated: false,
      urlBefore: "https://x.example/",
    });
    items.push(effective);
    // The last one changed nothing in the DOM but did navigate, so it stays.
    expect(summary(items, [{ url: "https://x.example/next", at: effective.at + 20 }])).toEqual([
      "click",
      "click",
      "click",
      "click",
      "waitFor **/next*",
    ]);
  });

  it("coalesces consecutive scrolls", () => {
    expect(
      summary([
        step({ type: "scroll", mode: "by", amount: 300 }),
        step({ type: "scroll", mode: "by", amount: 500 }),
        click("a"),
        step({ type: "scroll", mode: "by", amount: 200 }),
        step({ type: "scroll", mode: "toBottom" }),
      ]),
    ).toEqual(["scroll by 800", "click", "scroll toBottom"]);
  });

  it("groups consecutive fields into one extract and lets a re-mark replace a field", () => {
    const steps = postProcess([
      navigate("https://x.example/"),
      field("title", ".old"),
      field("location"),
      field("title", ".new"),
      click("a"),
      field("description"),
    ]);
    expect(
      summary([
        navigate("https://x.example/"),
        field("title"),
        field("location"),
        click("a"),
        field("description"),
      ]),
    ).toEqual([
      "navigate https://x.example/",
      "extract title,location",
      "click",
      "extract description",
    ]);
    const first = steps[1];
    expect(first?.type === "extract" && first.fields.map((f) => f.target.locators[0])).toEqual([
      { kind: "css", value: ".new" },
      { kind: "css", value: ".location" },
    ]);
  });

  it("adds a URL wait after an action that navigated, crediting the right action", () => {
    const start = navigate("https://x.example/jobs");
    const open = click("a.job", { urlBefore: "https://x.example/jobs" });
    const typing = fill("#q", "rust");
    const submit = step(
      { type: "press", key: "Enter" },
      { urlBefore: "https://x.example/jobs/4411" },
    );
    expect(
      summary(
        [start, open, typing, submit],
        [
          { url: "https://x.example/jobs/4411", at: open.at + 30 },
          { url: "https://x.example/search/rust?page=1", at: submit.at + 400 },
        ],
      ),
    ).toEqual([
      "navigate https://x.example/jobs",
      "click",
      "waitFor **/jobs/*",
      "fill rust",
      "press Enter",
      "waitFor **/search/*?*",
    ]);
  });

  it("does not add a wait the old URL already satisfies, or credit navigations to typed URLs", () => {
    const next = click("a.next", { urlBefore: "https://x.example/jobs?page=1" });
    const typed = navigate("https://x.example/other");
    expect(
      summary(
        [next, typed],
        [
          { url: "https://x.example/jobs?page=2", at: next.at + 10 },
          // A redirect right after the typed URL belongs to no action.
          { url: "https://x.example/other/home", at: typed.at + 10 },
        ],
      ),
    ).toEqual(["click", "navigate https://x.example/other"]);
  });

  it("credits a navigation to the click before it even when a typed URL follows at once", () => {
    const open = click("a.job", { urlBefore: "https://x.example/jobs" });
    const typed: RawItem = { ...navigate("https://x.example/other"), at: open.at + 30 };
    // A second click soon after the typed URL must not take the credit either.
    const second: RawItem = { ...click("button"), at: open.at + 31 };
    expect(
      summary([open, typed, second], [{ url: "https://x.example/jobs/9", at: open.at + 29 }]),
    ).toEqual(["click", "waitFor **/jobs/*", "navigate https://x.example/other", "click"]);
  });

  it("uses arrival order when a navigation and a typed URL share a timestamp", () => {
    const open = click("a.job", { urlBefore: "https://x.example/jobs" });
    const typed = (seq: number) =>
      step({ type: "navigate", url: "https://x.example/other" }, { at: open.at + 15, seq });
    const navigation = { url: "https://x.example/jobs/9", at: open.at + 15, seq: 1 };
    expect(summary([open, typed(2)], [navigation])).toContain("waitFor **/jobs/*");
    expect(summary([open, typed(0)], [navigation])).not.toContain("waitFor **/jobs/*");
  });

  it("ignores navigations that happened too long after the last action", () => {
    const item = click("a", { urlBefore: "https://x.example/" });
    expect(summary([item], [{ url: "https://x.example/late", at: item.at + 60_000 }])).toEqual([
      "click",
    ]);
  });

  it("orders items by time, so a late-arriving action still precedes its navigation", () => {
    const typed = navigate("https://x.example/b");
    const earlier: RawItem = { ...click("a"), at: typed.at - 500 };
    expect(summary([typed, earlier])).toEqual(["click", "navigate https://x.example/b"]);
  });

  it("replaces a click that opened a new tab with a navigation, and drops reloads", () => {
    expect(
      summary([
        navigate("https://x.example/jobs"),
        click("a[target=_blank]"),
        navigate("https://x.example/jobs/7", { replacesClick: true }),
        navigate("https://x.example/jobs/7"),
      ]),
    ).toEqual(["navigate https://x.example/jobs", "navigate https://x.example/jobs/7"]);
  });
});

describe("postProcess: lists, detail pages and pagination", () => {
  const itemTarget = (css: string): Target => ({ ...target(css), relativeTo: "item" });
  const itemField = (name: string): RawItem => {
    const item = field(name);
    return item.kind === "field"
      ? { ...item, field: { ...item.field, target: itemTarget(`.${name}`) } }
      : item;
  };
  const marker = (item: Record<string, unknown>) => ({ ...item, at: tick() }) as RawItem;
  const listStart = () => marker({ kind: "listStart", items: target("li.job") });
  const detailStart = () =>
    marker({ kind: "detailStart", link: itemTarget("a.title"), strategy: "newTab" });
  const scopeEnd = () => marker({ kind: "scopeEnd" });
  const nextPage = () => marker({ kind: "paginate", mode: "nextButton", next: target("a.next") });
  const infinite = () => marker({ kind: "paginate", mode: "infiniteScroll" });

  /** Outline of a step tree with ids, e.g. `s2:forEach[s3:extract:item(title)]`. */
  const tree = (steps: ReturnType<typeof postProcess>): string =>
    steps
      .map((result) => {
        const label =
          result.type === "extract"
            ? `extract:${result.scope}(${result.fields.map((f) => f.name).join(",")})`
            : result.type === "paginate"
              ? `paginate:${result.mode}`
              : result.type;
        return `${result.id}:${label}${"body" in result ? `[${tree(result.body)}]` : ""}`;
      })
      .join(" ");

  it("nests item fields, the detail page and later item fields, with ids in reading order", () => {
    const steps = postProcess([
      navigate("https://x.example/jobs"),
      listStart(),
      itemField("title"),
      itemField("location"),
      detailStart(),
      field("description"),
      click("button.more"),
      field("benefits"),
      scopeEnd(),
      itemField("salaryText"),
      scopeEnd(),
      field("company"),
    ]);
    expect(tree(steps)).toBe(
      "s1:navigate s2:forEach[s3:extract:item(title,location) s4:openDetail[s5:extract:page(description) s6:click s7:extract:page(benefits)] s8:extract:item(salaryText)] s9:extract:page(company)",
    );
  });

  it("wraps the list in pagination, whether marked inside the list or after it", () => {
    const inside = postProcess([listStart(), itemField("title"), nextPage()]);
    expect(tree(inside)).toBe("s1:paginate:nextButton[s2:forEach[s3:extract:item(title)]]");
    expect(inside[0]).toMatchObject({
      until: "nextMissingOrDisabled",
      next: { locators: [{ value: "a.next" }] },
    });

    const after = postProcess([listStart(), itemField("title"), scopeEnd(), infinite()]);
    expect(tree(after)).toBe("s1:paginate:infiniteScroll[s2:forEach[s3:extract:item(title)]]");
    expect(after[0]).toMatchObject({ until: "noNewItems" });
    expect(after[0]).not.toHaveProperty("next");
  });

  it("lets a later pagination choice replace an earlier one, and ignores one without a list", () => {
    expect(tree(postProcess([listStart(), nextPage(), infinite(), itemField("title")]))).toBe(
      "s1:paginate:infiniteScroll[s2:forEach[s3:extract:item(title)]]",
    );
    expect(tree(postProcess([navigate("https://x.example/"), nextPage()]))).toBe("s1:navigate");
  });

  it("runs page-level actions made while a list is open once, before the list", () => {
    const start = navigate("https://x.example/jobs");
    const list = listStart();
    const title = itemField("title");
    const search = fill("#q", "rust", { elementKey: "q" });
    const submit = step({ type: "press", key: "Enter" }, { urlBefore: "https://x.example/jobs" });
    const expand = step({ type: "click", target: itemTarget("button.expand") });
    const steps = postProcess(
      [start, list, title, search, submit, expand, nextPage()],
      [{ url: "https://x.example/jobs?q=rust", at: submit.at + 20 }],
    );
    expect(tree(steps)).toBe(
      "s1:navigate s2:fill s3:press s4:waitFor s5:paginate:nextButton[s6:forEach[s7:extract:item(title) s8:click]]",
    );
  });

  it("does not credit the navigation into or out of a detail page to an earlier action", () => {
    const filter = click("button.filter", { urlBefore: "https://x.example/jobs" });
    const list = listStart();
    const title = itemField("title");
    const open = detailStart();
    const description = field("description");
    const back = scopeEnd();
    const steps = postProcess(
      [filter, list, title, open, description, back],
      [
        { url: "https://x.example/jobs/7", at: open.at + 30 },
        { url: "https://x.example/jobs", at: back.at + 30 },
      ],
    );
    expect(tree(steps)).toBe(
      "s1:click s2:forEach[s3:extract:item(title) s4:openDetail[s5:extract:page(description)]]",
    );
  });

  it("closes scopes left open, and ignores stray markers", () => {
    expect(
      tree(
        postProcess([scopeEnd(), detailStart(), listStart(), detailStart(), field("description")]),
      ),
    ).toBe("s1:forEach[s2:openDetail[s3:extract:page(description)]]");
  });
});

describe("urlWaitPattern", () => {
  it.each([
    ["https://x.example/jobs", "**/jobs*"],
    ["https://x.example/jobs/", "**/jobs/*"],
    ["https://x.example/jobs/4411", "**/jobs/*"],
    ["https://x.example/jobs/6f1e2a9c-0b1d-4c3e-9f00-aa11bb22cc33/apply", "**/jobs/*/apply*"],
    ["https://x.example/search?q=rust&page=2", "**/search?*"],
    ["https://x.example/app#/jobs/5", "**/app#**"],
    ["https://x.example/a[1]/b", "**/*/b*"],
  ])("%s -> %s", (url, expected) => {
    expect(urlWaitPattern(url)).toBe(expected);
    expect(globMatches(expected, url)).toBe(true);
  });

  it("wildcards path segments the user typed", () => {
    expect(urlWaitPattern("https://x.example/search/rust%20dev/results", ["rust dev"])).toBe(
      "**/search/*/results*",
    );
  });

  it("returns null for unparseable URLs", () => {
    expect(urlWaitPattern("not a url")).toBeNull();
  });
});

describe("globMatches", () => {
  it("treats * as one path segment, ** as anything, and ? literally", () => {
    expect(globMatches("**/jobs/*", "https://x.example/jobs/12")).toBe(true);
    expect(globMatches("**/jobs/*", "https://x.example/jobs/12/apply")).toBe(false);
    expect(globMatches("**/search?*", "https://x.example/search?q=1")).toBe(true);
    expect(globMatches("**/search?*", "https://x.example/search")).toBe(false);
    expect(globMatches("**/a.b", "https://x.example/axb")).toBe(false);
  });
});
