import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerGatewayWorkspacePatch,
  resolveGatewayWorkspaceOps,
  GATEWAY_WORKSPACE_PATCH_KEY,
} from "./gateway-workspace-patch.js";

const BASE_URL = "http://localhost:8181";

describe("gateway-workspace-patch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Clear any previously registered patch
    delete (globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY];
    vi.clearAllMocks();
  });

  it("registers callback on globalThis", () => {
    registerGatewayWorkspacePatch(BASE_URL);
    expect((globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY]).toBeDefined();
  });

  it("resolveGatewayWorkspaceOps returns ops after registration", () => {
    registerGatewayWorkspacePatch(BASE_URL);
    const ops = resolveGatewayWorkspaceOps();
    expect(ops).toBeDefined();
    expect(typeof ops!.statFile).toBe("function");
    expect(typeof ops!.readFile).toBe("function");
    expect(typeof ops!.writeFile).toBe("function");
  });

  it("resolveGatewayWorkspaceOps returns undefined when not registered", () => {
    const ops = resolveGatewayWorkspaceOps();
    expect(ops).toBeUndefined();
  });

  describe("statFile", () => {
    it("returns metadata on 200", async () => {
      fetchMock.mockResolvedValue(new Response("# Soul content", { status: 200 }));
      registerGatewayWorkspacePatch(BASE_URL);
      const ops = resolveGatewayWorkspaceOps()!;

      const meta = await ops.statFile("SOUL.md");

      expect(meta).not.toBeNull();
      expect(meta!.size).toBe(new TextEncoder().encode("# Soul content").byteLength);
      expect(meta!.updatedAtMs).toBeGreaterThan(0);
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/raw/_workspace/SOUL.md`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns null on 404", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 404 }));
      registerGatewayWorkspacePatch(BASE_URL);
      const ops = resolveGatewayWorkspaceOps()!;

      const meta = await ops.statFile("missing.md");
      expect(meta).toBeNull();
    });

    it("throws on vault error (500)", async () => {
      fetchMock.mockResolvedValue(
        new Response("Server Error", { status: 500, statusText: "Internal Server Error" }),
      );
      registerGatewayWorkspacePatch(BASE_URL);
      const ops = resolveGatewayWorkspaceOps()!;

      await expect(ops.statFile("SOUL.md")).rejects.toThrow("Vault workspace stat failed: 500");
    });
  });

  describe("readFile", () => {
    it("returns content on 200", async () => {
      fetchMock.mockResolvedValue(new Response("# Soul\nBe kind.", { status: 200 }));
      registerGatewayWorkspacePatch(BASE_URL);
      const ops = resolveGatewayWorkspaceOps()!;

      const content = await ops.readFile("SOUL.md");

      expect(content).toBe("# Soul\nBe kind.");
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/raw/_workspace/SOUL.md`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns null on 404", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 404 }));
      registerGatewayWorkspacePatch(BASE_URL);
      const ops = resolveGatewayWorkspaceOps()!;

      const content = await ops.readFile("missing.md");
      expect(content).toBeNull();
    });

    it("throws on vault error (500)", async () => {
      fetchMock.mockResolvedValue(
        new Response("Error", { status: 500, statusText: "Internal Server Error" }),
      );
      registerGatewayWorkspacePatch(BASE_URL);
      const ops = resolveGatewayWorkspaceOps()!;

      await expect(ops.readFile("SOUL.md")).rejects.toThrow("Vault workspace read failed: 500");
    });
  });

  describe("writeFile", () => {
    it("sends PUT on success", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      registerGatewayWorkspacePatch(BASE_URL);
      const ops = resolveGatewayWorkspaceOps()!;

      await ops.writeFile("SOUL.md", "# Updated Soul");

      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/raw/_workspace/SOUL.md`,
        expect.objectContaining({
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: "# Updated Soul",
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("throws on vault error (500)", async () => {
      fetchMock.mockResolvedValue(
        new Response("Error", { status: 500, statusText: "Internal Server Error" }),
      );
      registerGatewayWorkspacePatch(BASE_URL);
      const ops = resolveGatewayWorkspaceOps()!;

      await expect(ops.writeFile("SOUL.md", "content")).rejects.toThrow(
        "Vault workspace write failed: 500",
      );
    });
  });

  describe("filename encoding", () => {
    it("encodes filenames with special characters", async () => {
      fetchMock.mockResolvedValue(new Response("content", { status: 200 }));
      registerGatewayWorkspacePatch(BASE_URL);
      const ops = resolveGatewayWorkspaceOps()!;

      await ops.readFile(".openclaw/workspace-state.json");

      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/raw/_workspace/${encodeURIComponent(".openclaw/workspace-state.json")}`,
        expect.any(Object),
      );
    });
  });
});
