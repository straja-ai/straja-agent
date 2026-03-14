import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";

describe("vault-backed auth profile store", () => {
  const patchKey = Symbol.for("openclaw.authProfileStorePatchCallback");
  const globalRecord = globalThis as Record<symbol, unknown>;
  const previousFactory = globalRecord[patchKey];

  afterEach(() => {
    if (previousFactory === undefined) {
      delete globalRecord[patchKey];
    } else {
      globalRecord[patchKey] = previousFactory;
    }
  });

  it("does not import disk auth when the vault store is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-vault-only-"));
    const agentDir = path.join(root, "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");
    const loadAuthProfileStore = vi.fn(() => ({ version: AUTH_STORE_VERSION, profiles: {} }));
    const saveAuthProfileStore = vi.fn();

    try {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        authPath,
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                access: "disk-access",
                refresh: "disk-refresh",
                expires: Date.now() + 60_000,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      globalRecord[patchKey] = () => ({ loadAuthProfileStore, saveAuthProfileStore });

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles).toEqual({});
      expect(loadAuthProfileStore).toHaveBeenCalledTimes(2);
      expect(saveAuthProfileStore).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
