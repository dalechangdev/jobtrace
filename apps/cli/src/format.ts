import { JobTraceError, type Step } from "@jobtrace/core";

const MAX_CELL = 48;

const clip = (value: string, max = MAX_CELL) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** Plain-text table with padded columns. Cells are single-line and clipped. */
export function table(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  const cells = rows.map((row) =>
    row.map((cell) =>
      clip(
        String(cell ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    ),
  );
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...cells.map((row) => row[column]?.length ?? 0)),
  );
  const line = (row: readonly string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return `${[line(headers), ...cells.map(line)].join("\n")}\n`;
}

/** Local date and time to the minute, e.g. `2026-10-06 18:20`. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

const UNITS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parses `--since`: a span back from now (`36h`, `7d`, `2w`) or a date. Returns an ISO timestamp. */
export function parseSince(value: string, now: Date = new Date()): string {
  const span = /^(\d+)\s*([hdw])$/i.exec(value.trim());
  if (span) {
    const unit = UNITS[(span[2] as string).toLowerCase()] as number;
    return new Date(now.getTime() - Number(span[1]) * unit).toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new JobTraceError(
      "INVALID_ARGUMENT",
      `--since expects a span like 7d or 36h, or a date; got "${value}"`,
    );
  }
  return date.toISOString();
}

/** Indented outline of a step tree, for `recordings show`. */
export function outline(steps: readonly Step[], depth = 0): string[] {
  return steps.flatMap((step) => {
    let detail = "";
    if (step.type === "navigate") detail = step.url;
    else if (step.type === "fill" || step.type === "select") detail = JSON.stringify(step.value);
    else if (step.type === "press") detail = step.key;
    else if (step.type === "waitFor")
      detail = step.urlPattern ?? (step.ms === undefined ? "element" : `${step.ms}ms`);
    else if (step.type === "extract") detail = step.fields.map((field) => field.name).join(", ");
    else if (step.type === "paginate") detail = step.mode;
    else if (step.type === "openDetail") detail = step.strategy;
    const line = `${"  ".repeat(depth)}${step.id}  ${step.type}${detail ? `  ${detail}` : ""}`;
    return "body" in step ? [line, ...outline(step.body, depth + 1)] : [line];
  });
}
