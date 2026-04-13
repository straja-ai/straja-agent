import crypto from "node:crypto";
import { logVerbose } from "../../globals.js";
import { safeJsonStringify } from "../../utils/safe-json.js";
import { withVaultAuthRequestInit } from "../../vault-auth.js";

const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");
const ORCHESTRATION_COLLECTION = "_orchestration";

function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (depth > 10) {
    return "[max-depth]";
  }
  if (value == null) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return {
      type: "buffer",
      bytes: value.byteLength,
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTraceValue(entry, depth + 1));
  }
  if (typeof value !== "object") {
    return safeJsonStringify(value) ?? "[unserializable]";
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.type === "string" &&
    typeof record.data === "string" &&
    (record.type === "image" || record.type === "audio" || record.type === "file")
  ) {
    return {
      ...Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => key !== "data")
          .map(([key, entry]) => [key, sanitizeTraceValue(entry, depth + 1)]),
      ),
      data: `[omitted ${record.type} payload: ${record.data.length} chars]`,
    };
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, sanitizeTraceValue(entry, depth + 1)]),
  );
}

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

function resolveVaultBaseUrl(): string | null {
  const g = globalThis as Record<symbol, unknown>;
  return normalizeVaultBaseUrl(g[VAULT_READER_KEY]);
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function writeVaultJson(path: string, payload: unknown): Promise<boolean> {
  const baseUrl = resolveVaultBaseUrl();
  if (!baseUrl) {
    return false;
  }
  const body = safeJsonStringify(sanitizeTraceValue(payload));
  if (!body) {
    return false;
  }
  const resp = await fetch(
    `${baseUrl}/raw/${ORCHESTRATION_COLLECTION}/${encodeURIComponent(path)}`,
    withVaultAuthRequestInit({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5_000),
    }),
  );
  if (!resp.ok) {
    throw new Error(`vault PUT ${path} failed (${resp.status})`);
  }
  return true;
}

async function readVaultJson(path: string): Promise<Record<string, unknown> | null> {
  const baseUrl = resolveVaultBaseUrl();
  if (!baseUrl) {
    return null;
  }
  const resp = await fetch(
    `${baseUrl}/raw/${ORCHESTRATION_COLLECTION}/${encodeURIComponent(path)}`,
    withVaultAuthRequestInit({
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    }),
  );
  if (resp.status === 404) {
    return null;
  }
  if (!resp.ok) {
    throw new Error(`vault GET ${path} failed (${resp.status})`);
  }
  const text = await resp.text();
  if (!text.trim()) {
    return null;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export async function persistOrchestrationRunSnapshot(params: {
  traceId: string;
  snapshot: Record<string, unknown>;
}): Promise<void> {
  try {
    const path = `runs/${params.traceId}.json`;
    const existing = await readVaultJson(path);
    await writeVaultJson(path, existing ? { ...existing, ...params.snapshot } : params.snapshot);
  } catch (err) {
    logVerbose(`orchestration vault snapshot failed: ${String(err)}`);
  }
}

export async function persistOrchestrationStep(params: {
  traceId: string;
  stage: string;
  data: Record<string, unknown>;
}): Promise<void> {
  const stage = sanitizePathSegment(params.stage) || "step";
  const id = crypto.randomUUID().slice(0, 8);
  const path = `steps/${params.traceId}/${Date.now()}-${stage}-${id}.json`;
  try {
    await writeVaultJson(path, {
      timestamp: new Date().toISOString(),
      traceId: params.traceId,
      stage: params.stage,
      data: params.data,
    });
  } catch (err) {
    logVerbose(`orchestration vault step failed: ${String(err)}`);
  }
}

export async function persistOrchestrationPromptInput(params: {
  traceId: string;
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
  toolDefinitions?: Array<{
    name: string;
    label?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  toolAllowlist?: string[];
  systemPromptReport?: unknown;
}): Promise<void> {
  try {
    await writeVaultJson(`prompts/${params.traceId}/${params.runId}-input.json`, {
      timestamp: new Date().toISOString(),
      traceId: params.traceId,
      runId: params.runId,
      sessionId: params.sessionId,
      provider: params.provider,
      model: params.model,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
      historyMessages: params.historyMessages,
      imagesCount: params.imagesCount,
      toolDefinitions: params.toolDefinitions,
      toolAllowlist: params.toolAllowlist,
      systemPromptReport: params.systemPromptReport,
    });
  } catch (err) {
    logVerbose(`orchestration vault prompt input failed: ${String(err)}`);
  }
}

export async function persistOrchestrationPromptOutput(params: {
  traceId: string;
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}): Promise<void> {
  try {
    await writeVaultJson(`prompts/${params.traceId}/${params.runId}-output.json`, {
      timestamp: new Date().toISOString(),
      traceId: params.traceId,
      runId: params.runId,
      sessionId: params.sessionId,
      provider: params.provider,
      model: params.model,
      assistantTexts: params.assistantTexts,
      lastAssistant: params.lastAssistant,
      usage: params.usage,
    });
  } catch (err) {
    logVerbose(`orchestration vault prompt output failed: ${String(err)}`);
  }
}
