/** The source-preserving program representation used by the visual editor. */
export interface StudioSpan { file: string; start: number; end: number }
export interface StudioPort { id: string; label: string; type: string; span: StudioSpan; text: string }
export interface StudioNode {
  id: string; kind: string; label: string; text: string; span: StudioSpan;
  contractId: string; functionId: string; regionId: string;
  inputs: StudioPort[]; outputType: string; reusable: boolean;
  statement: boolean; execution?: boolean; opaque: boolean; effects: string[]; callTarget?: string;
}
export interface StudioEdge { id: string; source: string; target: string; kind: "execution" | "value" | "reference"; label: string; targetPort?: string }
export interface StudioRegion { id: string; ownerId: string; label: string; span: StudioSpan; statements: string[]; braced: boolean }
export interface StudioSymbol { id: string; name: string; kind: string; type: string; span: StudioSpan; contractId: string; functionId: string }
export interface StudioFunction { id: string; name: string; contractId: string; span: StudioSpan; bodyRegion: string; modifiers: string[]; callable?: StudioCallable }
export interface StudioContract { id: string; name: string; span: StudioSpan; insertAt: number; constructorInputs?: StudioAbiInput[] }
export interface StudioProgram {
  schemaVersion: 1; contracts: StudioContract[]; functions: StudioFunction[];
  nodes: StudioNode[]; edges: StudioEdge[]; regions: StudioRegion[]; symbols: StudioSymbol[];
}
export interface StudioDiagnostic { severity: "error" | "warning" | "info"; message: string; file?: string; start?: number; end?: number }
export interface StudioResult { revision: number; compilerVersion: string; sources: Record<string, string>; program: StudioProgram | null; diagnostics: StudioDiagnostic[] }
export type StudioEdit =
  | { kind: "replace"; nodeId: string; text: string; portId?: string }
  | { kind: "insert"; regionId: string; text: string; afterId?: string }
  | { kind: "declaration"; contractId: string; text: string }
  | { kind: "delete"; nodeId: string }
  | { kind: "connectValue"; sourceId: string; targetId: string; portId: string }
  | { kind: "connectExecution"; sourceId: string; targetId: string };
export interface StudioRequest { revision: number; sources: Record<string, string>; edit?: StudioEdit }
export interface StudioDraft { title: string; edit: StudioEdit; text: string; template?: string; fields?: Record<string, string> }
export interface StudioWorkspace { pendingEdit?: StudioDraft; schemaVersion: 1; sources: Record<string, string>; positions: Record<string, { x: number; y: number }> }

export function parseStudioWorkspace(value: unknown): StudioWorkspace {
  if (!value || typeof value !== "object") throw new Error("Invalid workspace file.");
  const data = value as Partial<StudioWorkspace>;
  if (data.schemaVersion !== 1 || !data.sources || typeof data.sources !== "object" || Array.isArray(data.sources) || !Object.entries(data.sources).length || Object.entries(data.sources).some(([name, source]) => !name.endsWith(".sol") || typeof source !== "string")) throw new Error("Workspace must contain Solidity source files (schema version 1).");
  const positions = data.positions ?? {};
  if (typeof positions !== "object" || Array.isArray(positions) || Object.values(positions).some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("Invalid canvas positions.");
  const draft = data.pendingEdit;
  if (draft !== undefined && (!draft || typeof draft !== "object" || typeof draft.title !== "string" || typeof draft.text !== "string" || !draft.edit || typeof draft.edit !== "object" || !["replace", "insert", "declaration", "delete", "connectValue", "connectExecution"].includes(draft.edit.kind) || (draft.template !== undefined && typeof draft.template !== "string") || (draft.fields !== undefined && (!draft.fields || typeof draft.fields !== "object" || Array.isArray(draft.fields) || Object.values(draft.fields).some(v => typeof v !== "string"))))) throw new Error("Invalid pending node edit.");
  return { schemaVersion: 1, sources: data.sources, positions, ...(draft ? { pendingEdit: draft } : {}) };
}

export const STUDIO_BLANK = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MyContract {
}

`;
export const STUDIO_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Vault {
    mapping(address => uint256) public balances;
    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        // Check before changing state.
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        // Update the balance before transferring control.
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }
}
`;

export interface StudioAbiInput { name: string; type: string; components?: StudioAbiInput[] }
export interface StudioCallable {
  kind: "function" | "constructor" | "receive" | "fallback";
  signature: string; inputs: StudioAbiInput[]; outputs: StudioAbiInput[];
  mutability: string; disabledReason?: string;
}
export interface StudioArtifact {
  abi: unknown[]; bytecode: string; sourceMap: string;
  deployedBytecode: string; deployedSourceMap: string;
}
export interface StudioBuild extends StudioResult { artifacts: Record<string, StudioArtifact>; sourceFiles: Record<number, string> }
export interface StudioRunRequest extends StudioRequest {
  contractId: string; functionId: string; args: string[]; constructorArgs: string[];
  caller: number; value: string; calldata?: string; sessionId?: string; requestId: string;
}
export interface StudioTraceStep { nodeId: string; functionId: string; edgeId?: string; source: StudioSpan; outcome?: "revert" | "return" }
export interface StudioRunResult {
  sessionId: string; contractAddress: string; accounts: string[]; functionId: string;
  status: "success" | "reverted"; transactionHash: string; gasUsed: string;
  returnValues: unknown[]; returnData: string; error?: string;
  events: { name: string; values: unknown[]; address: string }[];
  storage: { slot: string; before: string; after: string; expression: string }[];
  steps: StudioTraceStep[]; traceTruncated: boolean; unmappedSteps: number;
  messages: string[];
}
