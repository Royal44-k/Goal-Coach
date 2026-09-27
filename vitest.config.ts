import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    exclude: [...configDefaults.exclude, "dist/**", "e2e/**", "e2e-invite/**"],
    coverage: {
      provider: "v8",
      include: [
        "src/core/state-machine/**/*.ts",
        "src/server/agent/permission-gate.ts",
        "src/server/agent/tool-executor.ts",
        "src/server/agent/orchestrator.ts",
        "src/server/agent/agent-turn-store.ts",
        "src/server/agent/domain-write-observer.ts",
        "src/server/agent/agent-turn-error.ts"
      ],
      thresholds: { branches: 90, functions: 90, lines: 90, statements: 90 }
    }
  }
});
