import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { jobsFor, type RunningTestSites, startTestSites } from "@jobtrace/test-sites";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "./main.ts";
import { exitCodeFor, parseParams } from "./run-command.ts";

const example = (name: string) =>
  fileURLToPath(new URL(`../../../examples/recordings/${name}.jobtrace.json`, import.meta.url));

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

let sites: RunningTestSites;
let dataDir: string;

beforeAll(async () => {
  sites = await startTestSites();
  dataDir = mkdtempSync(join(tmpdir(), "jobtrace-cli-"));
});
afterAll(async () => {
  await sites?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function cli(...argv: string[]) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { DATA_DIR: dataDir, LOG_LEVEL: "info" },
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe("jobtrace run", () => {
  it("prints the extracted jobs as JSON and logs to stderr", async () => {
    const result = await cli("run", example("static-list"), "--param", `baseUrl=${sites.origin}`);
    expect(result.code).toBe(0);
    const jobs = JSON.parse(result.stdout) as Array<{ title: string }>;
    expect(jobs.map((job) => job.title)).toEqual(jobsFor("staticList").map((job) => job.title));
    const lastLog = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "{}");
    expect(lastLog).toMatchObject({ type: "run_finished", data: { status: "succeeded" } });
  });

  it("applies limits and prints a summary on request", async () => {
    const result = await cli(
      "run",
      example("paginated"),
      "--param",
      `baseUrl=${sites.origin}`,
      "--max-items",
      "3",
      "--summary",
    );
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({ status: "succeeded", stats: { jobs: 3 } });
    expect(summary.jobs).toHaveLength(3);
  });

  it("exits 1 with a readable message for a missing or invalid recording", async () => {
    const missing = await cli("run", join(dataDir, "nope.jobtrace.json"));
    expect(missing).toMatchObject({ code: 1, stdout: "" });
    expect(missing.stderr).toMatch(/Cannot read recording file/);

    const file = join(dataDir, "bad.jobtrace.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        id: "x",
        name: "x",
        startUrl: "x",
        steps: [{ id: "a", type: "teleport" }],
      }),
    );
    const invalid = await cli("run", file);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/Invalid recording/);
  });

  it("exits 1 and still prints JSON when the run fails", async () => {
    const result = await cli(
      "run",
      example("static-list"),
      "--param",
      `baseUrl=${sites.origin}/missing`,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stderr).toMatch(/HTTP 404/);
  });

  it("rejects malformed options", async () => {
    expect((await cli("run", example("static-list"), "--param", "novalue")).stderr).toMatch(
      /key=value/,
    );
    expect((await cli("run", example("static-list"), "--max-pages", "0")).code).toBe(1);
    expect((await cli("run")).code).toBe(1);
  });
});

describe("helpers", () => {
  it("maps statuses to exit codes", () => {
    expect([
      exitCodeFor("succeeded"),
      exitCodeFor("partial"),
      exitCodeFor("failed"),
      exitCodeFor("blocked"),
    ]).toEqual([0, 2, 1, 1]);
  });

  it("parses params, keeping '=' inside values", () => {
    expect(parseParams(["a=1", "url=https://x.example/?q=1"])).toEqual({
      a: "1",
      url: "https://x.example/?q=1",
    });
  });
});
