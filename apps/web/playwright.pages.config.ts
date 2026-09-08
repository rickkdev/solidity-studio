import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/pages",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  use: { baseURL: process.env.PAGES_TEST_URL ?? "http://127.0.0.1:4290/solidity-studio/", viewport: { width: 1440, height: 1000 } },
  ...(!process.env.PAGES_TEST_URL ? { webServer: { command: "VITE_PUBLIC_DEMO=true npm run preview -- --host 127.0.0.1 --port 4290", port: 4290, reuseExistingServer: false } } : {}),
});
