export const GRAPH_SCHEMA_VERSION = 1 as const;
export const WORK_EVENT_SCHEMA_VERSION = 1 as const;

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
