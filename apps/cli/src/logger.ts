import type { Config, RunEvent } from "@jobtrace/core";
import pino from "pino";

export interface Logger {
  event(event: RunEvent): void;
  error(message: string): void;
}

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;

/**
 * Logs go to stderr so stdout stays clean for results. On a terminal they are
 * short readable lines; otherwise pino JSON, one object per line.
 */
export function createLogger(
  level: Config["logLevel"],
  stderr: NodeJS.WritableStream & { isTTY?: boolean },
): Logger {
  if (stderr.isTTY) {
    const threshold = LEVELS.indexOf(level);
    const write = (eventLevel: RunEvent["level"], message: string, stepId?: string) => {
      if (LEVELS.indexOf(eventLevel) < threshold) return;
      const time = new Date().toTimeString().slice(0, 8);
      stderr.write(`${time} ${eventLevel.padEnd(5)} ${stepId ? `[${stepId}] ` : ""}${message}\n`);
    };
    return {
      event: (event) => write(event.level, event.message, event.stepId),
      error: (message) => write("error", message),
    };
  }
  const logger = pino({ level, base: null }, stderr);
  return {
    event: ({ level: eventLevel, message, ts: _ts, ...rest }) => logger[eventLevel](rest, message),
    error: (message) => logger.error(message),
  };
}
