import { describe, expect, it } from "vitest";
import { createEmptyGraph } from "./index.js";

describe("createEmptyGraph", () => {
  it("creates a named graph with no nodes", () => {
    expect(createEmptyGraph("fixture")).toEqual({ name: "fixture", nodeCount: 0 });
  });
});
