const DAY_MS = 86_400_000;

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;
const MONTH_NAME = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const ORDINAL = "(?:st|nd|rd|th)?";

const UNIT_DAYS: Record<string, number> = {
  minute: 0,
  min: 0,
  hour: 0,
  hr: 0,
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

function utcDate(year: number, monthIndex: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, monthIndex, day));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === monthIndex &&
    date.getUTCDate() === day;
  return valid ? date : null;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS);
}

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
}

/**
 * Best-effort parse of a posting date. Understands ISO dates, month-name dates,
 * numeric dates, and relative phrases ("3 days ago", "yesterday", "30+ days ago")
 * resolved against `now`. Results are UTC midnight unless the text carries a full
 * ISO timestamp. Slash dates are read as US month/day unless the first number is
 * above 12; dotted dates are read as day.month.
 */
export function parseDate(text: string, now: Date = new Date()): Date | null {
  const input = text.trim().toLowerCase();
  if (input === "") return null;
  const today = startOfUtcDay(now);

  const isoDateTime =
    /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?/.exec(input);
  if (isoDateTime) {
    const parsed = new Date(isoDateTime[0].toUpperCase());
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const iso = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(input);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  if (/\b(?:just now|today|moments? ago|just posted)\b/.test(input)) return today;
  if (/\byesterday\b/.test(input)) return new Date(today.getTime() - DAY_MS);

  const relative =
    /(\d+|an?|one|few)\s*\+?\s*(minute|min|hour|hr|day|week|month|year)s?\s+ago/.exec(input);
  if (relative) {
    const amount = /^\d+$/.test(relative[1] as string) ? Number(relative[1]) : 1;
    const days = amount * (UNIT_DAYS[relative[2] as string] ?? 0);
    return new Date(today.getTime() - days * DAY_MS);
  }

  const dayMonth = new RegExp(`(\\d{1,2})${ORDINAL}\\s+${MONTH_NAME},?(?:\\s+(\\d{4}))?`).exec(
    input,
  );
  const monthDay = new RegExp(`${MONTH_NAME}\\s+(\\d{1,2})${ORDINAL}(?:,?\\s+(\\d{4}))?`).exec(
    input,
  );
  const named = dayMonth
    ? { day: dayMonth[1], month: dayMonth[2], year: dayMonth[3] }
    : monthDay
      ? { day: monthDay[2], month: monthDay[1], year: monthDay[3] }
      : null;
  if (named) {
    const month = monthIndex(named.month as string);
    const day = Number(named.day);
    if (named.year) return utcDate(Number(named.year), month, day);
    // No year: the most recent such date that is not in the future.
    const thisYear = utcDate(today.getUTCFullYear(), month, day);
    if (thisYear && thisYear.getTime() <= today.getTime()) return thisYear;
    return utcDate(today.getUTCFullYear() - 1, month, day);
  }

  const dotted = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(input);
  if (dotted) return utcDate(Number(dotted[3]), Number(dotted[2]) - 1, Number(dotted[1]));

  const slashed = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(input);
  if (slashed) {
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    const year = Number(slashed[3]);
    return first > 12 ? utcDate(year, second - 1, first) : utcDate(year, first - 1, second);
  }

  return null;
}
