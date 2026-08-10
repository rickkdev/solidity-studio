import { expect, test } from "@playwright/test";

test("renders the fixture graph and supports canvas controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Repository graph for solidity-project")).toBeVisible();
  await expect(page.getByText("Vault.sol")).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(9);
  await page.getByRole("button", { name: "Fit graph" }).click();
  await page.getByRole("button", { name: "Reset view" }).click();
});
