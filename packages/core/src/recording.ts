import { z } from "zod";

/**
 * The recording format: the central contract of JobTrace (PLAN.md section 5).
 * Changing a schema here means bumping CURRENT_SCHEMA_VERSION and adding a
 * migration in ./migrations.
 */
export const CURRENT_SCHEMA_VERSION = 1;

const nonEmpty = z.string().min(1);

export const locatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("testId"), value: nonEmpty }),
  z.strictObject({
    kind: z.literal("role"),
    role: nonEmpty,
    name: z.string().optional(),
    exact: z.boolean().optional(),
    /** Heading level, for `role: "heading"`. */
    level: z.number().int().min(1).max(6).optional(),
  }),
  z.strictObject({ kind: z.literal("text"), value: nonEmpty, exact: z.boolean().optional() }),
  z.strictObject({ kind: z.literal("css"), value: nonEmpty }),
  z.strictObject({ kind: z.literal("xpath"), value: nonEmpty }),
]);
export type Locator = z.infer<typeof locatorSchema>;
export type LocatorKind = Locator["kind"];

export const fingerprintSchema = z.strictObject({
  tag: nonEmpty,
  text: z.string().optional(),
  attrs: z.record(z.string(), z.string()).default({}),
  ancestorTrail: z.array(z.string()).default([]),
});
export type Fingerprint = z.infer<typeof fingerprintSchema>;

export const targetSchema = z.strictObject({
  /** Ranked locators, most stable first. */
  locators: z.array(locatorSchema).min(1),
  /** Description of the recorded element, used to heal broken locators. */
  fingerprint: fingerprintSchema.optional(),
  /** Chain of iframe CSS selectors, outermost first. */
  frame: z.array(nonEmpty).default([]),
  /** "item" resolves the locators inside the current forEach item instead of the page. */
  relativeTo: z.literal("item").nullable().default(null),
});
export type Target = z.infer<typeof targetSchema>;

/** Field transforms; `regex:<pattern>` keeps the first capture group (or the whole match). */
export const TRANSFORM_NAMES = [
  "trim",
  "collapseWhitespace",
  "absoluteUrl",
  "parseDate",
  "parseSalary",
] as const;
export const REGEX_TRANSFORM_PREFIX = "regex:";

function isValidTransform(transform: string): boolean {
  if ((TRANSFORM_NAMES as readonly string[]).includes(transform)) return true;
  if (!transform.startsWith(REGEX_TRANSFORM_PREFIX)) return false;
  const pattern = transform.slice(REGEX_TRANSFORM_PREFIX.length);
  if (pattern === "") return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const transformSchema = z.string().refine(isValidTransform, {
  error: `Unknown transform. Use one of ${TRANSFORM_NAMES.join(", ")} or regex:<pattern>`,
});

export const fieldSchema = z.strictObject({
  /** A core job field name (see CORE_FIELD_NAMES) or any custom name. */
  name: nonEmpty,
  target: targetSchema,
  read: z.enum(["text", "innerHTML", "attr"]).default("text"),
  attr: z.string().nullable().default(null),
  /** Applied in order. */
  transforms: z.array(transformSchema).default([]),
  required: z.boolean().default(false),
});
export type Field = z.infer<typeof fieldSchema>;

const stepId = nonEmpty;

const navigateStep = z.strictObject({ id: stepId, type: z.literal("navigate"), url: nonEmpty });
const clickStep = z.strictObject({ id: stepId, type: z.literal("click"), target: targetSchema });
const fillStep = z.strictObject({
  id: stepId,
  type: z.literal("fill"),
  target: targetSchema,
  value: z.string(),
});
const selectStep = z.strictObject({
  id: stepId,
  type: z.literal("select"),
  target: targetSchema,
  value: z.string(),
});
const pressStep = z.strictObject({
  id: stepId,
  type: z.literal("press"),
  target: targetSchema.optional(),
  key: nonEmpty,
});
const scrollStep = z.strictObject({
  id: stepId,
  type: z.literal("scroll"),
  target: targetSchema.optional(),
  mode: z.enum(["toBottom", "by"]),
  /** Pixels, required when mode is "by". */
  amount: z.number().optional(),
});
const waitForStep = z.strictObject({
  id: stepId,
  type: z.literal("waitFor"),
  target: targetSchema.optional(),
  /** Glob matched against the page URL. */
  urlPattern: nonEmpty.optional(),
  ms: z.number().int().nonnegative().optional(),
});
const extractStep = z.strictObject({
  id: stepId,
  type: z.literal("extract"),
  scope: z.enum(["page", "item"]),
  fields: z.array(fieldSchema).min(1),
});
const forEachStep = z.strictObject({
  id: stepId,
  type: z.literal("forEach"),
  items: targetSchema,
  get body() {
    return z.array(stepSchema);
  },
});
const openDetailStep = z.strictObject({
  id: stepId,
  type: z.literal("openDetail"),
  link: targetSchema,
  strategy: z.enum(["sameTab", "newTab"]).default("sameTab"),
  get body() {
    return z.array(stepSchema);
  },
});
const paginateStep = z.strictObject({
  id: stepId,
  type: z.literal("paginate"),
  mode: z.enum(["nextButton", "infiniteScroll", "urlPattern"]),
  /** The next-page control, required for mode "nextButton". */
  next: targetSchema.optional(),
  /** URL containing `{{page}}`, required for mode "urlPattern". Pages count from 1. */
  urlTemplate: nonEmpty.optional(),
  /**
   * The recorded primary stop condition. The runner always applies every stop
   * condition that fits the mode (next missing or disabled, no new items,
   * maxPages, repeated page), so this is descriptive.
   */
  until: z.enum(["nextMissingOrDisabled", "noNewItems", "maxPages"]).optional(),
  get body() {
    return z.array(stepSchema);
  },
});

export const stepSchema = z.discriminatedUnion("type", [
  navigateStep,
  clickStep,
  fillStep,
  selectStep,
  pressStep,
  scrollStep,
  waitForStep,
  extractStep,
  forEachStep,
  openDetailStep,
  paginateStep,
]);
export type Step = z.infer<typeof stepSchema>;
export type StepType = Step["type"];
export type StepOf<T extends StepType> = Extract<Step, { type: T }>;

export const settingsSchema = z.strictObject({
  maxPages: z.number().int().positive().default(20),
  maxItems: z.number().int().positive().default(1000),
  minDelayMs: z.number().int().nonnegative().default(1000),
  maxDelayMs: z.number().int().nonnegative().default(3000),
  stepTimeoutMs: z.number().int().positive().default(15_000),
  respectRobotsTxt: z.boolean().default(true),
  /** Company name used when a job does not extract one. */
  company: z.string().optional(),
});
export type RecordingSettings = z.infer<typeof settingsSchema>;

export const paramSchema = z.strictObject({ default: z.string().optional() });

/** Walks a step tree depth-first, including loop and detail bodies. */
export function* walkSteps(steps: readonly Step[]): Generator<Step> {
  for (const step of steps) {
    yield step;
    if ("body" in step) yield* walkSteps(step.body);
  }
}

export const recordingSchema = z
  .strictObject({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: nonEmpty,
    name: nonEmpty,
    startUrl: nonEmpty,
    authProfileId: z.string().nullable().default(null),
    /** Run parameters, referenced in step strings as `{{params.<name>}}`. */
    params: z.record(z.string(), paramSchema).default({}),
    settings: settingsSchema.default(() => settingsSchema.parse({})),
    steps: z.array(stepSchema),
  })
  .superRefine((recording, ctx) => {
    if (recording.settings.minDelayMs > recording.settings.maxDelayMs) {
      ctx.addIssue({
        code: "custom",
        path: ["settings", "minDelayMs"],
        message: "minDelayMs must not exceed maxDelayMs",
      });
    }
    const seen = new Set<string>();
    for (const step of walkSteps(recording.steps)) {
      const issue = (message: string) =>
        ctx.addIssue({ code: "custom", path: ["steps"], message: `step "${step.id}": ${message}` });
      if (seen.has(step.id)) issue("duplicate step id");
      seen.add(step.id);
      switch (step.type) {
        case "scroll":
          if (step.mode === "by" && step.amount === undefined) issue('mode "by" needs an amount');
          break;
        case "waitFor": {
          const given = [step.target, step.urlPattern, step.ms].filter((v) => v !== undefined);
          if (given.length !== 1) issue("needs exactly one of target, urlPattern or ms");
          break;
        }
        case "paginate":
          if (step.mode === "nextButton" && !step.next) issue('mode "nextButton" needs next');
          if (step.mode === "urlPattern" && !step.urlTemplate?.includes("{{page}}")) {
            issue('mode "urlPattern" needs a urlTemplate containing {{page}}');
          }
          break;
        default:
          break;
      }
    }
  });

export type Recording = z.infer<typeof recordingSchema>;
/** A recording as written by hand or by the recorder, before defaults are applied. */
export type RecordingInput = z.input<typeof recordingSchema>;

/** File extension of exported recordings. */
export const RECORDING_FILE_EXTENSION = ".jobtrace.json";
