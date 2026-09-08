import { readFile } from "node:fs/promises";
import path from "node:path";
import solc from "solc";
import {
  createStableNodeId,
  parseFunctionFlowchart,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowNode,
  type FlowNodeKind,
  type FunctionFlowchart,
  type GraphEdge,
  type GraphNode,
  type GraphNodeKind,
  type JsonValue,
  type SourceLocation,
} from "@codevis/shared";
import { discoverSolidityFiles, type DiscoverSolidityFilesOptions } from "./discover-solidity-files.js";

interface AstNode {
  readonly [key: string]: unknown;
  readonly id?: number;
  readonly nodeType?: string;
  readonly name?: string;
  readonly src?: string;
  readonly nodes?: readonly AstNode[];
  readonly absolutePath?: string;
  readonly file?: string;
  readonly sourceUnit?: number;
  readonly referencedDeclaration?: number;
  readonly contractKind?: string;
  readonly abstract?: boolean;
  readonly baseContracts?: readonly { readonly baseName?: { readonly namePath?: string; readonly name?: string; readonly referencedDeclaration?: number } }[];
  readonly visibility?: string;
  readonly stateMutability?: string;
  readonly kind?: string;
  readonly mutability?: string;
  readonly constant?: boolean;
  readonly stateVariable?: boolean;
  readonly typeDescriptions?: { readonly typeString?: string };
  readonly parameters?: { readonly parameters?: readonly AstNode[] };
  readonly returnParameters?: { readonly parameters?: readonly AstNode[] };
}

interface CompilerDiagnostic {
  readonly severity?: string;
  readonly errorCode?: string;
  readonly type?: string;
  readonly message?: string;
  readonly formattedMessage?: string;
  readonly sourceLocation?: { readonly file?: string; readonly start?: number; readonly end?: number };
}

interface CompilerOutput {
  readonly errors?: readonly CompilerDiagnostic[];
  readonly sources?: Readonly<Record<string, { readonly ast?: AstNode }>>;
}

export interface SolidityDiagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly code?: string;
  readonly type?: string;
  readonly source?: SourceLocation;
}

export interface SolidityStructureAnalysis {
  readonly compilerVersion: string;
  readonly files: readonly string[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly diagnostics: readonly SolidityDiagnostic[];
  readonly flowcharts: readonly FunctionFlowchart[];
}

/** Compiles all discovered sources to a Solidity AST and extracts structural graph nodes. */
export async function analyzeSolidityStructure(
  projectDirectory: string,
  options: DiscoverSolidityFilesOptions = {},
): Promise<SolidityStructureAnalysis> {
  const root = path.resolve(projectDirectory);
  const files = await discoverSolidityFiles(root, options);
  const sourceEntries = await Promise.all(
    files.map(async (file) => [file, { content: await readFile(path.join(root, file), "utf8") }] as const),
  );
  const sources = Object.fromEntries(sourceEntries);
  const input = {
    language: "Solidity",
    sources,
    settings: { outputSelection: { "*": { "": ["ast"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as CompilerOutput;
  const sourceTexts = new Map(sourceEntries.map(([file, source]) => [file, source.content]));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const astNodeIds = new Map<number, string>();

  const repositoryNode = createSyntheticNode("repository", path.basename(root), ".");
  nodes.push(repositoryNode);
  const containerIds = createDirectoryNodes(files, repositoryNode, nodes, edges);

  for (const file of files) {
    const text = sourceTexts.get(file)!;
    const fileNode = createNode("file", path.posix.basename(file), file, 0, Buffer.byteLength(text), text, {});
    nodes.push(fileNode);
    addEdge(edges, "contains", containerIds.get(path.posix.dirname(file)) ?? repositoryNode.id, fileNode.id);
    const ast = output.sources?.[file]?.ast;
    if (ast) visitNodes(ast.nodes ?? [], file, text, nodes, edges, astNodeIds, fileNode.id);
  }

  for (const file of files) {
    const ast = output.sources?.[file]?.ast;
    if (ast) addDependencyEdges(ast.nodes ?? [], file, nodes, edges, astNodeIds);
  }

  const behaviorDiagnostics: SolidityDiagnostic[] = [];
  for (const file of files) {
    const ast = output.sources?.[file]?.ast;
    if (ast) addBehaviorEdges(ast, nodes, edges, astNodeIds, behaviorDiagnostics);
  }
  const flowcharts: FunctionFlowchart[] = [];
  for (const file of files) {
    const ast = output.sources?.[file]?.ast;
    const text = sourceTexts.get(file)!;
    if (ast) walkAst(ast, (candidate) => {
      if (candidate.nodeType !== "FunctionDefinition" || candidate.id === undefined || !asAstNode(candidate.body)) return;
      const functionId = astNodeIds.get(candidate.id);
      if (functionId) flowcharts.push(buildFunctionFlowchart(candidate, functionId, file, text));
    });
  }

  return {
    compilerVersion: solc.version(),
    files,
    nodes,
    edges,
    flowcharts,
    diagnostics: [
      ...(output.errors ?? []).map((diagnostic) => mapDiagnostic(diagnostic, sourceTexts)),
      ...behaviorDiagnostics,
    ],
  };
}

type PendingFlow = { readonly id: string; readonly kind: FlowEdgeKind };

function buildFunctionFlowchart(fn: AstNode, functionId: string, file: string, text: string): FunctionFlowchart {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let sequence = 0;
  const location = (node: AstNode) => { const [start, length] = parseSrc(node.src ?? fn.src!); return sourceLocation(file, start, start + length, text); };
  const addNode = (kind: FlowNodeKind, label: string, ast: AstNode): string => { const id = `${functionId}:flow:${++sequence}`; nodes.push({ id, kind, label, source: location(ast) }); return id; };
  const connect = (incoming: readonly PendingFlow[], target: string) => incoming.forEach(({ id: source, kind }) => edges.push({ id: `${source}:${target}:${kind}`, source, target, kind }));
  const labelFor = (node: AstNode, fallback: string) => { const [start, length] = parseSrc(node.src ?? "0:0"); const raw = Buffer.from(text).subarray(start, start + length).toString("utf8").replace(/\s+/g, " ").trim(); return raw.length > 92 ? `${raw.slice(0, 89)}…` : raw || fallback; };
  const statements = (node: AstNode | undefined): AstNode[] => (node?.nodeType === "Block" || node?.nodeType === "YulBlock") && Array.isArray(node.statements) ? (node.statements as AstNode[]) : node ? [node] : [];

  const buildSequence = (items: readonly AstNode[], initial: readonly PendingFlow[]): PendingFlow[] => {
    let incoming = [...initial];
    for (const statement of items) incoming = buildStatement(statement, incoming);
    return incoming;
  };
  const buildStatement = (statement: AstNode, incoming: readonly PendingFlow[]): PendingFlow[] => {
    if (statement.nodeType === "Block" || statement.nodeType === "YulBlock") return buildSequence(statements(statement), incoming);
    if (statement.nodeType === "InlineAssembly") return buildSequence(statements(asAstNode(statement.AST)), incoming);
    if (statement.nodeType === "IfStatement") {
      const condition = asAstNode(statement.condition) ?? statement;
      const id = addNode("decision", labelFor(condition, "condition"), condition); connect(incoming, id);
      const yes = buildSequence(statements(asAstNode(statement.trueBody)), [{ id, kind: "yes" }]);
      const falseBody = asAstNode(statement.falseBody);
      const no = falseBody ? buildSequence(statements(falseBody), [{ id, kind: "no" }]) : [{ id, kind: "no" as const }];
      return [...yes, ...no];
    }
    if (statement.nodeType === "YulIf") {
      const condition = asAstNode(statement.condition) ?? statement;
      const id = addNode("decision", labelFor(condition, "assembly condition"), condition); connect(incoming, id);
      const yes = buildSequence(statements(asAstNode(statement.body)), [{ id, kind: "yes" }]);
      return [...yes, { id, kind: "no" }];
    }
    if (statement.nodeType === "WhileStatement" || statement.nodeType === "DoWhileStatement" || statement.nodeType === "ForStatement" || statement.nodeType === "YulForLoop") {
      const condition = asAstNode(statement.condition) ?? statement;
      const id = addNode("decision", labelFor(condition, statement.nodeType === "ForStatement" ? "for loop" : "loop condition"), condition); connect(incoming, id);
      const body = buildSequence(statements(asAstNode(statement.body)), [{ id, kind: "yes" }]);
      body.forEach(({ id: source }) => edges.push({ id: `${source}:${id}:loop`, source, target: id, kind: "loop" }));
      return [{ id, kind: "no" }];
    }
    if (statement.nodeType === "Return") { const id = addNode("return", labelFor(statement, "return"), statement); connect(incoming, id); return []; }
    if (statement.nodeType === "RevertStatement" || isNamedCall(statement, "revert")) { const id = addNode("error", labelFor(statement, "revert"), statement); connect(incoming, id); return []; }
    if (isNamedCall(statement, "require") || isNamedCall(statement, "assert")) {
      const id = addNode("decision", labelFor(statement, "validation"), statement); connect(incoming, id);
      const errorId = addNode("error", isNamedCall(statement, "assert") ? "Assertion fails" : "Requirement fails", statement);
      edges.push({ id: `${id}:${errorId}:no`, source: id, target: errorId, kind: "no" });
      return [{ id, kind: "yes" }];
    }
    const kind = classifyFlowNode(statement);
    const id = addNode(kind, labelFor(statement, kind.replaceAll("_", " ")), statement); connect(incoming, id);
    return [{ id, kind: "next" }];
  };

  const start = addNode("start", `${fn.name || fn.kind || "function"} starts`, fn);
  const exits = buildSequence(statements(asAstNode(fn.body)), [{ id: start, kind: "next" }]);
  if (exits.length) { const end = addNode("return", "Function completes", fn); connect(exits, end); }
  return parseFunctionFlowchart({ schemaVersion: 1, functionId, nodes, edges });
}

function classifyFlowNode(statement: AstNode): FlowNodeKind {
  if (statement.nodeType === "EmitStatement") return "event";
  if (statement.nodeType === "YulAssignment" || statement.nodeType === "YulVariableDeclaration") return "process";
  let hasAssignment = false; let hasExternal = false; let hasCall = false;
  walkAst(statement, (node) => { if (node.nodeType === "Assignment" || node.nodeType === "YulAssignment") hasAssignment = true; if (node.nodeType === "FunctionCall" || node.nodeType === "YulFunctionCall") hasCall = true; if (node.nodeType === "MemberAccess") hasExternal = true; });
  if (hasAssignment) return "state_write";
  if (hasExternal && hasCall) return "external_call";
  if (hasCall) return "call";
  return "process";
}

function isNamedCall(statement: AstNode, name: string): boolean {
  let found = false;
  walkAst(statement, (node) => {
    if (node.nodeType === "YulFunctionCall" && asAstNode(node.functionName)?.name === name) found = true;
    if (node.nodeType !== "FunctionCall") return; const expression = asAstNode(node.expression); if (expression?.name === name || expression?.memberName === name) found = true;
  });
  return found;
}


function addBehaviorEdges(
  ast: AstNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
  astNodeIds: Map<number, string>,
  diagnostics: SolidityDiagnostic[],
): void {
  walkAst(ast, (candidate) => {
    if (candidate.nodeType !== "FunctionDefinition" || candidate.id === undefined) return;
    const functionId = astNodeIds.get(candidate.id);
    if (!functionId) return;

    let hasExternalCalls = false;
    let sendsValue = false;
    const unresolvedCalls = new Set<string>();
    walkAst(candidate, (node, parent, key) => {
      if (node.nodeType === "ModifierInvocation") {
        const modifierName = asAstNode(node.modifierName);
        const target = modifierName?.referencedDeclaration === undefined
          ? undefined
          : astNodeIds.get(modifierName.referencedDeclaration);
        if (target) addEdge(edges, "applies_modifier", functionId, target);
      }

      if (node.nodeType === "FunctionCall") {
        const expression = asAstNode(node.expression);
        const callable = expression?.nodeType === "FunctionCallOptions"
          ? asAstNode(expression.expression)
          : expression;
        const declaration = callable?.referencedDeclaration;
        const target = declaration === undefined ? undefined : astNodeIds.get(declaration);
        if (target) addEdge(edges, "calls", functionId, target);

        if (callable?.nodeType === "MemberAccess") {
          hasExternalCalls = true;
          if (!target) unresolvedCalls.add(String(callable.memberName ?? "external call"));
        }
        if (expression?.nodeType === "FunctionCallOptions") {
          const names = Array.isArray(expression.names) ? expression.names : [];
          if (names.includes("value")) sendsValue = true;
        }
      }

      if (node.nodeType === "Identifier" && node.referencedDeclaration !== undefined) {
        const target = astNodeIds.get(node.referencedDeclaration);
        const targetNode = target ? nodes.find(({ id }) => id === target) : undefined;
        if (!target || targetNode?.kind !== "state_variable") return;
        const access = stateAccessFor(parent, key);
        if (access.read) addEdge(edges, "reads", functionId, target);
        if (access.write) addEdge(edges, "writes", functionId, target);
      }
    });

    const index = nodes.findIndex(({ id }) => id === functionId);
    if (index >= 0) {
      const current = nodes[index]!;
      nodes[index] = {
        ...current,
        metadata: {
          ...current.metadata,
          hasExternalCalls,
          sendsValue,
          unresolvedCalls: [...unresolvedCalls].sort(),
        },
      };
    }
    for (const call of unresolvedCalls) {
      const source = nodes.find(({ id }) => id === functionId)?.source;
      diagnostics.push({
        severity: "info",
        message: `Unresolved external call '${call}' in ${currentFunctionLabel(nodes, functionId)}`,
        ...(source ? { source } : {}),
      });
    }
  });
}

function currentFunctionLabel(nodes: readonly GraphNode[], id: string): string {
  return nodes.find((node) => node.id === id)?.label ?? id;
}

function stateAccessFor(parent: AstNode | undefined, key: string | undefined): { read: boolean; write: boolean } {
  let ancestor = parent;
  let childKey = key;
  while (ancestor && (ancestor.nodeType === "IndexAccess" || ancestor.nodeType === "MemberAccess")) {
    if (childKey !== "baseExpression" && childKey !== "expression") break;
    const relation = astParentRelations.get(ancestor);
    ancestor = relation?.parent;
    childKey = relation?.key;
  }
  if (ancestor?.nodeType === "Assignment" && childKey === "leftHandSide") {
    return { read: ancestor.operator !== "=", write: true };
  }
  if (ancestor?.nodeType === "UnaryOperation" && childKey === "subExpression") {
    const writes = ancestor.operator === "++" || ancestor.operator === "--" || ancestor.operator === "delete";
    return { read: ancestor.operator !== "delete", write: writes };
  }
  return { read: true, write: false };
}

const astParentRelations = new WeakMap<AstNode, { parent: AstNode; key: string }>();

function walkAst(node: AstNode, visit: (node: AstNode, parent?: AstNode, key?: string) => void, parent?: AstNode, key?: string): void {
  if (parent && key) astParentRelations.set(node, { parent, key });
  visit(node, parent, key);
  for (const [childKey, value] of Object.entries(node)) {
    if (isAstNode(value)) walkAst(value, visit, node, childKey);
    else if (Array.isArray(value)) {
      for (const child of value) if (isAstNode(child)) walkAst(child, visit, node, childKey);
    }
  }
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { nodeType?: unknown }).nodeType === "string";
}

function asAstNode(value: unknown): AstNode | undefined {
  return isAstNode(value) ? value : undefined;
}

function visitNodes(astNodes: readonly AstNode[], file: string, text: string, nodes: GraphNode[], edges: GraphEdge[], astNodeIds: Map<number, string>, parentId: string): void {
  for (const ast of astNodes) {
    const mapped = mapAstNode(ast);
    let childParentId = parentId;
    if (mapped && ast.src) {
      const [start, length] = parseSrc(ast.src);
      const node = createNode(mapped.kind, mapped.label, file, start, start + length, text, mapped.metadata);
      nodes.push(node);
      addEdge(edges, "contains", parentId, node.id);
      if (ast.id !== undefined) astNodeIds.set(ast.id, node.id);
      childParentId = node.id;
    }
    if (ast.nodes) visitNodes(ast.nodes, file, text, nodes, edges, astNodeIds, childParentId);
  }
}

function createDirectoryNodes(files: readonly string[], repository: GraphNode, nodes: GraphNode[], edges: GraphEdge[]): Map<string, string> {
  const result = new Map<string, string>();
  const directories = [...new Set(files.flatMap((file) => directoryAncestors(path.posix.dirname(file))))].sort();
  for (const directory of directories) {
    const node = createSyntheticNode("directory", path.posix.basename(directory), directory);
    nodes.push(node);
    const parent = path.posix.dirname(directory);
    addEdge(edges, "contains", result.get(parent) ?? repository.id, node.id);
    result.set(directory, node.id);
  }
  return result;
}

function directoryAncestors(directory: string): string[] {
  if (directory === ".") return [];
  const parts = directory.split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function addDependencyEdges(astNodes: readonly AstNode[], file: string, nodes: readonly GraphNode[], edges: GraphEdge[], astNodeIds: Map<number, string>): void {
  const fileNode = nodes.find((node) => node.kind === "file" && node.source?.file === file);
  for (const ast of astNodes) {
    if (ast.nodeType === "ImportDirective" && fileNode) {
      const importedFile = ast.absolutePath ?? ast.file;
      const target = nodes.find((node) => node.kind === "file" && node.source?.file === importedFile);
      if (target) addEdge(edges, "imports", fileNode.id, target.id);
    }
    if (ast.nodeType === "ContractDefinition" && ast.id !== undefined) {
      const source = astNodeIds.get(ast.id);
      for (const base of ast.baseContracts ?? []) {
        const target = base.baseName?.referencedDeclaration === undefined ? undefined : astNodeIds.get(base.baseName.referencedDeclaration);
        if (source && target) addEdge(edges, "inherits", source, target);
      }
    }
    if (ast.nodes) addDependencyEdges(ast.nodes, file, nodes, edges, astNodeIds);
  }
}

function createSyntheticNode(kind: "repository" | "directory", label: string, nodePath: string): GraphNode {
  return { id: createStableNodeId({ kind, path: nodePath }), kind, label, status: "idle", metadata: {} };
}

function addEdge(edges: GraphEdge[], kind: GraphEdge["kind"], source: string, target: string): void {
  const id = `${kind}:${encodeURIComponent(source)}:${encodeURIComponent(target)}`;
  if (!edges.some((edge) => edge.id === id)) edges.push({ id, kind, source, target, metadata: {} });
}

function mapAstNode(ast: AstNode): { kind: GraphNodeKind; label: string; metadata: Record<string, JsonValue> } | undefined {
  const label = ast.name || (ast.nodeType === "FunctionDefinition" ? ast.kind : undefined);
  if (!label) return undefined;
  switch (ast.nodeType) {
    case "ContractDefinition":
      return {
        kind: "contract",
        label,
        metadata: {
          contractKind: ast.contractKind ?? "contract",
          abstract: ast.abstract ?? false,
          inheritanceNames: (ast.baseContracts ?? []).map((base) => base.baseName?.namePath ?? base.baseName?.name ?? "<unknown>"),
        },
      };
    case "FunctionDefinition":
      return {
        kind: "function",
        label,
        metadata: {
          functionKind: ast.kind ?? "function",
          visibility: ast.visibility ?? "default",
          mutability: ast.stateMutability ?? "nonpayable",
          payable: ast.stateMutability === "payable",
          parameters: (ast.parameters?.parameters ?? []).map((parameter) => `${parameter.name || "value"}: ${parameter.typeDescriptions?.typeString ?? "unknown"}`),
          returns: (ast.returnParameters?.parameters ?? []).map((parameter) => `${parameter.name || "value"}: ${parameter.typeDescriptions?.typeString ?? "unknown"}`),
        },
      };
    case "ModifierDefinition":
      return { kind: "modifier", label, metadata: {} };
    case "EventDefinition":
      return { kind: "event", label, metadata: {} };
    case "ErrorDefinition":
      return { kind: "error", label, metadata: {} };
    case "VariableDeclaration":
      if (!ast.stateVariable) return undefined;
      return {
        kind: "state_variable",
        label,
        metadata: {
          visibility: ast.visibility ?? "internal",
          mutability: ast.mutability ?? (ast.constant ? "constant" : "mutable"),
          type: ast.typeDescriptions?.typeString ?? "unknown",
        },
      };
    default:
      return undefined;
  }
}

function createNode(
  kind: GraphNodeKind,
  label: string,
  file: string,
  start: number,
  end: number,
  text: string,
  metadata: Record<string, JsonValue>,
): GraphNode {
  return {
    id: createStableNodeId({ kind, path: file, symbol: label, startOffset: start }),
    kind,
    label,
    status: "idle",
    source: sourceLocation(file, start, end, text),
    metadata,
  };
}

function mapDiagnostic(diagnostic: CompilerDiagnostic, sources: Map<string, string>): SolidityDiagnostic {
  const location = diagnostic.sourceLocation;
  const text = location?.file ? sources.get(location.file) : undefined;
  return {
    severity: diagnostic.severity === "error" || diagnostic.severity === "warning" ? diagnostic.severity : "info",
    message: diagnostic.formattedMessage ?? diagnostic.message ?? "Unknown Solidity compiler diagnostic",
    ...(diagnostic.errorCode ? { code: diagnostic.errorCode } : {}),
    ...(diagnostic.type ? { type: diagnostic.type } : {}),
    ...(location?.file && text !== undefined && location.start !== undefined && location.end !== undefined
      ? { source: sourceLocation(location.file, location.start, location.end, text) }
      : {}),
  };
}

function parseSrc(src: string): [number, number] {
  const parts = src.split(":", 2);
  const start = Number(parts[0]);
  const length = Number(parts[1]);
  if (!Number.isInteger(start) || !Number.isInteger(length)) {
    throw new Error(`Invalid Solidity AST source range '${src}'`);
  }
  return [start, length];
}

function sourceLocation(file: string, start: number, end: number, text: string): SourceLocation {
  return { file, start: positionAt(text, start), end: positionAt(text, end) };
}

function positionAt(text: string, byteOffset: number) {
  const prefix = Buffer.from(text).subarray(0, byteOffset).toString("utf8");
  const lines = prefix.split("\n");
  return { offset: byteOffset, line: lines.length, column: [...lines.at(-1)!].length + 1 };
}
