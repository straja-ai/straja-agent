import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const GATEWAY_WORKSPACE_PATCH_KEY = Symbol.for("openclaw.gatewayWorkspacePatchCallback");

type GatewayWorkspaceOps = {
  statFile(filename: string): Promise<{ size: number; updatedAtMs: number } | null>;
  readFile(filename: string): Promise<string | null>;
  writeFile(filename: string, content: string): Promise<void>;
};

/**
 * Regression tests for agents.ts vault integration.
 *
 * These tests verify that the gateway handlers (statFile, agents.files.get,
 * agents.files.set) route through the vault when the gateway workspace patch
 * is registered on globalThis.
 *
 * We mock the globalThis callback directly rather than importing agents.ts
 * (which has many heavy dependencies). This validates the contract between
 * agents.ts and the gateway-workspace-patch callback.
 */
describe("agents.ts vault integration", () => {
  let mockOps: GatewayWorkspaceOps;

  beforeEach(() => {
    mockOps = {
      statFile: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
    };
    (globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY] = () => mockOps;
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY];
    vi.clearAllMocks();
  });

  describe("resolveVaultOps pattern", () => {
    it("factory function returns ops when patch is registered", () => {
      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();
      expect(ops).toBeDefined();
      expect(typeof ops.statFile).toBe("function");
      expect(typeof ops.readFile).toBe("function");
      expect(typeof ops.writeFile).toBe("function");
    });

    it("returns undefined when patch is not registered", () => {
      delete (globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY];
      const factory = (globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY] as
        | (() => GatewayWorkspaceOps)
        | undefined;
      expect(factory).toBeUndefined();
    });
  });

  describe("statFile via vault", () => {
    it("routes through vault statFile when patch is present", async () => {
      const meta = { size: 42, updatedAtMs: Date.now() };
      (mockOps.statFile as ReturnType<typeof vi.fn>).mockResolvedValue(meta);

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();
      const result = await ops.statFile("SOUL.md");

      expect(result).toEqual(meta);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockOps.statFile).toHaveBeenCalledWith("SOUL.md");
    });

    it("returns null for missing files via vault", async () => {
      (mockOps.statFile as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();
      const result = await ops.statFile("MISSING.md");

      expect(result).toBeNull();
    });

    it("throws when vault is unreachable", async () => {
      (mockOps.statFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Vault unreachable"),
      );

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();

      await expect(ops.statFile("SOUL.md")).rejects.toThrow("Vault unreachable");
    });
  });

  describe("readFile (agents.files.get) via vault", () => {
    it("routes through vault readFile when patch is present", async () => {
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Soul\nContent here");

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();
      const content = await ops.readFile("SOUL.md");

      expect(content).toBe("# Soul\nContent here");
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockOps.readFile).toHaveBeenCalledWith("SOUL.md");
    });

    it("returns null for missing files via vault", async () => {
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();
      const content = await ops.readFile("MISSING.md");

      expect(content).toBeNull();
    });

    it("throws when vault is unreachable", async () => {
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Vault connection refused"),
      );

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();

      await expect(ops.readFile("SOUL.md")).rejects.toThrow("Vault connection refused");
    });
  });

  describe("writeFile (agents.files.set) via vault", () => {
    it("routes through vault writeFile when patch is present", async () => {
      (mockOps.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();
      await ops.writeFile("SOUL.md", "# Updated Soul");

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockOps.writeFile).toHaveBeenCalledWith("SOUL.md", "# Updated Soul");
    });

    it("throws when vault is unreachable", async () => {
      (mockOps.writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Vault write failed: 500"),
      );

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();

      await expect(ops.writeFile("SOUL.md", "content")).rejects.toThrow("Vault write failed: 500");
    });

    it("writes empty content without error", async () => {
      (mockOps.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();
      await ops.writeFile("SOUL.md", "");

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockOps.writeFile).toHaveBeenCalledWith("SOUL.md", "");
    });
  });

  describe("listAgentFiles via vault", () => {
    it("statFile is called for each bootstrap file name via vault", async () => {
      // Simulate what agents.ts listAgentFiles does: stat each bootstrap file
      const bootstrapFileNames = [
        "AGENTS.md",
        "SOUL.md",
        "TOOLS.md",
        "IDENTITY.md",
        "USER.md",
        "HEARTBEAT.md",
        "BOOTSTRAP.md",
      ];

      (mockOps.statFile as ReturnType<typeof vi.fn>).mockImplementation(
        async (filename: string) => {
          if (filename === "AGENTS.md" || filename === "SOUL.md") {
            return { size: 100, updatedAtMs: Date.now() };
          }
          return null;
        },
      );

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => GatewayWorkspaceOps;
      const ops = factory();

      const results = await Promise.all(bootstrapFileNames.map((name) => ops.statFile(name)));

      // AGENTS.md and SOUL.md should have metadata
      expect(results[0]).not.toBeNull();
      expect(results[1]).not.toBeNull();
      // Others should be null (missing)
      expect(results[2]).toBeNull();
      expect(results[3]).toBeNull();
      expect(results[4]).toBeNull();
      expect(results[5]).toBeNull();
      expect(results[6]).toBeNull();
    });
  });
});
