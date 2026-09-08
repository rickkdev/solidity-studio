import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { STUDIO_VAULT } from "@codevis/shared";
import { analyzeStudio, generateStudio } from "./studio-compiler.js";
const analyze = (source: string) => analyzeStudio({ revision: 1, sources: { "Test.sol": source } });
const wrap = (body: string) => `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Test { uint256 public value; function run(uint256 amount) external returns(uint256) { ${body} } }`;

describe("source-preserving studio compiler", () => {
  it("imports a vault with typed values and preserves every source byte", () => {
    const result = analyze(STUDIO_VAULT);
    expect(result.program).not.toBeNull();
    expect(result.sources["Test.sol"]).toBe(STUDIO_VAULT);
    expect(result.program!.nodes.some(n => n.kind === "Parameter" && n.text === "amount" && n.outputType === "uint256")).toBe(true);
    expect(result.program!.edges.some(e => e.kind === "value" && e.targetPort)).toBe(true);
    expect(result.program!.nodes.some(n => n.effects.includes("External call / control leaves contract"))).toBe(true);
  });
  it("changes a check, recompiles, and retains comments and surrounding source", () => {
    const result = analyze(STUDIO_VAULT);
    const node = result.program!.nodes.find(n => n.text === "balances[msg.sender] >= amount")!;
    const changed = generateStudio({ revision: 2, sources: result.sources, edit: { kind: "replace", nodeId: node.id, text: "balances[msg.sender] > amount" } });
    expect(changed.program).not.toBeNull();
    expect(changed.sources["Test.sol"]).toBe(STUDIO_VAULT.replace("balances[msg.sender] >= amount", "balances[msg.sender] > amount"));
    expect(analyze(changed.sources["Test.sol"]!).program).toEqual(changed.program);
  });
  it("uses character offsets for Unicode source and preserves opaque assembly", () => {
    const source = wrap('// café 🌱\n assembly { mstore(0, 42) }\n value = amount; return value;');
    const result = analyze(source);
    const opaque = result.program!.nodes.find(n => n.opaque)!;
    expect(opaque.text).toBe("assembly { mstore(0, 42) }");
    expect(() => generateStudio({ revision: 2, sources: result.sources, edit: { kind: "replace", nodeId: opaque.id, text: "" } })).toThrow(/source editor/);
    const input = result.program!.nodes.find(n => n.text === "amount" && n.kind === "Identifier")!;
    const changed = generateStudio({ revision: 2, sources: result.sources, edit: { kind: "replace", nodeId: input.id, text: "amount + 1" } });
    expect(changed.sources["Test.sol"]).toBe(source.replace("value = amount", "value = amount + 1"));
    expect(changed.program).not.toBeNull();
  });
  it("preserves structured loops, update steps, break and continue paths", () => {
    const result = analyze(wrap('for (uint256 i = 0; i < amount; i++) { if (i == 2) continue; if (i == 4) break; value += i; } do { value++; } while (value < 10); while (false) { break; } return value;'));
    expect(result.program).not.toBeNull();
    expect(result.program!.nodes.some(n => n.text === "i++")).toBe(true);
    expect(result.program!.edges.some(e => e.label === "continue")).toBe(true);
    expect(result.program!.edges.some(e => e.label === "break")).toBe(true);
    expect(result.program!.edges.some(e => e.label === "body first")).toBe(true);
  });
  it("reorders siblings with their leading comments but rejects cross-region wires", () => {
    const source = wrap('\n // first\n value = 1;\n // second\n value = 2;\n if (amount > 0) { value = 3; }\n return value;');
    const result = analyze(source);
    const statements = result.program!.nodes.filter(n => n.statement);
    const first = statements.find(n => n.text === "value = 1")!;
    const second = statements.find(n => n.text === "value = 2")!;
    const changed = generateStudio({ revision: 2, sources: result.sources, edit: { kind: "connectExecution", sourceId: second.id, targetId: first.id } });
    expect(changed.program).not.toBeNull();
    expect(changed.sources["Test.sol"]).toMatch(/\/\/ second\s+value = 2;\s+\/\/ first\s+value = 1;/);
    expect(() => generateStudio({ revision: 2, sources: result.sources, edit: { kind: "connectExecution", sourceId: first.id, targetId: statements.find(n => n.text === "value = 3")!.id } })).toThrow(/structured body/);
  });
  it("validates wired types and does not duplicate effectful expressions", () => {
    const source = wrap('uint256 x = 1; bool good = true; value = x; return value;');
    const result = analyze(source);
    const boolean = result.program!.nodes.find(n => n.text === "true")!;
    const assignment = result.program!.nodes.find(n => n.kind === "Assignment")!;
    const invalid = generateStudio({ revision: 2, sources: result.sources, edit: { kind: "connectValue", sourceId: boolean.id, targetId: assignment.id, portId: "rightHandSide" } });
    expect(invalid.program).toBeNull();
    expect(invalid.diagnostics.some(d => d.severity === "error")).toBe(true);
    const vault = analyze(STUDIO_VAULT);
    const call = vault.program!.nodes.find(n => n.kind === "FunctionCall" && n.text.includes('.call{'))!;
    expect(call.reusable).toBe(false);
    expect(() => generateStudio({ revision: 2, sources: vault.sources, edit: { kind: "connectValue", sourceId: call.id, targetId: call.id, portId: "expression" } })).toThrow(/execute once/);
  });
  it("authors declarations and statements in an empty contract", () => {
    let result = analyze('// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Test {}');
    for (const text of ["uint256 public value;", "function set(uint256 amount) external {}"])
      result = generateStudio({ revision: 2, sources: result.sources, edit: { kind: "declaration", contractId: result.program!.contracts[0]!.id, text } });
    result = generateStudio({ revision: 3, sources: result.sources, edit: { kind: "insert", regionId: result.program!.functions[0]!.bodyRegion, text: "value = amount;" } });
    expect(result.program).not.toBeNull();
    expect(result.program!.nodes.some(n => n.kind === "Assignment")).toBe(true);
  });
  it("retains source and gives diagnostics for syntax errors, imports and pragma mismatches", () => {
    for (const source of ["contract {", "pragma solidity 0.7.0; contract Test {}", 'pragma solidity ^0.8.20; import "Missing.sol"; contract Test {}']) {
      const result = analyze(source); expect(result.program).toBeNull(); expect(result.sources["Test.sol"]).toBe(source); expect(result.diagnostics.some(d => d.severity === "error")).toBe(true);
    }
    const result = analyzeStudio({ revision: 1, sources: { "Test.sol": 'pragma solidity ^0.8.20; import "./lib/Base.sol"; contract Test is Base {}', "lib/Base.sol": "pragma solidity ^0.8.20; contract Base {}" } });
    expect(result.program).not.toBeNull();
  });
  it("preserves expression precedence when wiring a composite value", () => {
    const result = analyze(wrap('uint256 x = amount + 1; value = amount * 2; return x + value;'));
    const from = result.program!.nodes.find(n => n.kind === "BinaryOperation" && n.text === "amount + 1")!;
    const to = result.program!.nodes.find(n => n.kind === "BinaryOperation" && n.text === "amount * 2")!;
    const changed = generateStudio({ revision: 2, sources: result.sources, edit: { kind: "connectValue", sourceId: from.id, targetId: to.id, portId: "rightExpression" } });
    expect(changed.program).not.toBeNull();
    expect(changed.sources["Test.sol"]).toContain("amount * (amount + 1)");
  });
  it("resolves overloaded calls using compiler references", () => {
    const result = analyze('pragma solidity ^0.8.20; contract Test { function f(uint256 n) internal pure returns(uint256) {return n;} function f(bool n) internal pure returns(bool) {return n;} function run() external pure returns(bool) {return f(true);} }');
    const call = result.program!.nodes.find(n => n.kind === "FunctionCall" && n.text === "f(true)")!;
    expect(result.program!.functions.find(f => f.id === call.callTarget)?.name).toBe("f(bool)");
  });
  it("connects the Coin sample's functions and declaration overview", async () => {
    const source = await readFile(new URL("../test/fixtures/studio/Coin.sol", import.meta.url), "utf8");
    const result = analyze(source);
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    expect(result.sources["Test.sol"]).toBe(source);
    for (const [name, count] of [["constructor()", 2], ["mint(address,uint256)", 4], ["send(address,uint256)", 6]] as const) {
      const fn = result.program!.functions.find(f => f.name === name)!;
      const ids = new Set(result.program!.nodes.filter(n => n.functionId === fn.id).map(n => n.id));
      const edges = result.program!.edges.filter(e => e.kind === "execution" && ids.has(e.source) && ids.has(e.target));
      expect(edges).toHaveLength(count);
      expect(edges.some(e => e.target === `${fn.id}/entry/complete`)).toBe(true);
    }
    const references = result.program!.edges.filter(e => e.kind === "reference");
    expect(references).toHaveLength(6);
    expect(references.some(e => e.label === "emits")).toBe(true);
    expect(references.some(e => e.label === "error type")).toBe(true);
  });
  it("does not read arbitrary filesystem paths", () => {
    expect(() => analyzeStudio({ revision: 1, sources: { "../Secret.sol": "contract Secret {}" } })).toThrow(/relative/);
    const result = analyze('pragma solidity ^0.8.20; import "/etc/passwd"; contract Test {}');
    expect(result.program).toBeNull();
  });
});

it("compiles and edits multi-file projects using preserved import remappings", () => {
  const sources = {
    'src/Counter.sol': '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.26; import {Math} from "@math/Math.sol"; contract Counter { function sum(uint256 amount) public pure returns(uint256) { return Math.add(amount, 1); } }',
    'lib/math/Math.sol': '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.26; library Math { function add(uint256 a, uint256 b) internal pure returns(uint256) { return a + b; } }',
  };
  const request = { revision: 1, sources, remappings: ['@math/=lib/math/'] };
  const result = analyzeStudio(request);
  expect(result.program).not.toBeNull();
  const node = result.program!.nodes.find(n => n.kind === 'Return' && n.text.includes('Math.add'))!;
  const changed = generateStudio({ ...request, edit: { kind: 'replace', nodeId: node.id, text: 'return Math.add(amount, 2)' } });
  expect(changed.program).not.toBeNull();
  expect(changed.remappings).toEqual(request.remappings);
  expect(changed.sources['lib/math/Math.sol']).toBe(sources['lib/math/Math.sol']);
  expect(changed.sources['src/Counter.sol']).toContain('Math.add(amount, 2)');
});
