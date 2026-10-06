import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { JobTraceError, newId } from "@jobtrace/core";
import type { AuthProfile } from "@jobtrace/db";
import { captureAuth } from "@jobtrace/recorder";
import type { Command } from "commander";
import type { CliContext } from "../context.ts";
import { table, when } from "../format.ts";
import { normalizeUrl } from "../record-command.ts";
import { type Remote, remoteFrom } from "../remote.ts";

export function registerAuth(program: Command, ctx: CliContext): void {
  const auth = program
    .command("auth")
    .description("Saved logins (auth profiles) for boards behind a sign-in");

  /** Opens the login page, waits for "Save login", and stores or updates the profile. */
  /** Sends a saved login to a server that cannot open a login window itself. */
  async function push(profile: AuthProfile, remote: Remote | null) {
    if (!remote) return;
    const storageState = JSON.parse(await readFile(profile.storageStatePath, "utf8"));
    await remote.send("PUT", `/api/auth-profiles/${profile.id}/session`, {
      name: profile.name,
      domain: profile.domain,
      storageState,
    });
    ctx.stderr.write(`Sent the login "${profile.name}" to ${remote.url}.\n`);
  }

  async function capture(
    url: string,
    profile: Pick<AuthProfile, "id" | "name" | "storageStatePath">,
    existing: boolean,
    remote: Remote | null,
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
    const saved = await ctx.db.authProfiles.save({ ...profile, domain: session.domain });
    await push(saved, remote);
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
    .option("--server <url>", "also send the login to a JobTrace server (e.g. one in Docker)")
    .action(async (name: string, options: { url: string; server?: string }) => {
      const remote = remoteFrom(options.server, ctx.env);
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
        remote,
      );
    });

  auth
    .command("refresh")
    .description("Log in again to renew a profile whose session has expired")
    .argument("<profile>", "profile name or id")
    .option("--url <loginUrl>", "login page to open (default: the site's home page)")
    .option("--server <url>", "also send the renewed login to a JobTrace server")
    .action(async (ref: string, options: { url?: string; server?: string }) => {
      const remote = remoteFrom(options.server, ctx.env);
      const profile = await ctx.db.authProfiles.resolve(ref);
      await capture(
        normalizeUrl(options.url ?? `https://${profile.domain}/`),
        profile,
        true,
        remote,
      );
    });

  auth
    .command("push")
    .description("Send a saved login to a JobTrace server that cannot open a login window itself")
    .argument("<profile>", "profile name or id")
    .option("--server <url>", "the server's address (default: JOBTRACE_SERVER)")
    .action(async (ref: string, options: { server?: string }) => {
      const remote = remoteFrom(options.server, ctx.env);
      if (!remote) {
        throw new JobTraceError(
          "INVALID_ARGUMENT",
          "Say which server: --server http://127.0.0.1:4317",
        );
      }
      await push(await ctx.db.authProfiles.resolve(ref), remote);
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
