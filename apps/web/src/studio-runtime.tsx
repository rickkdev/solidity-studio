import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StudioAbiInput, StudioContract, StudioFunction, StudioProgram, StudioRunResult, StudioTraceStep } from "@codevis/shared";
import "./studio-runtime.css";
const PUBLIC_DEMO = import.meta.env.VITE_PUBLIC_DEMO === "true";
const TEST_ACCOUNTS = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"];
const ACCOUNT_TWO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
function defaultValue(input: StudioAbiInput): string { if (input.type.includes("[")) return "[]"; if (input.type.startsWith("tuple")) return JSON.stringify(input.components?.map(defaultValue) ?? []); if (input.type === "address") return ACCOUNT_TWO; if (input.type === "bool") return "false"; if (/^u?int/.test(input.type)) return "0"; if (/^bytes/.test(input.type)) return input.type === "bytes" ? "0x" : "0x" + "00".repeat(Number(input.type.slice(5))); return ""; }

export function useStudioRuntime({ sources, program, contract, fn, disabled, onStep }: { sources: Record<string, string> | null; program: StudioProgram | null; contract: StudioContract | undefined; fn: StudioFunction | undefined; disabled: boolean; onStep: (step: StudioTraceStep) => void }) {
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [constructorValues, setConstructorValues] = useState<string[]>([]);
  const [caller, setCaller] = useState(0); const [value, setValue] = useState("0");
  const [calldata, setCalldata] = useState("0xdeadbeef");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState(""); const sessionRef = useRef("");
  const [history, setHistory] = useState<StudioRunResult[]>([]);
  const [index, setIndex] = useState(-1); const [playing, setPlaying] = useState(false); const [speed, setSpeed] = useState(1000);
  const [notice, setNotice] = useState("Run a function to deploy it in a local sandbox. No wallet or real ETH is used.");
  const scope = useMemo(() => JSON.stringify([contract?.id, sources]), [contract?.id, sources]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const onStepRef = useRef(onStep); onStepRef.current = onStep;
  const inFlight = useRef(false);
  const mounted = useRef(true); const serial = useRef(0);
  const current = history.at(-1); const step = current?.steps[index];
  const callable = fn?.callable;
  const args = fn ? values[fn.id] ?? callable?.inputs.map(defaultValue) ?? [] : [];
  const ctorArgs = contract?.constructorInputs?.map((input, i) => constructorValues[i] ?? defaultValue(input)) ?? [];
  const resetRemote = (id: string) => fetch("/api/studio/reset-runtime", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: id }), keepalive: true }).catch(() => undefined);
  useEffect(() => {
    if (sessionRef.current) { void resetRemote(sessionRef.current); setNotice("Code or contract changed. The next run deploys fresh state."); }
    sessionRef.current = ""; setSessionId(""); setHistory([]); setIndex(-1); setPlaying(false); setError(""); setValues({}); setConstructorValues([]); setValue("0");
  }, [scope]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (sessionRef.current) void resetRemote(sessionRef.current); }; }, []);
  useEffect(() => {
    if (step) onStepRef.current(step);
  }, [step]);
  useEffect(() => {
    if (!playing || !current) return;
    if (index >= current.steps.length - 1) { setPlaying(false); return; }
    const timer = setTimeout(() => setIndex(i => i + 1), speed);
    return () => clearTimeout(timer);
  }, [playing, index, current, speed]);

  async function run() {
    if (PUBLIC_DEMO || !sources || !contract || !fn || !callable || disabled || busy || playing || inFlight.current || callable.disabledReason) return;
    inFlight.current = true;
    const requestScope = scope; setBusy(true); setError(""); setIndex(-1);
    try {
      const response = await fetch("/api/studio/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: ++serial.current, requestId: crypto.randomUUID(), sources, contractId: contract.id, functionId: fn.id, args, constructorArgs: ctorArgs, caller, value: callable.mutability === "payable" ? value : "0", calldata, ...(sessionRef.current ? { sessionId: sessionRef.current } : {}) }) });
      const result = await response.json() as StudioRunResult & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Local execution failed.");
      if (!mounted.current || requestScope !== scopeRef.current) { void resetRemote(result.sessionId); return; }
      sessionRef.current = result.sessionId; setSessionId(result.sessionId);
      setHistory(h => [...h.slice(-19), result]); setIndex(result.steps.length ? 0 : -1); setPlaying(result.steps.length > 1);
      setNotice(`Sandbox ${result.contractAddress || "awaiting deployment"} · state persists between runs`);
    } catch (e) { if (mounted.current && requestScope === scopeRef.current) setError(e instanceof Error ? e.message : "Execution response unavailable. Reset the sandbox before retrying."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function reset() {
    if (busy) return;
    setPlaying(false); setIndex(-1);
    try {
      if (sessionRef.current) {
        const response = await fetch("/api/studio/reset-runtime", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionRef.current }) });
        if (!response.ok) throw new Error("Sandbox could not be reset. Wait for execution to finish and retry.");
      }
      sessionRef.current = ""; setSessionId(""); setHistory([]); setError(""); setNotice("Sandbox reset. Next Run creates a fresh deployment.");
    } catch (e) { setError(e instanceof Error ? e.message : "Reset failed."); }
  }
  const canRun = !PUBLIC_DEMO && !!callable && !callable.disabledReason && !disabled && !busy && !playing && !(callable.kind === "constructor" && !!current?.contractAddress);
  function inputField(input: StudioAbiInput, i: number, text: string, onChange: (text: string) => void, constructor = false) {
    const name = input.name || `input ${i + 1}`;
    return <label className="runtime-input" key={`${constructor ? "constructor" : "fn"}:${i}`}><span>{constructor ? "Constructor " : ""}{name}<small>{input.type}</small></span>{input.type === "bool" ? <select aria-label={`${constructor ? "Constructor" : "Run"} ${name}`} value={text} onChange={e => onChange(e.target.value)} disabled={busy || playing}><option value="false">false</option><option value="true">true</option></select> : <input list={input.type === "address" ? "runtime-test-accounts" : undefined} aria-label={`${constructor ? "Constructor" : "Run"} ${name}`} value={text} onChange={e => onChange(e.target.value)} disabled={busy || playing} spellCheck={false} placeholder={input.type.includes("[") || input.type.startsWith("tuple") ? "JSON; quote large integers" : input.type} />}</label>;
  }
  const controls: ReactNode = callable && fn ? <div className="runtime-node-controls nodrag nopan nowheel" onClick={event => event.stopPropagation()}>
    <datalist id="runtime-test-accounts">{(current?.accounts ?? TEST_ACCOUNTS).map((address, i) => <option key={address} value={address}>Account {i + 1}{i === 0 ? " (deployer)" : ""}</option>)}</datalist><div className="runtime-node-title">LOCAL FUNCTION INPUTS</div>
    {PUBLIC_DEMO ? <p>Run functions and replay traces in the local version. <a href="https://github.com/rickkdev/solidity-studio#development">Setup instructions</a></p> : callable.disabledReason ? <p>{callable.disabledReason}</p> : <>
      {callable.inputs.map((input, i) => inputField(input, i, args[i] ?? "", text => setValues(previous => ({ ...previous, [fn.id]: args.map((v, index) => index === i ? text : v) }))))}
      {callable.kind !== "constructor" && <label className="runtime-input"><span>Caller <small>msg.sender</small></span><select aria-label="Run caller" value={caller} onChange={e => setCaller(Number(e.target.value))} disabled={busy || playing}>{[0, 1, 2].map(i => <option key={i} value={i}>Account {i + 1}{i === 0 ? " · deployer" : ""}{current?.accounts[i] ? ` · ${current.accounts[i]!.slice(0, 8)}…` : ""}</option>)}</select></label>}
      {callable.mutability === "payable" && <label className="runtime-input"><span>ETH value <small>wei</small></span><input aria-label="Run ETH value" value={value} onChange={e => setValue(e.target.value)} disabled={busy || playing} /></label>}
      {callable.kind === "fallback" && <label className="runtime-input"><span>Calldata <small>hex</small></span><input aria-label="Run calldata" value={calldata} onChange={e => setCalldata(e.target.value)} disabled={busy || playing} /></label>}
      {!sessionId && callable.kind !== "constructor" && !!contract?.constructorInputs?.length && <details open><summary>Deployment inputs</summary>{contract.constructorInputs.map((input, i) => inputField(input, i, ctorArgs[i]!, text => setConstructorValues(ctorArgs.map((v, index) => index === i ? text : v)), true))}</details>}
      <button className="runtime-play" type="button" aria-label="Run function" disabled={!canRun} onClick={() => void run()}>{busy ? "Running…" : playing ? "Replaying trace…" : callable.kind === "constructor" ? "▶ Deploy contract" : "▶ Run function"}</button>
      {!sessionId && <small className="runtime-hint">First run deploys locally from Account 1.</small>}
      {callable.kind === "constructor" && sessionId && <small className="runtime-hint">Reset the sandbox to run the constructor again.</small>}
    </>}
  </div> : null;
  const consolePanel = <section className="studio-runtime-console" aria-label="Execution console"><header><strong>EXECUTION CONSOLE</strong><button disabled={busy || (!sessionId && !error)} onClick={() => void reset()}>Reset sandbox</button></header><p className="runtime-notice">{PUBLIC_DEMO ? "Code conversion and editing run in your browser. Execution requires the local Studio server and Anvil." : notice}</p>
    {error && <p className="runtime-error" role="alert">{error}</p>}
    {busy && <p role="status">Executing in the local EVM…</p>}
    {current && <div className="runtime-replay"><span>Trace replay {Math.max(0, index + 1)}/{current.steps.length}</span><button disabled={!current.steps.length || busy} onClick={() => { if (!playing && index >= current.steps.length - 1) setIndex(0); setPlaying(p => !p); }}>{playing ? "Pause replay" : "Replay trace"}</button><button disabled={busy || index >= current.steps.length - 1} onClick={() => { setPlaying(false); setIndex(i => i + 1); }}>Step</button>{playing && <button onClick={() => { setPlaying(false); setIndex(current.steps.length - 1); }}>Finish replay</button>}<select aria-label="Replay speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={1800}>Slow</option><option value={1000}>Normal</option><option value={600}>Fast</option></select></div>}
    <div className="runtime-log" role="log" aria-live="polite">{history.slice().reverse().map((result, i) => <article key={result.transactionHash} className={`runtime-result runtime-result--${result.status}`}><header><strong>{result.status === "success" ? "✓ Success" : "✕ Reverted"} · {program?.functions.find(f => f.id === result.functionId)?.name ?? "Deployment"}</strong><span>{result.gasUsed} gas</span></header>{result.messages.map((message, j) => <p key={j}>{message}</p>)}{result.error && <p className="runtime-error">{result.error}</p>}<p><b>Return:</b> {result.returnValues.length ? JSON.stringify(result.returnValues) : result.status === "reverted" ? result.returnData : (program?.functions.find(f => f.id === result.functionId)?.callable?.outputs.length ?? 0) > 0 ? "Return data unavailable" : "No return values"}</p>{result.events.map((event, j) => <p className="runtime-event" key={j}><b>Event {event.name}</b> {JSON.stringify(event.values)}</p>)}{result.storage.map(change => <p key={change.slot} title={`Slot ${change.slot}\n${change.before} → ${change.after}`}><b>Storage</b> {change.expression}<br /><code>{BigInt(change.before).toString()} → {BigInt(change.after).toString()}</code> <small>(raw slot value)</small></p>)}{result.status === "reverted" && <p>State changes were rolled back.</p>}{result.traceTruncated && <p>Replay limited to the first 1,000 mapped steps.</p>}{result.unmappedSteps > 0 && <small>{result.unmappedSteps} compiler-generated or external VM steps have no node highlight.</small>}<details><summary>Transaction details</summary><code>{result.transactionHash}</code><p>Return data: {result.returnData}</p></details>{i === 0 && step && <p className="runtime-current">{step.source.file}:{sources?.[step.source.file]?.slice(0, step.source.start).split("\n").length ?? "?"} · {program?.nodes.find(n => n.id === step.nodeId)?.label}</p>}</article>)}</div>
  </section>;
  return { controls, consolePanel, busy, playing, trace: current, speed, visitedEdgeIds: new Set(current?.steps.slice(0, index + 1).map(s => s.edgeId).filter(Boolean)), activeNodeId: step?.nodeId, activeEdgeId: step?.edgeId, activeOutcome: step?.outcome, canRun, run };
}
