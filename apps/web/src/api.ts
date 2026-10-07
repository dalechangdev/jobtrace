import type {
  ApiAuthProfile,
  ApiEvent,
  ApiJob,
  ApiPage,
  ApiRecordingDetail,
  ApiRecordingListItem,
  ApiRun,
  ApiRunDetail,
  ApiSchedule,
  ApiSession,
  ApiSettings,
  ApiSuggestion,
  ApiTestStepResult,
  ApiVersion,
  RuntimeSettings,
} from "@jobtrace/api";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = "jobtrace.apiToken";

/** Only needed when the server is exposed beyond localhost with an API token. */
export const token = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
      return "";
    }
  },
  set: (value: string) => localStorage.setItem(TOKEN_KEY, value),
};

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const saved = token.get();
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(saved ? { authorization: `Bearer ${saved}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "ERROR",
      error?.message ?? `Request failed (${response.status})`,
    );
  }
  return data as T;
}

const get = <T>(url: string) => request<T>("GET", url);
const query = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "" && value !== false) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

export interface JobSearch {
  recording?: string;
  new?: boolean;
  q?: string;
  from?: string;
  to?: string;
  closed?: boolean;
  remote?: string;
  page?: number;
  pageSize?: number;
}

export type Definition = Record<string, unknown>;

export const api = {
  health: () => get<{ status: "ok"; activeRuns: number; queuedRuns: number }>("/api/health"),
  recordings: {
    list: () => get<ApiRecordingListItem[]>("/api/recordings"),
    get: (id: string) => get<ApiRecordingDetail>(`/api/recordings/${id}`),
    create: (definition: Definition) =>
      request<ApiRecordingDetail>("POST", "/api/recordings", definition),
    update: (id: string, definition: Definition) =>
      request<ApiRecordingDetail>("PUT", `/api/recordings/${id}`, definition),
    remove: (id: string) => request<void>("DELETE", `/api/recordings/${id}`),
    versions: (id: string) => get<ApiVersion[]>(`/api/recordings/${id}/versions`),
    version: (id: string, versionId: string) =>
      get<Definition>(`/api/recordings/${id}/versions/${versionId}`),
    run: (
      id: string,
      options: { headed?: boolean; trace?: boolean; params?: Record<string, string> } = {},
    ) => request<ApiRun>("POST", `/api/recordings/${id}/runs`, options),
    testStep: (id: string, stepId: string) =>
      request<ApiTestStepResult>("POST", `/api/recordings/${id}/test-step`, { stepId }),
    record: (input: { url: string; name?: string; authProfileId?: string }) =>
      request<ApiSession>("POST", "/api/recordings/record", input),
    addSource: (input: {
      provider: string;
      boardToken: string;
      name?: string;
      company?: string;
      baseUrl?: string;
    }) => request<ApiRecordingDetail>("POST", "/api/sources", input),
  },
  runs: {
    list: (filter: { recording?: string; status?: string; limit?: number } = {}) =>
      get<ApiRun[]>(`/api/runs${query(filter)}`),
    get: (id: string) => get<ApiRunDetail>(`/api/runs/${id}`),
    events: (id: string) => get<ApiEvent[]>(`/api/runs/${id}/events`),
    cancel: (id: string) => request<ApiRun>("POST", `/api/runs/${id}/cancel`),
    suggestions: (id: string) => get<ApiSuggestion[]>(`/api/runs/${id}/suggestions`),
    acceptSuggestion: (id: string, index: number) =>
      request<ApiSuggestion[]>("POST", `/api/runs/${id}/suggestions/${index}/accept`),
    streamUrl: (id: string) =>
      `/api/runs/${id}/events/stream${query({ access_token: token.get() })}`,
    artifactUrl: (runId: string, artifactId: string) =>
      `/api/runs/${runId}/artifacts/${artifactId}`,
  },
  jobs: {
    list: (search: JobSearch) => get<ApiPage<ApiJob>>(`/api/jobs${query({ ...search })}`),
    exportUrl: (search: JobSearch, format: "csv" | "json") => {
      const { page: _page, pageSize: _size, ...filters } = search;
      return `/api/jobs/export${query({ ...filters, format })}`;
    },
  },
  auth: {
    list: () => get<ApiAuthProfile[]>("/api/auth-profiles"),
    create: (input: { name: string; url: string }) =>
      request<ApiSession>("POST", "/api/auth-profiles", input),
    refresh: (id: string, url?: string) =>
      request<ApiSession>("POST", `/api/auth-profiles/${id}/refresh`, url ? { url } : {}),
    remove: (id: string) => request<void>("DELETE", `/api/auth-profiles/${id}`),
  },
  sessions: {
    get: (id: string) => get<ApiSession>(`/api/record-sessions/${id}`),
    stop: (id: string) => request<ApiSession>("POST", `/api/record-sessions/${id}/stop`),
  },
  schedules: {
    list: (recording?: string) => get<ApiSchedule[]>(`/api/schedules${query({ recording })}`),
    preview: (cron: string, timezone?: string) =>
      get<{ description: string; effectiveTimezone: string; nextRuns: string[] }>(
        `/api/schedules/preview${query({ cron, timezone })}`,
      ),
    create: (input: { recordingId: string; cron: string; timezone?: string | null }) =>
      request<ApiSchedule>("POST", "/api/schedules", input),
    update: (id: string, patch: { cron?: string; timezone?: string | null; enabled?: boolean }) =>
      request<ApiSchedule>("PUT", `/api/schedules/${id}`, patch),
    remove: (id: string) => request<void>("DELETE", `/api/schedules/${id}`),
  },
  settings: {
    get: () => get<ApiSettings>("/api/settings"),
    update: (patch: Partial<RuntimeSettings>) =>
      request<ApiSettings>("PUT", "/api/settings", patch),
  },
};
