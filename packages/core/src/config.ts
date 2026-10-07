import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { JobTraceError } from "./errors.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const blankToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const intWithDefault = (fallback: number, min = 0) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).default(fallback));
const boolWithDefault = (fallback: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .enum(["true", "false", "1", "0"])
      .default(fallback ? "true" : "false")
      .transform((value) => value === "true" || value === "1"),
  );

const envSchema = z.object({
  DATA_DIR: optionalString,
  DATABASE_URL: optionalString,
  HOST: z.preprocess(blankToUndefined, z.string().default("127.0.0.1")),
  PORT: intWithDefault(4317, 1),
  API_TOKEN: optionalString,
  ALLOWED_HOSTS: optionalString,
  HEADLESS_ONLY: boolWithDefault(false),
  MAX_CONCURRENT_RUNS: intWithDefault(2, 1),
  DEFAULT_MIN_DELAY_MS: intWithDefault(1000),
  DEFAULT_MAX_DELAY_MS: intWithDefault(3000),
  ARTIFACT_RETENTION_RUNS: intWithDefault(20, 1),
  AI_FALLBACK_ENABLED: boolWithDefault(false),
  ANTHROPIC_API_KEY: optionalString,
  AI_FALLBACK_MODEL: optionalString,
  AI_FALLBACK_MAX_CALLS: intWithDefault(10),
  AI_FALLBACK_AUTO_APPLY: boolWithDefault(false),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  ),
});

export interface Config {
  dataDir: string;
  databaseUrl: string;
  host: string;
  port: number;
  apiToken: string | undefined;
  /**
   * Host names the server answers to, when it is bound to all interfaces but
   * only published locally (as in Docker). Empty means "not restricted this way".
   */
  allowedHosts: string[];
  /** True where there is no screen (a container): browser windows cannot be opened. */
  headlessOnly: boolean;
  maxConcurrentRuns: number;
  defaultMinDelayMs: number;
  defaultMaxDelayMs: number;
  artifactRetentionRuns: number;
  aiFallback: {
    enabled: boolean;
    apiKey: string | undefined;
    model: string | undefined;
    /** Most Claude calls one run may make. */
    maxCalls: number;
    /** Save a healed locator into the recording once the run succeeded, without asking. */
    autoApply: boolean;
  };
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Whether the server can show a browser window to the person using it: it is
 * on their own computer (bound to loopback) and that computer has a screen.
 */
export function canOpenWindows(config: Pick<Config, "host" | "headlessOnly">): boolean {
  return isLoopbackHost(config.host) && !config.headlessOnly;
}

function expandPath(path: string, cwd: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Builds the configuration from an environment object. Apps pass `process.env`
 * (with CLI flags merged over it); library packages never read env themselves.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new JobTraceError(
      "INVALID_CONFIG",
      `Invalid configuration:\n${z.prettifyError(result.error)}`,
    );
  }
  const values = result.data;
  if (values.DEFAULT_MIN_DELAY_MS > values.DEFAULT_MAX_DELAY_MS) {
    throw new JobTraceError(
      "INVALID_CONFIG",
      "DEFAULT_MIN_DELAY_MS must not exceed DEFAULT_MAX_DELAY_MS",
    );
  }
  const allowedHosts = (values.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  // Reachable from other machines unless it only answers to loopback names,
  // which is the case for a container published on 127.0.0.1.
  const localOnly =
    isLoopbackHost(values.HOST) || (allowedHosts.length > 0 && allowedHosts.every(isLoopbackHost));
  if (!localOnly && !values.API_TOKEN) {
    throw new JobTraceError(
      "INVALID_CONFIG",
      `API_TOKEN is required when HOST (${values.HOST}) is not a loopback address, unless ALLOWED_HOSTS limits the server to localhost names`,
    );
  }
  const dataDir = expandPath(values.DATA_DIR ?? "~/.jobtrace", cwd);
  return {
    dataDir,
    databaseUrl: values.DATABASE_URL ?? `file:${join(dataDir, "jobtrace.db")}`,
    host: values.HOST,
    port: values.PORT,
    apiToken: values.API_TOKEN,
    allowedHosts,
    headlessOnly: values.HEADLESS_ONLY,
    maxConcurrentRuns: values.MAX_CONCURRENT_RUNS,
    defaultMinDelayMs: values.DEFAULT_MIN_DELAY_MS,
    defaultMaxDelayMs: values.DEFAULT_MAX_DELAY_MS,
    artifactRetentionRuns: values.ARTIFACT_RETENTION_RUNS,
    aiFallback: {
      enabled: values.AI_FALLBACK_ENABLED,
      apiKey: values.ANTHROPIC_API_KEY,
      model: values.AI_FALLBACK_MODEL,
      maxCalls: values.AI_FALLBACK_MAX_CALLS,
      autoApply: values.AI_FALLBACK_AUTO_APPLY,
    },
    logLevel: values.LOG_LEVEL,
  };
}
