/**
 * Audit Patch — Routes audit entries from the agent bundle to the vault's
 * `_audit` collection via the dedicated `POST /audit/append` endpoint.
 *
 * Uses the same globalThis callback bridge pattern as other vault patches.
 *
 * The vault's `_audit` collection is write-protected from raw endpoints,
 * so agent-side code cannot use the regular `/raw/` API. This patch calls
 * the dedicated `/audit/append` endpoint which bypasses that restriction.
 *
 * All operations are async (fetch) and best-effort (consumers catch errors).
 */

import { vaultFetch } from "./http.js";

const TIMEOUT_MS = 5_000;

/** Well-known Symbol used to pass vault audit ops from plugin → bundle. */
export const AUDIT_PATCH_KEY = Symbol.for("openclaw.auditPatchCallback");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditPatchOps {
  /** Append a single audit entry to the named category. */
  appendEntry(category: string, entry: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Vault-backed implementation
// ---------------------------------------------------------------------------

function createVaultAuditOps(baseUrl: string): AuditPatchOps {
  async function appendEntry(category: string, entry: Record<string, unknown>): Promise<void> {
    const url = `${baseUrl}/audit/append`;

    const resp = await vaultFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, entry }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(`Vault audit append failed: ${resp.status} ${resp.statusText}`);
    }
  }

  return { appendEntry };
}

// ---------------------------------------------------------------------------
// Patch registration (called during plugin register, synchronous)
// ---------------------------------------------------------------------------

/**
 * Register the audit patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from agent-side consumers (deliver.ts, bot-message.ts) when emitting
 * audit entries for messaging and other agent-side operations.
 */
export function registerAuditPatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;
  g[AUDIT_PATCH_KEY] = (): AuditPatchOps => {
    return createVaultAuditOps(baseUrl);
  };
}
