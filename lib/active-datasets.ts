export const ACTIVE_DATASET_IDS = [
  "rice_nitrogen",
  "tutoring_education",
  "supply_chain_bullwhip",
] as const;

const activeDatasetIdSet = new Set<string>(ACTIVE_DATASET_IDS);

export function isActiveDataset(datasetId: string): boolean {
  return activeDatasetIdSet.has(datasetId);
}
