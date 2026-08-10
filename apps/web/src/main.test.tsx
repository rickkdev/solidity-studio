import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./main";

const graph = {
  schemaVersion: 1,
  repository: "fixture",
  nodes: [
    { id: "repo", kind: "repository", label: "fixture", status: "idle", metadata: {} },
    { id: "file", kind: "file", label: "Vault.sol", status: "idle", metadata: {} },
    { id: "contract", kind: "contract", label: "Vault", status: "idle", metadata: {} },
    { id: "fn", kind: "function", label: "deposit", status: "idle", metadata: { visibility: "external", payable: true, hasExternalCalls: true }, source: { file: "src/Vault.sol", start: { offset: 19, line: 2, column: 3 }, end: { offset: 57, line: 2, column: 41 } } },
    { id: "modifier", kind: "modifier", label: "onlyOwner", status: "idle", metadata: {} },
    { id: "event", kind: "event", label: "Deposited", status: "idle", metadata: {} },
    { id: "test", kind: "test", label: "testDeposit", status: "passed", metadata: {} },
    { id: "finding", kind: "finding", label: "Review call", status: "warning", metadata: {} },
  ],
  edges: [
    { id: "contains", kind: "contains", source: "repo", target: "file", metadata: {} },
    { id: "file-contract", kind: "contains", source: "file", target: "contract", metadata: {} },
    { id: "contract-fn", kind: "contains", source: "contract", target: "fn", metadata: {} },
    { id: "calls", kind: "calls", source: "fn", target: "modifier", metadata: {} },
    { id: "reads", kind: "reads", source: "fn", target: "event", metadata: {} },
    { id: "writes", kind: "writes", source: "fn", target: "finding", metadata: {} },
    { id: "tests", kind: "tests", source: "test", target: "fn", metadata: {} },
  ],
  metadata: { sources: { "src/Vault.sol": "contract Vault {\n  function deposit() external payable {}\n}" } },
};

afterEach(() => { cleanup(); });

describe("repository graph", () => {
  it("loads and renders fixture nodes, directed relationship styles, and viewport actions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => graph }));
    render(<App />);
    expect(screen.getByText("Mapping repository…")).toBeInTheDocument();
    expect(await screen.findByLabelText("Repository graph for fixture")).toBeInTheDocument();
    for (const label of ["Vault.sol", "Vault", "onlyOwner", "Deposited", "testDeposit", "Review call"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText("deposit")).not.toBeInTheDocument();
    expect(document.querySelector(".react-flow__edge.edge--calls")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit graph" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset view" })).toBeInTheDocument();
  });

  it("expands and collapses groups without leaving edges connected to hidden nodes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => graph }));
    render(<App />);
    await screen.findByText("Vault");

    fireEvent.click(screen.getByLabelText("Expand Vault"));
    expect(screen.getByLabelText("function deposit")).toBeInTheDocument();
    expect(screen.getByText("7 relationships")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit expanded" })).toBeEnabled();

    fireEvent.click(screen.getByLabelText("Collapse Vault"));
    expect(screen.queryByText("deposit")).not.toBeInTheDocument();
    expect(screen.getByText("2 relationships")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Collapse Vault.sol"));
    expect(screen.queryByText("Vault")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Expand Vault.sol"));
    expect(screen.getByText("Vault")).toBeInTheDocument();
  });

  it("inspects source-backed nodes, relationships, metadata, and copies locations", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => graph }));
    render(<App />);
    await screen.findByText("Vault");
    fireEvent.click(screen.getByLabelText("Expand Vault"));
    fireEvent.click(screen.getByText("deposit"));

    const details = screen.getByLabelText("Details for deposit");
    expect(details).toHaveTextContent("external");
    expect(details).toHaveTextContent("Incoming 2");
    expect(details).toHaveTextContent("Outgoing 3");
    expect(screen.getByLabelText("Source excerpt for deposit").querySelector("mark")).toHaveTextContent("function deposit() external payable {}");
    expect(details).toHaveTextContent("src/Vault.sol · lines 2–2");
    fireEvent.click(screen.getByRole("button", { name: "Copy location" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("src/Vault.sol:2"));
  });

  it("explains when a selected node has no source location", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => graph }));
    render(<App />);
    fireEvent.click(await screen.findByText("Review call"));
    expect(screen.getByLabelText("Details for Review call")).toHaveTextContent("This node was generated without a source location.");
  });

  it("searches labels and paths, reveals hidden ancestors, selects, and focuses a result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => graph }));
    render(<App />);
    await screen.findByText("Vault");
    fireEvent.change(screen.getByLabelText("Find symbol or path"), { target: { value: "SRC/VAULT" } });
    expect(screen.getByLabelText("Search results")).toHaveTextContent("deposit");
    fireEvent.click(screen.getByRole("button", { name: /deposit.*src\/Vault.sol/i }));
    expect(screen.getByLabelText("function deposit")).toBeInTheDocument();
    expect(screen.getByLabelText("Details for deposit")).toBeInTheDocument();
  });

  it("toggles node and edge kinds independently and clears filters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => graph }));
    render(<App />);
    await screen.findByText("Vault");
    fireEvent.click(screen.getByText("Node kinds"));
    fireEvent.click(screen.getByLabelText("finding"));
    expect(screen.queryByText("Review call")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Relationships"));
    fireEvent.click(screen.getByLabelText("contains"));
    expect(screen.getByText("0 relationships")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Review call")).toBeInTheDocument();
    expect(screen.getByText("2 relationships")).toBeInTheDocument();
  });

  it("applies and resets the security evidence preset", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => graph }));
    render(<App />);
    await screen.findByText("Vault");
    fireEvent.click(screen.getByRole("button", { name: "Security evidence" }));
    expect(screen.getByText("deposit")).toBeInTheDocument();
    expect(screen.getByText("Review call")).toBeInTheDocument();
    expect(screen.queryByText("onlyOwner")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("onlyOwner")).toBeInTheDocument();
    expect(screen.queryByText("deposit")).not.toBeInTheDocument();
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
