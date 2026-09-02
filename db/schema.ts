import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const narrativeCache = sqliteTable("narrative_cache", {
  cacheKey: text("cache_key").primaryKey(),
  modelVersion: text("model_version").notNull(),
  datasetId: text("dataset_id").notNull(),
  interventionNode: text("intervention_node").notNull(),
  interventionValue: real("intervention_value").notNull(),
  promptVersion: text("prompt_version").notNull(),
  providerModel: text("provider_model").notNull(),
  narrativeText: text("narrative_text").notNull(),
  resultJson: text("result_json").notNull(),
  createdAt: text("created_at").notNull(),
  lastAccessedAt: text("last_accessed_at").notNull(),
  hitCount: integer("hit_count").notNull().default(0),
}, (table) => [
  index("narrative_lookup_idx").on(table.datasetId, table.interventionNode, table.interventionValue),
]);
