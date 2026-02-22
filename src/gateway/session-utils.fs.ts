import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveSessionFilePath,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
} from "../config/sessions.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { extractToolCallNames, hasToolCall } from "../utils/transcript-tools.js";
import { stripEnvelope } from "./chat-sanitize.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

// ---------------------------------------------------------------------------
// Vault reader — reads session transcripts from Straja Vault HTTP API
// instead of the filesystem. The vault base URL is set on globalThis by
// the straja-vault plugin during register().
// ---------------------------------------------------------------------------

const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");
const VAULT_COLLECTION = "_sessions";

function getVaultBaseUrl(): string | null {
  const g = globalThis as Record<symbol, unknown>;
  const url = g[VAULT_READER_KEY];
  if (typeof url === "string") {
    return url;
  }
  // Fallback to env var (always available, even before plugin registers)
  return process.env.STRAJA_VAULT_URL || "http://localhost:8181";
}

/**
 * Extract just the filename from a full filesystem path.
 * e.g. "/Users/x/.openclaw/agents/vault/sessions/abc-123.jsonl" -> "abc-123.jsonl"
 */
function pathToVaultKey(filePath: string): string {
  return path.basename(filePath);
}

/**
 * Synchronous HTTP GET from vault via curl.
 * Returns the raw JSONL text content, or null if not found / unreachable.
 */
function vaultGet(baseUrl: string, key: string): string | null {
  const url = `${baseUrl}/raw/${VAULT_COLLECTION}/${encodeURIComponent(key)}`;
  try {
    const result = execFileSync("curl", ["-s", "-w", "\n%{http_code}", "-X", "GET", url], {
      encoding: "utf-8",
      timeout: 5_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = result.trimEnd().split("\n");
    const statusLine = lines.pop() || "0";
    const status = parseInt(statusLine, 10);
    if (status !== 200) {
      return null;
    }
    const body = lines.join("\n");
    return body.trim() ? body : null;
  } catch {
    return null;
  }
}

/**
 * Write session JSONL content to vault (synchronous).
 * Used by the compact handler in sessions.ts.
 */
export function vaultWriteSessionContent(candidates: string[], content: string): void {
  const baseUrl = getVaultBaseUrl();
  if (!baseUrl) {
    return;
  }

  const key = pathToVaultKey(candidates[0]);
  const url = `${baseUrl}/raw/${VAULT_COLLECTION}/${encodeURIComponent(key)}`;
  try {
    execFileSync(
      "curl",
      ["-s", "-X", "PUT", "-H", "Content-Type: text/plain", "--data-binary", "@-", url],
      {
        input: content,
        encoding: "utf-8",
        timeout: 5_000,
        maxBuffer: 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    console.error(`[vault-session] PUT ${url} failed: ${String(err)}`);
  }
}

/** Check if vault storage is configured. */
export { getVaultBaseUrl };

/**
 * Read session JSONL content from vault for the given session candidates.
 * Tries each candidate path's filename as a vault key. Returns the raw
 * JSONL string on success, or null if not found.
 */
export function readVaultSessionContent(candidates: string[]): string | null {
  const baseUrl = getVaultBaseUrl();
  if (!baseUrl) {
    return null;
  }

  // Deduplicate vault keys (multiple paths may yield the same filename)
  const triedKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = pathToVaultKey(candidate);
    if (triedKeys.has(key)) {
      continue;
    }
    triedKeys.add(key);

    const content = vaultGet(baseUrl, key);
    if (content) {
      return content;
    }
  }
  return null;
}

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

type SessionTitleFieldsCacheEntry = SessionTitleFields & {
  mtimeMs: number;
  size: number;
};

const sessionTitleFieldsCache = new Map<string, SessionTitleFieldsCacheEntry>();
const MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES = 5000;

function _readSessionTitleFieldsCacheKey(
  filePath: string,
  opts?: { includeInterSession?: boolean },
) {
  const includeInterSession = opts?.includeInterSession === true ? "1" : "0";
  return `${filePath}\t${includeInterSession}`;
}

function _getCachedSessionTitleFields(cacheKey: string, stat: fs.Stats): SessionTitleFields | null {
  const cached = sessionTitleFieldsCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    sessionTitleFieldsCache.delete(cacheKey);
    return null;
  }
  // LRU bump
  sessionTitleFieldsCache.delete(cacheKey);
  sessionTitleFieldsCache.set(cacheKey, cached);
  return {
    firstUserMessage: cached.firstUserMessage,
    lastMessagePreview: cached.lastMessagePreview,
  };
}

function _setCachedSessionTitleFields(cacheKey: string, stat: fs.Stats, value: SessionTitleFields) {
  sessionTitleFieldsCache.set(cacheKey, {
    ...value,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
  while (sessionTitleFieldsCache.size > MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES) {
    const oldestKey = sessionTitleFieldsCache.keys().next().value;
    if (typeof oldestKey !== "string" || !oldestKey) {
      break;
    }
    sessionTitleFieldsCache.delete(oldestKey);
  }
}

export function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): unknown[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);

  const rawText = readVaultSessionContent(candidates);
  if (!rawText) {
    return [];
  }

  const lines = rawText.split(/\r?\n/);
  const messages: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        messages.push(parsed.message);
        continue;
      }

      // Compaction entries are not "message" records, but they're useful context for debugging.
      // Emit a lightweight synthetic message that the Web UI can render as a divider.
      if (parsed?.type === "compaction") {
        const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
        const timestamp = Number.isFinite(ts) ? ts : Date.now();
        messages.push({
          role: "system",
          content: [{ type: "text", text: "Compaction" }],
          timestamp,
          __openclaw: {
            kind: "compaction",
            id: typeof parsed.id === "string" ? parsed.id : undefined,
          },
        });
      }
    } catch {
      // ignore bad lines
    }
  }
  return messages;
}

export function resolveSessionTranscriptCandidates(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string[] {
  const candidates: string[] = [];
  const pushCandidate = (resolve: () => string): void => {
    try {
      candidates.push(resolve());
    } catch {
      // Ignore invalid paths/IDs and keep scanning other safe candidates.
    }
  };

  if (storePath) {
    const sessionsDir = path.dirname(storePath);
    if (sessionFile) {
      pushCandidate(() =>
        resolveSessionFilePath(sessionId, { sessionFile }, { sessionsDir, agentId }),
      );
    }
    pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, sessionsDir));
  } else if (sessionFile) {
    if (agentId) {
      pushCandidate(() => resolveSessionFilePath(sessionId, { sessionFile }, { agentId }));
    } else {
      const trimmed = sessionFile.trim();
      if (trimmed) {
        candidates.push(path.resolve(trimmed));
      }
    }
  }

  if (agentId) {
    pushCandidate(() => resolveSessionTranscriptPath(sessionId, agentId));
  }

  const home = resolveRequiredHomeDir(process.env, os.homedir);
  const legacyDir = path.join(home, ".openclaw", "sessions");
  pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, legacyDir));

  return Array.from(new Set(candidates));
}

export type ArchiveFileReason = "bak" | "reset" | "deleted";

export function archiveFileOnDisk(filePath: string, reason: ArchiveFileReason): string {
  const ts = new Date().toISOString().replaceAll(":", "-");
  const archived = `${filePath}.${reason}.${ts}`;
  fs.renameSync(filePath, archived);
  return archived;
}

/**
 * Archives all transcript files for a given session.
 * Best-effort: silently skips files that don't exist or fail to rename.
 */
export function archiveSessionTranscripts(opts: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): string[] {
  const archived: string[] = [];
  for (const candidate of resolveSessionTranscriptCandidates(
    opts.sessionId,
    opts.storePath,
    opts.sessionFile,
    opts.agentId,
  )) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      archived.push(archiveFileOnDisk(candidate, opts.reason));
    } catch {
      // Best-effort.
    }
  }
  return archived;
}

function restoreArchiveTimestamp(raw: string): string {
  const [datePart, timePart] = raw.split("T");
  if (!datePart || !timePart) {
    return raw;
  }
  return `${datePart}T${timePart.replace(/-/g, ":")}`;
}

function parseArchivedTimestamp(fileName: string, reason: ArchiveFileReason): number | null {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }
  const raw = fileName.slice(index + marker.length);
  if (!raw) {
    return null;
  }
  const timestamp = Date.parse(restoreArchiveTimestamp(raw));
  return Number.isNaN(timestamp) ? null : timestamp;
}

export async function cleanupArchivedSessionTranscripts(opts: {
  directories: string[];
  olderThanMs: number;
  reason?: "deleted";
  nowMs?: number;
}): Promise<{ removed: number; scanned: number }> {
  if (!Number.isFinite(opts.olderThanMs) || opts.olderThanMs < 0) {
    return { removed: 0, scanned: 0 };
  }
  const now = opts.nowMs ?? Date.now();
  const reason: ArchiveFileReason = opts.reason ?? "deleted";
  const directories = Array.from(new Set(opts.directories.map((dir) => path.resolve(dir))));
  let removed = 0;
  let scanned = 0;

  for (const dir of directories) {
    const entries = await fs.promises.readdir(dir).catch(() => []);
    for (const entry of entries) {
      const timestamp = parseArchivedTimestamp(entry, reason);
      if (timestamp == null) {
        continue;
      }
      scanned += 1;
      if (now - timestamp <= opts.olderThanMs) {
        continue;
      }
      const fullPath = path.join(dir, entry);
      const stat = await fs.promises.stat(fullPath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      await fs.promises.rm(fullPath).catch(() => undefined);
      removed += 1;
    }
  }

  return { removed, scanned };
}

function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

export function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
): { items: T[]; bytes: number } {
  if (items.length === 0) {
    return { items, bytes: 2 };
  }
  const parts = items.map((item) => jsonUtf8Bytes(item));
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= parts[start] + 1;
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

const MAX_LINES_TO_SCAN = 10;

type TranscriptMessage = {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  provenance?: unknown;
};

export function readSessionTitleFieldsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);

  const content = readVaultSessionContent(candidates);
  if (!content) {
    return { firstUserMessage: null, lastMessagePreview: null };
  }

  // Extract first user message from head
  let firstUserMessage: string | null = null;
  try {
    const headChunk = content.slice(0, 8192);
    firstUserMessage = extractFirstUserMessageFromTranscriptChunk(headChunk, opts);
  } catch {
    // ignore
  }

  // Extract last message preview from tail
  let lastMessagePreview: string | null = null;
  try {
    const tailChunk = content.slice(-LAST_MSG_MAX_BYTES);
    lastMessagePreview = extractLastMessagePreviewFromChunk(tailChunk);
  } catch {
    // ignore
  }

  return { firstUserMessage, lastMessagePreview };
}

function extractTextFromContent(content: TranscriptMessage["content"]): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    if (!part || typeof part.text !== "string") {
      continue;
    }
    if (part.type === "text" || part.type === "output_text" || part.type === "input_text") {
      const trimmed = part.text.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

function _readTranscriptHeadChunk(fd: number, maxBytes = 8192): string | null {
  const buf = Buffer.alloc(maxBytes);
  const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
  if (bytesRead <= 0) {
    return null;
  }
  return buf.toString("utf-8", 0, bytesRead);
}

function extractFirstUserMessageFromTranscriptChunk(
  chunk: string,
  opts?: { includeInterSession?: boolean },
): string | null {
  const lines = chunk.split(/\r?\n/).slice(0, MAX_LINES_TO_SCAN);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptMessage | undefined;
      if (msg?.role !== "user") {
        continue;
      }
      if (opts?.includeInterSession !== true && hasInterSessionUserProvenance(msg)) {
        continue;
      }
      const text = extractTextFromContent(msg.content);
      if (text) {
        return text;
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

function _findExistingTranscriptPath(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function _withOpenTranscriptFd<T>(filePath: string, read: (fd: number) => T | null): T | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    return read(fd);
  } catch {
    // file read error
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
  return null;
}

export function readFirstUserMessageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);

  const content = readVaultSessionContent(candidates);
  if (!content) {
    return null;
  }
  const headChunk = content.slice(0, 8192);
  return extractFirstUserMessageFromTranscriptChunk(headChunk, opts);
}

const LAST_MSG_MAX_BYTES = 16384;
const LAST_MSG_MAX_LINES = 20;

function extractLastMessagePreviewFromChunk(chunk: string): string | null {
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
  const tailLines = lines.slice(-LAST_MSG_MAX_LINES);

  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptMessage | undefined;
      if (msg?.role !== "user" && msg?.role !== "assistant") {
        continue;
      }
      const text = extractTextFromContent(msg.content);
      if (text) {
        return text;
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

function _readLastMessagePreviewFromOpenTranscript(params: {
  fd: number;
  size: number;
}): string | null {
  const readStart = Math.max(0, params.size - LAST_MSG_MAX_BYTES);
  const readLen = Math.min(params.size, LAST_MSG_MAX_BYTES);
  const buf = Buffer.alloc(readLen);
  fs.readSync(params.fd, buf, 0, readLen, readStart);

  return extractLastMessagePreviewFromChunk(buf.toString("utf-8"));
}

export function readLastMessagePreviewFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);

  const content = readVaultSessionContent(candidates);
  if (!content) {
    return null;
  }
  const tailChunk = content.slice(-LAST_MSG_MAX_BYTES);
  return extractLastMessagePreviewFromChunk(tailChunk);
}

const _PREVIEW_READ_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024];
const PREVIEW_MAX_LINES = 200;

type TranscriptContentEntry = {
  type?: string;
  text?: string;
  name?: string;
};

type TranscriptPreviewMessage = {
  role?: string;
  content?: string | TranscriptContentEntry[];
  text?: string;
  toolName?: string;
  tool_name?: string;
};

function normalizeRole(role: string | undefined, isTool: boolean): SessionPreviewItem["role"] {
  if (isTool) {
    return "tool";
  }
  switch ((role ?? "").toLowerCase()) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return "other";
  }
}

function truncatePreviewText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function extractPreviewText(message: TranscriptPreviewMessage): string | null {
  if (typeof message.content === "string") {
    const trimmed = message.content.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
      .filter((text) => text.trim().length > 0);
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }
  if (typeof message.text === "string") {
    const trimmed = message.text.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function isToolCall(message: TranscriptPreviewMessage): boolean {
  return hasToolCall(message as Record<string, unknown>);
}

function extractToolNames(message: TranscriptPreviewMessage): string[] {
  return extractToolCallNames(message as Record<string, unknown>);
}

function extractMediaSummary(message: TranscriptPreviewMessage): string | null {
  if (!Array.isArray(message.content)) {
    return null;
  }
  for (const entry of message.content) {
    const raw = typeof entry?.type === "string" ? entry.type.trim().toLowerCase() : "";
    if (!raw || raw === "text" || raw === "toolcall" || raw === "tool_call") {
      continue;
    }
    return `[${raw}]`;
  }
  return null;
}

function buildPreviewItems(
  messages: TranscriptPreviewMessage[],
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const items: SessionPreviewItem[] = [];
  for (const message of messages) {
    const toolCall = isToolCall(message);
    const role = normalizeRole(message.role, toolCall);
    let text = extractPreviewText(message);
    if (!text) {
      const toolNames = extractToolNames(message);
      if (toolNames.length > 0) {
        const shown = toolNames.slice(0, 2);
        const overflow = toolNames.length - shown.length;
        text = `call ${shown.join(", ")}`;
        if (overflow > 0) {
          text += ` +${overflow}`;
        }
      }
    }
    if (!text) {
      text = extractMediaSummary(message);
    }
    if (!text) {
      continue;
    }
    let trimmed = text.trim();
    if (!trimmed) {
      continue;
    }
    if (role === "user") {
      trimmed = stripEnvelope(trimmed);
    }
    trimmed = truncatePreviewText(trimmed, maxChars);
    items.push({ role, text: trimmed });
  }

  if (items.length <= maxItems) {
    return items;
  }
  return items.slice(-maxItems);
}

function _readRecentMessagesFromTranscript(
  filePath: string,
  maxMessages: number,
  readBytes: number,
): TranscriptPreviewMessage[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) {
      return [];
    }

    const readStart = Math.max(0, size - readBytes);
    const readLen = Math.min(size, readBytes);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readStart);

    const chunk = buf.toString("utf-8");
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
    const tailLines = lines.slice(-PREVIEW_MAX_LINES);

    const collected: TranscriptPreviewMessage[] = [];
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i];
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message as TranscriptPreviewMessage | undefined;
        if (msg && typeof msg === "object") {
          collected.push(msg);
          if (collected.length >= maxMessages) {
            break;
          }
        }
      } catch {
        // skip malformed lines
      }
    }
    return collected.toReversed();
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function extractRecentMessagesFromContent(
  content: string,
  maxMessages: number,
): TranscriptPreviewMessage[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const tailLines = lines.slice(-PREVIEW_MAX_LINES);

  const collected: TranscriptPreviewMessage[] = [];
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptPreviewMessage | undefined;
      if (msg && typeof msg === "object") {
        collected.push(msg);
        if (collected.length >= maxMessages) {
          break;
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return collected.toReversed();
}

export function readSessionPreviewItemsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);

  const boundedItems = Math.max(1, Math.min(maxItems, 50));
  const boundedChars = Math.max(20, Math.min(maxChars, 2000));

  const content = readVaultSessionContent(candidates);
  if (!content) {
    return [];
  }
  const messages = extractRecentMessagesFromContent(content, boundedItems);
  return buildPreviewItems(messages, boundedItems, boundedChars);
}
