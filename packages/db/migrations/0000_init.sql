CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `auth_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`domain` text NOT NULL,
	`storage_state_path` text NOT NULL,
	`created_at` text NOT NULL,
	`last_verified_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_profiles_name_unique` ON `auth_profiles` (`name`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`dedup_key` text NOT NULL,
	`title` text NOT NULL,
	`company` text,
	`location` text,
	`remote` text NOT NULL,
	`salary_text` text,
	`salary_min` real,
	`salary_max` real,
	`salary_currency` text,
	`salary_period` text,
	`url` text,
	`description` text,
	`description_html` text,
	`posted_at` text,
	`employment_type` text,
	`custom_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`first_seen_run_id` text,
	`closed_at` text,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`first_seen_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_recording_dedup_idx` ON `jobs` (`recording_id`,`dedup_key`);--> statement-breakpoint
CREATE INDEX `jobs_last_seen_idx` ON `jobs` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `jobs_first_seen_idx` ON `jobs` (`first_seen_at`);--> statement-breakpoint
CREATE TABLE `recording_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`definition_json` text NOT NULL,
	`created_at` text NOT NULL,
	`note` text,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recording_versions_recording_idx` ON `recording_versions` (`recording_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`start_url` text NOT NULL,
	`domain` text NOT NULL,
	`definition_json` text NOT NULL,
	`schema_version` integer NOT NULL,
	`auth_profile_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`auth_profile_id`) REFERENCES `auth_profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`ts` text NOT NULL,
	`level` text NOT NULL,
	`step_id` text,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`data_json` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_run_ts_idx` ON `run_events` (`run_id`,`ts`);--> statement-breakpoint
CREATE TABLE `run_jobs` (
	`run_id` text NOT NULL,
	`job_id` text NOT NULL,
	`is_new` integer NOT NULL,
	`is_changed` integer NOT NULL,
	PRIMARY KEY(`run_id`, `job_id`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_jobs_job_idx` ON `run_jobs` (`job_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`recording_version_id` text,
	`schedule_id` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`params_json` text DEFAULT '{}' NOT NULL,
	`started_at` text,
	`finished_at` text,
	`stats_json` text,
	`error_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recording_version_id`) REFERENCES `recording_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_recording_created_idx` ON `runs` (`recording_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`cron` text NOT NULL,
	`timezone` text,
	`enabled` integer DEFAULT true NOT NULL,
	`params_json` text DEFAULT '{}' NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
