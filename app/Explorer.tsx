"use client";

import { useMemo, useState } from "react";
import { formatValue, getDataset, models, type Dataset, type ModelNode } from "../lib/causal-engine";
import {
  getStaticDataset,
  getStaticNarrative,
  getStaticScenario,
  getStoryBible,
  staticTotals,
  type StaticScenario,
} from "../lib/static-experience";

type Assignments = Record<string, number | null>;
type NarrativeMode = "professional" | "story";

function naturalAssignments(datasetId: string): Assignments {
  const dataset = getStaticDataset(datasetId);
  return Object.fromEntries(dataset.controls.map((control) => [control.node_id, null]));
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

  return (
    <svg className="causal-graph" viewBox="0 0 1000 620" role="img" aria-label={`${dataset.title_zh}因果图`}>
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" />
        </marker>
      </defs>
      {dataset.edges.map((edge) => {
        const source = positions[edge.source];
        const target = positions[edge.target];
        if (!source || !target) return null;
        const active = activeEdges.has(`${edge.source}->${edge.target}`);
        const midY = source[1] + (target[1] - source[1]) * 0.5;
        return (
          <path
            key={`${edge.source}-${edge.target}`}
            className={`graph-edge ${active ? "active" : ""}`}
            d={`M ${source[0]} ${source[1] + 31} C ${source[0]} ${midY}, ${target[0]} ${midY}, ${target[0]} ${target[1] - 31}`}
            markerEnd="url(#arrow)"
          />
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
          <p className="eyebrow">CAUSAL NARRATIVE LAB · STATIC EDITION</p>
          <h1>同时改变多个选择，看故事走向哪里</h1>
          <p className="lede">每个节点都可以保持自然变化，或选择五档固定值。所有组合、计算结果和双版本叙事均已离线生成，页面切换时直接读取。</p>
        </div>
        <div className="model-stamp">
          <span>静态情景库</span>
          <strong>{staticTotals.scenarios} 个分支</strong>
          <small>{models.totals.datasets} 个数据集 · 无后端请求 · 无数据库</small>
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
          <div className="static-status"><span className="status-light hit" />离线内容已就绪 · 切换即时显示</div>
          <div className="narrative-tabs" role="tablist" aria-label="叙事版本">
            <button role="tab" aria-selected={narrativeMode === "professional"} className={narrativeMode === "professional" ? "active" : ""} onClick={() => setNarrativeMode("professional")}>专业说明</button>
            <button role="tab" aria-selected={narrativeMode === "story"} className={narrativeMode === "story" ? "active" : ""} onClick={() => setNarrativeMode("story")}>生动故事</button>
          </div>
          <article className={`story-card ${narrativeMode}`}>
            <span className="ai-label">{narrativeMode === "professional" ? "专业说明" : storyBible.title}</span>
            <p>{narrativeMode === "professional" ? narrative.professional_explanation : narrative.children_story}</p>
          </article>
          <p className="privacy-note">本页不会发送任何网络生成请求；当前内容来自预先完成的 DeepSeek 离线批处理。</p>
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
        <p>CoNS Explorer · 偏差考点版 v2 · 静态多节点情景实验</p>
        <p className="mono">{models.model_version} · {scenario.key}</p>
      </footer>
    </main>
  );
}
