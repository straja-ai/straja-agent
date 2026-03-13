import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest, loadSessionStore } from "./sessions.js";

const SESSION_STORE_PATCH_KEY = Symbol.for("openclaw.sessionStorePatchCallback");

describe("vault-backed session store lock handling", () => {
  let fixtureRoot = "";

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-vault-lock-test-"));
  });

  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    vi.restoreAllMocks();
    const g = globalThis as Record<symbol, unknown>;
    delete g[SESSION_STORE_PATCH_KEY];
  });

  it("does not fall back to disk migration when the vault reports a locked session store", () => {
    const storePath = path.join(fixtureRoot, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "session:legacy": {
            sessionId: "legacy",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );

    const diskReadSpy = vi.spyOn(fs, "readFileSync");
    const g = globalThis as Record<symbol, unknown>;
    g[SESSION_STORE_PATCH_KEY] = () => ({
      loadSessionStore: () => {
        throw new Error("Vault session-store is locked for key stores/abc.json");
      },
      saveSessionStore: () => {
        throw new Error("should not save while locked");
      },
    });

    expect(() => loadSessionStore(storePath, { skipCache: true })).toThrow(
      "Vault session-store is locked",
    );
    expect(diskReadSpy).not.toHaveBeenCalledWith(storePath, "utf-8");
  });
});
