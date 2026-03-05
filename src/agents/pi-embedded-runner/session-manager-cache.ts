import { isCacheEnabled, resolveCacheTtlMs } from "../../config/cache-utils.js";

const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");

type SessionManagerCacheEntry = {
  sessionFile: string;
  loadedAt: number;
};

const SESSION_MANAGER_CACHE = new Map<string, SessionManagerCacheEntry>();
const DEFAULT_SESSION_MANAGER_TTL_MS = 45_000; // 45 seconds

function getSessionManagerTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_MANAGER_TTL_MS,
  });
}

function isSessionManagerCacheEnabled(): boolean {
  return isCacheEnabled(getSessionManagerTtl());
}

export function trackSessionManagerAccess(sessionFile: string): void {
  if (!isSessionManagerCacheEnabled()) {
    return;
  }
  const now = Date.now();
  SESSION_MANAGER_CACHE.set(sessionFile, {
    sessionFile,
    loadedAt: now,
  });
}

function isSessionManagerCached(sessionFile: string): boolean {
  if (!isSessionManagerCacheEnabled()) {
    return false;
  }
  const entry = SESSION_MANAGER_CACHE.get(sessionFile);
  if (!entry) {
    return false;
  }
  const now = Date.now();
  const ttl = getSessionManagerTtl();
  return now - entry.loadedAt <= ttl;
}

export async function prewarmSessionFile(sessionFile: string): Promise<void> {
  const g = globalThis as Record<symbol, unknown>;
  const vaultBaseUrl = g[VAULT_READER_KEY];
  if (typeof vaultBaseUrl !== "string" || !vaultBaseUrl.trim()) {
    throw new Error("[vault] prewarmSessionFile: vault session base URL is missing");
  }
  if (!isSessionManagerCacheEnabled()) {
    return;
  }
  if (isSessionManagerCached(sessionFile)) {
    return;
  }
  trackSessionManagerAccess(sessionFile);
}
