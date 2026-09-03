import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const narrativeVersion = process.env.NARRATIVE_VERSION ?? "v2";
const validationConfigs = {
  v2: {
    path: "lib/narratives-v2.generated.json",
    schema: "static-narratives-full-graph-v2",
    prompt: "full-causal-story-v2",
    minimumStoryLength: 450,
  },
  v3: {
    path: "lib/narratives-v3.generated.json",
    schema: "static-narratives-causal-explanation-v3",
    prompt: "causal-explanation-story-v3",
    minimumStoryLength: 220,
  },
};
const validationConfig = validationConfigs[narrativeVersion];
if (!validationConfig) throw new Error(`Unsupported NARRATIVE_VERSION: ${narrativeVersion}`);
const outputPath = resolve(process.env.NARRATIVES_PATH ?? process.env.NARRATIVES_V2_PATH ?? validationConfig.path);
const output = JSON.parse(readFileSync(outputPath, "utf8"));
const scenarios = JSON.parse(readFileSync(new URL("../lib/scenarios.generated.json", import.meta.url), "utf8"));
const models = JSON.parse(readFileSync(new URL("../lib/models.generated.json", import.meta.url), "utf8"));
const modelById = new Map(models.datasets.map((dataset) => [dataset.dataset_id, dataset]));
const expectedScenarioKeys = new Set(scenarios.datasets.flatMap((dataset) => dataset.scenarios.map((scenario) => scenario.key)));

if (output.schema_version !== validationConfig.schema) {
  throw new Error(`Unexpected schema_version: ${output.schema_version}`);
}
if (output.prompt_version !== validationConfig.prompt) {
  throw new Error(`Unexpected prompt_version: ${output.prompt_version}`);
}

const generatedRows = output.datasets.flatMap((dataset) => dataset.scenarios.map((scenario) => ({
  dataset_id: dataset.dataset_id,
  ...scenario,
})));
if (generatedRows.length !== expectedScenarioKeys.size) {
  throw new Error(`Expected ${expectedScenarioKeys.size} scenarios, found ${generatedRows.length}`);
}

for (const row of generatedRows) {
  if (!expectedScenarioKeys.has(row.key)) throw new Error(`Unexpected scenario key: ${row.key}`);
  const dataset = modelById.get(row.dataset_id);
  if (!dataset) throw new Error(`Unknown dataset: ${row.dataset_id}`);
  const expectedEdges = dataset.edges.map((edge) => `${edge.source}->${edge.target}`);
  if (typeof row.professional_explanation !== "string" || row.professional_explanation.length < 250) {
    throw new Error(`${row.key}: professional_explanation is too short`);
  }
  if (typeof row.children_story !== "string" || row.children_story.length < validationConfig.minimumStoryLength) {
    throw new Error(`${row.key}: children_story is too short`);
  }
  for (const field of ["professional", "children_story"]) {
    const actual = row.coverage?.[field];
    const actualSet = new Set(actual ?? []);
    const missing = expectedEdges.filter((edge) => !actualSet.has(edge));
    const unexpected = [...actualSet].filter((edge) => !expectedEdges.includes(edge));
    if (!Array.isArray(actual) || actual.length !== expectedEdges.length || actualSet.size !== expectedEdges.length || missing.length || unexpected.length) {
      throw new Error(`${row.key}: invalid coverage.${field}; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
    }
  }
}

console.log(`Validated ${generatedRows.length} ${narrativeVersion} narratives with complete professional and story edge coverage.`);
