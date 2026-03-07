/**
 * Auth Profiles Store Patch — Routes auth-profiles.json through Straja Vault HTTP API
 *
 * Uses the same globalThis callback bridge pattern as session-store-patch.ts.
 * The consumer (auth-profiles/store.ts) uses synchronous loadJsonFile/saveJsonFile,
 * so this patch uses execFileSync("curl") for HTTP calls.
 *
 * The vault's `_auth_profiles` collection stores a single document:
 *   - `auth-profiles.json` — the auth profile store (identical format to filesystem)
 *
 * No disk fallback — if the vault is unreachable, operations throw.
 */

import { execFileSync } from "node:child_process";
import { appendVaultAuthCurlArgs, formatVaultCurlError } from "./http.js";

const COLLECTION = "_auth_profiles";
const DOC_KEY = "auth-profiles.json";
const TIMEOUT_MS = 5_000;

/** Well-known Symbol used to pass vault auth-profiles ops from plugin → bundle. */
export const AUTH_PROFILES_PATCH_KEY = Symbol.for("openclaw.authProfileStorePatchCallback");

// ---------------------------------------------------------------------------
// Types (mirrored from core to avoid import issues across Jiti boundary)
// ---------------------------------------------------------------------------

interface AuthProfileStore {
  version: number;
  profiles: Record<string, Record<string, unknown>>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, Record<string, unknown>>;
}

export interface AuthProfileStorePatchOps {
  loadAuthProfileStore: (storePath: string) => AuthProfileStore;
  saveAuthProfileStore: (storePath: string, store: AuthProfileStore) => void;
}

// ---------------------------------------------------------------------------
// Sync HTTP helpers (same pattern as session-store-patch.ts)
// ---------------------------------------------------------------------------

function syncHttpGet(url: string): { status: number; body: string } {
  const args = appendVaultAuthCurlArgs(["-s", "-w", "\n%{http_code}", "-X", "GET", url]);
  try {
    const result = execFileSync("curl", args, {
      encoding: "utf-8",
      timeout: TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = result.trimEnd().split("\n");
    const statusLine = lines.pop() || "0";
    return { status: parseInt(statusLine, 10), body: lines.join("\n") };
  } catch (err: unknown) {
    const msg = formatVaultCurlError(err);
    throw new Error(`Vault auth-profiles GET failed: ${msg}`);
  }
}

function syncHttpPut(url: string, body: string): void {
  try {
    const statusRaw = execFileSync(
      "curl",
      appendVaultAuthCurlArgs([
        "-s",
        "-w",
        "\n%{http_code}",
        "-X",
        "PUT",
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        "@-",
        url,
      ]),
      {
        input: body,
        encoding: "utf-8",
        timeout: TIMEOUT_MS,
        maxBuffer: 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const status = Number.parseInt(statusRaw.trim().split("\n").pop() || "0", 10);
    if (!Number.isFinite(status) || status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}`);
    }
  } catch (err: unknown) {
    const msg = formatVaultCurlError(err);
    throw new Error(`Vault auth-profiles PUT failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Vault-backed implementations
// ---------------------------------------------------------------------------

function createVaultAuthProfileStoreOps(baseUrl: string): AuthProfileStorePatchOps {
  const loadAuthProfileStore = (_storePath: string): AuthProfileStore => {
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(DOC_KEY)}`;
    const resp = syncHttpGet(url);

    if (resp.status === 404) {
      return { version: 1, profiles: {} };
    }

    if (resp.status !== 200) {
      throw new Error(`Vault auth-profiles read failed (${resp.status}) for key ${DOC_KEY}`);
    }

    if (!resp.body.trim()) {
      return { version: 1, profiles: {} };
    }

    const parsed = JSON.parse(resp.body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Vault auth-profiles payload is not an object");
    }

    const record = parsed as Record<string, unknown>;
    const profiles =
      record.profiles && typeof record.profiles === "object" && !Array.isArray(record.profiles)
        ? (record.profiles as Record<string, Record<string, unknown>>)
        : {};

    return {
      version: typeof record.version === "number" ? record.version : 1,
      profiles,
      order:
        record.order && typeof record.order === "object"
          ? (record.order as Record<string, string[]>)
          : undefined,
      lastGood:
        record.lastGood && typeof record.lastGood === "object"
          ? (record.lastGood as Record<string, string>)
          : undefined,
      usageStats:
        record.usageStats && typeof record.usageStats === "object"
          ? (record.usageStats as Record<string, Record<string, unknown>>)
          : undefined,
    };
  };

  const saveAuthProfileStore = (_storePath: string, store: AuthProfileStore): void => {
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(DOC_KEY)}`;
    const body = JSON.stringify(store, null, 2);
    syncHttpPut(url, body);
  };

  return { loadAuthProfileStore, saveAuthProfileStore };
}

// ---------------------------------------------------------------------------
// Patch registration (called during plugin register, synchronous)
// ---------------------------------------------------------------------------

/**
 * Register the auth-profiles store patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from auth-profiles/store.ts when loading/saving auth profiles.
 */
export function registerAuthProfilesPatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;
  g[AUTH_PROFILES_PATCH_KEY] = (): AuthProfileStorePatchOps => {
    return createVaultAuthProfileStoreOps(baseUrl);
  };
}
