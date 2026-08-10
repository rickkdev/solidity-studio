import { describe, expect, it } from "vitest";
import {
  createEmptyGraph,
  createStableNodeId,
  GraphValidationError,
  parseGraph,
  parseWorkEvent,
  serializeGraph,
  type Graph,
} from "./index.js";

describe("work event model", () => {
  const event = { schemaVersion: 1, id: "event-1", type: "file_edit_completed", timestamp: "2026-08-10T16:00:00.000Z", message: "Updated Vault.sol", targetIds: ["file"], metadata: { path: "src/Vault.sol" } };

  it("validates every semantic event type", () => {
    const types = ["plan_created", "step_started", "file_read", "file_edit_started", "file_edit_completed", "command_started", "test_passed", "test_failed", "finding_created", "work_completed"];
    types.forEach((type) => expect(parseWorkEvent({ ...event, id: type, type })).toMatchObject({ type }));
  });

  it("rejects malformed events with actionable fields", () => {
    expect(() => parseWorkEvent({ ...event, type: "noise", timestamp: "later", targetIds: ["file", "file"] }))
      .toThrowError(/type must be one of:[\s\S]*timestamp must be a valid[\s\S]*duplicates id 'file'/);
  });
});

const validGraph: Graph = {
  schemaVersion: 1,
  repository: "fixture",
  metadata: { analyzer: "test", nested: { enabled: true }, tags: ["solidity"] },
  nodes: [
    {
      id: "repository:fixture::",
      kind: "repository",
      label: "fixture",
      status: "idle",
      metadata: {},
    },
    {
      id: "contract:src%2FVault.sol:Vault:12",
      kind: "contract",
      label: "Vault",
      status: "inspecting",
      source: {
        file: "src/Vault.sol",
        start: { offset: 12, line: 2, column: 1 },
        end: { offset: 100, line: 8, column: 2 },
      },
      metadata: { contractKind: "contract" },
    },
  ],
  edges: [
    {
      id: "contains:fixture-vault",
      kind: "contains",
      source: "repository:fixture::",
      target: "contract:src%2FVault.sol:Vault:12",
      metadata: {},
    },
  ],
};

describe("graph model", () => {
  it("accepts a valid graph", () => {
    expect(parseGraph(validGraph)).toBe(validGraph);
  });

  it("rejects edges with invalid references using actionable paths", () => {
    const graph = structuredClone(validGraph) as Graph;
    (graph.edges[0] as { target: string }).target = "missing";

    expect(() => parseGraph(graph)).toThrowError(
      "edges[0].target references missing node 'missing'",
    );
  });

  it("rejects duplicate node and edge IDs", () => {
    const graph = structuredClone(validGraph) as Graph;
    (graph.nodes as unknown[]).push(structuredClone(graph.nodes[0]));
    (graph.edges as unknown[]).push(structuredClone(graph.edges[0]));

    try {
      parseGraph(graph);
      throw new Error("expected graph validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphValidationError);
      expect((error as GraphValidationError).issues).toEqual(
        expect.arrayContaining([
          "nodes[2].id duplicates id 'repository:fixture::'",
          "edges[1].id duplicates id 'contains:fixture-vault'",
        ]),
      );
    }
  });

  it("round-trips through JSON serialization", () => {
    expect(parseGraph(JSON.parse(serializeGraph(validGraph)))).toEqual(validGraph);
  });

  it("rejects non-serializable metadata", () => {
    const graph = structuredClone(validGraph) as Graph;
    (graph.metadata as Record<string, unknown>).invalid = Number.NaN;
    expect(() => parseGraph(graph)).toThrowError("metadata must contain only finite");
  });
});

describe("stable IDs", () => {
  it("normalizes paths and remains deterministic", () => {
    const unix = createStableNodeId({
      kind: "function",
      path: "src/Vault.sol",
      symbol: "deposit(uint256)",
      startOffset: 42,
    });
    const windows = createStableNodeId({
      kind: "function",
      path: ".\\src\\Vault.sol",
      symbol: "deposit(uint256)",
      startOffset: 42,
    });
    expect(unix).toBe(windows);
    expect(unix).toBe("function:src%2FVault.sol:deposit(uint256):42");
  });
});

describe("createEmptyGraph", () => {
  it("keeps the workspace status helper compatible", () => {
    expect(createEmptyGraph("fixture")).toEqual({ name: "fixture", nodeCount: 0 });
  });
});
