import { useEffect, useMemo, useState } from "react";
import { parseFunctionFlowchart, type CodeExplanation, type ExplanationCollection, type FunctionFlowchart, type Graph, type GraphNode } from "@codevis/shared";
import { RepositoryGraph } from "./repository-graph";
import { FlowchartView } from "./flowchart-view";

export function GuidedExplorer({ graph, explanations, liveDisconnected, onReconnect }: { readonly graph: Graph; readonly explanations: ExplanationCollection; readonly liveDisconnected?: boolean; readonly onReconnect?: () => void }) {
  const contracts = useMemo(() => graph.nodes.filter(({ kind }) => kind === "contract"), [graph]);
  const [selectedId, setSelectedId] = useState<string>(() => contracts[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"learn" | "graph">("learn");
  const selected = graph.nodes.find(({ id }) => id === selectedId) ?? contracts[0];
  const explanation = explanations.items.find(({ nodeId }) => nodeId === selected?.id);
  const visibleContracts = contracts.filter((node) => `${node.label} ${node.source?.file ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  if (view === "graph") return <div className="guided-shell"><ViewTabs view={view} onView={setView} /><RepositoryGraph graph={graph} {...(liveDisconnected === undefined ? {} : { liveDisconnected })} {...(onReconnect ? { onReconnect } : {})} /></div>;
  return <section className="guided-shell" aria-label={`Guided explorer for ${graph.repository}`}>
    <ViewTabs view={view} onView={setView} />
    {liveDisconnected && <div className="recovery-banner" role="alert">Live updates disconnected.<button type="button" onClick={onReconnect}>Reconnect</button></div>}
    <div className="guided-workspace">
      <nav className="symbol-nav" aria-label="Contracts and public functions">
        <header><small>Repository guide</small><strong>{graph.repository.split(/[\\/]/).at(-1)}</strong></header>
        <label><span>Find a contract</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search contracts…" /></label>
        <div className="explanation-progress"><span>{explanations.enabled ? "Codex explanations" : "Local evidence only"}</span><strong>{explanations.items.filter(({ status }) => status === "ready").length}/{explanations.items.length || contracts.length}</strong></div>
        <ul>{visibleContracts.map((contract) => <ContractItem key={contract.id} graph={graph} contract={contract} selectedId={selected?.id} explanations={explanations} onSelect={setSelectedId} />)}</ul>
      </nav>
      {selected ? <ExplanationWorkspace graph={graph} node={selected} explanation={explanation} enabled={explanations.enabled} onSelect={setSelectedId} /> : <div className="learning-empty">No contracts were discovered.</div>}
    </div>
  </section>;
}

function ViewTabs({ view, onView }: { readonly view: "learn" | "graph"; readonly onView: (view: "learn" | "graph") => void }) {
  return <div className="view-tabs" role="tablist"><button role="tab" aria-selected={view === "learn"} onClick={() => onView("learn")}>Guided explorer</button><button role="tab" aria-selected={view === "graph"} onClick={() => onView("graph")}>Full graph</button></div>;
}

function ContractItem({ graph, contract, selectedId, explanations, onSelect }: { readonly graph: Graph; readonly contract: GraphNode; readonly selectedId?: string | undefined; readonly explanations: ExplanationCollection; readonly onSelect: (id: string) => void }) {
  const functions = childrenOf(graph, contract.id).filter((node) => node.kind === "function");
  return <li><button className={selectedId === contract.id ? "selected" : ""} onClick={() => { onSelect(contract.id); prioritize(contract.id); }}><span><i className={`status-dot status-${statusFor(explanations, contract.id)}`} />{contract.label}</span><small>{String(contract.metadata.contractKind ?? "contract")}</small></button>
    {functions.length > 0 && <ul>{functions.map((fn) => <li key={fn.id}><button className={selectedId === fn.id ? "selected" : ""} onClick={() => { onSelect(fn.id); prioritize(fn.id); }}><span><i className={`status-dot status-${statusFor(explanations, fn.id)}`} />{fn.label}</span><small>{String(fn.metadata.visibility)}</small></button></li>)}</ul>}
  </li>;
}

function ExplanationWorkspace({ graph, node, explanation, enabled, onSelect }: { readonly graph: Graph; readonly node: GraphNode; readonly explanation?: CodeExplanation | undefined; readonly enabled: boolean; readonly onSelect: (id: string) => void }) {
  const [evidence, setEvidence] = useState<{ file: string; startLine: number; endLine: number }>();
  const [flowchart, setFlowchart] = useState<FunctionFlowchart>();
  useEffect(() => {
    setFlowchart(undefined);
    if (node.kind !== "function") return;
    const controller = new AbortController();
    void fetch(`/api/flows/${encodeURIComponent(node.id)}`, { signal: controller.signal }).then((response) => response.ok ? response.json() : Promise.reject(new Error("No flowchart"))).then((payload) => setFlowchart(parseFunctionFlowchart(payload))).catch(() => undefined);
    return () => controller.abort();
  }, [node.id, node.kind]);
  const relationshipEdges = graph.edges.filter((edge) => edge.source === node.id && edge.kind !== "contains");
  const source = sourceFor(graph, node.source?.file);
  const range = evidence?.file === node.source?.file ? evidence : node.source ? { file: node.source.file, startLine: node.source.start.line, endLine: node.source.end.line } : undefined;
  return <main className="learning-main">
    <header className="learning-header"><div><small>{node.kind.replace("_", " ")} · {node.source?.file}</small><h2>{node.label}</h2></div><ExplanationBadge explanation={explanation} enabled={enabled} nodeId={node.id} /></header>
    <div className="learning-columns"><article className="explanation-card">
      {explanation?.status === "ready" ? <>
        <p className="lede">{explanation.summary}</p>
        {flowchart ? <FlowchartView flowchart={flowchart} onEvidence={(source) => setEvidence({ file: source.file, startLine: source.start.line, endLine: source.end.line })} /> : <BehaviorDiagram explanation={explanation} onEvidence={setEvidence} />}
        <details className="explanation-details"><summary>Read the detailed explanation</summary><h3>What this does</h3><p>{explanation.purpose}</p>
        {(explanation.inputs?.length || explanation.outputs?.length) ? <div className="io-grid"><FactList title="Inputs" values={explanation.inputs} /><FactList title="Outputs" values={explanation.outputs} /></div> : null}
        <h3>How it works</h3><ol className="behavior-steps">{explanation.steps?.map((step, index) => <li key={`${step.title}-${index}`}><span>{index + 1}</span><div><strong>{step.title}</strong><p>{step.detail}</p>{step.evidence.map((item, evidenceIndex) => <button key={evidenceIndex} onClick={() => setEvidence(item)}>{item.file}:{item.startLine}</button>)}</div></li>)}</ol>
        <div className="fact-grid"><FactList title="State effects" values={explanation.stateEffects} /><FactList title="External interactions" values={explanation.externalInteractions} /><FactList title="Can stop when" values={explanation.reverts} /><FactList title="Concepts" values={explanation.concepts} /></div>
        </details>
      </> : <>{flowchart && <FlowchartView flowchart={flowchart} onEvidence={(source) => setEvidence({ file: source.file, startLine: source.start.line, endLine: source.end.line })} />}<Fallback node={node} explanation={explanation} enabled={enabled} graph={graph} /></>}
      <h3>Focused relationships</h3><div className="focused-flow"><div className="focus-symbol">{node.label}</div>{relationshipEdges.length ? relationshipEdges.map((edge) => { const target = graph.nodes.find(({ id }) => id === edge.target); return <button key={edge.id} onClick={() => target && onSelect(target.id)}><small>{edge.kind.replace("_", " ")}</small>{target?.label ?? edge.target}</button>; }) : <p>No direct behavioral relationships detected.</p>}</div>
    </article><aside className="evidence-panel"><header><strong>Source evidence</strong>{range && <span>lines {range.startLine}–{range.endLine}</span>}</header>{source && range ? <SourceView text={source} range={range} /> : <p>Source content is unavailable.</p>}</aside></div>
  </main>;
}

function BehaviorDiagram({ explanation, onEvidence }: { readonly explanation: CodeExplanation; readonly onEvidence: (evidence: { file: string; startLine: number; endLine: number }) => void }) {
  const inputs = explanation.inputs ?? [];
  const outputs = explanation.outputs ?? [];
  const effects = explanation.stateEffects ?? [];
  const external = explanation.externalInteractions ?? [];
  const reverts = explanation.reverts ?? [];
  return <section className="behavior-diagram" aria-label="Behavior overview">
    <header><div><small>Visual walkthrough</small><h3>Behavior overview</h3></div><span>{explanation.steps?.length ?? 0} steps</span></header>
    <div className="behavior-diagram__body">
      <DiagramLane label="Enters with" tone="input" values={inputs.length ? inputs : ["Function or contract entry"]} />
      <div className="diagram-arrow" aria-hidden="true">↓</div>
      <div className="diagram-steps">{explanation.steps?.map((step, index) => <div className="diagram-step" key={`${step.title}-${index}`}><span>{index + 1}</span><div><strong>{step.title}</strong><p>{step.detail}</p>{step.evidence[0] && <button onClick={() => onEvidence(step.evidence[0]!)}>View lines {step.evidence[0].startLine}–{step.evidence[0].endLine}</button>}</div>{index < (explanation.steps?.length ?? 0) - 1 && <i aria-hidden="true">↓</i>}</div>)}</div>
      <div className="diagram-arrow" aria-hidden="true">↓</div>
      <div className="diagram-outcomes">
        <DiagramLane label="Returns" tone="output" values={outputs.length ? outputs : ["No explicit return value"]} />
        {effects.length > 0 && <DiagramLane label="Changes state" tone="state" values={effects} />}
        {external.length > 0 && <DiagramLane label="Calls outside" tone="external" values={external} />}
        {reverts.length > 0 && <DiagramLane label="Stops when" tone="revert" values={reverts} />}
      </div>
    </div>
  </section>;
}

function DiagramLane({ label, tone, values }: { readonly label: string; readonly tone: string; readonly values: readonly string[] }) {
  return <div className={`diagram-lane diagram-lane--${tone}`}><small>{label}</small>{values.map((value, index) => <div key={index}>{value}</div>)}</div>;
}

function ExplanationBadge({ explanation, enabled, nodeId }: { readonly explanation?: CodeExplanation | undefined; readonly enabled: boolean; readonly nodeId: string }) {
  const status = explanation?.status ?? (enabled ? "queued" : "unavailable");
  return <div className={`explanation-badge status-${status}`}><i />{status === "ready" ? "Codex explanation" : status.replace("_", " ")}{status === "failed" && <button onClick={() => void fetch(`/api/explanations/${encodeURIComponent(nodeId)}/retry`, { method: "POST" })}>Retry</button>}</div>;
}

function Fallback({ node, explanation, enabled, graph }: { readonly node: GraphNode; readonly explanation?: CodeExplanation | undefined; readonly enabled: boolean; readonly graph: Graph }) {
  const edges = graph.edges.filter(({ source }) => source === node.id);
  return <div className="fallback-explanation"><h3>{enabled ? explanation?.status === "failed" ? "Explanation failed" : "Explanation is being prepared" : "Codex explanations are off"}</h3><p>{explanation?.error ?? (enabled ? "You can inspect verified source facts while Codex works in the background." : "Restart with --explain to add beginner-friendly Codex explanations. No source has been sent.")}</p><dl><div><dt>Visibility</dt><dd>{String(node.metadata.visibility ?? "—")}</dd></div><div><dt>Mutability</dt><dd>{String(node.metadata.mutability ?? "—")}</dd></div><div><dt>Known interactions</dt><dd>{edges.filter(({ kind }) => kind !== "contains").length}</dd></div></dl></div>;
}

function FactList({ title, values = [] }: { readonly title: string; readonly values?: readonly string[] | undefined }) { return <section><h4>{title}</h4>{values.length ? <ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>None identified.</p>}</section>; }
function SourceView({ text, range }: { readonly text: string; readonly range: { startLine: number; endLine: number } }) { const lines = text.split("\n"); const first = Math.max(1, range.startLine - 2); const last = Math.min(lines.length, range.endLine + 2); return <pre className="guided-source">{lines.slice(first - 1, last).map((line, index) => <span className={first + index >= range.startLine && first + index <= range.endLine ? "highlight" : ""} key={first + index}><i>{first + index}</i><code>{line || " "}</code></span>)}</pre>; }
function childrenOf(graph: Graph, id: string): GraphNode[] { return graph.edges.filter((edge) => edge.kind === "contains" && edge.source === id).map((edge) => graph.nodes.find((node) => node.id === edge.target)).filter((node): node is GraphNode => Boolean(node)); }
function sourceFor(graph: Graph, file?: string): string | undefined { const sources = graph.metadata.sources; return file && sources && typeof sources === "object" && !Array.isArray(sources) ? (sources as Record<string, unknown>)[file] as string | undefined : undefined; }
function statusFor(explanations: ExplanationCollection, id: string) { return explanations.items.find(({ nodeId }) => nodeId === id)?.status ?? (explanations.enabled ? "queued" : "unavailable"); }
function prioritize(id: string) { void Promise.resolve(fetch(`/api/explanations/${encodeURIComponent(id)}/prioritize`, { method: "POST" })).catch(() => undefined); }
