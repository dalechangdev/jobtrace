/** Retry-After as milliseconds: the header is either a number of seconds or an HTTP date. */
export function retryAfterMs(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
