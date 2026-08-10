import { describe, expect, it } from "vitest";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeSolidityStructure,
  discoverSolidityFiles,
  parseFoundryJson,
  runFoundryTests,
  runCli,
  serviceStatus,
  startWatchServer,
  SolidityDiscoveryError,
} from "./index.js";
import { parseGraph } from "@codevis/shared";

const fixtureRoot = fileURLToPath(
  new URL("../test/fixtures/solidity-project/", import.meta.url),
);

describe("Foundry tests", () => {
  it("parses deterministic passing, failing, and skipped machine output", () => {
    const parsed = parseFoundryJson(JSON.stringify({
      "test/Example.t.sol:ExampleTest": {
        test_results: {
          "testPass()": { status: "Success", duration: "2ms 500µs", reason: null },
          "testFail()": { status: "Failure", duration: "1ms", reason: "expected failure" },
          "testSkip()": { status: "Skipped", duration: "0ns", reason: null },
        },
      },
    }));
    expect(parsed.results).toEqual([
      expect.objectContaining({ name: "testFail()", status: "failed", durationMs: 1, reason: "expected failure" }),
      expect.objectContaining({ name: "testPass()", status: "passed", durationMs: 2.5 }),
      expect.objectContaining({ name: "testSkip()", status: "skipped", durationMs: 0 }),
    ]);
  });

  it("runs and filters the fixture without a shell", async () => {
    const available = await runFoundryTests(fixtureRoot, "testOwnerIsDeployingTest");
    expect(available.exitCode).toBe(0);
    expect(available.results).toEqual([
      expect.objectContaining({ name: "testOwnerIsDeployingTest()", status: "passed" }),
    ]);

    const full = await runFoundryTests(fixtureRoot);
    expect(full.exitCode).not.toBe(0);
    expect(full.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "testIntentionalFailure()", status: "failed", reason: "intentional fixture failure" }),
      expect.objectContaining({ name: "testOwnerIsDeployingTest()", status: "passed" }),
    ]));
  });

  it("reports missing Foundry prerequisites and compiler failures", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "codevis-not-foundry-"));
    try {
      await expect(runFoundryTests(project)).rejects.toThrow(/no foundry\.toml/);
      await writeFile(path.join(project, "foundry.toml"), "[profile.default]\nsrc = 'src'\n");
      await mkdir(path.join(project, "src"));
      await writeFile(path.join(project, "src", "Broken.sol"), "contract Broken { function nope( }");
      const broken = await runFoundryTests(project);
      expect(broken.exitCode).not.toBe(0);
      expect(broken.results).toEqual([]);
      expect(broken.diagnostics.join("\n")).toMatch(/Compiler run failed|ParserError/);
      await expect(runFoundryTests(project, undefined, { forgeExecutable: path.join(project, "missing-forge") }))
        .rejects.toThrow(/forge executable is unavailable/);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("serviceStatus", () => {
  it("reports that the service foundation is ready", () => {
    expect(serviceStatus()).toBe("Code Visualizer local service ready");
  });
});

describe("codevis watch", () => {
  it("serves the visualizer and initial validated graph, then closes cleanly", async () => {
    const webRoot = await mkdtemp(path.join(tmpdir(), "codevis-web-"));
    await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>Code Visualizer</title>");
    const service = await startWatchServer(fixtureRoot, { port: 0, webRoot });
    try {
      expect(service.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(service.projectPath).toBe(path.resolve(fixtureRoot));

      const ui = await fetch(service.url);
      expect(ui.status).toBe(200);
      expect(await ui.text()).toContain("Code Visualizer");

      const graphResponse = await fetch(`${service.url}/api/graph`);
      expect(graphResponse.status).toBe(200);
      const graph = parseGraph(await graphResponse.json());
      expect(graph.nodes.some(({ label }) => label === "Vault")).toBe(true);
      expect(graph.metadata.sources).toBeTypeOf("object");
      expect(graph.metadata.workEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "plan_created" }),
        expect.objectContaining({ type: "work_completed" }),
      ]));

      const malformed = await fetch(`${service.url}/api/work-events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "noise" }) });
      expect(malformed.status).toBe(400);
      expect((await fetch(`${service.url}/api/graph`)).status).toBe(200);

      const external = { schemaVersion: 1, id: "agent-step", type: "step_started", timestamp: "2026-08-10T16:00:00.000Z", message: "Inspect Vault", targetIds: [graph.nodes.find(({ label }) => label === "Vault")!.id], metadata: { agent: "codex" } };
      const accepted = await fetch(`${service.url}/api/work-events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(external) });
      expect(accepted.status).toBe(202);
      const updated = parseGraph(await (await fetch(`${service.url}/api/graph`)).json());
      expect(updated.metadata.workEvents).toEqual(expect.arrayContaining([external]));
    } finally {
      await service.close();
      await rm(webRoot, { recursive: true, force: true });
    }
    await expect(fetch(service.url)).rejects.toThrow();
  });

  it("pushes ordered graph states for create, modify, delete, syntax error, and recovery", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "codevis-live-project-"));
    const webRoot = await mkdtemp(path.join(tmpdir(), "codevis-live-web-"));
    await cp(fixtureRoot, project, { recursive: true });
    await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>Code Visualizer</title>");
    const service = await startWatchServer(project, { port: 0, webRoot, debounceMs: 20 });
    const events = await fetch(`${service.url}/api/events`);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    try {
      const createdFile = path.join(project, "src", "Live.sol");
      await writeFile(createdFile, "contract Live { function ping() external {} }\n");
      await waitForGraph(service.url, (graph) => graph.nodes.some((node) => node.label === "Live" && node.status === "passed"));

      await writeFile(createdFile, "contract Live { function pong() external {} }\n");
      await waitForGraph(service.url, (graph) => graph.nodes.some((node) => node.label === "pong" && node.status === "passed"));

      await writeFile(createdFile, "contract Live { function broken( }\n");
      const failed = await waitForGraph(service.url, (graph) => graph.nodes.some((node) => node.source?.file === "src/Live.sol" && node.status === "failed"));
      expect(failed.metadata.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error" })]));

      await writeFile(createdFile, "contract Live { function recovered() external {} }\n");
      await waitForGraph(service.url, (graph) => graph.nodes.some((node) => node.label === "recovered" && node.status === "passed"));

      await rm(createdFile);
      await waitForGraph(service.url, (graph) => graph.nodes.some((node) => node.source?.file === "src/Live.sol" && node.status === "deleted"));
    } finally {
      await events.body?.cancel();
      await service.close();
      await rm(project, { recursive: true, force: true });
      await rm(webRoot, { recursive: true, force: true });
    }
  }, 20_000);
});

async function waitForGraph(url: string, predicate: (graph: ReturnType<typeof parseGraph>) => boolean): Promise<ReturnType<typeof parseGraph>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const graph = parseGraph(await (await fetch(`${url}/api/graph`)).json());
    if (predicate(graph)) return graph;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for live graph update.");
}

describe("codevis analyze", () => {
  function captureIo() {
    let stdout = "";
    let stderr = "";
    return {
      io: {
        stdout: { write: (chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; } },
        stderr: { write: (chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; } },
      },
      output: () => ({ stdout, stderr }),
    };
  }

  it("analyzes the fixture and keeps stdout machine-readable", async () => {
    const capture = captureIo();
    await expect(runCli(["analyze", fixtureRoot], capture.io)).resolves.toBe(0);
    const output = capture.output();
    const graph = parseGraph(JSON.parse(output.stdout));

    expect(graph.repository).toBe(path.resolve(fixtureRoot));
    expect(graph.nodes.some(({ label }) => label === "Vault")).toBe(true);
    expect(output.stderr).toContain("Analyzing Solidity project:");
    expect(output.stderr).toContain("Analysis complete:");
  });

  it("writes output files and documents command usage", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codevis-cli-"));
    try {
      const outputPath = path.join(directory, "graph.json");
      const capture = captureIo();
      expect(await runCli(["analyze", fixtureRoot, "--output", outputPath], capture.io)).toBe(0);
      expect(capture.output().stdout).toBe("");
      const outputGraph = JSON.parse(await readFile(outputPath, "utf8"));
      expect(() => parseGraph(outputGraph)).not.toThrow();

      const help = captureIo();
      expect(await runCli(["--help"], help.io)).toBe(0);
      expect(help.output().stdout).toContain("Usage: codevis <command> [path] [options]");
      expect(help.output().stdout).toContain("watch [path]");
      expect(help.output().stdout).toContain("test [filter]");
      expect(help.output().stdout).toContain("--output <file>");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs filtered Foundry tests as machine-readable JSON", async () => {
    const previous = process.cwd();
    process.chdir(fixtureRoot);
    try {
      const capture = captureIo();
      expect(await runCli(["test", "testOwnerIsDeployingTest"], capture.io)).toBe(0);
      expect(JSON.parse(capture.output().stdout).results).toEqual([
        expect.objectContaining({ name: "testOwnerIsDeployingTest()", status: "passed" }),
      ]);
      expect(capture.output().stderr).toContain("Foundry complete: 1 passed, 0 failed, 0 skipped.");
    } finally {
      process.chdir(previous);
    }
  });

  it("returns non-zero with actionable errors for invalid input and analysis failure", async () => {
    const missing = captureIo();
    expect(await runCli(["analyze", path.join(fixtureRoot, "missing")], missing.io)).toBe(1);
    expect(missing.output().stderr).toMatch(/codevis: Cannot access Solidity project directory/);

    const project = await mkdtemp(path.join(tmpdir(), "codevis-cli-broken-"));
    try {
      await writeFile(path.join(project, "Broken.sol"), "contract Broken { function nope( }");
      const broken = captureIo();
      expect(await runCli(["analyze", project], broken.io)).toBe(1);
      expect(broken.output().stdout).toBe("");
      expect(broken.output().stderr).toMatch(/Broken\.sol:1:\d+: error: ParserError/);
      expect(broken.output().stderr).toContain("Analysis failed with 1 compiler error.");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
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

    const nodeById = new Map(first.nodes.map((node) => [node.id, node]));
    const relationships = first.edges.map((edge) => ({
      kind: edge.kind,
      source: nodeById.get(edge.source)?.label,
      target: nodeById.get(edge.target)?.label,
    }));
    expect(relationships).toEqual(expect.arrayContaining([
      { kind: "contains", source: "solidity-project", target: "src" },
      { kind: "contains", source: "src", target: "Vault.sol" },
      { kind: "contains", source: "Vault.sol", target: "Vault" },
      { kind: "contains", source: "Vault", target: "deposit" },
      { kind: "imports", source: "Vault.sol", target: "INotifier.sol" },
      { kind: "imports", source: "Vault.sol", target: "Owned.sol" },
      { kind: "imports", source: "Vault.t.sol", target: "Vault.sol" },
      { kind: "inherits", source: "Vault", target: "Owned" },
      { kind: "inherits", source: "RecordingNotifier", target: "INotifier" },
    ]));
    expect(new Set(first.edges.map(({ id }) => id)).size).toBe(first.edges.length);
  });

  it("maps function calls, state access, modifiers, and value-sending behavior", async () => {
    const analysis = await analyzeSolidityStructure(fixtureRoot);
    const nodesById = new Map(analysis.nodes.map((node) => [node.id, node]));
    const relationships = analysis.edges.map((edge) => ({
      kind: edge.kind,
      source: nodesById.get(edge.source)?.label,
      target: nodesById.get(edge.target)?.label,
    }));

    expect(relationships).toEqual(expect.arrayContaining([
      { kind: "calls", source: "withdraw", target: "_debit" },
      { kind: "calls", source: "withdraw", target: "notify" },
      { kind: "calls", source: "_debit", target: "balanceOf" },
      { kind: "reads", source: "deposit", target: "balances" },
      { kind: "writes", source: "deposit", target: "balances" },
      { kind: "reads", source: "withdraw", target: "notifier" },
      { kind: "writes", source: "_debit", target: "balances" },
      { kind: "applies_modifier", source: "withdraw", target: "onlyOwner" },
    ]));

    const functions = analysis.nodes.filter(({ kind }) => kind === "function");
    expect(functions.find(({ label }) => label === "withdraw")?.metadata).toMatchObject({
      hasExternalCalls: true,
      sendsValue: true,
      unresolvedCalls: ["call"],
    });
    expect(functions.find(({ label }) => label === "deposit")?.metadata).toMatchObject({
      hasExternalCalls: false,
      sendsValue: false,
    });
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "info", message: expect.stringContaining("Unresolved external call 'call' in withdraw") }),
    ]));
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

  it("reports unresolved imports and inheritance without crashing", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "codevis-relationships-"));
    try {
      await writeFile(path.join(project, "MissingImport.sol"), 'import "./Absent.sol";\ncontract MissingImport {}\n');
      await writeFile(path.join(project, "MissingBase.sol"), "contract MissingBase is UnknownBase {}\n");
      const importAnalysis = await analyzeSolidityStructure(project);
      expect(importAnalysis.diagnostics.map(({ message }) => message).join("\n")).toContain("Absent.sol");
      const inheritanceAnalysis = await analyzeSolidityStructure(project, { ignoredPaths: ["MissingImport.sol"] });
      expect(inheritanceAnalysis.diagnostics.map(({ message }) => message).join("\n")).toContain("UnknownBase");
      expect(inheritanceAnalysis.edges.filter(({ kind }) => kind === "imports" || kind === "inherits")).toEqual([]);
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
