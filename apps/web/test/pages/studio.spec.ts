import "../project-import-checks";
import { expect, test } from "@playwright/test";

test("public site converts and edits Solidity without a backend", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(request.url()); });
  await page.goto("./");
  await expect(page.getByText(/Public browser edition/)).toBeVisible();
  await expect(page.getByLabel("Paste Solidity")).toHaveValue(/contract TokenFactory/);
  await page.getByRole("button", { name: "Convert to nodes" }).click();
  await expect(page.getByRole("status")).toContainText("Synchronized");
  await expect(page.getByRole("button", { name: "Run selected function" })).toBeDisabled();
  await expect(page.locator('.react-flow__edge')).not.toHaveCount(0);
  await page.getByRole("button", { name: /Solidity Studio CODE/ }).click();
  await page.getByLabel("Paste Solidity").fill('// SPDX-License-Identifier: MIT\npragma solidity ^0.8.26; contract Counter { uint256 public value; function set(uint256 amount) external { value = amount; } }');
  await page.getByRole("button", { name: "Convert to nodes" }).click();
  await expect(page.getByRole("status")).toContainText("Synchronized");
  await page.locator('.react-flow__node').filter({ hasText: 'Assignment' }).filter({ hasText: 'value = amount' }).first().click();
  await page.getByLabel("Node inspector").getByRole("button", { name: /right uint256/ }).click();
  await page.getByLabel("Node draft").fill("amount + 1");
  await page.getByRole("button", { name: "Apply node edit" }).click();
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/value = amount \+ 1/);
  await expect(page.getByRole("status")).toContainText("Synchronized");
  await page.getByLabel("Solidity source editor").fill('pragma solidity ^0.8.26; contract Broken {');
  await expect(page.getByRole("status")).toContainText("last valid revision");
  await expect(page.getByLabel("Compiler diagnostics")).toContainText("ParserError");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Synchronized");
  expect(posts).toEqual([]);
});

test("switches browser compiler versions for legacy Solidity and keeps source unchanged", async ({ page }) => {
  await page.goto('./');
  const legacy = 'pragma solidity =0.7.6; contract Legacy { function decrement(uint256 amount) public pure returns(uint256) { return amount - 1; } }';
  await page.getByLabel('Paste Solidity').fill(legacy);
  await page.getByRole('button', { name: 'Convert to nodes' }).click();
  await expect(page.getByRole('status')).toContainText('solc 0.7.6');
  await expect(page.getByRole('status')).toContainText('Synchronized');
  await expect(page.getByLabel('Solidity source editor')).toHaveValue(legacy);
  await page.getByLabel('Solidity source editor').fill(legacy.replace('=0.7.6', '^0.8.26'));
  await expect(page.getByRole('status')).toContainText('solc 0.8.36');
  await expect(page.getByRole('status')).toContainText('Synchronized');
  await page.getByLabel('Solidity source editor').fill(legacy);
  await expect(page.getByRole('status')).toContainText('solc 0.7.6');
  await expect(page.getByRole('status')).toContainText('Synchronized');
});
