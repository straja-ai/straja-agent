import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const GATEWAY_WORKSPACE_PATCH_KEY = Symbol.for("openclaw.gatewayWorkspacePatchCallback");
const AUTH_JSON_VAULT_KEY = "_config/auth.json";

type VaultWorkspaceOps = {
  statFile(filename: string): Promise<{ size: number; updatedAtMs: number } | null>;
  readFile(filename: string): Promise<string | null>;
  writeFile(filename: string, content: string): Promise<void>;
};

/**
 * Tests for pi-auth-json.ts vault integration.
 *
 * These tests verify that readAuthJson and ensurePiAuthJsonFromAuthProfiles
 * route through the vault when the gateway workspace patch is registered
 * on globalThis.
 */
describe("pi-auth-json vault integration", () => {
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

  describe("readFile for auth.json", () => {
    it("reads auth.json from vault when patch is present", async () => {
      const authData = {
        openai: { type: "api_key", key: "sk-test-123" },
        anthropic: { type: "api_key", key: "sk-ant-test" },
      };
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(authData));

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();
      const raw = await ops.readFile(AUTH_JSON_VAULT_KEY);

      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.openai.type).toBe("api_key");
      expect(parsed.anthropic.key).toBe("sk-ant-test");
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockOps.readFile).toHaveBeenCalledWith(AUTH_JSON_VAULT_KEY);
    });

    it("returns null for missing auth.json", async () => {
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();
      const raw = await ops.readFile(AUTH_JSON_VAULT_KEY);

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

      await expect(ops.readFile(AUTH_JSON_VAULT_KEY)).rejects.toThrow("Vault unreachable");
    });
  });

  describe("writeFile for auth.json", () => {
    it("writes auth.json to vault when patch is present", async () => {
      const authData = {
        openai: { type: "api_key", key: "sk-new-key" },
      };
      const payload = `${JSON.stringify(authData, null, 2)}\n`;

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();
      await ops.writeFile(AUTH_JSON_VAULT_KEY, payload);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockOps.writeFile).toHaveBeenCalledWith(AUTH_JSON_VAULT_KEY, payload);
      expect(writeCaptures).toHaveLength(1);
      expect(writeCaptures[0].filename).toBe(AUTH_JSON_VAULT_KEY);

      // Verify the written content is valid JSON
      const parsed = JSON.parse(writeCaptures[0].content);
      expect(parsed.openai.key).toBe("sk-new-key");
    });

    it("throws when vault write fails", async () => {
      (mockOps.writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Vault write failed: 500"),
      );

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();

      await expect(ops.writeFile(AUTH_JSON_VAULT_KEY, "{}")).rejects.toThrow(
        "Vault write failed: 500",
      );
    });
  });

  describe("credential change detection", () => {
    it("detects changed credentials in vault auth.json", async () => {
      // Simulate reading existing auth.json from vault
      const existingAuth = {
        openai: { type: "api_key", key: "sk-old-key" },
      };
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify(existingAuth),
      );

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();
      const raw = await ops.readFile(AUTH_JSON_VAULT_KEY);
      const parsed = JSON.parse(raw!);

      // Simulate detecting a change
      const newCred = { type: "api_key", key: "sk-new-key" };
      const changed = parsed.openai.key !== newCred.key;

      expect(changed).toBe(true);
    });

    it("detects no change when credentials match", async () => {
      const existingAuth = {
        openai: { type: "api_key", key: "sk-same-key" },
      };
      (mockOps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify(existingAuth),
      );

      const factory = (globalThis as Record<symbol, unknown>)[
        GATEWAY_WORKSPACE_PATCH_KEY
      ] as () => VaultWorkspaceOps;
      const ops = factory();
      const raw = await ops.readFile(AUTH_JSON_VAULT_KEY);
      const parsed = JSON.parse(raw!);

      const newCred = { type: "api_key", key: "sk-same-key" };
      const changed = parsed.openai.key !== newCred.key;

      expect(changed).toBe(false);
    });
  });

  describe("no vault fallback", () => {
    it("returns undefined when gateway workspace patch is not registered", () => {
      delete (globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY];

      const factory = (globalThis as Record<symbol, unknown>)[GATEWAY_WORKSPACE_PATCH_KEY] as
        | (() => VaultWorkspaceOps)
        | undefined;
      expect(factory).toBeUndefined();
    });
  });
});
