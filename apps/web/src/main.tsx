import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

export function App() {
  return (
    <main>
      <p className="eyebrow">Solidity workspace</p>
      <h1>Code Visualizer</h1>
      <p>The graph-first development environment is ready.</p>
    </main>
  );
}

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
