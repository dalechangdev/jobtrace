import {
  FIELD_NAME_CHOICES,
  type FieldRead,
  type FieldSamples,
  OVERLAY_ID,
  type RecorderConfig,
  type RecorderMode,
  type RecorderStatus,
} from "./protocol.ts";

export interface OverlayHandlers {
  onMode(mode: RecorderMode): void;
  onStop(): void;
  onFieldNamed(pickId: number, name: string, read: FieldRead): void;
  onFieldCancelled(pickId: number): void;
}

export interface Overlay {
  /** The element hosting the overlay; events passing through it are not recorded. */
  host: HTMLElement;
  setStatus(status: RecorderStatus): void;
  prompt(pickId: number, samples: FieldSamples): void;
  toast(text: string, level: "info" | "warn"): void;
  /** Outlines the element under the pointer while marking fields; null hides it. */
  highlight(rect: DOMRect | null, label?: string): void;
}

const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.bar, .dialog, .toast { position: fixed; z-index: 2147483647; color: #f4f4f5; background: #18181b;
  border: 1px solid #3f3f46; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
.bar { left: 50%; transform: translateX(-50%); top: 10px; display: flex; align-items: center; gap: 8px; padding: 6px 8px; white-space: nowrap; }
.bar.bottom { top: auto; bottom: 10px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; }
.bar.marking .dot { background: #3b82f6; }
.status { color: #a1a1aa; padding: 0 4px; }
button { cursor: pointer; color: inherit; background: #27272a; border: 1px solid #52525b; border-radius: 6px; padding: 4px 10px; }
button:hover { background: #3f3f46; }
button[aria-pressed="true"] { background: #2563eb; border-color: #2563eb; }
button.stop { background: #b91c1c; border-color: #b91c1c; }
.dialog { left: 50%; top: 64px; transform: translateX(-50%); width: 340px; padding: 12px; display: none; }
.dialog.open { display: grid; gap: 8px; }
.dialog h2 { margin: 0; font-size: 14px; font-weight: 600; }
label { display: grid; gap: 3px; color: #a1a1aa; }
select, input { color: #f4f4f5; background: #09090b; border: 1px solid #52525b; border-radius: 6px; padding: 5px 6px; width: 100%; }
.preview { max-height: 72px; overflow: auto; padding: 6px; border-radius: 6px; background: #09090b; color: #d4d4d8; overflow-wrap: anywhere; }
.error { color: #fca5a5; min-height: 1em; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.toast { left: 50%; transform: translateX(-50%); bottom: 56px; padding: 8px 12px; max-width: 480px; display: none; }
.toast.open { display: block; }
.toast.warn { border-color: #f59e0b; }
.box { position: fixed; z-index: 2147483646; pointer-events: none; display: none; border: 2px solid #3b82f6; background: rgba(59,130,246,.15); border-radius: 2px; }
.box span { position: absolute; left: -2px; top: -20px; background: #3b82f6; color: #fff; padding: 0 5px; border-radius: 3px 3px 0 0; font-size: 11px; }
`;

type Props = Record<string, string>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Array<Node | string>
) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "text") node.textContent = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

/**
 * The recorder UI. It lives in a shadow root (closed outside of tests) so site
 * CSS cannot affect it, is built without innerHTML or inline styles so strict
 * Content-Security-Policy pages accept it, and stops its own events from
 * reaching the page. Sub-frames only get the highlight box (`toolbar: false`).
 */
export function createOverlay(
  config: RecorderConfig,
  handlers: OverlayHandlers,
  toolbar: boolean,
): Overlay {
  const host = el("div", { id: OVERLAY_ID });
  const shadow = host.attachShadow({ mode: config.openShadow ? "open" : "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS_TEXT);
  shadow.adoptedStyleSheets = [sheet];

  const boxLabel = el("span");
  const box = el("div", { class: "box" }, boxLabel);
  shadow.append(box);

  const mount = () => {
    if (!host.isConnected && document.documentElement) document.documentElement.append(host);
  };
  mount();
  // Single-page apps sometimes replace the whole document body or root.
  new MutationObserver(mount).observe(document, { childList: true, subtree: false });
  document.addEventListener("DOMContentLoaded", mount);

  const highlight: Overlay["highlight"] = (rect, label = "") => {
    if (!rect) {
      box.style.display = "none";
      return;
    }
    mount();
    box.style.display = "block";
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    boxLabel.textContent = label;
  };

  if (!toolbar) {
    return { host, highlight, setStatus() {}, prompt() {}, toast() {} };
  }

  const label = el("strong", { text: "Recording" });
  const status = el("span", { class: "status", text: "0 steps" });
  const recordButton = el("button", { type: "button", "data-action": "record", text: "Record" });
  const markButton = el("button", { type: "button", "data-action": "mark", text: "Mark field" });
  const stopButton = el("button", {
    type: "button",
    "data-action": "stop",
    class: "stop",
    text: "Stop",
  });
  const moveButton = el("button", {
    type: "button",
    "data-action": "move",
    title: "Move toolbar",
    text: "⇅",
  });
  const bar = el(
    "div",
    { class: "bar", role: "toolbar", "aria-label": "JobTrace recorder" },
    el("span", { class: "dot" }),
    label,
    status,
    recordButton,
    markButton,
    stopButton,
    moveButton,
  );

  const nameSelect = el("select", { "data-role": "name" });
  const customInput = el("input", {
    "data-role": "custom",
    placeholder: "customFieldName",
    hidden: "",
  });
  const readSelect = el("select", { "data-role": "read" });
  const preview = el("div", { class: "preview", "data-role": "preview" });
  const error = el("div", { class: "error", "data-role": "error" });
  const saveButton = el("button", { type: "button", "data-action": "save", text: "Save field" });
  const cancelButton = el("button", { type: "button", "data-action": "cancel", text: "Cancel" });
  const dialog = el(
    "div",
    { class: "dialog", role: "dialog", "aria-label": "Name this field" },
    el("h2", { text: "What is this?" }),
    el("label", {}, "Field", nameSelect),
    customInput,
    el("label", {}, "Read", readSelect),
    preview,
    error,
    el("div", { class: "actions" }, cancelButton, saveButton),
  );
  const toastBox = el("div", { class: "toast", role: "status" });
  shadow.append(bar, dialog, toastBox);

  // Keep the overlay's own events away from the page's listeners.
  for (const type of [
    "click",
    "mousedown",
    "mouseup",
    "pointerdown",
    "pointerup",
    "keydown",
    "keyup",
    "keypress",
    "input",
    "change",
    "focusin",
  ]) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }

  let usedFields: string[] = [];
  let pending: { pickId: number; samples: FieldSamples } | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const CUSTOM = "__custom";

  const sampleFor = (read: FieldRead, samples: FieldSamples) =>
    read === "href" ? (samples.href ?? "") : read === "innerHTML" ? samples.html : samples.text;
  const refreshPreview = () => {
    if (!pending) return;
    const value = sampleFor(readSelect.value as FieldRead, pending.samples);
    preview.textContent = value.length > 300 ? `${value.slice(0, 300)}…` : value || "(empty)";
  };
  const closeDialog = () => {
    dialog.classList.remove("open");
    pending = null;
  };

  nameSelect.addEventListener("change", () => {
    customInput.hidden = nameSelect.value !== CUSTOM;
    if (nameSelect.value === CUSTOM) customInput.focus();
    if (pending?.samples.href !== undefined)
      readSelect.value = nameSelect.value === "url" ? "href" : "text";
    refreshPreview();
  });
  readSelect.addEventListener("change", refreshPreview);

  const save = () => {
    if (!pending) return;
    const name = nameSelect.value === CUSTOM ? customInput.value.trim() : nameSelect.value;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      error.textContent = "Use letters, digits and underscores, starting with a letter.";
      return;
    }
    const { pickId } = pending;
    closeDialog();
    handlers.onFieldNamed(pickId, name, readSelect.value as FieldRead);
  };
  const cancel = () => {
    if (!pending) return;
    const { pickId } = pending;
    closeDialog();
    handlers.onFieldCancelled(pickId);
  };
  saveButton.addEventListener("click", save);
  cancelButton.addEventListener("click", cancel);
  // Enter and Escape answer the dialog; Escape with no dialog open leaves marking mode.
  host.addEventListener("keydown", (event) => {
    if (pending) {
      if (event.key === "Enter") save();
      else if (event.key === "Escape") cancel();
    } else if (event.key === "Escape") handlers.onMode("record");
  });

  recordButton.addEventListener("click", () => handlers.onMode("record"));
  markButton.addEventListener("click", () => handlers.onMode("markField"));
  stopButton.addEventListener("click", () => handlers.onStop());
  moveButton.addEventListener("click", () => bar.classList.toggle("bottom"));

  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

  return {
    host,
    highlight,
    setStatus({ mode, steps, fields }) {
      usedFields = fields;
      const marking = mode === "markField";
      bar.classList.toggle("marking", marking);
      label.textContent = marking ? "Click the data to extract" : "Recording";
      status.textContent = `${plural(steps, "step")} · ${plural(fields.length, "field")}`;
      recordButton.setAttribute("aria-pressed", String(!marking));
      markButton.setAttribute("aria-pressed", String(marking));
      if (!marking) highlight(null);
    },
    prompt(pickId, samples) {
      if (pending) handlers.onFieldCancelled(pending.pickId);
      pending = { pickId, samples };
      nameSelect.replaceChildren(
        ...FIELD_NAME_CHOICES.map((name) =>
          el("option", {
            value: name,
            text: usedFields.includes(name) ? `${name} (replace)` : name,
          }),
        ),
        el("option", { value: CUSTOM, text: "Custom name…" }),
      );
      nameSelect.value = FIELD_NAME_CHOICES.find((name) => !usedFields.includes(name)) ?? CUSTOM;
      customInput.hidden = nameSelect.value !== CUSTOM;
      customInput.value = "";
      readSelect.replaceChildren(
        el("option", { value: "text", text: "Text" }),
        ...(samples.href === undefined ? [] : [el("option", { value: "href", text: "Link URL" })]),
        el("option", { value: "innerHTML", text: "HTML" }),
      );
      readSelect.value = nameSelect.value === "url" && samples.href !== undefined ? "href" : "text";
      error.textContent = "";
      refreshPreview();
      dialog.classList.add("open");
      nameSelect.focus();
    },
    toast(text, level) {
      toastBox.textContent = text;
      toastBox.className = `toast open ${level}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(
        () => toastBox.classList.remove("open"),
        level === "warn" ? 8000 : 2500,
      );
    },
  };
}
