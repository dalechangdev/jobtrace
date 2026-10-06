import {
  ATS_PROVIDERS,
  type AtsProvider,
  apiSourceFeedUrl,
  JobTraceError,
  newId,
  parseApiSource,
} from "@jobtrace/core";
import { fetchSource } from "@jobtrace/sources";
import type { Command } from "commander";
import type { CliContext } from "../context.ts";

interface SourceAddOptions {
  name?: string;
  company?: string;
  baseUrl?: string;
  check: boolean;
}

const LABELS: Record<AtsProvider, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
};

export function registerSource(program: Command, ctx: CliContext): void {
  const source = program
    .command("source")
    .description("Job boards read through their public API instead of a browser");

  source
    .command("add")
    .description("Add a Greenhouse, Lever or Ashby job board by its board name")
    .argument("<provider>", ATS_PROVIDERS.join(" | "))
    .argument("<board>", "the board's name in its URL, e.g. acme in jobs.lever.co/acme")
    .option("--name <name>", 'display name (default: "<board> (<provider>)")')
    .option("--company <company>", "company name for jobs, when the feed does not carry one")
    .option(
      "--base-url <url>",
      "API origin to use instead of the provider's, e.g. https://api.eu.lever.co",
    )
    .option("--no-check", "do not read the feed once to verify the board exists")
    .action(async (provider: string, board: string, options: SourceAddOptions) => {
      if (!(ATS_PROVIDERS as readonly string[]).includes(provider)) {
        throw new JobTraceError(
          "INVALID_ARGUMENT",
          `Unknown provider "${provider}". Supported: ${ATS_PROVIDERS.join(", ")}.`,
        );
      }
      const definition = parseApiSource({
        schemaVersion: 1,
        kind: "api",
        id: newId("source"),
        name: options.name?.trim() || `${board} (${LABELS[provider as AtsProvider]})`,
        provider,
        boardToken: board,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        settings: options.company ? { company: options.company } : {},
      });

      if (options.check) {
        // Nothing is stored for a board that cannot be read.
        const result = await ctx.withInterrupt((signal) => fetchSource(definition, { signal }));
        if (result.status !== "succeeded" && result.status !== "partial") {
          throw new JobTraceError(
            "NOT_FOUND",
            `Could not read ${apiSourceFeedUrl(definition)}: ${result.error?.message ?? result.status}`,
          );
        }
        ctx.stderr.write(`Found ${result.jobs.length} job(s) on the board.\n`);
      }
      await ctx.db.recordings.save(definition, "added");
      if (!options.company && provider !== "greenhouse") {
        ctx.stderr.write(
          `Note: ${LABELS[provider as AtsProvider]} feeds do not name the company. Add --company "<name>" to fill it in.\n`,
        );
      }
      ctx.stderr.write(
        `Added "${definition.name}". Fetch its jobs with: jobtrace run ${definition.id}\n`,
      );
      ctx.stdout.write(`${definition.id}\n`);
    });
}
