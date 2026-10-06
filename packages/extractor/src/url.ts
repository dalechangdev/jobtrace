const TRACKING_PARAMS = new Set(["gh_src", "source", "ref", "fbclid", "gclid", "mc_cid", "mc_eid"]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/** Resolves a possibly relative URL against a base. Returns null when it is not an http(s) URL. */
export function absoluteUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Canonical form of a job URL, used as the dedup key: lowercased host, tracking
 * parameters and fragment removed, remaining parameters sorted, trailing slash
 * dropped. Returns null when the value is not an http(s) URL.
 */
export function canonicalizeUrl(value: string, base?: string): string | null {
  const absolute = absoluteUrl(value, base);
  if (absolute === null) return null;
  const url = new URL(absolute);
  url.hash = "";
  url.username = "";
  url.password = "";
  const kept = [...url.searchParams.entries()].filter(([name]) => !isTrackingParam(name));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = new URLSearchParams(kept).toString();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}
