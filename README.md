# CoNS Explorer Demo

一个面向因果理解研究的 Cloudflare 原型：用户选择离散干预值，结构因果模型确定性地计算下游结果，后端只在缓存缺失时调用一次 AI，并将叙事写入 D1。

## 数据来源

模型从 `因果图候选库_v2_偏差考点版.md` 转换而来，当前生成包包含：

- 5 个数据集
- 44 个节点
- 65 条结构方程依赖边
- ICU、农业、货币政策、教育与供应链 5 个教学场景
- 每张图 3 个偏差考点，以及供应链图中的潜在变量

原文的边数小计为 62，但图 1、3、4 各少计了一条方程依赖。模型以结构方程为准，保留全部 65 条边。

重新生成模型：

```bash
node scripts/build-bias-models.mjs /absolute/path/to/因果图候选库_v2_偏差考点版.md lib/models.generated.json
```

转换脚本会校验数据集、节点、边、拓扑顺序和边端点，并将源文件 SHA-256 写入模型版本。

## 成本控制

1. 每个可干预节点只有 3–4 个预设离散值，后端拒绝任意连续值。
2. 缓存键包含模型版本、提示词版本、数据集、节点和干预值。
3. 请求先查询 D1；命中时直接返回，不调用 AI。
4. 缺失时调用一次兼容 OpenAI Chat Completions 的接口，并把叙事与完整计算结果写入 `narrative_cache`。
5. 未配置 AI 时使用确定性模板，便于本地完整演示缓存流程。

## 本地运行

```bash
npm install
npm run dev
```

如需测试真实 AI，将 `.env.example` 复制为 `.env` 并填写：

```text
AI_API_KEY=
AI_BASE_URL=
AI_MODEL=
```

不要提交包含真实密钥的 `.env`。

## 验证

```bash
npm run build
node scripts/validate-bias-models.mjs
node --test tests/rendered-html.test.mjs
```

## Cloudflare

- `.openai/hosting.json` 声明 D1 绑定 `DB`
- `db/schema.ts` 与 `drizzle/` 保存缓存表和迁移
- `/api/narrative` 负责离散值校验、SCM复算、缓存查询和首次生成
