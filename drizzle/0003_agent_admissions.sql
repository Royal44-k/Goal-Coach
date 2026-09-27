CREATE TABLE `agent_daily_admissions` (
  `owner_id` text NOT NULL,
  `day` text NOT NULL,
  `count` integer NOT NULL,
  PRIMARY KEY (`owner_id`, `day`),
  CONSTRAINT `agent_daily_admissions_count_check` CHECK (`count` >= 0)
);
--> statement-breakpoint
CREATE TABLE `account_model_usage` (
  `owner_id` text NOT NULL,
  `attempt_id` text NOT NULL,
  `day` text NOT NULL,
  `input_tokens` integer NOT NULL,
  `output_tokens` integer NOT NULL,
  PRIMARY KEY (`owner_id`, `attempt_id`),
  CONSTRAINT `account_model_usage_tokens_check` CHECK (`input_tokens` >= 0 AND `output_tokens` >= 0)
);
