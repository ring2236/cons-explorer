CREATE TABLE `narrative_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`model_version` text NOT NULL,
	`dataset_id` text NOT NULL,
	`intervention_node` text NOT NULL,
	`intervention_value` real NOT NULL,
	`prompt_version` text NOT NULL,
	`provider_model` text NOT NULL,
	`narrative_text` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL,
	`last_accessed_at` text NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `narrative_lookup_idx` ON `narrative_cache` (`dataset_id`,`intervention_node`,`intervention_value`);