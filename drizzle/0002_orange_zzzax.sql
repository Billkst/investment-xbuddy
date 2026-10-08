CREATE TABLE `model_usage` (
	`bucket` text PRIMARY KEY NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL
);
