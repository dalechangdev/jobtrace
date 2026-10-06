/**
 * Messages between the in-page recorder script and the Node recorder session.
 * Types and constants only: this file is bundled into the page script, so it
 * must not import anything with runtime Node dependencies.
 */
import type { Fingerprint, Locator } from "@jobtrace/core";

export const BRIDGE_NAME = "__jobtraceBridge";
export const API_NAME = "__jobtraceRecorder";
export const CONFIG_NAME = "__jobtraceConfig";
export const OVERLAY_ID = "__jobtrace-overlay";

/**
 * Core job fields offered in the "name this field" dialog. Kept in sync with
 * CORE_FIELD_NAMES in @jobtrace/core by a test; it cannot be imported here
 * because that would pull Node-only code into the page bundle.
 */
export const FIELD_NAME_CHOICES = [
  "title",
  "company",
  "location",
  "salaryText",
  "url",
  "description",
  "postedAt",
  "employmentType",
  "remote",
] as const;

/**
 * What the next click means:
 *  - record: a normal action on the page
 *  - markField: pick a piece of data to extract
 *  - markList: pick one item of a repeating list
 *  - openDetail: follow an item's link to its detail page
 *  - markNext: pick the next-page control
 *  - markLoggedIn: pick an element that proves the user is logged in
 */
export type RecorderMode =
  | "record"
  | "markField"
  | "markList"
  | "openDetail"
  | "markNext"
  | "markLoggedIn";
/** The innermost construct being recorded into. */
export type ScopeKind = "none" | "list" | "detail";
export type ListChoice = "use" | "wider" | "narrower" | "cancel";
export type GeneratePurpose = "action" | "field";
export type FieldRead = "text" | "innerHTML" | "href";

export interface WireTarget {
  locators: Locator[];
  fingerprint: Fingerprint;
}

/** Identifies a DOM element of one document, so Node can refer back to it. */
export interface ElementRef {
  /** Random id of the document the element lives in. */
  nonce: string;
  key: string;
}

export interface FieldSamples {
  text: string;
  html: string;
  /** Present when the element is, or is inside, a link. */
  href?: string;
}

export type PageMessage =
  | { kind: "hello" }
  | {
      kind: "action";
      action: "click" | "fill" | "select" | "press";
      /** Page clock (epoch ms) when the action happened; orders it against navigations. */
      at: number;
      url: string;
      ref?: ElementRef;
      target?: WireTarget;
      /** Text typed or option chosen (fill, select). */
      value?: string;
      /** Key name (press). */
      key?: string;
      /** False when a click landed on an element that is not obviously interactive. */
      interactive?: boolean;
      /** Set on non-interactive clicks; a matching "effect" message follows. */
      effectId?: number;
      /** Set when the target is relative to this item of the current list. */
      item?: { index: number };
    }
  | { kind: "effect"; effectId: number; mutated: boolean }
  | {
      kind: "pick";
      pickId: number;
      ref: ElementRef;
      target: WireTarget;
      link?: { ref: ElementRef; target: WireTarget };
      samples: FieldSamples;
      /** Set when the targets are relative to this item of the current list. */
      item?: { index: number };
    }
  /** A list item was clicked in markList mode; the frame holds the candidate lists. */
  | { kind: "listPick"; count: number; canWiden: boolean; canNarrow: boolean }
  /** The user's answer in the list dialog (sent by the top frame). */
  | { kind: "listChoice"; choice: ListChoice }
  | { kind: "listConfirmed"; group: ElementRef; target: WireTarget; count: number }
  | {
      kind: "detailPick";
      at: number;
      url: string;
      item: { index: number };
      ref: ElementRef;
      target: WireTarget;
      /** The link's href attribute, when it is a link. */
      href?: string;
    }
  | { kind: "nextPick"; ref: ElementRef; target: WireTarget }
  | { kind: "loggedInPick"; ref: ElementRef; target: WireTarget }
  /** Auth capture only: the user is done logging in, or gave up. */
  | { kind: "authSave" }
  | { kind: "authCancel" }
  | { kind: "setPagination"; mode: "infiniteScroll" }
  | { kind: "finishScope" }
  | { kind: "notice"; text: string; level: "info" | "warn" }
  | { kind: "fieldNamed"; pickId: number; name: string; read: FieldRead }
  | { kind: "fieldCancelled"; pickId: number }
  | { kind: "sensitive"; reason: string }
  | { kind: "setMode"; mode: RecorderMode }
  | { kind: "stop" };

export interface RecorderStatus {
  mode: RecorderMode;
  steps: number;
  fields: string[];
  scope: ScopeKind;
  /** The list being recorded into, so every frame can find its items again. */
  list?: { locators: Locator[]; count: number };
  /** True once any list was marked; pagination needs one. */
  hasList: boolean;
  /** Present when recording with a saved login; says whether its logged-in check was marked. */
  auth?: { hasCheck: boolean };
}

export type NodeMessage =
  | ({ kind: "status" } & RecorderStatus)
  | { kind: "prompt"; pickId: number; samples: FieldSamples }
  | { kind: "promptList"; count: number; canWiden: boolean; canNarrow: boolean }
  /** Relayed to the frame that holds the list candidates. */
  | { kind: "listChoice"; choice: ListChoice }
  | { kind: "toast"; text: string; level: "info" | "warn" };

export interface RecorderConfig {
  /** Tests open the overlay's shadow root so they can click its buttons. */
  openShadow?: boolean;
  /**
   * Auth capture: the page only shows a "Save login" bar. Nothing the user does
   * or types is observed at all.
   */
  authCapture?: boolean;
}

/** The API the page script exposes on `window`. */
export interface RecorderApi {
  nonce: string;
  receive(message: NodeMessage): void;
  /** Sends any typed-but-not-yet-reported text now. */
  flush(): void;
  /** True when `element` is the one registered under `key`. */
  isElement(key: string, element: Element): boolean;
  /** True when `elements` are exactly the group registered under `key`. */
  isGroup(key: string, elements: Element[]): boolean;
  generateTarget(element: Element, purpose: GeneratePurpose): WireTarget;
  /** A CSS selector for an element, used for iframe chains. */
  cssFor(element: Element): string | null;
  register(element: Element): ElementRef;
}
