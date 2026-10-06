import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { NavLink } from "react-router";
import { ApiError, api, token } from "../api.ts";
import { Button, cx, Field, Input } from "../ui.tsx";

/** Shown instead of the app when the server wants an API token (it is exposed beyond this computer). */
function TokenForm() {
  const [value, setValue] = useState("");
  return (
    <form
      className="mx-auto mt-16 max-w-sm space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        token.set(value.trim());
        window.location.reload();
      }}
    >
      <h1 className="text-xl font-semibold">API token needed</h1>
      <p className="text-sm text-zinc-500">
        This JobTrace server is reachable from other machines, so it asks for the token it was
        started with (API_TOKEN).
      </p>
      <Field label="API token">
        <Input
          type="password"
          required
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary">
        Continue
      </Button>
    </form>
  );
}

const LINKS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/recordings", label: "Recordings" },
  { to: "/runs", label: "Runs" },
  { to: "/jobs", label: "Jobs" },
  { to: "/schedules", label: "Schedules" },
  { to: "/auth", label: "Saved logins" },
  { to: "/settings", label: "Settings" },
];

export function Layout({ children }: { children: ReactNode }) {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 5000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings.get });
  const busy = (health.data?.activeRuns ?? 0) + (health.data?.queuedRuns ?? 0);
  if (settings.error instanceof ApiError && settings.error.status === 401) return <TokenForm />;
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col md:flex-row">
      <nav
        aria-label="Main"
        className="shrink-0 border-zinc-200 p-4 md:w-52 md:border-r dark:border-zinc-800"
      >
        <p className="mb-4 px-2 text-lg font-semibold">JobTrace</p>
        <ul className="flex flex-wrap gap-1 md:flex-col">
          {LINKS.map((link) => (
            <li key={link.to}>
              <NavLink
                to={link.to}
                end={link.end ?? false}
                className={({ isActive }) =>
                  cx(
                    "block rounded-md px-2 py-1.5 text-sm",
                    isActive
                      ? "bg-zinc-200 font-medium dark:bg-zinc-800"
                      : "text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-800/60",
                  )
                }
              >
                {link.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <p className="mt-4 px-2 text-xs text-zinc-500" aria-live="polite">
          {health.isError
            ? "Server not reachable"
            : busy > 0
              ? `${health.data?.activeRuns} running, ${health.data?.queuedRuns} queued`
              : "Idle"}
        </p>
      </nav>
      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
    </div>
  );
}
