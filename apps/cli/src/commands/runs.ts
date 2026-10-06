import type { Command } from "commander";
import type { CliContext } from "../context.ts";
import { duration, table, when } from "../format.ts";

export function registerRuns(
  program: Command,
  ctx: CliContext,
  positiveInt: (value: string) => number,
): void {
  const runs = program.command("runs").description("Inspect past runs");

  runs
    .command("list")
    .description("List runs, newest first")
    .option("--recording <recording>", "only runs of this recording (id, id prefix or name)")
    .option("--limit <n>", "how many to show", positiveInt, 20)
    .option("--json", "print as JSON")
    .action(async (options: { recording?: string; limit: number; json?: boolean }) => {
      const recordingId = options.recording
        ? (await ctx.db.recordings.resolve(options.recording)).id
        : undefined;
      const found = await ctx.db.runs.list({
        limit: options.limit,
        ...(recordingId ? { recordingId } : {}),
      });
      if (options.json) return void ctx.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
      if (found.length === 0)
        return void ctx.stderr.write("No runs yet. Start one with: jobtrace run <recording>\n");
      const names = new Map(
        (await ctx.db.recordings.list()).map((recording) => [recording.id, recording.name]),
      );
      ctx.stdout.write(
        table(
          ["ID", "RECORDING", "STATUS", "STARTED", "TOOK", "JOBS", "NEW", "CHANGED"],
          found.map((run) => [
            run.id,
            names.get(run.recordingId) ?? run.recordingId,
            run.reason && run.status !== "succeeded" ? `${run.status} (${run.reason})` : run.status,
            when(run.startedAt ?? run.createdAt),
            duration(run.stats?.durationMs),
            run.stats?.jobs,
            run.stats?.newJobs,
            run.stats?.changedJobs,
          ]),
        ),
      );
    });

  runs
    .command("show")
    .description("Show one run: outcome, jobs, artifacts and optionally its log")
    .argument("<run>", "run id or id prefix")
    .option("--events", "include the run's event log")
    .option("--json", "print as JSON")
    .action(async (ref: string, options: { events?: boolean; json?: boolean }) => {
      const run = await ctx.db.runs.resolve(ref);
      const [jobs, artifacts, events, recording] = await Promise.all([
        ctx.db.jobs.forRun(run.id),
        ctx.db.artifacts.forRun(run.id),
        options.events ? ctx.db.runs.events(run.id) : Promise.resolve([]),
        ctx.db.recordings.get(run.recordingId),
      ]);
      if (options.json) {
        const payload = { run, jobs, artifacts, ...(options.events ? { events } : {}) };
        return void ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      }
      const stats = run.stats;
      const lines = [
        `Run ${run.id}`,
        `  recording  ${recording?.name ?? run.recordingId}`,
        `  status     ${run.status}${run.reason ? ` (${run.reason})` : ""}`,
        `  trigger    ${run.trigger}`,
        `  started    ${when(run.startedAt)}${stats ? `, took ${duration(stats.durationMs)}` : ""}`,
      ];
      if (stats) {
        lines.push(
          `  jobs       ${stats.jobs} (${stats.newJobs} new, ${stats.changedJobs} changed, ${stats.closedJobs} closed)`,
          `  pages      ${stats.pages}, ${stats.itemsSeen} items, ${stats.itemErrors} item errors`,
        );
      }
      if (run.error)
        lines.push(
          `  error      ${run.error.code}${run.error.stepId ? ` at step ${run.error.stepId}` : ""}: ${run.error.message}`,
        );
      for (const artifact of artifacts)
        lines.push(`  ${artifact.type.padEnd(10)} ${artifact.path}`);
      ctx.stdout.write(`${lines.join("\n")}\n`);

      const flagged = jobs.filter((job) => job.isNew || job.isChanged);
      if (flagged.length > 0) {
        ctx.stdout.write(
          `\n${table(
            ["", "TITLE", "LOCATION", "URL"],
            flagged.map((job) => [job.isNew ? "new" : "changed", job.title, job.location, job.url]),
          )}`,
        );
      }
      if (options.events) {
        ctx.stdout.write(
          `\n${events.map((event) => `${event.ts.slice(11, 19)} ${event.level.padEnd(5)} ${event.stepId ? `[${event.stepId}] ` : ""}${event.message}`).join("\n")}\n`,
        );
      }
    });
}
