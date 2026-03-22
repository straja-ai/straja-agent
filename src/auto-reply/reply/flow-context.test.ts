import { describe, expect, it } from "vitest";
import { appendFlowContext } from "./flow-context.js";

describe("appendFlowContext", () => {
  it("prepends trusted flow context ahead of the user body", () => {
    const result = appendFlowContext("User message", ["<flow>Update a file, then reply.</flow>"]);

    expect(result).toContain("Trusted flow context for this inbound message:");
    expect(result).toContain("User message");
    expect(result.indexOf("Trusted flow context")).toBeLessThan(result.indexOf("User message"));
  });
});
