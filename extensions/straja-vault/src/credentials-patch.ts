/**
 * Credentials Patch — Routes pairing/allowFrom credentials through Straja Vault HTTP API
 *
 * Uses the same globalThis callback bridge pattern as other vault patches.
 * The pairing-store.ts consumer uses BOTH async and sync I/O:
 *   - Async: readJsonFileWithFallback / writeJsonFileAtomically (most operations)
 *   - Sync: readChannelAllowFromStoreSync (hot-path per-message authorization)
 *
 * So this patch provides both async (fetch) and sync (execFileSync curl) HTTP helpers.
 *
 * The vault's `_credentials` collection stores:
 *   - `telegram-pairing.json` — pending pairing requests
 *   - `telegram-allowFrom.json` — authorized Telegram sender IDs
 *   - `telegram-{accountId}-allowFrom.json` — per-account scoped sender IDs
 *
 * No disk fallback — if the vault is unreachable, operations throw.
 */

import { execFileSync } from "node:child_process";

const COLLECTION = "_credentials";
const TIMEOUT_MS = 5_000;

/** Well-known Symbol used to pass vault credentials ops from plugin → bundle. */
export const CREDENTIALS_PATCH_KEY = Symbol.for("openclaw.credentialsPatchCallback");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialsPatchOps {
  /** Async read: returns parsed JSON or fallback (like readJsonFileWithFallback). */
  readJsonFile: <T>(filePath: string, fallback: T) => Promise<{ value: T; exists: boolean }>;

  /** Async write: stores JSON (like writeJsonFileAtomically). */
  writeJsonFile: (filePath: string, value: unknown) => Promise<void>;

  /** Sync read: returns raw JSON string or null. For readChannelAllowFromStoreSync(). */
  readJsonFileSync: (filePath: string) => string | null;

  /** Async check: does the file exist? For ensureJsonFile(). */
  fileExists: (filePath: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract just the filename from a full disk path.
 * E.g. `/home/x/.openclaw/credentials/telegram-allowFrom.json` → `telegram-allowFrom.json`
 */
function extractKeyFromPath(filePath: string): string {
  const parts = filePath.split("/");
  const basename = parts[parts.length - 1] || filePath;
  // Sanity: ensure it's a reasonable filename
  if (!basename || basename.includes("..")) {
    throw new Error(`Invalid credentials file path: ${filePath}`);
  }
  return basename;
}

// ---------------------------------------------------------------------------
// Sync HTTP helpers (for readJsonFileSync)
// ---------------------------------------------------------------------------

function syncHttpGet(url: string): { status: number; body: string } {
  const args = ["-s", "-w", "\n%{http_code}", "-X", "GET", url];
  try {
    const result = execFileSync("curl", args, {
      encoding: "utf-8",
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = result.trimEnd().split("\n");
    const statusLine = lines.pop() || "0";
    return { status: parseInt(statusLine, 10), body: lines.join("\n") };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Vault credentials GET failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Vault-backed implementations
// ---------------------------------------------------------------------------

function createVaultCredentialsOps(baseUrl: string): CredentialsPatchOps {
  async function readJsonFile<T>(
    filePath: string,
    fallback: T,
  ): Promise<{ value: T; exists: boolean }> {
    const key = extractKeyFromPath(filePath);
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`;

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (resp.status === 404) {
      return { value: fallback, exists: false };
    }

    if (!resp.ok) {
      throw new Error(`Vault credentials read failed: ${resp.status} ${resp.statusText}`);
    }

    const raw = await resp.text();
    if (!raw.trim()) {
      return { value: fallback, exists: true };
    }

    try {
      const parsed = JSON.parse(raw) as T;
      return { value: parsed ?? fallback, exists: true };
    } catch {
      return { value: fallback, exists: true };
    }
  }

  async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
    const key = extractKeyFromPath(filePath);
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`;
    const json = JSON.stringify(value, null, 2);

    const resp = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: json,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(`Vault credentials write failed: ${resp.status} ${resp.statusText}`);
    }
  }

  function readJsonFileSync(filePath: string): string | null {
    const key = extractKeyFromPath(filePath);
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`;

    try {
      const resp = syncHttpGet(url);
      if (resp.status === 404) {
        return null;
      }
      if (resp.status !== 200) {
        return null;
      }
      return resp.body || null;
    } catch {
      return null;
    }
  }

  async function fileExists(filePath: string): Promise<boolean> {
    const key = extractKeyFromPath(filePath);
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`;

    try {
      const resp = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  return { readJsonFile, writeJsonFile, readJsonFileSync, fileExists };
}

// ---------------------------------------------------------------------------
// Patch registration (called during plugin register, synchronous)
// ---------------------------------------------------------------------------

/**
 * Register the credentials patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from pairing-store.ts when reading/writing pairing and allowFrom files.
 */
export function registerCredentialsPatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;
  g[CREDENTIALS_PATCH_KEY] = (): CredentialsPatchOps => {
    return createVaultCredentialsOps(baseUrl);
  };
}
