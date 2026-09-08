import { validateStudioRemappings } from "./studio.js";
import { Interface, type ParamType } from "ethers";
import type { StudioDiagnostic, StudioEdit, StudioNode, StudioProgram, StudioRequest, StudioResult, StudioSpan, StudioBuild, StudioAbiInput, StudioCallable } from "./studio.js";

export function createStudioCompiler(solc: { compile: (source: string) => string; version: () => string }) {
// solc's JSON AST is heterogeneous. Narrow its fields at the compiler boundary.
type Ast = { nodeType: string; id: number; src: string; [key: string]: any };
const expressionKeys = ["expression", "leftExpression", "rightExpression", "leftHandSide", "rightHandSide", "baseExpression", "indexExpression", "condition", "trueExpression", "falseExpression", "subExpression", "initialValue", "eventCall", "errorCall", "arguments", "components", "options"];
const supportedStatements = new Set(["ExpressionStatement", "VariableDeclarationStatement", "IfStatement", "ForStatement", "WhileStatement", "DoWhileStatement", "Return", "EmitStatement", "RevertStatement", "Break", "Continue"]);
const supportedExpressions = new Set(["Identifier", "Literal", "MemberAccess", "IndexAccess", "BinaryOperation", "UnaryOperation", "Assignment", "FunctionCall", "FunctionCallOptions", "TupleExpression", "Conditional", "ElementaryTypeNameExpression"]);
const emptyProgram = (): StudioProgram => ({ schemaVersion: 1, contracts: [], functions: [], nodes: [], edges: [], regions: [], symbols: [] });

function validateSources(sources: unknown): asserts sources is Record<string, string> {
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) throw new Error("Sources must be a file map.");
  const entries = Object.entries(sources);
  if (!entries.length || entries.length > 100) throw new Error("Supply between 1 and 100 Solidity files.");
  if (entries.some(([name, source]) => !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\x00]+\.sol$/.test(name) || typeof source !== "string")) throw new Error("Use relative .sol paths and text sources.");
  if (entries.reduce((sum, [, source]) => sum + new TextEncoder().encode(source as string).length, 0) > 2_000_000) throw new Error("Workspace exceeds the 2 MB source limit.");
}

function analyzeStudio(request: StudioRequest): StudioResult {
  validateSources(request.sources);
  validateStudioRemappings(request.remappings);
  if (!Number.isSafeInteger(request.revision) || request.revision < 0) throw new Error("Invalid revision.");
  const sources = Object.fromEntries(Object.entries(request.sources).map(([name, content]) => [name, { content }]));
  const output = compileSources(sources, request.remappings);
  const diagnostics: StudioDiagnostic[] = (output.errors ?? []).map((error: any) => {
    const loc = error.sourceLocation;
    const text = loc && request.sources[loc.file];
    return { severity: error.severity, message: error.formattedMessage ?? error.message, ...(text !== undefined && loc.start >= 0 ? { file: loc.file, start: charOffset(text, loc.start), end: charOffset(text, loc.end) } : {}) };
  });
  const result: StudioResult = { ...(request.remappings ? { remappings: request.remappings } : {}), revision: request.revision, compilerVersion: solc.version(), sources: request.sources, diagnostics, program: null };
  if (diagnostics.some(d => d.severity === "error")) return result;
  const program = emptyProgram();
  const declarations = new Map<number, Ast>();
  const functionIds = new Map<number, string>();
  const callReferences = new Map<string, number>();
  const declarationNodes = new Map<number, string>();
  const overviewReferences = new Map<string, Set<number>>();
  function walk(value: any, visit: (ast: Ast) => void) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(v => walk(v, visit)); return; }
    if (value.nodeType) visit(value);
    Object.values(value).forEach(v => { if (v && typeof v === "object") walk(v, visit); });
  }
  Object.values(output.sources).forEach((source: any) => walk(source.ast, ast => declarations.set(ast.id, ast)));
  for (const [file, compiled] of Object.entries(output.sources) as [string, any][]) {
    const source = request.sources[file]!;
    const span = (ast: Ast): StudioSpan => {
      const [start, length] = ast.src.split(":").map(Number) as [number, number];
      return { file, start: charOffset(source, start), end: charOffset(source, start + length) };
    };
    const snippet = (ast: Ast) => { const s = span(ast); return source.slice(s.start, s.end); };
    const idCounts = new Map<string, number>();
    function stable(prefix: string, ast: Ast): string {
      // Source-content identity survives unrelated edits; duplicate occurrences get a suffix.
      let hash = 2166136261;
      for (const char of snippet(ast)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      const key = `${prefix}/${ast.nodeType}:${(hash >>> 0).toString(36)}`;
      const count = idCounts.get(key) ?? 0; idCounts.set(key, count + 1);
      return `${key}:${count}`;
    }
    for (const contract of compiled.ast.nodes.filter((n: Ast) => n.nodeType === "ContractDefinition")) {
      const cid = `${file}:${contract.name}`;
      const cs = span(contract);
      const iface = new Interface(output.contracts?.[file]?.[contract.name]?.abi ?? []);
      program.contracts.push({ id: cid, name: contract.name, span: cs, insertAt: cs.end - 1, constructorInputs: iface.deploy.inputs.map(abiInput) });
      for (const base of (contract.baseContracts ?? []) as Ast[]) program.nodes.push({ id: stable(cid, base), kind: "Source block", label: `Inherits ${snippet(base)}`, text: snippet(base), span: span(base), contractId: cid, functionId: "", regionId: "", inputs: [], outputType: "", reusable: false, statement: false, opaque: true, effects: ["Inherited behavior is preserved; inspect the base contract source."] });
      walk(contract, ast => {
        if (ast.nodeType === "VariableDeclaration") program.symbols.push({ id: String(ast.id), name: ast.name, kind: ast.stateVariable ? "state" : "local / parameter", type: ast.typeDescriptions?.typeString ?? "unknown", span: span(ast), contractId: cid, functionId: "" });
      });
      const functionCounts = new Map<string, number>();
      for (const member of contract.nodes as Ast[]) {
        if (member.nodeType !== "FunctionDefinition") {
          const supported = member.nodeType === "VariableDeclaration" || member.nodeType === "EventDefinition" || member.nodeType === "ErrorDefinition";
          const declarationId = stable(cid, member); declarationNodes.set(member.id, declarationId);
          program.nodes.push({ id: declarationId, kind: supported ? member.nodeType.replace("Definition", "").replace("VariableDeclaration", "State") : "Source block", label: member.name || member.nodeType, text: snippet(member), span: span(member), contractId: cid, functionId: "", regionId: "", inputs: [], outputType: member.typeDescriptions?.typeString ?? "", reusable: false, statement: false, opaque: !supported, effects: supported ? [] : ["Preserved source; effects are not modeled"] });
          continue;
        }
        const signature = `${member.name || member.kind}(${member.parameters.parameters.map((p: Ast) => p.typeDescriptions?.typeString).join(",")})`;
        const count = functionCounts.get(signature) ?? 0; functionCounts.set(signature, count + 1);
        const fid = `${cid}/${signature}:${count}`;
        functionIds.set(member.id, fid);
        const modifiers = (member.modifiers ?? []).map((m: Ast) => snippet(m));
        const abiFunction = member.functionSelector ? iface.getFunction(`0x${member.functionSelector}`) : null;
        const callable: StudioCallable = {
          kind: member.kind, signature: abiFunction?.format("sighash") ?? member.kind,
          inputs: abiFunction ? abiFunction.inputs.map(abiInput) : member.kind === "constructor" ? iface.deploy.inputs.map(abiInput) : [],
          outputs: abiFunction?.outputs.map(abiInput) ?? [], mutability: member.stateMutability,
          ...(!["public", "external"].includes(member.visibility) && member.kind === "function" ? { disabledReason: `${member.visibility} function — execute it through a public or external caller.` } : {}),
        };
        const fn = { id: fid, name: signature, contractId: cid, span: span(member), bodyRegion: "", modifiers, callable };
        program.functions.push(fn);
        program.symbols.filter(s => s.contractId === cid && s.span.start >= fn.span.start && s.span.end <= fn.span.end).forEach(s => { s.functionId = fid; });
        const startId = `${fid}/entry`;
        const references = new Set<number>();
        walk(member.body, ast => { if (typeof ast.referencedDeclaration === "number") references.add(ast.referencedDeclaration); });
        overviewReferences.set(startId, references);
        const startSpan = span(member); startSpan.end = member.body ? span(member.body).start : startSpan.end;
        program.nodes.push({ id: startId, kind: "Entry", label: signature, text: source.slice(startSpan.start, startSpan.end), span: startSpan, contractId: cid, functionId: fid, regionId: "", inputs: [], outputType: "", reusable: false, statement: false, opaque: false, effects: modifiers.length ? [`Modifier boundary: ${modifiers.join(", ")}. Body flow excludes modifier execution.`] : [] });
        for (const symbol of program.symbols.filter(s => s.contractId === cid && (s.kind === "state" || s.functionId === fid) && !!s.name)) {
          const ast = declarations.get(Number(symbol.id));
          const symbolSpan = ast?.nameLocation ? span({ ...ast, src: ast.nameLocation }) : symbol.span;
          program.nodes.push({ id: `${fid}/symbol/${symbol.name}`, kind: symbol.kind === "state" ? "State read" : symbol.span.end <= startSpan.end ? "Parameter" : "Local read", label: symbol.name, text: symbol.name, span: symbolSpan, contractId: cid, functionId: fid, regionId: "", inputs: [], outputType: symbol.type, reusable: true, statement: false, opaque: false, effects: symbol.kind === "state" ? [`Reads state: ${symbol.name}`] : [] });
        }
        if (!member.body) continue;
        const addEdge = (from: string, to: string, label = "next", kind: "execution" | "value" = "execution", targetPort?: string) => {
          program.edges.push({ id: `${from}>${to}:${label}:${targetPort ?? ""}`, source: from, target: to, kind, label, ...(targetPort ? { targetPort } : {}) });
        };
        function isReusable(ast: Ast): boolean {
          if (["FunctionCall", "Assignment", "NewExpression"].includes(ast.nodeType) || (ast.nodeType === "UnaryOperation" && ["++", "--", "delete"].includes(ast.operator))) return false;
          return expressionChildren(ast).every(({ child }) => isReusable(child));
        }
        function effects(ast: Ast): string[] {
          const found = new Set<string>();
          walk(ast, item => {
            if (item.nodeType === "Identifier" && declarations.get(item.referencedDeclaration)?.stateVariable) found.add(`State access: ${item.name}`);
            if (item.nodeType === "Assignment" || (item.nodeType === "UnaryOperation" && ["++", "--", "delete"].includes(item.operator))) {
              const target = item.leftHandSide ?? item.subExpression;
              let state = false; walk(target, n => { if (declarations.get(n.referencedDeclaration)?.stateVariable) state = true; });
              found.add(state ? "Writes state" : "Writes local value");
            }
            if (item.nodeType === "FunctionCall") {
              const callee = item.expression?.nodeType === "FunctionCallOptions" ? item.expression.expression : item.expression;
              const type = `${callee?.typeDescriptions?.typeString ?? ""} ${callee?.typeDescriptions?.typeIdentifier ?? ""}`;
              if (/external|barecall|send|transfer|delegatecall|staticcall/.test(type)) found.add("External call / control leaves contract");
              else if (["require", "assert", "revert"].includes(callee?.name)) found.add("May revert");
              else if (item.kind !== "typeConversion") found.add("Function call");
            }
            if (item.nodeType === "EmitStatement") found.add("Emits event");
          });
          return [...found];
        }
        function makeNode(ast: Ast, regionId: string, statement: boolean): StudioNode {
          const id = stable(fid, ast);
          const opaque = statement ? !supportedStatements.has(ast.nodeType) : !supportedExpressions.has(ast.nodeType);
          const node: StudioNode = { id, kind: opaque ? "Source block" : ast.nodeType.replace("Statement", ""), label: snippet(ast).split("\n")[0]!.slice(0, 110), text: snippet(ast), span: span(ast), contractId: cid, functionId: fid, regionId, inputs: [], outputType: ast.typeDescriptions?.typeString ?? "", reusable: !statement && !opaque && isReusable(ast), statement, opaque, effects: opaque ? ["Preserved source; effects are not modeled"] : effects(ast) };
          const inputAst = ast.nodeType === "ExpressionStatement" ? ast.expression : ast.nodeType === "EmitStatement" ? ast.eventCall : ast;
          if (inputAst.nodeType === "FunctionCall") {
            const callee = inputAst.expression?.nodeType === "FunctionCallOptions" ? inputAst.expression.expression : inputAst.expression;
            if (typeof callee?.referencedDeclaration === "number") callReferences.set(id, callee.referencedDeclaration);
          }
          if (ast.nodeType === "ExpressionStatement" && inputAst.nodeType === "Assignment") node.kind = "Assignment";
          if (ast.nodeType === "ExpressionStatement" && inputAst.nodeType === "FunctionCall") {
            node.kind = ["require", "assert"].includes(inputAst.expression?.name) ? "Check" : "Call";
          }
          program.nodes.push(node);
          const children = expressionChildren(inputAst).filter(({ key }) => !(inputAst.nodeType === "FunctionCall" && key === "expression" && inputAst.expression?.nodeType === "Identifier"));
          if (!opaque) for (const { key, child } of children) {
            const input = { id: key, label: node.kind === "Check" && key.startsWith("arguments:") ? (key === "arguments:0" ? "condition" : "message") : key.replace(/Expression|HandSide/g, ""), type: child.typeDescriptions?.typeString ?? "expression", span: span(child), text: snippet(child) };
            if (ast.nodeType === "DoWhileStatement" && key === "condition") continue;
            node.inputs.push(input);
            const childNode = makeNode(child, regionId, false);
            addEdge(childNode.id, id, input.type, "value", key);
          }
          return node;
        }
        function region(body: Ast, owner: string, label: string, incoming: string, loop?: { breakTo: string; continueTo: string }): { id: string; exits: string[] } {
          const braced = body.nodeType === "Block";
          const rid = `${owner}/${label}`;
          const rs = span(body);
          program.regions.push({ id: rid, ownerId: owner, label, span: rs, statements: [], braced });
          const r = program.regions.at(-1)!;
          let exits = [incoming];
          for (const ast of (braced ? body.statements : [body]) as Ast[]) {
            const node = makeNode(ast, rid, true); r.statements.push(node.id);
            exits.forEach(from => addEdge(from, node.id, from === incoming ? label : "next"));
            exits = [node.id];
            if (ast.nodeType === "IfStatement") {
              const yes = region(ast.trueBody, node.id, "true", node.id, loop);
              const no = ast.falseBody ? region(ast.falseBody, node.id, "false", node.id, loop) : null;
              const join = junction(node, "join");
              yes.exits.forEach(id => addEdge(id, join));
              if (no) no.exits.forEach(id => addEdge(id, join)); else addEdge(node.id, join, "false");
              exits = yes.exits.length || !no || no.exits.length ? [join] : [];
            } else if (["ForStatement", "WhileStatement", "DoWhileStatement"].includes(ast.nodeType)) {
              const exit = junction(node, "exit");
              let condition = node.id;
              if (ast.nodeType === "ForStatement" && ast.initializationExpression) {
                const init = makeNode(ast.initializationExpression, "", false); init.execution = true;
                // Enter the loop through initialization, including on a predecessor branch.
                program.edges.filter(e => e.kind === "execution" && e.target === node.id).forEach(e => { e.target = init.id; });
                addEdge(init.id, node.id, "initialized");
              }
              let update = node.id;
              if (ast.nodeType === "ForStatement" && ast.loopExpression) { const updateNode = makeNode(ast.loopExpression, "", false); updateNode.execution = true; update = updateNode.id; addEdge(update, node.id, "condition"); }
              if (ast.nodeType === "DoWhileStatement") {
                condition = junction(node, "condition");
                update = condition;
                const conditionNode = makeNode(ast.condition, rid, false);
                const junctionNode = program.nodes.find(n => n.id === condition)!; junctionNode.execution = true; junctionNode.span = span(ast.condition);
                junctionNode.inputs.push({ id: "condition", label: "condition", type: "bool", span: span(ast.condition), text: snippet(ast.condition) });
                addEdge(conditionNode.id, condition, "bool", "value", "condition");
              }
              const inner = region(ast.body, node.id, ast.nodeType === "DoWhileStatement" ? "body first" : "true", node.id, { breakTo: exit, continueTo: update });
              inner.exits.forEach(id => addEdge(id, update, "loop"));
              if (ast.nodeType === "DoWhileStatement") { addEdge(condition, node.id, "true"); }
              addEdge(condition, exit, "false"); exits = [exit];
            } else if (ast.nodeType === "Break" || ast.nodeType === "Continue") {
              if (loop) addEdge(node.id, ast.nodeType === "Break" ? loop.breakTo : loop.continueTo, ast.nodeType.toLowerCase());
              exits = [];
            } else if (ast.nodeType === "Return" || ast.nodeType === "RevertStatement" || (ast.nodeType === "ExpressionStatement" && ast.expression?.expression?.name === "revert")) exits = [];
            else if (ast.nodeType === "ExpressionStatement" && ["require", "assert"].includes(ast.expression?.expression?.name)) {
              const failure = junction(node, "revert"); addEdge(node.id, failure, "false / revert");
            }
          }
          return { id: rid, exits };
        }
        function junction(parent: StudioNode, kind: string) {
          const id = `${parent.id}/${kind}`;
          program.nodes.push({ ...parent, id, kind, label: kind === "condition" ? "Evaluate loop condition" : kind, text: "", inputs: [], outputType: "", statement: false, reusable: false, effects: [] });
          return id;
        }
        const body = region(member.body, fid, "body", startId);
        fn.bodyRegion = body.id;
        if (body.exits.length) {
          const entry = program.nodes.find(n => n.id === startId)!;
          const end = junction(entry, "complete");
          const endNode = program.nodes.find(n => n.id === end)!;
          endNode.kind = "Return"; endNode.label = "Function completes"; endNode.span = { file: fn.span.file, start: fn.span.end - 1, end: fn.span.end };
          body.exits.forEach(from => addEdge(from, end));
        }
      }
    }
  }
  for (const node of program.nodes) { const reference = callReferences.get(node.id); const target = reference === undefined ? undefined : functionIds.get(reference); if (target) node.callTarget = target; }
  for (const [source, references] of overviewReferences) for (const reference of references) {
    const declaration = declarations.get(reference);
    const target = declarationNodes.get(reference) ?? (functionIds.has(reference) ? `${functionIds.get(reference)}/entry` : undefined);
    if (!target || !declaration) continue;
    const label = declaration.stateVariable ? "uses state" : declaration.nodeType === "EventDefinition" ? "emits" : declaration.nodeType === "ErrorDefinition" ? "error type" : declaration.nodeType === "FunctionDefinition" ? "calls" : "uses declaration";
    program.edges.push({ id: `${source}>${target}:reference`, source, target, kind: "reference", label });
  }
  result.program = program;
  return result;
}

function expressionChildren(ast: Ast): { key: string; child: Ast }[] {
  const result: { key: string; child: Ast }[] = [];
  for (const key of expressionKeys) {
    const value = ast[key];
    if (Array.isArray(value)) value.forEach((child, i) => { if (child?.nodeType) result.push({ key: `${key}:${i}`, child }); });
    else if (value?.nodeType) result.push({ key, child: value });
  }
  return result;
}
function charOffset(source: string, bytes: number): number { return new TextDecoder().decode(new TextEncoder().encode(source).subarray(0, bytes)).length; }

function generateStudio(request: StudioRequest): StudioResult {
  const base = analyzeStudio(request);
  if (!base.program) throw new Error("Fix source diagnostics before editing nodes.");
  const edit = request.edit;
  if (!edit || typeof edit !== "object") throw new Error("An edit is required.");
  const program = base.program;
  const find = (id: string) => { const n = program.nodes.find(n => n.id === id); if (!n) throw new Error("Node no longer exists. Refresh the workspace."); return n; };
  const patches: { span: StudioSpan; text: string }[] = [];
  const patch = (span: StudioSpan, text: string) => { if (typeof text !== "string") throw new Error("Edit text must be a string."); patches.push({ span, text }); };
  const editable = (node: StudioNode) => { if (node.opaque || !node.text) throw new Error("Edit preserved source blocks in the source editor."); };
  switch (edit.kind) {
    case "replace": {
      const n = find(edit.nodeId); editable(n);
      const target = edit.portId ? n.inputs.find(p => p.id === edit.portId)?.span : n.span;
      if (!target) throw new Error("Input port not found.");
      // Compiler ranges often omit the trailing semicolon. Keep it outside the patch.
      const parent = edit.portId ? n : program.nodes.find(parent => program.edges.some(edge => edge.kind === "value" && edge.source === n.id && edge.target === parent.id));
      const original = request.sources[target.file]!.slice(target.start, target.end);
      const protect = parent && ["BinaryOperation", "UnaryOperation", "MemberAccess", "IndexAccess"].includes(parent.kind);
      patch(target, protect && edit.text !== original ? `(${edit.text})` : edit.text); break;
    }
    case "delete": {
      const n = find(edit.nodeId); editable(n);
      if (!n.statement && n.functionId) throw new Error("Delete a statement, not a required expression or entrypoint.");
      patch(statementSpan(n, request.sources), ""); break;
    }
    case "insert": {
      const r = program.regions.find(r => r.id === edit.regionId);
      if (!r || !r.braced) throw new Error("Choose a braced function, branch, or loop body. Add braces in source for single-statement bodies.");
      let at = r.span.end - 1;
      if (edit.afterId) { const n = find(edit.afterId); if (n.regionId !== r.id || !n.statement) throw new Error("Insertion point must be a statement in this region."); at = statementSpan(n, request.sources).end; }
      patch({ file: r.span.file, start: at, end: at }, `\n        ${edit.text}\n    `); break;
    }
    case "declaration": {
      const c = program.contracts.find(c => c.id === edit.contractId);
      if (!c) throw new Error("Contract not found.");
      patch({ file: c.span.file, start: c.insertAt, end: c.insertAt }, `\n    ${edit.text}\n`); break;
    }
    case "connectValue": {
      const from = find(edit.sourceId), to = find(edit.targetId); editable(to);
      if (!from.reusable || from.functionId !== to.functionId) throw new Error("Only reusable expressions in the same function can be wired. Calls and assignments execute once and cannot be copied.");
      const input = to.inputs.find(p => p.id === edit.portId);
      if (!input) throw new Error("Input port not found.");
      if (from.span.start <= to.span.start && from.span.end >= to.span.end) throw new Error("A value cannot depend on itself.");
      patch(input.span, ["BinaryOperation", "UnaryOperation", "Conditional", "TupleExpression"].includes(from.kind) ? `(${from.text})` : from.text); break; // solc is the authority for scope and implicit conversions.
    }
    case "connectExecution": {
      const from = find(edit.sourceId), to = find(edit.targetId);
      editable(from); editable(to);
      const fn = program.functions.find(f => `${f.id}/entry` === from.id);
      const r = program.regions.find(r => r.id === (fn?.bodyRegion ?? from.regionId));
      if (!r || !r.braced || to.regionId !== r.id || !to.statement || (!fn && !from.statement) || from.id === to.id) throw new Error("Execution connections reorder sibling statements in one structured body. Branches and loops keep their boundaries.");
      if (["Return", "Revert", "Break", "Continue"].includes(from.kind)) throw new Error("Cannot connect execution after a terminal statement.");
      const targetSpan = attachedStatementSpan(to, request.sources);
      const index = r.statements.indexOf(to.id);
      const previous = index > 0 ? find(r.statements[index - 1]!) : undefined;
      const leadingStart = previous ? attachedStatementSpan(previous, request.sources).end : r.span.start + 1;
      const movedSpan = { ...targetSpan, start: leadingStart };
      const text = request.sources[targetSpan.file]!.slice(movedSpan.start, movedSpan.end);
      const at = fn ? r.span.start + 1 : attachedStatementSpan(from, request.sources).end;
      if (at === leadingStart || at === targetSpan.end) return base;
      patch(movedSpan, ""); patch({ ...targetSpan, start: at, end: at }, text); break;
    }
    default: throw new Error("Unknown edit operation.");
  }
  const sources = { ...request.sources };
  for (const p of patches.sort((a, b) => b.span.start - a.span.start)) sources[p.span.file] = sources[p.span.file]!.slice(0, p.span.start) + p.text + sources[p.span.file]!.slice(p.span.end);
  return analyzeStudio({ ...request, sources });
}
function statementSpan(node: StudioNode, sources: Record<string, string>): StudioSpan {
  const span = { ...node.span }; const source = sources[span.file]!;
  if (source[span.end] === ";") span.end++;
  return span;
}

function attachedStatementSpan(node: StudioNode, sources: Record<string, string>): StudioSpan {
  const span = statementSpan(node, sources);
  const trailing = sources[span.file]!.slice(span.end).match(/^[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/);
  if (trailing) span.end += trailing[0].length;
  return span;
}

function abiInput(input: ParamType): StudioAbiInput {
  const tuple = input.baseType === "array" ? input.arrayChildren : input;
  return { name: input.name, type: input.type, ...(tuple?.components ? { components: tuple.components.map(abiInput) } : {}) };
}
function compileSources(sources: Record<string, { content: string }>, remappings: string[] = [], runtime = false) {
  const legacy = solc.version().startsWith("0.7.");
  return JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings: { remappings, evmVersion: legacy ? "istanbul" : "cancun", ...(runtime && legacy ? { optimizer: { enabled: true, runs: 200 } } : {}), outputSelection: { "*": { "": ["ast"], "*": runtime ? ["abi", "evm.bytecode.object", "evm.bytecode.sourceMap", "evm.deployedBytecode.object", "evm.deployedBytecode.sourceMap"] : ["abi"] } } } })));
}
function buildStudioRuntime(request: StudioRequest): StudioBuild {
  const analysis = analyzeStudio(request);
  if (!analysis.program) throw new Error(analysis.diagnostics.filter(d => d.severity === "error").map(d => d.message).join("\n"));
  const output = compileSources(Object.fromEntries(Object.entries(request.sources).map(([file, content]) => [file, { content }])), request.remappings, true);
  if (output.errors?.some((error: { severity: string }) => error.severity === "error")) throw new Error(output.errors.filter((error: { severity: string }) => error.severity === "error").map((error: { formattedMessage: string }) => error.formattedMessage).join("\n"));
  const artifacts: StudioBuild["artifacts"] = {};
  for (const contract of analysis.program.contracts) {
    const artifact = output.contracts[contract.span.file][contract.name];
    artifacts[contract.id] = { abi: artifact.abi, bytecode: artifact.evm.bytecode.object, sourceMap: artifact.evm.bytecode.sourceMap, deployedBytecode: artifact.evm.deployedBytecode.object, deployedSourceMap: artifact.evm.deployedBytecode.sourceMap };
  }
  return { ...analysis, artifacts, sourceFiles: Object.fromEntries(Object.entries(output.sources).map(([file, source]) => [(source as { id: number }).id, file])) };
}

return { analyzeStudio, generateStudio, buildStudioRuntime };
}
