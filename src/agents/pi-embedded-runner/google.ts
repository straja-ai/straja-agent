import { EventEmitter } from "node:events";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { registerUnhandledRejectionHandler } from "../../infra/unhandled-rejections.js";
import {
  hasInterSessionUserProvenance,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import {
  downgradeOpenAIReasoningBlocks,
  isCompactionFailureError,
  isGoogleModelApi,
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
} from "../pi-embedded-helpers.js";
import { cleanToolSchemaForGemini } from "../pi-tools.schema.js";
import {
  sanitizeToolCallInputs,
  stripToolResultDetails,
  sanitizeToolUseResultPairing,
} from "../session-transcript-repair.js";
import type { TranscriptPolicy } from "../transcript-policy.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { log } from "./logger.js";
import { describeUnknownError } from "./utils.js";

const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";
const GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);
const ANTIGRAVITY_SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const INTER_SESSION_PREFIX_BASE = "[Inter-session message]";
const PERSISTENT_MEMORY_BLOCK_RE = /<persistent_memory>[\s\S]*?<\/persistent_memory>\s*/gi;
const CONVERSATION_INFO_BLOCK_RE =
  /Conversation info \(untrusted metadata\):\s*```(?:json)?[\s\S]*?```\s*/gi;
const HOOK_STATUS_LINE_RE = /^System:\s*\[[^\]]+\]\s*Hook [^\n]+(?:\n+|$)/gim;

function isValidAntigravitySignature(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length % 4 !== 0) {
    return false;
  }
  return ANTIGRAVITY_SIGNATURE_RE.test(trimmed);
}

export function sanitizeAntigravityThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant") {
      out.push(msg);
      continue;
    }
    const assistant = msg;
    if (!Array.isArray(assistant.content)) {
      out.push(msg);
      continue;
    }
    type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
    const nextContent: AssistantContentBlock[] = [];
    let contentChanged = false;
    for (const block of assistant.content) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "thinking"
      ) {
        nextContent.push(block);
        continue;
      }
      const rec = block as {
        thinkingSignature?: unknown;
        signature?: unknown;
        thought_signature?: unknown;
        thoughtSignature?: unknown;
      };
      const candidate =
        rec.thinkingSignature ?? rec.signature ?? rec.thought_signature ?? rec.thoughtSignature;
      if (!isValidAntigravitySignature(candidate)) {
        // Preserve reasoning content as plain text when signatures are invalid/missing.
        // Antigravity Claude rejects unsigned thinking blocks, but dropping them loses context.
        const thinkingText = (block as { thinking?: unknown }).thinking;
        if (typeof thinkingText === "string" && thinkingText.trim()) {
          nextContent.push({ type: "text", text: thinkingText } as AssistantContentBlock);
        }
        contentChanged = true;
        continue;
      }
      if (rec.thinkingSignature !== candidate) {
        const nextBlock = {
          ...(block as unknown as Record<string, unknown>),
          thinkingSignature: candidate,
        } as AssistantContentBlock;
        nextContent.push(nextBlock);
        contentChanged = true;
      } else {
        nextContent.push(block);
      }
    }
    if (contentChanged) {
      touched = true;
    }
    if (nextContent.length === 0) {
      touched = true;
      continue;
    }
    out.push(contentChanged ? { ...assistant, content: nextContent } : msg);
  }
  return touched ? out : messages;
}

function buildInterSessionPrefix(message: AgentMessage): string {
  const provenance = normalizeInputProvenance((message as { provenance?: unknown }).provenance);
  if (!provenance) {
    return INTER_SESSION_PREFIX_BASE;
  }
  const details = [
    provenance.sourceSessionKey ? `sourceSession=${provenance.sourceSessionKey}` : undefined,
    provenance.sourceChannel ? `sourceChannel=${provenance.sourceChannel}` : undefined,
    provenance.sourceTool ? `sourceTool=${provenance.sourceTool}` : undefined,
  ].filter(Boolean);
  if (details.length === 0) {
    return INTER_SESSION_PREFIX_BASE;
  }
  return `${INTER_SESSION_PREFIX_BASE} ${details.join(" ")}`;
}

function annotateInterSessionUserMessages(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!hasInterSessionUserProvenance(msg as { role?: unknown; provenance?: unknown })) {
      out.push(msg);
      continue;
    }
    const prefix = buildInterSessionPrefix(msg);
    const user = msg as Extract<AgentMessage, { role: "user" }>;
    if (typeof user.content === "string") {
      if (user.content.startsWith(prefix)) {
        out.push(msg);
        continue;
      }
      touched = true;
      out.push({
        ...(msg as unknown as Record<string, unknown>),
        content: `${prefix}\n${user.content}`,
      } as AgentMessage);
      continue;
    }
    if (!Array.isArray(user.content)) {
      out.push(msg);
      continue;
    }

    const textIndex = user.content.findIndex(
      (block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    );

    if (textIndex >= 0) {
      const existing = user.content[textIndex] as { type: "text"; text: string };
      if (existing.text.startsWith(prefix)) {
        out.push(msg);
        continue;
      }
      const nextContent = [...user.content];
      nextContent[textIndex] = {
        ...existing,
        text: `${prefix}\n${existing.text}`,
      };
      touched = true;
      out.push({
        ...(msg as unknown as Record<string, unknown>),
        content: nextContent,
      } as AgentMessage);
      continue;
    }

    touched = true;
    out.push({
      ...(msg as unknown as Record<string, unknown>),
      content: [{ type: "text", text: prefix }, ...user.content],
    } as AgentMessage);
  }
  return touched ? out : messages;
}

function extractPlainTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
      textParts.push(typedBlock.text);
    }
  }
  return textParts.join("\n\n");
}

function stripSyntheticUserWrappers(text: string): string {
  return text
    .replace(PERSISTENT_MEMORY_BLOCK_RE, "")
    .replace(CONVERSATION_INFO_BLOCK_RE, "")
    .replace(HOOK_STATUS_LINE_RE, "")
    .trim();
}

function normalizeAssistantUsage(message: AgentMessage): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
} {
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  const input = typeof usage?.input === "number" ? usage.input : 0;
  const output = typeof usage?.output === "number" ? usage.output : 0;
  const cacheRead = typeof usage?.cacheRead === "number" ? usage.cacheRead : 0;
  const cacheWrite = typeof usage?.cacheWrite === "number" ? usage.cacheWrite : 0;
  const totalTokens =
    typeof usage?.totalTokens === "number"
      ? usage.totalTokens
      : input + output + cacheRead + cacheWrite;
  const rawCost =
    usage?.cost && typeof usage.cost === "object"
      ? (usage.cost as Record<string, unknown>)
      : undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: typeof rawCost?.input === "number" ? rawCost.input : 0,
      output: typeof rawCost?.output === "number" ? rawCost.output : 0,
      cacheRead: typeof rawCost?.cacheRead === "number" ? rawCost.cacheRead : 0,
      cacheWrite: typeof rawCost?.cacheWrite === "number" ? rawCost.cacheWrite : 0,
      total: typeof rawCost?.total === "number" ? rawCost.total : 0,
    },
  };
}

function normalizeConversationHistory(messages: AgentMessage[]): AgentMessage[] {
  const normalized: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    if (msg.role !== "user" && msg.role !== "assistant") {
      continue;
    }
    const content = extractPlainTextContent((msg as { content?: unknown }).content);
    const text = msg.role === "user" ? stripSyntheticUserWrappers(content) : content.trim();
    if (!text) {
      continue;
    }
    if (msg.role === "user") {
      normalized.push({
        role: "user",
        content: text,
        timestamp:
          typeof (msg as { timestamp?: unknown }).timestamp === "number"
            ? (msg as { timestamp: number }).timestamp
            : Date.now(),
      } as AgentMessage);
      continue;
    }
    normalized.push({
      role: "assistant",
      content: [{ type: "text", text }],
      api:
        typeof (msg as { api?: unknown }).api === "string"
          ? (msg as { api: string }).api
          : "openai-responses",
      provider:
        typeof (msg as { provider?: unknown }).provider === "string"
          ? (msg as { provider: string }).provider
          : "openclaw",
      model:
        typeof (msg as { model?: unknown }).model === "string"
          ? (msg as { model: string }).model
          : "sanitized-history",
      usage: normalizeAssistantUsage(msg),
      stopReason:
        typeof (msg as { stopReason?: unknown }).stopReason === "string"
          ? ((msg as { stopReason: string }).stopReason as
              | "stop"
              | "length"
              | "toolUse"
              | "error"
              | "aborted")
          : "stop",
      timestamp:
        typeof (msg as { timestamp?: unknown }).timestamp === "number"
          ? (msg as { timestamp: number }).timestamp
          : Date.now(),
    } as AgentMessage);
  }
  return normalized;
}

function findUnsupportedSchemaKeywords(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      findUnsupportedSchemaKeywords(item, `${path}[${index}]`),
    );
  }
  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      violations.push(...findUnsupportedSchemaKeywords(value, `${path}.properties.${key}`));
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties") {
      continue;
    }
    if (GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS.has(key)) {
      violations.push(`${path}.${key}`);
    }
    if (value && typeof value === "object") {
      violations.push(...findUnsupportedSchemaKeywords(value, `${path}.${key}`));
    }
  }
  return violations;
}

export function sanitizeToolsForGoogle<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: {
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
}): AgentTool<TSchemaType, TResult>[] {
  // Cloud Code Assist uses the OpenAPI 3.03 `parameters` field for both Gemini
  // AND Claude models.  This field does not support JSON Schema keywords such as
  // patternProperties, additionalProperties, $ref, etc.  We must clean schemas
  // for every provider that routes through this path.
  if (params.provider !== "google-gemini-cli" && params.provider !== "google-antigravity") {
    return params.tools;
  }
  return params.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: cleanToolSchemaForGemini(
        tool.parameters as Record<string, unknown>,
      ) as TSchemaType,
    };
  });
}

export function logToolSchemasForGoogle(params: { tools: AgentTool[]; provider: string }) {
  if (params.provider !== "google-antigravity" && params.provider !== "google-gemini-cli") {
    return;
  }
  const toolNames = params.tools.map((tool, index) => `${index}:${tool.name}`);
  const tools = sanitizeToolsForGoogle(params);
  log.info("google tool schema snapshot", {
    provider: params.provider,
    toolCount: tools.length,
    tools: toolNames,
  });
  for (const [index, tool] of tools.entries()) {
    const violations = findUnsupportedSchemaKeywords(tool.parameters, `${tool.name}.parameters`);
    if (violations.length > 0) {
      log.warn("google tool schema has unsupported keywords", {
        index,
        tool: tool.name,
        violations: violations.slice(0, 12),
        violationCount: violations.length,
      });
    }
  }
}

// Event emitter for unhandled compaction failures that escape try-catch blocks.
// Listeners can use this to trigger session recovery with retry.
const compactionFailureEmitter = new EventEmitter();

export type CompactionFailureListener = (reason: string) => void;

/**
 * Register a listener for unhandled compaction failures.
 * Called when auto-compaction fails in a way that escapes the normal try-catch,
 * e.g., when the summarization request itself exceeds the model's token limit.
 * Returns an unsubscribe function.
 */
export function onUnhandledCompactionFailure(cb: CompactionFailureListener): () => void {
  compactionFailureEmitter.on("failure", cb);
  return () => compactionFailureEmitter.off("failure", cb);
}

registerUnhandledRejectionHandler((reason) => {
  const message = describeUnknownError(reason);
  if (!isCompactionFailureError(message)) {
    return false;
  }
  log.error(`Auto-compaction failed (unhandled): ${message}`);
  compactionFailureEmitter.emit("failure", message);
  return true;
});

type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

type ModelSnapshotEntry = {
  timestamp: number;
  provider?: string;
  modelApi?: string | null;
  modelId?: string;
};

const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";

function readLastModelSnapshot(sessionManager: SessionManager): ModelSnapshotEntry | null {
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as CustomEntryLike;
      if (entry?.type !== "custom" || entry?.customType !== MODEL_SNAPSHOT_CUSTOM_TYPE) {
        continue;
      }
      const data = entry?.data as ModelSnapshotEntry | undefined;
      if (data && typeof data === "object") {
        return data;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function appendModelSnapshot(sessionManager: SessionManager, data: ModelSnapshotEntry): void {
  try {
    sessionManager.appendCustomEntry(MODEL_SNAPSHOT_CUSTOM_TYPE, data);
  } catch {
    // ignore persistence failures
  }
}

function isSameModelSnapshot(a: ModelSnapshotEntry, b: ModelSnapshotEntry): boolean {
  const normalize = (value?: string | null) => value ?? "";
  return (
    normalize(a.provider) === normalize(b.provider) &&
    normalize(a.modelApi) === normalize(b.modelApi) &&
    normalize(a.modelId) === normalize(b.modelId)
  );
}

function hasGoogleTurnOrderingMarker(sessionManager: SessionManager): boolean {
  try {
    return sessionManager
      .getEntries()
      .some(
        (entry) =>
          (entry as CustomEntryLike)?.type === "custom" &&
          (entry as CustomEntryLike)?.customType === GOOGLE_TURN_ORDERING_CUSTOM_TYPE,
      );
  } catch {
    return false;
  }
}

function markGoogleTurnOrderingMarker(sessionManager: SessionManager): void {
  try {
    sessionManager.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, {
      timestamp: Date.now(),
    });
  } catch {
    // ignore marker persistence failures
  }
}

export function applyGoogleTurnOrderingFix(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  sessionManager: SessionManager;
  sessionId: string;
  warn?: (message: string) => void;
}): { messages: AgentMessage[]; didPrepend: boolean } {
  if (!isGoogleModelApi(params.modelApi)) {
    return { messages: params.messages, didPrepend: false };
  }
  const first = params.messages[0] as { role?: unknown; content?: unknown } | undefined;
  if (first?.role !== "assistant") {
    return { messages: params.messages, didPrepend: false };
  }
  const sanitized = sanitizeGoogleTurnOrdering(params.messages);
  const didPrepend = sanitized !== params.messages;
  if (didPrepend && !hasGoogleTurnOrderingMarker(params.sessionManager)) {
    const warn = params.warn ?? ((message: string) => log.warn(message));
    warn(`google turn ordering fixup: prepended user bootstrap (sessionId=${params.sessionId})`);
    markGoogleTurnOrderingMarker(params.sessionManager);
  }
  return { messages: sanitized, didPrepend };
}

export async function sanitizeSessionHistory(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  modelId?: string;
  provider?: string;
  config?: OpenClawConfig;
  sessionManager: SessionManager;
  sessionId: string;
  policy?: TranscriptPolicy;
}): Promise<AgentMessage[]> {
  // Keep docs/reference/transcript-hygiene.md in sync with any logic changes here.
  const policy =
    params.policy ??
    resolveTranscriptPolicy({
      modelApi: params.modelApi,
      provider: params.provider,
      modelId: params.modelId,
    });
  const withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);
  const sanitizedImages = await sanitizeSessionMessagesImages(
    withInterSessionMarkers,
    "session:history",
    {
      sanitizeMode: policy.sanitizeMode,
      sanitizeToolCallIds: policy.sanitizeToolCallIds,
      toolCallIdMode: policy.toolCallIdMode,
      preserveSignatures: policy.preserveSignatures,
      sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures,
      ...resolveImageSanitizationLimits(params.config),
    },
  );
  const sanitizedThinking = policy.normalizeAntigravityThinkingBlocks
    ? sanitizeAntigravityThinkingBlocks(sanitizedImages)
    : sanitizedImages;
  const sanitizedToolCalls = sanitizeToolCallInputs(sanitizedThinking);
  const repairedTools = policy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairing(sanitizedToolCalls)
    : sanitizedToolCalls;
  const sanitizedToolResults = stripToolResultDetails(repairedTools);

  const isOpenAIResponsesApi =
    params.modelApi === "openai-responses" || params.modelApi === "openai-codex-responses";
  const hasSnapshot = Boolean(params.provider || params.modelApi || params.modelId);
  const priorSnapshot = hasSnapshot ? readLastModelSnapshot(params.sessionManager) : null;
  const modelChanged = priorSnapshot
    ? !isSameModelSnapshot(priorSnapshot, {
        timestamp: 0,
        provider: params.provider,
        modelApi: params.modelApi,
        modelId: params.modelId,
      })
    : false;
  const sanitizedOpenAI = isOpenAIResponsesApi
    ? downgradeOpenAIReasoningBlocks(sanitizedToolResults)
    : sanitizedToolResults;
  const normalizedConversation = normalizeConversationHistory(sanitizedOpenAI);

  if (hasSnapshot && (!priorSnapshot || modelChanged)) {
    appendModelSnapshot(params.sessionManager, {
      timestamp: Date.now(),
      provider: params.provider,
      modelApi: params.modelApi,
      modelId: params.modelId,
    });
  }

  if (!policy.applyGoogleTurnOrdering) {
    return normalizedConversation;
  }

  return applyGoogleTurnOrderingFix({
    messages: normalizedConversation,
    modelApi: params.modelApi,
    sessionManager: params.sessionManager,
    sessionId: params.sessionId,
  }).messages;
}
