import type { StudioBuild, StudioTraceStep } from "@codevis/shared";
export interface EvmLog { pc: number; op: string; depth: number; stack?: string[] }
export interface EvmTrace { failed: boolean; returnValue: string; gas: number | string; structLogs: EvmLog[] }

/** Source maps index instructions, not bytes: PUSH data must not increment the map index. */
export function instructionSources(bytecode: string, sourceMap: string) {
  const result = new Map<number, { start: number; length: number; file: number }>();
  let pc = 0; const previous = [0, 0, -1];
  for (const entry of sourceMap.split(";")) {
    const fields = entry.split(":");
    for (let i = 0; i < 3; i++) if (fields[i] !== undefined && fields[i] !== "") previous[i] = Number(fields[i]);
    result.set(pc, { start: previous[0]!, length: previous[1]!, file: previous[2]! });
    const opcode = Number.parseInt(bytecode.slice(pc * 2, pc * 2 + 2), 16);
    if (!Number.isFinite(opcode)) break;
    pc += opcode >= 0x60 && opcode <= 0x7f ? opcode - 0x5f + 1 : 1;
  }
  return result;
}

export function mapStudioTrace(build: StudioBuild, contractId: string, functionId: string, trace: EvmTrace, address: string, deployment = false) {
  const program = build.program!; const artifact = build.artifacts[contractId]!;
  const mappings = instructionSources(deployment ? artifact.bytecode : artifact.deployedBytecode, deployment ? artifact.sourceMap : artifact.deployedSourceMap);
  const candidates = program.nodes.filter(n => n.statement || n.execution);
  const cache = new Map<number, typeof candidates[number] | null>();
  const rootDepth = trace.structLogs[0]?.depth ?? 1;
  const frames = new Map<number, string>([[rootDepth, address.toLowerCase()]]);
  const steps: StudioTraceStep[] = []; let unmappedSteps = 0; let traceTruncated = false;
  const writes = new Map<string, string>();
  let previousLog: EvmLog | undefined;
  const nodeById = new Map(program.nodes.map(n => [n.id, n]));
  const push = (id: string, edgeId?: string, outcome?: "revert" | "return") => {
    if (steps.length >= 1000) { traceTruncated = true; return; }
    const node = nodeById.get(id); if (!node) return;
    steps.push({ nodeId: id, functionId: node.functionId, source: node.span, ...(edgeId ? { edgeId } : {}), ...(outcome ? { outcome } : {}) });
  };
  function bridge(from: string, to: string): string[] | null {
    const queue: { id: string; edges: string[] }[] = [{ id: from, edges: [] }]; const seen = new Set<string>();
    while (queue.length) {
      const item = queue.shift()!; if (seen.has(item.id) || item.edges.length > 8) continue; seen.add(item.id);
      for (const edge of program.edges.filter(e => e.kind === "execution" && e.source === item.id)) {
        if (edge.target === to) return [...item.edges, edge.id];
        const target = nodeById.get(edge.target);
        if (target && !target.statement && ["join", "exit", "condition"].includes(target.kind)) queue.push({ id: target.id, edges: [...item.edges, edge.id] });
      }
    }
    return null;
  }
  function visit(id: string) {
    const previous = steps.at(-1);
    if (previous?.nodeId === id) return;
    if (!previous) {
      const node = nodeById.get(id)!;
      if (node.functionId === functionId) push(`${functionId}/entry`);
    }
    const from = steps.at(-1)?.nodeId;
    const path = from ? bridge(from, id) : null;
    if (path?.length) for (const edgeId of path) { const edge = program.edges.find(e => e.id === edgeId)!; push(edge.target, edgeId); }
    else push(id);
  }
  for (const log of trace.structLogs) {
    if (previousLog && log.depth > previousLog.depth) {
      const target = ["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE"].includes(previousLog.op) ? previousLog.stack?.at(-2)?.slice(-40) : undefined;
      frames.set(log.depth, target ? `0x${target}`.toLowerCase() : "unknown");
    }
    previousLog = log;
    if (frames.get(log.depth) !== address.toLowerCase()) { unmappedSteps++; continue; }
    let node = cache.get(log.pc);
    if (node === undefined) {
      const location = mappings.get(log.pc); const file = location && build.sourceFiles[location.file]; const source = file && build.sources[file];
      if (location && file && source !== undefined && location.start >= 0 && location.length > 0) {
        const start = Buffer.from(source).subarray(0, location.start).toString("utf8").length;
        const end = Buffer.from(source).subarray(0, location.start + location.length).toString("utf8").length;
        node = candidates.filter(n => n.span.file === file && n.span.start <= start && n.span.end >= end).sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start))[0] ?? null;
      } else node = null;
      cache.set(log.pc, node);
    }
    if (node) visit(node.id); else unmappedSteps++;
    if (log.op === "SSTORE" && log.stack?.length) writes.set(`0x${log.stack.at(-1)!.replace(/^0x/, "").padStart(64, "0")}`, node?.text ?? "Storage write");
  }
  const last = steps.at(-1);
  if (trace.failed && last) {
    const failure = program.edges.find(e => e.kind === "execution" && e.source === last.nodeId && nodeById.get(e.target)?.kind === "revert");
    if (failure) push(failure.target, failure.id, "revert"); else last.outcome = "revert";
  } else if (!trace.failed && last) {
    const completion = `${functionId}/entry/complete`;
    if (nodeById.has(completion)) { visit(completion); if (steps.at(-1)) steps.at(-1)!.outcome = "return"; }
    else last.outcome = "return";
  }
  return { steps, writes, unmappedSteps, traceTruncated };
}
