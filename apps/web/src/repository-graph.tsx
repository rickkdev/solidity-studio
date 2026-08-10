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
  const [selectedId, setSelectedId] = useState<string>();
  const visibleIds = useMemo(() => visibleNodeIds(graph, expanded), [graph, expanded]);
  const toggleExpanded = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const { nodes, edges } = useMemo(
    () => toFlowElements(graph, visibleIds, expanded, toggleExpanded, selectedId),
    [graph, visibleIds, expanded, selectedId],
  );
  const selectedNode = graph.nodes.find((node) => node.id === selectedId);
  return (
    <section className="graph-panel" aria-label={`Repository graph for ${graph.repository}`}>
      <div className="graph-meta">
        <div><span className="graph-meta__label">Repository</span><strong>{graph.repository}</strong></div>
        <div className="graph-counts"><span>{nodes.length} nodes</span><span>{edges.length} relationships</span></div>
      </div>
      <div className={`graph-workspace${selectedNode ? " graph-workspace--inspecting" : ""}`}>
      <div className="graph-canvas" data-testid="graph-canvas">
        <ReactFlow nodes={nodes} edges={edges} onNodeClick={(_, node) => {
          setSelectedId(node.id);
        }} fitView fitViewOptions={{ padding: 0.18 }} minZoom={0.2} maxZoom={2.5} proOptions={{ hideAttribution: true }}>
          <Background color="#26322c" gap={22} size={1} variant={BackgroundVariant.Dots} />
          <MiniMap nodeColor={(node) => `var(--kind-${String(node.data.kind).replace("_", "-")})`} maskColor="rgba(8, 12, 10, .74)" />
          <Controls showInteractive={false} />
          <ViewportActions graph={graph} expanded={expanded} visibleIds={visibleIds} />
          <GraphLegend />
        </ReactFlow>
      </div>
      {selectedNode && <NodeInspector graph={graph} node={selectedNode} onClose={() => setSelectedId(undefined)} />}
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

function NodeInspector({ graph, node, onClose }: { readonly graph: Graph; readonly node: GraphNode; readonly onClose: () => void }) {
  const incoming = graph.edges.filter((edge) => edge.target === node.id);
  const outgoing = graph.edges.filter((edge) => edge.source === node.id);
  const nodesById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const location = node.source ? `${node.source.file}:${node.source.start.line}` : undefined;
  const sourceText = node.source ? sourceFor(graph, node.source.file) : undefined;
  const copyLocation = async () => {
    if (location) await navigator.clipboard.writeText(location);
  };
  return (
    <aside className="node-inspector" aria-label={`Details for ${node.label}`}>
      <header><div><small>{node.kind.replace("_", " ")}</small><h2>{node.label}</h2></div><button type="button" aria-label="Close details" onClick={onClose}>×</button></header>
      <dl className="node-facts"><div><dt>Status</dt><dd>{node.status}</dd></div>{Object.entries(node.metadata).map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{formatMetadata(value)}</dd></div>)}</dl>
      <RelationshipList title="Incoming" edges={incoming} endpoint="source" nodesById={nodesById} />
      <RelationshipList title="Outgoing" edges={outgoing} endpoint="target" nodesById={nodesById} />
      <section className="source-evidence">
        <h3>Source evidence</h3>
        {!node.source && <p>This node was generated without a source location.</p>}
        {node.source && <>
          <div className="source-location"><span>{node.source.file} · lines {node.source.start.line}–{node.source.end.line}</span><button type="button" onClick={() => void copyLocation()}>Copy location</button></div>
          {sourceText === undefined
            ? <p>Source content is unavailable for this file.</p>
            : <SourceExcerpt text={sourceText} node={node} />}
        </>}
      </section>
    </aside>
  );
}

function RelationshipList({ title, edges, endpoint, nodesById }: { readonly title: string; readonly edges: readonly Graph["edges"][number][]; readonly endpoint: "source" | "target"; readonly nodesById: ReadonlyMap<string, GraphNode> }) {
  return <section className="relationship-list"><h3>{title} <span>{edges.length}</span></h3>{edges.length === 0 ? <p>None</p> : <ul>{edges.map((edge) => <li key={edge.id}><span>{relationshipLabel[edge.kind]}</span>{nodesById.get(edge[endpoint])?.label ?? edge[endpoint]}</li>)}</ul>}</section>;
}

function SourceExcerpt({ text, node }: { readonly text: string; readonly node: GraphNode }) {
  const source = node.source!;
  const lines = text.split("\n");
  const firstLine = Math.max(1, source.start.line - 2);
  const lastLine = Math.min(lines.length, source.end.line + 2);
  return <pre className="source-code" aria-label={`Source excerpt for ${node.label}`}>{lines.slice(firstLine - 1, lastLine).map((line, index) => {
    const lineNumber = firstLine + index;
    const start = lineNumber === source.start.line ? source.start.column - 1 : 0;
    const end = lineNumber === source.end.line ? source.end.column - 1 : line.length;
    const highlighted = lineNumber >= source.start.line && lineNumber <= source.end.line;
    return <span className="source-line" key={lineNumber}><span className="source-line__number">{lineNumber}</span><code>{highlighted ? <>{line.slice(0, start)}<mark>{line.slice(start, Math.max(start, end)) || " "}</mark>{line.slice(end)}</> : line}{"\n"}</code></span>;
  })}</pre>;
}

function sourceFor(graph: Graph, file: string): string | undefined {
  const sources = graph.metadata.sources;
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) return undefined;
  const source = (sources as Readonly<Record<string, unknown>>)[file];
  return typeof source === "string" ? source : undefined;
}

function formatMetadata(value: GraphNode["metadata"][string]): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function toFlowElements(
  graph: Graph,
  visibleIds: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
  toggleExpanded: (id: string) => void,
  selectedId?: string,
): { nodes: Node[]; edges: Edge[] } {
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
      selected: node.id === selectedId,
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
    node.data = { ...node.data, label: <div className="node-label"><span>{kindGlyph[kind]}</span><div><small>{kind.replace("_", " ")}</small><strong>{node.data.label as string}</strong></div>{collapsible && <button type="button" className="node-toggle" aria-label={`${node.data.expanded ? "Collapse" : "Expand"} ${node.data.label as string}`} onClick={(event) => { event.stopPropagation(); toggleExpanded(node.id); }}>{node.data.expanded ? "−" : "+"}</button>}</div> };
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
