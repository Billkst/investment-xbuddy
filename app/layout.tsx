import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "投资 XBuddy · 个人研究工作台",
  description: "从研究目标到可验证成果。管理研究计划、金融证据与长期研究记忆。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
