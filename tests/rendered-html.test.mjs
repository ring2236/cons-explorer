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
  assert.match(explorer, /离散情景值/);
  assert.match(explorer, /数据库命中/);
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

test("uses a versioned D1 narrative cache", async () => {
  const [route, schema, hosting] = await Promise.all([
    readFile(new URL("app/api/narrative/route.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
  ]);
  assert.match(route, /PROMPT_VERSION/);
  assert.match(route, /SELECT narrative_text/);
  assert.match(route, /INSERT INTO narrative_cache/);
  assert.match(schema, /narrativeCache/);
  assert.equal(JSON.parse(hosting).d1, "DB");
});
