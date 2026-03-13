import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import { registerSessionStorePatch, SESSION_STORE_PATCH_KEY } from "./session-store-patch.js";

function clearSessionStorePatch(): void {
  const g = globalThis as Record<symbol, unknown>;
  delete g[SESSION_STORE_PATCH_KEY];
}

describe("session-store patch", () => {
  afterEach(() => {
    execFileSyncMock.mockReset();
    vi.restoreAllMocks();
    clearSessionStorePatch();
  });

  it("treats 423 responses as a locked vault instead of an empty store", () => {
    execFileSyncMock.mockReturnValue("\n423");

    registerSessionStorePatch("http://localhost:8181");
    const g = globalThis as Record<symbol, unknown>;
    const factory = g[SESSION_STORE_PATCH_KEY] as
      | (() => {
          loadSessionStore: (storePath: string) => Record<string, unknown>;
        })
      | undefined;

    expect(factory).toBeTypeOf("function");
    const ops = factory!();

    expect(() => ops.loadSessionStore("/tmp/openclaw-session-store.json")).toThrow(
      "Vault session-store is locked",
    );
  });

  it("still returns an empty store on 404", () => {
    execFileSyncMock.mockReturnValue("\n404");

    registerSessionStorePatch("http://localhost:8181");
    const g = globalThis as Record<symbol, unknown>;
    const factory = g[SESSION_STORE_PATCH_KEY] as
      | (() => {
          loadSessionStore: (storePath: string) => Record<string, unknown>;
        })
      | undefined;

    expect(factory).toBeTypeOf("function");
    const ops = factory!();

    expect(ops.loadSessionStore("/tmp/openclaw-session-store.json")).toEqual({});
  });
});
