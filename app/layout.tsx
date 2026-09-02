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
    description: "基于 ICU、农业、货币政策、教育与供应链五个偏差教学模型的交互因果干预实验。",
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "CoNS Explorer · 偏差考点版",
      description: "五个因果干预实验：看见偏差结构与变化路径。",
      images: [{ url: ogImage, width: 1200, height: 630, alt: "CoNS Explorer 偏差考点版五个因果干预实验" }],
    },
    twitter: { card: "summary_large_image", images: [ogImage] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
