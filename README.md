# CoNS Explorer

一个完全静态的多节点因果情景探索器。用户可以让每个可干预节点保持自然变化，或从五个离散值中选择；页面随后直接读取预先计算的结果、专业说明和同一故事世界中的平行分支。

## 当前数据

- 5 个数据集、44 个节点、65 条结构方程依赖边
- 每个数据集 2–3 个可组合设置的节点
- 每个节点包含“自然变化”与 5 个固定值
- 360 个静态情景，其中 355 个至少包含一次主动设置
- 每个情景均包含专业说明和生动故事

模型来自 `因果图候选库_v2_偏差考点版.md`。静态情景位于 `lib/scenarios.generated.json`，离线叙事位于 `lib/narratives.generated.json`。

## 本地运行与验证

```bash
npm install
npm run dev
```

```bash
npm test
```

## 重新生成离线内容

先生成确定性情景：

```bash
npm run scenarios:generate
```

如需重新请求 DeepSeek，在本地终端临时设置 `DEEPSEEK_API_KEY`，然后运行：

```bash
npm run narratives:bibles
npm run narratives:generate
```

API Key 只用于离线生成，不会进入前端构建或线上运行环境。

## Cloudflare 部署

Cloudflare Workers Builds 配置：

- Build command：`npm run build`
- Deploy command：`npx wrangler deploy`

线上页面不连接数据库，也不调用生成式 AI，无需配置 D1、API Key 或其他运行时变量。
