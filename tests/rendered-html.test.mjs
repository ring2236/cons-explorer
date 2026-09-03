import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the finished CoNS Explorer instead of the starter", async () => {
  const [page, explorer, layout] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/Explorer.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);
  assert.match(page, /<Explorer/);
  assert.match(explorer, /组合多个选择/);
  assert.match(explorer, /专业说明/);
  assert.match(explorer, /生动故事/);
  assert.match(explorer, /portOffset/);
  assert.match(explorer, /markerUnits="userSpaceOnUse"/);
  assert.match(explorer, /graph-edge-halo/);
  assert.doesNotMatch(explorer, /fetch\(|\/api\/narrative|数据库命中/);
  assert.doesNotMatch(explorer, /CAUSAL NARRATIVE LAB|静态情景库|离线内容已就绪|DeepSeek 离线批处理/);
  assert.match(layout, /CoNS Explorer/);
  assert.doesNotMatch(`${page}${explorer}${layout}`, /codex-preview|SkeletonPreview|Your site is taking shape/);
});

test("contains the complete bias-teaching model bundle", async () => {
  const bundle = JSON.parse(await readFile(new URL("lib/models.generated.json", root), "utf8"));
  assert.equal(bundle.totals.datasets, 5);
  assert.equal(bundle.totals.nodes, 44);
  assert.equal(bundle.totals.edges, 65);
  assert.equal(bundle.datasets.reduce((sum, item) => sum + item.nodes.length, 0), 44);
  assert.ok(bundle.datasets.every((item) => item.bias_points.length === 3));
  assert.ok(bundle.datasets.some((item) => item.nodes.some((node) => node.latent)));
  assert.ok(bundle.datasets.every((item) => item.nodes.every((node) => !node.intervenable || node.discrete_options.length >= 3)));
});

test("publishes only the three currently active datasets", async () => {
  const activeDatasets = await readFile(new URL("lib/active-datasets.ts", root), "utf8");
  assert.match(activeDatasets, /rice_nitrogen/);
  assert.match(activeDatasets, /tutoring_education/);
  assert.match(activeDatasets, /supply_chain_bullwhip/);
  assert.doesNotMatch(activeDatasets, /icu_septic_shock|monetary_policy/);
});

test("ships all static scenarios and complete v4 narrative versions", async () => {
  const [scenarios, narratives] = await Promise.all([
    readFile(new URL("lib/scenarios.generated.json", root), "utf8").then(JSON.parse),
    readFile(new URL("lib/narratives-v4.generated.json", root), "utf8").then(JSON.parse),
  ]);
  assert.equal(scenarios.totals.scenarios, 360);
  assert.equal(narratives.totals.generated_scenarios, 360);
  assert.equal(narratives.schema_version, "static-narratives-natural-professional-v4");
  assert.equal(narratives.prompt_version, "natural-professional-explanation-v4");
  assert.ok(scenarios.datasets.every((dataset) => dataset.controls.every((control) => control.values.length === 5)));
  const scenarioKeys = new Set(scenarios.datasets.flatMap((dataset) => dataset.scenarios.map((scenario) => scenario.key)));
  const narrativeRows = narratives.datasets.flatMap((dataset) => dataset.scenarios);
  assert.equal(scenarioKeys.size, 360);
  assert.equal(narrativeRows.length, 360);
  assert.ok(narrativeRows.every((row) => scenarioKeys.has(row.key)));
  assert.ok(narrativeRows.every((row) => row.professional_explanation.length >= 250 && row.children_story.length >= 220));
  assert.ok(narrativeRows.every((row) => row.coverage?.professional?.length && row.coverage?.children_story?.length));
});

test("has no runtime database or narrative API", async () => {
  const [hosting, packageJson, vite, worker] = await Promise.all([
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("vite.config.ts", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
  ]);
  assert.equal(JSON.parse(hosting).d1, null);
  assert.doesNotMatch(packageJson, /drizzle/);
  assert.doesNotMatch(`${vite}${worker}`, /D1Database|d1_databases|CLOUDFLARE_D1/);
  await assert.rejects(readFile(new URL("app/api/narrative/route.ts", root), "utf8"));
});
