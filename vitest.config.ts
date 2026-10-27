import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: false,
  esbuild: {
    jsx: "automatic",
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    passWithNoTests: false,
    reporters: ["default"],
  },
});
