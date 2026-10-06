import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { DEFAULT_CHOICE, type Frequency, type ScheduleChoice, toCron } from "../lib/cron.ts";
import { ago, when } from "../lib/format.ts";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Note,
  PageHeader,
  Select,
  Table,
  Td,
} from "../ui.tsx";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = (): string[] => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
};

function ScheduleForm({ onSaved }: { onSaved: () => void }) {
  const recordings = useQuery({ queryKey: ["recordings"], queryFn: api.recordings.list });
  const [recordingId, setRecordingId] = useState("");
  const [choice, setChoice] = useState<ScheduleChoice>(DEFAULT_CHOICE);
  const [timezone, setTimezone] = useState(browserZone);
  const cron = toCron(choice);
  const set = (patch: Partial<ScheduleChoice>) => setChoice({ ...choice, ...patch });

  // Ask the server what the schedule means and when it fires; it is the one that will run it.
  const preview = useQuery({
    queryKey: ["schedule-preview", cron, timezone],
    queryFn: () => api.schedules.preview(cron, timezone),
    enabled: cron !== "",
    retry: false,
  });
  const create = useMutation({
    mutationFn: () => api.schedules.create({ recordingId, cron, timezone }),
    onSuccess: onSaved,
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <Field label="Recording or feed">
        <Select
          required
          value={recordingId}
          onChange={(event) => setRecordingId(event.target.value)}
        >
          <option value="">Choose…</option>
          {recordings.data?.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="How often">
        <Select
          value={choice.frequency}
          onChange={(event) => set({ frequency: event.target.value as Frequency })}
        >
          <option value="weekdays">Every weekday</option>
          <option value="daily">Every day</option>
          <option value="weekly">Once a week</option>
          <option value="hours">Every few hours</option>
          <option value="custom">Custom (cron expression)</option>
        </Select>
      </Field>
      {choice.frequency === "weekly" && (
        <Field label="Day">
          <Select
            value={choice.weekday}
            onChange={(event) => set({ weekday: Number(event.target.value) })}
          >
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={index}>
                {day}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {["daily", "weekdays", "weekly"].includes(choice.frequency) && (
        <Field label="Time">
          <Input
            type="time"
            required
            value={choice.time}
            onChange={(event) => set({ time: event.target.value })}
          />
        </Field>
      )}
      {choice.frequency === "hours" && (
        <Field label="Every … hours">
          <Input
            type="number"
            min={1}
            max={23}
            required
            value={choice.everyHours}
            onChange={(event) => set({ everyHours: Number(event.target.value) })}
          />
        </Field>
      )}
      {choice.frequency === "custom" && (
        <Field
          label="Cron expression"
          hint="Five fields: minute, hour, day of month, month, day of week. At most every 15 minutes."
        >
          <Input
            required
            className="font-mono"
            value={choice.cron}
            onChange={(event) => set({ cron: event.target.value })}
          />
        </Field>
      )}
      <Field label="Time zone">
        <Input
          required
          list="timezones"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
        />
        <datalist id="timezones">
          {zones().map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </Field>

      <div
        className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800"
        data-testid="schedule-preview"
        aria-live="polite"
      >
        {preview.error ? (
          <p className="text-red-700 dark:text-red-400">{preview.error.message}</p>
        ) : preview.data ? (
          <>
            <p className="font-medium">{preview.data.description}</p>
            <p className="mt-1 text-xs text-zinc-500">Next runs:</p>
            <ol className="text-xs text-zinc-600 dark:text-zinc-400">
              {preview.data.nextRuns.map((run) => (
                <li key={run}>{when(run)}</li>
              ))}
            </ol>
            <p className="mt-1 text-xs text-zinc-500">Times are shown in your own time zone.</p>
          </>
        ) : (
          <p className="text-zinc-500">…</p>
        )}
      </div>
      <ErrorNote error={create.error} />
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || Boolean(preview.error)}
        >
          Save schedule
        </Button>
      </div>
    </form>
  );
}

export function Schedules() {
  const client = useQueryClient();
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.schedules.list(),
    refetchInterval: 30_000,
  });
  const recordings = useQuery({ queryKey: ["recordings"], queryFn: api.recordings.list });
  const names = useMemo(
    () => new Map((recordings.data ?? []).map((item) => [item.id, item.name])),
    [recordings.data],
  );
  const [adding, setAdding] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: ["schedules"] });
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.schedules.update(input.id, { enabled: input.enabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.schedules.remove(id),
    onSuccess: refresh,
  });

  return (
    <>
      <PageHeader
        title="Schedules"
        subtitle="Run recordings and feeds automatically."
        actions={
          <Button
            variant="primary"
            disabled={(recordings.data?.length ?? 0) === 0}
            onClick={() => setAdding(true)}
          >
            New schedule
          </Button>
        }
      />
      <div className="mb-4 space-y-3">
        <Note>
          Schedules run only while JobTrace is running on this computer (jobtrace serve). Runs that
          were due while it was off are skipped, not caught up.
        </Note>
        <ErrorNote error={schedules.error ?? toggle.error ?? remove.error} />
      </div>
      <Card>
        {!schedules.data ? (
          <Loading />
        ) : schedules.data.length === 0 ? (
          <Empty>
            {(recordings.data?.length ?? 0) === 0
              ? "Add a recording or feed first; then it can be scheduled."
              : "No schedules yet."}
          </Empty>
        ) : (
          <Table head={["Recording", "When", "Next run", "Last run", ""]}>
            {schedules.data.map((schedule) => (
              <tr key={schedule.id}>
                <Td>
                  <Link
                    className="font-medium text-blue-700 hover:underline dark:text-blue-400"
                    to={`/recordings/${schedule.recordingId}`}
                  >
                    {names.get(schedule.recordingId) ?? schedule.recordingId}
                  </Link>
                </Td>
                <Td>
                  {schedule.description}
                  <span className="ml-2 font-mono text-xs text-zinc-400">{schedule.cron}</span>
                </Td>
                <Td className="whitespace-nowrap">
                  {schedule.enabled ? when(schedule.nextRuns[0]) : <Badge>Paused</Badge>}
                </Td>
                <Td className="whitespace-nowrap text-zinc-500">
                  {schedule.lastRunAt ? ago(schedule.lastRunAt) : "Never"}
                </Td>
                <Td className="space-x-2 whitespace-nowrap text-right">
                  <Button
                    size="sm"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ id: schedule.id, enabled: !schedule.enabled })}
                  >
                    {schedule.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      if (window.confirm("Delete this schedule?")) remove.mutate(schedule.id);
                    }}
                  >
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Dialog open={adding} onClose={() => setAdding(false)} title="New schedule">
        <ScheduleForm
          onSaved={() => {
            setAdding(false);
            void refresh();
          }}
        />
      </Dialog>
    </>
  );
}
