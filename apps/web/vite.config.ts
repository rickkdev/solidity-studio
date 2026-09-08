import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_PUBLIC_DEMO === "true" ? "/solidity-studio/" : "/",
  worker: { format: "iife" },
  preview: { proxy: {} },
  server: { proxy: { "/api/studio": `http://127.0.0.1:${process.env.CODEVIS_STUDIO_PORT ?? 4174}` } },
  resolve: {
    alias: {
      "@codevis/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/setup-tests.ts"],
  },
});
