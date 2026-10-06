import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  apiSourceFeedUrl,
  isApiSource,
  JobTraceError,
  parseDefinitionJson,
  walkSteps,
} from "@jobtrace/core";
import { definitionOf } from "@jobtrace/db";
import { removeRunArtifacts } from "@jobtrace/scheduler";
import type { Command } from "commander";
import type { CliContext } from "../context.ts";
import { outline, table, when } from "../format.ts";

export function registerRecordings(program: Command, ctx: CliContext): void {
  const recordings = program.command("recordings").description("Manage stored recordings");

  recordings
    .command("list")
    .description("List stored recordings")
    .option("--json", "print as JSON")
    .action(async (options: { json?: boolean }) => {
      const rows = await Promise.all(
        (await ctx.db.recordings.list()).map(async (recording) => {
          const [lastRun] = await ctx.db.runs.list({ recordingId: recording.id, limit: 1 });
          const openJobs = await ctx.db.jobs.count({ recordingId: recording.id });
          return { ...recording, openJobs, lastRun: lastRun ?? null };
        }),
      );
      if (options.json) return void ctx.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      if (rows.length === 0) {
        return void ctx.stderr.write("No recordings yet. Create one with: jobtrace record <url>\n");
      }
      ctx.stdout.write(
        table(
          ["ID", "TYPE", "NAME", "SITE", "OPEN JOBS", "LAST RUN"],
          rows.map((row) => [
            row.id,
            row.kind === "api" ? "feed" : "recording",
            row.name,
            row.domain,
            row.openJobs,
            row.lastRun
              ? `${row.lastRun.status} ${when(row.lastRun.startedAt ?? row.lastRun.createdAt)}`
              : "never",
          ]),
        ),
      );
    });

  recordings
    .command("show")
    .description("Show a recording's details and steps")
    .argument("<recording>", "id, id prefix or name")
    .option("--json", "print the recording definition as JSON")
    .action(async (ref: string, options: { json?: boolean }) => {
      const stored = await ctx.db.recordings.resolve(ref);
      if (options.json) {
        return void ctx.stdout.write(`${JSON.stringify(definitionOf(stored), null, 2)}\n`);
      }
      const versions = await ctx.db.recordings.versions(stored.id);
      const openJobs = await ctx.db.jobs.count({ recordingId: stored.id });
      const head = [
        `${stored.name}`,
        `  id         ${stored.id}`,
        `  updated    ${when(stored.updatedAt)} (${versions.length} version${versions.length === 1 ? "" : "s"})`,
        `  open jobs  ${openJobs}`,
      ];
      if (stored.kind === "api") {
        const { source } = stored;
        return void ctx.stdout.write(
          [
            ...head,
            `  type       ${source.provider} feed, board "${source.boardToken}"`,
            `  feed URL   ${apiSourceFeedUrl(source)}`,
            ...(source.settings.company ? [`  company    ${source.settings.company}`] : []),
            "",
          ].join("\n"),
        );
      }
      const params = Object.entries(stored.recording.params).map(
        ([name, spec]) => `${name}${spec.default === undefined ? "" : `=${spec.default}`}`,
      );
      ctx.stdout.write(
        [
          ...head,
          `  start URL  ${stored.startUrl}`,
          ...(params.length > 0 ? [`  params     ${params.join(", ")}`] : []),
          "",
          "Steps",
          ...outline(stored.recording.steps, 1),
          "",
        ].join("\n"),
      );
    });

  recordings
    .command("export")
    .description("Write a recording as a .jobtrace.json file (stdout by default)")
    .argument("<recording>", "id, id prefix or name")
    .option("--out <file>", "file to write")
    .option("--force", "overwrite the file if it exists")
    .action(async (ref: string, options: { out?: string; force?: boolean }) => {
      const stored = await ctx.db.recordings.resolve(ref);
      const text = `${JSON.stringify(definitionOf(stored), null, 2)}\n`;
      if (!options.out) return void ctx.stdout.write(text);
      const file = resolve(ctx.cwd, options.out);
      if (existsSync(file) && !options.force) {
        throw new JobTraceError(
          "INVALID_ARGUMENT",
          `${options.out} already exists. Pass --force to overwrite it.`,
        );
      }
      await writeFile(file, text);
      ctx.stderr.write(`Exported "${stored.name}" to ${file}\n`);
    });

  recordings
    .command("import")
    .description(
      "Store a .jobtrace.json file; an existing recording with the same id gets a new version",
    )
    .argument("<file>", "recording file")
    .action(async (path: string) => {
      let text: string;
      try {
        text = await readFile(resolve(ctx.cwd, path), "utf8");
      } catch (error) {
        throw new JobTraceError("INVALID_RECORDING", `Cannot read recording file ${path}`, {
          cause: error,
        });
      }
      const definition = parseDefinitionJson(text);
      const { created } = await ctx.db.recordings.save(definition, `imported from ${path}`);
      const what = isApiSource(definition)
        ? `${definition.provider} feed`
        : `${[...walkSteps(definition.steps)].length} steps`;
      ctx.stderr.write(`${created ? "Imported" : "Updated"} "${definition.name}" (${what})\n`);
      ctx.stdout.write(`${definition.id}\n`);
    });

  recordings
    .command("delete")
    .description("Delete a recording together with its runs, jobs and artifacts")
    .argument("<recording>", "id, id prefix or name")
    .option("--yes", "really delete; without it, only shows what would be deleted")
    .action(async (ref: string, options: { yes?: boolean }) => {
      const stored = await ctx.db.recordings.resolve(ref);
      const runs = await ctx.db.runs.list({ recordingId: stored.id, limit: 100_000 });
      const jobs = await ctx.db.jobs.count({ recordingId: stored.id, includeClosed: true });
      const what = `"${stored.name}" (${stored.id}), ${runs.length} run(s) and ${jobs} job(s)`;
      if (!options.yes) {
        ctx.stderr.write(`This would delete ${what}. Nothing was deleted; pass --yes to do it.\n`);
        return ctx.setExitCode(1);
      }
      const { runIds } = await ctx.db.recordings.delete(stored.id);
      await removeRunArtifacts(ctx.config.dataDir, runIds);
      ctx.stderr.write(`Deleted ${what}.\n`);
    });
}
