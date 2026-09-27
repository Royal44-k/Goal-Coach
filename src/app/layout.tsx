import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AuthGate } from "@/components/auth/auth-gate";
import { PWAProvider } from "@/components/pwa/pwa-controls";

export const metadata: Metadata = {
  title: "自适应目标教练",
  description: "把目标变成今天能开始的行动",
  appleWebApp: { capable: true, title: "目标教练", statusBarStyle: "default" },
  icons: { apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" }] },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><PWAProvider><AuthGate>{children}</AuthGate></PWAProvider></body>
    </html>
  );
}
