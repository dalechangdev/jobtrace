import type { SalaryPeriod } from "@jobtrace/core";

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  /** ISO 4217 code. */
  currency: string | null;
  period: SalaryPeriod | null;
}

const EMPTY: ParsedSalary = { min: null, max: null, currency: null, period: null };

/** Checked in order, so prefixed dollar signs win over the bare "$". */
const CURRENCY_SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:CA|C)\$/i, "CAD"],
  [/\b(?:AU|A)\$/i, "AUD"],
  [/\bNZ\$/i, "NZD"],
  [/\bS\$/i, "SGD"],
  [/€/, "EUR"],
  [/£/, "GBP"],
  [/₹/, "INR"],
  [/¥/, "JPY"],
  [/zł/i, "PLN"],
  [/\$/, "USD"],
];
const CURRENCY_CODES =
  /\b(USD|EUR|GBP|CAD|AUD|NZD|SGD|CHF|JPY|INR|SEK|NOK|DKK|PLN|CZK|BRL|MXN|ILS|ZAR)\b/i;

const PERIODS: ReadonlyArray<readonly [RegExp, SalaryPeriod]> = [
  [/(?:\bper|\ban?|\/)\s*(?:hour|hr|h)\b|\bhourly\b/i, "hour"],
  [/(?:\bper|\ba|\/)\s*day\b|\bdaily\b/i, "day"],
  [/(?:\bper|\ba|\/)\s*(?:week|wk)\b|\bweekly\b/i, "week"],
  [/(?:\bper|\ba|\/)\s*(?:month|mo)\b|\bmonthly\b/i, "month"],
  [
    /(?:\bper|\ba|\/)\s*(?:year|yr|annum|y)\b|\bannual(?:ly)?\b|\byearly\b|\bp\.?a\.?(?:\s|$)/i,
    "year",
  ],
];

// Either a thousands-grouped number (85,000 / 85.000 / 85 000, optional decimals)
// or a plain one (65 / 65.50), followed by an optional k or m multiplier.
const NUMBER = /(\d{1,3}(?:[,.\s ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?)\s*(k|m)?(?![a-z\d])/gi;

interface Amount {
  value: number;
  scaled: boolean;
}

function toAmount(digits: string, suffix: string | undefined): Amount {
  const grouped = /^\d{1,3}(?:[,.\s ]\d{3})+/.exec(digits);
  let value: number;
  if (grouped) {
    const whole = grouped[0].replace(/[,.\s ]/g, "");
    const fraction = digits.slice(grouped[0].length).replace(/[.,]/, "");
    value = Number(fraction ? `${whole}.${fraction}` : whole);
  } else {
    value = Number(digits.replace(",", "."));
  }
  const multiplier = suffix?.toLowerCase() === "k" ? 1_000 : suffix ? 1_000_000 : 1;
  return { value: value * multiplier, scaled: multiplier > 1 };
}

/**
 * Best-effort parse of salary text such as "€85,000 - €110,000 per year",
 * "$140k–$180k" or "£45/hour". Returns all nulls when the text does not look
 * like a salary (no currency and no pay period).
 */
export function parseSalary(text: string): ParsedSalary {
  const currency =
    CURRENCY_SYMBOLS.find(([pattern]) => pattern.test(text))?.[1] ??
    CURRENCY_CODES.exec(text)?.[1]?.toUpperCase() ??
    null;
  let period = PERIODS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
  if (currency === null && period === null) return EMPTY;

  const amounts = [...text.matchAll(NUMBER)]
    .map((match) => toAmount(match[1] as string, match[2]))
    .filter((amount) => Number.isFinite(amount.value) && amount.value > 0)
    .slice(0, 2);
  const [first, second] = amounts;
  if (!first) return EMPTY;

  // "$140-180k": the multiplier is written once but applies to both ends.
  if (second?.scaled && !first.scaled && first.value < 1000) {
    first.value *= second.value >= 1_000_000 ? 1_000_000 : 1_000;
  }

  let min: number | null = first.value;
  let max: number | null = second?.value ?? first.value;
  if (second && second.value < first.value) max = first.value;
  if (!second) {
    if (/\b(?:up to|max(?:imum)?|under)\b/i.test(text)) min = null;
    else if (/\b(?:from|min(?:imum)?|starting at|over)\b|\d\s*(?:k|m)?\s*\+/i.test(text))
      max = null;
  }

  // Annual pay is commonly quoted without a period.
  if (period === null && (min ?? max ?? 0) >= 10_000) period = "year";
  return { min, max, currency, period };
}

/** Compact, stable rendering of a parsed salary, e.g. "85000-110000 EUR/year". */
export function formatSalary(salary: ParsedSalary): string | null {
  if (salary.min === null && salary.max === null) return null;
  const range =
    salary.min === salary.max
      ? String(salary.min)
      : salary.min === null
        ? `<=${salary.max}`
        : salary.max === null
          ? `>=${salary.min}`
          : `${salary.min}-${salary.max}`;
  return [range, [salary.currency, salary.period].filter(Boolean).join("/")]
    .filter(Boolean)
    .join(" ");
}
