import { readFile } from "node:fs/promises";
import path from "node:path";
import solc from "solc";
import {
  createStableNodeId,
  type GraphNode,
  type GraphNodeKind,
  type JsonValue,
  type SourceLocation,
} from "@codevis/shared";
import { discoverSolidityFiles, type DiscoverSolidityFilesOptions } from "./discover-solidity-files.js";

interface AstNode {
  readonly nodeType?: string;
  readonly name?: string;
  readonly src?: string;
  readonly nodes?: readonly AstNode[];
  readonly contractKind?: string;
  readonly abstract?: boolean;
  readonly baseContracts?: readonly { readonly baseName?: { readonly namePath?: string; readonly name?: string } }[];
  readonly visibility?: string;
  readonly stateMutability?: string;
  readonly kind?: string;
  readonly mutability?: string;
  readonly constant?: boolean;
  readonly stateVariable?: boolean;
  readonly typeDescriptions?: { readonly typeString?: string };
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
  readonly diagnostics: readonly SolidityDiagnostic[];
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

  for (const file of files) {
    const text = sourceTexts.get(file)!;
    nodes.push(createNode("file", path.posix.basename(file), file, 0, Buffer.byteLength(text), text, {}));
    const ast = output.sources?.[file]?.ast;
    if (ast) visitNodes(ast.nodes ?? [], file, text, nodes);
  }

  return {
    compilerVersion: solc.version(),
    files,
    nodes,
    diagnostics: (output.errors ?? []).map((diagnostic) => mapDiagnostic(diagnostic, sourceTexts)),
  };
}

function visitNodes(astNodes: readonly AstNode[], file: string, text: string, nodes: GraphNode[]): void {
  for (const ast of astNodes) {
    const mapped = mapAstNode(ast);
    if (mapped && ast.src) {
      const [start, length] = parseSrc(ast.src);
      nodes.push(createNode(mapped.kind, mapped.label, file, start, start + length, text, mapped.metadata));
    }
    if (ast.nodes) visitNodes(ast.nodes, file, text, nodes);
  }
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
