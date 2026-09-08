import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import {
  EXPLANATION_SCHEMA_VERSION,
  parseExplanationCollection,
  type CodeExplanation,
  type ExplanationCollection,
  type Graph,
  type GraphNode,
} from "@codevis/shared";

const PROMPT_VERSION = 1;

export interface ExplanationProvider {
  explain(packet: ExplanationPacket, signal?: AbortSignal): Promise<readonly GeneratedExplanation[]>;
}

export interface ExplanationPacket {
  readonly contractId: string;
  readonly symbols: readonly { readonly nodeId: string; readonly kind: string; readonly label: string; readonly source: string; readonly file: string; readonly startLine: number; readonly endLine: number; readonly facts: readonly string[] }[];
}

export interface GeneratedExplanation {
  readonly nodeId: string;
  readonly summary: string;
  readonly purpose: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly steps: readonly { readonly title: string; readonly detail: string; readonly evidence: readonly { readonly file: string; readonly startLine: number; readonly endLine: number }[] }[];
  readonly stateEffects: readonly string[];
  readonly externalInteractions: readonly string[];
  readonly reverts: readonly string[];
  readonly concepts: readonly string[];
}

export interface ExplanationManager {
  collection(): ExplanationCollection;
  subscribe(listener: (collection: ExplanationCollection) => void): () => void;
  retry(nodeId: string): boolean;
  prioritize(nodeId: string): boolean;
  updateGraph(graph: Graph): void;
  close(): Promise<void>;
}

export async function createExplanationManager(graph: Graph, provider: ExplanationProvider = new CodexExplanationProvider(), cacheRoot = defaultCacheRoot()): Promise<ExplanationManager> {
  let currentGraph = graph;
  let closed = false;
  let running = false;
  let controller: AbortController | undefined;
  const listeners = new Set<(collection: ExplanationCollection) => void>();
  const items = new Map<string, CodeExplanation>();
  let queue: string[] = [];
  const cacheFile = path.join(cacheRoot, `${createHash("sha256").update(path.resolve(graph.repository)).digest("hex")}.json`);
  const cached = await readCache(cacheFile);

  const seed = () => {
    const eligible = eligibleNodes(currentGraph);
    const eligibleIds = new Set(eligible.map(({ id }) => id));
    for (const id of [...items.keys()]) if (!eligibleIds.has(id)) items.delete(id);
    for (const node of eligible) {
      const hash = contentHash(currentGraph, node);
      const previous = items.get(node.id) ?? cached.get(node.id);
      if (previous?.contentHash === hash && previous.status === "ready") items.set(node.id, previous);
      else {
        items.set(node.id, { schemaVersion: 1, nodeId: node.id, contentHash: hash, status: previous ? "stale" : "queued" });
        if (!queue.includes(node.id)) queue.push(node.id);
      }
    }
  };
  const snapshot = (): ExplanationCollection => parseExplanationCollection({ schemaVersion: 1, enabled: true, items: [...items.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)) });
  const emit = () => { const value = snapshot(); listeners.forEach((listener) => listener(value)); };
  const save = async () => { await mkdir(cacheRoot, { recursive: true }); await writeFile(cacheFile, JSON.stringify(snapshot()), "utf8"); };

  const pump = async () => {
    if (running || closed) return;
    running = true;
    while (!closed && queue.length) {
      const requestedId = queue.shift()!;
      const node = currentGraph.nodes.find(({ id }) => id === requestedId);
      if (!node || !isEligible(node)) continue;
      const owner = owningContract(currentGraph, node) ?? node;
      const packet = buildPacket(currentGraph, owner);
      const packetIds = packet.symbols.map(({ nodeId }) => nodeId).filter((id) => items.has(id));
      packetIds.forEach((id) => { const { error: _error, ...item } = items.get(id)!; items.set(id, { ...item, status: "running" }); });
      queue = queue.filter((id) => !packetIds.includes(id));
      emit();
      controller = new AbortController();
      let error: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const generated = await provider.explain(packet, controller.signal);
          validateGenerated(packet, generated);
          for (const result of generated) {
            const existing = items.get(result.nodeId);
            if (existing) items.set(result.nodeId, { schemaVersion: 1, contentHash: existing.contentHash, status: "ready", ...result });
          }
          error = undefined;
          break;
        } catch (caught) { error = caught; }
      }
      if (error) packetIds.forEach((id) => items.set(id, { ...items.get(id)!, status: "failed", error: error instanceof Error ? error.message : String(error) }));
      await save().catch(() => undefined);
      emit();
    }
    running = false;
  };

  seed();
  void pump();
  return {
    collection: snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    retry(nodeId) { if (!items.has(nodeId)) return false; const { error: _error, ...item } = items.get(nodeId)!; items.set(nodeId, { ...item, status: "queued" }); queue = [nodeId, ...queue.filter((id) => id !== nodeId)]; emit(); void pump(); return true; },
    prioritize(nodeId) { if (!queue.includes(nodeId)) return false; queue = [nodeId, ...queue.filter((id) => id !== nodeId)]; return true; },
    updateGraph(next) { currentGraph = next; seed(); emit(); void pump(); },
    async close() { closed = true; controller?.abort(); await save().catch(() => undefined); },
  };
}

export class CodexExplanationProvider implements ExplanationProvider {
  public async explain(packet: ExplanationPacket, signal?: AbortSignal): Promise<readonly GeneratedExplanation[]> {
    const thread = new Codex().startThread({ workingDirectory: os.tmpdir(), skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false, webSearchMode: "disabled" });
    const result = await thread.run(`${SYSTEM_PROMPT}\n\nEvidence packet:\n${JSON.stringify(packet)}`, { outputSchema: GENERATED_SCHEMA, ...(signal ? { signal } : {}) });
    const parsed = JSON.parse(result.finalResponse) as { explanations?: unknown };
    if (!Array.isArray(parsed.explanations)) throw new Error("Codex returned no explanations.");
    return parsed.explanations as GeneratedExplanation[];
  }
}

function eligibleNodes(graph: Graph): GraphNode[] {
  return graph.nodes.filter(isEligible).sort((a, b) => (a.source?.file ?? "").localeCompare(b.source?.file ?? "") || (a.source?.start.offset ?? 0) - (b.source?.start.offset ?? 0));
}

function isEligible(node: GraphNode): boolean {
  return node.kind === "contract" || (node.kind === "function" && (node.metadata.visibility === "public" || node.metadata.visibility === "external"));
}

function owningContract(graph: Graph, node: GraphNode): GraphNode | undefined {
  if (node.kind === "contract") return node;
  const parentId = graph.edges.find((edge) => edge.kind === "contains" && edge.target === node.id)?.source;
  return graph.nodes.find((candidate) => candidate.id === parentId && candidate.kind === "contract");
}

export function buildPacket(graph: Graph, contract: GraphNode): ExplanationPacket {
  const sourceMap = graph.metadata.sources as Readonly<Record<string, string>> | undefined;
  const children = graph.edges.filter((edge) => edge.kind === "contains" && edge.source === contract.id).map((edge) => graph.nodes.find(({ id }) => id === edge.target)).filter((node): node is GraphNode => Boolean(node));
  const symbols = [contract, ...children.filter(isEligible)].map((node) => ({
    nodeId: node.id, kind: node.kind, label: node.label, file: node.source?.file ?? "", startLine: node.source?.start.line ?? 1, endLine: node.source?.end.line ?? 1,
    source: excerpt(sourceMap?.[node.source?.file ?? ""] ?? "", node.source?.start.line ?? 1, node.source?.end.line ?? 1),
    facts: graph.edges.filter((edge) => edge.source === node.id && edge.kind !== "contains").map((edge) => `${edge.kind} ${graph.nodes.find(({ id }) => id === edge.target)?.label ?? edge.target}`),
  }));
  return { contractId: contract.id, symbols };
}

function excerpt(text: string, startLine: number, endLine: number): string {
  const selected = text.split("\n").slice(startLine - 1, endLine).join("\n");
  return selected.length <= 50_000 ? selected : `${selected.slice(0, 49_980)}\n/* truncated */`;
}

function contentHash(graph: Graph, node: GraphNode): string {
  const owner = owningContract(graph, node) ?? node;
  return createHash("sha256").update(JSON.stringify({ prompt: PROMPT_VERSION, packet: buildPacket(graph, owner) })).digest("hex");
}

function validateGenerated(packet: ExplanationPacket, generated: readonly GeneratedExplanation[]): void {
  const allowed = new Map(packet.symbols.map((symbol) => [symbol.nodeId, symbol]));
  for (const result of generated) {
    const symbol = allowed.get(result.nodeId);
    if (!symbol) throw new Error(`Codex referenced unknown symbol '${result.nodeId}'.`);
    for (const step of result.steps) for (const evidence of step.evidence) {
      if (evidence.file !== symbol.file || evidence.startLine < symbol.startLine || evidence.endLine > symbol.endLine || evidence.endLine < evidence.startLine) throw new Error(`Codex returned unsupported evidence for '${result.nodeId}'.`);
    }
  }
  for (const symbol of packet.symbols) if (!generated.some(({ nodeId }) => nodeId === symbol.nodeId)) throw new Error(`Codex omitted '${symbol.nodeId}'.`);
}

async function readCache(file: string): Promise<Map<string, CodeExplanation>> {
  try { const collection = parseExplanationCollection(JSON.parse(await readFile(file, "utf8"))); return new Map(collection.items.map((item) => [item.nodeId, item])); }
  catch { return new Map(); }
}

function defaultCacheRoot(): string {
  return process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "codevis") : path.join(os.homedir(), ".cache", "codevis");
}

const SYSTEM_PROMPT = `You explain Solidity to newcomers. Use only the supplied evidence packet. Return one concise explanation for every symbol. Define unfamiliar concepts plainly. Never claim security, correctness, or runtime behavior beyond evidence. Every behavior step must cite a line range inside that symbol.`;

const stringArray = { type: "array", items: { type: "string" } } as const;
const GENERATED_SCHEMA = { type: "object", properties: { explanations: { type: "array", items: { type: "object", properties: {
  nodeId: { type: "string" }, summary: { type: "string" }, purpose: { type: "string" }, inputs: stringArray, outputs: stringArray,
  steps: { type: "array", items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" }, evidence: { type: "array", items: { type: "object", properties: { file: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" } }, required: ["file", "startLine", "endLine"], additionalProperties: false } } }, required: ["title", "detail", "evidence"], additionalProperties: false } },
  stateEffects: stringArray, externalInteractions: stringArray, reverts: stringArray, concepts: stringArray,
}, required: ["nodeId", "summary", "purpose", "inputs", "outputs", "steps", "stateEffects", "externalInteractions", "reverts", "concepts"], additionalProperties: false } } }, required: ["explanations"], additionalProperties: false } as const;
