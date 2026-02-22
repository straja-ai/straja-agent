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
 * - Reads (setSessionFile) load exclusively from vault. If vault is empty
 *   or unreachable, a new empty session is started.
 *
 * The vault must be running on the configured baseUrl for this to work.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const COLLECTION = "_sessions";

/** Well-known Symbol used to pass the patch callback from plugin -> bundle. */
export const SESSION_PATCH_KEY = Symbol.for("openclaw.sessionPatchCallback");

/** Well-known Symbol used to expose the vault base URL to the gateway reader. */
export const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");

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
  const args = ["-s", "-w", "\n%{http_code}", "-X", "GET", url];

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
    const msg = err instanceof Error ? err.message : String(err);
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
    execFileSync(
      "curl",
      ["-s", "-X", method, "-H", "Content-Type: text/plain", "--data-binary", "@-", url],
      {
        input: body,
        encoding: "utf-8",
        timeout: 5_000,
        maxBuffer: 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    console.error(`[vault-session] ${method} ${url} failed: ${err}`);
  }
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

  // No original methods saved — disk I/O is fully suppressed.

  // -- Override _persist(entry) ---------------------------------------------
  // Vault-only write (async, non-blocking).
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

    if (!this._vaultFlushed) {
      // Full flush: PUT all entries as the complete document
      const content = this.fileEntries.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
      syncHttpWrite("PUT", rawUrl(key), content);
      this._vaultFlushed = true;
      this.flushed = true;
    } else {
      // Incremental: append just this entry
      syncHttpWrite("POST", rawUrl(key) + "/append", JSON.stringify(entry));
    }
  };

  // -- Override _rewriteFile() ----------------------------------------------
  // Vault-only write (async, non-blocking). No disk write.
  SM._rewriteFile = function (this: any) {
    if (!this.persist || !this.sessionFile) return;
    const key = sessionPathToVaultKey(this.sessionFile);
    const content = this.fileEntries.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
    syncHttpWrite("PUT", rawUrl(key), content);
  };

  // -- Override setSessionFile(path) ----------------------------------------
  // Vault-only read. No disk fallback.
  SM.setSessionFile = function (this: any, sessionFile: string) {
    const resolvedPath = resolve(sessionFile);
    const key = sessionPathToVaultKey(resolvedPath);

    // Read from vault (synchronous)
    let vaultEntries: any[] = [];
    try {
      const resp = syncHttpGet(rawUrl(key));
      if (resp.status === 200 && resp.body.trim()) {
        vaultEntries = parseSessionEntries(resp.body);
      }
    } catch {
      // Vault unreachable — start with empty session
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
    this._vaultFlushed = vaultEntries.length > 0;
  };

  // -- Override createBranchedSession(leafId) --------------------------------
  const origCreateBranchedSession = SM.createBranchedSession;
  SM.createBranchedSession = function (this: any, leafId: string) {
    const result = origCreateBranchedSession.call(this, leafId);
    if (this.persist && this.sessionFile) {
      // Mirror the branched state to vault
      const key = sessionPathToVaultKey(this.sessionFile);
      const content = this.fileEntries.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
      syncHttpWrite("PUT", rawUrl(key), content);
    }
    return result;
  };
}
