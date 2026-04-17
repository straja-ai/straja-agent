import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const storeMocks = vi.hoisted(() => ({
  updateAuthProfileStoreWithLock: vi.fn(),
  saveAuthProfileStore: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("./auth-profiles/store.js", () => ({
  updateAuthProfileStoreWithLock: storeMocks.updateAuthProfileStoreWithLock,
  saveAuthProfileStore: storeMocks.saveAuthProfileStore,
}));

vi.mock("./auth-profiles/constants.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-profiles/constants.js")>(
    "./auth-profiles/constants.js",
  );
  return {
    ...actual,
    log: { ...actual.log, warn: logMocks.warn },
  };
});

import { markAuthProfileGood } from "./auth-profiles/profiles.js";
import { markAuthProfileUsed } from "./auth-profiles/usage.js";

function makeStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai-codex:default": {
        type: "token",
        provider: "openai-codex",
        token: "tok",
      },
    },
  };
}

describe("auth profile bookkeeping writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("markAuthProfileGood does not throw when lock and save writes fail", async () => {
    const store = makeStore();
    storeMocks.updateAuthProfileStoreWithLock.mockRejectedValueOnce(new Error("lock failed"));
    storeMocks.saveAuthProfileStore.mockImplementationOnce(() => {
      throw new Error("save failed");
    });

    await expect(
      markAuthProfileGood({
        store,
        provider: "openai-codex",
        profileId: "openai-codex:default",
        agentDir: "/tmp/agent",
      }),
    ).resolves.toBeUndefined();

    expect(store.lastGood).toEqual({ "openai-codex": "openai-codex:default" });
    expect(storeMocks.saveAuthProfileStore).toHaveBeenCalledTimes(1);
    expect(logMocks.warn).toHaveBeenCalledTimes(2);
  });

  it("markAuthProfileUsed does not throw when lock and save writes fail", async () => {
    const store = makeStore();
    storeMocks.updateAuthProfileStoreWithLock.mockRejectedValueOnce(new Error("lock failed"));
    storeMocks.saveAuthProfileStore.mockImplementationOnce(() => {
      throw new Error("save failed");
    });

    await expect(
      markAuthProfileUsed({
        store,
        profileId: "openai-codex:default",
        agentDir: "/tmp/agent",
      }),
    ).resolves.toBeUndefined();

    expect(store.usageStats?.["openai-codex:default"]).toMatchObject({
      errorCount: 0,
      cooldownUntil: undefined,
      disabledUntil: undefined,
      disabledReason: undefined,
      failureCounts: undefined,
    });
    expect(typeof store.usageStats?.["openai-codex:default"]?.lastUsed).toBe("number");
    expect(storeMocks.saveAuthProfileStore).toHaveBeenCalledTimes(1);
    expect(logMocks.warn).toHaveBeenCalledTimes(2);
  });
});
