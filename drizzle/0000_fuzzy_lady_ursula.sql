CREATE TABLE `research_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`owner` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_checkpoints_run` ON `research_checkpoints` (`run_id`);--> statement-breakpoint
CREATE TABLE `research_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`content` text NOT NULL,
	`source_run_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_memories_owner` ON `research_memories` (`owner`);--> statement-breakpoint
CREATE TABLE `research_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`state` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`stop_requested` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_runs_owner_updated` ON `research_runs` (`owner`,`updated_at`);