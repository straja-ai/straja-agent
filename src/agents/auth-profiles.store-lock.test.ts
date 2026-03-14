import { afterEach, describe, expect, it } from "vitest";
import { resolveAuthStorePath } from "./auth-profiles/paths.js";
import { resolveAuthProfileStoreLockPath } from "./auth-profiles/store.js";

const AUTH_PROFILES_PATCH_KEY = Symbol.for("openclaw.authProfileStorePatchCallback");

describe("resolveAuthProfileStoreLockPath", () => {
  afterEach(() => {
    const g = globalThis as Record<symbol, unknown>;
    delete g[AUTH_PROFILES_PATCH_KEY];
  });

  it("uses the main auth store path when the vault auth-profiles patch is active", () => {
    const g = globalThis as Record<symbol, unknown>;
    g[AUTH_PROFILES_PATCH_KEY] = () => ({
      loadAuthProfileStore: () => ({ version: 1, profiles: {} }),
      saveAuthProfileStore: () => {},
    });

    const lockPath = resolveAuthProfileStoreLockPath("/tmp/secondary-agent");
    expect(lockPath).toBe(resolveAuthStorePath());
  });

  it("uses the agent-specific auth store path without the vault patch", () => {
    const lockPath = resolveAuthProfileStoreLockPath("/tmp/secondary-agent");
    expect(lockPath).toBe("/tmp/secondary-agent/auth-profiles.json");
  });
});
