import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { appendVaultAuthCurlArgs, formatVaultCurlError } from "./http.js";

const COLLECTION = "_sessions_store";
const TIMEOUT_MS = 12_000;

/** Well-known Symbol used to pass vault session-store ops from plugin → bundle. */
export const SESSION_STORE_PATCH_KEY = Symbol.for("openclaw.sessionStorePatchCallback");

export type SessionStorePatchOps = {
  loadSessionStore: (storePath: string) => Record<string, unknown>;
  saveSessionStore: (storePath: string, store: Record<string, unknown>) => void;
};

function normalizeStorePath(storePath: string): string {
  return resolve(String(storePath || ""));
}

function storePathToVaultKey(storePath: string): string {
  const normalized = normalizeStorePath(storePath);
  const hash = createHash("sha256").update(normalized).digest("hex");
  return `stores/${hash}.json`;
}

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return [
    "ETIMEDOUT",
    "request timed out",
    "ECONNRESET",
    "ECONNREFUSED",
    "HTTP 503",
    "aborted",
  ].some((p) => msg.includes(p));
}

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
    throw new Error(`Vault session-store GET failed: ${msg}`);
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
    throw new Error(`Vault session-store PUT failed: ${msg}`);
  }
}

function createVaultSessionStoreOps(baseUrl: string): SessionStorePatchOps {
  /** In-memory cache so we can survive transient vault failures. */
  const cache = new Map<string, Record<string, unknown>>();

  const loadSessionStore = (storePath: string): Record<string, unknown> => {
    const key = storePathToVaultKey(storePath);
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`;
    try {
      const resp = syncHttpGet(url);
      if (resp.status === 404) {
        const empty = {};
        cache.set(key, empty);
        return empty;
      }
      if (resp.status !== 200) {
        throw new Error(`Vault session-store read failed (${resp.status}) for key ${key}`);
      }
      if (!resp.body.trim()) {
        const empty = {};
        cache.set(key, empty);
        return empty;
      }
      const parsed = JSON.parse(resp.body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Vault session-store payload is not an object for key ${key}`);
      }
      const result = parsed as Record<string, unknown>;
      cache.set(key, result);
      return result;
    } catch (err) {
      // On transient error, return cached version if available
      if (isTransientError(err)) {
        const cached = cache.get(key);
        if (cached) {
          console.warn(
            `[straja-vault] session-store GET failed (transient), using cached: ${err instanceof Error ? err.message : err}`,
          );
          return cached;
        }
      }
      throw err;
    }
  };

  const saveSessionStore = (storePath: string, store: Record<string, unknown>) => {
    const key = storePathToVaultKey(storePath);
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`;
    const body = JSON.stringify(store, null, 2);
    // Always update cache so reads see the latest even if vault write is queued
    cache.set(key, store);
    try {
      syncHttpPut(url, body);
    } catch (err) {
      if (isTransientError(err)) {
        console.warn(
          `[straja-vault] session-store PUT failed (transient), cached locally: ${err instanceof Error ? err.message : err}`,
        );
        return; // Data is in cache; vault write queue or next save will persist it
      }
      throw err;
    }
  };

  return { loadSessionStore, saveSessionStore };
}

/**
 * Register the session-store patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from config/sessions/store.ts and returns vault-backed load/save ops.
 */
export function registerSessionStorePatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;
  g[SESSION_STORE_PATCH_KEY] = (): SessionStorePatchOps => createVaultSessionStoreOps(baseUrl);
}
