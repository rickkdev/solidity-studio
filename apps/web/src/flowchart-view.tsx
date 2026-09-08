import { useMemo, useState } from "react";
import { Background, BackgroundVariant, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import type { FlowNode, FunctionFlowchart } from "@codevis/shared";
import "./flowchart.css";

const glyph: Record<FlowNode["kind"], string> = { start: "▶", process: "=", decision: "?", call: "ƒ", state_read: "R", state_write: "W", external_call: "↗", event: "E", return: "■", error: "!" };

export function FlowchartView({ flowchart, onEvidence }: { readonly flowchart: FunctionFlowchart; readonly onEvidence: (source: FlowNode["source"]) => void }) {
  const [showErrors, setShowErrors] = useState(true);
  const [selected, setSelected] = useState<string>();
  const elements = useMemo(() => flowElements(flowchart, showErrors, selected), [flowchart, showErrors, selected]);
  return <section className="program-flow" aria-label="Programming flowchart">
    <header><div><small>Compiler-derived</small><strong>Programming flowchart</strong></div><label><input type="checkbox" checked={showErrors} onChange={(event) => setShowErrors(event.target.checked)} /> Error paths</label></header>
    <div className="program-flow__canvas"><ReactFlow nodes={elements.nodes} edges={elements.edges} fitView fitViewOptions={{ padding: .22 }} minZoom={.35} maxZoom={1.8} onNodeClick={(_, node) => { setSelected(node.id); const source = flowchart.nodes.find(({ id }) => id === node.id)?.source; if (source) onEvidence(source); }} proOptions={{ hideAttribution: true }}>
      <Background color="#26372e" gap={20} size={1} variant={BackgroundVariant.Dots} /><Controls showInteractive={false} />
    </ReactFlow></div>
    <footer><span className="flow-key flow-key--decision">◆ decision</span><span className="flow-key flow-key--state">■ state</span><span className="flow-key flow-key--external">■ external call</span><span className="flow-key flow-key--error">■ failure</span></footer>
  </section>;
}

function flowElements(flowchart: FunctionFlowchart, showErrors: boolean, selected?: string): { nodes: Node[]; edges: Edge[] } {
  const hidden = new Set(showErrors ? [] : flowchart.nodes.filter(({ kind }) => kind === "error").map(({ id }) => id));
  const visible = flowchart.nodes.filter(({ id }) => !hidden.has(id));
  const depths = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  flowchart.edges.filter(({ source, target, kind }) => !hidden.has(source) && !hidden.has(target) && kind !== "loop").forEach((edge) => incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]));
  const depthFor = (id: string, seen = new Set<string>()): number => { if (seen.has(id)) return 0; const known = depths.get(id); if (known !== undefined) return known; const parents = incoming.get(id) ?? []; const depth = parents.length ? Math.max(...parents.map((parent) => depthFor(parent, new Set([...seen, id])))) + 1 : 0; depths.set(id, depth); return depth; };
  visible.forEach(({ id }) => depthFor(id));
  const rows = new Map<number, FlowNode[]>(); visible.forEach((node) => rows.set(depths.get(node.id) ?? 0, [...(rows.get(depths.get(node.id) ?? 0) ?? []), node]));
  const nodes: Node[] = [];
  for (const [depth, row] of [...rows].sort(([a], [b]) => a - b)) row.sort((a, b) => a.id.localeCompare(b.id)).forEach((node, index) => {
    const width = node.kind === "decision" ? 210 : 230; const total = row.length * 270;
    nodes.push({ id: node.id, position: { x: index * 270 - total / 2 + 400, y: depth * 145 }, selected: node.id === selected, className: `flow-node flow-node--${node.kind}`, style: { width }, data: { label: <div className="flow-node__content"><span>{glyph[node.kind]}</span><div><small>{node.kind.replaceAll("_", " ")}</small><strong>{node.label}</strong><em>lines {node.source.start.line}–{node.source.end.line}</em></div></div> } });
  });
  const connected = selected ? new Set(flowchart.edges.filter((edge) => edge.source === selected || edge.target === selected).map(({ id }) => id)) : undefined;
  const edges: Edge[] = flowchart.edges.filter(({ source, target }) => !hidden.has(source) && !hidden.has(target)).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, label: edge.kind === "next" ? undefined : edge.kind, markerEnd: { type: MarkerType.ArrowClosed }, className: `flow-edge flow-edge--${edge.kind}${connected && !connected.has(edge.id) ? " flow-edge--dim" : ""}`, animated: edge.kind === "loop" }));
  return { nodes, edges };
}
