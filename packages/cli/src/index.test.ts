import { describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeSolidityStructure,
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

describe("analyzeSolidityStructure", () => {
  it("extracts deterministic structural nodes and accurate source ranges from compiler ASTs", async () => {
    const first = await analyzeSolidityStructure(fixtureRoot);
    const second = await analyzeSolidityStructure(fixtureRoot);

    expect(second).toEqual(first);
    expect(first.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(first.files).toEqual([
      "src/INotifier.sol",
      "src/Owned.sol",
      "src/Vault.sol",
      "test/Vault.t.sol",
    ]);
    expect(
      Object.fromEntries(
        ["file", "contract", "function", "modifier", "event", "error", "state_variable"].map(
          (kind) => [kind, first.nodes.filter((node) => node.kind === kind).map((node) => node.label)],
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "contract": [
          "INotifier",
          "Owned",
          "Vault",
          "RecordingNotifier",
          "VaultTest",
        ],
        "error": [
          "Unauthorized",
          "InsufficientBalance",
          "TransferFailed",
        ],
        "event": [
          "Deposited",
          "Withdrawn",
        ],
        "file": [
          "INotifier.sol",
          "Owned.sol",
          "Vault.sol",
          "Vault.t.sol",
        ],
        "function": [
          "notify",
          "constructor",
          "constructor",
          "deposit",
          "balanceOf",
          "withdraw",
          "_debit",
          "notify",
          "setUp",
          "testOwnerIsDeployingTest",
          "testIntentionalFailure",
        ],
        "modifier": [
          "onlyOwner",
        ],
        "state_variable": [
          "owner",
          "balances",
          "notifier",
          "lastAccount",
          "lastAmount",
          "notifier",
          "vault",
        ],
      }
    `);

    const vault = first.nodes.find((node) => node.kind === "contract" && node.label === "Vault")!;
    expect(vault.metadata).toMatchObject({
      contractKind: "contract",
      abstract: false,
      inheritanceNames: ["Owned"],
    });
    const deposit = first.nodes.find((node) => node.kind === "function" && node.label === "deposit")!;
    expect(deposit.metadata).toMatchObject({ visibility: "external", mutability: "payable", payable: true });
    expect(deposit.source).toMatchObject({
      file: "src/Vault.sol",
      start: { line: 21, column: 5 },
      end: { line: 24, column: 6 },
    });
    const vaultSource = await readFile(`${fixtureRoot}src/Vault.sol`, "utf8");
    expect(Buffer.from(vaultSource).subarray(deposit.source!.start.offset, deposit.source!.end.offset).toString())
      .toContain("function deposit() external payable");
  });

  it("preserves compiler diagnostics with source locations", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "codevis-parser-"));
    try {
      await writeFile(path.join(project, "Broken.sol"), "pragma solidity ^0.8.24;\ncontract Broken { function nope( }\n");
      const analysis = await analyzeSolidityStructure(project);
      expect(analysis.nodes.filter(({ kind }) => kind === "file")).toHaveLength(1);
      expect(analysis.diagnostics[0]).toMatchObject({
        severity: "error",
        type: "ParserError",
        source: { file: "Broken.sol", start: { line: 2 } },
      });
      expect(analysis.diagnostics[0]?.message).toContain("ParserError");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
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
