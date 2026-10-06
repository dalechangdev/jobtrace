import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { JobTraceError } from "@jobtrace/core";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { injectedScript } from "./bundle.ts";
import { BRIDGE_NAME, CONFIG_NAME, type RecorderConfig } from "./injected/protocol.ts";
import { pageMessageSchema } from "./messages.ts";

export interface AuthCaptureOptions {
  /** The site's login page. */
  url: string;
  /** Where to write the session (cookies and local storage). Created with mode 0600. */
  statePath: string;
  /** A previously saved session to start from, when refreshing a profile. */
  existingState?: string;
  /** Run without a window. Only useful for automated tests. */
  headless?: boolean;
  /** Reuse a browser instead of launching one. It is left open. */
  browser?: Browser;
  /** Tests only: open the bar's shadow root so its buttons can be clicked by a script. */
  openShadow?: boolean;
  /** Aborting cancels the capture; nothing is saved. */
  signal?: AbortSignal;
}

export interface AuthCaptureResult {
  /** False when the user cancelled or closed the window. */
  saved: boolean;
  /** Host name of the page the user was on when saving. */
  domain: string;
}

export interface AuthCapture {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly finished: Promise<AuthCaptureResult>;
  /** Saves the session now, as the "Save login" button does. */
  save(): Promise<AuthCaptureResult>;
  cancel(): Promise<AuthCaptureResult>;
}

/**
 * Opens a browser on a login page and waits for the user to log in by hand and
 * press "Save login". Only the resulting browser session is stored: the page
 * gets no recorder at all, so credentials are never observed.
 */
export async function captureAuth(options: AuthCaptureOptions): Promise<AuthCapture> {
  const headless = options.headless ?? false;
  const browser = options.browser ?? (await chromium.launch({ headless }));
  const done = Promise.withResolvers<AuthCaptureResult>();
  done.promise.catch(() => {});
  let ending: Promise<AuthCaptureResult> | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  };

  function end(save: boolean): Promise<AuthCaptureResult> {
    ending ??= (async () => {
      const domain =
        hostOf(page && !page.isClosed() ? page.url() : options.url) || hostOf(options.url);
      try {
        if (save && context) {
          const state = await context.storageState();
          await mkdir(dirname(options.statePath), { recursive: true, mode: 0o700 });
          await writeFile(options.statePath, JSON.stringify(state), { mode: 0o600 });
          // writeFile's mode only applies to new files; a refreshed profile already exists.
          await chmod(options.statePath, 0o600);
        }
        return { saved: save, domain };
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
        await context?.close().catch(() => {});
        if (!options.browser) await browser.close().catch(() => {});
      }
    })();
    ending.then(done.resolve, done.reject);
    return ending;
  }
  const onAbort = () => void end(false).catch(() => {});

  try {
    context = await browser.newContext({
      viewport: headless ? { width: 1280, height: 800 } : null,
      ...(options.existingState ? { storageState: options.existingState } : {}),
    });
    await context.exposeBinding(BRIDGE_NAME, (_source, raw) => {
      const parsed = pageMessageSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      if (parsed.data.kind === "authSave") void end(true).catch(() => {});
      else if (parsed.data.kind === "authCancel") void end(false).catch(() => {});
      return undefined;
    });
    const config: RecorderConfig = { openShadow: options.openShadow === true, authCapture: true };
    await context.addInitScript({
      content: `window[${JSON.stringify(CONFIG_NAME)}] = ${JSON.stringify(config)};\n${await injectedScript()}`,
    });
    page = await context.newPage();
    // Closing the window without saving is a cancel.
    page.on("close", () => void end(false).catch(() => {}));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    else {
      try {
        await page.goto(options.url);
      } catch (error) {
        throw new JobTraceError(
          "NAVIGATION_FAILED",
          `Could not open ${options.url}: ${(error as Error).message.split("\n")[0]}`,
          { cause: error },
        );
      }
    }
  } catch (error) {
    await context?.close().catch(() => {});
    if (!options.browser) await browser.close().catch(() => {});
    throw error;
  }

  return {
    page,
    context,
    finished: done.promise,
    save: () => end(true),
    cancel: () => end(false),
  };
}
