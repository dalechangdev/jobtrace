import { fingerprintSchema, locatorSchema } from "@jobtrace/core";
import { z } from "zod";
import type { PageMessage } from "./injected/protocol.ts";

/**
 * Validation of messages coming from recorded pages. The page is untrusted
 * input: any site script could call the bridge, so nothing is taken on faith.
 */
const ref = z.object({ nonce: z.string().max(64), key: z.string().max(32) });
const target = z.object({
  locators: z.array(locatorSchema).max(20),
  fingerprint: fingerprintSchema,
});
const mode = z.enum(["record", "markField"]);

export const pageMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello") }),
  z.object({
    kind: z.literal("action"),
    action: z.enum(["click", "fill", "select", "press"]),
    at: z.number(),
    url: z.string(),
    ref: ref.optional(),
    target: target.optional(),
    value: z.string().optional(),
    key: z.string().max(32).optional(),
    interactive: z.boolean().optional(),
    effectId: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("effect"), effectId: z.number().int(), mutated: z.boolean() }),
  z.object({
    kind: z.literal("pick"),
    pickId: z.number().int(),
    ref,
    target,
    link: z.object({ ref, target }).optional(),
    samples: z.object({ text: z.string(), html: z.string(), href: z.string().optional() }),
  }),
  z.object({
    kind: z.literal("fieldNamed"),
    pickId: z.number().int(),
    name: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
      .max(64),
    read: z.enum(["text", "innerHTML", "href"]),
  }),
  z.object({ kind: z.literal("fieldCancelled"), pickId: z.number().int() }),
  z.object({ kind: z.literal("sensitive"), reason: z.string().max(500) }),
  z.object({ kind: z.literal("setMode"), mode }),
  z.object({ kind: z.literal("stop") }),
]) satisfies z.ZodType<PageMessage>;
