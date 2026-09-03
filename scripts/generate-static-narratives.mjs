import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const mode = args.has("--bibles-only") ? "bibles" : "narratives";
const dryRun = args.has("--dry-run");
const apiKey = process.env.DEEPSEEK_API_KEY;
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const narrativeVersion = process.env.NARRATIVE_VERSION ?? "v1";
if (!new Set(["v1", "v2"]).has(narrativeVersion)) throw new Error(`Unsupported NARRATIVE_VERSION: ${narrativeVersion}`);
const fullGraphNarratives = narrativeVersion === "v2";
const batchSize = Number(process.env.NARRATIVE_BATCH_SIZE ?? 1);
const maxApiAttempts = Number(process.env.DEEPSEEK_MAX_ATTEMPTS ?? 3);
const requestTimeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 180000);
const apiBase = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const biblesPath = resolve(process.env.STORY_BIBLES_PATH ?? "lib/story-bibles.generated.json");
const outputPath = resolve(process.env.NARRATIVES_OUTPUT_PATH ?? (fullGraphNarratives
  ? "lib/narratives-v2.generated.json"
  : "lib/narratives.generated.json"));
const scenarios = JSON.parse(readFileSync(new URL("../lib/scenarios.generated.json", import.meta.url), "utf8"));
const models = JSON.parse(readFileSync(new URL("../lib/models.generated.json", import.meta.url), "utf8"));
const promptVersion = fullGraphNarratives ? "full-causal-story-v2" : "parallel-short-story-v1";

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

function fullCausalStructure(datasetId) {
  const dataset = datasetById.get(datasetId);
  const nodes = nodeMapFor(datasetId);
  return {
    instruction: "下面是本数据集的完整有向关系清单。两个文本版本都必须逐条覆盖，不得只写本情景中发生数值变化的关系。",
    edge_count: dataset.edges.length,
    edges: dataset.edges.map((edge) => ({
      key: `${edge.source}->${edge.target}`,
      source_id: edge.source,
      source_label_zh: nodes.get(edge.source).label_zh,
      target_id: edge.target,
      target_label_zh: nodes.get(edge.target).label_zh,
      direction: edge.sign === "positive" ? "正向：源升高会推动目标升高，源降低会推动目标降低" : "负向：源升高会推动目标降低，源降低会推动目标升高",
    })),
  };
}

async function deepseekJson({ system, user, maxTokens = 4096, temperature = 0.65 }) {
  let lastError;
  for (let attempt = 1; attempt <= maxApiAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(`${apiBase}/chat/completions`, {
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
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      lastError = new Error(`DeepSeek network request failed (attempt=${attempt}): ${detail}`);
      if (attempt < maxApiAttempts) {
        console.warn(`${lastError.message}\nRetrying DeepSeek request (${attempt + 1}/${maxApiAttempts})...`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500 * attempt));
      }
      continue;
    }
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
          const recovered = recoverFirstJsonValue(content, error);
          if (recovered !== undefined) {
            console.warn(`Recovered valid JSON from a malformed DeepSeek suffix (chars=${content.length}).`);
            return recovered;
          }
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

function recoverFirstJsonValue(content, parseError) {
  const position = Number(parseError.message.match(/position (\d+)/)?.[1]);
  if (Number.isFinite(position)) {
    try {
      return JSON.parse(content.slice(0, position).trim());
    } catch {
      // Continue with structural scanning when the reported position is inside the object.
    }
  }

  const start = content.search(/[\[{]/);
  if (start < 0) return undefined;
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) continue;
      stack.pop();
      if (stack.length === 0) {
        try {
          return JSON.parse(content.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
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
  const causalStructure = fullCausalStructure(dataset.dataset_id);
  if (fullGraphNarratives) {
    return {
      system: [
        "你是中文因果解释编辑和短篇故事作者。",
        "为当前平行情景输出 professional_explanation 和 children_story 两个完整版本。",
        "professional_explanation 不能只讲主动调整和变化路径；必须覆盖 full_causal_structure 中的每一条有向关系，包括本情景中数值没有明显变化的关系。",
        "专业说明先交代当前主动设置与自然变化，再按完整结构说明所有直接关系、方向以及它们如何汇入当前结局。只能使用输入提供的关系与数值，不得补造额外因果边。",
        "专业说明可以使用输入名称中已有的常见缩写，例如 MAP、AKI、SOFA；不要求每次重复完整中文名称，但含义必须清楚。",
        "children_story 要保留旧版短篇故事的完整性，同时把专业说明表达的全部关系融入人物、环境、选择、连锁变化和结局。不能把专业说明生硬粘贴到故事末尾。",
        "故事必须沿用 story_bible 的人物、地点、关系和语气；每条结构关系都要在故事事件中找到可辨认的对应，并保持正向或负向方向不变。",
        "故事正文不要出现因果图、模型、变量、节点、路径、干预、指数、计算、数据集、教学、反事实等术语，也不要写虚构说明、免责声明或建议。",
        "不要杜撰输入以外的数值。可以把量翻译成自然的生活表达，但当前情景的重要数值和最终结局需要保留。",
        "coverage_professional 与 coverage_children_story 必须分别原样列出 full_causal_structure 的全部 edge key，用于程序检查，不可少项、增项或改写。",
        "当前一次只处理一个情景。严格输出 output_schema 所示的单层 JSON 对象，不要增加 scenarios 数组，不要在对象结尾追加任何括号或文字。",
        "遵守 branch_contexts 中的叙事变化指令，并避开 recent_stories 已使用的开场句式和事件推进方式。",
      ].join("\n"),
      user: {
        dataset_id: dataset.dataset_id,
        title_zh: dataset.title_zh,
        story_bible: bible,
        bias_points: sourceDataset.bias_points,
        full_causal_structure: causalStructure,
        branch_contexts: batch.map((scenario) => ({ key: scenario.key, ...branchContext(dataset, scenario) })),
        recent_stories: recentStories,
        baseline: summarizeScenario(dataset.dataset_id, dataset.scenarios.find((item) => item.is_observational_baseline)),
        scenarios: batch.map((scenario) => summarizeScenario(dataset.dataset_id, scenario)),
        output_schema: {
          dataset_id: "原样返回",
          key: batch[0].key,
          coverage_professional: causalStructure.edges.map((edge) => edge.key),
          coverage_children_story: causalStructure.edges.map((edge) => edge.key),
          professional_explanation: "450-750字中文：当前设置、完整直接关系清单、关系方向、当前结局；所有边必须出现",
          children_story: "700-1100字中文：完整短篇故事，在事件中自然体现全部关系及当前结局，不使用专业术语",
        },
      },
    };
  }
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

function normalizeNarrativeResponse(generated, datasetId) {
  if (!generated || typeof generated !== "object") return generated;
  const response = generated.data && typeof generated.data === "object" ? generated.data : generated;
  const normalized = fullGraphNarratives && response.key && !response.scenarios
    ? {
        dataset_id: response.dataset_id ?? generated.dataset_id ?? datasetId,
        scenarios: [{
          ...response,
          coverage: response.coverage ?? {
            professional: response.coverage_professional,
            children_story: response.coverage_children_story,
          },
        }],
      }
    : response.scenarios
      ? { ...response, dataset_id: response.dataset_id ?? generated.dataset_id ?? datasetId }
      : response;
  if (!Array.isArray(normalized.scenarios)) return normalized;
  return {
    ...normalized,
    scenarios: normalized.scenarios.map((item) => ({
      ...item,
      professional_explanation: item.professional_explanation
        ?? item.professional_explanation_zh
        ?? item.professional
        ?? item.explanation,
      children_story: item.children_story
        ?? item.children_story_zh
        ?? item.vivid_story
        ?? item.story,
      coverage: item.coverage ?? {
        professional: item.professional_covered_edges,
        children_story: item.story_covered_edges ?? item.children_story_covered_edges,
      },
    })),
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
    if (fullGraphNarratives) {
      if (item.professional_explanation.length < 250) throw new Error(`${datasetId}: ${item.key} professional_explanation is too short for full graph coverage`);
      if (item.children_story.length < 450) throw new Error(`${datasetId}: ${item.key} children_story is too short for full graph coverage`);
      const sourceDataset = datasetById.get(datasetId);
      const expectedEdges = sourceDataset.edges.map((edge) => `${edge.source}->${edge.target}`);
      for (const field of ["professional", "children_story"]) {
        const actualEdges = item.coverage?.[field];
        if (!Array.isArray(actualEdges)) throw new Error(`${datasetId}: ${item.key} missing coverage.${field}`);
        const actualSet = new Set(actualEdges);
        const missing = expectedEdges.filter((edge) => !actualSet.has(edge));
        const unexpected = actualEdges.filter((edge) => !expectedEdges.includes(edge));
        if (actualEdges.length !== expectedEdges.length || actualSet.size !== expectedEdges.length || missing.length || unexpected.length) {
          throw new Error(`${datasetId}: ${item.key} invalid coverage.${field}; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
        }
      }
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
    schema_version: fullGraphNarratives ? "static-narratives-full-graph-v2" : "static-narratives-v2",
    narrative_version: narrativeVersion,
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
      let generated;
      let validationError;
      let previousInvalidOutput;
      for (let attempt = 1; attempt <= maxApiAttempts; attempt += 1) {
        const retryUser = validationError
          ? {
              ...prompt.user,
              correction_required: `上一次输出未通过检查：${validationError.message}。请重新输出完整对象，尤其不要遗漏 output_schema 中的任何字段。`,
              previous_invalid_output: previousInvalidOutput,
            }
          : prompt.user;
        generated = normalizeNarrativeResponse(await deepseekJson({
          ...prompt,
          user: retryUser,
          maxTokens: fullGraphNarratives ? 6200 : 2400,
          temperature: 0.72,
        }), dataset.dataset_id);
        try {
          validateNarrativeBatch(dataset.dataset_id, batch.map((item) => item.key), generated);
          validationError = null;
          break;
        } catch (error) {
          validationError = error;
          previousInvalidOutput = generated;
          if (attempt < maxApiAttempts) console.warn(`${error.message}\nRetrying narrative for schema/coverage (${attempt + 1}/${maxApiAttempts})...`);
        }
      }
      if (validationError) throw validationError;
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
    narrative_version: narrativeVersion,
    full_graph_coverage: fullGraphNarratives,
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
