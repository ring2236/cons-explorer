import type { Metadata } from "next";
import { Explorer } from "./Explorer";

export const metadata: Metadata = {
  title: "CoNS Explorer · 静态多节点因果情景",
  description: "同时设置多个离散节点，即时查看离线计算结果、专业说明与平行故事分支。",
};

export default function Home() {
  return <Explorer />;
}
