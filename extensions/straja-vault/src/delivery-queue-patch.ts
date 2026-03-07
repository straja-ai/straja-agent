/**
 * Delivery Queue Patch — Routes delivery queue storage through Straja Vault HTTP API
 *
 * Uses the same globalThis callback bridge pattern as other vault patches.
 *
 * On disk, the delivery queue uses one JSON file per entry (UUID-named) with
 * `readdir()` for listing. Since the vault raw HTTP API doesn't expose a
 * collection-listing endpoint, we use two aggregate JSON documents:
 *   - `pending.json` — Record<uuid, QueuedDelivery> for in-flight entries
 *   - `failed.json` — Record<uuid, QueuedDelivery> for entries that exceeded max retries
 *
 * SQLite atomicity replaces the tmp+rename pattern used on disk.
 * The queue is small (typically 0-10 in-flight messages), so read-modify-write is fine.
 *
 * All operations are async (fetch), matching the async consumer API.
 *
 * No disk fallback — if the vault is unreachable, operations throw.
 */

import { vaultFetch } from "./http.js";

const COLLECTION = "_delivery_queue";
const TIMEOUT_MS = 5_000;

/** Well-known Symbol used to pass vault delivery queue ops from plugin → bundle. */
export const DELIVERY_QUEUE_PATCH_KEY = Symbol.for("openclaw.deliveryQueuePatchCallback");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeliveryQueuePatchOps {
  loadQueue(key: "pending" | "failed"): Promise<Record<string, unknown>>;
  saveQueue(key: "pending" | "failed", entries: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Vault-backed implementations
// ---------------------------------------------------------------------------

function createVaultDeliveryQueueOps(baseUrl: string): DeliveryQueuePatchOps {
  async function loadQueue(key: "pending" | "failed"): Promise<Record<string, unknown>> {
    const docKey = `${key}.json`;
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(docKey)}`;

    const resp = await vaultFetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (resp.status === 404) {
      return {};
    }

    if (!resp.ok) {
      throw new Error(`Vault delivery queue load failed: ${resp.status} ${resp.statusText}`);
    }

    const raw = await resp.text();
    if (!raw.trim()) {
      return {};
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async function saveQueue(
    key: "pending" | "failed",
    entries: Record<string, unknown>,
  ): Promise<void> {
    const docKey = `${key}.json`;
    const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(docKey)}`;
    const json = JSON.stringify(entries, null, 2);

    const resp = await vaultFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: json,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(`Vault delivery queue save failed: ${resp.status} ${resp.statusText}`);
    }
  }

  return { loadQueue, saveQueue };
}

// ---------------------------------------------------------------------------
// Patch registration (called during plugin register, synchronous)
// ---------------------------------------------------------------------------

/**
 * Register the delivery queue patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from delivery-queue.ts when performing queue operations.
 */
export function registerDeliveryQueuePatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;
  g[DELIVERY_QUEUE_PATCH_KEY] = (): DeliveryQueuePatchOps => {
    return createVaultDeliveryQueueOps(baseUrl);
  };
}
