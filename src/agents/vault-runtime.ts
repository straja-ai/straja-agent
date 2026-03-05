const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");
const SESSION_STORE_PATCH_KEY = Symbol.for("openclaw.sessionStorePatchCallback");
const SUBAGENT_REGISTRY_PATCH_KEY = Symbol.for("openclaw.subagentRegistryPatchCallback");
const FS_TOOLS_PATCH_KEY = Symbol.for("openclaw.fsToolsPatchCallback");
const VAULT_PROBE_COLLECTION = "_workspace";
const VAULT_PROBE_KEY = "__vault_required_probe__";
const VAULT_PROBE_TIMEOUT_MS = 3_000;

function normalizeVaultBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function assertVaultPatchCallbacks(context: string): string {
  const g = globalThis as Record<symbol, unknown>;
  const baseUrl = normalizeVaultBaseUrl(g[VAULT_READER_KEY]);
  if (!baseUrl) {
    throw new Error(`[vault] ${context}: vault session base URL is missing`);
  }
  if (typeof g[SESSION_STORE_PATCH_KEY] !== "function") {
    throw new Error(`[vault] ${context}: session-store patch is missing`);
  }
  if (typeof g[SUBAGENT_REGISTRY_PATCH_KEY] !== "function") {
    throw new Error(`[vault] ${context}: subagent-registry patch is missing`);
  }
  if (typeof g[FS_TOOLS_PATCH_KEY] !== "function") {
    throw new Error(`[vault] ${context}: fs-tools patch is missing`);
  }
  return baseUrl;
}

export async function assertVaultRuntimeReady(context: string): Promise<string> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return "test://vault-bypass";
  }
  const baseUrl = assertVaultPatchCallbacks(context);

  const probeUrl = `${baseUrl}/raw/${VAULT_PROBE_COLLECTION}/${encodeURIComponent(VAULT_PROBE_KEY)}`;
  let response: Response;
  try {
    response = await fetch(probeUrl, {
      method: "GET",
      signal: AbortSignal.timeout(VAULT_PROBE_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[vault] ${context}: vault is unreachable at ${baseUrl}: ${msg}`, {
      cause: err,
    });
  }

  const status = response.status;
  if (!Number.isFinite(status) || status <= 0 || status >= 500) {
    throw new Error(`[vault] ${context}: vault probe failed (${status}) at ${baseUrl}`);
  }
  return baseUrl;
}
