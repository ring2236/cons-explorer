# CoNS Explorer

一个完全静态的多节点因果情景探索器。用户可以让每个可干预节点保持自然变化，或从五个离散值中选择；页面随后直接读取预先计算的结果、专业说明和同一故事世界中的平行分支。

## 当前数据

- 当前前端展示 3 个数据集：水稻氮管理、课外辅导与学业成绩、供应链牛鞭效应
- 3 个展示数据集共 27 个节点、40 条结构方程依赖边
- 每个数据集 2–3 个可组合设置的节点
- 每个节点包含“自然变化”与 5 个固定值
- 当前展示 288 个静态情景，其中 285 个至少包含一次主动设置
- 每个情景均包含覆盖完整因果结构的专业说明和情境化因果故事

模型来自 `因果图候选库_v2_偏差考点版.md`。仓库仍保留 ICU 和货币政策的完整数据，当前通过 `lib/active-datasets.ts` 暂时隐藏，之后可以快速恢复。静态情景位于 `lib/scenarios.generated.json`，当前使用的 v4 叙事位于 `lib/narratives-v4.generated.json`。

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
npm run narratives:v4:generate
npm run narratives:v4:validate
```

API Key 只用于离线生成，不会进入前端构建或线上运行环境。

## Cloudflare 部署

Cloudflare Workers Builds 配置：

- Build command：`npm run build`
- Deploy command：`npx wrangler deploy`

线上页面不连接数据库，也不调用生成式 AI，无需配置 D1、API Key 或其他运行时变量。
