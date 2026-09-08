import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("pastes a contract, edits a value, undoes, and restores an exported workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Think in nodes/ })).toBeVisible();
  await page.getByLabel("Paste Solidity").fill('// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Counter { uint256 public value; function set(uint256 amount) external { value = amount; } }');
  await page.getByRole("button", { name: "Convert to nodes" }).click();
  await expect(page.getByRole("status")).toContainText("Synchronized");
  await page.getByRole("button", { name: "ƒ set(uint256)" }).click();
  await page.locator('.react-flow__node').filter({ hasText: /^.*Assignment/ }).filter({ hasText: 'value = amount' }).first().click();
  await page.getByLabel("Node inspector").getByRole("button", { name: /right uint256/ }).click();
  await page.getByLabel("Node draft").fill("amount + 1");
  await page.getByRole("button", { name: "Apply node edit" }).click();
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/value = amount \+ 1/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/value = amount;/);
  await expect(page.getByRole("status")).toContainText("Synchronized");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/value = amount \+ 1/);
  await expect(page.getByRole("status")).toContainText("Synchronized");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save workspace" }).click();
  const file = await download; const path = await file.path();
  await page.reload();
  await page.getByRole("button", { name: /Resume saved workspace/ }).click();
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/value = amount \+ 1/);
  await page.getByRole("button", { name: /Solidity Studio CODE/ }).click();
  await page.getByLabel("Import Solidity or workspace").setInputFiles({ name: "workspace.codevis.json", mimeType: "application/json", buffer: await readFile(path!) });
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/value = amount \+ 1/);
});

test("builds a contract using palette controls and retains the source when a node draft fails", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New contract" }).click();
  await expect(page.getByRole("status")).toContainText("Synchronized");
  await page.getByRole("button", { name: "State variable Contract" }).click();
  await page.getByRole("button", { name: "Apply node edit" }).click();
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/uint256 public value;/);
  await page.getByRole("button", { name: "Function Contract", exact: true }).click();
  await page.getByLabel("Node Name").fill("set");
  await page.getByRole("button", { name: "Apply node edit" }).click();
  await page.getByRole("button", { name: "ƒ set(uint256)" }).click();
  await page.getByRole("button", { name: "Assign / write Values" }).click();
  await page.getByLabel("Node Value", { exact: true }).fill("amount");
  await page.getByRole("button", { name: "Apply node edit" }).click();
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/value = amount;/);
  await page.getByRole("button", { name: "Check / require Logic" }).click();
  await page.getByLabel("Node Condition").fill("missingSymbol > 0");
  await page.getByRole("button", { name: "Apply node edit" }).click();
  await expect(page.getByRole("alert")).toContainText("does not compile");
  await expect(page.getByLabel("Solidity source editor")).not.toHaveValue(/missingSymbol/);
  await expect(page.getByLabel("Solidity source editor")).toBeDisabled();
  await page.getByLabel("Node Condition").fill("amount > 0");
  await page.getByRole("button", { name: "Apply node edit" }).click();
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/require\(amount > 0/);
  await expect(page.getByRole("status")).toContainText("Synchronized");
});

test("keeps the last valid canvas for invalid source and recovers", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore a vault" }).click();
  await expect(page.getByRole("status")).toContainText("Synchronized");
  await page.getByRole("button", { name: "ƒ withdraw(uint256)" }).click();
  await expect(page.locator(".react-flow__node")).not.toHaveCount(0);
  const source = await page.getByLabel("Solidity source editor").inputValue();
  await page.getByLabel("Solidity source editor").fill(source + " invalid");
  await expect(page.getByRole("status")).toContainText("last valid revision");
  await expect(page.getByLabel("Compiler diagnostics")).toContainText("ParserError");
  await expect(page.locator(".react-flow__node")).not.toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check / require Logic" })).toBeDisabled();
  await page.getByLabel("Solidity source editor").fill(source);
  await expect(page.getByRole("status")).toContainText("Synchronized");
  await expect(page.getByRole("button", { name: "Check / require Logic" })).toBeEnabled();
  await page.screenshot({ path: "test-results/studio-vault.png", fullPage: true });
});

test("wires a typed parameter into a statement and rejects incompatible input", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Paste Solidity").fill('// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Test { uint256 public value; function set(uint256 amount, bool flag) external { value = 0; } }');
  await page.getByRole("button", { name: "Convert to nodes" }).click();
  await expect(page.getByRole("status")).toContainText("Synchronized");
  await page.getByRole("button", { name: "ƒ set(uint256,bool)" }).click();
  // Fit all nodes so both the parameter and assignment handles are reachable.
  await page.getByRole("button", { name: "fit view" }).click();
  const assignment = page.locator('.react-flow__node').filter({ has: page.locator('.blueprint-node__heading', { hasText: "Assignment" }) });
  const amount = page.locator('.react-flow__node').filter({ has: page.locator('.blueprint-node__heading', { hasText: "Parameter" }) }).filter({ hasText: "amount" });
  const flag = page.locator('.react-flow__node').filter({ has: page.locator('.blueprint-node__heading', { hasText: "Parameter" }) }).filter({ hasText: "flag" });
  await amount.locator('[data-handleid="value-out"]').dragTo(assignment.locator('[data-handleid="in:rightHandSide"]'));
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/value = amount;/);
  await flag.locator('[data-handleid="value-out"]').dragTo(assignment.locator('[data-handleid="in:rightHandSide"]'));
  await expect(page.getByRole("alert")).toContainText("does not compile");
  await expect(page.getByLabel("Solidity source editor")).toHaveValue(/value = amount;/);
  await expect(page.getByLabel("Solidity source editor")).toBeDisabled();
  await expect(page.locator(".react-flow__edge").filter({ hasText: "pending connection" })).toHaveCount(1);
  await page.getByRole("button", { name: "Cancel draft" }).click();
  await expect(page.getByLabel("Solidity source editor")).toBeEnabled();
});

test("validates local compiler requests and edit operations", async ({ request }) => {
  const source = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Test {}';
  const foreign = await request.post('/api/studio/analyze', { headers: { origin: 'https://example.com' }, data: { revision: 1, sources: { 'Test.sol': source } } });
  expect(foreign.status()).toBe(403);
  const traversal = await request.post('/api/studio/analyze', { data: { revision: 1, sources: { '../Test.sol': source } } });
  expect(traversal.status()).toBe(400);
  const invalid = await request.post('/api/studio/generate', { data: { revision: 1, sources: { 'Test.sol': source }, edit: { kind: 'delete', nodeId: 'missing' } } });
  expect(invalid.status()).toBe(400);
  const valid = await request.post('/api/studio/analyze', { data: { revision: 42, sources: { 'Test.sol': source } } });
  expect(valid.status()).toBe(200);
  expect((await valid.json()).revision).toBe(42);
});

test("ignores superseded compiler responses", async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a vault' }).click();
  await expect(page.getByRole('status')).toContainText('Synchronized');
  const source = await page.getByLabel('Solidity source editor').inputValue();
  await page.route('**/api/studio/analyze', async route => {
    const response = await route.fetch();
    if (route.request().postData()?.includes('Older')) await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fulfill({ response });
  });
  await page.getByLabel('Solidity source editor').fill(source.replace('contract Vault', 'contract Older'));
  await page.waitForRequest(r => r.url().endsWith('/api/studio/analyze') && !!r.postData()?.includes('Older'));
  await page.getByLabel('Solidity source editor').fill(source.replace('contract Vault', 'contract Newer'));
  await expect(page.getByRole('button', { name: '◇ Newer' })).toBeVisible();
  await page.waitForTimeout(1400);
  await expect(page.getByRole('button', { name: '◇ Older' })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Synchronized');
});

test("Coin opens connected execution and shows relationships in the contract overview", async ({ page }) => {
  const errors: string[] = [];
  page.on('console', message => { if (/couldn't create edge/i.test(message.text())) errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  const source = await readFile(new URL('../../../../packages/cli/test/fixtures/studio/Coin.sol', import.meta.url), 'utf8');
  await page.goto('/');
  await page.getByLabel('Paste Solidity').fill(source);
  await page.getByRole('button', { name: 'Convert to nodes' }).click();
  await expect(page.getByRole('status')).toContainText('Synchronized');
  await expect(page.locator('.studio-canvas-toolbar')).toContainText('mint(address,uint256)');
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Function completes' }).locator('[data-handleid="exec-in"]')).toHaveCount(1);
  await page.locator('.studio-canvas-toolbar').getByRole('button', { name: 'Coin', exact: true }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(6);
  await expect(page.locator('.react-flow__edge').filter({ hasText: 'emits' })).toHaveCount(1);
  await expect(page.locator('.react-flow__edge').filter({ hasText: 'error type' })).toHaveCount(1);
  await page.screenshot({ path: 'test-results/coin-overview.png', fullPage: true });
  await page.locator('.react-flow__node').filter({ hasText: 'send(address,uint256)' }).click();
  await expect(page.locator('.studio-canvas-toolbar')).toContainText('send(address,uint256)');
  await expect(page.locator('.react-flow__edge')).toHaveCount(6);
  await page.getByLabel('All values', { exact: true }).check();
  await expect.poll(() => page.locator('.react-flow__edge').count()).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test("runs Coin from entry-node inputs, replays connected traces and prints console results", async ({ page }) => {
  const source = await readFile(new URL('../../../../packages/cli/test/fixtures/studio/Coin.sol', import.meta.url), 'utf8');
  await page.goto('/');
  await page.getByLabel('Paste Solidity').fill(source);
  await page.getByRole('button', { name: 'Convert to nodes' }).click();
  await expect(page.locator('.studio-canvas-toolbar')).toContainText('mint(address,uint256)');
  await page.getByLabel('Run amount', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Run function', exact: true }).click();
  const consolePanel = page.getByLabel('Execution console');
  await expect(consolePanel).toContainText('Success · mint(address,uint256)');
  await expect(consolePanel).toContainText('0 → 100');
  await page.getByLabel('Replay speed').selectOption('600');
  await page.getByRole('button', { name: 'Finish replay' }).click();
  await page.getByRole('button', { name: 'Replay trace', exact: true }).click();
  await expect(page.locator('.runtime-edge')).toHaveCount(1);
  await expect(page.locator('.runtime-running')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pause replay' }).click();
  await expect(page.getByRole('button', { name: 'Replay trace', exact: true })).toBeVisible();
  // Advancing the trace must not move or zoom the camera.
  const viewport = page.locator('.react-flow__viewport');
  const camera = await viewport.getAttribute('style');
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await expect(viewport).toHaveAttribute('style', camera!);
  // Finish this recorded trace without sending another transaction.
  await page.getByRole('button', { name: 'Replay trace', exact: true }).click();
  await page.getByRole('button', { name: 'Finish replay' }).click();
  await expect(page.getByLabel('Solidity source editor')).toHaveValue(source);
  await page.getByRole('button', { name: 'ƒ send(address,uint256)' }).click();
  await page.getByLabel('Run receiver', { exact: true }).fill('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
  await page.getByLabel('Run amount', { exact: true }).fill('40');
  await page.getByLabel('Run caller').selectOption('1');
  await page.getByRole('button', { name: 'Run function', exact: true }).click();
  await expect(consolePanel).toContainText('Success · send(address,uint256)');
  await expect(consolePanel).toContainText('Event Sent');
  await expect(consolePanel).toContainText('100 → 60');
  await page.getByRole('button', { name: 'Finish replay' }).click();
  await page.getByRole('button', { name: 'Inputs', exact: true }).click();
  await page.getByLabel('Run amount', { exact: true }).fill('70');
  await page.getByRole('button', { name: 'Run function', exact: true }).click();
  await expect(consolePanel).toContainText('InsufficientBalance(70, 60)');
  await expect(consolePanel).toContainText('State changes were rolled back');
  await page.getByRole('button', { name: 'Finish replay' }).click();
  await expect(page.locator('.runtime-reverted')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/coin-runtime.png', fullPage: true });
  await page.getByRole('button', { name: 'Reset sandbox' }).click();
  await expect(consolePanel).toContainText('Next Run creates a fresh deployment');
  await expect(consolePanel.locator('.runtime-result')).toHaveCount(0);
});
