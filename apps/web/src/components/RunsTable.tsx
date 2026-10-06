import type { ApiRun } from "@jobtrace/api";
import { Link } from "react-router";
import { ago, duration, reasonText } from "../lib/format.ts";
import { Empty, StatusBadge, Table, Td } from "../ui.tsx";

export function RunsTable({
  runs,
  names,
  empty = "No runs yet.",
}: {
  runs: ApiRun[];
  names?: Map<string, string>;
  empty?: string;
}) {
  if (runs.length === 0) return <Empty>{empty}</Empty>;
  return (
    <Table
      head={[
        ...(names ? ["Recording"] : []),
        "Status",
        "Started",
        "Took",
        "Jobs",
        "New",
        "Changed",
        "",
      ]}
    >
      {runs.map((run) => (
        <tr key={run.id}>
          {names && (
            <Td>
              <Link className="hover:underline" to={`/recordings/${run.recordingId}`}>
                {names.get(run.recordingId) ?? run.recordingId}
              </Link>
            </Td>
          )}
          <Td>
            <StatusBadge status={run.status} />
            {run.status !== "succeeded" && run.reason && (
              <span className="ml-2 text-xs text-zinc-500">{reasonText(run.reason)}</span>
            )}
          </Td>
          <Td className="whitespace-nowrap text-zinc-500">{ago(run.startedAt ?? run.createdAt)}</Td>
          <Td className="whitespace-nowrap">{duration(run.stats?.durationMs)}</Td>
          <Td>{run.stats?.jobs}</Td>
          <Td>{run.stats?.newJobs}</Td>
          <Td>{run.stats?.changedJobs}</Td>
          <Td>
            <Link
              className="text-blue-700 hover:underline dark:text-blue-400"
              to={`/runs/${run.id}`}
            >
              Details
            </Link>
          </Td>
        </tr>
      ))}
    </Table>
  );
}
