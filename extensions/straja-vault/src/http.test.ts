import { afterEach, describe, expect, it } from "vitest";
import {
  appendVaultAuthCurlArgs,
  appendVaultProbeCurlArgs,
  formatVaultCurlError,
  registerVaultAuthToken,
} from "./http.js";

const VAULT_AUTH_TOKEN_KEY = Symbol.for("openclaw.vaultAuthToken");

function clearVaultAuthState(): void {
  const g = globalThis as Record<symbol, unknown>;
  delete g[VAULT_AUTH_TOKEN_KEY];
  delete process.env.STRAJA_VAULT_TOKEN;
}

describe("vault extension http auth", () => {
  afterEach(() => {
    clearVaultAuthState();
  });

  it("prepends the Authorization header before the curl URL", () => {
    registerVaultAuthToken("Bearer extension-token");

    const args = appendVaultAuthCurlArgs(["-s", "http://localhost:8181/status"]);

    expect(args).toEqual([
      "-H",
      "Authorization: Bearer extension-token",
      "-s",
      "http://localhost:8181/status",
    ]);
  });

  it("adds retry flags to the startup probe curl args", () => {
    registerVaultAuthToken("extension-token");

    const args = appendVaultProbeCurlArgs(["-s", "http://localhost:8181/status"]);

    expect(args).toEqual([
      "-H",
      "Authorization: Bearer extension-token",
      "--connect-timeout",
      "2",
      "--max-time",
      "12",
      "--retry",
      "6",
      "--retry-delay",
      "1",
      "--retry-all-errors",
      "-s",
      "http://localhost:8181/status",
    ]);
  });

  it("redacts bearer tokens from curl error messages", () => {
    const err = new Error(
      "Command failed: curl -H Authorization: Bearer svlt_agent_secret -s http://localhost",
    );

    expect(formatVaultCurlError(err)).toBe(
      "Command failed: curl -H Authorization: Bearer [REDACTED] -s http://localhost",
    );
  });
});
