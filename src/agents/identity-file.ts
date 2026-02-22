import { execFileSync } from "node:child_process";
import path from "node:path";
import { DEFAULT_IDENTITY_FILENAME } from "./workspace.js";

export type AgentIdentityFile = {
  name?: string;
  emoji?: string;
  theme?: string;
  creature?: string;
  vibe?: string;
  avatar?: string;
};

const IDENTITY_PLACEHOLDER_VALUES = new Set([
  "pick something you like",
  "ai? robot? familiar? ghost in the machine? something weirder?",
  "how do you come across? sharp? warm? chaotic? calm?",
  "your signature - pick one that feels right",
  "workspace-relative path, http(s) url, or data uri",
]);

function normalizeIdentityValue(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^[*_]+|[*_]+$/g, "").trim();
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  normalized = normalized.replace(/[\u2013\u2014]/g, "-");
  normalized = normalized.replace(/\s+/g, " ").toLowerCase();
  return normalized;
}

function isIdentityPlaceholder(value: string): boolean {
  const normalized = normalizeIdentityValue(value);
  return IDENTITY_PLACEHOLDER_VALUES.has(normalized);
}

export function parseIdentityMarkdown(content: string): AgentIdentityFile {
  const identity: AgentIdentityFile = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const label = cleaned.slice(0, colonIndex).replace(/[*_]/g, "").trim().toLowerCase();
    const value = cleaned
      .slice(colonIndex + 1)
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim();
    if (!value) {
      continue;
    }
    if (isIdentityPlaceholder(value)) {
      continue;
    }
    if (label === "name") {
      identity.name = value;
    }
    if (label === "emoji") {
      identity.emoji = value;
    }
    if (label === "creature") {
      identity.creature = value;
    }
    if (label === "vibe") {
      identity.vibe = value;
    }
    if (label === "theme") {
      identity.theme = value;
    }
    if (label === "avatar") {
      identity.avatar = value;
    }
  }
  return identity;
}

export function identityHasValues(identity: AgentIdentityFile): boolean {
  return Boolean(
    identity.name ||
    identity.emoji ||
    identity.theme ||
    identity.creature ||
    identity.vibe ||
    identity.avatar,
  );
}

// ---------------------------------------------------------------------------
// Vault-backed synchronous file reader
// ---------------------------------------------------------------------------

/** Well-known Symbol for the gateway workspace patch (vault-backed file ops). */
const GATEWAY_WORKSPACE_PATCH_KEY = Symbol.for("openclaw.gatewayWorkspacePatchCallback");

/**
 * Synchronous HTTP GET via curl to the vault.
 *
 * Same pattern as session-patch.ts — needed because callers of
 * loadIdentityFromFile() and loadAgentIdentityFromWorkspace() are
 * synchronous (agents.config.ts, identity-avatar.ts).
 */
function syncVaultRead(filename: string): string | null {
  const g = globalThis as Record<symbol, unknown>;
  const factory = g[GATEWAY_WORKSPACE_PATCH_KEY] as (() => { readFile: unknown }) | undefined;
  if (!factory) {
    return null;
  }

  // Resolve base URL from the vault reader key (also set by session-patch)
  const baseUrl = g[Symbol.for("openclaw.vaultReaderBaseUrl")] as string | undefined;
  if (!baseUrl) {
    return null;
  }

  const url = `${baseUrl}/raw/_workspace/${encodeURIComponent(filename)}`;

  try {
    const result = execFileSync("curl", ["-s", "-w", "\n%{http_code}", "-X", "GET", url], {
      encoding: "utf-8",
      timeout: 5_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const lines = result.trimEnd().split("\n");
    const statusLine = lines.pop() || "0";
    const status = parseInt(statusLine, 10);
    const body = lines.join("\n");

    if (status === 200 && body.trim()) {
      return body;
    }
    // 404 or empty → file not found
    return null;
  } catch {
    // curl failed (vault unreachable) — throw, no silent disk fallback
    throw new Error(`Vault identity read failed for ${filename}`);
  }
}

/**
 * Check whether vault I/O is available.
 * Returns true if both the gateway workspace patch and the vault reader base URL
 * are registered on globalThis.
 */
function isVaultAvailable(): boolean {
  const g = globalThis as Record<symbol, unknown>;
  const factory = g[GATEWAY_WORKSPACE_PATCH_KEY];
  const baseUrl = g[Symbol.for("openclaw.vaultReaderBaseUrl")];
  return Boolean(factory && baseUrl);
}

export function loadIdentityFromFile(identityPath: string): AgentIdentityFile | null {
  if (isVaultAvailable()) {
    // Vault mode: read from vault using the filename (basename)
    const filename = path.basename(identityPath);
    try {
      const content = syncVaultRead(filename);
      if (!content) {
        return null;
      }
      const parsed = parseIdentityMarkdown(content);
      if (!identityHasValues(parsed)) {
        return null;
      }
      return parsed;
    } catch {
      // Vault unreachable — no fallback to disk
      return null;
    }
  }

  // No vault registered (shouldn't happen in production, but safe for tests)
  return null;
}

export function loadAgentIdentityFromWorkspace(workspace: string): AgentIdentityFile | null {
  const identityPath = path.join(workspace, DEFAULT_IDENTITY_FILENAME);
  return loadIdentityFromFile(identityPath);
}
