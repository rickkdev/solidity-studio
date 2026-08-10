import { expect, test } from "@playwright/test";

test("renders the fixture graph and supports canvas controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Repository graph for solidity-project")).toBeVisible();
  await expect(page.getByText("Vault.sol")).toBeVisible();
  await expect(page.getByText("deposit", { exact: true })).toBeHidden();
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await page.getByLabel("Expand Vault").click();
  await expect(page.getByText("deposit", { exact: true })).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(9);
  await page.getByLabel("Collapse Vault", { exact: true }).click();
  await expect(page.getByText("deposit", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Fit graph" }).click();
  await page.getByRole("button", { name: "Fit expanded" }).click();
  await page.getByRole("button", { name: "Reset view" }).click();
});

test("searches and filters graph evidence", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Find symbol or path").fill("SRC/VAULT.SOL");
  await page.getByRole("button", { name: /deposit.*src\/Vault.sol/i }).click();
  await expect(page.getByLabel("Details for deposit")).toBeVisible();
  await page.getByRole("button", { name: "Security evidence" }).click();
  await expect(page.getByText("External value transfer", { exact: true })).toBeVisible();
  await expect(page.getByText("onlyOwner", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("onlyOwner", { exact: true })).toBeVisible();
});

test("visualizes runtime Foundry results and unresolved failures", async ({ page }) => {
  await page.route("**/api/graph", async (route) => {
    const response = await route.fetch();
    const graph = await response.json();
    graph.nodes = graph.nodes.map((node: { id: string }) => node.id === "vault-test"
      ? { ...node, status: "passed", metadata: { runtimeObserved: true, result: "passed" } } : node);
    graph.nodes.push({ id: "unresolved-test", kind: "test", label: "testUnknown()", status: "failed", metadata: { runtimeObserved: true, unresolvedTarget: true, failureMessage: "unresolved target" } });
    graph.edges = graph.edges.map((edge: { id: string }) => edge.id === "e8" ? { ...edge, metadata: { runtimeObserved: true } } : edge);
    graph.metadata.workEvents = [{ schemaVersion: 1, id: "failed", type: "test_failed", timestamp: "2026-08-10T18:00:00.000Z", message: "testUnknown(): failed — unresolved target", targetIds: ["unresolved-test"], metadata: {} }];
    await route.fulfill({ response, json: graph });
  });
  await page.goto("/");
  await expect(page.getByLabel("test testDeposit")).toHaveClass(/code-node--status-passed/);
  await expect(page.getByLabel("test testUnknown()" )).toHaveClass(/code-node--status-failed/);
  await page.getByLabel("Expand Vault").click();
  await expect(page.locator(".react-flow__edge.edge--runtime")).toHaveCount(1);
  await page.getByRole("button", { name: "testUnknown()" }).click();
  await expect(page.getByLabel("Details for testUnknown()")).toContainText("unresolved target");
});
