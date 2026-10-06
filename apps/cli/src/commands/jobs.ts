import type { Command } from "commander";
import type { CliContext } from "../context.ts";
import { parseSince, table, when } from "../format.ts";

interface JobsListOptions {
  new?: boolean;
  recording?: string;
  since?: string;
  search?: string;
  all?: boolean;
  limit: number;
  json?: boolean;
}

export function registerJobs(
  program: Command,
  ctx: CliContext,
  positiveInt: (value: string) => number,
): void {
  const jobs = program.command("jobs").description("Browse the jobs found so far");

  jobs
    .command("list")
    .description("List jobs, most recently found first")
    .option("--new", "only jobs that were new in the latest run of their recording")
    .option("--recording <recording>", "only jobs of this recording (id, id prefix or name)")
    .option("--since <when>", "only jobs first seen since then: 36h, 7d, 2w or a date")
    .option("--search <text>", "search title, company, location and description")
    .option("--all", "include jobs that have disappeared from the site")
    .option("--limit <n>", "how many to show", positiveInt, 50)
    .option("--json", "print as JSON")
    .action(async (options: JobsListOptions) => {
      const filter = {
        ...(options.recording
          ? { recordingId: (await ctx.db.recordings.resolve(options.recording)).id }
          : {}),
        ...(options.new ? { newInLatestRun: true } : {}),
        ...(options.since ? { since: parseSince(options.since) } : {}),
        ...(options.search ? { search: options.search } : {}),
        ...(options.all ? { includeClosed: true } : {}),
      };
      const [found, total] = await Promise.all([
        ctx.db.jobs.list({ ...filter, limit: options.limit }),
        ctx.db.jobs.count(filter),
      ]);
      if (options.json) return void ctx.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
      if (found.length === 0) return void ctx.stderr.write("No jobs match.\n");
      ctx.stdout.write(
        table(
          ["FIRST SEEN", "TITLE", "COMPANY", "LOCATION", "URL"],
          found.map((job) => [
            `${when(job.firstSeenAt)}${job.closedAt ? " (closed)" : ""}`,
            job.title,
            job.company,
            job.location,
            job.url,
          ]),
        ),
      );
      ctx.stderr.write(`${found.length} of ${total} job(s)\n`);
    });
}
