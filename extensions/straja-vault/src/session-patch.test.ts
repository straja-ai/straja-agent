import { describe, expect, it } from "vitest";
import { SESSION_PATCH_KEY, VAULT_READER_KEY, registerSessionPatch } from "./session-patch.js";

describe("session-patch registration", () => {
  it("stores vault base URL on globalThis", () => {
    const baseUrl = "http://localhost:9999";
    registerSessionPatch(baseUrl);
    const g = globalThis as Record<symbol, unknown>;
    expect(g[VAULT_READER_KEY]).toBe(baseUrl);
  });

  it("stores a patch callback on globalThis", () => {
    const baseUrl = "http://localhost:9999";
    registerSessionPatch(baseUrl);
    const g = globalThis as Record<symbol, unknown>;
    expect(typeof g[SESSION_PATCH_KEY]).toBe("function");
  });
});
