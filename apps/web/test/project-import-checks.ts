import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const folder = new URL('../../../packages/cli/test/fixtures/studio/project/', import.meta.url);

test('imports a Solidity folder with remappings, navigates files and restores the workspace', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Import project / GitHub' }).click();
  await page.getByLabel('Solidity project folder').setInputFiles(fileURLToPath(folder));
  await expect(page.getByText('2 Solidity files found', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Project import remappings')).toHaveValue('@math/=lib/math/');
  await page.getByRole('button', { name: 'Import selected Solidity files' }).click();
  await expect(page.getByRole('status')).toContainText('Synchronized');
  await expect(page.getByLabel('Compiler diagnostics')).toContainText('0 errors');
  await page.getByRole('button', { name: 'ƒ sum(uint256)' }).click();
  await expect(page.getByLabel('Solidity source editor')).toHaveValue(/import \{Math\} from "@math\/Math.sol"/);
  if (await page.locator('.studio-public-notice').count()) await expect(page.getByRole('button', { name: 'Run selected function' })).toBeDisabled();
  else {
    await page.getByLabel('Run amount', { exact: true }).fill('4');
    await page.getByRole('button', { name: 'Run function', exact: true }).click();
    await expect(page.getByLabel('Execution console')).toContainText('Return: ["5"]');
  }
  await page.reload();
  await page.getByRole('button', { name: /Resume saved workspace/ }).click();
  await expect(page.getByRole('status')).toContainText('Synchronized');
  await expect(page.getByLabel('Compiler diagnostics')).toContainText('0 errors');
  await page.locator('.studio-project-files summary').click();
  await page.getByRole('button', { name: 'lib/math/Math.sol', exact: true }).click();
  await expect(page.getByLabel('Solidity source editor')).toHaveValue(/library Math/);
});

test('discovers Solidity in a GitHub repository and imports pinned source files', async ({ page }) => {
  const sha = 'a'.repeat(40); const tree = 'b'.repeat(40);
  const sources = Object.fromEntries(await Promise.all(['src/Counter.sol', 'lib/math/Math.sol', 'remappings.txt'].map(async path => [path, await readFile(new URL(path, folder), 'utf8')])));
  await page.route('https://api.github.com/repos/demo/project**', async route => {
    const url = route.request().url();
    await route.fulfill({ json: url.includes('/git/trees/') ? { truncated: false, tree: Object.entries(sources).map(([path, text]) => ({ path, size: Buffer.byteLength(text), type: 'blob', mode: '100644' })).concat([{ path: 'README.md', size: 15, type: 'blob', mode: '100644' }]) } : url.includes('/commits/') ? { sha, commit: { tree: { sha: tree } } } : { default_branch: 'main' } });
  });
  await page.route(`https://raw.githubusercontent.com/demo/project/${sha}/**`, route => route.fulfill({ body: sources[new URL(route.request().url()).pathname.split('/').slice(4).join('/')]!, contentType: 'text/plain' }));
  await page.goto('./');
  await page.getByRole('button', { name: 'Import project / GitHub' }).click();
  await page.getByLabel('GitHub repository URL').fill('https://github.com/demo/project');
  await page.getByRole('button', { name: 'Find Solidity files' }).click();
  await expect(page.getByText('2 Solidity files found', { exact: true })).toBeVisible();
  await expect(page.locator('.project-files')).toContainText('lib/math/Math.sol');
  await expect(page.locator('.project-files')).not.toContainText('README.md');
  await page.getByRole('button', { name: 'Import selected Solidity files' }).click();
  await expect(page.getByRole('status')).toContainText('Synchronized');
  await expect(page.getByLabel('Compiler diagnostics')).toContainText('0 errors');
  await page.getByRole('button', { name: 'ƒ sum(uint256)' }).click();
  await expect(page.getByLabel('Solidity source editor')).toHaveValue(sources['src/Counter.sol']!);
});
