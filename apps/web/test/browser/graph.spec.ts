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
