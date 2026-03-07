import { afterEach, describe, expect, it } from "vitest";
import { appendVaultAuthCurlArgs } from "./vault-auth.js";

const VAULT_AUTH_TOKEN_KEY = Symbol.for("openclaw.vaultAuthToken");

function clearVaultAuthState(): void {
  const g = globalThis as Record<symbol, unknown>;
  delete g[VAULT_AUTH_TOKEN_KEY];
  delete process.env.STRAJA_VAULT_TOKEN;
}

describe("vault-auth", () => {
  afterEach(() => {
    clearVaultAuthState();
  });

  it("prepends the Authorization header before the curl URL", () => {
    process.env.STRAJA_VAULT_TOKEN = "Bearer test-token";

    const args = appendVaultAuthCurlArgs(["-s", "http://localhost:8181/status"]);

    expect(args).toEqual([
      "-H",
      "Authorization: Bearer test-token",
      "-s",
      "http://localhost:8181/status",
    ]);
  });
});
