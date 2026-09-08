import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  projects: [
    { name: "repository", testMatch: "graph.spec.ts", use: { baseURL: "http://127.0.0.1:4273" } },
    { name: "studio", testMatch: "studio.spec.ts", use: { baseURL: "http://127.0.0.1:4275", viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: [{
    command: "npm run preview -- --host 127.0.0.1 --port 4273",
    port: 4273,
    reuseExistingServer: false,
  }, { command: "node ../../packages/cli/dist/index.js studio --port 4275", port: 4275, reuseExistingServer: false }],
});
