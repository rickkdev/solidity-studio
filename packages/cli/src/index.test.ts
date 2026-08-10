import { describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverSolidityFiles,
  serviceStatus,
  SolidityDiscoveryError,
} from "./index.js";

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

describe("discoverSolidityFiles", () => {
  it("discovers fixture sources from absolute and relative project paths", async () => {
    const expected = [
      "src/INotifier.sol",
      "src/Owned.sol",
      "src/Vault.sol",
      "test/Vault.t.sol",
    ];

    await expect(discoverSolidityFiles(fixtureRoot)).resolves.toEqual(expected);

    const relativeFixture = path.relative(process.cwd(), fixtureRoot);
    await expect(discoverSolidityFiles(relativeFixture)).resolves.toEqual(expected);
  });

  it("uses default ignores and configurable ignored paths", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "codevis-discovery-"));

    try {
      const directories = [
        "src/nested",
        ".git",
        "node_modules/pkg",
        "out",
        "cache",
        "vendor/generated",
        "src/generated",
      ];
      await Promise.all(
        directories.map((directory) =>
          mkdir(path.join(project, directory), { recursive: true }),
        ),
      );
      await Promise.all([
        writeFile(path.join(project, "Root.sol"), "contract Root {}"),
        writeFile(path.join(project, "src/nested/Z.sol"), "contract Z {}"),
        writeFile(path.join(project, ".git/Hidden.sol"), "contract Hidden {}"),
        writeFile(path.join(project, "node_modules/pkg/Dependency.sol"), "contract Dependency {}"),
        writeFile(path.join(project, "out/Artifact.sol"), "contract Artifact {}"),
        writeFile(path.join(project, "cache/Cached.sol"), "contract Cached {}"),
        writeFile(path.join(project, "vendor/generated/Vendor.sol"), "contract Vendor {}"),
        writeFile(path.join(project, "src/generated/Generated.sol"), "contract Generated {}"),
      ]);

      await expect(
        discoverSolidityFiles(project, {
          ignoredPaths: ["vendor", "src/generated"],
        }),
      ).resolves.toEqual(["Root.sol", "src/nested/Z.sol"]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("reports actionable errors for invalid and empty projects", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "codevis-empty-"));
    const filePath = path.join(project, "README.md");
    await writeFile(filePath, "not a directory");

    try {
      await expect(discoverSolidityFiles(path.join(project, "missing"))).rejects.toThrow(
        /Cannot access Solidity project directory.*missing/,
      );
      await expect(discoverSolidityFiles(filePath)).rejects.toThrow(
        /project path is not a directory.*README\.md/,
      );
      await expect(discoverSolidityFiles(project)).rejects.toThrow(
        /No Solidity \(\.sol\) files found/,
      );
      await expect(
        discoverSolidityFiles(project, { ignoredPaths: ["../outside"] }),
      ).rejects.toBeInstanceOf(SolidityDiscoveryError);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
