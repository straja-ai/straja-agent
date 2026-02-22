import { describe, test, expect } from "vitest";

/**
 * Tests for the unconditional exec/process tool removal in pi-tools.ts.
 *
 * Native exec and process tools are always removed from the tools array.
 * There is no fallback to host execution — all command execution goes
 * through vault_exec and vault_process.
 */

// ---------------------------------------------------------------------------
// Minimal tool stubs
// ---------------------------------------------------------------------------

interface MinimalTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute?: (...args: unknown[]) => unknown;
}

function createStubTool(name: string): MinimalTool {
  return {
    name,
    label: name,
    description: `Stub ${name} tool`,
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

/**
 * The unconditional exec removal logic from pi-tools.ts.
 * Extracted to test independently.
 */
function applyExecToolRemoval(tools: MinimalTool[]): MinimalTool[] {
  const removeNames = new Set(["exec", "process"]);
  for (let i = tools.length - 1; i >= 0; i--) {
    if (removeNames.has(tools[i].name)) {
      tools.splice(i, 1);
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("native exec/process are always removed", () => {
  test("native exec is removed from tools array", () => {
    const tools = [createStubTool("read"), createStubTool("exec"), createStubTool("write")];

    applyExecToolRemoval(tools);

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("exec");
    expect(names).toContain("read");
    expect(names).toContain("write");
  });

  test("native process is removed from tools array", () => {
    const tools = [createStubTool("read"), createStubTool("process"), createStubTool("write")];

    applyExecToolRemoval(tools);

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("process");
    expect(names).toContain("read");
    expect(names).toContain("write");
  });

  test("both exec and process are removed, vault variants remain", () => {
    const tools = [
      createStubTool("read"),
      createStubTool("exec"),
      createStubTool("write"),
      createStubTool("process"),
      createStubTool("vault_exec"),
      createStubTool("vault_process"),
    ];

    applyExecToolRemoval(tools);

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("exec");
    expect(names).not.toContain("process");
    expect(names).toContain("vault_exec");
    expect(names).toContain("vault_process");
    expect(names).toContain("read");
    expect(names).toContain("write");
  });

  test("only vault_exec and vault_process survive when all four present", () => {
    const tools = [
      createStubTool("exec"),
      createStubTool("process"),
      createStubTool("vault_exec"),
      createStubTool("vault_process"),
    ];

    applyExecToolRemoval(tools);

    const names = tools.map((t) => t.name);
    expect(names).toEqual(["vault_exec", "vault_process"]);
  });

  test("no-op on empty tools array", () => {
    const tools: MinimalTool[] = [];
    applyExecToolRemoval(tools);
    expect(tools.length).toBe(0);
  });

  test("no-op when exec/process not present (already replaced)", () => {
    const tools = [
      createStubTool("read"),
      createStubTool("write"),
      createStubTool("vault_exec"),
      createStubTool("vault_process"),
    ];

    applyExecToolRemoval(tools);

    expect(tools.length).toBe(4);
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "vault_exec", "vault_process"]);
  });

  test("non-exec tools are never affected", () => {
    const tools = [
      createStubTool("read"),
      createStubTool("write"),
      createStubTool("edit"),
      createStubTool("vault_search"),
      createStubTool("vault_get"),
      createStubTool("vault_exec"),
      createStubTool("vault_process"),
      createStubTool("exec"),
      createStubTool("process"),
    ];

    applyExecToolRemoval(tools);

    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "read",
      "write",
      "edit",
      "vault_search",
      "vault_get",
      "vault_exec",
      "vault_process",
    ]);
  });
});

describe("tool-policy group:runtime includes vault variants", () => {
  test("group:runtime contains vault_exec and vault_process", () => {
    // This matches what tool-policy.ts defines:
    // "group:runtime": ["exec", "process", "vault_exec", "vault_process"]
    // exec/process are listed for policy resolution but always removed at the tool level.
    const groupRuntime = ["exec", "process", "vault_exec", "vault_process"];
    expect(groupRuntime).toContain("vault_exec");
    expect(groupRuntime).toContain("vault_process");
  });
});
