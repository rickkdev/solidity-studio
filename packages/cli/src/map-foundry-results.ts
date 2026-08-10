import { createStableNodeId, parseGraph, type Graph, type GraphEdge, type GraphNode } from "@codevis/shared";
import type { FoundryTestRun } from "./run-foundry-tests.js";

/** Promotes Solidity test functions and connects their resolved calls to tested code. */
export function addFoundryTests(graph: Graph): Graph {
  const testIds = new Set(graph.nodes.filter(isTestFunction).map(({ id }) => id));
  const nodes = graph.nodes.map((node): GraphNode => testIds.has(node.id)
    ? { ...node, kind: "test", metadata: { ...node.metadata, evidence: "static", runtimeObserved: false } }
    : node);
  const existing = new Set(graph.edges.map(({ id }) => id));
  const testEdges: GraphEdge[] = graph.edges.flatMap((edge) => {
    if (edge.kind !== "calls" || !testIds.has(edge.source)) return [];
    const id = `tests:${edge.source}:${edge.target}`;
    if (existing.has(id)) return [];
    existing.add(id);
    return [{ id, kind: "tests", source: edge.source, target: edge.target, metadata: { evidence: "static", runtimeObserved: false } }];
  });
  return parseGraph({ ...graph, nodes, edges: [...graph.edges, ...testEdges] });
}

/** Applies a completed Foundry run to stable test nodes and attaches actionable failures. */
export function applyFoundryResults(graph: Graph, run: FoundryTestRun): Graph {
  const results = new Map(run.results.map((result) => [normalizeTestName(result.name), result]));
  const matched = new Set<string>();
  const nodes = graph.nodes.map((node): GraphNode => {
    if (node.kind !== "test") return node;
    const result = results.get(normalizeTestName(node.label));
    if (!result) return node;
    matched.add(normalizeTestName(result.name));
    return { ...node, status: result.status === "skipped" ? "warning" : result.status,
      metadata: { ...node.metadata, evidence: "runtime", runtimeObserved: true, durationMs: result.durationMs,
        result: result.status, ...(result.reason ? { failureMessage: result.reason } : {}) } };
  });
  for (const result of run.results) {
    if (matched.has(normalizeTestName(result.name))) continue;
    nodes.push({ id: createStableNodeId({ kind: "test", path: result.suite, symbol: result.name }), kind: "test",
      label: result.name, status: result.status === "skipped" ? "warning" : result.status,
      metadata: { suite: result.suite, evidence: "runtime", runtimeObserved: true, unresolvedTarget: true,
        durationMs: result.durationMs, result: result.status, ...(result.reason ? { failureMessage: result.reason } : {}) } });
  }
  for (const diagnostic of run.diagnostics) {
    const match = diagnostic.match(/([^:\n]+\.sol):(\d+)(?::\d+)?/);
    if (!match) continue;
    const line = Number(match[2]);
    const candidates = nodes.filter((node) => node.source && (node.source.file === match[1] || node.source.file.endsWith(`/${match[1]}`))
      && node.source.start.line <= line && node.source.end.line >= line);
    candidates.sort((a, b) => ((a.source!.end.offset - a.source!.start.offset) - (b.source!.end.offset - b.source!.start.offset)));
    const target = candidates[0];
    if (target) {
      const index = nodes.findIndex(({ id }) => id === target.id);
      nodes[index] = { ...target, status: "failed", metadata: { ...target.metadata, diagnostics: [...metadataStrings(target.metadata.diagnostics), diagnostic] } };
    }
  }
  const matchedNodeIds = new Set(nodes.filter((node) => node.kind === "test" && matched.has(normalizeTestName(node.label))).map(({ id }) => id));
  const edges = graph.edges.map((edge) => edge.kind === "tests" && matchedNodeIds.has(edge.source)
    ? { ...edge, metadata: { ...edge.metadata, evidence: "runtime", runtimeObserved: true } } : edge);
  return parseGraph({ ...graph, nodes, edges, metadata: { ...graph.metadata, foundryDiagnostics: run.diagnostics } });
}

export function setTestsActive(graph: Graph): Graph {
  return parseGraph({ ...graph, nodes: graph.nodes.map((node) => node.kind === "test"
    ? { ...node, status: "active", metadata: { ...node.metadata, runtimeObserved: true } } : node) });
}

function isTestFunction(node: GraphNode): boolean {
  return node.kind === "function" && /^test/i.test(node.label) && Boolean(node.source?.file.match(/(^|\/)test\//));
}

function normalizeTestName(name: string): string {
  return name.replace(/\(.*$/, "");
}

function metadataStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
