import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NormalizedJob, parseApiSource, parseRecording, type Recording } from "@jobtrace/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./sqlite.ts";
import { type Database, definitionOf, type StoredRunStats } from "./types.ts";

let db: Database;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => db.close());

function recording(id: string, name = "Acme Careers"): Recording {
  return parseRecording({
    schemaVersion: 1,
    id,
    name,
    startUrl: "https://careers.acme.example/jobs",
    steps: [{ id: "s1", type: "navigate", url: "https://careers.acme.example/jobs" }],
  });
}

function job(key: string, overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    recordingId: "rec_a",
    dedupKey: `https://careers.acme.example/jobs/${key}`,
    contentHash: `hash-${key}`,
    title: `Job ${key}`,
    company: "Acme Robotics",
    location: "Berlin, Germany",
    remote: "unknown",
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    url: `https://careers.acme.example/jobs/${key}`,
    description: `Description of job ${key}`,
    descriptionHtml: null,
    postedAt: null,
    employmentType: null,
    custom: {},
    ...overrides,
  };
}

const STATS: StoredRunStats = {
  pages: 1,
  itemsSeen: 0,
  itemErrors: 0,
  jobs: 0,
  durationMs: 1,
  newJobs: 0,
  changedJobs: 0,
  closedJobs: 0,
};

/** Simulates one finished run that saw the given jobs. */
async function run(
  jobs: NormalizedJob[],
  status: "succeeded" | "partial" | "failed" = "succeeded",
) {
  const created = await db.runs.create({ recordingId: "rec_a", trigger: "cli", status: "running" });
  const saved = await db.jobs.saveRunJobs({ runId: created.id, recordingId: "rec_a", jobs });
  await db.runs.finish(created.id, { status, stats: STATS });
  return { id: created.id, saved };
}

const flags = (saved: Awaited<ReturnType<typeof run>>["saved"]) =>
  saved.map((item) => `${item.title}:${item.isNew ? "new" : item.isChanged ? "changed" : "same"}`);

describe("recordings", () => {
  it("saves, versions and loads a recording", async () => {
    const first = await db.recordings.save(recording("rec_a"), "recorded");
    const second = await db.recordings.save({ ...recording("rec_a"), name: "Acme (renamed)" });
    expect([first.created, second.created]).toEqual([true, false]);

    const stored = await db.recordings.get("rec_a");
    expect(stored).toMatchObject({
      id: "rec_a",
      name: "Acme (renamed)",
      domain: "careers.acme.example",
      versionId: second.versionId,
    });
    expect(stored?.kind === "browser" && stored.recording.steps).toHaveLength(1);
    expect(
      (await db.recordings.versions("rec_a")).map((version) => [version.id, version.note]),
    ).toEqual([
      [second.versionId, null],
      [first.versionId, "recorded"],
    ]);
    expect(await db.recordings.get("rec_missing")).toBeNull();
  });

  it("stores API sources next to recordings", async () => {
    const source = parseApiSource({
      schemaVersion: 1,
      kind: "api",
      id: "src_acme",
      name: "Acme on Lever",
      provider: "lever",
      boardToken: "acme",
    });
    await db.recordings.save(recording("rec_a"));
    await db.recordings.save(source, "added");

    const stored = await db.recordings.resolve("acme on lever");
    expect(stored).toMatchObject({
      kind: "api",
      domain: "api.lever.co",
      startUrl: "https://api.lever.co/v0/postings/acme?mode=json",
      source: { provider: "lever", boardToken: "acme", settings: { maxItems: 5000 } },
    });
    expect(definitionOf(stored)).toEqual(source);
    expect((await db.recordings.list()).map((item) => [item.id, item.kind])).toEqual([
      ["rec_a", "browser"],
      ["src_acme", "api"],
    ]);
    const browser = await db.recordings.get("rec_a");
    expect(browser?.kind).toBe("browser");
    expect(browser && definitionOf(browser)).toMatchObject({
      id: "rec_a",
      steps: expect.any(Array),
    });
  });

  it("resolves by id, unique prefix or name", async () => {
    await db.recordings.save(recording("rec_alpha1", "Alpha"));
    await db.recordings.save(recording("rec_alpha2", "Beta"));
    await db.recordings.save(recording("rec_100%_x", "Gamma"));
    expect((await db.recordings.resolve("rec_alpha1")).name).toBe("Alpha");
    expect((await db.recordings.resolve("beta")).id).toBe("rec_alpha2");
    expect((await db.recordings.resolve("rec_100%")).name).toBe("Gamma");
    await expect(db.recordings.resolve("rec_alpha")).rejects.toThrow(/matches 2 recordings/);
    await expect(db.recordings.resolve("rec_")).rejects.toThrow(/matches 3 recordings/);
    await expect(db.recordings.resolve("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // "%" is not a wildcard, and very short prefixes are not accepted.
    await expect(db.recordings.resolve("rec_%")).rejects.toThrow(/No recording/);
    await expect(db.recordings.resolve("rec")).rejects.toThrow(/No recording/);
    expect((await db.recordings.list()).map((item) => item.name)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });

  it("deletes a recording with everything that belongs to it", async () => {
    await db.recordings.save(recording("rec_a"));
    const { id } = await run([job("1")]);
    await db.runs.addEvent(id, {
      ts: "2026-10-06T00:00:00.000Z",
      level: "info",
      type: "page",
      message: "Page 1",
    });
    await db.artifacts.add(id, [{ type: "screenshot", path: "/tmp/x.png" }]);

    expect(await db.recordings.delete("rec_a")).toEqual({ runIds: [id] });
    expect(await db.runs.get(id)).toBeNull();
    expect(await db.runs.events(id)).toEqual([]);
    expect(await db.jobs.count({ includeClosed: true })).toBe(0);
    expect(await db.jobs.list({ search: "job" })).toEqual([]);
    expect(await db.artifacts.forRun(id)).toEqual([]);
  });
});

describe("runs", () => {
  beforeEach(() => db.recordings.save(recording("rec_a")));

  it("tracks a run from queued to finished, with its events in order", async () => {
    const { versionId } = (await db.recordings.get("rec_a")) ?? {};
    const queued = await db.runs.create({
      recordingId: "rec_a",
      recordingVersionId: versionId,
      trigger: "manual",
      status: "queued",
      params: { keyword: "rust" },
    });
    expect(queued).toMatchObject({
      status: "queued",
      startedAt: null,
      params: { keyword: "rust" },
      stats: null,
    });
    await db.runs.markRunning(queued.id);
    await db.runs.addEvent(queued.id, {
      ts: "2026-10-06T00:00:01.000Z",
      level: "info",
      type: "page",
      message: "Page 1",
      stepId: "s2",
      data: { page: 1 },
    });
    await db.runs.addEvent(queued.id, {
      ts: "2026-10-06T00:00:00.000Z",
      level: "warn",
      type: "locator_drift",
      message: "Fallback",
    });
    const finished = await db.runs.finish(queued.id, {
      status: "partial",
      reason: "item_errors",
      stats: { ...STATS, jobs: 3, newJobs: 2 },
      error: { code: "STEP_FAILED", message: "boom", stepId: "s3" },
    });

    expect(finished).toMatchObject({
      status: "partial",
      reason: "item_errors",
      recordingVersionId: versionId,
      stats: { jobs: 3, newJobs: 2 },
      error: { code: "STEP_FAILED", stepId: "s3" },
    });
    expect(finished.startedAt).not.toBeNull();
    expect(finished.finishedAt).not.toBeNull();
    // Insertion order, not timestamp order: events are a log.
    expect(await db.runs.events(queued.id)).toEqual([
      {
        ts: "2026-10-06T00:00:01.000Z",
        level: "info",
        type: "page",
        message: "Page 1",
        stepId: "s2",
        data: { page: 1 },
      },
      { ts: "2026-10-06T00:00:00.000Z", level: "warn", type: "locator_drift", message: "Fallback" },
    ]);
  });

  it("lists newest first, filters by recording, and resolves id prefixes", async () => {
    await db.recordings.save(recording("rec_b", "Other"));
    const first = await db.runs.create({ recordingId: "rec_a", trigger: "cli", status: "running" });
    const second = await db.runs.create({
      recordingId: "rec_b",
      trigger: "cli",
      status: "running",
    });
    const third = await db.runs.create({ recordingId: "rec_a", trigger: "cli", status: "running" });
    expect((await db.runs.list()).map((item) => item.id)).toEqual([third.id, second.id, first.id]);
    expect((await db.runs.list({ recordingId: "rec_a", limit: 1 })).map((item) => item.id)).toEqual(
      [third.id],
    );
    expect((await db.runs.resolve(second.id)).recordingId).toBe("rec_b");
    await expect(db.runs.resolve("run_zzzz")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("jobs", () => {
  beforeEach(() => db.recordings.save(recording("rec_a")));

  it("flags new and changed jobs across runs", async () => {
    const first = await run([job("1"), job("2"), job("3")]);
    expect(flags(first.saved)).toEqual(["Job 1:new", "Job 2:new", "Job 3:new"]);

    const second = await run([
      job("1"),
      job("2", { contentHash: "hash-2b", salaryText: "€90,000", salaryMin: 90000 }),
      job("4"),
    ]);
    expect(flags(second.saved)).toEqual(["Job 1:same", "Job 2:changed", "Job 4:new"]);
    expect(flags(await db.jobs.forRun(second.id))).toEqual(flags(second.saved));
    expect(flags(await db.jobs.forRun(first.id))).toEqual(["Job 1:new", "Job 2:new", "Job 3:new"]);

    const changed = second.saved[1];
    expect(changed).toMatchObject({ salaryMin: 90000, firstSeenRunId: first.id });
    expect((changed?.lastSeenAt ?? "") >= (changed?.firstSeenAt ?? "x")).toBe(true);
    expect(await db.jobs.count()).toBe(4);
  });

  it("scopes dedup to the recording", async () => {
    await db.recordings.save(recording("rec_b", "Other"));
    await run([job("1")]);
    const other = await db.runs.create({ recordingId: "rec_b", trigger: "cli", status: "running" });
    const saved = await db.jobs.saveRunJobs({
      runId: other.id,
      recordingId: "rec_b",
      jobs: [job("1", { recordingId: "rec_b" })],
    });
    expect(saved[0]?.isNew).toBe(true);
    expect(await db.jobs.count({ recordingId: "rec_b" })).toBe(1);
  });

  it("closes jobs missing from the last N successful runs, and reopens them when seen again", async () => {
    await run([job("1"), job("2")]);
    await run([job("1")]);
    expect(await db.jobs.closeMissing("rec_a", 3)).toBe(0);
    await run([job("1")], "partial");
    await run([job("1")]);
    // Two successful runs without job 2 so far; the partial one does not count.
    expect(await db.jobs.closeMissing("rec_a", 3)).toBe(0);
    await run([job("1")]);
    expect(await db.jobs.closeMissing("rec_a", 3)).toBe(1);
    expect(await db.jobs.closeMissing("rec_a", 3)).toBe(0);

    expect((await db.jobs.list()).map((item) => item.title)).toEqual(["Job 1"]);
    const all = await db.jobs.list({ includeClosed: true });
    expect(all.find((item) => item.title === "Job 2")?.closedAt).not.toBeNull();

    const back = await run([job("1"), job("2")]);
    expect(flags(back.saved)).toEqual(["Job 1:same", "Job 2:same"]);
    expect(back.saved[1]?.closedAt).toBeNull();
    expect(await db.jobs.closeMissing("rec_a", 0)).toBe(0);
  });

  it("filters by latest run, first-seen time and full text", async () => {
    await db.recordings.save(recording("rec_b", "Other"));
    await run([
      job("1", { title: "Senior Backend Engineer" }),
      job("2", { title: "Product Designer" }),
    ]);
    const cutoff = new Date(Date.now() + 5).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await run([
      job("1", { title: "Senior Backend Engineer" }),
      job("3", { title: "Data Engineer", location: "Zürich", description: "Pipelines in Rust" }),
    ]);
    // A run still in progress is not "the latest run" yet.
    await db.runs.create({ recordingId: "rec_a", trigger: "cli", status: "running" });

    const titles = async (filter: Parameters<Database["jobs"]["list"]>[0]) =>
      (await db.jobs.list(filter)).map((item) => item.title);
    expect(await titles({ newInLatestRun: true })).toEqual(["Data Engineer"]);
    expect(await titles({ since: cutoff })).toEqual(["Data Engineer"]);
    expect(await titles({ search: "engineer" })).toEqual([
      "Data Engineer",
      "Senior Backend Engineer",
    ]);
    expect(await titles({ search: "back eng" })).toEqual(["Senior Backend Engineer"]);
    expect(await titles({ search: "zurich" })).toEqual(["Data Engineer"]);
    expect(await titles({ search: "rust" })).toEqual(["Data Engineer"]);
    expect(await titles({ search: 'weird "quotes" AND (' })).toEqual([]);
    expect(await titles({ recordingId: "rec_b" })).toEqual([]);
    expect(await titles({ limit: 1, offset: 1 })).toHaveLength(1);
    expect(await db.jobs.count({ search: "engineer" })).toBe(2);
  });

  it("keeps the search index in step with content changes", async () => {
    await run([job("1", { title: "Backend Engineer" })]);
    await run([job("1", { title: "Platform Engineer", contentHash: "hash-1b" })]);
    expect(await db.jobs.count({ search: "backend" })).toBe(0);
    expect(await db.jobs.count({ search: "platform" })).toBe(1);
    const [stored] = await db.jobs.list();
    expect(await db.jobs.get(stored?.id ?? "")).toMatchObject({ title: "Platform Engineer" });
    expect(await db.jobs.get("job_missing")).toBeNull();
  });
});

describe("artifacts", () => {
  it("keeps artifacts only for the newest runs of a recording", async () => {
    await db.recordings.save(recording("rec_a"));
    await db.recordings.save(recording("rec_b", "Other"));
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const { id } = await run([]);
      ids.push(id);
      // The third run produced no artifacts at all.
      if (index !== 2)
        await db.artifacts.add(id, [
          { type: "screenshot", path: `/a/${index}.png` },
          { type: "dom", path: `/a/${index}.html` },
        ]);
    }
    const other = await db.runs.create({ recordingId: "rec_b", trigger: "cli", status: "running" });
    await db.artifacts.add(other.id, [{ type: "trace", path: "/b/trace.zip" }]);

    expect(await db.artifacts.prune("rec_a", 2)).toEqual({ runIds: [ids[0], ids[1]] });
    expect(await db.artifacts.prune("rec_a", 2)).toEqual({ runIds: [] });
    expect(await db.artifacts.forRun(ids[0] ?? "")).toEqual([]);
    expect((await db.artifacts.forRun(ids[3] ?? "")).map((item) => item.type)).toEqual([
      "screenshot",
      "dom",
    ]);
    expect(await db.artifacts.forRun(other.id)).toHaveLength(1);
  });
});

describe("auth profiles", () => {
  const profile = (id: string, name: string) => ({
    id,
    name,
    domain: "careers.acme.example",
    storageStatePath: `/data/auth/${id}.json`,
  });

  it("saves, resolves, lists with usage, verifies and deletes", async () => {
    const saved = await db.authProfiles.save(profile("auth_1", "Acme"));
    expect(saved).toMatchObject({ id: "auth_1", name: "Acme", lastVerifiedAt: null });
    expect((await db.authProfiles.resolve("acme")).id).toBe("auth_1");
    expect((await db.authProfiles.resolve("auth_1")).name).toBe("Acme");
    await expect(db.authProfiles.resolve("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(db.authProfiles.save(profile("auth_2", "Acme"))).rejects.toThrow(/already exists/);

    await db.recordings.save({ ...recording("rec_a"), authProfileId: "auth_1" });
    // A profile id unknown to this database is kept in the definition but not linked.
    await db.recordings.save({ ...recording("rec_b", "Other"), authProfileId: "auth_elsewhere" });
    expect(await db.authProfiles.list()).toMatchObject([{ name: "Acme", usedBy: 1 }]);
    const other = await db.recordings.get("rec_b");
    expect(other?.kind === "browser" && other.recording.authProfileId).toBe("auth_elsewhere");

    await db.authProfiles.markVerified("auth_1");
    expect((await db.authProfiles.get("auth_1"))?.lastVerifiedAt).not.toBeNull();
    // Saving again (a refresh) resets the verification, keeping the creation time.
    const refreshed = await db.authProfiles.save(profile("auth_1", "Acme"));
    expect(refreshed).toMatchObject({ lastVerifiedAt: null, createdAt: saved.createdAt });

    await db.authProfiles.delete("auth_1");
    expect(await db.authProfiles.get("auth_1")).toBeNull();
    expect(await db.authProfiles.list()).toEqual([]);
    // The recording survives; its definition still names the profile it needs.
    const orphan = await db.recordings.get("rec_a");
    expect(orphan?.kind === "browser" && orphan.recording.authProfileId).toBe("auth_1");
  });
});

describe("database file", () => {
  it("creates the file, migrates once, and keeps data across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobtrace-db-"));
    try {
      const path = join(dir, "nested", "jobtrace.db");
      const first = openDatabase(`file:${path}`);
      await first.recordings.save(recording("rec_a"));
      first.close();
      expect(existsSync(path)).toBe(true);
      const second = openDatabase(path);
      expect((await second.recordings.list()).map((item) => item.id)).toEqual(["rec_a"]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
