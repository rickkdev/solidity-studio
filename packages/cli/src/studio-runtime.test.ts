import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { buildStudioRuntime } from "./studio-compiler.js";
import { createStudioRuntime } from "./studio-runtime.js";
import { instructionSources } from "./studio-trace.js";
import type { StudioRunRequest } from "@codevis/shared";
const A2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const A3 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

it("maps compressed source entries by instruction index, skipping PUSH immediate bytes", () => {
  const map = instructionSources("610102600100", "3:4:0;:2;9::");
  expect([...map.entries()]).toEqual([[0, { start: 3, length: 4, file: 0 }], [3, { start: 3, length: 2, file: 0 }], [5, { start: 9, length: 2, file: 0 }]]);
});

it("runs Coin with persistent state, caller inputs, event/revert decoding, actual traces and reset", async () => {
  const sources = { "Coin.sol": await readFile(new URL("../test/fixtures/studio/Coin.sol", import.meta.url), "utf8") };
  const build = buildStudioRuntime({ revision: 1, sources });
  const runtime = createStudioRuntime(async () => build);
  const request = (name: string, args: string[], sessionId?: string, caller = 0): StudioRunRequest => ({ revision: 1, sources, contractId: build.program!.contracts[0]!.id, functionId: build.program!.functions.find(f => f.name.startsWith(name + "("))!.id, requestId: randomUUID(), args, constructorArgs: [], caller, value: "0", ...(sessionId ? { sessionId } : {}) });
  try {
    const mintRequest = request("mint", [A2, "100"]);
    const mint = await runtime.run(mintRequest);
    expect(mint.status).toBe("success");
    expect(mint.messages.some(m => m.includes("trace details unavailable"))).toBe(false);
    expect(mint.storage.map(change => BigInt(change.after))).toContain(100n);
    expect(mint.steps.map(step => build.program!.nodes.find(n => n.id === step.nodeId)?.kind)).toEqual(["Entry", "Check", "Assignment", "Return"]);
    expect((await runtime.run(mintRequest)).transactionHash).toBe(mint.transactionHash);
    const send = await runtime.run(request("send", [A3, "40"], mint.sessionId, 1));
    expect(send.status).toBe("success");
    expect(send.events[0]?.name).toBe("Sent");
    expect(send.events[0]?.values).toEqual([A2, A3, "40"]);
    expect(send.storage.map(change => [BigInt(change.before), BigInt(change.after)])).toContainEqual([100n, 60n]);
    expect(send.steps.some(step => build.program!.nodes.find(n => n.id === step.nodeId)?.kind === "Emit")).toBe(true);
    const revert = await runtime.run(request("send", [A3, "70"], mint.sessionId, 1));
    expect(revert.status).toBe("reverted");
    expect(revert.error).toBe("InsufficientBalance(70, 60)");
    expect(revert.steps.at(-1)?.outcome).toBe("revert");
    expect(revert.steps.some(step => build.program!.nodes.find(n => n.id === step.nodeId)?.kind === "Emit")).toBe(false);
    expect(revert.storage).toEqual([]);
    const rest = await runtime.run(request("send", [A3, "60"], mint.sessionId, 1));
    expect(rest.status).toBe("success");
    const unauthorized = await runtime.run(request("mint", [A2, "1"], mint.sessionId, 1));
    expect(unauthorized.status).toBe("reverted");
    runtime.reset(mint.sessionId);
    await expect(runtime.run(request("mint", [A2, "1"], mint.sessionId))).rejects.toThrow(/expired/);
    const fresh = await runtime.run(request("mint", [A2, "1"]));
    expect(fresh.storage.map(change => [BigInt(change.before), BigInt(change.after)])).toContainEqual([0n, 1n]);
  } finally { await runtime.close(); }
}, 30_000);

it("handles constructor/array/boolean inputs, returns, loops and internal calls without lighting untaken branches", async () => {
  const sources = { "Flow.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Flow {
 uint256 public value;
 constructor(uint256 initial) { value = initial; }
 function choose(bool take, uint256 amount) public returns(uint256) { if (take) { value += amount; } else { value += 10; } return value; }
 function twice(uint256 x) public returns(uint256) { return helper(x) + helper(x); }
 function helper(uint256 x) internal returns(uint256) { value++; return x; }
 function sum(uint256[] memory numbers) public pure returns(uint256 result) { for(uint256 i = 0; i < numbers.length; i++) { if (i == 1) continue; result += numbers[i]; } }
 function echo(uint256 x) public pure returns(uint256) { return x; }
}` };
  const build = buildStudioRuntime({ revision: 1, sources }); const runtime = createStudioRuntime(async () => build);
  const request = (name: string, args: string[], sessionId?: string): StudioRunRequest => ({ sources, revision: 1, contractId: build.program!.contracts[0]!.id, functionId: build.program!.functions.find(f => f.name.startsWith(name + "("))!.id, requestId: randomUUID(), args, constructorArgs: ["5"], caller: 0, value: "0", ...(sessionId ? { sessionId } : {}) });
  try {
    const first = await runtime.run(request("choose", ["true", "2"]));
    expect(first.status).toBe("success"); expect(first.returnValues).toEqual(["7"]);
    const labels = first.steps.map(step => build.program!.nodes.find(n => n.id === step.nodeId)?.text);
    expect(labels).toContain("value += amount"); expect(labels).not.toContain("value += 10");
    const twice = await runtime.run(request("twice", ["4"], first.sessionId));
    expect(twice.returnValues).toEqual(["8"]);
    expect(twice.steps.filter(step => build.program!.nodes.find(n => n.id === step.nodeId)?.text === "value++")).toHaveLength(2);
    const sum = await runtime.run(request("sum", ["[2, 9, 3]"], first.sessionId));
    expect(sum.returnValues).toEqual(["5"]);
    expect(sum.steps.some(step => build.program!.nodes.find(n => n.id === step.nodeId)?.kind === "Continue")).toBe(true);
    const echo = await runtime.run(request("echo", ["9007199254740993"], first.sessionId));
    expect(echo.returnValues).toEqual(["9007199254740993"]);
    await expect(runtime.run(request("helper", ["1"], first.sessionId))).rejects.toThrow(/internal/);
    await expect(runtime.run(request("choose", ["not a boolean", "1"], first.sessionId))).rejects.toThrow(/true or false/);
    await expect(runtime.run(request("sum", ["[9007199254740993]"], first.sessionId))).rejects.toThrow(/Quote large/);
    const modified = request("echo", ["1"], first.sessionId); modified.sources = { "Flow.sol": sources["Flow.sol"] + "\n" };
    await expect(runtime.run(modified)).rejects.toThrow(/Source changed/);
  } finally { await runtime.close(); }
}, 30_000);

it("bounds infinite execution and allows the sandbox to recover after an out-of-gas revert", async () => {
  const sources = { "Bounded.sol": '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Bounded { function spin() public { while (true) {} } function ping() public pure returns(uint256) { return 42; } }' };
  const build = buildStudioRuntime({ revision: 1, sources }); const runtime = createStudioRuntime(async () => build);
  const base = { sources, revision: 1, contractId: build.program!.contracts[0]!.id, constructorArgs: [], args: [], caller: 0, value: "0" };
  try {
    const spin = await runtime.run({ ...base, requestId: randomUUID(), functionId: build.program!.functions.find(f => f.name === "spin()")!.id });
    expect(spin.status).toBe("reverted"); expect(spin.error).toContain("500,000 gas");
    expect(spin.steps.at(-1)?.outcome).toBe("revert");
    const ping = await runtime.run({ ...base, requestId: randomUUID(), functionId: build.program!.functions.find(f => f.name === "ping()")!.id, sessionId: spin.sessionId });
    expect(ping.returnValues).toEqual(["42"]);
  } finally { await runtime.close(); }
}, 30_000);

it("runs payable constructors, functions, receive and fallback with wei inputs", async () => {
  const sources = { "Paid.sol": '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Paid { uint256 public total; constructor(uint256 seed) payable { require(msg.value == seed); total = seed; } function deposit() public payable returns(uint256) { total += msg.value; return total; } receive() external payable { total += msg.value; } fallback() external payable { total += 1; } }' };
  const build = buildStudioRuntime({ revision: 1, sources }); const runtime = createStudioRuntime(async () => build);
  const req = (name: string, args: string[], value: string, sessionId?: string): StudioRunRequest => ({ sources, revision: 1, requestId: randomUUID(), contractId: build.program!.contracts[0]!.id, functionId: build.program!.functions.find(f => f.name.startsWith(name + "("))!.id, args, constructorArgs: [], caller: 0, value, ...(sessionId ? { sessionId } : {}) });
  try {
    const deployment = await runtime.run(req("constructor", ["100"], "100"));
    expect(deployment.status).toBe("success"); expect(deployment.storage.map(s => BigInt(s.after))).toContain(100n);
    const deposit = await runtime.run(req("deposit", [], "7", deployment.sessionId));
    expect(deposit.returnValues).toEqual(["107"]);
    const receive = await runtime.run(req("receive", [], "3", deployment.sessionId));
    expect(receive.storage.map(s => BigInt(s.after))).toContain(110n);
    const fallback = await runtime.run({ ...req("fallback", [], "0", deployment.sessionId), calldata: "0xaabbccdd" });
    expect(fallback.storage.map(s => BigInt(s.after))).toContain(111n);
    await expect(runtime.run({ ...req("fallback", [], "0", deployment.sessionId), calldata: "0x" })).rejects.toThrow(/another function/);
    await expect(runtime.run(req("constructor", ["0"], "0", deployment.sessionId))).rejects.toThrow(/already ran/);
  } finally { await runtime.close(); }
}, 30_000);

it("executes a Solidity 0.7.6 contract with its original arithmetic semantics", async () => {
  const sources = { 'Legacy.sol': 'pragma solidity =0.7.6; contract Legacy { function decrement(uint256 amount) public pure returns (uint256) { return amount - 1; } }' };
  const build = buildStudioRuntime({ revision: 1, sources });
  expect(build.compilerVersion).toContain('0.7.6');
  const runtime = createStudioRuntime(async () => build);
  try {
    const result = await runtime.run({ revision: 1, requestId: randomUUID(), sources, contractId: build.program!.contracts[0]!.id, functionId: build.program!.functions[0]!.id, args: ['0'], constructorArgs: [], caller: 0, value: '0' });
    expect(result.status).toBe('success');
    expect(result.returnValues).toEqual([(2n ** 256n - 1n).toString()]);
    expect(result.steps.length).toBeGreaterThan(0);
  } finally { await runtime.close(); }
}, 30_000);
