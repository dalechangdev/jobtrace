import { JobTraceError } from "@jobtrace/core";
import { createSchedule, scheduleView, updateSchedule } from "@jobtrace/scheduler";
import type { Command } from "commander";
import type { CliContext } from "../context.ts";
import { table, when } from "../format.ts";
import { parseParams } from "../run-command.ts";

const SERVE_NOTE =
  "Schedules only fire while `jobtrace serve` is running; a running server picks this up within a minute.\n";

export function registerSchedule(program: Command, ctx: CliContext): void {
  const schedule = program
    .command("schedule")
    .description("Run recordings and sources automatically, on a schedule");
  const collect = (value: string, previous: string[]) => [...previous, value];

  /** Finds a schedule by id or unique id prefix. */
  async function resolve(ref: string) {
    const matches = (await ctx.db.schedules.list()).filter(
      (item) => item.id === ref || (ref.length >= 6 && item.id.startsWith(ref)),
    );
    if (matches.length !== 1) {
      throw new JobTraceError(
        "NOT_FOUND",
        matches.length === 0
          ? `No schedule matches "${ref}"`
          : `"${ref}" matches ${matches.length} schedules`,
      );
    }
    return matches[0] as (typeof matches)[number];
  }

  schedule
    .command("add")
    .description("Schedule a recording or source")
    .argument("<recording>", "id, id prefix or name")
    .requiredOption(
      "--cron <expression>",
      'when to run, as a cron expression, e.g. "0 8 * * 1-5" for weekdays at 08:00',
    )
    .option(
      "--tz <timezone>",
      "time zone the expression is in, e.g. Europe/Madrid (default: this computer's)",
    )
    .option(
      "--param <key=value>",
      "set a recording param for scheduled runs; repeatable",
      collect,
      [],
    )
    .action(async (ref: string, options: { cron: string; tz?: string; param: string[] }) => {
      const stored = await ctx.db.recordings.resolve(ref);
      const created = await createSchedule(ctx.db, {
        recordingId: stored.id,
        cron: options.cron,
        ...(options.tz ? { timezone: options.tz } : {}),
        params: parseParams(options.param),
      });
      const view = scheduleView(created);
      ctx.stderr.write(
        `Scheduled "${stored.name}": ${view.description}\nNext runs: ${view.nextRuns.slice(0, 3).map(when).join(", ")}\n${SERVE_NOTE}`,
      );
      ctx.stdout.write(`${created.id}\n`);
    });

  schedule
    .command("list")
    .description("List schedules")
    .option("--json", "print as JSON")
    .action(async (options: { json?: boolean }) => {
      const views = (await ctx.db.schedules.list()).map((item) => scheduleView(item));
      if (options.json) return void ctx.stdout.write(`${JSON.stringify(views, null, 2)}\n`);
      if (views.length === 0) {
        return void ctx.stderr.write(
          'No schedules. Add one with: jobtrace schedule add <recording> --cron "0 8 * * 1-5"\n',
        );
      }
      const names = new Map(
        (await ctx.db.recordings.list()).map((recording) => [recording.id, recording.name]),
      );
      ctx.stdout.write(
        table(
          ["ID", "RECORDING", "WHEN", "NEXT RUN", "LAST RUN"],
          views.map((view) => [
            view.id,
            names.get(view.recordingId) ?? view.recordingId,
            view.description,
            view.enabled ? when(view.nextRuns[0]) : "paused",
            view.lastRunAt ? when(view.lastRunAt) : "never",
          ]),
        ),
      );
    });

  for (const [name, enabled] of [
    ["pause", false],
    ["resume", true],
  ] as const) {
    schedule
      .command(name)
      .description(enabled ? "Resume a paused schedule" : "Pause a schedule without deleting it")
      .argument("<schedule>", "schedule id or id prefix")
      .action(async (ref: string) => {
        const found = await resolve(ref);
        await updateSchedule(ctx.db, found.id, { enabled });
        ctx.stderr.write(`${enabled ? "Resumed" : "Paused"} schedule ${found.id}.\n`);
      });
  }

  schedule
    .command("remove")
    .description("Delete a schedule")
    .argument("<schedule>", "schedule id or id prefix")
    .action(async (ref: string) => {
      const found = await resolve(ref);
      await ctx.db.schedules.delete(found.id);
      ctx.stderr.write(`Removed schedule ${found.id}.\n`);
    });
}
