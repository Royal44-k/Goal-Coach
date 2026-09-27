import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Goal Coach",
    short_name: "Goal Coach",
    description: "把目标变成今天能开始的行动",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    lang: "zh-CN",
    background_color: "#f6f4ed",
    theme_color: "#245c3b",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
