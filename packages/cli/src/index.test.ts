import { describe, expect, it } from "vitest";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serviceStatus } from "./index.js";

const fixtureRoot = fileURLToPath(
  new URL("../test/fixtures/solidity-project/", import.meta.url),
);

describe("serviceStatus", () => {
  it("reports that the service foundation is ready", () => {
    expect(serviceStatus()).toBe("Code Visualizer local service ready");
  });
});

describe("Solidity analysis fixture", () => {
  it("contains the expected documented Foundry project files", async () => {
    const expectedFiles = [
      "README.md",
      "foundry.toml",
      "src/INotifier.sol",
      "src/Owned.sol",
      "src/Vault.sol",
      "test/Vault.t.sol",
    ];

    await expect(
      Promise.all(expectedFiles.map((path) => access(`${fixtureRoot}${path}`))),
    ).resolves.toHaveLength(expectedFiles.length);

    const tests = await readFile(`${fixtureRoot}test/Vault.t.sol`, "utf8");
    expect(tests).toContain("function testOwnerIsDeployingTest()");
    expect(tests).toContain("function testIntentionalFailure()");
    expect(tests).toContain('require(false, "intentional fixture failure")');
  });
});
