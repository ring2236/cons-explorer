import narrativesBundle from "./narratives-v4.generated.json";
import scenariosBundle from "./scenarios.generated.json";
import { isActiveDataset } from "./active-datasets";

export type StaticControl = {
  node_id: string;
  label_zh: string;
  unit: string;
  values: number[];
};

export type StaticIntervention = {
  node_id: string;
  value: number;
  label_zh: string;
  unit: string;
};

export type StaticScenario = {
  key: string;
  is_observational_baseline: boolean;
  assignments: Record<string, number | null>;
  interventions: StaticIntervention[];
  values: Record<string, number>;
  changed_node_ids: string[];
  affected_edge_keys: string[];
};

export type StaticScenarioDataset = {
  dataset_id: string;
  title_zh: string;
  controls: StaticControl[];
  scenario_count: number;
  scenarios: StaticScenario[];
};

export type StaticNarrative = {
  key: string;
  professional_explanation: string;
  children_story: string;
};

type NarrativeDataset = {
  dataset_id: string;
  story_bible: { title: string; protagonist: string; setting: string };
  scenarios: StaticNarrative[];
};

const scenarioDatasets = (scenariosBundle as unknown as { datasets: StaticScenarioDataset[] }).datasets
  .filter((dataset) => isActiveDataset(dataset.dataset_id));
const narrativeDatasets = (narrativesBundle as unknown as { datasets: NarrativeDataset[] }).datasets
  .filter((dataset) => isActiveDataset(dataset.dataset_id));
const scenarioDatasetById = new Map(scenarioDatasets.map((dataset) => [dataset.dataset_id, dataset]));
const narrativeDatasetById = new Map(narrativeDatasets.map((dataset) => [dataset.dataset_id, dataset]));
const scenarioByKey = new Map(scenarioDatasets.flatMap((dataset) => dataset.scenarios.map((scenario) => [scenario.key, scenario] as const)));
const narrativeByKey = new Map(narrativeDatasets.flatMap((dataset) => dataset.scenarios.map((narrative) => [narrative.key, narrative] as const)));

export const staticTotals = {
  datasets: scenarioDatasets.length,
  scenarios: scenarioDatasets.reduce((sum, dataset) => sum + dataset.scenarios.length, 0),
  intervention_scenarios: scenarioDatasets.reduce(
    (sum, dataset) => sum + dataset.scenarios.filter((scenario) => scenario.interventions.length > 0).length,
    0,
  ),
};

export function getStaticDataset(datasetId: string): StaticScenarioDataset {
  const dataset = scenarioDatasetById.get(datasetId);
  if (!dataset) throw new Error(`Unknown static dataset: ${datasetId}`);
  return dataset;
}

export function buildScenarioKey(dataset: StaticScenarioDataset, assignments: Record<string, number | null>): string {
  return [
    dataset.dataset_id,
    ...dataset.controls.map((control) => `${control.node_id}=${assignments[control.node_id] ?? "natural"}`),
  ].join("|");
}

export function getStaticScenario(dataset: StaticScenarioDataset, assignments: Record<string, number | null>): StaticScenario {
  const key = buildScenarioKey(dataset, assignments);
  const scenario = scenarioByKey.get(key);
  if (!scenario) throw new Error(`Unknown static scenario: ${key}`);
  return scenario;
}

export function getStaticNarrative(key: string): StaticNarrative {
  const narrative = narrativeByKey.get(key);
  if (!narrative) throw new Error(`Missing static narrative: ${key}`);
  return narrative;
}

export function getStoryBible(datasetId: string): NarrativeDataset["story_bible"] {
  const dataset = narrativeDatasetById.get(datasetId);
  if (!dataset) throw new Error(`Missing story bible: ${datasetId}`);
  return dataset.story_bible;
}
