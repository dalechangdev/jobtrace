import { JobTraceError } from "@jobtrace/core";

/**
 * A JobTrace server to send results to, for when the server runs somewhere
 * without a screen (a container): browsers open here, results go there.
 */
export interface Remote {
  url: string;
  send<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T>;
}

export function remoteFrom(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): Remote | null {
  const raw = flag ?? env.JOBTRACE_SERVER;
  if (!raw) return null;
  let url: string;
  try {
    url = new URL(raw).origin;
  } catch {
    throw new JobTraceError(
      "INVALID_ARGUMENT",
      `"${raw}" is not a valid server address, e.g. http://127.0.0.1:4317`,
    );
  }
  const token = env.JOBTRACE_TOKEN ?? env.API_TOKEN;
  return {
    url,
    async send<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
      let response: Response;
      try {
        response = await fetch(`${url}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new JobTraceError(
          "NAVIGATION_FAILED",
          `Could not reach the JobTrace server at ${url}. Is it running?`,
          { cause: error },
        );
      }
      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      if (!response.ok) {
        const message = (data as { error?: { message?: string } } | undefined)?.error?.message;
        throw new JobTraceError(
          response.status === 404 ? "NOT_FOUND" : "INVALID_ARGUMENT",
          `The server at ${url} refused: ${message ?? `HTTP ${response.status}`}`,
        );
      }
      return data as T;
    },
  };
}
