ALTER TABLE `check_ins` ADD `withdrawn_at` integer;
--> statement-breakpoint
CREATE TABLE `__new_undo_records` (
 `id` text PRIMARY KEY NOT NULL,
 `owner_id` text NOT NULL,
 `goal_id` text NOT NULL REFERENCES `goals`(`id`),
 `kind` text NOT NULL,
 `task_id` text REFERENCES `tasks`(`id`),
 `check_in_id` text REFERENCES `check_ins`(`id`),
 `ordinal` integer NOT NULL CHECK (`ordinal` > 0),
 `conversation_fence` text,
 `forward_patch` text NOT NULL,
 `reverse_patch` text NOT NULL,
 `undone_at` integer,
 `created_at` integer NOT NULL,
 `updated_at` integer NOT NULL,
 `version` integer DEFAULT 1 NOT NULL,
 CONSTRAINT `undo_records_target_check` CHECK ((`kind` = 'task_execution' AND `task_id` IS NOT NULL AND `check_in_id` IS NULL) OR (`kind` = 'check_in' AND `task_id` IS NULL AND `check_in_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_undo_records` (`id`,`owner_id`,`goal_id`,`kind`,`task_id`,`check_in_id`,`ordinal`,`conversation_fence`,`forward_patch`,`reverse_patch`,`undone_at`,`created_at`,`updated_at`,`version`)
SELECT id, owner_id, goal_id, kind, task_id, check_in_id,
 row_number() over(partition by owner_id, goal_id order by created_at, source_rank, source_rowid),
 NULL, forward_patch, reverse_patch, undone_at, created_at, updated_at, version
FROM (
 SELECT id, owner_id, goal_id, 'task_execution' AS kind, task_id, NULL AS check_in_id, forward_patch, reverse_patch, undone_at, created_at, updated_at, version, 0 AS source_rank, rowid AS source_rowid FROM undo_records
 UNION ALL
 SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))), owner_id, goal_id, 'check_in', NULL, id, '{"withdrawnAt":null}', '{"withdrawn":true}', NULL, created_at, updated_at, 1, 1, rowid FROM check_ins
);
--> statement-breakpoint
DROP TABLE `undo_records`;
--> statement-breakpoint
ALTER TABLE `__new_undo_records` RENAME TO `undo_records`;
--> statement-breakpoint
CREATE INDEX `undo_records_owner_idx` ON `undo_records` (`owner_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `undo_records_goal_ordinal_unique` ON `undo_records` (`owner_id`,`goal_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `undo_records_check_in_unique` ON `undo_records` (`check_in_id`);
