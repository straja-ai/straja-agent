import { beforeEach, describe, expect, it, vi } from "vitest";

const { vaultFetchMock } = vi.hoisted(() => ({
  vaultFetchMock: vi.fn(),
}));

vi.mock("./http.js", () => ({
  vaultFetch: vaultFetchMock,
}));

import { createVaultReadOperations, createVaultWriteOperations } from "./vault-fs-operations.js";

describe("vault-fs-operations", () => {
  const baseUrl = "http://localhost:8181";
  const workspaceRoot = "/Users/test/.openclaw/workspace";

  beforeEach(() => {
    vaultFetchMock.mockReset();
  });

  it("routes normal workspace reads to _workspace", async () => {
    vaultFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const ops = createVaultReadOperations(baseUrl, workspaceRoot);

    await ops.readFile("/Users/test/.openclaw/workspace/AGENTS.md");

    expect(vaultFetchMock).toHaveBeenCalledWith(`${baseUrl}/raw/_workspace/AGENTS.md`);
  });

  it("routes memory reads to _memory", async () => {
    vaultFetchMock.mockResolvedValue(new Response("memory", { status: 200 }));
    const ops = createVaultReadOperations(baseUrl, workspaceRoot);

    await ops.readFile("/Users/test/.openclaw/workspace/memory/2026-03-09.md");

    expect(vaultFetchMock).toHaveBeenCalledWith(`${baseUrl}/raw/_memory/memory%2F2026-03-09.md`);
  });

  it("treats missing daily memory files as empty reads", async () => {
    vaultFetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
    const ops = createVaultReadOperations(baseUrl, workspaceRoot);

    const result = await ops.readFile("/Users/test/.openclaw/workspace/memory/2026-03-09.md");

    expect(result.toString("utf-8")).toBe("");
  });

  it("treats missing daily memory files as accessible", async () => {
    vaultFetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
    const ops = createVaultReadOperations(baseUrl, workspaceRoot);

    await expect(
      ops.access("/Users/test/.openclaw/workspace/memory/2026-03-09.md"),
    ).resolves.toBeUndefined();
  });

  it("still errors for missing normal workspace files", async () => {
    vaultFetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
    const ops = createVaultReadOperations(baseUrl, workspaceRoot);

    await expect(ops.readFile("/Users/test/.openclaw/workspace/AGENTS.md")).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("routes MEMORY.md writes to _memory", async () => {
    vaultFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const ops = createVaultWriteOperations(baseUrl, workspaceRoot);

    await ops.writeFile("/Users/test/.openclaw/workspace/MEMORY.md", "# Durable memory");

    expect(vaultFetchMock).toHaveBeenCalledWith(
      `${baseUrl}/raw/_memory/MEMORY.md`,
      expect.objectContaining({
        method: "PUT",
        body: "# Durable memory",
      }),
    );
  });
});
