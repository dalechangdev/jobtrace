import { JobTraceError, REGEX_TRANSFORM_PREFIX } from "@jobtrace/core";
import { parseDate } from "./date.ts";
import { formatSalary, parseSalary } from "./salary.ts";
import { absoluteUrl } from "./url.ts";

export interface TransformContext {
  /** Base for `absoluteUrl`, normally the URL of the page the value was read from. */
  baseUrl: string;
  /** Reference time for relative dates, normally the run's start time. */
  now: Date;
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function applyRegex(value: string, pattern: string): string | null {
  const match = new RegExp(pattern).exec(value);
  if (!match) return null;
  return match[1] ?? match[0];
}

/** Applies one transform. A null result means "no value" and short-circuits the chain. */
export function applyTransform(
  value: string,
  transform: string,
  context: TransformContext,
): string | null {
  if (transform.startsWith(REGEX_TRANSFORM_PREFIX)) {
    return applyRegex(value, transform.slice(REGEX_TRANSFORM_PREFIX.length));
  }
  switch (transform) {
    case "trim":
      return value.trim();
    case "collapseWhitespace":
      return collapseWhitespace(value);
    case "absoluteUrl":
      return absoluteUrl(value, context.baseUrl);
    case "parseDate":
      return parseDate(value, context.now)?.toISOString() ?? null;
    case "parseSalary":
      return formatSalary(parseSalary(value));
    default:
      throw new JobTraceError("INVALID_RECORDING", `Unknown transform "${transform}"`);
  }
}

export function applyTransforms(
  value: string | null,
  transforms: readonly string[],
  context: TransformContext,
): string | null {
  let current = value;
  for (const transform of transforms) {
    if (current === null) return null;
    current = applyTransform(current, transform, context);
  }
  return current;
}
