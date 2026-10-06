/** Local date and time to the minute, e.g. `6 Oct 2026, 18:20`. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "just now", "5 minutes ago", "3 days ago"; falls back to the date after a month. */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 45) return "just now";
  const units: Array<[number, string]> = [
    [60, "minute"],
    [3600, "hour"],
    [86_400, "day"],
  ];
  for (let index = units.length - 1; index >= 0; index--) {
    const [size, name] = units[index] as [number, string];
    if (seconds >= size) {
      const count = Math.round(seconds / size);
      if (name === "day" && count > 30) break;
      return `${count} ${name}${count === 1 ? "" : "s"} ago`;
    }
  }
  return when(iso);
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A salary range for display, e.g. "EUR 85,000–110,000 / year"; falls back to the site's own text. */
export function salary(job: {
  salaryText: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}): string {
  if (job.salaryMin === null && job.salaryMax === null) return job.salaryText ?? "";
  const amount = (value: number) => value.toLocaleString("en-US");
  const range =
    job.salaryMin !== null && job.salaryMax !== null && job.salaryMin !== job.salaryMax
      ? `${amount(job.salaryMin)}–${amount(job.salaryMax)}`
      : amount((job.salaryMin ?? job.salaryMax) as number);
  return [job.salaryCurrency, range, job.salaryPeriod ? `/ ${job.salaryPeriod}` : ""]
    .filter(Boolean)
    .join(" ");
}

const RUN_REASONS: Record<string, string> = {
  auth_expired: "The saved login has expired",
  bot_wall: "The site showed an anti-bot check or refused the request",
  robots_disallowed: "The site's robots.txt does not allow this",
  locator_not_found: "An element could not be found",
  navigation_failed: "A page could not be loaded",
  item_errors: "Some jobs could not be read",
  run_cancelled: "Cancelled",
  run_timeout: "Took too long",
  interrupted: "The server was restarted while it was running",
  required_field_missing: "A required field was empty",
  not_found: "The board was not found",
  internal_error: "Something went wrong inside JobTrace",
};

export const reasonText = (reason: string | null | undefined) =>
  reason ? (RUN_REASONS[reason] ?? reason.replaceAll("_", " ")) : "";
