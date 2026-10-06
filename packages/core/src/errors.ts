/** Stable error codes. They are persisted with runs and shown in the UI, so never rename one. */
export const ERROR_CODES = [
  "INVALID_RECORDING",
  "UNSUPPORTED_SCHEMA_VERSION",
  "INVALID_CONFIG",
  "TEMPLATE_ERROR",
  "LOCATOR_NOT_FOUND",
  "STEP_FAILED",
  "NAVIGATION_FAILED",
  "REQUIRED_FIELD_MISSING",
  "RUN_TIMEOUT",
  "RUN_CANCELLED",
  "AUTH_EXPIRED",
  "ROBOTS_DISALLOWED",
  "BOT_WALL",
  "NOT_FOUND",
  "INVALID_ARGUMENT",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface JobTraceErrorOptions {
  cause?: unknown;
  /** Structured context, e.g. the locators that were tried. Must be JSON-serializable. */
  details?: Record<string, unknown>;
  stepId?: string;
}

export class JobTraceError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  stepId: string | undefined;

  constructor(code: ErrorCode, message: string, options: JobTraceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JobTraceError";
    this.code = code;
    this.details = options.details;
    this.stepId = options.stepId;
  }

  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      ...(this.stepId === undefined ? {} : { stepId: this.stepId }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export interface SerializedError {
  code: ErrorCode;
  message: string;
  stepId?: string;
  details?: Record<string, unknown>;
}

export function isJobTraceError(error: unknown, code?: ErrorCode): error is JobTraceError {
  return error instanceof JobTraceError && (code === undefined || error.code === code);
}

/** Wraps any thrown value as a JobTraceError, keeping existing ones intact. */
export function toJobTraceError(
  error: unknown,
  fallback: ErrorCode = "STEP_FAILED",
): JobTraceError {
  if (error instanceof JobTraceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new JobTraceError(fallback, message, { cause: error });
}
