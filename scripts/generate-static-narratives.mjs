import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const mode = args.has("--bibles-only") ? "bibles" : "narratives";
const dryRun = args.has("--dry-run");
const apiKey = process.env.DEEPSEEK_API_KEY;
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const batchSize = Number(process.env.NARRATIVE_BATCH_SIZE ?? 1);
const maxApiAttempts = Number(process.env.DEEPSEEK_MAX_ATTEMPTS ?? 3);
const apiBase = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const biblesPath = resolve(process.env.STORY_BIBLES_PATH ?? "lib/story-bibles.generated.json");
const outputPath = resolve(process.env.NARRATIVES_OUTPUT_PATH ?? "lib/narratives.generated.json");
const scenarios = JSON.parse(readFileSync(new URL("../lib/scenarios.generated.json", import.meta.url), "utf8"));
const models = JSON.parse(readFileSync(new URL("../lib/models.generated.json", import.meta.url), "utf8"));
const promptVersion = "parallel-short-story-v1";

const worldSeeds = {
  icu_septic_shock: {
    title_hint: "凌晨三点的监护室",
    people_hint: "一名年长病人、夜班医生、护士长、在门外等待的家属",
    place_hint: "城市医院的ICU，灯光很低，值班白板上写着整夜更新的数字",
  },
  rice_nitrogen: {
    title_hint: "河湾村的青秧田",
    people_hint: "种稻的许岚、会看天色的外婆、隔壁田的老周、农技站的小陈",
    place_hint: "河湾村，田埂、灌渠、晒谷场和抽穗前的闷热午后",
  },
  monetary_policy: {
    title_hint: "周三上午的城市简报",
    people_hint: "研究员唐晟、开小厂的姐姐、准备买房的朋友、会议室里的同事",
    place_hint: "一座沿江城市，研究室、银行大厅、工厂办公室和新闻发布会屏幕",
  },
  tutoring_education: {
    title_hint: "梧桐街的三张便签",
    people_hint: "初三学生林晓、图书馆工作的妈妈、修钟表的爸爸、同桌阿澄",
    place_hint: "梧桐树很多的小城，家里的饭桌、书桌、辅导班教室和期中考试前的周末",
  },
  supply_chain_bullwhip: {
    title_hint: "周一早晨的补货会",
    people_hint: "计划员孙澈、门店店长、仓库主管、供应商代表",
    place_hint: "连锁零售公司的办公室、郊区仓库和几家临街门店",
  },
};

const datasetById = new Map(models.datasets.map((dataset) => [dataset.dataset_id, dataset]));

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function formatNumber(value, decimals) {
  return Number(value).toFixed(decimals).replace(/\.?0+$/, "");
}

function nodeMapFor(datasetId) {
  return new Map(datasetById.get(datasetId).nodes.map((node) => [node.id, node]));
}

function formatValue(node, value) {
  if (value === null || value === undefined) return "自然生成";
  const unit = node.unit === "—" ? "" : node.unit;
  return `${formatNumber(value, node.decimals)}${unit}`;
}

function summarizeScenario(datasetId, scenario) {
  const nodes = nodeMapFor(datasetId);
  const baseline = scenarios.datasets.find((dataset) => dataset.dataset_id === datasetId)
    .scenarios.find((item) => item.is_observational_baseline);
  return {
    key: scenario.key,
    is_observational_baseline: scenario.is_observational_baseline,
    interventions: scenario.interventions.map((item) => {
      const node = nodes.get(item.node_id);
      return {
        node_id: item.node_id,
        label_zh: item.label_zh,
        value: item.value,
        formatted: formatValue(node, item.value),
      };
    }),
    changed_nodes: scenario.changed_node_ids.map((nodeId) => {
      const node = nodes.get(nodeId);
      const before = baseline.values[nodeId];
      const after = scenario.values[nodeId];
      return {
        node_id: nodeId,
        label_zh: node.label_zh,
        before: formatValue(node, before),
        after: formatValue(node, after),
        direction: after > before ? "上升" : after < before ? "下降" : "不变",
      };
    }),
    final_values: Object.fromEntries(
      Object.entries(scenario.values).map(([nodeId, value]) => [nodeId, formatValue(nodes.get(nodeId), value)]),
    ),
    affected_edges: scenario.affected_edge_keys.map((key) => {
      const [source, target] = key.split("->");
      return {
        key,
        label_zh: `${nodes.get(source).label_zh} -> ${nodes.get(target).label_zh}`,
      };
    }),
  };
}

async function deepseekJson({ system, user, maxTokens = 4096, temperature = 0.65 }) {
  let lastError;
  for (let attempt = 1; attempt <= maxApiAttempts; attempt += 1) {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        thinking: { type: "disabled" },
        temperature: attempt === 1 ? temperature : Math.min(temperature, 0.5),
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `${system}\n\n输出必须是完整、合法、紧凑的 JSON，不要输出 Markdown；字符串中不要使用未转义的换行。`,
          },
          { role: "user", content: JSON.stringify(user) },
        ],
        stream: false,
      }),
    });
    if (!response.ok) {
      lastError = new Error(`DeepSeek returned ${response.status}: ${await response.text()}`);
    } else {
      const payload = await response.json();
      const choice = payload.choices?.[0];
      const content = choice?.message?.content;
      if (!content) {
        lastError = new Error(`DeepSeek returned empty content (finish_reason=${choice?.finish_reason ?? "unknown"})`);
      } else {
        try {
          return JSON.parse(content);
        } catch (error) {
          const tail = content.slice(-160).replaceAll("\n", "\\n");
          lastError = new Error(
            `DeepSeek returned invalid JSON (attempt=${attempt}, finish_reason=${choice?.finish_reason ?? "unknown"}, chars=${content.length}, tail=${JSON.stringify(tail)}): ${error.message}`,
          );
        }
      }
    }
    if (attempt < maxApiAttempts) {
      console.warn(`${lastError.message}\nRetrying DeepSeek request (${attempt + 1}/${maxApiAttempts})...`);
    }
  }
  throw lastError;
}

function biblePrompt(dataset) {
  return {
    system: [
      "你是中文短篇故事设定作者。",
      "为一个数据集创建固定故事世界，之后所有平行情景都必须沿用这个世界。",
      "不要写因果图、模型、教学实验、虚构说明、免责声明。",
      "故事世界要能容纳不同选择带来的分支，但不要预先写任何具体分支结果。",
    ].join("\n"),
    user: {
      dataset_id: dataset.dataset_id,
      title_zh: dataset.title_zh,
      domain: dataset.domain,
      seed: worldSeeds[dataset.dataset_id],
      output_schema: {
        dataset_id: "原样返回",
        title: "故事标题，短",
        protagonist: "主角姓名与一句背景",
        supporting_cast: ["固定配角，2-4人"],
        setting: "固定地点与生活背景，80-140字",
        recurring_details: ["会在多个分支重复出现的物件或场景，3-5项"],
        tone: "叙事语气，接近语文课文/短篇故事",
        rules: ["后续分支必须遵守的连续性规则，3-5条"],
      },
    },
  };
}

function normalizeBibleResponse(datasetId, response) {
  const candidates = [
    response?.story_bible,
    response?.bible,
    response?.data,
    response?.data?.story_bible,
    response,
  ];
  const bible = candidates.find((candidate) => (
    candidate
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && ("title" in candidate || "protagonist" in candidate || "setting" in candidate)
  ));
  if (!bible) throw new Error(`${datasetId}: story bible response is not an object`);
  return {
    ...bible,
    dataset_id: bible.dataset_id ?? datasetId,
  };
}

function validateBible(datasetId, bible) {
  if (bible?.dataset_id !== datasetId) throw new Error(`${datasetId}: story bible returned wrong dataset_id`);
  const minimumLengths = { title: 2, protagonist: 4, setting: 20, tone: 2 };
  for (const [field, minimumLength] of Object.entries(minimumLengths)) {
    if (typeof bible[field] !== "string") throw new Error(`${datasetId}: story bible ${field} must be a string`);
    if (bible[field].trim().length < minimumLength) {
      throw new Error(`${datasetId}: story bible ${field} is too short (${bible[field].trim().length} < ${minimumLength}): ${JSON.stringify(bible[field])}`);
    }
  }
  for (const field of ["supporting_cast", "recurring_details", "rules"]) {
    if (!Array.isArray(bible[field]) || bible[field].length < 2) throw new Error(`${datasetId}: story bible missing ${field}`);
  }
}

function storyBiblesOutput(datasets) {
  return {
    schema_version: "story-bibles-v1",
    model_version: scenarios.model_version,
    prompt_version: promptVersion,
    generator: { provider: "deepseek", model, generated_at: new Date().toISOString() },
    datasets,
  };
}

async function generateBibles() {
  const datasets = existsSync(biblesPath)
    ? JSON.parse(readFileSync(biblesPath, "utf8")).datasets ?? []
    : [];
  const existingById = new Map(datasets.map((bible) => [bible.dataset_id, bible]));
  for (const dataset of models.datasets) {
    const existing = existingById.get(dataset.dataset_id);
    if (existing) {
      validateBible(dataset.dataset_id, existing);
      console.log(`Reusing story bible: ${dataset.title_zh}`);
      continue;
    }
    console.log(`Generating story bible: ${dataset.title_zh}`);
    const prompt = biblePrompt(dataset);
    const response = await deepseekJson({ ...prompt, maxTokens: 1800, temperature: 0.8 });
    const bible = normalizeBibleResponse(dataset.dataset_id, response);
    validateBible(dataset.dataset_id, bible);
    datasets.push(bible);
    writeFileSync(biblesPath, `${JSON.stringify(storyBiblesOutput(datasets), null, 2)}\n`);
  }
  return storyBiblesOutput(datasets);
}

const storyVariationDirectives = [
  "从一个具体动作开场，让选择立即推动事件，不要先介绍背景。",
  "用一小段人物对话开场，冲突通过对话自然显现。",
  "让固定故事世界中的一个常见物件贯穿开头、转折和结尾。",
  "从当天的光线、天气或声音切入，但不要大段写景。",
  "把配角的观察作为推动情节的关键，主角仍然是故事中心。",
  "采用安静克制的语文课文式叙述，用细节体现结局变化。",
  "设置一个需要当场取舍的小冲突，让本情景的数值变化决定后续。",
  "以一张便条、一次记录或一件被留下的东西收束故事。",
];

function branchContext(dataset, scenario) {
  const nodes = nodeMapFor(dataset.dataset_id);
  const scenarioIndex = dataset.scenarios.findIndex((item) => item.key === scenario.key);
  return {
    branch_number: scenarioIndex + 1,
    total_branches: dataset.scenarios.length,
    intervention_space: dataset.controls.map((control) => ({
      node_id: control.node_id,
      label_zh: control.label_zh,
      choices: ["不主动调整，随前因自然变化", ...control.values.map((value) => formatValue(nodes.get(control.node_id), value))],
    })),
    current_branch_has_interventions: scenario.interventions.length,
    variation_directive: storyVariationDirectives[scenarioIndex % storyVariationDirectives.length],
  };
}

function narrativePrompt(dataset, bible, batch, recentStories = []) {
  const sourceDataset = datasetById.get(dataset.dataset_id);
  return {
    system: [
      "你是中文因果解释编辑和短篇故事作者。",
      "为每个给定情景输出两个版本：professional_explanation 和 children_story。",
      "professional_explanation 只解释本情景中哪些量被调整、哪些量随路径变化、最终结果如何。不要写免责声明。",
      "children_story 必须是完整短篇故事，有主角、背景、选择、经过和结尾。沿用 story_bible，不能改人物、地点、关系和语气。",
      "children_story 不要出现因果图、模型、变量、节点、路径、干预、指数、计算、数据集、教学、反事实等专业词。",
      "不要杜撰输入以外的数值。可以把专业量翻译成生活化表达，但关键结局数值要保留。",
      "这是许多离散选择组成的平行分支之一。必须让当前选择真正改变人物的行动、阻碍、转折或结局，不能只替换数字。",
      "遵守 branch_context 的变化指令，并避开 recent_stories 中已经使用过的开场句式和事件推进方式。",
    ].join("\n"),
    user: {
      dataset_id: dataset.dataset_id,
      title_zh: dataset.title_zh,
      story_bible: bible,
      bias_points: sourceDataset.bias_points,
      branch_contexts: batch.map((scenario) => ({ key: scenario.key, ...branchContext(dataset, scenario) })),
      recent_stories: recentStories,
      baseline: summarizeScenario(dataset.dataset_id, dataset.scenarios.find((item) => item.is_observational_baseline)),
      scenarios: batch.map((scenario) => summarizeScenario(dataset.dataset_id, scenario)),
      output_schema: {
        dataset_id: "原样返回",
        scenarios: [
          {
            key: "原样返回",
            professional_explanation: "120-220字中文，说明调整、主要变化、结局",
            children_story: "260-420字中文，完整故事，沿用固定世界，不使用专业词",
          },
        ],
      },
    },
  };
}

function validateNarrativeBatch(datasetId, expectedKeys, generated) {
  if (generated?.dataset_id !== datasetId) throw new Error(`${datasetId}: narrative batch returned wrong dataset_id`);
  if (!Array.isArray(generated.scenarios)) throw new Error(`${datasetId}: narrative batch missing scenarios`);
  const remaining = new Set(expectedKeys);
  for (const item of generated.scenarios) {
    if (!remaining.delete(item.key)) throw new Error(`${datasetId}: unexpected or duplicate narrative key ${item.key}`);
    for (const field of ["professional_explanation", "children_story"]) {
      if (typeof item[field] !== "string" || item[field].length < 40) throw new Error(`${datasetId}: ${item.key} missing ${field}`);
    }
  }
  if (remaining.size) throw new Error(`${datasetId}: missing narrative keys ${[...remaining].join(", ")}`);
}

function loadBibles() {
  if (!existsSync(biblesPath)) throw new Error(`Missing ${biblesPath}. Run npm run narratives:bibles first.`);
  const bibles = JSON.parse(readFileSync(biblesPath, "utf8"));
  return new Map(bibles.datasets.map((bible) => [bible.dataset_id, bible]));
}

function narrativeOutput(datasets, callCount) {
  const generatedScenarioCount = datasets.reduce((sum, dataset) => sum + dataset.scenarios.length, 0);
  return {
    schema_version: "static-narratives-v2",
    model_version: scenarios.model_version,
    prompt_version: promptVersion,
    generator: { provider: "deepseek", model, batch_size: batchSize, calls: callCount, generated_at: new Date().toISOString() },
    totals: { ...scenarios.totals, generated_scenarios: generatedScenarioCount },
    datasets,
  };
}

async function generateNarratives() {
  const bibles = loadBibles();
  const previous = existsSync(outputPath)
    ? JSON.parse(readFileSync(outputPath, "utf8"))
    : null;
  if (previous && (previous.model_version !== scenarios.model_version || previous.prompt_version !== promptVersion)) {
    throw new Error(`Existing ${outputPath} uses a different model or prompt version; move it aside before regenerating.`);
  }
  const completedByDataset = new Map((previous?.datasets ?? []).map((dataset) => [dataset.dataset_id, dataset]));
  const datasets = [];
  let callCount = previous?.generator?.calls ?? 0;
  for (const dataset of scenarios.datasets) {
    const bible = bibles.get(dataset.dataset_id);
    if (!bible) throw new Error(`Missing story bible for ${dataset.dataset_id}`);
    const expectedKeys = new Set(dataset.scenarios.map((scenario) => scenario.key));
    const generatedByKey = new Map(
      (completedByDataset.get(dataset.dataset_id)?.scenarios ?? [])
        .filter((scenario) => expectedKeys.has(scenario.key))
        .map((scenario) => [scenario.key, scenario]),
    );
    const pending = dataset.scenarios.filter((scenario) => !generatedByKey.has(scenario.key));
    if (generatedByKey.size) console.log(`Resuming ${dataset.title_zh}: ${generatedByKey.size}/${dataset.scenarios.length} already generated`);
    for (const batch of chunks(pending, batchSize)) {
      callCount += 1;
      console.log(`Generating narratives: ${dataset.title_zh}, ${generatedByKey.size}/${dataset.scenarios.length} complete`);
      const recentStories = [...generatedByKey.values()].slice(-3).map((item) => ({
        key: item.key,
        opening_excerpt: item.children_story.slice(0, 140),
      }));
      const prompt = narrativePrompt(dataset, bible, batch, recentStories);
      const generated = await deepseekJson({ ...prompt, maxTokens: 2400, temperature: 0.72 });
      validateNarrativeBatch(dataset.dataset_id, batch.map((item) => item.key), generated);
      for (const item of generated.scenarios) generatedByKey.set(item.key, item);
      const checkpointDataset = {
        dataset_id: dataset.dataset_id,
        title_zh: dataset.title_zh,
        story_bible: bible,
        scenarios: dataset.scenarios.filter((scenario) => generatedByKey.has(scenario.key)).map((scenario) => generatedByKey.get(scenario.key)),
      };
      completedByDataset.set(dataset.dataset_id, checkpointDataset);
      const checkpointDatasets = scenarios.datasets
        .filter((item) => completedByDataset.has(item.dataset_id))
        .map((item) => completedByDataset.get(item.dataset_id));
      writeFileSync(outputPath, `${JSON.stringify(narrativeOutput(checkpointDatasets, callCount), null, 2)}\n`);
    }
    const completedDataset = {
      dataset_id: dataset.dataset_id,
      title_zh: dataset.title_zh,
      story_bible: bible,
      scenarios: dataset.scenarios.map((scenario) => generatedByKey.get(scenario.key)),
    };
    completedByDataset.set(dataset.dataset_id, completedDataset);
    datasets.push(completedDataset);
  }
  const output = narrativeOutput(datasets, callCount);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (dryRun) {
  const plan = {
    model,
    prompt_version: promptVersion,
    mode,
    story_bible_calls: mode === "bibles" ? scenarios.datasets.length : 0,
    narrative_batch_size: batchSize,
    narrative_calls: mode === "narratives"
      ? scenarios.datasets.reduce((sum, dataset) => sum + chunks(dataset.scenarios, batchSize).length, 0)
      : 0,
    datasets: scenarios.datasets.map((dataset) => ({
      dataset_id: dataset.dataset_id,
      title_zh: dataset.title_zh,
      scenarios: dataset.scenario_count,
      narrative_batches: chunks(dataset.scenarios, batchSize).length,
    })),
    outputs: { biblesPath, outputPath },
  };
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required. Export it before running this script.");
if (mode === "bibles") {
  const output = await generateBibles();
  console.log(`Wrote ${biblesPath}: ${output.datasets.length} story bibles.`);
} else {
  const output = await generateNarratives();
  console.log(`Wrote ${outputPath}: ${output.totals.scenarios} scenario narratives.`);
}
