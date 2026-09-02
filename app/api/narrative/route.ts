import { env } from "cloudflare:workers";
import {
  buildDeterministicNarrative,
  formatValue,
  getDataset,
  models,
  simulate,
} from "../../../lib/causal-engine";

export const runtime = "edge";

const PROMPT_VERSION = "causal-story-v1";

type RuntimeEnv = {
  DB?: D1Database;
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
};

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function ensureSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS narrative_cache (
      cache_key TEXT PRIMARY KEY NOT NULL,
      model_version TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      intervention_node TEXT NOT NULL,
      intervention_value REAL NOT NULL,
      prompt_version TEXT NOT NULL,
      provider_model TEXT NOT NULL,
      narrative_text TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS narrative_lookup_idx ON narrative_cache(dataset_id, intervention_node, intervention_value)"),
  ]);
}

async function callAi(runtimeEnv: RuntimeEnv, prompt: string) {
  if (!runtimeEnv.AI_API_KEY || !runtimeEnv.AI_BASE_URL || !runtimeEnv.AI_MODEL) return null;
  const endpoint = `${runtimeEnv.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runtimeEnv.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: runtimeEnv.AI_MODEL,
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: "你是因果模型解释器。只能使用输入中出现的变量、数值、单位和有向边；不得补充人物背景、现实机制或模型外原因。明确称其为模拟结果，不作预测、诊断或建议。使用自然、清楚、克制的中文，150至220字。",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) throw new Error(`AI provider returned ${response.status}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() || null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      datasetId?: string;
      interventionNode?: string;
      interventionValue?: number;
    };
    if (!body.datasetId || !body.interventionNode || typeof body.interventionValue !== "number") {
      return Response.json({ error: "请求缺少数据集、节点或干预值" }, { status: 400 });
    }

    const dataset = getDataset(body.datasetId);
    const result = simulate(dataset, body.interventionNode, body.interventionValue);
    const target = dataset.nodes.find((node) => node.id === body.interventionNode)!;
    const rawCacheKey = [models.model_version, PROMPT_VERSION, body.datasetId, body.interventionNode, result.interventionValue].join("|");
    const cacheKey = await digest(rawCacheKey);
    const runtimeEnv = env as unknown as RuntimeEnv;
    const db = runtimeEnv.DB;

    if (db) {
      await ensureSchema(db);
      const cached = await db.prepare(
        "SELECT narrative_text, provider_model FROM narrative_cache WHERE cache_key = ?",
      ).bind(cacheKey).first<{ narrative_text: string; provider_model: string }>();
      if (cached) {
        await db.prepare(
          "UPDATE narrative_cache SET hit_count = hit_count + 1, last_accessed_at = ? WHERE cache_key = ?",
        ).bind(new Date().toISOString(), cacheKey).run();
        return Response.json({
          narrative: cached.narrative_text,
          cache: "hit",
          provider: cached.provider_model,
          cacheKey: cacheKey.slice(0, 12),
        });
      }
    }

    const nodeMap = new Map(dataset.nodes.map((node) => [node.id, node]));
    const changes = result.changedNodeIds.map((id) => {
      const node = nodeMap.get(id)!;
      return {
        variable: node.label_zh,
        before: formatValue(node, result.baseline[id]),
        after: formatValue(node, result.values[id]),
        direction: result.values[id] >= result.baseline[id] ? "增加" : "减少",
      };
    });
    const activeEdges = dataset.edges
      .filter((edge) => result.affectedEdgeKeys.includes(`${edge.source}->${edge.target}`))
      .map((edge) => `${nodeMap.get(edge.source)?.label_zh} → ${nodeMap.get(edge.target)?.label_zh}`);
    const prompt = JSON.stringify({
      dataset: dataset.title_zh,
      intervention: `${target.label_zh} = ${formatValue(target, result.interventionValue)}`,
      changes,
      active_causal_edges: activeEdges,
      boundary: dataset.boundary_zh,
    });

    let provider = "deterministic-demo";
    let narrative = await callAi(runtimeEnv, prompt);
    if (narrative) provider = runtimeEnv.AI_MODEL ?? "configured-ai";
    else narrative = buildDeterministicNarrative(dataset, result);

    if (db) {
      const now = new Date().toISOString();
      await db.prepare(`INSERT INTO narrative_cache (
        cache_key, model_version, dataset_id, intervention_node, intervention_value,
        prompt_version, provider_model, narrative_text, result_json, created_at,
        last_accessed_at, hit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
        .bind(
          cacheKey,
          models.model_version,
          dataset.dataset_id,
          result.interventionNode,
          result.interventionValue,
          PROMPT_VERSION,
          provider,
          narrative,
          JSON.stringify(result),
          now,
          now,
        ).run();
    }

    return Response.json({
      narrative,
      cache: "miss",
      provider,
      cacheKey: cacheKey.slice(0, 12),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return Response.json({ error: message }, { status: 400 });
  }
}
