import { readFileSync } from "node:fs";

const bundle = JSON.parse(readFileSync(new URL("../lib/models.generated.json", import.meta.url), "utf8"));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

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
    case "exp": return Math.exp(evaluate(expression.x, values));
    case "log": return Math.log(evaluate(expression.x, values));
    case "max": return Math.max(...expression.args.map((item) => evaluate(item, values)));
    default: throw new Error(`Unsupported operation: ${expression.op}`);
  }
}

function simulate(datasetId, interventionNode, interventionValue) {
  const dataset = bundle.datasets.find((item) => item.dataset_id === datasetId);
  const nodeMap = new Map(dataset.nodes.map((node) => [node.id, node]));
  const values = Object.fromEntries(dataset.nodes.map((node) => [node.id, node.reference_value]));
  values[interventionNode] = interventionValue;
  const descendants = new Set();
  const queue = [interventionNode];
  while (queue.length) {
    const source = queue.shift();
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
    values[nodeId] = clamp(evaluate(node.mechanism.expression, values), node.min_value, node.max_value);
  }
  return values;
}

const frozenCases = [
  ["icu_septic_shock", "N", 0.60, { M: 95.66, U: 1.53, R: 42.75 }],
  ["rice_nitrogen", "N", 320, { LAI: 4.51, Ld: 51.89, Y: 5.67 }],
  ["monetary_policy", "R", 5.40, { L: 7.00, C: 8.00, I: 6.38, P: 3.59, U: 4.29 }],
  ["tutoring_education", "T", 10, { S: 13.00, H: 7.18, A: 3.30, G: 74.60 }],
  ["supply_chain_bullwhip", "S", 9, { O: 1149.85, L: 9.59, K: 12.61 }],
  ["supply_chain_bullwhip", "S", 2, { O: 872.30, L: 5.78, K: 60.44 }],
];

for (const [datasetId, nodeId, value, expected] of frozenCases) {
  const actual = simulate(datasetId, nodeId, value);
  for (const [outcome, expectedValue] of Object.entries(expected)) {
    const delta = Math.abs(actual[outcome] - expectedValue);
    if (delta > 0.055) {
      throw new Error(`${datasetId} do(${nodeId}=${value}) ${outcome}: expected ${expectedValue}, got ${actual[outcome]}`);
    }
  }
}

console.log(`Validated ${frozenCases.length} frozen intervention scenarios against the source document.`);
