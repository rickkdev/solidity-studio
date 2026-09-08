import { ProjectImportDialog } from "./studio-project-dialog";
import { MAX_PROJECT_BYTES, MAX_PROJECT_FILES, type ImportedProject } from "./studio-project-import";
import { compileInBrowser } from "./studio-browser-compiler";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Connection, type Node, type NodeProps, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import { parseStudioWorkspace, STUDIO_BLANK, STUDIO_VAULT, STUDIO_TOKEN_FACTORY, type StudioEdit, type StudioNode, type StudioProgram, type StudioResult, type StudioWorkspace, type StudioDraft } from "@codevis/shared";
import { useStudioRuntime } from "./studio-runtime";
import { nodeTemplates } from "./studio-templates";
import "./studio.css";

type Positions = StudioWorkspace["positions"];
type Snapshot = { remappings?: string[]; sources: Record<string, string>; positions: Positions };
const STORAGE = "codevis-studio-v1";
const PALETTE = [
  { group: "Contract", name: "Function", text: "function newFunction(uint256 amount) external {\n    }" },
  { group: "Contract", name: "State variable", text: "uint256 public value;" },
  { group: "Contract", name: "Mapping", text: "mapping(address => uint256) public balances;" },
  { group: "Contract", name: "Event", text: "event Updated(uint256 value);" },
  { group: "Contract", name: "Constructor", text: "constructor() {\n    }" },
  { group: "Contract", name: "Receive ETH", text: "receive() external payable {\n    }" },
  { group: "Contract", name: "Fallback", text: "fallback() external payable {\n    }" },
  { group: "Logic", name: "Check / require", text: 'require(true, "Check failed");' },
  { group: "Logic", name: "If / else", text: "if (true) {\n        } else {\n        }" },
  { group: "Logic", name: "For loop", text: "for (uint256 i = 0; i < 10; i++) {\n        }" },
  { group: "Logic", name: "While loop", text: "while (false) {\n        }" },
  { group: "Logic", name: "Do / while", text: "do {\n        } while (false);" },
  { group: "Logic", name: "Break", text: "break;" },
  { group: "Logic", name: "Continue", text: "continue;" },
  { group: "Values", name: "Local value", text: "uint256 localValue = 0;" },
  { group: "Values", name: "Assign / write", text: "value = 0;" },
  { group: "Calls", name: "Function call", text: "newFunction(0);" },
  { group: "Calls", name: "External call", text: '(bool success, bytes memory result) = address(msg.sender).call{value: 0}("");' },
  { group: "Calls", name: "Emit event", text: "emit Updated(0);" },
  { group: "Exit", name: "Return", text: "return;" },
  { group: "Exit", name: "Revert", text: 'revert("Stopped");' },
];

function BlueprintNode({ data, selected }: NodeProps<Node<{ node: StudioNode; overview?: boolean; runControls?: ReactNode }>>) {
  const node = data.node;
  const exec = !data.overview && (node.statement || node.execution || ["Entry", "Return", "join", "exit", "condition", "revert"].includes(node.kind));
  return <div className={`blueprint-node ${exec ? "blueprint-node--exec" : "blueprint-node--value"} ${node.opaque ? "blueprint-node--opaque" : ""} ${selected ? "is-selected" : ""}`}>
    <div className="blueprint-node__heading"><span>{exec ? "◆" : "●"} {data.overview && node.kind === "Entry" ? "Function" : node.kind}</span>{node.opaque && <b>Preserved</b>}</div>
    <strong>{node.label}</strong>
    {data.overview && <><Handle type="target" position={Position.Left} id="reference-in" isConnectable={false} />{node.kind === "Entry" && <><Handle type="source" position={Position.Right} id="reference-out" isConnectable={false} /><p className="studio-open-function">Open function →</p></>}</>}
    {exec && <div className="blueprint-node__exec"><Handle type="target" position={Position.Left} id="exec-in" /><span>execution</span>{!["Return", "Revert", "Break", "Continue", "revert"].includes(node.kind) && <Handle type="source" position={Position.Right} id="exec-out" />}</div>}
    {node.inputs.map(port => <div className="blueprint-node__port" key={port.id}><Handle type="target" position={Position.Left} id={`in:${port.id}`} /><span>{port.label}<code>{port.text}</code></span><small title={port.type}>{port.type}</small></div>)}
    {!data.overview && node.outputType && <div className="blueprint-node__port blueprint-node__port--output"><small>{node.outputType}</small><Handle type="source" position={Position.Right} id="value-out" isConnectable={node.reusable} /></div>}
    {node.effects.length > 0 && <p>{node.effects.join(" · ")}</p>}
    {data.runControls}
  </div>;
}
const nodeTypes = { blueprint: BlueprintNode };

export function Studio() {
  const [workspace, setWorkspace] = useState<Snapshot | null>(null);
  const [lastValid, setLastValid] = useState<StudioResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<StudioResult["diagnostics"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState("");
  const [contractId, setContractId] = useState("");
  const [functionId, setFunctionId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [showProjectImport, setShowProjectImport] = useState(false);
  const [paste, setPaste] = useState(STUDIO_TOKEN_FACTORY);
  const [query, setQuery] = useState("");
  const [showSource, setShowSource] = useState(true);
  const [showValues, setShowValues] = useState(false);
  const [draft, setDraft] = useState<StudioDraft | null>(null);
  const [regionId, setRegionId] = useState("");
  const [undo, setUndo] = useState<Snapshot[]>([]);
  const [redo, setRedo] = useState<Snapshot[]>([]);
  const [saved, setSaved] = useState<StudioWorkspace | null>(() => {
    try { const raw = localStorage.getItem(STORAGE); return raw ? parseStudioWorkspace(JSON.parse(raw)) : null; } catch { return null; }
  });
  const [saveStatus, setSaveStatus] = useState("Saved locally");
  const revision = useRef(0);
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace;
  const editor = useRef<HTMLTextAreaElement>(null);
  const flow = useRef<Pick<ReactFlowInstance<Node<{ node: StudioNode; overview?: boolean; runControls?: ReactNode }>>, "setCenter" | "getNode" | "fitView"> | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const skipAnalyze = useRef(false);
  const validRef = useRef(lastValid); validRef.current = lastValid;
  const program = lastValid?.program ?? null;
  const contract = program?.contracts.find(c => c.id === contractId) ?? program?.contracts[0];
  const fn = program?.functions.find(f => f.id === functionId);
  const selected = program?.nodes.find(n => n.id === selectedId);
  const stale = !!workspace && (!lastValid || !sameSources(workspace.sources, lastValid.sources));
  const runtime = useStudioRuntime({ sources: workspace?.sources ?? null, remappings: workspace?.remappings ?? [], program, contract, fn, disabled: busy || stale || !!draft, onStep: step => {
    const target = program?.nodes.find(n => n.id === step.nodeId);
    if (!target || target.contractId !== contract?.id) return;
    setFunctionId(step.functionId); setSelectedId(step.nodeId); setFile(step.source.file);
    setTimeout(() => editor.current?.setSelectionRange(step.source.start, step.source.end), 0);
  } });
  // Fit once per recorded transaction/function, never chase individual steps.
  useEffect(() => {
    if (!runtime.trace || !fn) return;
    const traceNodes = [...new Set(runtime.trace.steps.filter(step => step.functionId === fn.id).map(step => step.nodeId))];
    if (!traceNodes.length) return;
    const timer = setTimeout(() => { void flow.current?.fitView({ nodes: traceNodes.map(id => ({ id })), padding: .22, minZoom: .08, maxZoom: .85, duration: 450 }); }, 100);
    return () => clearTimeout(timer);
  }, [runtime.trace, fn?.id]);
  const locked = busy || stale || !!draft || runtime.busy || runtime.playing;

  const acceptResult = useCallback((result: StudioResult) => {
    setDiagnostics(result.diagnostics);
    if (result.program) {
      const oldProgram = validRef.current?.program;
      setRegionId(current => {
        if (result.program!.regions.some(r => r.id === current)) return current;
        const old = oldProgram?.regions.find(r => r.id === current);
        return old ? result.program!.regions.find(r => r.label === old.label && r.span.file === old.span.file && r.span.start === old.span.start)?.id ?? "" : "";
      });
      setLastValid(result);
      setContractId(current => result.program!.contracts.some(c => c.id === current) ? current : result.program!.contracts[0]?.id ?? "");
      setFunctionId(current => {
        if (result.program!.functions.some(f => f.id === current)) return current;
        if (oldProgram) return ""; // Respect an explicitly selected contract overview.
        const functions = result.program!.functions.filter(f => f.contractId === result.program!.contracts[0]?.id);
        return (functions.find(f => !/^(constructor|receive|fallback)\(/.test(f.name)) ?? functions[0])?.id ?? "";
      });
    }
  }, []);
  const request = useCallback(async (operation: string, sources: Record<string, string>, edit?: StudioEdit) => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const current = ++revision.current;
    setBusy(true); setError("");
    try {
      const remappings = workspaceRef.current?.remappings ?? [];
      if (import.meta.env.VITE_PUBLIC_DEMO === "true") {
        const result = await compileInBrowser(operation, { revision: current, sources, remappings, ...(edit ? { edit } : {}) }, controller.signal);
        return current === revision.current ? result : null;
      }
      const response = await fetch(`/api/studio/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: current, sources, remappings, ...(edit ? { edit } : {}) }), signal: controller.signal });
      const result = await response.json() as StudioResult & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The compiler service could not complete this edit.");
      if (current !== revision.current) return null;
      return result;
    } catch (e) { if (!controller.signal.aborted && current === revision.current) setError(e instanceof Error ? e.message : "Compiler unavailable. Start npm run dev or codevis studio."); return null; }
    finally { if (current === revision.current) setBusy(false); }
  }, []);
  useEffect(() => {
    if (!workspace) return;
    if (skipAnalyze.current) { skipAnalyze.current = false; return; }
    if (lastValid && sameSources(workspace.sources, lastValid.sources)) { setDiagnostics(lastValid.diagnostics); setError(""); }
    // Invalidate any older response immediately, before the debounce expires.
    revision.current++; abort.current?.abort(); setBusy(false);
    const timer = setTimeout(() => { void request("analyze", workspace.sources).then(result => { if (result) acceptResult(result); }); }, 400);
    return () => clearTimeout(timer);
  }, [workspace?.sources, request, acceptResult]);
  useEffect(() => {
    if (!workspace) return;
    try { const data: StudioWorkspace = { schemaVersion: 1, ...workspace, ...(draft ? { pendingEdit: draft } : {}) }; localStorage.setItem(STORAGE, JSON.stringify(data)); setSaved(data); setSaveStatus("Saved locally"); }
    catch { setSaveStatus("Local storage full — export workspace"); }
  }, [workspace, draft]);
  useEffect(() => () => { abort.current?.abort(); }, []);

  const commit = (next: Snapshot) => {
    if (workspaceRef.current) setUndo(history => [...history.slice(-99), workspaceRef.current!]);
    setRedo([]); setWorkspace(next);
  };
  function open(sources: Record<string, string>, positions: Positions = {}, pendingEdit?: StudioDraft, remappings: string[] = []) {
    revision.current++; abort.current?.abort(); setLastValid(null); setWorkspace({ sources, positions, remappings }); setFile(Object.keys(sources)[0] ?? "");
    setContractId(""); setFunctionId(""); setSelectedId(""); setUndo([]); setRedo([]); setDraft(pendingEdit ?? null); setError(""); setDiagnostics([]);
  }
  async function generate(edit: StudioEdit) {
    if (!workspace || stale) return;
    const result = await request("generate", workspace.sources, edit);
    if (!result) return;
    if (!result.program) { setDiagnostics(result.diagnostics); setError("This node edit does not compile. Fix the draft or cancel it; your accepted source is unchanged."); return; }
    const previousSelected = selected;
    skipAnalyze.current = true;
    commit({ ...workspace, sources: result.sources, positions: reconcilePositions(program, result.program, workspace.positions) });
    acceptResult(result); setDraft(null); setError("");
    if (previousSelected) setSelectedId(result.program.nodes.find(n => n.id === previousSelected.id)?.id ?? result.program.nodes.find(n => n.functionId === previousSelected.functionId && n.span.start === previousSelected.span.start && n.kind === previousSelected.kind)?.id ?? "");
  }
  function onConnect(connection: Connection) {
    if (locked || !connection.source || !connection.target) return;
    if (connection.sourceHandle === "exec-out" && connection.targetHandle === "exec-in") {
      const edit: StudioEdit = { kind: "connectExecution", sourceId: connection.source, targetId: connection.target };
      setDraft({ title: "Execution connection", edit, text: "" }); void generate(edit);
    } else if (connection.sourceHandle === "value-out" && connection.targetHandle?.startsWith("in:")) {
      const edit: StudioEdit = { kind: "connectValue", sourceId: connection.source, targetId: connection.target, portId: connection.targetHandle.slice(3) };
      setDraft({ title: "Value connection", edit, text: "" }); void generate(edit);
    } else setError("Connect execution to execution, or a typed value output to a value input.");
  }
  function selectNode(node: StudioNode) {
    setSelectedId(node.id); setFile(node.span.file);
    if (program?.regions.some(r => r.id === node.regionId && r.braced)) setRegionId(node.regionId);
    setTimeout(() => { editor.current?.setSelectionRange(node.span.start, node.span.end); if (editor.current) editor.current.scrollTop = Math.max(0, (workspace?.sources[node.span.file]?.slice(0, node.span.start).split("\n").length ?? 1) - 5) * 21; }, 0);
  }
  function focusInputs(id: string) {
    const entryId = `${id}/entry`; const position = workspace?.positions[entryId] ?? { x: 0, y: 0 };
    const height = flow.current?.getNode(entryId)?.measured?.height ?? 400;
    void flow.current?.setCenter(position.x + 140, position.y + height / 2, { zoom: .85, duration: 180 });
  }
  function navigateFunction(id: string) { setFunctionId(id); setSelectedId(""); setRegionId(program?.functions.find(f => f.id === id)?.bodyRegion ?? ""); }
  function importProject(project: ImportedProject, merge: boolean) {
    if (workspace && merge) {
      const conflicts = Object.keys(project.sources).filter(path => path in workspace.sources && workspace.sources[path] !== project.sources[path]);
      if (conflicts.length) throw new Error(`These paths already contain different source: ${conflicts.slice(0, 5).join(", ")}. Import as a new workspace or rename them.`);
      const sources = { ...workspace.sources, ...project.sources };
      if (Object.keys(sources).length > MAX_PROJECT_FILES || Object.values(sources).reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0) > MAX_PROJECT_BYTES) throw new Error("Combined workspace exceeds 100 files or 2 MB. Import as a new workspace.");
      const prefixes = new Map<string, string>();
      for (const mapping of [...(workspace.remappings ?? []), ...project.remappings]) {
        const [prefix, target] = mapping.split("=");
        if (prefixes.has(prefix!) && prefixes.get(prefix!) !== target) throw new Error(`Conflicting remapping for ${prefix}. Adjust the project remappings before adding it.`);
        prefixes.set(prefix!, target!);
      }
      // Open resets compiled state so remapping-only changes cannot reuse old analysis.
      open(sources, workspace.positions, undefined, [...new Set([...(workspace.remappings ?? []), ...project.remappings])]);
    } else open(project.sources, {}, undefined, project.remappings);
  }
  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    try {
      if (files.length === 1 && files[0]!.name.endsWith(".json")) { const restored = parseStudioWorkspace(JSON.parse(await files[0]!.text())); open(restored.sources, restored.positions, restored.pendingEdit, restored.remappings); }
      else {
        if (files.length > MAX_PROJECT_FILES || Array.from(files).reduce((sum, file) => sum + file.size, 0) > MAX_PROJECT_BYTES) throw new Error("Choose at most 100 Solidity files and 2 MB, or use Import project to select a subset.");
        const entries = await Promise.all(Array.from(files).map(async f => [f.webkitRelativePath || f.name, await f.text()] as const));
        if (entries.some(([name]) => !name.endsWith(".sol"))) throw new Error("Choose .sol files or a workspace JSON.");
        if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error("Duplicate file names. Import a folder or rename the files.");
        importProject({ sources: Object.fromEntries(entries), remappings: [] }, !!workspace);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not import files."); }
    if (importInput.current) importInput.current.value = "";
  }
  function travel(direction: "undo" | "redo") {
    const stack = direction === "undo" ? undo : redo; const snapshot = stack.at(-1); if (!snapshot || !workspace) return;
    setDraft(null); setError("");
    if (direction === "undo") { setUndo(stack.slice(0, -1)); setRedo(h => [...h, workspace]); } else { setRedo(stack.slice(0, -1)); setUndo(h => [...h, workspace]); }
    setWorkspace(snapshot);
  }
  function addPalette(item: typeof PALETTE[number]) {
    if (!contract || locked) return;
    if (item.group === "Contract") setDraft({ title: `Add ${item.name.toLowerCase()}`, edit: { kind: "declaration", contractId: contract.id, text: item.text }, text: item.text, ...(nodeTemplates[item.name] ? { template: item.name, fields: { ...nodeTemplates[item.name]!.fields } } : {}) });
    else if (fn) {
      const region = regionId || fn.bodyRegion;
      setDraft({ title: `Add ${item.name.toLowerCase()}`, edit: { kind: "insert", regionId: region, text: item.text, ...(selected?.statement && selected.regionId === region ? { afterId: selected.id } : {}) }, text: item.text, ...(nodeTemplates[item.name] ? { template: item.name, fields: { ...nodeTemplates[item.name]!.fields } } : {}) });
    } else setError("Open a function, or add one from the Contract palette, to insert logic.");
  }
  const revealed = new Set<string>();
  function revealInputs(id: string, depth = 0) { if (depth > 8 || revealed.has(id)) return; revealed.add(id); program?.edges.filter(e => e.kind === "value" && e.target === id).forEach(e => revealInputs(e.source, depth + 1)); }
  if (selectedId) revealInputs(selectedId);
  const visible = program?.nodes.filter(n => n.contractId === contract?.id && (fn ? n.functionId === fn.id : n.functionId === "" || n.kind === "Entry") && (showValues || revealed.has(n.id) || n.statement || n.execution || ["Entry", "Parameter", "Return", "join", "exit", "condition", "revert"].includes(n.kind) || !n.functionId)) ?? [];
  const autoPositions = fn ? layoutNodes(visible, program) : Object.fromEntries(visible.map(n => { const group = visible.filter(other => (other.kind === "Entry") === (n.kind === "Entry")); return [n.id, { x: n.kind === "Entry" ? 0 : 460, y: group.indexOf(n) * 230 }]; }));
  const nodes: Node<{ node: StudioNode; overview?: boolean; runControls?: ReactNode }>[] = visible.map(n => ({ id: n.id, type: "blueprint", data: { node: n, overview: !fn, ...(fn && n.id === `${fn.id}/entry` ? { runControls: runtime.controls } : {}) }, className: n.id === runtime.activeNodeId ? runtime.activeOutcome === "revert" ? "runtime-reverted" : "runtime-running" : "", position: workspace?.positions[fn ? n.id : `overview:${n.id}`] ?? autoPositions[n.id]!, selected: n.id === selectedId, draggable: true, connectable: !!fn && !locked }));
  const ids = new Set(visible.map(n => n.id));
  const connected = selectedId ? new Set(program?.edges.filter(e => e.source === selectedId || e.target === selectedId).map(e => e.id)) : null;
  const edges = (program?.edges ?? []).filter(e => ids.has(e.source) && ids.has(e.target) && (fn ? e.kind !== "reference" : e.kind === "reference")).map(e => ({ ...e, ...(e.id === runtime.activeEdgeId ? { className: `runtime-edge${runtime.playing ? "" : " runtime-edge--paused"}${runtime.activeOutcome === "revert" ? " runtime-edge--failed" : ""}` } : runtime.visitedEdgeIds.has(e.id) ? { className: "runtime-edge-visited" } : {}), sourceHandle: e.kind === "reference" ? "reference-out" : e.kind === "execution" ? "exec-out" : "value-out", targetHandle: e.kind === "reference" ? "reference-in" : e.kind === "execution" ? "exec-in" : `in:${e.targetPort}`, label: e.kind !== "value" ? e.label : undefined, style: { "--runtime-step-duration": `${runtime.speed}ms`, stroke: e.kind === "execution" ? "#dad6cd" : "#52c7ba", strokeWidth: e.kind === "execution" ? 2 : 1.3, opacity: runtime.visitedEdgeIds.has(e.id) ? 1 : connected && !connected.has(e.id) ? .2 : .8 }, markerEnd: { type: MarkerType.ArrowClosed, color: e.kind === "execution" ? "#dad6cd" : "#52c7ba" }, type: "smoothstep" }));
  if (draft?.edit.kind === "connectValue" || draft?.edit.kind === "connectExecution") {
    const edit = draft.edit; const value = edit.kind === "connectValue";
    if (ids.has(edit.sourceId) && ids.has(edit.targetId)) edges.push({ id: "pending-connection", source: edit.sourceId, target: edit.targetId, kind: value ? "value" : "execution", sourceHandle: value ? "value-out" : "exec-out", targetHandle: edit.kind === "connectValue" ? `in:${edit.portId}` : "exec-in", label: "pending connection", style: { "--runtime-step-duration": `${runtime.speed}ms`, stroke: "#f0aa85", strokeWidth: 3, opacity: 1 }, markerEnd: { type: MarkerType.ArrowClosed, color: "#f0aa85" }, type: "smoothstep" });
  }
  const onNodesChange = (changes: NodeChange[]) => {
    const updates: Positions = {};
    changes.forEach(c => { if (c.type === "position" && c.position) updates[fn ? c.id : `overview:${c.id}`] = c.position; });
    if (Object.keys(updates).length) setWorkspace(w => w ? { ...w, positions: { ...w.positions, ...updates } } : w);
  };
  const activeFile = workspace?.sources[file] !== undefined ? file : Object.keys(workspace?.sources ?? {})[0] ?? "";

  return <main className="studio-shell">
    <header className="studio-topbar"><button className="studio-brand" onClick={() => { if (!busy && !draft && !runtime.busy) { setWorkspace(null); setLastValid(null); setError(""); } }}><span>⌘</span><div>Solidity Studio<small>CODE ↔ CANVAS</small></div></button>
      {workspace ? <div className="studio-actions"><span className="studio-save">{saveStatus}</span><button disabled={!undo.length || busy || runtime.busy || runtime.playing} onClick={() => travel("undo")}>Undo</button><button disabled={!redo.length || busy || runtime.busy || runtime.playing} onClick={() => travel("redo")}>Redo</button><button onClick={() => setShowSource(s => !s)}>{showSource ? "Hide code" : "Show code"}</button><button onClick={() => download("workspace.codevis.json", JSON.stringify({ schemaVersion: 1, ...workspace, ...(draft ? { pendingEdit: draft } : {}) }, null, 2))}>Save workspace</button><button className="studio-primary" onClick={() => download(activeFile.split("/").at(-1) || "Contract.sol", workspace.sources[activeFile] ?? "")}>Export {stale ? "draft" : draft ? "accepted code" : "Solidity"}</button></div> : <span className="studio-save">Local compiler · no AI account needed</span>}
    </header>
    {showProjectImport && <ProjectImportDialog hasWorkspace={!!workspace} onClose={() => setShowProjectImport(false)} onImport={importProject} />}
    <input ref={importInput} type="file" multiple accept=".sol,.json" hidden aria-label="Import Solidity or workspace" onChange={e => void importFiles(e.target.files)} />
    {error && <div className="studio-error" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
    {import.meta.env.VITE_PUBLIC_DEMO === "true" && <p className="studio-public-notice">Public browser edition · Convert and edit Solidity here. To run functions and replay execution, <a href="https://github.com/rickkdev/solidity-studio#development">run Studio locally</a>.</p>}
    {!workspace ? <div className="studio-welcome"><div className="studio-welcome__intro"><span className="studio-kicker">A CONTRACT YOU CAN FOLLOW</span><h1>Think in nodes.<br /><em>Build in Solidity.</em></h1><p>Turn a contract into connected logic. Follow the values, change a condition, and take the code back with you.</p><div className="studio-start-actions"><button className="studio-primary" onClick={() => open({ "MyContract.sol": STUDIO_BLANK })}>＋ New contract</button><button onClick={() => importInput.current?.click()}>Import files</button><button onClick={() => setShowProjectImport(true)}>Import project / GitHub</button><button onClick={() => open({ "Vault.sol": STUDIO_VAULT })}>Explore a vault →</button></div>{saved && <button className="studio-resume" onClick={() => open(saved.sources, saved.positions, saved.pendingEdit, saved.remappings)}>Resume saved workspace <span>{Object.keys(saved.sources).join(", ")} →</span></button>}<div className="studio-preview" aria-hidden="true"><span>amount <small>uint256</small></span><i>→</i><span>Check balance <small>true / false</small></span><i>→</i><span>Send ETH <small>success</small></span></div></div><section className="studio-paste"><header><span>01 / START WITH CODE</span><h2>Paste your Solidity</h2><p>Try the token factory below, or replace it with your own Solidity. Choose minting, burning, and pausing when you create a token. This demo uses token IDs in one contract.</p><button onClick={() => setPaste(STUDIO_TOKEN_FACTORY)}>Load token factory example</button></header><textarea aria-label="Paste Solidity" spellCheck={false} value={paste} onChange={e => setPaste(e.target.value)} placeholder={'// Paste a complete contract here\npragma solidity ^0.8.20;\n\ncontract YourContract {\n    ...\n}'} /><button className="studio-primary" disabled={!paste.trim()} onClick={() => open({ "Contract.sol": paste.replace(/^\s*```(?:solidity)?\s*\n/, "").replace(/\n```\s*$/, "") })}>Convert to nodes →</button></section></div> : <>
      <div className="studio-status" role="status"><span className={stale ? "is-warning" : "is-valid"}>● {busy ? "Compiling…" : stale ? "Source draft · canvas shows last valid revision" : draft ? "Node draft · source editing paused" : "Synchronized"}</span><span>{lastValid ? `solc ${lastValid.compilerVersion.split("+")[0]}` : import.meta.env.VITE_PUBLIC_DEMO === "true" ? "Browser Solidity compiler" : "Local Solidity compiler"} · {runtime.busy ? "Executing locally" : runtime.playing ? "Recorded execution trace" : import.meta.env.VITE_PUBLIC_DEMO === "true" ? "Browser compilation" : "Code + local execution"}</span>{stale && !busy && <button onClick={() => void request("analyze", workspace.sources).then(r => { if (r) acceptResult(r); })}>Retry compiler</button>}</div>
      <div className={`studio-workspace ${showSource ? "" : "studio-workspace--wide"}`}>
        <aside className="studio-sidebar"><div className="studio-project-files"><button disabled={busy || runtime.busy || runtime.playing || !!draft} onClick={() => setShowProjectImport(true)}>Import project / GitHub</button><details><summary>Files · {Object.keys(workspace.sources).length}</summary>{Object.keys(workspace.sources).sort().map(path => <button key={path} className={activeFile === path ? "is-active" : ""} onClick={() => { setFile(path); setShowSource(true); const target = program?.contracts.find(c => c.span.file === path); if (target) { setContractId(target.id); navigateFunction(""); } }}>{path}</button>)}</details></div><div className="studio-section-heading">CONTRACTS <button aria-label="Import more files" onClick={() => importInput.current?.click()}>＋</button></div><nav aria-label="Contract navigation">{program?.contracts.map(c => <div key={c.id}><button className={contract?.id === c.id && !fn ? "is-active" : ""} onClick={() => { setContractId(c.id); navigateFunction(""); setFile(c.span.file); }}>◇ {c.name}</button>{program.functions.filter(f => f.contractId === c.id).map(f => <button className={`studio-function ${fn?.id === f.id ? "is-active" : ""}`} key={f.id} onClick={() => { setContractId(c.id); navigateFunction(f.id); setFile(f.span.file); }}>ƒ {f.name}</button>)}</div>)}</nav><div className="studio-section-heading">NODE PALETTE</div><input className="studio-search" aria-label="Search node palette" placeholder="Find a node…" value={query} onChange={e => setQuery(e.target.value)} /><div className="studio-palette">{PALETTE.filter(p => `${p.name} ${p.group}`.toLowerCase().includes(query.toLowerCase())).map(item => <button key={item.name} disabled={locked || !contract} onClick={() => addPalette(item)}><span>{item.name}</span><small>{item.group}</small></button>)}</div></aside>
        <section className="studio-canvas-section" aria-label="Visual Solidity workspace"><header className="studio-canvas-toolbar"><div><button onClick={() => navigateFunction("")}>{contract?.name ?? "Workspace"}</button>{fn && <><span>/</span><strong>{fn.name}</strong></>}</div><div>{fn && <button disabled={runtime.busy || runtime.playing} onClick={() => focusInputs(fn.id)}>Inputs</button>}{fn && <button className="runtime-toolbar-play" disabled={!runtime.canRun} onClick={() => void runtime.run()} title="Uses the inputs on the function entry node">▶ Run selected function</button>}<label><input type="checkbox" checked={showValues} onChange={e => setShowValues(e.target.checked)} /> All values</label><button disabled={!selectedId} onClick={() => { const n = nodes.find(n => n.id === selectedId); if (n) void flow.current?.setCenter(n.position.x + 140, n.position.y + 80, { zoom: .85, duration: 250 }); }}>Focus</button><button onClick={() => setWorkspace(w => w ? { ...w, positions: { ...w.positions, ...Object.fromEntries(Object.entries(autoPositions).map(([id, position]) => [fn ? id : `overview:${id}`, position])) } } : w)}>Auto-layout</button></div></header>
          {fn && (fn.modifiers.length > 0 || (contract && /\bis\b/.test(workspace.sources[contract.span.file]?.slice(contract.span.start, workspace.sources[contract.span.file]?.indexOf("{", contract.span.start)) ?? ""))) && <div className="studio-boundary">Inherited behavior and modifiers remain in source. {fn.modifiers.length > 0 && `Modifier boundary: ${fn.modifiers.join(" → ")}.`} This canvas shows the function body.</div>}
          {!fn && contract && <div className="studio-contract-intro"><strong>{contract.name}</strong><span>Select a function node to open its execution flow. These connections show the declarations it uses.</span></div>}
          <div className="studio-canvas"><ReactFlow key={fn?.id ?? contract?.id ?? "empty"} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={instance => { flow.current = instance; }} onNodesChange={onNodesChange} onConnect={onConnect} onNodeClick={(_, node) => { if (!fn && node.data.node.kind === "Entry") navigateFunction(node.data.node.functionId); else selectNode(node.data.node); }} nodesConnectable={!!fn && !locked} deleteKeyCode={null} fitView fitViewOptions={{ padding: .18, minZoom: fn ? .7 : .3, maxZoom: .9, nodes: !fn ? nodes : [...nodes.filter(n => n.data.node.statement || n.data.node.kind === "Entry" || !n.data.node.functionId).slice(0, 2), ...nodes.filter(n => n.data.node.kind === "Parameter").slice(0, 2)] }} minZoom={.08} maxZoom={1.8} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#34413f" /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={n => n.data.node && (n.data.node as StudioNode).statement ? "#929eab" : "#449d91"} /></ReactFlow>{!nodes.length && <div className="studio-canvas-empty">{stale ? "Fix the source diagnostics to build the canvas." : "Your contract starts here.\nAdd a state variable or function from the palette."}</div>}</div>
          <footer className="studio-canvas-footer">{fn ? <><span>◆ execution order</span><span className="studio-value-key">● typed values</span><span>Drag an output to an input to edit logic</span></> : <span className="studio-value-key">↗ State, event, error, and call relationships · open a function to edit execution</span>}</footer>
          {fn && <div className="studio-insert-region"><label>Insert into <select aria-label="Insertion region" value={regionId || fn.bodyRegion} onChange={e => setRegionId(e.target.value)}>{program?.regions.filter(r => r.id.startsWith(fn.id) && r.braced).map(r => <option value={r.id} key={r.id}>{r.label} · line {lineAt(workspace.sources[r.span.file] ?? "", r.span.start)}</option>)}</select></label><span>{selected?.statement && selected.regionId === (regionId || fn.bodyRegion) ? "After selected statement" : "At end of region"}</span></div>}
        </section>
        {showSource && <aside className="studio-source-panel"><header><strong>SOLIDITY</strong><select aria-label="Source file" value={activeFile} onChange={e => setFile(e.target.value)}>{Object.keys(workspace.sources).map(name => <option key={name}>{name}</option>)}</select></header><div className="studio-editor"><pre aria-hidden="true">{Array.from({ length: (workspace.sources[activeFile] ?? "").split("\n").length }, (_, i) => i + 1).join("\n")}</pre><textarea ref={editor} aria-label="Solidity source editor" spellCheck={false} disabled={!!draft || runtime.busy || runtime.playing} value={workspace.sources[activeFile] ?? ""} onChange={e => commit({ ...workspace, sources: { ...workspace.sources, [activeFile]: e.target.value } })} onSelect={e => { if (stale) return; const start = e.currentTarget.selectionStart; const end = e.currentTarget.selectionEnd; const match = program?.nodes.filter(n => n.span.file === activeFile && n.span.start <= start && n.span.end >= end && n.span.end > start).sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start))[0]; if (match) { setSelectedId(match.id); setContractId(match.contractId); if (match.functionId) setFunctionId(match.functionId); if (match.id !== selectedId) { const position = workspace.positions[match.id] ?? autoPositions[match.id]; if (position) void flow.current?.setCenter(position.x + 140, position.y + 100, { zoom: .85, duration: 200 }); } } }} onScroll={e => { const gutter = e.currentTarget.previousElementSibling; if (gutter) gutter.scrollTop = e.currentTarget.scrollTop; }} /></div><div className="studio-source-note">{selected ? `${selected.span.file}:${lineAt(workspace.sources[selected.span.file] ?? "", selected.span.start)} · ${selected.kind}` : "Select code to locate its node"}</div></aside>}
      </div>
      <div className="studio-bottom"><section className="studio-inspector" aria-label="Node inspector"><header><strong>{draft ? draft.title : selected ? `${selected.kind} · ${selected.label}` : "Node inspector"}</strong>{draft && <button onClick={() => { setDraft(null); setDiagnostics(lastValid?.diagnostics ?? []); setError(""); }}>Cancel draft</button>}</header>{draft ? <div className="studio-draft">{draft.template && nodeTemplates[draft.template] && draft.fields && <div className="studio-draft-fields">{Object.entries(draft.fields).map(([label, value]) => <label key={label}>{label}<input aria-label={`Node ${label}`} value={value} onChange={event => { const fields = { ...draft.fields, [label]: event.target.value }; setDraft({ ...draft, fields, text: nodeTemplates[draft.template!]!.render(fields) }); }} /></label>)}</div>}{draft.edit.kind === "connectValue" || draft.edit.kind === "connectExecution" ? <p>The highlighted connection is a draft. Apply to retry validation, or cancel to choose a different connection.</p> : <textarea aria-label="Node draft" value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} spellCheck={false} />}<button className="studio-primary" disabled={busy} onClick={() => { if (["replace", "insert", "declaration"].includes(draft.edit.kind)) void generate({ ...draft.edit, text: draft.text } as StudioEdit); else void generate(draft.edit); }}>Apply node edit</button><small>Solidity checks types and scope before accepting this change.</small></div> : selected ? <div className="studio-inspector-content"><div><p>{selected.effects.join(" · ") || "No additional effects detected for this node."}</p>{selected.opaque ? <p>Preserved exactly. Edit this construct in the source editor.</p> : <button disabled={locked || !selected.text} onClick={() => setDraft({ title: `Edit ${selected.kind.toLowerCase()}`, edit: { kind: "replace", nodeId: selected.id, text: selected.text }, text: selected.text })}>Edit {selected.statement ? "statement" : selected.kind === "Entry" ? "signature" : "value"}</button>}{(selected.statement || !selected.functionId) && !selected.opaque && <button disabled={locked} onClick={() => void generate({ kind: "delete", nodeId: selected.id })}>Delete node</button>}{selected.callTarget && program?.functions.filter(f => f.id === selected.callTarget).map(f => <button key={f.id} onClick={() => navigateFunction(f.id)}>Open {f.name} →</button>)}</div><div className="studio-input-list">{selected.inputs.map(input => <button disabled={locked || selected.opaque} key={input.id} onClick={() => { const text = workspace.sources[input.span.file]!.slice(input.span.start, input.span.end); setDraft({ title: `Edit ${input.label}`, edit: { kind: "replace", nodeId: selected.id, portId: input.id, text }, text }); }}><span>{input.label} <small>{input.type}</small></span><code>{workspace.sources[input.span.file]?.slice(input.span.start, input.span.end)}</code></button>)}</div></div> : <p className="studio-muted">Select a node to inspect its source, edit an input, or follow a call. Execution connections reorder statements within the same body.</p>}</section>{runtime.consolePanel}<section className="studio-diagnostics" aria-label="Compiler diagnostics"><header><strong>COMPILER</strong><span>{diagnostics.filter(d => d.severity === "error").length} errors · {diagnostics.filter(d => d.severity === "warning").length} warnings</span></header>{diagnostics.length ? diagnostics.map((d, i) => <button className={`diagnostic-${d.severity}`} key={i} onClick={() => { if (d.file) { setFile(d.file); setShowSource(true); setTimeout(() => { editor.current?.focus(); editor.current?.setSelectionRange(d.start ?? 0, d.end ?? d.start ?? 0); }, 0); } }}><strong>{d.severity}</strong><pre>{d.message}</pre></button>) : <p className="studio-muted">{busy ? "Checking Solidity…" : stale ? "Waiting for a valid program." : "Solidity compiled successfully. No diagnostics."}</p>}</section></div>
    </>}
  </main>;
}

function download(name: string, content: string) { const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function sameSources(a: Record<string, string>, b: Record<string, string>) { return JSON.stringify(a) === JSON.stringify(b); }
function lineAt(source: string, offset: number) { return source.slice(0, offset).split("\n").length; }
function layoutNodes(nodes: StudioNode[], program: StudioProgram | null): Positions {
  const positions: Positions = {}; const main = nodes.filter(n => n.statement || n.execution || ["Entry", "Return", "join", "exit", "condition", "revert"].includes(n.kind) || !n.functionId);
  let y = 0;
  main.forEach(n => { if (n.kind === "revert") { const parent = program?.edges.find(e => e.target === n.id && e.kind === "execution"); const p = parent && positions[parent.source]; if (p) { positions[n.id] = { x: p.x + 370, y: p.y + 50 }; return; } } const region = program?.regions.find(r => r.id === n.regionId); const depth = region ? Math.max(0, region.id.split("/").length - (program?.functions.find(f => f.id === n.functionId)?.bodyRegion.split("/").length ?? 0)) : 0; positions[n.id] = { x: Math.min(depth, 4) * 360, y }; y += n.kind === "Entry" ? Math.max(420, 250 + (program?.functions.find(f => f.id === n.functionId)?.callable?.inputs.length ?? 0) * 65) : 290; });
  let loose = 0; const slots = new Map<string, number>();
  const visit = (id: string, depth = 0): { root: string; depth: number } | null => { if (depth > 15) return null; if (positions[id]) return { root: id, depth }; const parent = program?.edges.find(e => e.kind === "value" && e.source === id); return parent ? visit(parent.target, depth + 1) : null; };
  nodes.filter(n => !positions[n.id]).forEach(n => { const parent = visit(n.id); const root = parent ? positions[parent.root] : undefined; const key = `${parent?.root ?? "loose"}/${parent?.depth ?? 1}`; const slot = slots.get(key) ?? 0; slots.set(key, slot + 1); positions[n.id] = root && parent ? { x: root.x - 350 * parent.depth, y: root.y + slot * 175 } : { x: -370, y: loose++ * 180 }; });
  return positions;
}
function reconcilePositions(before: StudioProgram | null, after: StudioProgram, positions: Positions): Positions {
  const result: Positions = {};
  for (const n of after.nodes) { const position = positions[`overview:${n.id}`]; if (position) result[`overview:${n.id}`] = position; }
  for (const n of after.nodes) { const previous = before?.nodes.find(old => old.id === n.id) ?? before?.nodes.find(old => old.functionId === n.functionId && old.kind === n.kind && old.span.start === n.span.start); const position = positions[n.id] ?? (previous ? positions[previous.id] : undefined); if (position) result[n.id] = position; }
  return result;
}
