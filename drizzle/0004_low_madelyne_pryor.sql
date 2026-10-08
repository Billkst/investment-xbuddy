CREATE TABLE `service_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_hash` text NOT NULL,
	`state` text NOT NULL
);
