/** Building a cron expression from the choices in the schedule form. */
export type Frequency = "daily" | "weekdays" | "weekly" | "hours" | "custom";

export interface ScheduleChoice {
  frequency: Frequency;
  /** "HH:MM", for daily, weekdays and weekly. */
  time: string;
  /** 0 (Sunday) to 6, for weekly. */
  weekday: number;
  /** For "every N hours". */
  everyHours: number;
  /** For custom. */
  cron: string;
}

export const DEFAULT_CHOICE: ScheduleChoice = {
  frequency: "weekdays",
  time: "08:00",
  weekday: 1,
  everyHours: 6,
  cron: "0 8 * * 1-5",
};

export function toCron(choice: ScheduleChoice): string {
  const [hour = "8", minute = "0"] = choice.time
    .split(":")
    .map((part) => String(Number(part) || 0));
  switch (choice.frequency) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${choice.weekday}`;
    case "hours":
      return `0 */${Math.min(Math.max(Math.round(choice.everyHours) || 1, 1), 23)} * * *`;
    case "custom":
      return choice.cron.trim();
  }
}
