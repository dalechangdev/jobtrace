import { installCapture } from "./capture.ts";
import { cssFor, generateTarget } from "./locators.ts";
import { createAuthBar, createOverlay } from "./overlay.ts";
import {
  API_NAME,
  BRIDGE_NAME,
  CONFIG_NAME,
  type ElementRef,
  type PageMessage,
  type RecorderApi,
  type RecorderConfig,
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

  const groups = new Map<string, readonly Element[]>();
  const registerGroup = (members: readonly Element[]): ElementRef => {
    const key = `g${nextKey++}`;
    groups.set(key, [...members]);
    return { nonce, key };
  };

  const api: RecorderApi = {
    nonce,
    register,
    generateTarget,
    cssFor,
    isElement: (key, element) => elements.get(key)?.deref() === element,
    isGroup: (key, candidates) => {
      const members = groups.get(key);
      return (
        members !== undefined &&
        members.length === candidates.length &&
        candidates.every((c) => members.includes(c))
      );
    },
    receive() {},
    flush() {},
  };
  win[API_NAME] = api;

  const bridge = win[BRIDGE_NAME];
  if (!bridge) return;
  const send = (message: PageMessage) => {
    void bridge(message).catch(() => {});
  };

  const config = win[CONFIG_NAME] ?? {};
  if (config.authCapture) {
    if (win.top === win) {
      createAuthBar(config, {
        onSave: () => send({ kind: "authSave" }),
        onCancel: () => send({ kind: "authCancel" }),
      });
    }
    return;
  }

  let current: RecorderStatus = {
    mode: "record",
    steps: 0,
    fields: [],
    scope: "none",
    hasList: false,
  };
  const isTop = win.top === win;
  const overlay = createOverlay(
    config,
    {
      onMode: (next) => send({ kind: "setMode", mode: next }),
      onStop: () => send({ kind: "stop" }),
      onFieldNamed: (pickId, name, read) => send({ kind: "fieldNamed", pickId, name, read }),
      onFieldCancelled: (pickId) => send({ kind: "fieldCancelled", pickId }),
      onListChoice: (choice) => send({ kind: "listChoice", choice }),
      onInfiniteScroll: () => send({ kind: "setPagination", mode: "infiniteScroll" }),
      onFinishScope: () => send({ kind: "finishScope" }),
    },
    isTop,
  );
  const capture = installCapture({
    send,
    register,
    registerGroup,
    overlay,
    getStatus: () => current,
  });

  const applyStatus = (status: RecorderStatus) => {
    current = status;
    if (status.mode === "record") overlay.highlight(null);
    overlay.setStatus(status);
    capture.refresh();
  };
  api.flush = capture.flush;
  api.receive = (message) => {
    if (message.kind === "status") applyStatus(message);
    else if (message.kind === "prompt") overlay.prompt(message.pickId, message.samples);
    else if (message.kind === "promptList")
      overlay.promptList(message.count, message.canWiden, message.canNarrow);
    else if (message.kind === "listChoice") capture.chooseList(message.choice);
    else overlay.toast(message.text, message.level);
  };

  // The session keeps state across page loads; ask where things stand.
  void bridge({ kind: "hello" })
    .then((status) => applyStatus(status as RecorderStatus))
    .catch(() => {});
}

init(window as RecorderWindow);
