PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_model_usage` (
	`bucket` text PRIMARY KEY NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`call_limit` integer DEFAULT 5000 NOT NULL,
	`token_limit` integer DEFAULT 2000000 NOT NULL,
	CONSTRAINT "model_calls_limit" CHECK("__new_model_usage"."calls" <= "__new_model_usage"."call_limit"),
	CONSTRAINT "model_tokens_limit" CHECK("__new_model_usage"."tokens" <= "__new_model_usage"."token_limit")
);
--> statement-breakpoint
INSERT INTO `__new_model_usage`("bucket", "calls", "tokens", "expires_at", "call_limit", "token_limit") SELECT "bucket", "calls", "tokens", "expires_at", 5000, 2000000 FROM `model_usage`;--> statement-breakpoint
DROP TABLE `model_usage`;--> statement-breakpoint
ALTER TABLE `__new_model_usage` RENAME TO `model_usage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;