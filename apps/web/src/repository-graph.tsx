import { useMemo, useState } from "react";
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => initialExpansion(graph));
  const visibleIds = useMemo(() => visibleNodeIds(graph, expanded), [graph, expanded]);
  const { nodes, edges } = useMemo(() => toFlowElements(graph, visibleIds, expanded), [graph, visibleIds, expanded]);
  const toggleExpanded = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <section className="graph-panel" aria-label={`Repository graph for ${graph.repository}`}>
      <div className="graph-meta">
        <div><span className="graph-meta__label">Repository</span><strong>{graph.repository}</strong></div>
        <div className="graph-counts"><span>{nodes.length} nodes</span><span>{edges.length} relationships</span></div>
      </div>
      <div className="graph-canvas" data-testid="graph-canvas">
        <ReactFlow nodes={nodes} edges={edges} onNodeClick={(_, node) => {
          if (node.data.collapsible) toggleExpanded(node.id);
        }} fitView fitViewOptions={{ padding: 0.18 }} minZoom={0.2} maxZoom={2.5} proOptions={{ hideAttribution: true }}>
          <Background color="#26322c" gap={22} size={1} variant={BackgroundVariant.Dots} />
          <MiniMap nodeColor={(node) => `var(--kind-${String(node.data.kind).replace("_", "-")})`} maskColor="rgba(8, 12, 10, .74)" />
          <Controls showInteractive={false} />
          <ViewportActions graph={graph} expanded={expanded} visibleIds={visibleIds} />
          <GraphLegend />
        </ReactFlow>
      </div>
    </section>
  );
}

function ViewportActions({ graph, expanded, visibleIds }: { readonly graph: Graph; readonly expanded: ReadonlySet<string>; readonly visibleIds: ReadonlySet<string> }) {
  const flow = useReactFlow();
  const expandedGroupIds = [...expanded].filter((id) => visibleIds.has(id));
  const selectionIds = expandedGroupIds.flatMap((id) => [id, ...descendantIds(graph, id).filter((childId) => visibleIds.has(childId))]);
  return (
    <div className="viewport-actions" aria-label="Viewport actions">
      <button type="button" onClick={() => void flow.fitView({ padding: 0.18, duration: 250 })}>Fit graph</button>
      <button type="button" disabled={selectionIds.length === 0} onClick={() => void flow.fitView({ nodes: selectionIds.map((id) => ({ id })), padding: 0.28, duration: 250 })}>Fit expanded</button>
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

function toFlowElements(graph: Graph, visibleIds: ReadonlySet<string>, expanded: ReadonlySet<string>): { nodes: Node[]; edges: Edge[] } {
  const depth = nodeDepths(graph);
  const columns = new Map<number, GraphNode[]>();
  for (const node of graph.nodes.filter((candidate) => visibleIds.has(candidate.id))) {
    const level = depth.get(node.id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), node]);
  }
  const nodes: Node[] = [];
  for (const [level, columnNodes] of [...columns].sort(([a], [b]) => a - b)) {
    columnNodes.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    columnNodes.forEach((node, row) => nodes.push({
      id: node.id,
      position: { x: level * 285, y: row * 112 },
      data: { label: node.label, kind: node.kind, collapsible: isCollapsible(graph, node.id), expanded: expanded.has(node.id) },
      className: `code-node code-node--${node.kind}`,
      ariaLabel: `${node.kind.replace("_", " ")} ${node.label}`,
      style: { width: 210 },
    }));
  }
  const edges: Edge[] = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target, label: relationshipLabel[edge.kind],
    className: `code-edge edge--${edge.kind}`, markerEnd: { type: MarkerType.ArrowClosed },
  }));
  nodes.forEach((node) => {
    const kind = node.data.kind as GraphNodeKind;
    const collapsible = Boolean(node.data.collapsible);
    node.data = { ...node.data, label: <div className="node-label"><span>{kindGlyph[kind]}</span><div><small>{kind.replace("_", " ")}</small><strong>{node.data.label as string}</strong></div>{collapsible && <button type="button" className="node-toggle" aria-label={`${node.data.expanded ? "Collapse" : "Expand"} ${node.data.label as string}`}>{node.data.expanded ? "−" : "+"}</button>}</div> };
  });
  return { nodes, edges };
}

function initialExpansion(graph: Graph): ReadonlySet<string> {
  return new Set(graph.nodes.filter((node) => node.kind === "file").map((node) => node.id));
}

function isCollapsible(graph: Graph, id: string): boolean {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  return Boolean(node && (node.kind === "file" || node.kind === "contract") && graph.edges.some((edge) => edge.kind === "contains" && edge.source === id));
}

function visibleNodeIds(graph: Graph, expanded: ReadonlySet<string>): ReadonlySet<string> {
  const parent = new Map(graph.edges.filter((edge) => edge.kind === "contains").map((edge) => [edge.target, edge.source]));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  return new Set(graph.nodes.filter((node) => {
    let ancestorId = parent.get(node.id);
    while (ancestorId) {
      const ancestor = nodeById.get(ancestorId);
      if (ancestor && (ancestor.kind === "file" || ancestor.kind === "contract") && !expanded.has(ancestorId)) return false;
      ancestorId = parent.get(ancestorId);
    }
    return true;
  }).map((node) => node.id));
}

function descendantIds(graph: Graph, id: string): string[] {
  const children = graph.edges.filter((edge) => edge.kind === "contains" && edge.source === id).map((edge) => edge.target);
  return children.flatMap((childId) => [childId, ...descendantIds(graph, childId)]);
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
