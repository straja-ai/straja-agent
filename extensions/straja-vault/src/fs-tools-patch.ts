/**
 * File Tools Patch — Routes agent's read/write/edit through Straja Vault
 *
 * Uses the same globalThis callback bridge pattern as session-patch.ts.
 * During plugin register(), we store a callback on a well-known Symbol.
 * In pi-tools.ts, when creating the read/write/edit tools, the bundle
 * checks for this callback and uses the vault operations if present.
 *
 * This avoids all Jiti/ESM module identity issues (same approach as
 * the session persistence patch).
 */

import {
  createVaultReadOperations,
  createVaultWriteOperations,
  createVaultEditOperations,
} from "./vault-fs-operations.js";

/** Well-known Symbol used to pass vault FS operations from plugin → bundle. */
export const FS_TOOLS_PATCH_KEY = Symbol.for("openclaw.fsToolsPatchCallback");

export interface VaultFsToolsPatch {
  readOperations: ReturnType<typeof createVaultReadOperations>;
  writeOperations: ReturnType<typeof createVaultWriteOperations>;
  editOperations: ReturnType<typeof createVaultEditOperations>;
}

/**
 * Register the FS tools patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from pi-tools.ts when creating the read/write/edit tools. It receives
 * the workspace root so it can properly strip path prefixes for vault keys.
 */
export function registerFsToolsPatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;

  g[FS_TOOLS_PATCH_KEY] = (workspaceRoot: string): VaultFsToolsPatch => {
    return {
      readOperations: createVaultReadOperations(baseUrl, workspaceRoot),
      writeOperations: createVaultWriteOperations(baseUrl, workspaceRoot),
      editOperations: createVaultEditOperations(baseUrl, workspaceRoot),
    };
  };
}
