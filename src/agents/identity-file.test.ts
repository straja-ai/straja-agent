import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseIdentityMarkdown,
  identityHasValues,
  loadIdentityFromFile,
  loadAgentIdentityFromWorkspace,
} from "./identity-file.js";

const GATEWAY_WORKSPACE_PATCH_KEY = Symbol.for("openclaw.gatewayWorkspacePatchCallback");
const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");

/**
 * Tests for identity-file.ts vault integration.
 *
 * The module uses sync HTTP via execFileSync("curl") to read identity files
 * from vault. For unit testing, we mock the execFileSync import via vi.mock.
 */

// Mock child_process.execFileSync while preserving other exports (e.g. execFile)
// that are used transitively by workspace.ts → process/exec.ts
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
const mockedExecFileSync = vi.mocked(execFileSync);

const BASE_URL = "http://localhost:8181";

describe("identity-file", () => {
  describe("parseIdentityMarkdown", () => {
    it("parses standard identity fields", () => {
      const content = [
        "# Identity",
        "- Name: TestBot",
        "- Emoji: 🤖",
        "- Creature: digital assistant",
        "- Vibe: calm and helpful",
        "- Theme: dark",
        "- Avatar: https://example.com/avatar.png",
      ].join("\n");

      const result = parseIdentityMarkdown(content);

      expect(result.name).toBe("TestBot");
      expect(result.emoji).toBe("🤖");
      expect(result.creature).toBe("digital assistant");
      expect(result.vibe).toBe("calm and helpful");
      expect(result.theme).toBe("dark");
      expect(result.avatar).toBe("https://example.com/avatar.png");
    });

    it("skips placeholder values", () => {
      const content = ["- Name: pick something you like", "- Emoji: 🤖"].join("\n");

      const result = parseIdentityMarkdown(content);

      expect(result.name).toBeUndefined();
      expect(result.emoji).toBe("🤖");
    });

    it("handles empty content", () => {
      const result = parseIdentityMarkdown("");
      expect(identityHasValues(result)).toBe(false);
    });

    it("strips markdown formatting from labels", () => {
      const content = "- **Name**: TestBot";
      const result = parseIdentityMarkdown(content);
      expect(result.name).toBe("TestBot");
    });
  });

  describe("identityHasValues", () => {
    it("returns true when at least one field is set", () => {
      expect(identityHasValues({ name: "Bot" })).toBe(true);
      expect(identityHasValues({ emoji: "🤖" })).toBe(true);
    });

    it("returns false when no fields are set", () => {
      expect(identityHasValues({})).toBe(false);
    });
  });

  describe("loadIdentityFromFile (vault mode)", () => {
    beforeEach(() => {
      const g = globalThis as Record<symbol, unknown>;
      g[GATEWAY_WORKSPACE_PATCH_KEY] = () => ({ readFile: vi.fn() });
      g[VAULT_READER_KEY] = BASE_URL;
    });

    afterEach(() => {
      const g = globalThis as Record<symbol, unknown>;
      delete g[GATEWAY_WORKSPACE_PATCH_KEY];
      delete g[VAULT_READER_KEY];
      vi.clearAllMocks();
    });

    it("reads from vault when patch is registered", () => {
      const identityContent = "- Name: VaultBot\n- Emoji: 🔒\n";
      mockedExecFileSync.mockReturnValue(`${identityContent}\n200`);

      const result = loadIdentityFromFile("/some/workspace/IDENTITY.md");

      expect(result).not.toBeNull();
      expect(result!.name).toBe("VaultBot");
      expect(result!.emoji).toBe("🔒");

      // Verify curl was called with the right URL
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "curl",
        expect.arrayContaining([`${BASE_URL}/raw/_workspace/IDENTITY.md`]),
        expect.any(Object),
      );
    });

    it("returns null when vault returns 404", () => {
      mockedExecFileSync.mockReturnValue("\n404");

      const result = loadIdentityFromFile("/some/workspace/IDENTITY.md");
      expect(result).toBeNull();
    });

    it("returns null when vault returns empty content", () => {
      mockedExecFileSync.mockReturnValue("\n200");

      const result = loadIdentityFromFile("/some/workspace/IDENTITY.md");
      expect(result).toBeNull();
    });

    it("returns null when identity has no values", () => {
      // Content with only placeholders
      const content = "- Name: pick something you like\n";
      mockedExecFileSync.mockReturnValue(`${content}\n200`);

      const result = loadIdentityFromFile("/some/workspace/IDENTITY.md");
      expect(result).toBeNull();
    });

    it("returns null (gracefully) when vault is unreachable", () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("curl failed");
      });

      // Should not throw — returns null gracefully
      const result = loadIdentityFromFile("/some/workspace/IDENTITY.md");
      expect(result).toBeNull();
    });

    it("uses basename of path as vault filename", () => {
      mockedExecFileSync.mockReturnValue("- Name: Bot\n200");

      loadIdentityFromFile("/deeply/nested/path/to/IDENTITY.md");

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "curl",
        expect.arrayContaining([`${BASE_URL}/raw/_workspace/IDENTITY.md`]),
        expect.any(Object),
      );
    });
  });

  describe("loadIdentityFromFile (no vault)", () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it("returns null when vault is not registered", () => {
      // No vault symbols on globalThis
      const result = loadIdentityFromFile("/some/workspace/IDENTITY.md");
      expect(result).toBeNull();
    });
  });

  describe("loadAgentIdentityFromWorkspace", () => {
    beforeEach(() => {
      const g = globalThis as Record<symbol, unknown>;
      g[GATEWAY_WORKSPACE_PATCH_KEY] = () => ({ readFile: vi.fn() });
      g[VAULT_READER_KEY] = BASE_URL;
    });

    afterEach(() => {
      const g = globalThis as Record<symbol, unknown>;
      delete g[GATEWAY_WORKSPACE_PATCH_KEY];
      delete g[VAULT_READER_KEY];
      vi.clearAllMocks();
    });

    it("reads from vault using workspace + IDENTITY.md", () => {
      mockedExecFileSync.mockReturnValue("- Name: WorkspaceBot\n200");

      const result = loadAgentIdentityFromWorkspace("/some/workspace");

      expect(result).not.toBeNull();
      expect(result!.name).toBe("WorkspaceBot");
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "curl",
        expect.arrayContaining([`${BASE_URL}/raw/_workspace/IDENTITY.md`]),
        expect.any(Object),
      );
    });
  });
});
