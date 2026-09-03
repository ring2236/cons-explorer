"use client";

import { useMemo, useState } from "react";
import { formatValue, getDataset, models, type Dataset, type ModelNode } from "../lib/causal-engine";
import {
  getStaticDataset,
  getStaticNarrative,
  getStaticScenario,
  getStoryBible,
  type StaticScenario,
} from "../lib/static-experience";

type Assignments = Record<string, number | null>;
type NarrativeMode = "professional" | "story";

function naturalAssignments(datasetId: string): Assignments {
  const dataset = getStaticDataset(datasetId);
  return Object.fromEntries(dataset.controls.map((control) => [control.node_id, null]));
}

type Edge = Dataset["edges"][number];
type ConnectionSide = "top" | "right" | "bottom" | "left";

function connectionSide(source: [number, number], target: [number, number], atSource: boolean): ConnectionSide {
  const dx = target[0] - source[0];
  const dy = target[1] - source[1];
  if (Math.abs(dy) < 90 && Math.abs(dx) > Math.abs(dy)) {
    if (atSource) return dx >= 0 ? "right" : "left";
    return dx >= 0 ? "left" : "right";
  }
  if (atSource) return dy >= 0 ? "bottom" : "top";
  return dy >= 0 ? "top" : "bottom";
}

function edgeKey(edge: Edge) {
  return `${edge.source}->${edge.target}`;
}

function portOffset(dataset: Dataset, edge: Edge, nodeId: string, side: ConnectionSide, atSource: boolean): number {
  const positions = dataset.layout;
  const siblings = dataset.edges
    .filter((candidate) => {
      const candidateNodeId = atSource ? candidate.source : candidate.target;
      if (candidateNodeId !== nodeId) return false;
      const source = positions[candidate.source];
      const target = positions[candidate.target];
      return source && target && connectionSide(source, target, atSource) === side;
    })
    .sort((a, b) => {
      const aOther = positions[atSource ? a.target : a.source];
      const bOther = positions[atSource ? b.target : b.source];
      const axis = side === "top" || side === "bottom" ? 0 : 1;
      return aOther[axis] - bOther[axis] || edgeKey(a).localeCompare(edgeKey(b));
    });
  if (siblings.length <= 1) return 0;
  const index = siblings.findIndex((candidate) => edgeKey(candidate) === edgeKey(edge));
  const span = side === "top" || side === "bottom" ? 104 : 34;
  return -span / 2 + (span * index) / (siblings.length - 1);
}

function connectionPoint(position: [number, number], side: ConnectionSide, offset: number, gap: number): [number, number] {
  switch (side) {
    case "top": return [position[0] + offset, position[1] - 30 - gap];
    case "right": return [position[0] + 76 + gap, position[1] + offset];
    case "bottom": return [position[0] + offset, position[1] + 30 + gap];
    case "left": return [position[0] - 76 - gap, position[1] + offset];
  }
}

function routedEdgePath(dataset: Dataset, edge: Edge): string {
  const sourcePosition = dataset.layout[edge.source];
  const targetPosition = dataset.layout[edge.target];
  const sourceSide = connectionSide(sourcePosition, targetPosition, true);
  const targetSide = connectionSide(sourcePosition, targetPosition, false);
  const sourceOffset = portOffset(dataset, edge, edge.source, sourceSide, true);
  const targetOffset = portOffset(dataset, edge, edge.target, targetSide, false);
  const start = connectionPoint(sourcePosition, sourceSide, sourceOffset, 3);
  const end = connectionPoint(targetPosition, targetSide, targetOffset, 9);
  const horizontal = sourceSide === "left" || sourceSide === "right";

  if (horizontal) {
    const direction = sourceSide === "right" ? 1 : -1;
    const bend = Math.min(150, Math.max(48, Math.abs(end[0] - start[0]) * 0.45));
    return `M ${start[0]} ${start[1]} C ${start[0] + direction * bend} ${start[1]}, ${end[0] - direction * bend} ${end[1]}, ${end[0]} ${end[1]}`;
  }

  const direction = sourceSide === "bottom" ? 1 : -1;
  const bend = Math.min(145, Math.max(48, Math.abs(end[1] - start[1]) * 0.42));
  return `M ${start[0]} ${start[1]} C ${start[0]} ${start[1] + direction * bend}, ${end[0]} ${end[1] - direction * bend}, ${end[0]} ${end[1]}`;
}

function Graph({ dataset, scenario, focusedNodeId, onSelect }: {
  dataset: Dataset;
  scenario: StaticScenario;
  focusedNodeId: string | null;
  onSelect: (node: ModelNode) => void;
}) {
  const baseline = Object.fromEntries(dataset.nodes.map((node) => [node.id, node.reference_value]));
  const changed = new Set(scenario.changed_node_ids);
  const directlySet = new Set(scenario.interventions.map((item) => item.node_id));
  const activeEdges = new Set(scenario.affected_edge_keys);
  const positions = dataset.layout;
  const routedEdges = [...dataset.edges].sort((a, b) => Number(activeEdges.has(edgeKey(a))) - Number(activeEdges.has(edgeKey(b))));

  return (
    <svg className="causal-graph" viewBox="0 0 1000 620" role="img" aria-label={`${dataset.title_zh}因果图`}>
      <defs>
        <marker id="arrow-neutral" viewBox="0 0 10 10" markerWidth="10" markerHeight="10" refX="9.5" refY="5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L10,5 L0,10 Z" fill="#8e9b96" />
        </marker>
        <marker id="arrow-active" viewBox="0 0 10 10" markerWidth="11" markerHeight="11" refX="9.5" refY="5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L10,5 L0,10 Z" fill="#087f6b" />
        </marker>
      </defs>
      {routedEdges.map((edge) => {
        const active = activeEdges.has(`${edge.source}->${edge.target}`);
        const path = routedEdgePath(dataset, edge);
        return (
          <g key={`${edge.source}-${edge.target}`} className="graph-edge-group">
            <path className={`graph-edge-halo ${active ? "active" : ""}`} d={path} />
            <path className={`graph-edge ${active ? "active" : ""}`} d={path} markerEnd={`url(#arrow-${active ? "active" : "neutral"})`} />
          </g>
        );
      })}
      {dataset.nodes.map((node) => {
        const position = positions[node.id];
        if (!position) return null;
        const value = scenario.values[node.id];
        const delta = value - baseline[node.id];
        const state = directlySet.has(node.id)
          ? "selected"
          : changed.has(node.id)
            ? (delta >= 0 ? "up" : "down")
            : "stable";
        return (
          <g
            key={node.id}
            className={`graph-node ${state} ${node.intervenable ? "clickable" : ""} ${node.latent ? "latent" : ""} ${focusedNodeId === node.id ? "focused" : ""}`}
            transform={`translate(${position[0] - 76}, ${position[1] - 30})`}
            onClick={() => node.intervenable && onSelect(node)}
            onKeyDown={(event) => {
              if (node.intervenable && (event.key === "Enter" || event.key === " ")) onSelect(node);
            }}
            role={node.intervenable ? "button" : undefined}
            tabIndex={node.intervenable ? 0 : undefined}
            aria-label={node.intervenable ? `定位设置项：${node.label_zh}` : undefined}
          >
            <rect width="152" height="60" rx="14" />
            <text className="node-label" x="76" y="24">{node.label_zh.length > 11 ? `${node.label_zh.slice(0, 10)}…` : node.label_zh}</text>
            <text className="node-value" x="76" y="44">
              {changed.has(node.id) ? `${delta >= 0 ? "+" : ""}${delta.toFixed(node.decimals)}` : formatValue(node, value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Explorer() {
  const [datasetId, setDatasetId] = useState(models.datasets[0].dataset_id);
  const [assignments, setAssignments] = useState<Assignments>(() => naturalAssignments(models.datasets[0].dataset_id));
  const [narrativeMode, setNarrativeMode] = useState<NarrativeMode>("professional");
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const dataset = getDataset(datasetId);
  const staticDataset = getStaticDataset(datasetId);
  const scenario = useMemo(() => getStaticScenario(staticDataset, assignments), [staticDataset, assignments]);
  const narrative = getStaticNarrative(scenario.key);
  const storyBible = getStoryBible(datasetId);
  const directlySet = new Set(scenario.interventions.map((item) => item.node_id));
  const activeInterventions = scenario.interventions.length;
  const changedRows = scenario.changed_node_ids.map((id) => dataset.nodes.find((node) => node.id === id)!);

  function changeDataset(nextId: string) {
    setDatasetId(nextId);
    setAssignments(naturalAssignments(nextId));
    setFocusedNodeId(null);
  }

  function selectValue(nodeId: string, value: number | null) {
    setFocusedNodeId(nodeId);
    setAssignments((current) => ({ ...current, [nodeId]: value }));
  }

  return (
    <main>
      <header className="site-header">
        <div>
          <h1>同时改变多个选择，看故事走向哪里</h1>
          <p className="lede">每个节点都可以保持自然变化，或选择五档固定值。组合不同选择，观察结果如何传播，并阅读同一故事世界里的不同走向。</p>
        </div>
      </header>

      <section className="dataset-switcher" aria-label="选择数据集">
        {models.datasets.map((item, index) => (
          <button key={item.dataset_id} className={item.dataset_id === datasetId ? "active" : ""} onClick={() => changeDataset(item.dataset_id)}>
            <span>0{index + 1}</span>{item.title_zh}
          </button>
        ))}
      </section>

      <section className="workspace-grid">
        <aside className="panel controls-panel">
          <div className="panel-heading">
            <span className="step-number">01</span>
            <div><h2>组合多个选择</h2><p>{activeInterventions ? `已主动设置 ${activeInterventions} 个节点` : "当前全部随祖先节点自然变化"}</p></div>
          </div>

          <div className="multi-control-list">
            {staticDataset.controls.map((control) => {
              const node = dataset.nodes.find((item) => item.id === control.node_id)!;
              const selected = assignments[control.node_id];
              return (
                <section id={`control-${node.id}`} key={node.id} className={`control-card ${focusedNodeId === node.id ? "focused" : ""}`}>
                  <div className="control-title">
                    <div><strong>{node.label_zh}</strong><small>{node.label_en}</small></div>
                    <span>{selected === null ? "自然变化" : formatValue(node, selected)}</span>
                  </div>
                  <div className="value-grid" role="group" aria-label={`${node.label_zh}取值`}>
                    <button className={selected === null ? "selected natural" : "natural"} onClick={() => selectValue(node.id, null)}>
                      <span>自然</span><small>不主动设置</small>
                    </button>
                    {control.values.map((value, index) => (
                      <button key={value} className={selected === value ? "selected" : ""} onClick={() => selectValue(node.id, value)}>
                        <span>档位 {index + 1}</span><small>{formatValue(node, value)}</small>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
          <button className="reset-action" onClick={() => setAssignments(naturalAssignments(datasetId))}>全部恢复自然变化</button>
          <p className="cost-note">“自然”不是固定在基线值：当祖先节点改变时，它会继续按图中的关系重新变化。</p>
        </aside>

        <section className="panel graph-panel">
          <div className="panel-heading graph-heading">
            <span className="step-number">02</span>
            <div><h2>{dataset.title_zh}</h2><p>{dataset.domain}</p></div>
            <div className="legend"><span className="up-dot" />增加 <span className="down-dot" />减少 <span className="selected-dot" />主动设置</div>
          </div>
          <Graph dataset={dataset} scenario={scenario} focusedNodeId={focusedNodeId} onSelect={(node) => setFocusedNodeId(node.id)} />
          <div className="scenario-key"><span>当前分支</span><code>{scenario.key}</code></div>
          <div className="bias-strip" aria-label="本图偏差考点">
            {(dataset.bias_points ?? []).map((point) => (
              <details key={point.name}>
                <summary>{point.name}<code>{point.structure}</code></summary>
                <p>{point.note}</p>
              </details>
            ))}
          </div>
          <div className="boundary"><strong>模型边界</strong>{dataset.boundary_zh}</div>
        </section>

        <aside className="panel narrative-panel">
          <div className="panel-heading">
            <span className="step-number">03</span>
            <div><h2>这一条故事线</h2><p>{storyBible.title} · {storyBible.protagonist}</p></div>
          </div>
          <div className="narrative-tabs" role="tablist" aria-label="叙事版本">
            <button role="tab" aria-selected={narrativeMode === "professional"} className={narrativeMode === "professional" ? "active" : ""} onClick={() => setNarrativeMode("professional")}>专业说明</button>
            <button role="tab" aria-selected={narrativeMode === "story"} className={narrativeMode === "story" ? "active" : ""} onClick={() => setNarrativeMode("story")}>生动故事</button>
          </div>
          <article className={`story-card ${narrativeMode}`}>
            <span className="ai-label">{narrativeMode === "professional" ? "专业说明" : storyBible.title}</span>
            <p>{narrativeMode === "professional" ? narrative.professional_explanation : narrative.children_story}</p>
          </article>
        </aside>
      </section>

      <section className="results-section">
        <div className="results-title"><span className="step-number">04</span><div><h2>情景前后对照</h2><p>同时考虑所有主动设置，并列出相对基线发生变化的节点。</p></div></div>
        <div className="results-table" role="table" aria-label="情景结果对照">
          <div className="result-row table-header" role="row"><span>变量</span><span>参考基线</span><span>当前情景</span><span>变化量</span></div>
          {changedRows.length === 0 && <p className="empty-result">当前是自然基线，没有节点偏离参考值。</p>}
          {changedRows.map((node) => {
            const before = node.reference_value;
            const after = scenario.values[node.id];
            const delta = after - before;
            return (
              <div className="result-row" role="row" key={node.id}>
                <strong>{node.label_zh}<small>{directlySet.has(node.id) ? "主动设置" : node.label_en}</small></strong>
                <span>{formatValue(node, before)}</span>
                <span>{formatValue(node, after)}</span>
                <span className={delta >= 0 ? "positive" : "negative"}>{delta >= 0 ? "+" : ""}{delta.toFixed(node.decimals)} {node.unit}</span>
              </div>
            );
          })}
        </div>
      </section>

      <footer>
        <p>CoNS Explorer · 偏差考点版 v4 · 静态多节点情景实验</p>
        <p className="mono">{models.model_version} · {scenario.key}</p>
      </footer>
    </main>
  );
}
