import type { z } from "zod";
import type { RuntimeSettings } from "./runtime.ts";
import type {
  artifactSchema,
  authProfileSchema,
  eventSchema,
  jobRecordSchema,
  recordingDetailSchema,
  recordingListItemSchema,
  runDetailSchema,
  runJobSchema,
  runSchema,
  scheduleSchema,
  sessionSchema,
  settingsViewSchema,
  suggestionSchema,
  testStepResultSchema,
  versionSchema,
} from "./schemas.ts";

/** Response shapes of the API, for clients written in TypeScript (the web UI). */
export type ApiRecordingListItem = z.infer<typeof recordingListItemSchema>;
export type ApiRecordingDetail = z.infer<typeof recordingDetailSchema>;
export type ApiVersion = z.infer<typeof versionSchema>;
export type ApiRun = z.infer<typeof runSchema>;
export type ApiRunDetail = z.infer<typeof runDetailSchema>;
export type ApiRunJob = z.infer<typeof runJobSchema>;
export type ApiJob = z.infer<typeof jobRecordSchema>;
export type ApiArtifact = z.infer<typeof artifactSchema>;
export type ApiEvent = z.infer<typeof eventSchema>;
export type ApiAuthProfile = z.infer<typeof authProfileSchema>;
export type ApiSchedule = z.infer<typeof scheduleSchema>;
export type ApiSession = z.infer<typeof sessionSchema>;
export type ApiSuggestion = z.infer<typeof suggestionSchema>;
export type ApiSettings = z.infer<typeof settingsViewSchema>;
export type ApiTestStepResult = z.infer<typeof testStepResultSchema>;
export type ApiPage<T> = { items: T[]; total: number; page: number; pageSize: number };
export type { RuntimeSettings };
