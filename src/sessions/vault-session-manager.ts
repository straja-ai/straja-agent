import {
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");
const SESSION_PATCH_KEY = Symbol.for("openclaw.sessionPatchCallback");
const SESSION_PATCH_APPLIED_KEY = Symbol.for("openclaw.sessionPatchApplied");

function hasVaultBaseUrl(): boolean {
  const g = globalThis as Record<symbol, unknown>;
  const raw = g[VAULT_READER_KEY];
  if (typeof raw !== "string") {
    return false;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Ensure SessionManager persistence is patched to vault-backed storage.
 * Fails closed if vault is unavailable or patch callback was not registered.
 */
export function ensureVaultSessionManagerPatched(context: string): void {
  if (!hasVaultBaseUrl()) {
    throw new Error(`[vault] ${context}: vault session base URL is missing`);
  }

  const proto = SessionManager.prototype as unknown as Record<symbol, unknown>;
  if (proto[SESSION_PATCH_APPLIED_KEY] === true) {
    return;
  }

  const g = globalThis as Record<symbol, unknown>;
  const patchFn = g[SESSION_PATCH_KEY];
  if (typeof patchFn === "function") {
    patchFn(SessionManager, parseSessionEntries, migrateSessionEntries);
    delete g[SESSION_PATCH_KEY];
  }

  if (proto[SESSION_PATCH_APPLIED_KEY] !== true) {
    throw new Error(
      `[vault] ${context}: session patch is not active; refusing SessionManager disk fallback`,
    );
  }
}
