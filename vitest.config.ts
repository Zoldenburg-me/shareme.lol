import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["host/test/**/*.test.ts", "mcp/test/**/*.test.ts", "test/**/*.test.ts"],
    coverage: {
      include: ["host/src/**", "mcp/src/**"],
      exclude: ["**/index.ts"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
