import type { PageSnapshot } from "@jobtrace/core";

/**
 * Signs that a page is an anti-bot challenge rather than the site. JobTrace
 * detects these only in order to stop: it never tries to solve or get around them.
 */
export interface BotWallRules {
  /** Page titles of challenge interstitials. Sufficient on their own. */
  titles: RegExp[];
  /** Frames that show an active challenge (the puzzle itself). Sufficient on their own. */
  activeChallengeFrames: RegExp[];
  /**
   * Frames or scripts of CAPTCHA widgets. Ordinary pages embed these too (an
   * application form, a login box), so they only count on a page with little else on it.
   */
  widgetSources: RegExp[];
  /** Challenge wording. Also only counts on a page with little else on it. */
  phrases: RegExp[];
  /** A page with less visible text than this is "little else". */
  sparseTextLength: number;
}

export const DEFAULT_BOT_WALL_RULES: BotWallRules = {
  titles: [
    /^just a moment/i,
    /attention required/i,
    /^access denied/i,
    /pardon our interruption/i,
    /are you a (robot|human)/i,
    /security check(point)?$/i,
    /^verif(y|ying) (you are|that you('| a)re) (a )?human/i,
    /^robot check/i,
    /bot verification/i,
  ],
  activeChallengeFrames: [
    /\/recaptcha\/(api2|enterprise)\/bframe/i,
    /hcaptcha\.com\/.*challenge/i,
    /geo\.captcha-delivery\.com/i,
  ],
  widgetSources: [
    /(google\.com|recaptcha\.net)\/recaptcha\//i,
    /hcaptcha\.com/i,
    /challenges\.cloudflare\.com/i,
    /captcha-delivery\.com/i,
    /arkoselabs\.com|funcaptcha\.com/i,
    /px-captcha|perimeterx/i,
  ],
  phrases: [
    /verify (that )?you are (a )?human/i,
    /checking (if the site connection is secure|your browser)/i,
    /needs to review the security of your connection/i,
    /unusual traffic from your (computer )?network/i,
    /enable javascript and cookies to continue/i,
    /press (and|&) hold/i,
    /prove you('| a)re not a robot/i,
    /complete the security check/i,
  ],
  sparseTextLength: 1500,
};

export interface BotWallVerdict {
  /** What gave it away, for the run log. */
  signal: string;
}

/** Decides from a page snapshot whether the page is a bot wall. Returns null when it is not. */
export function detectBotWall(
  snapshot: PageSnapshot,
  rules: BotWallRules = DEFAULT_BOT_WALL_RULES,
): BotWallVerdict | null {
  const title = snapshot.title.trim();
  const titled = rules.titles.find((pattern) => pattern.test(title));
  if (titled) return { signal: `page title "${title}"` };

  const sources = [...snapshot.visibleFrameUrls, ...snapshot.challengeMarkers];
  const active = snapshot.visibleFrameUrls.find((url) =>
    rules.activeChallengeFrames.some((pattern) => pattern.test(url)),
  );
  if (active) return { signal: `an active CAPTCHA challenge (${new URL(active).hostname})` };

  if (snapshot.textLength >= rules.sparseTextLength) return null;
  const widget = sources.find((source) =>
    rules.widgetSources.some((pattern) => pattern.test(source)),
  );
  if (widget) return { signal: "a CAPTCHA on an otherwise empty page" };
  const phrase = rules.phrases.find((pattern) => pattern.test(snapshot.text));
  if (phrase) return { signal: `challenge wording (${phrase.exec(snapshot.text)?.[0]})` };
  return null;
}
