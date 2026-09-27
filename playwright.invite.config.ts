import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-invite",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  globalSetup: "./e2e-invite/global-setup.ts",
  outputDir: "test-results/invite",
  // Traces could contain synthetic registration secrets; capture only explicit safe screenshots.
  use: { baseURL: process.env.APP_ORIGIN ?? `http://127.0.0.1:${process.env.E2E_PORT ?? "3000"}`, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "edge", use: { ...devices["Desktop Chrome"], channel: "msedge" } }],
});
