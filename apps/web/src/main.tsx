import { Studio } from "./studio";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseExplanationCollection, parseGraph, type ExplanationCollection, type Graph } from "@codevis/shared";
import { RepositoryGraph } from "./repository-graph";
import { GuidedExplorer } from "./guided-explorer";
import "@xyflow/react/dist/style.css";
import "./style.css";

export interface AppProps {
  readonly graphUrl?: string;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly graph: Graph }
  | { readonly kind: "error"; readonly message: string };

export function App({ graphUrl = "/api/graph" }: AppProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [liveConnected, setLiveConnected] = useState<boolean>();
  const [explanations, setExplanations] = useState<ExplanationCollection>({ schemaVersion: 1, enabled: false, items: [] });

  useEffect(() => {
    const controller = new AbortController();
    let events: EventSource | undefined;
    let explanationEvents: EventSource | undefined;
    setState({ kind: "loading" });
    void fetch(graphUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Graph service returned ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((payload) => {
        setState({ kind: "ready", graph: parseGraph(payload) });
        void fetch(new URL("/api/explanations", new URL(graphUrl, window.location.href)).toString(), { signal: controller.signal })
          .then((response) => response.json()).then((value) => setExplanations(parseExplanationCollection(value))).catch(() => undefined);
        if (typeof EventSource !== "undefined") {
          events = new EventSource(new URL("/api/events", new URL(graphUrl, window.location.href)).toString());
          events.onopen = () => setLiveConnected(true);
          events.onerror = () => setLiveConnected(false);
          events.onmessage = (event) => {
            try { setState({ kind: "ready", graph: parseGraph(JSON.parse(event.data) as unknown) }); }
            catch { /* Ignore malformed live messages and keep the last validated graph. */ }
          };
          explanationEvents = new EventSource(new URL("/api/explanation-events", new URL(graphUrl, window.location.href)).toString());
          explanationEvents.onmessage = (event) => { try { setExplanations(parseExplanationCollection(JSON.parse(event.data))); } catch { /* retain last valid explanations */ } };
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : "The graph could not be loaded.",
          });
        }
      });
    return () => { controller.abort(); events?.close(); explanationEvents?.close(); };
  }, [graphUrl, reloadKey]);

  const retry = () => setReloadKey((value) => value + 1);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Solidity workspace</p>
          <h1>Code Visualizer</h1>
        </div>
        <div className={`evidence-pill${liveConnected === false ? " evidence-pill--offline" : ""}`}><span />{liveConnected === false ? "Live updates disconnected" : "Static + live evidence"}</div>
      </header>

      {state.kind === "loading" && <StatusView title="Mapping repository…" detail="Loading the latest graph from the local analysis service." busy />}
      {state.kind === "error" && <StatusView title="Analysis unavailable" detail={state.message} tone="error" actionLabel="Retry analysis" onAction={retry} />}
      {state.kind === "ready" && state.graph.nodes.length === 0 && (
        <StatusView title="No graph nodes yet" detail="Add a Solidity file to the watched project, then retry analysis." actionLabel="Retry analysis" onAction={retry} />
      )}
      {state.kind === "ready" && state.graph.nodes.length > 0 && <GuidedExplorer graph={state.graph} explanations={explanations} liveDisconnected={liveConnected === false} onReconnect={retry} />}
    </main>
  );
}

function StatusView({ title, detail, busy = false, tone = "neutral", actionLabel, onAction }: { readonly title: string; readonly detail: string; readonly busy?: boolean; readonly tone?: "neutral" | "error"; readonly actionLabel?: string; readonly onAction?: () => void }) {
  return (
    <section className={`status-view status-view--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div className={busy ? "status-orbit status-orbit--busy" : "status-orbit"} aria-hidden="true" />
      <h2>{title}</h2>
      <p>{detail}</p>
      {actionLabel && onAction && <button type="button" onClick={onAction}>{actionLabel}</button>}
    </section>
  );
}

const root = document.getElementById("root");
function WorkspaceRoot() {
  const [mode, setMode] = useState<"studio" | "repository" | null>(null);
  useEffect(() => {
    if (import.meta.env.VITE_PUBLIC_DEMO === "true") { setMode("studio"); return; }
    const controller = new AbortController();
    void fetch("/api/studio/status", { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(data => setMode(data?.studio ? "studio" : "repository")).catch(() => { if (!controller.signal.aborted) setMode("studio"); });
    return () => controller.abort();
  }, []);
  return mode === "repository" ? <App /> : mode === "studio" ? <Studio /> : <p>Opening Solidity workspace…</p>;
}
if (root) createRoot(root).render(<StrictMode><WorkspaceRoot /></StrictMode>);
