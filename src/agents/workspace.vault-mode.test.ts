import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  ensureAgentWorkspace,
} from "./workspace.js";

const GATEWAY_WORKSPACE_PATCH_KEY = Symbol.for("openclaw.gatewayWorkspacePatchCallback");
const BOOTSTRAP_PATCH_KEY = Symbol.for("openclaw.bootstrapPatchCallback");

describe("ensureAgentWorkspace in vault mode", () => {
  const globals = globalThis as Record<symbol, unknown>;
  const previousWorkspaceFactory = globals[GATEWAY_WORKSPACE_PATCH_KEY];
  const previousBootstrapFactory = globals[BOOTSTRAP_PATCH_KEY];

  afterEach(() => {
    if (previousWorkspaceFactory === undefined) {
      delete globals[GATEWAY_WORKSPACE_PATCH_KEY];
    } else {
      globals[GATEWAY_WORKSPACE_PATCH_KEY] = previousWorkspaceFactory;
    }
    if (previousBootstrapFactory === undefined) {
      delete globals[BOOTSTRAP_PATCH_KEY];
    } else {
      globals[BOOTSTRAP_PATCH_KEY] = previousBootstrapFactory;
    }
  });

  it("does not read or seed bootstrap templates on disk", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vault-workspace-"));
    const writes: Array<{ filename: string; content: string }> = [];

    try {
      globals[GATEWAY_WORKSPACE_PATCH_KEY] = () => ({
        readFile: async (filename: string) => {
          if (filename === ".openclaw/workspace-state.json") {
            return null;
          }
          return null;
        },
        writeFile: async (filename: string, content: string) => {
          writes.push({ filename, content });
        },
      });
      globals[BOOTSTRAP_PATCH_KEY] = () => async (filename: string) => {
        if (filename === DEFAULT_BOOTSTRAP_FILENAME) {
          return "# Bootstrap\n";
        }
        if (filename === DEFAULT_AGENTS_FILENAME) {
          return "# Agents\n";
        }
        return null;
      };

      const result = await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

      expect(result.dir).toBe(path.resolve(tempDir));
      expect(result.agentsPath).toBe(path.join(path.resolve(tempDir), DEFAULT_AGENTS_FILENAME));
      expect(fs.existsSync(path.join(tempDir, DEFAULT_AGENTS_FILENAME))).toBe(false);
      expect(writes).toEqual([
        expect.objectContaining({ filename: ".openclaw/workspace-state.json" }),
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
