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
  v4: {
    path: "lib/narratives-v4.generated.json",
    schema: "static-narratives-natural-professional-v4",
    prompt: "natural-professional-explanation-v4",
    minimumStoryLength: 220,
    naturalProfessional: true,
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
const sourceV3 = validationConfig.naturalProfessional
  ? JSON.parse(readFileSync(new URL("../lib/narratives-v3.generated.json", import.meta.url), "utf8"))
  : null;
const sourceV3ByKey = new Map(
  (sourceV3?.datasets ?? []).flatMap((dataset) => dataset.scenarios.map((scenario) => [scenario.key, scenario])),
);
const bannedProfessionalTerms = [
  "根节点",
  "叶子节点",
  "中介节点",
  "碰撞点",
  "节点",
  "变量",
  "有向边",
  "因果边",
  "结构方程",
  "因果图",
  "路径被截断",
  "驱动被截断",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function professionalStyleViolations(dataset, text) {
  const violations = bannedProfessionalTerms.filter((term) => text.includes(term));
  if (text.includes("->") || text.includes("→")) violations.push("箭头表达");
  if (/[A-Za-z][A-Za-z0-9_]*\s*=/.test(text)) violations.push("字母等式");
  for (const nodeId of dataset.nodes.map((node) => node.id).sort((left, right) => right.length - left.length)) {
    const idAsSubjectPattern = new RegExp(
      `(^|[，。；：、\\s])${escapeRegExp(nodeId)}(?=(?:为|是|对|受|由|升高|降低|增加|减少|影响|促进|抑制|决定|导致|使))`,
    );
    if (idAsSubjectPattern.test(text)) violations.push(`内部编号 ${nodeId}`);
  }
  return [...new Set(violations)];
}

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
  if (validationConfig.naturalProfessional) {
    const styleViolations = professionalStyleViolations(dataset, row.professional_explanation);
    if (styleViolations.length) {
      throw new Error(`${row.key}: professional_explanation contains forbidden notation: ${styleViolations.join(", ")}`);
    }
    const sourceStory = sourceV3ByKey.get(row.key)?.children_story;
    if (row.children_story !== sourceStory) throw new Error(`${row.key}: children_story differs from v3 source`);
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

console.log(`Validated ${generatedRows.length} ${narrativeVersion} narratives with complete professional and story edge coverage${validationConfig.naturalProfessional ? ", natural professional wording, and unchanged v3 stories" : ""}.`);
