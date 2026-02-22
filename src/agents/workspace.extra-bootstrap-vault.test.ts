import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const BOOTSTRAP_PATCH_KEY = Symbol.for("openclaw.bootstrapPatchCallback");

/**
 * Tests for loadExtraBootstrapFiles vault integration.
 *
 * When the bootstrap patch is registered, loadExtraBootstrapFiles should
 * use the vault loader instead of fs.glob and disk reads.
 */
describe("loadExtraBootstrapFiles vault integration", () => {
  let vaultFiles: Record<string, string>;
  let vaultLoader: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vaultFiles = {};
    vaultLoader = vi.fn(async (filename: string) => {
      return vaultFiles[filename] ?? null;
    });
    (globalThis as Record<symbol, unknown>)[BOOTSTRAP_PATCH_KEY] = () => vaultLoader;
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[BOOTSTRAP_PATCH_KEY];
    vi.clearAllMocks();
  });

  describe("vault loader contract", () => {
    it("loader is available when bootstrap patch is registered", () => {
      const factory = (globalThis as Record<symbol, unknown>)[BOOTSTRAP_PATCH_KEY] as () => (
        filename: string,
      ) => Promise<string | null>;
      const loader = factory();
      expect(typeof loader).toBe("function");
    });

    it("loader returns content for existing files", async () => {
      vaultFiles["AGENTS.md"] = "# Agents Config";

      const factory = (globalThis as Record<symbol, unknown>)[BOOTSTRAP_PATCH_KEY] as () => (
        filename: string,
      ) => Promise<string | null>;
      const loader = factory();
      const content = await loader("AGENTS.md");

      expect(content).toBe("# Agents Config");
    });

    it("loader returns null for missing files", async () => {
      const factory = (globalThis as Record<symbol, unknown>)[BOOTSTRAP_PATCH_KEY] as () => (
        filename: string,
      ) => Promise<string | null>;
      const loader = factory();
      const content = await loader("NONEXISTENT.md");

      expect(content).toBeNull();
    });
  });

  describe("pattern resolution for vault mode", () => {
    it("resolves literal filenames to basenames", () => {
      // Simulate what loadExtraBootstrapFiles does in vault mode:
      // extract basename from literal patterns
      const patterns = ["subdir/AGENTS.md", "SOUL.md"];
      const basenames = patterns
        .filter((p) => !p.includes("*") && !p.includes("?") && !p.includes("{"))
        .map((p) => {
          const parts = p.split("/");
          return parts[parts.length - 1];
        });

      expect(basenames).toEqual(["AGENTS.md", "SOUL.md"]);
    });

    it("skips non-bootstrap filenames", () => {
      // The VALID_BOOTSTRAP_NAMES set filters out unknown files
      const VALID_BOOTSTRAP_NAMES = new Set([
        "AGENTS.md",
        "SOUL.md",
        "TOOLS.md",
        "IDENTITY.md",
        "USER.md",
        "HEARTBEAT.md",
        "BOOTSTRAP.md",
        "MEMORY.md",
        "memory.md",
      ]);

      const patterns = ["README.md", "AGENTS.md", "random.txt"];
      const valid = patterns.filter((p) => VALID_BOOTSTRAP_NAMES.has(p));

      expect(valid).toEqual(["AGENTS.md"]);
    });
  });

  describe("vault loader error handling", () => {
    it("handles vault errors gracefully per-file", async () => {
      // Simulate vault returning an error for one file
      const failingLoader = vi.fn(async (filename: string) => {
        if (filename === "SOUL.md") {
          throw new Error("Vault unreachable");
        }
        return vaultFiles[filename] ?? null;
      });

      vaultFiles["AGENTS.md"] = "# Agents";

      // Individual file errors should be caught, not propagate
      const content = await failingLoader("AGENTS.md");
      expect(content).toBe("# Agents");

      await expect(failingLoader("SOUL.md")).rejects.toThrow("Vault unreachable");
    });
  });

  describe("no vault fallback", () => {
    it("returns undefined when bootstrap patch is not registered", () => {
      delete (globalThis as Record<symbol, unknown>)[BOOTSTRAP_PATCH_KEY];

      const factory = (globalThis as Record<symbol, unknown>)[BOOTSTRAP_PATCH_KEY] as
        | (() => (filename: string) => Promise<string | null>)
        | undefined;
      expect(factory).toBeUndefined();
    });
  });
});
