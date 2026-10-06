import { installCapture } from "./capture.ts";
import { cssFor, generateTarget } from "./locators.ts";
import { createOverlay } from "./overlay.ts";
import {
  API_NAME,
  BRIDGE_NAME,
  CONFIG_NAME,
  type ElementRef,
  type PageMessage,
  type RecorderApi,
  type RecorderConfig,
  type RecorderMode,
  type RecorderStatus,
} from "./protocol.ts";

type Bridge = (message: PageMessage) => Promise<unknown>;
type RecorderWindow = Window & {
  [API_NAME]?: RecorderApi;
  [BRIDGE_NAME]?: Bridge;
  [CONFIG_NAME]?: RecorderConfig;
};

/**
 * Entry point of the script injected into every frame of a recorded page.
 * Without the Node bridge (as in locator-generator tests) it only exposes its API.
 */
function init(win: RecorderWindow) {
  if (win[API_NAME]) return;
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const elements = new Map<string, WeakRef<Element>>();
  const keys = new WeakMap<Element, string>();
  let nextKey = 1;

  const register = (element: Element): ElementRef => {
    let key = keys.get(element);
    if (!key) {
      key = String(nextKey++);
      keys.set(element, key);
      elements.set(key, new WeakRef(element));
    }
    return { nonce, key };
  };

  const api: RecorderApi = {
    nonce,
    register,
    generateTarget,
    cssFor,
    isElement: (key, element) => elements.get(key)?.deref() === element,
    receive() {},
    flush() {},
  };
  win[API_NAME] = api;

  const bridge = win[BRIDGE_NAME];
  if (!bridge) return;
  const send = (message: PageMessage) => {
    void bridge(message).catch(() => {});
  };

  let mode: RecorderMode = "record";
  const isTop = win.top === win;
  const overlay = createOverlay(
    win[CONFIG_NAME] ?? {},
    {
      onMode: (next) => send({ kind: "setMode", mode: next }),
      onStop: () => send({ kind: "stop" }),
      onFieldNamed: (pickId, name, read) => send({ kind: "fieldNamed", pickId, name, read }),
      onFieldCancelled: (pickId) => send({ kind: "fieldCancelled", pickId }),
    },
    isTop,
  );
  const capture = installCapture({ send, register, overlay, getMode: () => mode });

  const applyStatus = (status: RecorderStatus) => {
    mode = status.mode;
    if (mode !== "markField") overlay.highlight(null);
    overlay.setStatus(status);
  };
  api.flush = capture.flush;
  api.receive = (message) => {
    if (message.kind === "status") applyStatus(message);
    else if (message.kind === "prompt") overlay.prompt(message.pickId, message.samples);
    else overlay.toast(message.text, message.level);
  };

  // The session keeps state across page loads; ask where things stand.
  void bridge({ kind: "hello" })
    .then((status) => applyStatus(status as RecorderStatus))
    .catch(() => {});
}

init(window as RecorderWindow);
