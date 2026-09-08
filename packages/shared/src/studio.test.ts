import { describe, expect, it } from "vitest";
import { parseStudioWorkspace } from "./studio.js";
describe("studio workspace persistence", () => {
  it("restores sources, positions and pending edits", () => {
    const workspace = { schemaVersion: 1, sources: { "Contract.sol": "contract Contract {}" }, positions: { entry: { x: 10, y: -20 } }, pendingEdit: { title: "Add state", text: "uint256 value;", edit: { kind: "declaration", contractId: "Contract.sol:Contract", text: "uint256 value;" } } };
    expect(parseStudioWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace);
  });
  it("rejects corrupt or incompatible files without discarding the active workspace", () => {
    for (const value of [null, { schemaVersion: 2 }, { schemaVersion: 1, sources: [] }, { schemaVersion: 1, sources: { "C.sol": 123 } }, { schemaVersion: 1, sources: { "C.sol": "contract C {}" }, positions: { n: { x: null, y: 0 } } }, { schemaVersion: 1, sources: { "C.sol": "contract C {}" }, pendingEdit: { edit: { kind: "unknown" } } }]) expect(() => parseStudioWorkspace(value)).toThrow();
  });
});
