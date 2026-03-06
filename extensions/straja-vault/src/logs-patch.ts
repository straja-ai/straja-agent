/**
 * Logs Patch — Routes append-only log files through Straja Vault HTTP API
 *
 * Uses the same globalThis callback bridge pattern as other vault patches.
 *
 * The vault's `_logs` collection stores:
 *   - `commands.log` — JSONL command audit log (from command-logger hook)
 *   - `config-audit.jsonl` — JSONL config write audit trail (from config/io.ts)
 *
 * Both are append-only. Uses the vault's `POST /raw/:collection/:path/append`
 * endpoint which handles line-ending normalization.
 *
 * All operations are async (fetch). Both consumers are best-effort
 * (errors are swallowed).
 *
 * No disk fallback — if the vault is unreachable, operations throw
 * (but consumers catch).
 */

const COLLECTION = "_logs";
const TIMEOUT_MS = 5_000;

/** Well-known Symbol used to pass vault logs ops from plugin → bundle. */
export const LOGS_PATCH_KEY = Symbol.for("openclaw.logsPatchCallback");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogsPatchOps {
  /** Append a single line to the named log file. The line should NOT include a trailing newline. */
  appendLine(logName: string, line: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Vault-backed implementations
// ---------------------------------------------------------------------------

function createVaultLogsOps(baseUrl: string): LogsPatchOps {
  async function appendLine(logName: string, line: string): Promise<void> {
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(logName)}/append`;

    const resp = await fetch(url, {
      method: "POST",
      body: line,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(`Vault log append failed: ${resp.status} ${resp.statusText}`);
    }
  }

  return { appendLine };
}

// ---------------------------------------------------------------------------
// Patch registration (called during plugin register, synchronous)
// ---------------------------------------------------------------------------

/**
 * Register the logs patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from command-logger/handler.ts and config/io.ts when appending log entries.
 */
export function registerLogsPatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;
  g[LOGS_PATCH_KEY] = (): LogsPatchOps => {
    return createVaultLogsOps(baseUrl);
  };
}
