/**
 * Vault-Backed File Operations
 *
 * Provides drop-in replacements for the filesystem operations used by
 * pi-coding-agent's read, write, and edit tools. Instead of touching the
 * host filesystem, every operation goes through the vault's HTTP API.
 *
 * The vault stores files in the `_workspace` collection, keyed by their
 * path relative to the workspace root (e.g. "src/main.ts").
 *
 * These operations are async (the tool framework already expects Promises)
 * and use `fetch()` to talk to the vault over localhost.
 */

const COLLECTION = "_workspace";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Convert an absolute filesystem path into a vault-relative key.
 *
 * The pi-coding-agent tools resolve paths relative to `cwd` (workspace root)
 * before calling operations. We strip the workspace root prefix so the vault
 * key is a clean relative path like "src/main.ts".
 *
 * If the path is already relative or doesn't start with the workspace root,
 * we use it as-is (stripping leading slashes).
 */
function toVaultKey(absolutePath: string, workspaceRoot: string): string {
  let key = absolutePath;
  if (key.startsWith(workspaceRoot)) {
    key = key.slice(workspaceRoot.length);
  }
  // Strip leading slashes
  while (key.startsWith("/")) {
    key = key.slice(1);
  }
  return key || absolutePath;
}

function rawUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(key)}`;
}

// ---------------------------------------------------------------------------
// MIME type detection (extension-based, no filesystem magic bytes)
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

function detectImageMimeFromExtension(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = path.slice(dot).toLowerCase();
  return IMAGE_EXTENSIONS[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export interface VaultReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

export function createVaultReadOperations(
  baseUrl: string,
  workspaceRoot: string,
): VaultReadOperations {
  return {
    async readFile(absolutePath: string): Promise<Buffer> {
      const key = toVaultKey(absolutePath, workspaceRoot);
      const resp = await fetch(rawUrl(baseUrl, key));
      if (!resp.ok) {
        throw new Error(`ENOENT: no such file or directory, open '${absolutePath}'`);
      }
      const text = await resp.text();
      return Buffer.from(text, "utf-8");
    },

    async access(absolutePath: string): Promise<void> {
      const key = toVaultKey(absolutePath, workspaceRoot);
      const resp = await fetch(rawUrl(baseUrl, key), { method: "GET" });
      if (!resp.ok) {
        throw new Error(`ENOENT: no such file or directory, access '${absolutePath}'`);
      }
      // Consume body to avoid connection leak
      await resp.text();
    },

    async detectImageMimeType(absolutePath: string): Promise<string | null> {
      return detectImageMimeFromExtension(absolutePath);
    },
  };
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

export interface VaultWriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

export function createVaultWriteOperations(
  baseUrl: string,
  workspaceRoot: string,
): VaultWriteOperations {
  return {
    async writeFile(absolutePath: string, content: string): Promise<void> {
      const key = toVaultKey(absolutePath, workspaceRoot);
      const resp = await fetch(rawUrl(baseUrl, key), {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: content,
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Vault write failed for '${absolutePath}': ${resp.status} ${errText}`);
      }
      // Consume body
      await resp.text();
    },

    async mkdir(_dir: string): Promise<void> {
      // No-op: vault uses flat path keys, no directory structure needed
    },
  };
}

// ---------------------------------------------------------------------------
// Edit operations
// ---------------------------------------------------------------------------

export interface VaultEditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

export function createVaultEditOperations(
  baseUrl: string,
  workspaceRoot: string,
): VaultEditOperations {
  const readOps = createVaultReadOperations(baseUrl, workspaceRoot);
  const writeOps = createVaultWriteOperations(baseUrl, workspaceRoot);

  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  };
}
