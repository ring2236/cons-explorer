import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outputPath = resolve(process.argv[2] ?? "lib/scenarios.generated.json");
const bundle = JSON.parse(readFileSync(new URL("../lib/models.generated.json", import.meta.url), "utf8"));
const plan = JSON.parse(readFileSync(new URL("../lib/intervention-plan.json", import.meta.url), "utf8"));

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value) => Math.round(value * 1e10) / 1e10;

function evaluate(expression, values) {
  switch (expression.op) {
    case "const": return Number(expression.value);
    case "var": return values[expression.id];
    case "add": return expression.args.reduce((sum, item) => sum + evaluate(item, values), 0);
    case "sub": return evaluate(expression.a, values) - evaluate(expression.b, values);
    case "mul": return expression.args.reduce((product, item) => product * evaluate(item, values), 1);
    case "div": return evaluate(expression.a, values) / evaluate(expression.b, values);
    case "pow": return Math.pow(evaluate(expression.a, values), evaluate(expression.b, values));
    case "sigmoid": return 1 / (1 + Math.exp(-evaluate(expression.x, values)));
    case "tanh": return Math.tanh(evaluate(expression.x, values));
    case "exp": return Math.exp(evaluate(expression.x, values));
    case "log": return Math.log(evaluate(expression.x, values));
    case "max": return Math.max(...expression.args.map((item) => evaluate(item, values)));
    case "clip": return clamp(evaluate(expression.x, values), expression.min, expression.max);
    default: throw new Error(`Unsupported expression operation: ${expression.op}`);
  }
}

function evaluateNode(node, values) {
  if (node.mechanism.type === "input") return node.reference_value;
  if (node.mechanism.type === "expression") {
    return clamp(evaluate(node.mechanism.expression, values), node.min_value, node.max_value);
  }
  throw new Error(`Unsupported node mechanism: ${node.mechanism.type}`);
}

function descendantSet(dataset, interventionIds) {
  const children = new Map(dataset.nodes.map((node) => [node.id, node.children]));
  const affected = new Set();
  const queue = [...interventionIds];
  while (queue.length) {
    const source = queue.shift();
    for (const child of children.get(source) ?? []) {
      if (!affected.has(child)) {
        affected.add(child);
        queue.push(child);
      }
    }
  }
  return affected;
}

function combinations(controlEntries) {
  return controlEntries.reduce(
    (rows, [nodeId, options]) => rows.flatMap((row) => [
      ...options.map((value) => ({ ...row, [nodeId]: value })),
      { ...row, [nodeId]: null },
    ]),
    [{}],
  );
}

function simulate(dataset, controls, assignments) {
  const nodeMap = new Map(dataset.nodes.map((node) => [node.id, node]));
  const baseline = Object.fromEntries(dataset.nodes.map((node) => [node.id, node.reference_value]));
  const interventionIds = Object.entries(assignments)
    .filter(([, value]) => value !== null)
    .map(([nodeId]) => nodeId);
  const affected = descendantSet(dataset, interventionIds);
  const values = { ...baseline };

  for (const nodeId of dataset.topological_order) {
    const node = nodeMap.get(nodeId);
    if (!node) throw new Error(`Unknown node in topological order: ${nodeId}`);
    if (assignments[nodeId] !== undefined && assignments[nodeId] !== null) {
      values[nodeId] = clamp(assignments[nodeId], node.min_value, node.max_value);
    } else if (affected.has(nodeId)) {
      values[nodeId] = evaluateNode(node, values);
    }
  }

  for (const node of dataset.nodes) {
    if (!Number.isFinite(values[node.id])) throw new Error(`${dataset.dataset_id}: ${node.id} is not finite`);
    if (values[node.id] < node.min_value - 1e-8 || values[node.id] > node.max_value + 1e-8) {
      throw new Error(`${dataset.dataset_id}: ${node.id} is outside its declared bounds`);
    }
  }

  const changedNodeIds = dataset.topological_order.filter((nodeId) => {
    const node = nodeMap.get(nodeId);
    return Math.abs(values[nodeId] - baseline[nodeId]) >= Math.pow(10, -(node.decimals + 1));
  });
  const changed = new Set(changedNodeIds);
  const interventions = Object.entries(assignments)
    .filter(([, value]) => value !== null)
    .map(([nodeId, value]) => ({ node_id: nodeId, value, label_zh: nodeMap.get(nodeId).label_zh, unit: nodeMap.get(nodeId).unit }));

  return {
    key: `${dataset.dataset_id}|${Object.keys(controls).map((nodeId) => `${nodeId}=${assignments[nodeId] ?? "natural"}`).join("|")}`,
    is_observational_baseline: interventions.length === 0,
    assignments,
    interventions,
    values: Object.fromEntries(Object.entries(values).map(([nodeId, value]) => [nodeId, round(value)])),
    changed_node_ids: changedNodeIds,
    affected_edge_keys: dataset.edges
      .filter((edge) => changed.has(edge.source) && changed.has(edge.target))
      .map((edge) => `${edge.source}->${edge.target}`),
  };
}

function buildDataset(dataset) {
  const config = plan.datasets[dataset.dataset_id];
  if (!config) throw new Error(`No intervention plan for ${dataset.dataset_id}`);
  const nodeMap = new Map(dataset.nodes.map((node) => [node.id, node]));
  const controlEntries = Object.entries(config.controls);
  for (const [nodeId, options] of controlEntries) {
    const node = nodeMap.get(nodeId);
    if (!node) throw new Error(`${dataset.dataset_id}: unknown control node ${nodeId}`);
    if (!Array.isArray(options) || options.length !== 5 || new Set(options).size !== 5) {
      throw new Error(`${dataset.dataset_id}: ${nodeId} must have exactly five distinct values`);
    }
    for (const value of options) {
      if (!Number.isFinite(value) || value < node.min_value || value > node.max_value) {
        throw new Error(`${dataset.dataset_id}: invalid control value ${nodeId}=${value}`);
      }
    }
  }

  const scenarios = combinations(controlEntries).map((assignments) => simulate(dataset, config.controls, assignments));
  const expectedCount = 6 ** controlEntries.length;
  if (scenarios.length !== expectedCount) throw new Error(`${dataset.dataset_id}: expected ${expectedCount} scenarios, got ${scenarios.length}`);
  return {
    dataset_id: dataset.dataset_id,
    title_zh: dataset.title_zh,
    controls: controlEntries.map(([nodeId, options]) => {
      const node = nodeMap.get(nodeId);
      return { node_id: nodeId, label_zh: node.label_zh, unit: node.unit, values: options };
    }),
    scenario_count: scenarios.length,
    intervention_scenario_count: scenarios.length - 1,
    scenarios,
  };
}

const datasets = bundle.datasets.map(buildDataset);
const output = {
  schema_version: "static-scenarios-v1",
  model_version: bundle.model_version,
  intervention_plan_version: plan.schema_version,
  generated_at: new Date().toISOString(),
  totals: {
    datasets: datasets.length,
    scenarios: datasets.reduce((sum, dataset) => sum + dataset.scenario_count, 0),
    intervention_scenarios: datasets.reduce((sum, dataset) => sum + dataset.intervention_scenario_count, 0),
  },
  datasets,
};

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outputPath}: ${output.totals.scenarios} states (${output.totals.intervention_scenarios} with at least one do()).`);
