import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseGraph, type Graph } from "@codevis/shared";
import { RepositoryGraph } from "./repository-graph";
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

  useEffect(() => {
    const controller = new AbortController();
    let events: EventSource | undefined;
    setState({ kind: "loading" });
    void fetch(graphUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Graph service returned ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((payload) => {
        setState({ kind: "ready", graph: parseGraph(payload) });
        if (typeof EventSource !== "undefined") {
          events = new EventSource(new URL("/api/events", new URL(graphUrl, window.location.href)).toString());
          events.onmessage = (event) => {
            try { setState({ kind: "ready", graph: parseGraph(JSON.parse(event.data) as unknown) }); }
            catch { /* Ignore malformed live messages and keep the last validated graph. */ }
          };
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
    return () => { controller.abort(); events?.close(); };
  }, [graphUrl]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Solidity workspace</p>
          <h1>Code Visualizer</h1>
        </div>
        <div className="evidence-pill"><span />Static analysis evidence</div>
      </header>

      {state.kind === "loading" && <StatusView title="Mapping repository…" detail="Loading the latest graph from the local analysis service." busy />}
      {state.kind === "error" && <StatusView title="Analysis unavailable" detail={state.message} tone="error" />}
      {state.kind === "ready" && state.graph.nodes.length === 0 && (
        <StatusView title="No graph nodes yet" detail="Run analysis in a repository containing Solidity source files." />
      )}
      {state.kind === "ready" && state.graph.nodes.length > 0 && <RepositoryGraph graph={state.graph} />}
    </main>
  );
}

function StatusView({ title, detail, busy = false, tone = "neutral" }: { readonly title: string; readonly detail: string; readonly busy?: boolean; readonly tone?: "neutral" | "error" }) {
  return (
    <section className={`status-view status-view--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div className={busy ? "status-orbit status-orbit--busy" : "status-orbit"} aria-hidden="true" />
      <h2>{title}</h2>
      <p>{detail}</p>
    </section>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
