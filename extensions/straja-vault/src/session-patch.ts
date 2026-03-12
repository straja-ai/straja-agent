/**
 * Session Persistence Patch — Redirects SessionManager I/O to Straja Vault HTTP API
 *
 * Monkey-patches SessionManager.prototype to route all session persistence
 * (read, write, append) through the Vault's /raw/_sessions/ endpoints.
 * Disk writes are SUPPRESSED — the vault is the sole persistence layer.
 *
 * The gateway UI reads transcripts via session-utils.fs.ts, which is
 * separately patched (via VAULT_READER_KEY on globalThis) to fetch from
 * the vault instead of the filesystem.
 *
 * HOW IT WORKS:
 * Jiti (OpenClaw's plugin loader) creates a separate module instance from
 * Node's native ESM loader, so `import("@mariozechner/pi-coding-agent")`
 * inside a Jiti-loaded plugin returns a DIFFERENT SessionManager class than
 * what the OpenClaw bundle uses.
 *
 * To solve this, we use a globalThis callback bridge:
 *   1. During register(), the plugin stores a patchCallback on a well-known
 *      Symbol on globalThis.
 *   2. Before SessionManager.open() in attempt.ts, the bundle calls
 *      flushPluginSetup() which invokes any registered patch callbacks,
 *      passing the REAL SessionManager class.
 *
 * WRITE STRATEGY:
 * - Disk writes are SUPPRESSED (origPersist / origRewriteFile are NOT called).
 * - Vault writes use synchronous curl to localhost so data is available
 *   before the gateway broadcasts events to the UI.
 * - The vault has an in-memory write queue that handles all SQLite contention
 *   internally. The agent never sees SQLITE_BUSY or FK errors — those are
 *   resolved by the vault's drain worker.
 * - Reads (setSessionFile) load exclusively from vault. 404 means "new empty
 *   session"; transport/non-404 failures throw (fail closed).
 * - A background flush timer (5s) acts as a safety net: if the vault process
 *   is temporarily unreachable, deferred writes are retried until they succeed.
 *
 * CRITICAL: _persist, _rewriteFile, and createBranchedSession NEVER throw.
 * Any write failure is silently deferred — the background flush timer will
 * retry. This ensures the agent process never crashes due to vault errors.
 *
 * The vault must be running on the configured baseUrl for this to work.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { appendVaultAuthCurlArgs, formatVaultCurlError } from "./http.js";

const COLLECTION = "_sessions";
const BACKGROUND_FLUSH_INTERVAL_MS = 5_000;

/** Well-known Symbol used to pass the patch callback from plugin -> bundle. */
export const SESSION_PATCH_KEY = Symbol.for("openclaw.sessionPatchCallback");

/** Well-known Symbol used to expose the vault base URL to the gateway reader. */
export const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");
/** Marker set on SessionManager.prototype when vault patch is active. */
const SESSION_PATCH_APPLIED_KEY = Symbol.for("openclaw.sessionPatchApplied");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the session filename from a full filesystem path.
 * SessionManager stores paths like:
 *   /Users/x/.openclaw/agents/vault/sessions/48d9971c-...jsonl
 * We need just: "48d9971c-...jsonl"
 */
function sessionPathToVaultKey(sessionFile: string): string {
  const parts = sessionFile.split("/");
  return parts[parts.length - 1] || sessionFile;
}

/**
 * Synchronous HTTP request via curl.
 *
 * Used ONLY for reads (GET) where we need the response body immediately.
 * Writes use syncHttpWrite() instead to avoid blocking the event loop.
 */
function syncHttpGet(url: string): { status: number; body: string } {
  const args = appendVaultAuthCurlArgs(["-s", "-w", "\n%{http_code}", "-X", "GET", url]);

  try {
    const result = execFileSync("curl", args, {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 50 * 1024 * 1024,
    });

    const lines = result.trimEnd().split("\n");
    const statusLine = lines.pop() || "0";
    const responseBody = lines.join("\n");
    return { status: parseInt(statusLine, 10), body: responseBody };
  } catch (err: unknown) {
    const msg = formatVaultCurlError(err);
    throw new Error(`Vault HTTP GET ${url} failed: ${msg}`);
  }
}

/**
 * Synchronous HTTP write via curl.
 *
 * We need writes to be synchronous so the data is available in the vault
 * before the gateway broadcasts the "final" event to the UI. If writes were
 * async (fire-and-forget), the UI's subsequent `chat.history` call could
 * read stale data from the vault, causing the last message to disappear.
 *
 * The vault is localhost, so curl completes in <10ms. We use a short
 * timeout to avoid blocking the event loop for too long.
 */
function syncHttpWrite(method: string, url: string, body: string): void {
  try {
    const statusRaw = execFileSync(
      "curl",
      appendVaultAuthCurlArgs([
        "-s",
        "-w",
        "\n%{http_code}",
        "-X",
        method,
        "-H",
        "Content-Type: text/plain",
        "--data-binary",
        "@-",
        url,
      ]),
      {
        input: body,
        encoding: "utf-8",
        timeout: 12_000,
        maxBuffer: 10_240,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const status = Number.parseInt(statusRaw.trim().split("\n").pop() || "0", 10);
    if (!Number.isFinite(status) || status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}`);
    }
  } catch (err: unknown) {
    const msg = formatVaultCurlError(err);
    throw new Error(`Vault HTTP ${method} ${url} failed: ${msg}`);
  }
}

/**
 * Unconditionally defer a session write. Marks the session as unflushed
 * so the background flush timer will retry later. NEVER throws.
 */
function deferSessionWrite(sessionManager: any, err: unknown, context: string): void {
  sessionManager._vaultFlushed = false;
  sessionManager.flushed = false;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[straja-vault] ${context} — deferred for retry: ${msg}`);
}

// ---------------------------------------------------------------------------
// Patch registration (called during plugin register, synchronous)
// ---------------------------------------------------------------------------

/**
 * Register a session patch callback on globalThis.
 *
 * This is called synchronously during plugin register(). It does NOT patch
 * SessionManager immediately -- instead it stores a callback that will be
 * invoked by flushPluginSetup() in attempt.ts, which passes the REAL
 * SessionManager class from the bundle.
 *
 * Also stores the vault base URL on globalThis so the gateway's
 * session-utils.fs.ts can read transcripts from the vault.
 *
 * This avoids all Jiti/ESM module identity issues.
 */
export function registerSessionPatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;

  // Expose vault URL for the gateway reader (session-utils.fs.ts)
  g[VAULT_READER_KEY] = baseUrl;

  // Store the patch callback
  g[SESSION_PATCH_KEY] = (
    SessionManager: any,
    parseSessionEntries: any,
    migrateSessionEntries: any,
  ) => {
    applyPatch(SessionManager, parseSessionEntries, migrateSessionEntries, baseUrl);
  };
}

// ---------------------------------------------------------------------------
// Actual patching logic (called with the REAL SessionManager)
// ---------------------------------------------------------------------------

function applyPatch(
  SessionManager: any,
  parseSessionEntries: (content: string) => any[],
  _migrateSessionEntries: (entries: any[]) => void,
  baseUrl: string,
): void {
  const rawUrl = (key: string) => `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`;

  const SM = SessionManager.prototype;
  if ((SM as Record<symbol, unknown>)[SESSION_PATCH_APPLIED_KEY] === true) {
    return;
  }

  // No original methods saved — disk I/O is fully suppressed.

  // -- Track unflushed sessions for background retry -------------------------
  // We use a Set<WeakRef> so that GC'd sessions are automatically cleaned up.
  const unflushedSessions = new Set<WeakRef<any>>();
  const registry = new FinalizationRegistry<WeakRef<any>>((ref) => {
    unflushedSessions.delete(ref);
  });

  function trackUnflushed(sm: any): void {
    // Avoid duplicates — check if already tracked
    for (const ref of unflushedSessions) {
      if (ref.deref() === sm) return;
    }
    const weakRef = new WeakRef(sm);
    unflushedSessions.add(weakRef);
    registry.register(sm, weakRef);
  }

  function untrackUnflushed(sm: any): void {
    for (const ref of unflushedSessions) {
      if (ref.deref() === sm) {
        unflushedSessions.delete(ref);
        return;
      }
    }
  }

  // -- Background flush timer (safety net) -----------------------------------
  // Retries writes for sessions that failed to persist. Runs every 5s.
  // This is ONLY needed when the vault process itself is unreachable —
  // the vault's internal write queue handles all SQLite contention.
  setInterval(() => {
    for (const ref of unflushedSessions) {
      const sm = ref.deref();
      if (!sm) {
        unflushedSessions.delete(ref);
        continue;
      }
      if (sm.flushed || !sm.persist || !sm.sessionFile) continue;
      if (!sm.fileEntries?.length) continue;

      const key = sessionPathToVaultKey(sm.sessionFile);
      const content = sm.fileEntries.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
      try {
        syncHttpWrite("PUT", rawUrl(key), content);
        sm._vaultFlushed = true;
        sm.flushed = true;
        untrackUnflushed(sm);
        console.log("[straja-vault] Background flush succeeded for session", key);
      } catch {
        // Still unreachable — will retry on next tick. No log spam.
      }
    }
  }, BACKGROUND_FLUSH_INTERVAL_MS).unref();

  // -- Override _persist(entry) ---------------------------------------------
  // Vault-only write (synchronous, fail-closed).
  // Note: _persist is called by _appendEntry which already pushed entry to
  // fileEntries and updated byId/leafId. We only need to handle persistence.
  SM._persist = function (this: any, entry: any) {
    if (!this.persist || !this.sessionFile) return;
    const hasAssistant = this.fileEntries.some(
      (e: any) => e.type === "message" && e.message?.role === "assistant",
    );
    if (!hasAssistant) {
      // Mirror the original behavior: mark as not flushed so all entries
      // get written when the first assistant message arrives.
      this.flushed = false;
      return;
    }

    const key = sessionPathToVaultKey(this.sessionFile);

    try {
      if (!this._vaultFlushed) {
        // Full flush: PUT all entries as the complete document
        const content = this.fileEntries.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
        syncHttpWrite("PUT", rawUrl(key), content);
        this._vaultFlushed = true;
        this.flushed = true;
        untrackUnflushed(this);
      } else {
        // Incremental: append just this entry
        syncHttpWrite("POST", rawUrl(key) + "/append", JSON.stringify(entry));
      }
    } catch (err: unknown) {
      // NEVER throw — defer unconditionally. Background flush timer retries.
      deferSessionWrite(this, err, "Session persist failed");
      trackUnflushed(this);
    }
  };

  // -- Override _rewriteFile() ----------------------------------------------
  // Vault-only write (synchronous, fail-closed). No disk write.
  SM._rewriteFile = function (this: any) {
    if (!this.persist || !this.sessionFile) return;
    const key = sessionPathToVaultKey(this.sessionFile);
    const content = this.fileEntries.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
    try {
      syncHttpWrite("PUT", rawUrl(key), content);
      this._vaultFlushed = true;
      this.flushed = true;
      untrackUnflushed(this);
    } catch (err: unknown) {
      // NEVER throw — defer unconditionally. Background flush timer retries.
      deferSessionWrite(this, err, "Session rewrite failed");
      trackUnflushed(this);
    }
  };

  // -- Override setSessionFile(path) ----------------------------------------
  // Vault-only read. No disk fallback.
  SM.setSessionFile = function (this: any, sessionFile: string) {
    const resolvedPath = resolve(sessionFile);
    const key = sessionPathToVaultKey(resolvedPath);

    // Read from vault (synchronous)
    const resp = syncHttpGet(rawUrl(key));
    let vaultEntries: any[] = [];
    if (resp.status === 200 && resp.body.trim()) {
      vaultEntries = parseSessionEntries(resp.body);
    } else if (resp.status !== 404) {
      throw new Error(`Vault session read failed (${resp.status}) for key ${key}`);
    }

    this.sessionFile = resolvedPath;
    this.fileEntries = vaultEntries;

    if (vaultEntries.length > 0) {
      const header = this.fileEntries.find((e: any) => e.type === "session");
      this.sessionId = header?.id ?? randomUUID();
    } else {
      this.sessionId = randomUUID();
    }

    this._buildIndex();
    this.flushed = true;
    this._vaultFlushed = vaultEntries.some(
      (e: any) => e.type === "message" && e.message?.role === "assistant",
    );
  };

  // -- Override createBranchedSession(leafId) --------------------------------
  const origCreateBranchedSession = SM.createBranchedSession;
  SM.createBranchedSession = function (this: any, leafId: string) {
    const result = origCreateBranchedSession.call(this, leafId);
    if (this.persist && this.sessionFile) {
      // Mirror the branched state to vault
      const key = sessionPathToVaultKey(this.sessionFile);
      const content = this.fileEntries.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
      try {
        syncHttpWrite("PUT", rawUrl(key), content);
        this._vaultFlushed = true;
        this.flushed = true;
        untrackUnflushed(this);
      } catch (err: unknown) {
        // NEVER throw — defer unconditionally. Background flush timer retries.
        deferSessionWrite(this, err, "Session branch write failed");
        trackUnflushed(this);
      }
    }
    return result;
  };

  (SM as Record<symbol, unknown>)[SESSION_PATCH_APPLIED_KEY] = true;
}
