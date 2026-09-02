import type { Metadata } from "next";
import { Explorer } from "./Explorer";

export const metadata: Metadata = {
  title: "CoNS Explorer · 离散因果干预实验",
  description: "基于五个结构因果模型的交互干预与AI叙事研究原型。",
};

export default function Home() {
  return <Explorer />;
}
