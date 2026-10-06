import { JobTraceError } from "./errors.ts";
import type { Recording } from "./recording.ts";

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Replaces `{{params.name}}` (and any other dotted key in `values`) in a string.
 * Unknown placeholders are an error rather than silently rendering as empty.
 */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new JobTraceError("TEMPLATE_ERROR", `Unknown template placeholder {{${key}}}`, {
        details: { template, known: Object.keys(values) },
      });
    }
    return value;
  });
}

/** Merges run-time overrides over the recording's param defaults. */
export function resolveParams(
  declared: Recording["params"],
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const unknown = Object.keys(overrides).filter((name) => !(name in declared));
  if (unknown.length > 0) {
    throw new JobTraceError(
      "TEMPLATE_ERROR",
      `Unknown param(s): ${unknown.join(", ")}. This recording declares: ${Object.keys(declared).join(", ") || "none"}`,
    );
  }
  const resolved: Record<string, string> = {};
  for (const [name, spec] of Object.entries(declared)) {
    const value = overrides[name] ?? spec.default;
    if (value === undefined) {
      throw new JobTraceError(
        "TEMPLATE_ERROR",
        `Param "${name}" has no default and was not provided`,
      );
    }
    resolved[name] = value;
  }
  return resolved;
}

/** Template values for a run: each param as `params.<name>`. */
export function paramValues(params: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [`params.${name}`, value]),
  );
}
