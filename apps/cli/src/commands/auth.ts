import { rm } from "node:fs/promises";
import { join } from "node:path";
import { JobTraceError, newId } from "@jobtrace/core";
import type { AuthProfile } from "@jobtrace/db";
import { captureAuth } from "@jobtrace/recorder";
import type { Command } from "commander";
import type { CliContext } from "../context.ts";
import { table, when } from "../format.ts";
import { normalizeUrl } from "../record-command.ts";

export function registerAuth(program: Command, ctx: CliContext): void {
  const auth = program
    .command("auth")
    .description("Saved logins (auth profiles) for boards behind a sign-in");

  /** Opens the login page, waits for "Save login", and stores or updates the profile. */
  async function capture(
    url: string,
    profile: Pick<AuthProfile, "id" | "name" | "storageStatePath">,
    existing: boolean,
  ) {
    const session = await ctx.withInterrupt(async (signal) => {
      const started = await captureAuth({
        url,
        statePath: profile.storageStatePath,
        ...(existing ? { existingState: profile.storageStatePath } : {}),
        signal,
        ...ctx.io.recorder,
      });
      ctx.stderr.write(
        "Log in in the browser window as you normally would, then press Save login in the toolbar.\n" +
          "Your password is not recorded: only the resulting browser session is saved.\n",
      );
      ctx.io.onAuthCapture?.(started);
      return started.finished;
    });
    if (!session.saved) {
      ctx.stderr.write("Cancelled; nothing was saved.\n");
      return ctx.setExitCode(1);
    }
    await ctx.db.authProfiles.save({ ...profile, domain: session.domain });
    ctx.stderr.write(
      `Saved login "${profile.name}" for ${session.domain}.\nRecord with it: jobtrace record <url> --auth "${profile.name}"\n`,
    );
    ctx.stdout.write(`${profile.id}\n`);
  }

  auth
    .command("create")
    .description("Log in to a site once and save the session as a profile")
    .argument("<name>", "a name for the profile, e.g. the site's name")
    .requiredOption("--url <loginUrl>", "the site's login page")
    .action(async (name: string, options: { url: string }) => {
      const taken = (await ctx.db.authProfiles.list()).some(
        (profile) => profile.name.toLowerCase() === name.toLowerCase(),
      );
      if (taken) {
        throw new JobTraceError(
          "INVALID_ARGUMENT",
          `An auth profile named "${name}" already exists. Use: jobtrace auth refresh "${name}"`,
        );
      }
      const id = newId("authProfile");
      await capture(
        normalizeUrl(options.url),
        { id, name, storageStatePath: join(ctx.config.dataDir, "auth", `${id}.json`) },
        false,
      );
    });

  auth
    .command("refresh")
    .description("Log in again to renew a profile whose session has expired")
    .argument("<profile>", "profile name or id")
    .option("--url <loginUrl>", "login page to open (default: the site's home page)")
    .action(async (ref: string, options: { url?: string }) => {
      const profile = await ctx.db.authProfiles.resolve(ref);
      await capture(normalizeUrl(options.url ?? `https://${profile.domain}/`), profile, true);
    });

  auth
    .command("list")
    .description("List saved logins")
    .option("--json", "print as JSON")
    .action(async (options: { json?: boolean }) => {
      const profiles = await ctx.db.authProfiles.list();
      if (options.json) return void ctx.stdout.write(`${JSON.stringify(profiles, null, 2)}\n`);
      if (profiles.length === 0) {
        return void ctx.stderr.write(
          "No saved logins. Create one with: jobtrace auth create <name> --url <loginUrl>\n",
        );
      }
      ctx.stdout.write(
        table(
          ["NAME", "SITE", "CREATED", "LAST WORKED", "USED BY"],
          profiles.map((profile) => [
            profile.name,
            profile.domain,
            when(profile.createdAt),
            profile.lastVerifiedAt ? when(profile.lastVerifiedAt) : "not checked yet",
            `${profile.usedBy} recording${profile.usedBy === 1 ? "" : "s"}`,
          ]),
        ),
      );
    });

  auth
    .command("delete")
    .description("Delete a saved login and its session file")
    .argument("<profile>", "profile name or id")
    .action(async (ref: string) => {
      const profile = await ctx.db.authProfiles.resolve(ref);
      await rm(profile.storageStatePath, { force: true });
      await ctx.db.authProfiles.delete(profile.id);
      ctx.stderr.write(
        `Deleted saved login "${profile.name}". Recordings that used it will fail until re-recorded.\n`,
      );
    });
}
