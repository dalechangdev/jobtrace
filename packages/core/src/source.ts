import { z } from "zod";
import { JobTraceError } from "./errors.ts";
import { parseRecording } from "./migrations/index.ts";
import type { Recording } from "./recording.ts";

/**
 * API sources: job boards hosted by an applicant tracking system that publishes
 * a public JSON feed. They sit next to browser recordings and feed the same
 * jobs pipeline, without a browser.
 */
export const ATS_PROVIDERS = ["greenhouse", "lever", "ashby"] as const;
export type AtsProvider = (typeof ATS_PROVIDERS)[number];

export const API_SOURCE_SCHEMA_VERSION = 1;

export const apiSourceSchema = z.strictObject({
  schemaVersion: z.literal(API_SOURCE_SCHEMA_VERSION),
  kind: z.literal("api"),
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.enum(ATS_PROVIDERS),
  /** The board's name in the provider's URLs, e.g. `acme` in jobs.lever.co/acme. */
  boardToken: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, "Only letters, digits, dots, dashes and underscores"),
  /** Replaces the provider's API origin: Lever's EU instance, or a test server. */
  baseUrl: z.url().optional(),
  settings: z
    .strictObject({
      /** Company name used when the feed does not carry one. */
      company: z.string().optional(),
      maxItems: z.number().int().positive().default(5000),
      respectRobotsTxt: z.boolean().default(true),
    })
    .default(() => ({ maxItems: 5000, respectRobotsTxt: true })),
});
export type ApiSource = z.infer<typeof apiSourceSchema>;
export type ApiSourceInput = z.input<typeof apiSourceSchema>;

/** What a row in `recordings` holds: a browser recording or an API source. */
export type Definition = Recording | ApiSource;
export type DefinitionKind = "browser" | "api";

export function isApiSource(definition: Definition): definition is ApiSource {
  return "kind" in definition && definition.kind === "api";
}

const ORIGINS: Record<AtsProvider, string> = {
  greenhouse: "https://boards-api.greenhouse.io",
  lever: "https://api.lever.co",
  ashby: "https://api.ashbyhq.com",
};

/** The feed URL an API source is read from. */
export function apiSourceFeedUrl(
  source: Pick<ApiSource, "provider" | "boardToken" | "baseUrl">,
): string {
  const origin = (source.baseUrl ?? ORIGINS[source.provider]).replace(/\/+$/, "");
  const token = encodeURIComponent(source.boardToken);
  switch (source.provider) {
    case "greenhouse":
      return `${origin}/v1/boards/${token}/jobs?content=true&pay_transparency=true`;
    case "lever":
      return `${origin}/v0/postings/${token}?mode=json`;
    case "ashby":
      return `${origin}/posting-api/job-board/${token}?includeCompensation=true`;
  }
}

export function parseApiSource(document: unknown): ApiSource {
  const result = apiSourceSchema.safeParse(document);
  if (!result.success) {
    throw new JobTraceError(
      "INVALID_RECORDING",
      `Invalid API source:\n${z.prettifyError(result.error)}`,
      {
        details: { issues: result.error.issues },
      },
    );
  }
  return result.data;
}

/** Parses a stored or imported definition of either kind. */
export function parseDefinition(document: unknown): Definition {
  const isApi =
    typeof document === "object" &&
    document !== null &&
    (document as { kind?: unknown }).kind === "api";
  return isApi ? parseApiSource(document) : parseRecording(document);
}

export function parseDefinitionJson(text: string): Definition {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new JobTraceError("INVALID_RECORDING", "Not valid JSON", { cause: error });
  }
  return parseDefinition(document);
}
