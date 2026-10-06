import { JobTraceError } from "@jobtrace/core";
import { Cron } from "croner";

/** A schedule may not fire more often than this: scheduled runs repeat forever, so they must be gentle. */
export const MIN_INTERVAL_MS = 15 * 60_000;

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The time zone a schedule is read in: its own, or the server's when it has none. */
export const resolveTimezone = (timezone: string | null | undefined) =>
  timezone || systemTimezone();

/** The next `count` times a schedule fires, from `from`. Throws on an invalid expression or time zone. */
export function nextRuns(
  cron: string,
  timezone: string | null,
  count: number,
  from: Date = new Date(),
): Date[] {
  return new Cron(cron, { timezone: resolveTimezone(timezone), paused: true }).nextRuns(
    count,
    from,
  );
}

/**
 * Checks a schedule before it is stored: five-field cron syntax, a real time
 * zone, at least one future run, and not more often than every 15 minutes.
 */
export function validateSchedule(cron: string, timezone: string | null): void {
  const fail = (message: string): never => {
    throw new JobTraceError("INVALID_ARGUMENT", message);
  };
  if (cron.trim().split(/\s+/).length !== 5) {
    fail(
      `A schedule needs five fields (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5"; got "${cron}".`,
    );
  }
  let runs: Date[];
  try {
    runs = nextRuns(cron, timezone, 25);
  } catch (error) {
    const message = (error as Error).message;
    throw new JobTraceError(
      "INVALID_ARGUMENT",
      /timezone|time zone/i.test(message)
        ? `"${timezone}" is not a known time zone. Use a name like Europe/Madrid.`
        : `"${cron}" is not a valid schedule: ${message.replace(/^Cron\w*: /, "")}`,
    );
  }
  if (runs.length === 0) fail(`"${cron}" never fires.`);
  for (let index = 1; index < runs.length; index++) {
    const gap = (runs[index] as Date).getTime() - (runs[index - 1] as Date).getTime();
    if (gap < MIN_INTERVAL_MS) {
      fail(
        `"${cron}" would run every ${Math.round(gap / 60_000)} minute(s). Schedules may fire at most every ${MIN_INTERVAL_MS / 60_000} minutes.`,
      );
    }
  }
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const isNumber = (value: string) => /^\d+$/.test(value);
const list = (values: string[]) =>
  values.length <= 1 ? (values[0] ?? "") : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
const clock = (hour: string, minute: string) =>
  `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

function days(field: string): string | null {
  if (field === "*") return "Every day";
  if (field === "1-5") return "Weekdays";
  if (["0,6", "6,0", "6,7"].includes(field)) return "Weekends";
  const numbers = field.split(",");
  if (!numbers.every((value) => isNumber(value) && Number(value) <= 7)) return null;
  return list(numbers.map((value) => DAYS[Number(value) % 7] as string));
}

/**
 * A schedule in words, e.g. "Weekdays at 08:00 Europe/Madrid". Covers the
 * common shapes; anything else is shown as the expression itself.
 */
export function describeCron(cron: string, timezone: string | null): string {
  const zone = resolveTimezone(timezone);
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = cron
    .trim()
    .split(/\s+/);
  const describe = (): string | null => {
    if (month !== "*") return null;
    const everyMinutes = /^\*\/(\d+)$/.exec(minute);
    if (everyMinutes && hour === "*" && dayOfMonth === "*" && dayOfWeek === "*")
      return `Every ${everyMinutes[1]} minutes`;
    if (!isNumber(minute)) return null;
    if (dayOfMonth === "*" && dayOfWeek === "*") {
      if (hour === "*") return `Every hour at :${minute.padStart(2, "0")}`;
      const everyHours = /^\*\/(\d+)$/.exec(hour);
      if (everyHours) return `Every ${everyHours[1]} hours at :${minute.padStart(2, "0")}`;
    }
    const hours = hour.split(",");
    if (!hours.every(isNumber)) return null;
    const times = list(hours.map((value) => clock(value, minute)));
    if (dayOfMonth === "*") {
      const when = days(dayOfWeek);
      return when ? `${when} at ${times}` : null;
    }
    if (dayOfWeek === "*" && dayOfMonth.split(",").every(isNumber)) {
      return `On day ${list(dayOfMonth.split(","))} of every month at ${times}`;
    }
    return null;
  };
  return `${describe() ?? `Custom schedule (${cron})`} ${zone}`;
}
