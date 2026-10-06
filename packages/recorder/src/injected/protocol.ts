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

export type RecorderMode = "record" | "markField";
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
    }
  | { kind: "effect"; effectId: number; mutated: boolean }
  | {
      kind: "pick";
      pickId: number;
      ref: ElementRef;
      target: WireTarget;
      link?: { ref: ElementRef; target: WireTarget };
      samples: FieldSamples;
    }
  | { kind: "fieldNamed"; pickId: number; name: string; read: FieldRead }
  | { kind: "fieldCancelled"; pickId: number }
  | { kind: "sensitive"; reason: string }
  | { kind: "setMode"; mode: RecorderMode }
  | { kind: "stop" };

export interface RecorderStatus {
  mode: RecorderMode;
  steps: number;
  fields: string[];
}

export type NodeMessage =
  | ({ kind: "status" } & RecorderStatus)
  | { kind: "prompt"; pickId: number; samples: FieldSamples }
  | { kind: "toast"; text: string; level: "info" | "warn" };

export interface RecorderConfig {
  /** Tests open the overlay's shadow root so they can click its buttons. */
  openShadow?: boolean;
}

/** The API the page script exposes on `window`. */
export interface RecorderApi {
  nonce: string;
  receive(message: NodeMessage): void;
  /** Sends any typed-but-not-yet-reported text now. */
  flush(): void;
  /** True when `element` is the one registered under `key`. */
  isElement(key: string, element: Element): boolean;
  generateTarget(element: Element, purpose: GeneratePurpose): WireTarget;
  /** A CSS selector for an element, used for iframe chains. */
  cssFor(element: Element): string | null;
  register(element: Element): ElementRef;
}
