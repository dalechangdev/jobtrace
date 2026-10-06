import { JobTraceError, type PageSnapshot } from "@jobtrace/core";
import { detectBotWall } from "@jobtrace/politeness";
import type { Page } from "playwright";
import { captureFailure } from "./artifacts.ts";
import { emit, type RunState } from "./state.ts";

/**
 * Politeness guards of a run: robots.txt, bot walls and refusals. They only
 * ever stop the run; nothing here retries around a refusal or hides the browser.
 */

/** Throws ROBOTS_DISALLOWED when the recording respects robots.txt and it disallows `url`. */
export async function checkRobots(state: RunState, url: string, stepId?: string): Promise<void> {
  const robots = state.options.robots;
  if (!robots || !state.settings.respectRobotsTxt) return;
  const verdict = await robots.check(url);
  if (!verdict.allowed) {
    throw new JobTraceError(
      "ROBOTS_DISALLOWED",
      `${verdict.reason ?? `robots.txt disallows ${url}`}. To run anyway, set respectRobotsTxt to false in the recording's settings.`,
      { ...(stepId ? { stepId } : {}), details: { url } },
    );
  }
  // A site may ask for a minimum pause between requests; never go faster than that.
  const wanted = Math.min(verdict.crawlDelayMs ?? 0, state.tuning.maxCrawlDelayMs);
  if (wanted > state.settings.minDelayMs) {
    emit(
      state,
      "info",
      "crawl_delay",
      `robots.txt asks for ${wanted / 1000}s between requests; slowing down`,
      {
        data: { crawlDelayMs: wanted },
      },
    );
    state.settings = {
      ...state.settings,
      minDelayMs: wanted,
      maxDelayMs: Math.max(state.settings.maxDelayMs, wanted),
    };
  }
}

/** What bot-wall detection needs to know about a page. */
export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width >= 30 &&
        box.height >= 30 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const widgets: Array<[string, string]> = [
      [".cf-turnstile, #challenge-form, #cf-challenge-running", "challenges.cloudflare.com"],
      [".h-captcha", "hcaptcha.com"],
      [".g-recaptcha", "google.com/recaptcha/"],
      ["#px-captcha", "px-captcha"],
    ];
    return {
      url: location.href,
      title: document.title,
      text: text.slice(0, 4000),
      textLength: text.length,
      visibleFrameUrls: [...document.querySelectorAll("iframe")]
        .filter(visible)
        .map((frame) => frame.src)
        .filter(Boolean),
      challengeMarkers: [
        ...[...document.scripts]
          .map((script) => script.src)
          .filter((src) => /captcha|challenge|turnstile/i.test(src)),
        ...widgets
          .filter(([selector]) => document.querySelector(selector))
          .map(([, source]) => source),
      ].slice(0, 30),
    };
  });
}

/** BOT_WALL when the page is an anti-bot challenge, otherwise null. Never throws. */
export async function botWallOn(
  state: RunState,
  page: Page,
  stepId?: string,
): Promise<JobTraceError | null> {
  try {
    if (page.isClosed()) return null;
    const verdict = detectBotWall(await snapshotPage(page));
    if (!verdict) return null;
    const error = new JobTraceError(
      "BOT_WALL",
      `The site is showing an anti-bot check (${verdict.signal}). JobTrace stops here and does not try to get past it.`,
      { ...(stepId ? { stepId } : {}), details: { url: page.url(), signal: verdict.signal } },
    );
    // The screenshot is taken right away, while the challenge is on screen.
    state.captured.add(error);
    await captureFailure(state, page, stepId ?? "blocked");
    return error;
  } catch {
    return null;
  }
}

export function refusal(status: number, url: string, stepId?: string): JobTraceError {
  return new JobTraceError(
    "BOT_WALL",
    `${url} refused the request (HTTP ${status}). JobTrace stops here rather than retry against the site's wishes.`,
    { ...(stepId ? { stepId } : {}), details: { url, status } },
  );
}

/**
 * Watches a page for trouble caused by the page's own navigations (a click, a
 * redirect), which no step gets to inspect: refusals, disallowed URLs, bot walls.
 */
export function watchPage(state: RunState, page: Page): void {
  const stop = (error: JobTraceError) => {
    state.guard.fatal ??= error;
  };
  const ownNavigation = () => state.navigating.has(page);

  page.on("response", (response) => {
    if (ownNavigation() || state.guard.fatal) return;
    const request = response.request();
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    const status = response.status();
    if (status !== 403 && status !== 429) return;
    const error = refusal(status, response.url());
    state.captured.add(error);
    stop(error);
    state.guard.pending.push(captureFailure(state, page, "blocked"));
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame() || ownNavigation() || state.guard.fatal) return;
    checkRobots(state, frame.url()).catch((error: unknown) => {
      if (error instanceof JobTraceError) stop(error);
    });
  });
  page.on("load", () => {
    if (ownNavigation() || state.guard.fatal) return;
    state.guard.pending.push(
      botWallOn(state, page).then((error) => {
        if (error) stop(error);
      }),
    );
  });
}
