/**
 * Cron Store Patch — Routes cron job storage through Straja Vault HTTP API
 *
 * Uses the same globalThis callback bridge pattern as session-patch.ts,
 * bootstrap-patch.ts, fs-tools-patch.ts, and gateway-workspace-patch.ts.
 *
 * During plugin register(), we store a factory function on a well-known
 * Symbol. In store.ts and run-log.ts, the core checks for this callback
 * and uses vault-backed storage if present.
 *
 * The vault's `_cron` collection stores:
 *   - `jobs.json` — the cron job store (identical format to filesystem)
 *   - `runs/{jobId}.jsonl` — per-job run history (JSONL, one entry per line)
 *
 * No disk fallback — if the vault is unreachable, operations throw.
 */

const COLLECTION = "_cron";

/** Well-known Symbol used to pass vault cron store ops from plugin → bundle. */
export const CRON_STORE_PATCH_KEY = Symbol.for("openclaw.cronStorePatchCallback");

/** Timeout for vault HTTP calls (ms). */
const TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types (mirrored from core to avoid import issues across Jiti boundary)
// ---------------------------------------------------------------------------

interface CronStoreFile {
  version: 1;
  jobs: Array<Record<string, unknown>>;
}

interface CronRunLogEntry {
  ts: number;
  jobId: string;
  action: "finished";
  status?: string;
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: Record<string, unknown>;
}

export interface CronStorePatchOps {
  loadCronStore: (storePath: string) => Promise<CronStoreFile>;
  saveCronStore: (storePath: string, store: CronStoreFile) => Promise<void>;
  appendCronRunLog: (
    filePath: string,
    entry: CronRunLogEntry,
    opts?: { maxBytes?: number; keepLines?: number },
  ) => Promise<void>;
  readCronRunLogEntries: (
    filePath: string,
    opts?: { limit?: number; jobId?: string },
  ) => Promise<CronRunLogEntry[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract jobId from a filesystem run-log path.
 * The CronService passes paths like `/home/x/.openclaw/cron/runs/{jobId}.jsonl`.
 */
function extractJobIdFromPath(filePath: string): string {
  const basename = filePath.split("/").pop() || filePath;
  return basename.replace(/\.jsonl$/, "");
}

/**
 * Parse JSONL content into CronRunLogEntry objects.
 * Mirrors the validation logic from the core readCronRunLogEntries.
 */
function parseRunLogEntries(
  raw: string,
  opts?: { limit?: number; jobId?: string },
): CronRunLogEntry[] {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 200)));
  const jobId = opts?.jobId?.trim() || undefined;

  if (!raw.trim()) {
    return [];
  }

  const parsed: CronRunLogEntry[] = [];
  const lines = raw.split("\n");

  // Read from end (most recent first), then reverse for chronological order
  for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;

    try {
      const obj = JSON.parse(line) as Partial<CronRunLogEntry> | null;
      if (!obj || typeof obj !== "object") continue;
      if (obj.action !== "finished") continue;
      if (typeof obj.jobId !== "string" || obj.jobId.trim().length === 0) continue;
      if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) continue;
      if (jobId && obj.jobId !== jobId) continue;

      const usage =
        obj.usage && typeof obj.usage === "object"
          ? (obj.usage as Record<string, unknown>)
          : undefined;

      const entry: CronRunLogEntry = {
        ts: obj.ts,
        jobId: obj.jobId,
        action: "finished",
        status: obj.status,
        error: obj.error,
        summary: obj.summary,
        runAtMs: obj.runAtMs,
        durationMs: obj.durationMs,
        nextRunAtMs: obj.nextRunAtMs,
        model: typeof obj.model === "string" && obj.model.trim() ? obj.model : undefined,
        provider:
          typeof obj.provider === "string" && obj.provider.trim() ? obj.provider : undefined,
        usage: usage
          ? {
              input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
              output_tokens:
                typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
              total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
              cache_read_tokens:
                typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : undefined,
              cache_write_tokens:
                typeof usage.cache_write_tokens === "number" ? usage.cache_write_tokens : undefined,
            }
          : undefined,
      };

      if (typeof obj.sessionId === "string" && obj.sessionId.trim().length > 0) {
        entry.sessionId = obj.sessionId;
      }
      if (typeof obj.sessionKey === "string" && obj.sessionKey.trim().length > 0) {
        entry.sessionKey = obj.sessionKey;
      }

      parsed.push(entry);
    } catch {
      // ignore invalid lines
    }
  }

  return parsed.toReversed();
}

// ---------------------------------------------------------------------------
// Vault-backed implementations
// ---------------------------------------------------------------------------

function createVaultCronStoreOps(baseUrl: string): CronStorePatchOps {
  const storeKey = "jobs.json";

  // Serialization lock for run-log appends (prevents interleaving per key)
  const writesByKey = new Map<string, Promise<void>>();

  async function loadCronStore(_storePath: string): Promise<CronStoreFile> {
    const resp = await fetch(`${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(storeKey)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (resp.status === 404) {
      return { version: 1, jobs: [] };
    }

    if (!resp.ok) {
      throw new Error(`Vault cron store load failed: ${resp.status} ${resp.statusText}`);
    }

    const raw = await resp.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse vault cron store: ${String(err)}`);
    }

    const parsedRecord =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];

    return {
      version: 1,
      jobs: jobs.filter(Boolean) as CronStoreFile["jobs"],
    };
  }

  async function saveCronStore(_storePath: string, store: CronStoreFile): Promise<void> {
    const json = JSON.stringify(store, null, 2);
    const resp = await fetch(`${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(storeKey)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: json,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(`Vault cron store save failed: ${resp.status} ${resp.statusText}`);
    }
  }

  async function pruneRunLogIfNeeded(
    key: string,
    opts?: { maxBytes?: number; keepLines?: number },
  ): Promise<void> {
    const maxBytes = opts?.maxBytes ?? 2_000_000;
    const keepLines = opts?.keepLines ?? 2_000;

    // Read current content to check size
    const resp = await fetch(`${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) return;

    const raw = await resp.text();
    if (raw.length <= maxBytes) return;

    // Prune: keep last N lines
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const kept = lines.slice(Math.max(0, lines.length - keepLines));
    const trimmed = kept.join("\n") + "\n";

    // Overwrite with pruned content
    await fetch(`${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: trimmed,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function appendCronRunLog(
    filePath: string,
    entry: CronRunLogEntry,
    opts?: { maxBytes?: number; keepLines?: number },
  ): Promise<void> {
    const jobId = extractJobIdFromPath(filePath);
    const key = `runs/${jobId}.jsonl`;
    const line = JSON.stringify(entry);

    // Serialize writes per key to prevent interleaving
    const prev = writesByKey.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const resp = await fetch(`${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}/append`, {
          method: "POST",
          body: line,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!resp.ok) {
          throw new Error(`Vault cron run log append failed: ${resp.status} ${resp.statusText}`);
        }

        // Fire-and-forget prune check
        void pruneRunLogIfNeeded(key, opts).catch(() => {});
      });

    writesByKey.set(key, next);
    await next;
  }

  async function readCronRunLogEntries(
    filePath: string,
    opts?: { limit?: number; jobId?: string },
  ): Promise<CronRunLogEntry[]> {
    const jobId = extractJobIdFromPath(filePath);
    const key = `runs/${jobId}.jsonl`;

    const resp = await fetch(`${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (resp.status === 404) {
      return [];
    }

    if (!resp.ok) {
      throw new Error(`Vault cron run log read failed: ${resp.status} ${resp.statusText}`);
    }

    const raw = await resp.text();
    return parseRunLogEntries(raw, { ...opts, jobId: opts?.jobId ?? jobId });
  }

  return { loadCronStore, saveCronStore, appendCronRunLog, readCronRunLogEntries };
}

// ---------------------------------------------------------------------------
// Patch registration (called during plugin register, synchronous)
// ---------------------------------------------------------------------------

/**
 * Register the cron store patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from store.ts and run-log.ts when the cron service performs storage
 * operations. Returns vault-backed implementations of all four storage
 * functions.
 */
export function registerCronStorePatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;

  // Store a factory that creates the ops object. The consumer calls factory()
  // to get the ops — matching the pattern used by all other vault patches.
  g[CRON_STORE_PATCH_KEY] = (): CronStorePatchOps => {
    return createVaultCronStoreOps(baseUrl);
  };
}
