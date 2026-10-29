import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlyNeuro · 果蝇具身神经仿真",
  description:
    "在丰富自然微环境中探索果蝇复眼输入、Flyvis 视觉活动与全 CNS 通路背景的交互式仿真仪表盘。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
