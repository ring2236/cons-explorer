import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sourcePath = process.argv[2];
const outputPath = process.argv[3] ?? "lib/models.generated.json";

if (!sourcePath) {
  throw new Error("Usage: node scripts/parse-models.mjs <source.txt> [output.json]");
}

const source = readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, "");
const sourceHash = createHash("sha256").update(source).digest("hex");

function field(block, name) {
  const match = block.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function numberField(block, name) {
  const value = field(block, name);
  if (value == null || value === "无") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitIds(value) {
  if (!value || value.includes("无（")) return [];
  return value
    .replace(/（.*$/, "")
    .split("；")
    .map((item) => item.trim())
    .filter(Boolean);
}

function round(value, decimals) {
  return Number(value.toFixed(Math.max(0, Math.min(6, decimals ?? 2))));
}

function discreteOptions(node) {
  if (!node.intervenable) return [];
  const values = [
    { kind: "low", label: "较低情景", value: node.reference_value - (node.reference_value - node.min_value) * 0.5 },
    { kind: "baseline", label: "基线", value: node.reference_value },
  ];
  if (node.suggested_intervention != null) {
    values.push({ kind: "recommended", label: "推荐情景", value: node.suggested_intervention });
  }
  values.push({
    kind: "high",
    label: "较高情景",
    value: node.reference_value + (node.max_value - node.reference_value) * 0.5,
  });

  const unique = new Map();
  for (const item of values) {
    const value = round(Math.max(node.min_value, Math.min(node.max_value, item.value)), node.decimals);
    unique.set(value.toString(), { ...item, value });
  }
  return [...unique.values()].sort((a, b) => a.value - b.value);
}

const datasetPattern = /#{20,}\n数据集\s+\d+：([^\n]+)\n#{20,}\n([\s\S]*?)(?=\n#{20,}\n数据集\s+\d+：|\n={20,}\n附录：)/g;
const datasets = [];
let datasetMatch;

while ((datasetMatch = datasetPattern.exec(source))) {
  const heading = datasetMatch[1].trim();
  const block = datasetMatch[2];
  const [titleZh, titleEn = ""] = heading.split(" / ");
  const id = block.match(/^ID：(.+)$/m)?.[1]?.trim();
  if (!id) throw new Error(`Missing dataset id for ${heading}`);

  const nodeArea = block.match(/四、全部节点与计算方式\n([\s\S]*?)\n五、按拓扑顺序的结构方程摘要/)?.[1] ?? "";
  const nodeScanArea = `${nodeArea}\n  [END]`;
  const nodePattern = /^\s*\[(\d+)\] 节点 (.+?)：(.+?) \/ ([^\n]+)\n([\s\S]*?)(?=^\s*\[\d+\] 节点 |^\s*\[END\])/gm;
  const nodes = [];
  let nodeMatch;
  while ((nodeMatch = nodePattern.exec(nodeScanArea))) {
    const nodeBlock = nodeMatch[5];
    const mechanismLine = nodeBlock.match(/^\s*mechanism_json:\s*(\{.+\})$/m)?.[1];
    if (!mechanismLine) throw new Error(`Missing mechanism for ${id}/${nodeMatch[2]}`);
    const node = {
      id: nodeMatch[2].trim(),
      label_zh: nodeMatch[3].trim(),
      label_en: nodeMatch[4].trim(),
      role: field(nodeBlock, "role"),
      unit: field(nodeBlock, "unit"),
      reference_value: numberField(nodeBlock, "reference_value"),
      min_value: numberField(nodeBlock, "min_value"),
      max_value: numberField(nodeBlock, "max_value"),
      decimals: numberField(nodeBlock, "decimals"),
      intervenable: field(nodeBlock, "intervenable") === "是",
      suggested_intervention: numberField(nodeBlock, "suggested_intervention"),
      parents: splitIds(field(nodeBlock, "父节点")),
      children: splitIds(field(nodeBlock, "子节点")),
      mechanism: JSON.parse(mechanismLine),
    };
    node.discrete_options = discreteOptions(node);
    nodes.push(node);
  }

  const edgeArea = block.match(/3\.3 全部因果边：\n([\s\S]*?)\n\s*3\.4 父子邻接关系/)?.[1] ?? "";
  const edges = [];
  for (const line of edgeArea.split("\n")) {
    const edgeMatch = line.match(/^\s*\d+\.\s+(.+?)\(.+?\) -> (.+?)\(.+?\)；(.+)$/);
    if (!edgeMatch) continue;
    const metadata = edgeMatch[3];
    edges.push({
      source: edgeMatch[1].trim(),
      target: edgeMatch[2].trim(),
      sign: metadata.match(/sign=([^；]+)/)?.[1] ?? "unspecified",
      relation: metadata.match(/relation=([^；]+)/)?.[1] ?? null,
    });
  }

  const topoText = block.match(/3\.1 拓扑计算顺序：(.+)$/m)?.[1] ?? "";
  const topological_order = topoText.split(" → ").map((item) => item.trim()).filter(Boolean);
  const layoutText = block.match(/^\s*layout:\s*(\{.+\})$/m)?.[1];

  datasets.push({
    schema_version: "3.0-demo",
    dataset_id: id,
    title_zh: titleZh,
    title_en: titleEn,
    domain: block.match(/^领域：(.+)$/m)?.[1]?.trim() ?? "",
    boundary_zh: block.match(/^边界\/用途说明：(.+)$/m)?.[1]?.trim() ?? "",
    topological_order,
    nodes,
    edges,
    layout: layoutText ? JSON.parse(layoutText) : {},
  });
}

if (datasets.length !== 5) throw new Error(`Expected 5 datasets, got ${datasets.length}`);
const totalNodes = datasets.reduce((sum, item) => sum + item.nodes.length, 0);
const totalEdges = datasets.reduce((sum, item) => sum + item.edges.length, 0);
if (totalNodes !== 36 || totalEdges !== 38) {
  console.error(datasets.map((item) => `${item.dataset_id}: ${item.nodes.length} nodes / ${item.edges.length} edges`).join("\n"));
  throw new Error(`Expected 36 nodes/38 edges, got ${totalNodes}/${totalEdges}`);
}

for (const dataset of datasets) {
  const ids = new Set(dataset.nodes.map((node) => node.id));
  for (const edge of dataset.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      throw new Error(`Unknown edge node in ${dataset.dataset_id}: ${edge.source} -> ${edge.target}`);
    }
  }
  if (dataset.topological_order.length !== dataset.nodes.length) {
    throw new Error(`Invalid topological order in ${dataset.dataset_id}`);
  }
}

const output = {
  model_version: `txt-v3-${sourceHash.slice(0, 12)}`,
  source_file: sourcePath.split("/").pop(),
  source_sha256: sourceHash,
  generated_at: new Date().toISOString(),
  totals: { datasets: datasets.length, nodes: totalNodes, edges: totalEdges },
  datasets,
};

const absoluteOutput = resolve(outputPath);
mkdirSync(dirname(absoluteOutput), { recursive: true });
writeFileSync(absoluteOutput, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Generated ${absoluteOutput}: ${datasets.length} datasets, ${totalNodes} nodes, ${totalEdges} edges`);
