import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "健康问书 · 基于书籍知识库的健康问答",
  description: "基于《超越百岁》等书籍知识库的 AI 健康问答演示",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
