CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`start_state` text NOT NULL,
	`end_state` text,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`input_token_count` integer NOT NULL,
	`output_token_count` integer NOT NULL,
	`tool_call_count` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_runs_owner_idx` ON `agent_runs` (`owner_id`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`privacy_accepted_at` integer,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`fallback_enabled` integer NOT NULL,
	`daily_input_token_limit` integer NOT NULL,
	`daily_output_token_limit` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_settings_owner_idx` ON `app_settings` (`owner_id`);--> statement-breakpoint
CREATE TABLE `approval_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`allowed_tool` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `approval_grants_owner_idx` ON `approval_grants` (`owner_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text,
	`type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_events_owner_idx` ON `audit_events` (`owner_id`);--> statement-breakpoint
CREATE TABLE `check_ins` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`blocker_category` text,
	`note` text,
	`minutes_spent` integer,
	`available_weekly_minutes` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `check_ins_owner_idx` ON `check_ins` (`owner_id`);--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_messages_owner_idx` ON `conversation_messages` (`owner_id`);--> statement-breakpoint
CREATE TABLE `conversation_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`through_message_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`through_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_summaries_owner_idx` ON `conversation_summaries` (`owner_id`);--> statement-breakpoint
CREATE TABLE `draft_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`content_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `draft_artifacts_owner_idx` ON `draft_artifacts` (`owner_id`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`status` text NOT NULL,
	`agent_state` text DEFAULT 'intake' NOT NULL,
	`clarification_count` integer DEFAULT 0 NOT NULL,
	`current_plan_version_id` text,
	`desired_outcome` text,
	`definition_of_done` text,
	`deadline` text,
	`weekly_minutes` integer,
	`constraints` text,
	`motivation` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`current_plan_version_id`) REFERENCES `plan_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `goals_owner_idx` ON `goals` (`owner_id`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text,
	`operation_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`parameter_hash` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `operations_owner_idx` ON `operations` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `operations_operation_id_unique` ON `operations` (`operation_id`);--> statement-breakpoint
CREATE TABLE `plan_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`number` integer NOT NULL,
	`status` text NOT NULL,
	`change_reason` text,
	`change_source` text NOT NULL,
	`diff` text NOT NULL,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plan_versions_owner_idx` ON `plan_versions` (`owner_id`);--> statement-breakpoint
CREATE TABLE `task_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`task_id` text NOT NULL,
	`type` text NOT NULL,
	`text` text,
	`file_name` text,
	`file_size` integer,
	`mime_type` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_evidence_owner_idx` ON `task_evidence` (`owner_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`plan_version_id` text NOT NULL,
	`title` text NOT NULL,
	`action` text NOT NULL,
	`done_criteria` text NOT NULL,
	`evidence_type` text NOT NULL,
	`estimate_minutes` integer NOT NULL,
	`actual_minutes` integer,
	`due_at` text,
	`dependency_ids` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_version_id`) REFERENCES `plan_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_owner_idx` ON `tasks` (`owner_id`);--> statement-breakpoint
CREATE TABLE `undo_records` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`task_id` text NOT NULL,
	`forward_patch` text NOT NULL,
	`reverse_patch` text NOT NULL,
	`undone_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `undo_records_owner_idx` ON `undo_records` (`owner_id`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`task_granularity` text NOT NULL,
	`preferred_time_window` text,
	`estimate_bias` real NOT NULL,
	`common_blockers` text NOT NULL,
	`effective_strategies` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_preferences_owner_idx` ON `user_preferences` (`owner_id`);