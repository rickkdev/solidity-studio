import { describe, expect, it } from "vitest";
import { serviceStatus } from "./index.js";

describe("serviceStatus", () => {
  it("reports that the service foundation is ready", () => {
    expect(serviceStatus()).toBe("Code Visualizer local service ready");
  });
});
