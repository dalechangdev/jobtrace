-- Full-text search over jobs. A plain FTS5 table keyed by job id (rather than an
-- external-content table keyed by rowid): `jobs` has a text primary key, and
-- SQLite may renumber such a table's rowids on VACUUM.
CREATE VIRTUAL TABLE `jobs_fts` USING fts5(
	`job_id` UNINDEXED,
	`title`,
	`company`,
	`location`,
	`description`,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `jobs_fts_insert` AFTER INSERT ON `jobs` BEGIN
	INSERT INTO `jobs_fts` (`job_id`, `title`, `company`, `location`, `description`)
	VALUES (new.`id`, new.`title`, new.`company`, new.`location`, new.`description`);
END;
--> statement-breakpoint
CREATE TRIGGER `jobs_fts_delete` AFTER DELETE ON `jobs` BEGIN
	DELETE FROM `jobs_fts` WHERE `job_id` = old.`id`;
END;
--> statement-breakpoint
-- Only when searchable text is written; touching last_seen_at must stay cheap.
CREATE TRIGGER `jobs_fts_update` AFTER UPDATE OF `title`, `company`, `location`, `description` ON `jobs` BEGIN
	DELETE FROM `jobs_fts` WHERE `job_id` = old.`id`;
	INSERT INTO `jobs_fts` (`job_id`, `title`, `company`, `location`, `description`)
	VALUES (new.`id`, new.`title`, new.`company`, new.`location`, new.`description`);
END;
