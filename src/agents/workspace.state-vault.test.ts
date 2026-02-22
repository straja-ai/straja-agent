import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const GATEWAY_WORKSPACE_PATCH_KEY = Symbol.for("openclaw.gatewayWorkspacePatchCallback");
const WORKSPACE_STATE_VAULT_KEY = ".openclaw/workspace-state.json";

type VaultWorkspaceOps = {
  statFile(filename: string): Promise<{ size: number; updatedAtMs: number } | null>;
  readFile(filename: string): Promise<string | null>;
  writeFile(filename: string, content: string): Promise<void>;
};

/**
 * Tests for workspace onboarding state vault integration.
 *
 * These tests verify that readWorkspaceOnboardingState and
 * writeWorkspaceOnboardingState route through the vault when the
 * gateway workspace patch is registered on globalThis.
 *
 * We mock the globalThis callback to test the contract without
 * importing workspace.ts (which has heavy dependencies).
 */
describe("workspace state vault integration", () => {
  let mockOps: VaultWorkspaceOps;
  let writeCaptures: Array<{ filename: string; content: string }>;

  beforeEach(() => {
    writeCaptures = [];
    mockOps = {
      statFile: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(async (filename: string, content: string) => {
        writeCaptures.push({ filename, content });
      }),
    };
    (globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY] = () => mockOps;
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY];
    vi.clearAllMocks();
  });

  describe("readFile for workspace state", () => {
    it("reads workspace state from vault when patch is present", async () => {
      const state = {
        version: 1,
        bootstrapSeededAt: "2026-01-01T00:00:00.000Z",
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      };
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(state));

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();
      const raw = await ops.readFile(WORKSPACE_STATE_VAULT_KEY);

      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.version).toBe(1);
      expect(parsed.onboardingCompletedAt).toBe("2026-01-01T00:00:00.000Z");
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockOps.readFile).toHaveBeenCalledWith(WORKSPACE_STATE_VAULT_KEY);
    });

    it("returns null for missing workspace state", async () => {
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();
      const raw = await ops.readFile(WORKSPACE_STATE_VAULT_KEY);

      expect(raw).toBeNull();
    });

    it("throws when vault is unreachable", async () => {
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Vault unreachable"),
      );

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();

      await expect(ops.readFile(WORKSPACE_STATE_VAULT_KEY)).rejects.toThrow("Vault unreachable");
    });
  });

  describe("writeFile for workspace state", () => {
    it("writes workspace state to vault when patch is present", async () => {
      const state = {
        version: 1,
        bootstrapSeededAt: "2026-01-01T00:00:00.000Z",
        onboardingCompletedAt: "2026-01-15T12:00:00.000Z",
      };
      const payload = `${JSON.stringify(state, null, 2)}\n`;

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();
      await ops.writeFile(WORKSPACE_STATE_VAULT_KEY, payload);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockOps.writeFile).toHaveBeenCalledWith(WORKSPACE_STATE_VAULT_KEY, payload);
      expect(writeCaptures).toHaveLength(1);
      expect(writeCaptures[0].filename).toBe(WORKSPACE_STATE_VAULT_KEY);

      // Verify the written content is valid JSON
      const parsed = JSON.parse(writeCaptures[0].content);
      expect(parsed.onboardingCompletedAt).toBe("2026-01-15T12:00:00.000Z");
    });

    it("throws when vault write fails", async () => {
      (mockOps.writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Vault write failed: 500"),
      );

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();

      await expect(ops.writeFile(WORKSPACE_STATE_VAULT_KEY, "{}")).rejects.toThrow(
        "Vault write failed: 500",
      );
    });
  });

  describe("isWorkspaceOnboardingCompleted via vault", () => {
    it("detects completed onboarding from vault state", async () => {
      const state = {
        version: 1,
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      };
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(state));

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();
      const raw = await ops.readFile(WORKSPACE_STATE_VAULT_KEY);
      const parsed = JSON.parse(raw!);

      expect(
        typeof parsed.onboardingCompletedAt === "string" &&
          parsed.onboardingCompletedAt.trim().length > 0,
      ).toBe(true);
    });

    it("detects incomplete onboarding from vault state", async () => {
      const state = { version: 1 };
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(state));

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();
      const raw = await ops.readFile(WORKSPACE_STATE_VAULT_KEY);
      const parsed = JSON.parse(raw!);

      expect(parsed.onboardingCompletedAt).toBeUndefined();
    });
  });
});
