export const GRAPH_SCHEMA_VERSION = 1 as const;
export const WORK_EVENT_SCHEMA_VERSION = 1 as const;
export const EXPLANATION_SCHEMA_VERSION = 1 as const;
export const FLOWCHART_SCHEMA_VERSION = 1 as const;
export const flowNodeKinds = ["start", "process", "decision", "call", "state_read", "state_write", "external_call", "event", "return", "error"] as const;
export const flowEdgeKinds = ["next", "yes", "no", "success", "failure", "loop"] as const;
export type FlowNodeKind = (typeof flowNodeKinds)[number];
export type FlowEdgeKind = (typeof flowEdgeKinds)[number];
export interface FlowNode { readonly id: string; readonly kind: FlowNodeKind; readonly label: string; readonly source: SourceLocation; }
export interface FlowEdge { readonly id: string; readonly source: string; readonly target: string; readonly kind: FlowEdgeKind; }
export interface FunctionFlowchart { readonly schemaVersion: typeof FLOWCHART_SCHEMA_VERSION; readonly functionId: string; readonly nodes: readonly FlowNode[]; readonly edges: readonly FlowEdge[]; }

export function parseFunctionFlowchart(payload: unknown): FunctionFlowchart {
  const issues: string[] = [];
  if (!isRecord(payload)) throw new GraphValidationError(["flowchart must be an object"]);
  if (payload.schemaVersion !== FLOWCHART_SCHEMA_VERSION) issues.push(`schemaVersion must be ${FLOWCHART_SCHEMA_VERSION}`);
  requireNonEmptyString(payload.functionId, "functionId", issues);
  const ids = new Set<string>();
  if (!Array.isArray(payload.nodes)) issues.push("nodes must be an array");
  else payload.nodes.forEach((node, index) => {
    if (!isRecord(node)) { issues.push(`nodes[${index}] must be an object`); return; }
    validateUniqueId(node.id, `nodes[${index}].id`, ids, issues); requireEnum(node.kind, `nodes[${index}].kind`, new Set(flowNodeKinds), issues); requireNonEmptyString(node.label, `nodes[${index}].label`, issues); validateSource(node.source, `nodes[${index}].source`, issues);
  });
  const edgeIds = new Set<string>();
  if (!Array.isArray(payload.edges)) issues.push("edges must be an array");
  else payload.edges.forEach((edge, index) => {
    if (!isRecord(edge)) { issues.push(`edges[${index}] must be an object`); return; }
    validateUniqueId(edge.id, `edges[${index}].id`, edgeIds, issues); requireEnum(edge.kind, `edges[${index}].kind`, new Set(flowEdgeKinds), issues);
    for (const key of ["source", "target"] as const) if (requireNonEmptyString(edge[key], `edges[${index}].${key}`, issues) && !ids.has(edge[key] as string)) issues.push(`edges[${index}].${key} references missing node '${edge[key]}'`);
  });
  if (issues.length) throw new GraphValidationError(issues);
  return payload as unknown as FunctionFlowchart;
}

export const explanationStatuses = ["queued", "running", "ready", "stale", "failed", "unavailable"] as const;
export type ExplanationStatus = (typeof explanationStatuses)[number];

export interface ExplanationEvidence {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ExplanationStep {
  readonly title: string;
  readonly detail: string;
  readonly evidence: readonly ExplanationEvidence[];
}

export interface CodeExplanation {
  readonly schemaVersion: typeof EXPLANATION_SCHEMA_VERSION;
  readonly nodeId: string;
  readonly contentHash: string;
  readonly status: ExplanationStatus;
  readonly summary?: string;
  readonly purpose?: string;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly steps?: readonly ExplanationStep[];
  readonly stateEffects?: readonly string[];
  readonly externalInteractions?: readonly string[];
  readonly reverts?: readonly string[];
  readonly concepts?: readonly string[];
  readonly error?: string;
}

export interface ExplanationCollection {
  readonly schemaVersion: typeof EXPLANATION_SCHEMA_VERSION;
  readonly enabled: boolean;
  readonly items: readonly CodeExplanation[];
}

export class ExplanationValidationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`Invalid explanation payload:\n- ${issues.join("\n- ")}`);
    this.name = "ExplanationValidationError";
  }
}

export function parseExplanationCollection(payload: unknown): ExplanationCollection {
  const issues: string[] = [];
  if (!isRecord(payload)) throw new ExplanationValidationError(["collection must be an object"]);
  if (payload.schemaVersion !== EXPLANATION_SCHEMA_VERSION) issues.push(`schemaVersion must be ${EXPLANATION_SCHEMA_VERSION}`);
  if (typeof payload.enabled !== "boolean") issues.push("enabled must be a boolean");
  if (!Array.isArray(payload.items)) issues.push("items must be an array");
  else payload.items.forEach((item, index) => validateExplanation(item, `items[${index}]`, issues));
  if (issues.length) throw new ExplanationValidationError(issues);
  return payload as unknown as ExplanationCollection;
}

function validateExplanation(value: unknown, itemPath: string, issues: string[]): void {
  if (!isRecord(value)) { issues.push(`${itemPath} must be an object`); return; }
  if (value.schemaVersion !== EXPLANATION_SCHEMA_VERSION) issues.push(`${itemPath}.schemaVersion must be ${EXPLANATION_SCHEMA_VERSION}`);
  requireNonEmptyString(value.nodeId, `${itemPath}.nodeId`, issues);
  requireNonEmptyString(value.contentHash, `${itemPath}.contentHash`, issues);
  requireEnum(value.status, `${itemPath}.status`, new Set(explanationStatuses), issues);
  for (const key of ["summary", "purpose", "error"] as const) if (value[key] !== undefined) requireNonEmptyString(value[key], `${itemPath}.${key}`, issues);
  for (const key of ["inputs", "outputs", "stateEffects", "externalInteractions", "reverts", "concepts"] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((entry) => typeof entry === "string" && entry.length > 0))) issues.push(`${itemPath}.${key} must be an array of non-empty strings`);
  }
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps)) issues.push(`${itemPath}.steps must be an array`);
    else value.steps.forEach((step, index) => validateStep(step, `${itemPath}.steps[${index}]`, issues));
  }
}

function validateStep(value: unknown, stepPath: string, issues: string[]): void {
  if (!isRecord(value)) { issues.push(`${stepPath} must be an object`); return; }
  requireNonEmptyString(value.title, `${stepPath}.title`, issues);
  requireNonEmptyString(value.detail, `${stepPath}.detail`, issues);
  if (!Array.isArray(value.evidence)) issues.push(`${stepPath}.evidence must be an array`);
  else value.evidence.forEach((evidence, index) => {
    const evidencePath = `${stepPath}.evidence[${index}]`;
    if (!isRecord(evidence)) { issues.push(`${evidencePath} must be an object`); return; }
    requireNonEmptyString(evidence.file, `${evidencePath}.file`, issues);
    if (!Number.isInteger(evidence.startLine) || (evidence.startLine as number) < 1) issues.push(`${evidencePath}.startLine must be an integer >= 1`);
    if (!Number.isInteger(evidence.endLine) || (evidence.endLine as number) < (Number(evidence.startLine) || 1)) issues.push(`${evidencePath}.endLine must be >= startLine`);
  });
}

export const workEventTypes = [
  "plan_created", "step_started", "file_read", "file_edit_started", "file_edit_completed",
  "command_started", "test_passed", "test_failed", "finding_created", "work_completed",
] as const;

export type WorkEventType = (typeof workEventTypes)[number];
export interface WorkEvent {
  readonly schemaVersion: typeof WORK_EVENT_SCHEMA_VERSION;
  readonly id: string;
  readonly type: WorkEventType;
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
  readonly message: string;
  readonly targetIds: readonly string[];
  readonly metadata: GraphMetadata;
}

export const graphNodeKinds = [
  "repository",
  "directory",
  "file",
  "contract",
  "function",
  "modifier",
  "event",
  "error",
  "state_variable",
  "test",
  "task",
  "command",
  "finding",
] as const;

export const graphEdgeKinds = [
  "contains",
  "imports",
  "inherits",
  "calls",
  "reads",
  "writes",
  "applies_modifier",
  "tests",
  "modifies",
] as const;

export const graphNodeStatuses = [
  "idle",
  "planned",
  "inspecting",
  "active",
  "passed",
  "failed",
  "warning",
  "deleted",
] as const;

export type GraphNodeKind = (typeof graphNodeKinds)[number];
export type GraphEdgeKind = (typeof graphEdgeKinds)[number];
export type GraphNodeStatus = (typeof graphNodeStatuses)[number];
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type GraphMetadata = Readonly<Record<string, JsonValue>>;

export interface SourcePosition {
  /** Zero-based byte or character offset in the source file. */
  readonly offset: number;
  /** One-based line number. */
  readonly line: number;
  /** One-based column number. */
  readonly column: number;
}

export interface SourceLocation {
  /** Repository-relative path using forward slashes. */
  readonly file: string;
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  readonly status: GraphNodeStatus;
  readonly source?: SourceLocation;
  readonly metadata: GraphMetadata;
}

export interface GraphEdge {
  readonly id: string;
  readonly kind: GraphEdgeKind;
  readonly source: string;
  readonly target: string;
  readonly metadata: GraphMetadata;
}

export interface Graph {
  readonly schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  readonly repository: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly metadata: GraphMetadata;
}

export interface GraphSummary {
  readonly name: string;
  readonly nodeCount: number;
}

export function createEmptyGraph(name: string): GraphSummary {
  return { name, nodeCount: 0 };
}

export interface StableNodeIdInput {
  readonly kind: GraphNodeKind;
  readonly path: string;
  readonly symbol?: string;
  readonly startOffset?: number;
}

/** Creates a readable, deterministic ID from stable source identity fields. */
export function createStableNodeId(input: StableNodeIdInput): string {
  const path = input.path.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = [input.kind, path, input.symbol ?? "", input.startOffset?.toString() ?? ""];
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

export class GraphValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid graph payload:\n- ${issues.join("\n- ")}`);
    this.name = "GraphValidationError";
    this.issues = issues;
  }
}

export class WorkEventValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid work event:\n- ${issues.join("\n- ")}`);
    this.name = "WorkEventValidationError";
    this.issues = issues;
  }
}

const nodeKinds = new Set<string>(graphNodeKinds);
const edgeKinds = new Set<string>(graphEdgeKinds);
const nodeStatuses = new Set<string>(graphNodeStatuses);
const eventTypes = new Set<string>(workEventTypes);

/** Validates a semantic event received from a local tool or agent. */
export function parseWorkEvent(payload: unknown): WorkEvent {
  const issues: string[] = [];
  if (!isRecord(payload)) throw new WorkEventValidationError(["event must be an object"]);
  if (payload.schemaVersion !== WORK_EVENT_SCHEMA_VERSION) issues.push(`schemaVersion must be ${WORK_EVENT_SCHEMA_VERSION}`);
  requireNonEmptyString(payload.id, "id", issues);
  requireEnum(payload.type, "type", eventTypes, issues);
  if (requireNonEmptyString(payload.timestamp, "timestamp", issues) && Number.isNaN(Date.parse(payload.timestamp))) {
    issues.push("timestamp must be a valid ISO-8601 date");
  }
  requireNonEmptyString(payload.message, "message", issues);
  if (!Array.isArray(payload.targetIds)) issues.push("targetIds must be an array of unique non-empty strings");
  else {
    const ids = new Set<string>();
    payload.targetIds.forEach((id, index) => validateUniqueId(id, `targetIds[${index}]`, ids, issues));
  }
  validateMetadata(payload.metadata, "metadata", issues);
  if (issues.length > 0) throw new WorkEventValidationError(issues);
  return payload as unknown as WorkEvent;
}

/** Validates an untrusted payload and returns it with the Graph type. */
export function parseGraph(payload: unknown): Graph {
  const issues: string[] = [];
  if (!isRecord(payload)) {
    throw new GraphValidationError(["graph must be an object"]);
  }

  if (payload.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
  }
  requireNonEmptyString(payload.repository, "repository", issues);
  validateMetadata(payload.metadata, "metadata", issues);

  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  if (!Array.isArray(payload.nodes)) issues.push("nodes must be an array");
  const nodeIds = new Set<string>();
  nodes.forEach((node, index) => validateNode(node, index, nodeIds, issues));

  const edges = Array.isArray(payload.edges) ? payload.edges : [];
  if (!Array.isArray(payload.edges)) issues.push("edges must be an array");
  const edgeIds = new Set<string>();
  edges.forEach((edge, index) => validateEdge(edge, index, edgeIds, nodeIds, issues));

  if (issues.length > 0) throw new GraphValidationError(issues);
  return payload as unknown as Graph;
}

/** Validates before producing deterministic, portable JSON. */
export function serializeGraph(graph: Graph): string {
  return JSON.stringify(parseGraph(graph));
}

function validateNode(value: unknown, index: number, ids: Set<string>, issues: string[]): void {
  const path = `nodes[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  validateUniqueId(value.id, `${path}.id`, ids, issues);
  requireEnum(value.kind, `${path}.kind`, nodeKinds, issues);
  requireNonEmptyString(value.label, `${path}.label`, issues);
  requireEnum(value.status, `${path}.status`, nodeStatuses, issues);
  validateMetadata(value.metadata, `${path}.metadata`, issues);
  if (value.source !== undefined) validateSource(value.source, `${path}.source`, issues);
}

function validateEdge(
  value: unknown,
  index: number,
  ids: Set<string>,
  nodeIds: Set<string>,
  issues: string[],
): void {
  const path = `edges[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  validateUniqueId(value.id, `${path}.id`, ids, issues);
  requireEnum(value.kind, `${path}.kind`, edgeKinds, issues);
  for (const endpoint of ["source", "target"] as const) {
    const id = value[endpoint];
    if (requireNonEmptyString(id, `${path}.${endpoint}`, issues) && !nodeIds.has(id)) {
      issues.push(`${path}.${endpoint} references missing node '${id}'`);
    }
  }
  validateMetadata(value.metadata, `${path}.metadata`, issues);
}

function validateSource(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireNonEmptyString(value.file, `${path}.file`, issues);
  validatePosition(value.start, `${path}.start`, issues);
  validatePosition(value.end, `${path}.end`, issues);
  if (isPosition(value.start) && isPosition(value.end) && value.end.offset < value.start.offset) {
    issues.push(`${path}.end.offset must be greater than or equal to start.offset`);
  }
}

function validatePosition(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  for (const key of ["offset", "line", "column"] as const) {
    const number = value[key];
    const minimum = key === "offset" ? 0 : 1;
    if (!Number.isInteger(number) || (number as number) < minimum) {
      issues.push(`${path}.${key} must be an integer >= ${minimum}`);
    }
  }
}

function validateUniqueId(value: unknown, path: string, ids: Set<string>, issues: string[]): void {
  if (!requireNonEmptyString(value, path, issues)) return;
  if (ids.has(value)) issues.push(`${path} duplicates id '${value}'`);
  ids.add(value);
}

function requireNonEmptyString(value: unknown, path: string, issues: string[]): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string`);
    return false;
  }
  return true;
}

function requireEnum(value: unknown, path: string, values: Set<string>, issues: string[]): void {
  if (typeof value !== "string" || !values.has(value)) {
    issues.push(`${path} must be one of: ${[...values].join(", ")}`);
  }
}

function validateMetadata(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object containing JSON-serializable values`);
    return;
  }
  if (!isJsonValue(value, new Set<object>())) {
    issues.push(`${path} must contain only finite JSON-serializable values without cycles`);
  }
}

function isJsonValue(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is SourcePosition {
  return (
    isRecord(value) &&
    Number.isInteger(value.offset) &&
    Number.isInteger(value.line) &&
    Number.isInteger(value.column)
  );
}
export * from "./studio.js";
export * from "./studio-token-factory.js";
export { createStudioCompiler } from "./studio-compiler.js";
