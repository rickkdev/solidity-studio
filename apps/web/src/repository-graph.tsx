import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import type { Graph, GraphEdgeKind, GraphNode, GraphNodeKind } from "@codevis/shared";

const kindGlyph: Record<GraphNodeKind, string> = {
  repository: "R", directory: "D", file: "F", contract: "C", function: "ƒ", modifier: "M",
  event: "E", error: "!", state_variable: "S", test: "T", task: "↗", command: ">", finding: "?",
};

const relationshipLabel: Record<GraphEdgeKind, string> = {
  contains: "contains", imports: "imports", inherits: "inherits", calls: "calls", reads: "reads",
  writes: "writes", applies_modifier: "modifier", tests: "tests", modifies: "modifies",
};

export function RepositoryGraph({ graph }: { readonly graph: Graph }) {
  const { nodes, edges } = useMemo(() => toFlowElements(graph), [graph]);
  return (
    <section className="graph-panel" aria-label={`Repository graph for ${graph.repository}`}>
      <div className="graph-meta">
        <div><span className="graph-meta__label">Repository</span><strong>{graph.repository}</strong></div>
        <div className="graph-counts"><span>{nodes.length} nodes</span><span>{edges.length} relationships</span></div>
      </div>
      <div className="graph-canvas" data-testid="graph-canvas">
        <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.18 }} minZoom={0.2} maxZoom={2.5} proOptions={{ hideAttribution: true }}>
          <Background color="#26322c" gap={22} size={1} variant={BackgroundVariant.Dots} />
          <MiniMap nodeColor={(node) => `var(--kind-${String(node.data.kind).replace("_", "-")})`} maskColor="rgba(8, 12, 10, .74)" />
          <Controls showInteractive={false} />
          <ViewportActions />
          <GraphLegend />
        </ReactFlow>
      </div>
    </section>
  );
}

function ViewportActions() {
  const flow = useReactFlow();
  return (
    <div className="viewport-actions" aria-label="Viewport actions">
      <button type="button" onClick={() => void flow.fitView({ padding: 0.18, duration: 250 })}>Fit graph</button>
      <button type="button" onClick={() => void flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 250 })}>Reset view</button>
    </div>
  );
}

function GraphLegend() {
  return (
    <aside className="graph-legend" aria-label="Graph legend">
      <strong>Relationship</strong>
      {(["contains", "imports", "inherits", "calls", "reads", "writes", "tests"] as GraphEdgeKind[]).map((kind) => (
        <span key={kind}><i className={`legend-line edge--${kind}`} />{relationshipLabel[kind]}</span>
      ))}
    </aside>
  );
}

function toFlowElements(graph: Graph): { nodes: Node[]; edges: Edge[] } {
  const depth = nodeDepths(graph);
  const columns = new Map<number, GraphNode[]>();
  for (const node of graph.nodes) {
    const level = depth.get(node.id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), node]);
  }
  const nodes: Node[] = [];
  for (const [level, columnNodes] of [...columns].sort(([a], [b]) => a - b)) {
    columnNodes.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    columnNodes.forEach((node, row) => nodes.push({
      id: node.id,
      position: { x: level * 285, y: row * 112 },
      data: { label: node.label, kind: node.kind },
      className: `code-node code-node--${node.kind}`,
      ariaLabel: `${node.kind.replace("_", " ")} ${node.label}`,
      style: { width: 210 },
    }));
  }
  const edges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target, label: relationshipLabel[edge.kind],
    className: `code-edge edge--${edge.kind}`, markerEnd: { type: MarkerType.ArrowClosed },
  }));
  nodes.forEach((node) => {
    const kind = node.data.kind as GraphNodeKind;
    node.data = { ...node.data, label: <div className="node-label"><span>{kindGlyph[kind]}</span><div><small>{kind.replace("_", " ")}</small><strong>{node.data.label as string}</strong></div></div> };
  });
  return { nodes, edges };
}

function nodeDepths(graph: Graph): Map<string, number> {
  const depths = new Map<string, number>();
  const contains = graph.edges.filter((edge) => edge.kind === "contains");
  const children = new Map<string, string[]>();
  const childIds = new Set<string>();
  contains.forEach((edge) => { children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]); childIds.add(edge.target); });
  const visit = (id: string, depth: number, seen: Set<string>) => {
    if (seen.has(id) || (depths.get(id) ?? -1) >= depth) return;
    depths.set(id, depth);
    for (const child of children.get(id) ?? []) visit(child, depth + 1, new Set([...seen, id]));
  };
  graph.nodes.filter((node) => !childIds.has(node.id)).forEach((node) => visit(node.id, 0, new Set()));
  return depths;
}
