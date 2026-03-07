import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { ensureVaultSessionManagerPatched } from "../../sessions/vault-session-manager.js";
import { withVaultAuthRequestInit } from "../../vault-auth.js";
import { resolveDefaultSessionStorePath, resolveSessionFilePath } from "./paths.js";
import { loadSessionStore, updateSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");
const VAULT_SESSION_COLLECTION = "_sessions";
const VAULT_TIMEOUT_MS = 5_000;

function getVaultSessionBaseUrl(): string | null {
  const g = globalThis as Record<symbol, unknown>;
  const value = g[VAULT_READER_KEY];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

function sessionFileToVaultKey(sessionFile: string): string {
  return path.basename(sessionFile);
}

function stripQuery(value: string): string {
  const noHash = value.split("#")[0] ?? value;
  return noHash.split("?")[0] ?? noHash;
}

function extractFileNameFromMediaUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = stripQuery(trimmed);
  try {
    const parsed = new URL(cleaned);
    const base = path.basename(parsed.pathname);
    if (!base) {
      return null;
    }
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  } catch {
    const base = path.basename(cleaned);
    if (!base || base === "/" || base === ".") {
      return null;
    }
    return base;
  }
}

export function resolveMirroredTranscriptText(params: {
  text?: string;
  mediaUrls?: string[];
}): string | null {
  const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    const names = mediaUrls
      .map((url) => extractFileNameFromMediaUrl(url))
      .filter((name): name is string => Boolean(name && name.trim()));
    if (names.length > 0) {
      return names.join(", ");
    }
    return "media";
  }

  const text = params.text ?? "";
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  const vaultBaseUrl = getVaultSessionBaseUrl();
  if (vaultBaseUrl) {
    const key = sessionFileToVaultKey(params.sessionFile);
    const url = `${vaultBaseUrl}/raw/${VAULT_SESSION_COLLECTION}/${encodeURIComponent(key)}`;
    const existing = await fetch(
      url,
      withVaultAuthRequestInit({
        method: "GET",
        signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
      }),
    );
    if (existing.status === 200) {
      return;
    }
    if (existing.status !== 404) {
      throw new Error(`vault session header read failed (${existing.status})`);
    }
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const writeResp = await fetch(
      url,
      withVaultAuthRequestInit({
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: `${JSON.stringify(header)}\n`,
        signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
      }),
    );
    if (!writeResp.ok) {
      throw new Error(`vault session header write failed (${writeResp.status})`);
    }
    return;
  }
  throw new Error(
    "[vault] ensureSessionHeader: vault session base URL missing; refusing disk transcript fallback",
  );
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
}): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  let sessionFile: string;
  try {
    sessionFile = resolveSessionFilePath(entry.sessionId, entry, {
      agentId: params.agentId,
      sessionsDir: path.dirname(storePath),
    });
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  ensureVaultSessionManagerPatched("appendAssistantMessageToSessionTranscript");
  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: mirrorText }],
    api: "openai-responses",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  if (!entry.sessionFile || entry.sessionFile !== sessionFile) {
    await updateSessionStore(
      storePath,
      (current) => {
        current[sessionKey] = {
          ...entry,
          sessionFile,
        };
      },
      { activeSessionKey: sessionKey },
    );
  }

  emitSessionTranscriptUpdate(sessionFile);
  return { ok: true, sessionFile };
}
