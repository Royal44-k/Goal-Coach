import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: process.env.APP_ORIGIN ?? `http://127.0.0.1:${process.env.E2E_PORT ?? "3000"}`, trace: "retain-on-failure" },
  projects: [{ name: "edge", use: { ...devices["Desktop Chrome"], channel: "msedge" } }],
});
