"use client";

import { useMemo, useState } from "react";
import {
  buildDeterministicNarrative,
  formatValue,
  getDataset,
  models,
  simulate,
  type Dataset,
  type ModelNode,
} from "../lib/causal-engine";

type NarrativeState = {
  text: string;
  cache: "idle" | "loading" | "hit" | "miss" | "error";
  provider?: string;
};

function preferredOption(node: ModelNode) {
  return node.discrete_options.find((option) => option.kind === "recommended")
    ?? node.discrete_options.find((option) => option.kind === "high")
    ?? node.discrete_options[0];
}

function Graph({ dataset, result, onSelect, selectedId }: {
  dataset: Dataset;
  result: ReturnType<typeof simulate>;
  onSelect: (node: ModelNode) => void;
  selectedId: string;
}) {
  const changed = new Set(result.changedNodeIds);
  const activeEdges = new Set(result.affectedEdgeKeys);
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
        const baseline = result.baseline[node.id];
        const value = result.values[node.id];
        const delta = value - baseline;
        const state = node.id === selectedId ? "selected" : changed.has(node.id) ? (delta >= 0 ? "up" : "down") : "stable";
        return (
          <g
            key={node.id}
            className={`graph-node ${state} ${node.intervenable ? "clickable" : ""} ${node.latent ? "latent" : ""}`}
            transform={`translate(${position[0] - 76}, ${position[1] - 30})`}
            onClick={() => node.intervenable && onSelect(node)}
            onKeyDown={(event) => {
              if (node.intervenable && (event.key === "Enter" || event.key === " ")) onSelect(node);
            }}
            role={node.intervenable ? "button" : undefined}
            tabIndex={node.intervenable ? 0 : undefined}
            aria-label={node.intervenable ? `选择干预节点：${node.label_zh}` : undefined}
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
  const dataset = getDataset(datasetId);
  const intervenableNodes = dataset.nodes.filter((node) => node.intervenable);
  const [nodeId, setNodeId] = useState(intervenableNodes[0].id);
  const selectedNode = dataset.nodes.find((node) => node.id === nodeId) ?? intervenableNodes[0];
  const [optionValue, setOptionValue] = useState(preferredOption(selectedNode).value);
  const result = useMemo(
    () => simulate(dataset, selectedNode.id, optionValue),
    [dataset, selectedNode, optionValue],
  );
  const [narrative, setNarrative] = useState<NarrativeState>({
    text: buildDeterministicNarrative(dataset, result),
    cache: "idle",
  });

  function changeDataset(nextId: string) {
    const nextDataset = getDataset(nextId);
    const nextNode = nextDataset.nodes.find((node) => node.intervenable)!;
    const nextValue = preferredOption(nextNode).value;
    const nextResult = simulate(nextDataset, nextNode.id, nextValue);
    setDatasetId(nextId);
    setNodeId(nextNode.id);
    setOptionValue(nextValue);
    setNarrative({ text: buildDeterministicNarrative(nextDataset, nextResult), cache: "idle" });
  }

  function selectNode(node: ModelNode) {
    const nextValue = preferredOption(node).value;
    const nextResult = simulate(dataset, node.id, nextValue);
    setNodeId(node.id);
    setOptionValue(nextValue);
    setNarrative({ text: buildDeterministicNarrative(dataset, nextResult), cache: "idle" });
  }

  function selectValue(value: number) {
    const nextResult = simulate(dataset, selectedNode.id, value);
    setOptionValue(value);
    setNarrative({ text: buildDeterministicNarrative(dataset, nextResult), cache: "idle" });
  }

  async function requestNarrative() {
    setNarrative((current) => ({ ...current, cache: "loading" }));
    try {
      const response = await fetch("/api/narrative", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          datasetId: dataset.dataset_id,
          interventionNode: selectedNode.id,
          interventionValue: optionValue,
        }),
      });
      const payload = await response.json() as { narrative?: string; cache?: "hit" | "miss"; provider?: string; error?: string };
      if (!response.ok || !payload.narrative) throw new Error(payload.error ?? "叙事生成失败");
      setNarrative({ text: payload.narrative, cache: payload.cache ?? "miss", provider: payload.provider });
    } catch (error) {
      setNarrative({
        text: `${buildDeterministicNarrative(dataset, result)}（当前为本地模板；部署后可连接AI与D1缓存。）`,
        cache: "error",
      });
    }
  }

  const changedRows = result.changedNodeIds.map((id) => dataset.nodes.find((node) => node.id === id)!);

  return (
    <main>
      <header className="site-header">
        <div>
          <p className="eyebrow">CAUSAL NARRATIVE LAB · RESEARCH DEMO</p>
          <h1>看见一次干预，如何沿因果链条传播</h1>
          <p className="lede">选择一个离散情景，观察模型重新计算下游结果，再用受约束的叙事解释这条变化路径。</p>
        </div>
        <div className="model-stamp">
          <span>模型来源</span>
          <strong>偏差考点版 v2</strong>
          <small>{models.totals.datasets} 个数据集 · {models.totals.nodes} 节点 · {models.totals.edges} 条边</small>
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
            <div><h2>设置干预</h2><p>图中带圆点的节点可以点击。</p></div>
          </div>
          <label className="field-label" htmlFor="node-select">干预节点</label>
          <select id="node-select" value={selectedNode.id} onChange={(event) => selectNode(dataset.nodes.find((node) => node.id === event.target.value)!)}>
            {intervenableNodes.map((node) => <option key={node.id} value={node.id}>{node.label_zh}</option>)}
          </select>

          <div className="baseline-card">
            <span>当前基线</span>
            <strong>{formatValue(selectedNode, selectedNode.reference_value)}</strong>
          </div>

          <span className="field-label">离散情景值</span>
          <div className="option-list">
            {selectedNode.discrete_options.map((option) => (
              <button key={option.value} className={option.value === optionValue ? "selected" : ""} onClick={() => selectValue(option.value)}>
                <span>{option.label}</span>
                <strong>{formatValue(selectedNode, option.value)}</strong>
              </button>
            ))}
          </div>
          <p className="cost-note">只允许这些预设值，因此每一种结果都拥有稳定缓存键，最多调用AI一次。</p>
        </aside>

        <section className="panel graph-panel">
          <div className="panel-heading graph-heading">
            <span className="step-number">02</span>
            <div><h2>{dataset.title_zh}</h2><p>{dataset.domain}</p></div>
            <div className="legend"><span className="up-dot" />增加 <span className="down-dot" />减少 <span className="selected-dot" />直接干预</div>
          </div>
          <Graph dataset={dataset} result={result} selectedId={selectedNode.id} onSelect={selectNode} />
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
            <div><h2>因果叙事</h2><p>AI只解释模型已计算的节点与路径。</p></div>
          </div>
          <div className="cache-status">
            <span className={`status-light ${narrative.cache}`} />
            {narrative.cache === "hit" && "数据库命中 · 未调用AI"}
            {narrative.cache === "miss" && `首次生成 · 已写入数据库${narrative.provider ? ` · ${narrative.provider}` : ""}`}
            {narrative.cache === "loading" && "正在查询缓存…"}
            {narrative.cache === "error" && "本地模板预览"}
            {narrative.cache === "idle" && "尚未请求 · 当前为确定性预览"}
          </div>
          <article className="story-card">
            <span className="ai-label">AI生成内容 / 模型模拟</span>
            <p>{narrative.text}</p>
          </article>
          <button className="primary-action" onClick={requestNarrative} disabled={narrative.cache === "loading"}>
            {narrative.cache === "loading" ? "查询中…" : "生成或读取叙事"}
          </button>
          <p className="privacy-note">相同模型版本、节点和值会返回同一条已保存叙事。不会在拖动或切换时自动消耗API。</p>
        </aside>
      </section>

      <section className="results-section">
        <div className="results-title"><span className="step-number">04</span><div><h2>干预前后对照</h2><p>只列出本次发生变化的节点。</p></div></div>
        <div className="results-table" role="table" aria-label="干预结果对照">
          <div className="result-row table-header" role="row"><span>变量</span><span>干预前</span><span>干预后</span><span>变化量</span></div>
          {changedRows.map((node) => {
            const delta = result.values[node.id] - result.baseline[node.id];
            return (
              <div className="result-row" role="row" key={node.id}>
                <strong>{node.label_zh}<small>{node.label_en}</small></strong>
                <span>{formatValue(node, result.baseline[node.id])}</span>
                <span>{formatValue(node, result.values[node.id])}</span>
                <span className={delta >= 0 ? "positive" : "negative"}>{delta >= 0 ? "+" : ""}{delta.toFixed(node.decimals)} {node.unit}</span>
              </div>
            );
          })}
        </div>
      </section>

      <footer>
        <p>研究原型 · 所有结果均来自结构因果模型的确定性计算，不代表现实预测、诊断或决策建议。</p>
        <p className="mono">{models.model_version}</p>
      </footer>
    </main>
  );
}
