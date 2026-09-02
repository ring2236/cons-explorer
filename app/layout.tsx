import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const ogImage = `${protocol}://${host}/og.png`;
  return {
    title: "CoNS Explorer · 偏差考点版",
    description: "基于 ICU、农业、货币政策、教育与供应链五个场景的静态多节点因果探索器。",
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "CoNS Explorer · 偏差考点版",
      description: "360 个离线分支：组合多个选择，阅读专业说明与同世界短篇故事。",
      images: [{ url: ogImage, width: 1200, height: 630, alt: "CoNS Explorer 偏差考点版五个因果干预实验" }],
    },
    twitter: { card: "summary_large_image", images: [ogImage] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
