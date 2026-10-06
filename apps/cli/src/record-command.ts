import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JobTraceError, RECORDING_FILE_EXTENSION } from "@jobtrace/core";
import { type RecorderOptions, type RecordingSession, startRecording } from "@jobtrace/recorder";
import type { Logger } from "./logger.ts";

export interface RecordCommandOptions {
  name?: string;
  out?: string;
  force?: boolean;
}

export interface RecordCommandIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  logger: Logger;
  signal?: AbortSignal;
  cwd?: string;
  /** Tests: run headless and drive the session from a script. */
  recorder?: Pick<RecorderOptions, "headless" | "openShadow" | "browser">;
  onSession?: (session: RecordingSession) => void;
}

/** Accepts `careers.example.com/jobs` as well as full URLs. */
export function normalizeUrl(input: string): string {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new JobTraceError("INVALID_CONFIG", `"${input}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new JobTraceError(
      "INVALID_CONFIG",
      `Only http and https URLs can be recorded, got "${input}"`,
    );
  }
  return url.href;
}

export function defaultFileName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "recording"}${RECORDING_FILE_EXTENSION}`;
}

/**
 * `jobtrace record <url>`: opens a browser with the recorder toolbar, waits for
 * the user to press Stop (or Ctrl+C, or close the window), then writes the
 * recording file and prints its path on stdout.
 */
export async function recordCommand(
  input: string,
  options: RecordCommandOptions,
  io: RecordCommandIo,
): Promise<number> {
  const url = normalizeUrl(input);
  const cwd = io.cwd ?? process.cwd();
  // Checked before recording starts: nobody wants to lose a session to a file clash.
  if (options.out && existsSync(resolve(cwd, options.out)) && !options.force) {
    throw new JobTraceError(
      "INVALID_CONFIG",
      `${options.out} already exists. Pass --force to overwrite it.`,
    );
  }

  const session = await startRecording({
    url,
    ...(options.name ? { name: options.name } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
    ...io.recorder,
    onEvent: (event) => io.logger.event({ ts: new Date().toISOString(), ...event }),
  });
  io.stderr.write(
    "Recording. Use the toolbar in the browser window:\n" +
      "  Record      capture clicks, typing and navigation\n" +
      "  Mark field  click a piece of data (title, location, ...) to extract it\n" +
      "  Stop        finish and save (Ctrl+C here or closing the window also works)\n",
  );
  io.onSession?.(session);
  const { recording, samples, warnings } = await session.finished;

  let file = resolve(cwd, options.out ?? defaultFileName(recording.name));
  if (!options.out && !options.force) {
    // No explicit target: never overwrite, pick the next free name instead.
    const base = file.slice(0, -RECORDING_FILE_EXTENSION.length);
    for (let n = 2; existsSync(file); n++) file = `${base}-${n}${RECORDING_FILE_EXTENSION}`;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(recording, null, 2)}\n`);

  const fields = Object.entries(samples);
  io.stderr.write(
    `\nSaved "${recording.name}": ${recording.steps.length} step(s), ${fields.length} field(s)\n`,
  );
  for (const [name, value] of fields) {
    const preview = (value ?? "").replace(/\s+/g, " ").trim();
    io.stderr.write(`  ${name}: ${preview.length > 70 ? `${preview.slice(0, 70)}…` : preview}\n`);
  }
  for (const warning of warnings) io.stderr.write(`warning: ${warning}\n`);
  if (fields.length === 0) {
    io.stderr.write(
      "warning: no fields were marked, so replaying this recording will not extract any jobs.\n",
    );
  }
  io.stderr.write(`\nReplay it with: jobtrace run ${options.out ?? file}\n`);
  io.stdout.write(`${file}\n`);
  return 0;
}
