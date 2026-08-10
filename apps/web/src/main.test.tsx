import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "./main";

const graph = {
  schemaVersion: 1,
  repository: "fixture",
  nodes: [
    { id: "repo", kind: "repository", label: "fixture", status: "idle", metadata: {} },
    { id: "file", kind: "file", label: "Vault.sol", status: "idle", metadata: {} },
    { id: "contract", kind: "contract", label: "Vault", status: "idle", metadata: {} },
    { id: "fn", kind: "function", label: "deposit", status: "idle", metadata: {} },
    { id: "modifier", kind: "modifier", label: "onlyOwner", status: "idle", metadata: {} },
    { id: "event", kind: "event", label: "Deposited", status: "idle", metadata: {} },
    { id: "test", kind: "test", label: "testDeposit", status: "passed", metadata: {} },
    { id: "finding", kind: "finding", label: "Review call", status: "warning", metadata: {} },
  ],
  edges: [
    { id: "contains", kind: "contains", source: "repo", target: "file", metadata: {} },
    { id: "imports", kind: "imports", source: "file", target: "contract", metadata: {} },
    { id: "inherits", kind: "inherits", source: "contract", target: "fn", metadata: {} },
    { id: "calls", kind: "calls", source: "fn", target: "modifier", metadata: {} },
    { id: "reads", kind: "reads", source: "fn", target: "event", metadata: {} },
    { id: "writes", kind: "writes", source: "fn", target: "finding", metadata: {} },
    { id: "tests", kind: "tests", source: "test", target: "fn", metadata: {} },
  ],
  metadata: {},
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("repository graph", () => {
  it("loads and renders fixture nodes, directed relationship styles, and viewport actions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => graph }));
    render(<App />);
    expect(screen.getByText("Mapping repository…")).toBeInTheDocument();
    expect(await screen.findByLabelText("Repository graph for fixture")).toBeInTheDocument();
    for (const label of ["Vault.sol", "Vault", "deposit", "onlyOwner", "Deposited", "testDeposit", "Review call"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const relationship of ["imports", "inherits", "calls", "reads", "writes", "tests"]) {
      expect(document.querySelector(`.edge--${relationship}`)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Fit graph" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset view" })).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...graph, nodes: [], edges: [] }) }));
    render(<App />);
    expect(await screen.findByText("No graph nodes yet")).toBeInTheDocument();
  });

  it("shows service and validation failures as analysis errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Graph service returned 503");
    cleanup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ invalid: true }) }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid graph payload"));
  });
});
