import type { NextConfig } from "next";

const config = {
  poweredByHeader: false,
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [
      { source: "/sw.js", headers: [
        { key: "Cache-Control", value: "no-store" },
        { key: "Service-Worker-Allowed", value: "/" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ] },
      { source: "/offline.html", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
} satisfies NextConfig;

export default config;
