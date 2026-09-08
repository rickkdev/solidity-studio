import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Interface, type InterfaceAbi, type ParamType } from "ethers";
import type { StudioBuild, StudioRequest, StudioRunRequest, StudioRunResult } from "@codevis/shared";
import { mapStudioTrace, type EvmTrace } from "./studio-trace.js";

const GAS_LIMIT = 500_000;
const word = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const stringify = (value: unknown): any => JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v));
interface Sandbox { id: string; child: ChildProcess; url: string; hash: string; build: StudioBuild; contractId: string; address: string; accounts: string[]; busy: boolean; used: number }
export function createStudioRuntime(compile: (request: StudioRequest) => Promise<StudioBuild>) {
  const sessions = new Map<string, Sandbox>(); let starting = 0; let closed = false;
  const requests = new Map<string, { hash: string; promise: Promise<StudioRunResult> }>();
  const reap = setInterval(() => { for (const session of sessions.values()) if (!session.busy && Date.now() - session.used > 20 * 60_000) stop(session.id); }, 60_000); reap.unref();
  function stop(id: string) { const session = sessions.get(id); if (session) { session.child.kill("SIGTERM"); sessions.delete(id); } }
  async function run(request: StudioRunRequest): Promise<StudioRunResult> {
    if (closed) throw new Error("Runtime is closed.");
    if (!request || typeof request.requestId !== "string" || request.requestId.length > 100 || !request.requestId || !Number.isInteger(request.caller) || request.caller < 0 || request.caller > 2) throw new Error("Choose one of the three local test accounts.");
    if (!Array.isArray(request.args) || !Array.isArray(request.constructorArgs) || [...request.args, ...request.constructorArgs].some(v => typeof v !== "string")) throw new Error("Function and constructor inputs must be strings.");
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = requests.get(request.requestId);
    if (existing) { if (existing.hash !== requestHash) throw new Error("Execution request ID was reused with different inputs."); return existing.promise; }
    if (requests.size > 100) requests.delete(requests.keys().next().value!);
    const promise = execute(request); requests.set(request.requestId, { hash: requestHash, promise });
    return promise;
  }
  async function execute(request: StudioRunRequest): Promise<StudioRunResult> {
    const hash = sourceHash(request.sources, request.contractId, request.remappings);
    let session = request.sessionId ? sessions.get(request.sessionId) : undefined;
    if (request.sessionId && !session) throw new Error("Sandbox expired or was reset. Reset the runtime to deploy again.");
    if (session?.busy) throw new Error("This sandbox already has a function running.");
    if (session && session.hash !== hash) throw new Error("Source changed. Reset the sandbox before running the new code.");
    if (session) session.busy = true;
    let created = false;
    try {
      const build = session?.build ?? await compile(request);
      const fn = build.program?.functions.find(f => f.id === request.functionId && f.contractId === request.contractId);
      if (!fn?.callable) throw new Error("Function is no longer available. Recompile the workspace.");
      if (fn.callable.disabledReason) throw new Error(fn.callable.disabledReason);
      const artifact = build.artifacts[request.contractId];
      if (!artifact?.bytecode || !/^[0-9a-f]+$/i.test(artifact.bytecode)) throw new Error("This contract cannot be deployed: abstract/interface contracts and unlinked libraries need a concrete, linked contract.");
      const iface = new Interface(artifact.abi as InterfaceAbi);
      const constructor = fn.callable.kind === "constructor";
      const args = constructor ? request.args : request.constructorArgs;
      const deploymentData = session?.address ? "" : `0x${artifact.bytecode}${iface.encodeDeploy(parseInputs(iface.deploy.inputs, args)).slice(2)}`;
      const value = parseValue(request.value);
      if (value > 0n && fn.callable.mutability !== "payable") throw new Error("Only payable functions can receive ETH.");
      const data = fn.callable.kind === "function" ? iface.encodeFunctionData(fn.callable.signature, parseInputs(iface.getFunction(fn.callable.signature)!.inputs, request.args)) : fn.callable.kind === "fallback" ? request.calldata ?? "0xdeadbeef" : "0x";
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error("Calldata must be even-length hexadecimal bytes.");
      if (fn.callable.kind === "fallback" && ((data === "0x" && iface.receive) || (data.length >= 10 && iface.getFunction(data.slice(0, 10))))) throw new Error("This calldata selects another function. Use an unmatched selector to run fallback.");
      if (constructor && session?.address) throw new Error("Constructor already ran. Reset the sandbox to deploy a new instance.");
      if (!session) {
        if (sessions.size + starting >= 4) throw new Error("Four sandboxes are already open. Reset an unused workspace first.");
        starting++;
        try {
          const chain = await startAnvil();
          if (closed) { chain.child.kill("SIGTERM"); throw new Error("Runtime closed during startup."); }
          session = { id: randomUUID(), ...chain, build, hash, contractId: request.contractId, address: "", accounts: [], busy: true, used: Date.now() };
          sessions.set(session.id, session); created = true;
          session.accounts = await rpc(session, "eth_accounts", []);
        } finally { starting--; }
      }
      const messages: string[] = [];
      if (!session.address) {
        const deployment = await send(session, { from: session.accounts[0]!, data: deploymentData, value: word(constructor ? value : 0) }, 2_000_000);
        if (deployment.receipt.contractAddress) session.address = deployment.receipt.contractAddress;
        messages.push(`Deployed locally from Account 1 at ${session.address || "(deployment reverted)"}.`);
        if (constructor || deployment.receipt.status !== "0x1") {
          const ctor = build.program!.functions.find(f => f.contractId === request.contractId && f.callable?.kind === "constructor");
          if (!constructor) messages.push("Constructor reverted; the selected function was not called.");
          return await summarize(session, ctor?.id ?? fn.id, deployment, iface, true, messages);
        }
      }
      const transaction = await send(session, { from: session.accounts[request.caller]!, to: session.address, data, value: word(value) });
      messages.push(`Called ${fn.callable.signature} as Account ${request.caller + 1}. State persists until reset or a source change.`);
      return await summarize(session, fn.id, transaction, iface, false, messages);
    } catch (error) { if (created && session) stop(session.id); throw error;
    } finally { if (session) { session.busy = false; session.used = Date.now(); } }
  }
  async function summarize(session: Sandbox, functionId: string, tx: Awaited<ReturnType<typeof send>>, iface: Interface, deployment: boolean, messages: string[]): Promise<StudioRunResult> {
    const status = tx.receipt.status === "0x1" ? "success" : "reverted";
    const result: StudioRunResult = { sessionId: session.id, contractAddress: session.address, accounts: session.accounts, functionId, status, transactionHash: tx.hash, gasUsed: BigInt(tx.receipt.gasUsed).toString(), returnValues: [], returnData: "0x", events: [], storage: [], steps: [], traceTruncated: false, unmappedSteps: 0, messages };
    for (const log of tx.receipt.logs ?? []) {
      try { const event = iface.parseLog(log); result.events.push({ name: event?.name ?? "Unknown event", values: event ? stringify(event.args.toArray()) : [log.data], address: log.address }); }
      catch { result.events.push({ name: "External event", values: [log.topics, log.data], address: log.address }); }
    }
    try {
      const trace: EvmTrace = await rpc(session, "debug_traceTransaction", [tx.hash, { disableStorage: true, disableStack: false, enableMemory: false, enableReturnData: true }]);
      trace.failed = status === "reverted";
      result.returnData = trace.returnValue?.startsWith("0x") ? trace.returnValue : `0x${trace.returnValue ?? ""}`;
      const mapped = mapStudioTrace(session.build, session.contractId, functionId, trace, session.address || "deployment", deployment);
      result.steps = mapped.steps; result.traceTruncated = mapped.traceTruncated; result.unmappedSteps = mapped.unmappedSteps;
      if (status === "reverted") {
        try { const error = iface.parseError(result.returnData); result.error = error ? `${error.name}(${stringify(error.args.toArray()).join(", ")})` : "Execution reverted (no reason returned)."; }
        catch { result.error = "Execution reverted (undecoded error data)."; }
        if (BigInt(tx.receipt.gasUsed) >= BigInt(tx.gasLimit)) result.error = `Execution exhausted the ${tx.gasLimit.toLocaleString("en-US")} gas sandbox limit.`;
      } else if (!deployment) {
        const fn = session.build.program!.functions.find(f => f.id === functionId);
        if (fn?.callable?.kind === "function") result.returnValues = stringify(iface.decodeFunctionResult(fn.callable.signature, result.returnData).toArray());
      }
      if (status === "success" && session.address) for (const [slot, expression] of [...mapped.writes].slice(0, 30)) {
        const before = deployment ? "0x" + "0".repeat(64) : await rpc(session, "eth_getStorageAt", [session.address, slot, word(BigInt(tx.receipt.blockNumber) - 1n)]);
        const after = await rpc(session, "eth_getStorageAt", [session.address, slot, tx.receipt.blockNumber]);
        if (before !== after) result.storage.push({ slot, expression, before, after });
      }
    } catch (error) {
      messages.push(`Transaction ${status}; trace details unavailable: ${error instanceof Error ? error.message : "trace failed"}. Do not rerun to recover a trace; the transaction already executed.`);
      if (status === "reverted" && !result.error) result.error = "Execution reverted.";
    }
    return result;
  }
  return { run, reset: (id: string) => { const session = sessions.get(id); if (session?.busy) throw new Error("Wait for the running transaction before resetting."); stop(id); }, close: async () => { closed = true; clearInterval(reap); for (const id of sessions.keys()) stop(id); requests.clear(); } };
}

async function startAnvil(): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("anvil", ["--host", "127.0.0.1", "--port", "0", "--steps-tracing", "--hardfork", "cancun", "--accounts", "3", "--balance", "10000", "--mnemonic", "test test test test test test test test test test test junk", "--gas-limit", "2500000"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let done = false;
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Local Anvil sandbox did not start in time.")); }, 8000);
    child.on("error", () => { clearTimeout(timer); reject(new Error("Anvil is unavailable. Install Foundry (including anvil), then retry Run.")); });
    child.on("exit", () => { if (!done) { clearTimeout(timer); reject(new Error("Local Anvil sandbox exited before it was ready.")); } });
    child.stdout?.on("data", chunk => { output = (output + chunk.toString()).slice(-3000); const match = output.match(/Listening on (127\.0\.0\.1:\d+)/); if (match && !done) { done = true; clearTimeout(timer); resolve({ child, url: `http://${match[1]}` }); } });
    child.stderr?.resume();
  });
}
async function rpc(session: Pick<Sandbox, "url">, method: string, params: unknown[]): Promise<any> {
  const response = await fetch(session.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const body = await response.json() as { result?: unknown; error?: { message: string } };
  if (!response.ok || body.error) throw new Error(body.error?.message ?? `Local EVM returned ${response.status}`);
  return body.result;
}
async function send(session: Sandbox, tx: Record<string, string>, gasLimit = GAS_LIMIT) {
  const hash: string = await rpc(session, "eth_sendTransaction", [{ ...tx, gas: word(gasLimit) }]);
  for (let i = 0; i < 80; i++) { const receipt = await rpc(session, "eth_getTransactionReceipt", [hash]); if (receipt) return { hash, receipt, gasLimit }; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Transaction ${hash} was submitted but its receipt is not available. Reset the sandbox before retrying.`);
}
function parseValue(value: string): bigint {
  if (typeof value !== "string" || !/^(0x[0-9a-fA-F]+|\d+)$/.test(value.trim())) throw new Error("ETH value must be a non-negative integer in wei.");
  const n = BigInt(value); if (n > 10_000n * 10n ** 18n) throw new Error("ETH value exceeds the funded test account balance."); return n;
}
function parseInputs(inputs: readonly ParamType[], values: string[]): unknown[] {
  if (inputs.length !== values.length) throw new Error(`Expected ${inputs.length} inputs, received ${values.length}.`);
  return inputs.map((input, index) => {
    const text = values[index]!;
    if (input.baseType === "array" || input.baseType === "tuple") {
      let parsed: unknown; try { parsed = JSON.parse(text); } catch { throw new Error(`${input.name || `Input ${index + 1}`} needs a JSON array/object. Quote large integers.`); }
      const validate = (value: unknown) => { if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Quote large integer values in JSON inputs to preserve precision."); if (value && typeof value === "object") Object.values(value).forEach(validate); }; validate(parsed); return parsed;
    }
    if (input.type === "bool") { if (text !== "true" && text !== "false") throw new Error(`${input.name || "Boolean input"} must be true or false.`); return text === "true"; }
    return text;
  });
}
function sourceHash(sources: Record<string, string>, contract: string, remappings: string[] = []) { return createHash("sha256").update(JSON.stringify([contract, remappings, Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))])).digest("hex"); }
