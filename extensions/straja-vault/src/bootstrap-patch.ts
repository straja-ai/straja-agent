/**
 * Bootstrap Patch — Routes workspace .md files through Straja Vault
 *
 * Uses the same globalThis callback bridge pattern as session-patch.ts
 * and fs-tools-patch.ts. During plugin register(), we store a callback
 * on a well-known Symbol. In workspace.ts, when loading bootstrap files,
 * the core checks for this callback and uses vault reads if present.
 *
 * The vault's `_workspace` collection is the sole source of truth for
 * workspace bootstrap files (AGENTS.md, SOUL.md, TOOLS.md, etc.).
 * No disk fallback — if the vault is unreachable, the fetch throws.
 */

const COLLECTION = "_workspace";

/** Well-known Symbol used to pass the bootstrap loader from plugin → bundle. */
export const BOOTSTRAP_PATCH_KEY = Symbol.for("openclaw.bootstrapPatchCallback");

// ---------------------------------------------------------------------------
// TTL cache for bootstrap file content.
// Avoids hitting the vault HTTP server on every single bootstrap load.
// Cache is per-process and refreshed every 60 seconds.
// ---------------------------------------------------------------------------
const BOOTSTRAP_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  content: string | null; // null = vault returned 404 (file does not exist)
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Invalidate a single bootstrap file in the cache. */
export function invalidateBootstrapFile(filename: string): void {
  cache.delete(filename);
}

/** Invalidate all bootstrap files in the cache. */
export function invalidateBootstrapCache(): void {
  cache.clear();
}

/**
 * Fetch a bootstrap file from the vault, with TTL caching.
 *
 * Returns the file content (string) on 200, null on 404.
 * Throws on vault unreachable or non-200/404 responses — no fallback.
 */
async function fetchBootstrapFile(baseUrl: string, filename: string): Promise<string | null> {
  const now = Date.now();
  const cached = cache.get(filename);
  if (cached && now - cached.fetchedAt < BOOTSTRAP_CACHE_TTL_MS) {
    return cached.content;
  }

  const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(filename)}`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(3000),
  });

  if (resp.ok) {
    const text = await resp.text();
    const content = text.trim() || null;
    cache.set(filename, { content, fetchedAt: now });
    return content;
  }

  if (resp.status === 404) {
    cache.set(filename, { content: null, fetchedAt: now });
    return null;
  }

  // Non-200, non-404 — vault error. Throw, no fallback.
  throw new Error(
    `Vault bootstrap fetch failed: ${resp.status} ${resp.statusText} for ${filename}`,
  );
}

// ---------------------------------------------------------------------------
// Patch registration (called during plugin register, synchronous)
// ---------------------------------------------------------------------------

/**
 * Register the bootstrap patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from workspace.ts when loading bootstrap files. It returns a loader
 * function that fetches files from the vault's _workspace collection.
 */
export function registerBootstrapPatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;

  g[BOOTSTRAP_PATCH_KEY] = (): ((filename: string) => Promise<string | null>) => {
    return (filename: string) => fetchBootstrapFile(baseUrl, filename);
  };
}
