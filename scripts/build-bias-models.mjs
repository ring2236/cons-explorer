import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sourcePath = process.argv[2];
const outputPath = process.argv[3] ?? "lib/models.generated.json";
if (!sourcePath) throw new Error("Usage: node scripts/build-bias-models.mjs <source.md> [output.json]");

const source = readFileSync(sourcePath, "utf8");
for (const marker of ["图 1｜ICU", "图 2｜水稻", "图 3｜货币政策", "图 4｜课外辅导", "图 5｜供应链"]) {
  if (!source.includes(marker)) throw new Error(`Source marker missing: ${marker}`);
}
const sourceHash = createHash("sha256").update(source).digest("hex");

const c = (value) => ({ op: "const", value });
const v = (id) => ({ op: "var", id });
const add = (...args) => ({ op: "add", args });
const sub = (a, b) => ({ op: "sub", a, b });
const mul = (...args) => ({ op: "mul", args });
const div = (a, b) => ({ op: "div", a, b });
const pow = (a, b) => ({ op: "pow", a, b });
const exp = (x) => ({ op: "exp", x });
const log = (x) => ({ op: "log", x });
const max = (...args) => ({ op: "max", args });
const sigmoid = (x) => ({ op: "sigmoid", x });
const expression = (tree, text) => ({ type: "expression", expression: tree, formula_text: text });
const input = (text = "冻结基线输入") => ({ type: "input", formula_text: text });
const option = (kind, label, value) => ({ kind, label, value });

function node({ id, zh, en, unit, role, ref, min, max: upper, decimals = 2, mechanism, options = [], latent = false }) {
  return {
    id,
    label_zh: zh,
    label_en: en,
    unit,
    role,
    reference_value: ref,
    min_value: min,
    max_value: upper,
    decimals,
    intervenable: options.length > 0,
    suggested_intervention: options.find((item) => item.kind === "recommended")?.value ?? null,
    latent,
    mechanism,
    discrete_options: options,
  };
}

function edge(source, target, sign = "positive") { return { source, target, sign, relation: sign }; }

function finalize(dataset) {
  const parents = Object.fromEntries(dataset.nodes.map((item) => [item.id, []]));
  const children = Object.fromEntries(dataset.nodes.map((item) => [item.id, []]));
  for (const item of dataset.edges) {
    parents[item.target].push(item.source);
    children[item.source].push(item.target);
  }
  dataset.nodes = dataset.nodes.map((item) => ({ ...item, parents: parents[item.id], children: children[item.id] }));
  return dataset;
}

const datasets = [
  finalize({
    schema_version: "bias-v2",
    dataset_id: "icu_septic_shock",
    title_zh: "ICU脓毒症休克",
    title_en: "Vasopressor dose and acute kidney injury",
    domain: "重症医学 · 升压药剂量与急性肾损伤",
    expertise: "血管活性药物滴定、肾脏灌注阈值与ICU选择机制",
    boundary_zh: "冻结教学SCM，仅用于结构理解与偏差识别，不用于医疗决策。",
    topological_order: ["A", "S", "Kb", "N", "M", "L", "U", "H", "R"],
    nodes: [
      node({ id: "A", zh: "年龄", en: "Age", unit: "岁", role: "根节点", ref: 78, min: 18, max: 100, mechanism: input() }),
      node({ id: "Kb", zh: "慢性肾病负担", en: "Chronic kidney burden", unit: "指数", role: "中介/独立病因", ref: 10.16, min: 0, max: 30, mechanism: expression(sub(mul(c(.72), v("A")), c(46)), "Kb = 0.72·A − 46") }),
      node({ id: "S", zh: "SOFA评分", en: "SOFA score", unit: "分", role: "根节点", ref: 7.2, min: 0, max: 24, decimals: 1, mechanism: input("感染严重度冻结输入") }),
      node({ id: "N", zh: "去甲肾上腺素剂量", en: "Norepinephrine dose", unit: "μg/kg/min", role: "干预节点", ref: .33, min: 0, max: 1, decimals: 2, mechanism: expression(mul(c(.014), pow(v("S"), c(1.6))), "N = 0.014·S^1.6"), options: [option("low", "低剂量", .15), option("baseline", "基线", .33), option("recommended", "高剂量情景", .60)] }),
      node({ id: "M", zh: "平均动脉压MAP", en: "Mean arterial pressure", unit: "mmHg", role: "中介", ref: 89.18, min: 40, max: 130, mechanism: expression(add(c(52), mul(c(-.9), v("S")), mul(c(52), sub(c(1), exp(mul(c(-1), div(v("N"), c(.18))))))), "M = 52 − 0.9·S + 52·(1 − e^(−N/0.18))") }),
      node({ id: "L", zh: "血乳酸", en: "Lactate", unit: "mmol/L", role: "非后代", ref: 3.08, min: 0, max: 15, mechanism: expression(add(c(.85), mul(c(.155), pow(v("S"), c(1.35)))), "L = 0.85 + 0.155·S^1.35") }),
      node({ id: "U", zh: "尿量", en: "Urine output", unit: "ml/kg/h", role: "中介", ref: .99, min: 0, max: 2, mechanism: expression(mul(c(1.65), sigmoid(div(sub(v("M"), c(88)), c(3)))), "U = 1.65·σ((M−88)/3)") }),
      node({ id: "R", zh: "48h急性肾损伤风险", en: "48h AKI risk", unit: "%", role: "结局", ref: 55.75, min: 0, max: 100, mechanism: expression(mul(c(100), sigmoid(add(c(-3), mul(c(.55), v("S")), mul(c(.62), div(v("Kb"), c(18))), mul(c(.30), v("L")), mul(c(2.3), max(c(0), sub(v("N"), c(.30)))), mul(c(-2.1), v("U"))))), "R = 100·σ(… + 2.3·max(0,N−0.30) − 2.1·U)") }),
      node({ id: "H", zh: "收入ICU概率", en: "ICU admission probability", unit: "%", role: "选择节点/碰撞点", ref: 41.42, min: 0, max: 100, mechanism: expression(mul(c(100), sigmoid(add(mul(c(.55), sub(v("S"), c(7.2))), div(sub(v("Kb"), c(10)), c(3)), c(-.4)))), "H = 100·σ(0.55·(S−7.2)+(Kb−10)/3−0.4)") }),
    ],
    edges: [edge("A","Kb"),edge("S","N"),edge("S","M","negative"),edge("N","M"),edge("S","L"),edge("M","U"),edge("S","R"),edge("Kb","R"),edge("L","R"),edge("N","R"),edge("U","R","negative"),edge("S","H"),edge("Kb","H")],
    bias_points: [
      { name: "伯克森悖论", structure: "Kb → H ← S", note: "对ICU入选者分层会凭空制造肾病负担与感染严重度的负相关。" },
      { name: "过度控制", structure: "N → M → U → R", note: "把MAP当作控制变量会阻断剂量的肾保护通路。" },
      { name: "辛普森悖论", structure: "S → N 且 S → R", note: "观察相关方向与控制严重度后的方向相反。" },
    ],
    layout: { A:[130,70], S:[520,70], Kb:[130,220], N:[420,210], L:[720,210], H:[185,410], M:[430,340], U:[430,480], R:[760,480] },
  }),
  finalize({
    schema_version: "bias-v2", dataset_id: "rice_nitrogen", title_zh: "水稻氮管理", title_en: "Nitrogen, lodging and rice yield", domain: "农学 · 施氮量、倒伏与产量", expertise: "Mitscherlich饱和、土壤—气候耦合与倒伏风险", boundary_zh: "冻结教学SCM，不用于实际农业投入决策。", topological_order: ["T","P","O","I","W","N","LAI","Ld","Y"],
    nodes: [
      node({ id:"T",zh:"抽穗期均温",en:"Heading temperature",unit:"°C",role:"根节点",ref:26.5,min:10,max:40,decimals:1,mechanism:input()}),
      node({ id:"P",zh:"季降水量",en:"Season rainfall",unit:"mm",role:"根节点",ref:480,min:0,max:1000,decimals:0,mechanism:input()}),
      node({ id:"O",zh:"土壤有机质",en:"Soil organic matter",unit:"g/kg",role:"根节点/混杂因子",ref:22,min:0,max:60,mechanism:input()}),
      node({ id:"I",zh:"灌溉量",en:"Irrigation",unit:"mm",role:"中介",ref:80,min:0,max:400,mechanism:expression(max(c(0),sub(c(320),mul(c(.5),v("P")))),"I = max(0,320−0.5P)")}),
      node({ id:"W",zh:"耕层含水率",en:"Topsoil water",unit:"%",role:"中介",ref:28.56,min:0,max:60,mechanism:expression(add(c(18),mul(c(.012),v("P")),mul(c(.06),v("I")),mul(c(-.4),pow(max(c(0),sub(v("T"),c(28))),c(2)))),"W = 18+0.012P+0.06I−0.40max(0,T−28)²")}),
      node({ id:"N",zh:"施氮量",en:"Nitrogen application",unit:"kg/ha",role:"干预节点",ref:250.01,min:0,max:450,mechanism:expression(add(mul(c(300),exp(mul(c(-1),div(v("O"),c(35))))),c(90)),"N = 300e^(−O/35)+90"),options:[option("low","减氮情景",180),option("baseline","基线",250.01),option("recommended","高氮情景",320)]}),
      node({ id:"LAI",zh:"叶面积指数",en:"Leaf area index",unit:"—",role:"中介",ref:4.18,min:0,max:8,mechanism:expression(mul(c(6.2),sub(c(1),exp(mul(c(-1),div(v("N"),c(140))))),sub(c(1),exp(mul(c(-1),div(max(c(0),sub(v("W"),c(12))),c(10)))))),"LAI = 6.2·(1−e^(−N/140))·(1−e^(−max(0,W−12)/10))")}),
      node({ id:"Ld",zh:"倒伏率",en:"Lodging rate",unit:"%",role:"碰撞点/中介",ref:44.47,min:0,max:100,mechanism:expression(mul(c(100),sigmoid(add(mul(c(.9),sub(v("LAI"),c(4.4))),mul(c(.5),sub(v("W"),c(28.6)))))),"Ld = 100·σ(0.9(LAI−4.4)+0.5(W−28.6))")}),
      node({ id:"Y",zh:"产量",en:"Yield",unit:"t/ha",role:"结局",ref:5.96,min:0,max:15,mechanism:expression(add(c(3.1),mul(c(1.9),sub(c(1),exp(mul(c(-1),div(v("LAI"),c(2.2)))))),mul(c(.012),v("N")),mul(c(-.000028),pow(v("N"),c(2))),mul(c(.055),sub(v("O"),c(22))),mul(c(.03),sub(v("W"),c(20))),mul(c(-.12),pow(max(c(0),sub(v("T"),c(30))),c(2))),mul(c(-.006),v("Ld"))),"非线性产量方程")}),
    ],
    edges:[edge("P","I","negative"),edge("P","W"),edge("I","W"),edge("T","W","negative"),edge("O","N","negative"),edge("N","LAI"),edge("W","LAI"),edge("LAI","Ld"),edge("W","Ld"),edge("LAI","Y"),edge("N","Y"),edge("O","Y"),edge("W","Y"),edge("T","Y","negative"),edge("Ld","Y","negative")],
    bias_points:[{name:"碰撞偏差",structure:"LAI → Ld ← W",note:"按高倒伏地块分层会压低叶面积与水分的真实关系。"},{name:"过度控制",structure:"N → LAI → Ld → Y",note:"控制倒伏会阻断施氮的减产通路。"},{name:"辛普森悖论",structure:"O → N 且 O → Y",note:"贫瘠地块多施肥造成氮肥普遍有害的观察假象。"}],
    layout:{T:[120,70],P:[360,70],O:[680,70],I:[300,205],W:[250,350],N:[620,220],LAI:[540,350],Ld:[460,470],Y:[760,500]},
  }),
  finalize({
    schema_version:"bias-v2",dataset_id:"monetary_policy",title_zh:"货币政策传导",title_en:"Interest rates, credit and inflation",domain:"宏观经济 · 加息、信贷与通胀",expertise:"泰勒规则、信贷渠道、菲利普斯曲线与价格之谜",boundary_zh:"冻结教学SCM，不用于宏观预测或投资判断。",topological_order:["G","E","R","L","C","I","P","U"],
    nodes:[
      node({id:"G",zh:"产出缺口",en:"Output gap",unit:"%",role:"根节点/混杂因子",ref:1.8,min:-8,max:8,decimals:1,mechanism:input()}),
      node({id:"E",zh:"通胀预期",en:"Inflation expectation",unit:"%",role:"根节点",ref:2.6,min:0,max:10,decimals:1,mechanism:input()}),
      node({id:"R",zh:"政策利率",en:"Policy rate",unit:"%",role:"干预节点/碰撞点",ref:2.73,min:0,max:12,mechanism:expression(add(c(1.2),mul(c(.9),max(c(0),sub(v("E"),c(2)))),mul(c(.55),v("G"))),"R = 1.2+0.9max(0,E−2)+0.55G"),options:[option("low","宽松情景",1.5),option("baseline","基线",2.73),option("recommended","加息情景",5.4)]}),
      node({id:"L",zh:"银行贷款利率",en:"Bank lending rate",unit:"%",role:"中介",ref:4.33,min:0,max:20,mechanism:expression(add(c(1.6),v("R"),mul(c(.35),max(c(0),mul(c(-1),v("G"))))),"L = 1.6+R+0.35max(0,−G)")}),
      node({id:"C",zh:"信贷增速",en:"Credit growth",unit:"%",role:"中介",ref:14.41,min:-20,max:30,mechanism:expression(add(c(11),mul(c(-2.4),sub(v("L"),c(5))),v("G")),"C = 11−2.4(L−5)+G")}),
      node({id:"I",zh:"固定资产投资增速",en:"Investment growth",unit:"%",role:"中介",ref:9.41,min:0,max:20,mechanism:expression(add(c(2),mul(c(9),sub(c(1),exp(mul(c(-1),div(max(c(0),sub(v("C"),c(4))),c(6))))))),"I = 2+9(1−e^(−max(0,C−4)/6))")}),
      node({id:"P",zh:"核心通胀率",en:"Core inflation",unit:"%",role:"结局",ref:4.08,min:-5,max:20,mechanism:expression(add(c(.6),mul(c(.55),v("E")),mul(c(.3),v("G")),mul(c(.16),v("I")),mul(c(.8),pow(max(c(0),sub(v("G"),c(2.5))),c(2)))),"非线性菲利普斯曲线")}),
      node({id:"U",zh:"失业率",en:"Unemployment",unit:"%",role:"结局",ref:4.09,min:0,max:30,mechanism:expression(add(c(6),mul(c(-.52),v("G")),mul(c(-.16),v("I")),mul(c(.006),pow(v("I"),c(2)))),"U = 6−0.52G−0.16I+0.006I²")}),
    ],
    edges:[edge("E","R"),edge("G","R"),edge("R","L"),edge("G","L"),edge("L","C","negative"),edge("G","C"),edge("C","I"),edge("E","P"),edge("G","P"),edge("I","P"),edge("G","U","negative"),edge("I","U","negative")],
    bias_points:[{name:"碰撞偏差",structure:"G → R ← E",note:"按高利率时期分层会制造产出缺口与预期的负相关。"},{name:"过度控制",structure:"R → L → C → I → P",note:"控制信贷链会截断加息的传导机制。"},{name:"价格之谜",structure:"G/E → R 且 G/E → P",note:"观察数据中利率与通胀正相关，但干预加息使模型通胀下降。"}],
    layout:{G:[240,70],E:[700,70],R:[500,180],L:[500,295],C:[500,405],I:[500,515],P:[780,515],U:[220,515]},
  }),
  finalize({
    schema_version:"bias-v2",dataset_id:"tutoring_education",title_zh:"课外辅导与学业成绩",title_en:"Tutoring and academic achievement",domain:"教育经济 · 辅导、睡眠、焦虑与成绩",expertise:"按需分配、学习挤出与Yerkes–Dodson倒U",boundary_zh:"冻结教学SCM，不用于学生评价或教育决策。",topological_order:["F","Q","E","B","T","S","H","A","G"],
    nodes:[
      node({id:"F",zh:"家庭SES",en:"Family SES",unit:"z分数",role:"根节点",ref:.5,min:-3,max:3,decimals:2,mechanism:input()}),
      node({id:"E",zh:"父母教育年限",en:"Parental education",unit:"年",role:"中介",ref:13.5,min:0,max:25,decimals:1,mechanism:expression(add(c(12),mul(c(3),v("F"))),"E = 12+3F")}),
      node({id:"Q",zh:"学校质量指数",en:"School quality",unit:"分",role:"根节点",ref:74,min:0,max:100,decimals:0,mechanism:input()}),
      node({id:"B",zh:"入学前测成绩",en:"Baseline score",unit:"分",role:"混杂因子",ref:83.9,min:0,max:100,decimals:1,mechanism:expression(add(c(30),mul(c(1.8),v("E")),mul(c(.4),v("Q"))),"B = 30+1.8E+0.40Q")}),
      node({id:"T",zh:"课外辅导时长",en:"Tutoring hours",unit:"h/周",role:"干预节点",ref:5.23,min:0,max:20,mechanism:expression(add(c(3.5),mul(c(11),exp(mul(c(-1),div(sub(v("B"),c(58)),c(14)))))),"T = 3.5+11e^(−(B−58)/14)"),options:[option("low","低辅导情景",2),option("baseline","基线",5.23),option("recommended","高辅导情景",10)]}),
      node({id:"S",zh:"自主学习时长",en:"Self-study hours",unit:"h/周",role:"中介",ref:11.39,min:0,max:30,mechanism:expression(add(c(7),mul(c(1.1),v("T")),mul(c(-.05),pow(v("T"),c(2)))),"S = 7+1.1T−0.05T²")}),
      node({id:"H",zh:"睡眠时长",en:"Sleep duration",unit:"h/天",role:"中介",ref:7.41,min:0,max:12,mechanism:expression(add(c(9),mul(c(-.14),v("S"))),"H = 9−0.14S")}),
      node({id:"A",zh:"考试焦虑",en:"Test anxiety",unit:"指数",role:"中介",ref:2.07,min:0,max:10,mechanism:expression(add(c(1.2),mul(c(.3),max(c(0),sub(c(8.2),v("H")))),mul(c(.045),pow(v("T"),c(1.6)))),"A = 1.2+0.30max(0,8.2−H)+0.045T^1.6")}),
      node({id:"G",zh:"后测成绩",en:"Post-test score",unit:"分",role:"结局/选择节点",ref:71.86,min:0,max:100,mechanism:expression(add(mul(c(.55),v("B")),mul(c(4.5),log(add(c(1),v("T")))),mul(c(1.2),v("S")),mul(c(-.055),pow(v("S"),c(2))),mul(c(1.5),sub(v("H"),c(7))),mul(c(.15),v("Q")),mul(c(-.6),pow(sub(v("A"),c(3.2)),c(2)))),"含Yerkes–Dodson倒U的成绩方程")}),
    ],
    edges:[edge("F","E"),edge("E","B"),edge("Q","B"),edge("B","T","negative"),edge("T","S"),edge("S","H","negative"),edge("H","A","negative"),edge("T","A"),edge("B","G"),edge("T","G"),edge("S","G"),edge("H","G"),edge("Q","G"),edge("A","G")],
    bias_points:[{name:"选择偏差",structure:"B → G ← T",note:"只追踪高分生相当于对共同效应G选样。"},{name:"过度控制",structure:"T → S → H → A → G",note:"控制学习时间会截断辅导的总效应。"},{name:"辛普森悖论",structure:"B → T（负）且 B → G（正）",note:"差生多补习造成补习越多成绩越差的原始相关。"}],
    layout:{F:[160,70],Q:[650,70],E:[160,200],B:[420,200],T:[420,330],S:[240,440],H:[240,555],A:[520,500],G:[780,500]},
  }),
  finalize({
    schema_version:"bias-v2",dataset_id:"supply_chain_bullwhip",title_zh:"供应链牛鞭效应",title_en:"Safety stock, lead time and stockouts",domain:"供应链运营 · 安全库存、提前期与缺货率",expertise:"需求预测过度反应、Kingman拥堵与M-偏倚",boundary_zh:"冻结教学SCM；潜在节点用虚线显示，不用于真实库存决策。",topological_order:["V","U1","U2","F","S","O","L","Z","K"],
    nodes:[
      node({id:"V",zh:"需求波动系数",en:"Demand variability",unit:"CV",role:"根节点/混杂因子",ref:.35,min:0,max:1,decimals:2,mechanism:input()}),
      node({id:"U1",zh:"采购经理经验",en:"Manager experience",unit:"年",role:"潜在根节点",ref:8,min:0,max:40,latent:true,mechanism:input("未观测潜在输入")}),
      node({id:"U2",zh:"供应商真实可靠性",en:"Supplier reliability",unit:"指数",role:"潜在根节点",ref:70,min:0,max:100,latent:true,mechanism:input("未观测潜在输入")}),
      node({id:"F",zh:"需求预测",en:"Demand forecast",unit:"件/日",role:"中介",ref:793,min:0,max:2000,decimals:0,mechanism:expression(mul(c(520),add(c(1),mul(c(1.5),v("V")))),"F = 520(1+1.5V)")}),
      node({id:"S",zh:"安全库存天数",en:"Safety stock",unit:"天",role:"干预节点",ref:3.62,min:0,max:15,mechanism:expression(add(c(3),mul(c(3),pow(v("V"),c(1.5))),mul(c(.3),sub(v("U1"),c(8)))),"S = 3+3V^1.5+0.3(U1−8)"),options:[option("low","精益降库存",2),option("baseline","基线",3.62),option("recommended","高安全库存",9)]}),
      node({id:"O",zh:"订货量",en:"Order quantity",unit:"件/日",role:"碰撞点/中介",ref:936.58,min:0,max:1600,mechanism:expression(mul(v("F"),add(c(1),mul(c(.05),v("S")))),"O = F(1+0.05S)")}),
      node({id:"L",zh:"平均提前期",en:"Lead time",unit:"天",role:"中介",ref:6.41,min:0,max:100,mechanism:expression(add(c(2),mul(c(3.5),div(div(v("O"),c(1600)),sub(c(1.05),div(v("O"),c(1600)))))),"Kingman拥堵公式")}),
      node({id:"Z",zh:"供应商年度评级",en:"Supplier rating",unit:"分",role:"M-偏倚节点",ref:76.5,min:0,max:100,mechanism:expression(add(c(10),mul(c(3.5),v("U1")),mul(c(.55),v("U2"))),"Z = 10+3.5U1+0.55U2")}),
      node({id:"K",zh:"缺货率",en:"Stockout rate",unit:"%",role:"结局",ref:32.75,min:0,max:100,mechanism:expression(add(mul(c(100),sigmoid(mul(c(4),sub(div(add(v("L"),c(2)),add(v("S"),c(3))),c(1.45))))),mul(c(-1.2),sub(v("U2"),c(70)))),"K = 100σ(4((L+2)/(S+3)−1.45))−1.2(U2−70)")}),
    ],
    edges:[edge("V","F"),edge("V","S"),edge("U1","S"),edge("F","O"),edge("S","O"),edge("O","L"),edge("L","K"),edge("S","K","negative"),edge("U2","K","negative"),edge("U1","Z"),edge("U2","Z")],
    bias_points:[{name:"M-偏倚",structure:"S ← U1 → Z ← U2 → K",note:"控制看似合理的供应商评级Z会打开潜在碰撞路径。"},{name:"过度控制",structure:"S → O → L → K",note:"控制提前期会阻断安全库存的间接通路。"},{name:"混杂掩盖",structure:"V → S 且 V → F → O → L → K",note:"高波动同时推高库存和缺货，掩盖安全库存的保护作用。"}],
    layout:{V:[120,70],U1:[480,70],U2:[820,70],F:[120,230],S:[420,245],Z:[790,245],O:[350,380],L:[350,520],K:[720,500]},
  }),
];

const totals = {
  datasets: datasets.length,
  nodes: datasets.reduce((sum, item) => sum + item.nodes.length, 0),
  edges: datasets.reduce((sum, item) => sum + item.edges.length, 0),
};
// The Markdown's edge-count prose omits one equation dependency in graphs 1, 3 and 4.
// Preserve the actual DAG implied by every structural equation: 13 + 15 + 12 + 14 + 11 = 65.
if (totals.datasets !== 5 || totals.nodes !== 44 || totals.edges !== 65) {
  throw new Error(`Unexpected totals: ${JSON.stringify(totals)}`);
}
for (const dataset of datasets) {
  const ids = new Set(dataset.nodes.map((item) => item.id));
  if (dataset.topological_order.length !== dataset.nodes.length) throw new Error(`Bad topo length: ${dataset.dataset_id}`);
  for (const item of dataset.edges) if (!ids.has(item.source) || !ids.has(item.target)) throw new Error(`Bad edge: ${dataset.dataset_id}`);
}

const output = {
  model_version: `bias-v2-${sourceHash.slice(0, 12)}`,
  source_file: sourcePath.split("/").pop(),
  source_sha256: sourceHash,
  generated_at: new Date().toISOString(),
  totals,
  datasets,
};
const absoluteOutput = resolve(outputPath);
mkdirSync(dirname(absoluteOutput), { recursive: true });
writeFileSync(absoluteOutput, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Generated ${absoluteOutput}: ${totals.datasets} datasets, ${totals.nodes} nodes, ${totals.edges} edges`);
