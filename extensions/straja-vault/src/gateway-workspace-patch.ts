/**
 * Gateway Workspace Patch — Routes gateway file operations through Straja Vault
 *
 * Uses the same globalThis callback bridge pattern as bootstrap-patch.ts.
 * Provides stat/read/write operations for workspace files used by the
 * gateway UI (agents.files.list, agents.files.get, agents.files.set),
 * identity file loading, workspace state, and auth JSON.
 *
 * The vault's `_workspace` collection is the sole source of truth.
 * No disk fallback — if the vault is unreachable, operations throw.
 */

const COLLECTION = "_workspace";

/** Well-known Symbol used to pass the workspace file ops from plugin → gateway. */
export const GATEWAY_WORKSPACE_PATCH_KEY = Symbol.for("openclaw.gatewayWorkspacePatchCallback");

export interface VaultFileMeta {
  size: number;
  updatedAtMs: number;
}

export interface GatewayWorkspaceOps {
  statFile(filename: string): Promise<VaultFileMeta | null>;
  readFile(filename: string): Promise<string | null>;
  writeFile(filename: string, content: string): Promise<void>;
}

/**
 * Stat a file in the vault's _workspace collection.
 *
 * Uses GET (vault doesn't support HEAD on /raw/) and computes size from body.
 * Returns metadata on 200, null on 404. Throws on vault errors.
 */
async function vaultStatFile(baseUrl: string, filename: string): Promise<VaultFileMeta | null> {
  const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(filename)}`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(3000),
  });

  if (resp.ok) {
    const text = await resp.text();
    return {
      size: new TextEncoder().encode(text).byteLength,
      updatedAtMs: Date.now(),
    };
  }

  if (resp.status === 404) {
    return null;
  }

  throw new Error(`Vault workspace stat failed: ${resp.status} ${resp.statusText} for ${filename}`);
}

/**
 * Read a file from the vault's _workspace collection.
 *
 * Returns content string on 200, null on 404. Throws on vault errors.
 */
async function vaultReadFile(baseUrl: string, filename: string): Promise<string | null> {
  const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(filename)}`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(3000),
  });

  if (resp.ok) {
    return await resp.text();
  }

  if (resp.status === 404) {
    return null;
  }

  throw new Error(`Vault workspace read failed: ${resp.status} ${resp.statusText} for ${filename}`);
}

/**
 * Write a file to the vault's _workspace collection.
 *
 * Uses PUT. Throws on vault errors — no silent failures.
 */
async function vaultWriteFile(baseUrl: string, filename: string, content: string): Promise<void> {
  const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(filename)}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: content,
    signal: AbortSignal.timeout(3000),
  });

  if (!resp.ok) {
    throw new Error(
      `Vault workspace write failed: ${resp.status} ${resp.statusText} for ${filename}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Patch registration (called during plugin register, synchronous)
// ---------------------------------------------------------------------------

/**
 * Register the gateway workspace patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from gateway handlers, identity-file.ts, workspace.ts, and pi-auth-json.ts.
 * Returns an ops object with stat/read/write functions.
 */
export function registerGatewayWorkspacePatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;

  const ops: GatewayWorkspaceOps = {
    statFile: (filename: string) => vaultStatFile(baseUrl, filename),
    readFile: (filename: string) => vaultReadFile(baseUrl, filename),
    writeFile: (filename: string, content: string) => vaultWriteFile(baseUrl, filename, content),
  };

  g[GATEWAY_WORKSPACE_PATCH_KEY] = (): GatewayWorkspaceOps => ops;
}

/**
 * Resolve the gateway workspace ops from globalThis.
 * Returns the ops object if registered, undefined if not.
 */
export function resolveGatewayWorkspaceOps(): GatewayWorkspaceOps | undefined {
  const g = globalThis as Record<symbol, unknown>;
  const factory = g[GATEWAY_WORKSPACE_PATCH_KEY] as (() => GatewayWorkspaceOps) | undefined;
  return factory?.();
}
