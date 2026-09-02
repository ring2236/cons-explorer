import modelBundle from "./models.generated.json";

export type DiscreteOption = {
  kind: string;
  label: string;
  value: number;
};

export type ModelNode = {
  id: string;
  label_zh: string;
  label_en: string;
  role: string;
  unit: string;
  reference_value: number;
  min_value: number;
  max_value: number;
  decimals: number;
  intervenable: boolean;
  suggested_intervention: number | null;
  parents: string[];
  children: string[];
  mechanism: Record<string, any>;
  discrete_options: DiscreteOption[];
  latent?: boolean;
};

export type BiasPoint = {
  name: string;
  structure: string;
  note: string;
};

export type Dataset = {
  schema_version: string;
  dataset_id: string;
  title_zh: string;
  title_en: string;
  domain: string;
  expertise?: string;
  boundary_zh: string;
  topological_order: string[];
  nodes: ModelNode[];
  edges: Array<{ source: string; target: string; sign: string; relation: string | null }>;
  layout: Record<string, [number, number]>;
  bias_points?: BiasPoint[];
};

export const models = modelBundle as {
  model_version: string;
  source_file: string;
  source_sha256: string;
  totals: { datasets: number; nodes: number; edges: number };
  datasets: Dataset[];
};

export type SimulationResult = {
  datasetId: string;
  interventionNode: string;
  interventionValue: number;
  baseline: Record<string, number>;
  values: Record<string, number>;
  changedNodeIds: string[];
  affectedEdgeKeys: string[];
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function evaluateExpression(expression: Record<string, any>, values: Record<string, number>): number {
  switch (expression.op) {
    case "const": return Number(expression.value);
    case "var": return values[expression.id];
    case "add": return expression.args.reduce((sum: number, item: Record<string, any>) => sum + evaluateExpression(item, values), 0);
    case "sub": return evaluateExpression(expression.a, values) - evaluateExpression(expression.b, values);
    case "mul": return expression.args.reduce((product: number, item: Record<string, any>) => product * evaluateExpression(item, values), 1);
    case "div": return evaluateExpression(expression.a, values) / evaluateExpression(expression.b, values);
    case "pow": return Math.pow(evaluateExpression(expression.a, values), evaluateExpression(expression.b, values));
    case "sigmoid": return 1 / (1 + Math.exp(-evaluateExpression(expression.x, values)));
    case "tanh": return Math.tanh(evaluateExpression(expression.x, values));
    case "exp": return Math.exp(evaluateExpression(expression.x, values));
    case "log": return Math.log(evaluateExpression(expression.x, values));
    case "max": return Math.max(...expression.args.map((item: Record<string, any>) => evaluateExpression(item, values)));
    case "clip": return clamp(evaluateExpression(expression.x, values), expression.min, expression.max);
    default: throw new Error(`Unsupported expression op: ${expression.op}`);
  }
}

function evaluateNode(node: ModelNode, values: Record<string, number>): number {
  const mechanism = node.mechanism;
  if (mechanism.type === "input") return node.reference_value;
  if (mechanism.type === "expression") {
    return clamp(evaluateExpression(mechanism.expression, values), node.min_value, node.max_value);
  }
  if (mechanism.type === "robust_merge") {
    let z = 0;
    for (const parent of mechanism.parents) {
      const x = values[parent.id];
      const scale = x >= parent.reference
        ? parent.high - parent.reference
        : parent.reference - parent.low;
      z += parent.gain * Math.tanh((x - parent.reference) / Math.max(scale, Number.EPSILON));
    }
    const u = Math.tanh(z);
    const result = u >= 0
      ? mechanism.reference + (mechanism.high - mechanism.reference) * u
      : mechanism.reference + (mechanism.reference - mechanism.low) * u;
    return clamp(result, node.min_value, node.max_value);
  }
  if (mechanism.type === "hill_network") {
    const hill = (x: number, k: number, h: number) => {
      const safeX = Math.max(0, x);
      return Math.pow(safeX, h) / (Math.pow(k, h) + Math.pow(safeX, h));
    };
    let z = 0;
    for (const parent of mechanism.parents) {
      z += parent.gain * (
        hill(values[parent.id], parent.k, parent.hill)
        - hill(parent.reference, parent.k, parent.hill)
      );
    }
    const u = Math.tanh(mechanism.output_gain * z);
    const result = u >= 0
      ? mechanism.reference + (mechanism.high - mechanism.reference) * u
      : mechanism.reference + (mechanism.reference - mechanism.low) * u;
    return clamp(result, node.min_value, node.max_value);
  }
  throw new Error(`Unsupported mechanism type: ${mechanism.type}`);
}

export function getDataset(datasetId: string): Dataset {
  const dataset = models.datasets.find((item) => item.dataset_id === datasetId);
  if (!dataset) throw new Error(`Unknown dataset: ${datasetId}`);
  return dataset;
}

export function isAllowedDiscreteValue(node: ModelNode, value: number): boolean {
  return node.discrete_options.some((option) => Math.abs(option.value - value) < 1e-9);
}

export function simulate(dataset: Dataset, interventionNode: string, interventionValue: number): SimulationResult {
  const nodeMap = new Map(dataset.nodes.map((node) => [node.id, node]));
  const target = nodeMap.get(interventionNode);
  if (!target?.intervenable) throw new Error("该节点不可干预");
  if (!isAllowedDiscreteValue(target, interventionValue)) throw new Error("干预值不在预设离散选项中");

  const baseline = Object.fromEntries(dataset.nodes.map((node) => [node.id, node.reference_value]));
  const values = { ...baseline };
  values[target.id] = clamp(interventionValue, target.min_value, target.max_value);

  // Reference values in the teaching document are rounded. A baseline intervention
  // therefore returns the frozen baseline verbatim instead of recomputing descendants.
  if (Math.abs(values[target.id] - target.reference_value) < 1e-9) {
    return {
      datasetId: dataset.dataset_id,
      interventionNode,
      interventionValue: values[target.id],
      baseline,
      values,
      changedNodeIds: [],
      affectedEdgeKeys: [],
    };
  }

  const descendants = new Set<string>();
  const queue = [target.id];
  while (queue.length) {
    const source = queue.shift()!;
    for (const edge of dataset.edges.filter((item) => item.source === source)) {
      if (!descendants.has(edge.target)) {
        descendants.add(edge.target);
        queue.push(edge.target);
      }
    }
  }

  for (const nodeId of dataset.topological_order) {
    if (!descendants.has(nodeId)) continue;
    const node = nodeMap.get(nodeId);
    if (node) values[nodeId] = evaluateNode(node, values);
  }

  const changedNodeIds = dataset.topological_order.filter((nodeId) => {
    const node = nodeMap.get(nodeId)!;
    return Math.abs(values[nodeId] - baseline[nodeId]) >= Math.pow(10, -(node.decimals + 1));
  });
  const changedSet = new Set(changedNodeIds);
  const affectedEdgeKeys = dataset.edges
    .filter((edge) => changedSet.has(edge.source) && changedSet.has(edge.target))
    .map((edge) => `${edge.source}->${edge.target}`);

  return {
    datasetId: dataset.dataset_id,
    interventionNode,
    interventionValue: values[target.id],
    baseline,
    values,
    changedNodeIds,
    affectedEdgeKeys,
  };
}

export function formatValue(node: ModelNode, value: number): string {
  return `${value.toFixed(node.decimals)} ${node.unit}`;
}

export function buildDeterministicNarrative(dataset: Dataset, result: SimulationResult): string {
  const nodeMap = new Map(dataset.nodes.map((node) => [node.id, node]));
  const target = nodeMap.get(result.interventionNode)!;
  const direction = result.interventionValue > result.baseline[target.id] ? "提高" : result.interventionValue < result.baseline[target.id] ? "降低" : "保持";
  const downstream = result.changedNodeIds.filter((id) => id !== target.id);
  const steps = downstream.map((id) => {
    const node = nodeMap.get(id)!;
    const delta = result.values[id] - result.baseline[id];
    return `${node.label_zh}${delta >= 0 ? "上升" : "下降"}到${formatValue(node, result.values[id])}`;
  });
  if (!steps.length) {
    return `在这次模拟中，${target.label_zh}被设为${formatValue(target, result.interventionValue)}，与基线相比没有产生可显示的下游变化。`;
  }
  return `在这次模拟中，${target.label_zh}从${formatValue(target, result.baseline[target.id])}${direction}到${formatValue(target, result.interventionValue)}。变化沿图中的有向路径向下游传播，${steps.join("，随后")}。这些数值来自当前结构因果模型，只用于解释模型内部的变化规律。`;
}
