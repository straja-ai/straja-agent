import { createSubsystemLogger } from "../logging/subsystem.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { sanitizeToolResult } from "./pi-embedded-subscribe.tools.js";

const log = createSubsystemLogger("agents/guard");

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_GUARD_TEXT_CHARS = 12_000;
type GuardDecision = "allow" | "redact" | "block";

type GuardRuntimeConfig = {
  enabled: boolean;
  baseUrl: string;
  projectId: string;
  apiKey: string;
  timeoutMs: number;
};

type GuardRequestCheckOutcome = {
  checked: boolean;
  blocked: boolean;
  text: string;
  reason?: string;
};

type GuardResponseCheckOutcome = {
  checked: boolean;
  blocked: boolean;
  text: string;
  reason?: string;
};

type GuardResponseBody = {
  decision?: unknown;
  sanitized_text?: unknown;
  reasons?: Array<{ category?: unknown; rule?: unknown }>;
  policy_hits?: Array<{ category?: unknown; details?: unknown }>;
  error?: {
    message?: unknown;
    category?: unknown;
  };
};

function resolveTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}

function resolveGuardRuntimeConfig(): GuardRuntimeConfig {
  const baseUrl = process.env.STRAJA_GUARD_URL?.trim() ?? "";
  const apiKey =
    process.env.STRAJA_GUARD_PROJECT_KEY?.trim() ?? process.env.STRAJA_GUARD_API_KEY?.trim() ?? "";
  const projectId =
    process.env.STRAJA_GUARD_PROJECT_ID?.trim() ??
    process.env.STRAJA_GUARD_PROJECT?.trim() ??
    "workspace";
  const timeoutMs = resolveTimeoutMs(process.env.STRAJA_GUARD_TIMEOUT_MS);
  return {
    enabled: Boolean(baseUrl && apiKey && projectId),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    projectId,
    apiKey,
    timeoutMs,
  };
}

export function isStandaloneGuardEnabled(): boolean {
  return resolveGuardRuntimeConfig().enabled;
}

function normalizeGuardDecision(value: unknown): GuardDecision {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "block" || normalized === "redact") {
    return normalized;
  }
  return "allow";
}

function clampGuardText(text: string, maxChars = MAX_GUARD_TEXT_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n…(truncated)…`;
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  const blocks = collectTextContentBlocks(content)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return blocks.join("\n");
}

export function replaceMessageTextContent(
  message: { content?: unknown } | undefined,
  nextText: string,
): void {
  if (!message) {
    return;
  }

  if (typeof message.content === "string" || message.content == null) {
    message.content = nextText;
    return;
  }

  if (!Array.isArray(message.content)) {
    message.content = nextText;
    return;
  }

  let replaced = false;
  const nextContent = message.content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return entry;
      }
      const record = entry as { type?: unknown; text?: unknown };
      if (record.type !== "text") {
        return entry;
      }
      if (replaced) {
        return null;
      }
      replaced = true;
      return {
        ...entry,
        text: nextText,
      };
    })
    .filter((entry) => entry !== null);

  if (!replaced) {
    nextContent.unshift({ type: "text", text: nextText });
  }

  message.content = nextContent;
}

function summarizeGuardReasons(body: GuardResponseBody | null | undefined): string | undefined {
  const errorMessage = typeof body?.error?.message === "string" ? body.error.message.trim() : "";
  if (errorMessage) {
    return errorMessage;
  }

  const fromReasons = (body?.reasons ?? [])
    .map((entry) => {
      const rule = typeof entry?.rule === "string" ? entry.rule.trim() : "";
      const category = typeof entry?.category === "string" ? entry.category.trim() : "";
      return rule || category;
    })
    .filter(Boolean);
  if (fromReasons.length > 0) {
    return fromReasons.join(", ");
  }

  const fromHits = (body?.policy_hits ?? [])
    .map((entry) => {
      const details = typeof entry?.details === "string" ? entry.details.trim() : "";
      const category = typeof entry?.category === "string" ? entry.category.trim() : "";
      return details || category;
    })
    .filter(Boolean);
  if (fromHits.length > 0) {
    return fromHits.join(", ");
  }

  return undefined;
}

function normalizeGuardReasonTokens(body: GuardResponseBody | null | undefined): string[] {
  const summary = summarizeGuardReasons(body);
  if (!summary) {
    return [];
  }
  return summary
    .split(/[,|]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function shouldIgnoreThreatOnlyOutputDecision(body: GuardResponseBody | null | undefined): boolean {
  const reasons = normalizeGuardReasonTokens(body);
  if (reasons.length === 0) {
    return false;
  }
  return reasons.every((reason) => reason === "jailbreak" || reason === "prompt_injection");
}

async function postGuardJson(
  path: "/v1/guard/request" | "/v1/guard/response",
  body: Record<string, unknown>,
): Promise<
  | { ok: true; status: number; body: GuardResponseBody }
  | { ok: false; status?: number; body?: GuardResponseBody }
> {
  const cfg = resolveGuardRuntimeConfig();
  if (!cfg.enabled) {
    return { ok: false };
  }

  try {
    const response = await fetch(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const text = await response.text();
    let parsed: GuardResponseBody | undefined;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text) as GuardResponseBody;
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok) {
      if (response.status !== 403) {
        log.warn(`guard ${path} failed: status=${response.status}`);
      }
      return { ok: false, status: response.status, body: parsed };
    }
    return { ok: true, status: response.status, body: parsed ?? {} };
  } catch (err) {
    log.warn(`guard ${path} unavailable: ${String(err)}`);
    return { ok: false };
  }
}

function isGuardPolicyBlockResponse(
  response:
    | { ok: false; status?: number; body?: GuardResponseBody }
    | { ok: true; status: number; body: GuardResponseBody },
): boolean {
  if (response.ok) {
    return false;
  }
  if (response.status === 403) {
    return true;
  }
  return normalizeGuardDecision(response.body?.error?.category) === "block";
}

export async function guardModelRequest(params: {
  requestId: string;
  provider: string;
  modelId: string;
  prompt: string;
  sessionId?: string;
  userId?: string;
}): Promise<GuardRequestCheckOutcome> {
  const cfg = resolveGuardRuntimeConfig();
  const originalPrompt = params.prompt;
  if (!cfg.enabled) {
    return { checked: false, blocked: false, text: originalPrompt };
  }

  const response = await postGuardJson("/v1/guard/request", {
    request_id: params.requestId,
    project_id: cfg.projectId,
    input_text: clampGuardText(originalPrompt),
    metadata: {
      source: params.modelId,
      session_id: params.sessionId,
      user_id: params.userId,
      streaming: false,
    },
  });
  if (!response.ok) {
    if (isGuardPolicyBlockResponse(response)) {
      return {
        checked: true,
        blocked: true,
        text: originalPrompt,
        reason: summarizeGuardReasons(response.body) ?? "Blocked by Straja Guard.",
      };
    }
    return { checked: false, blocked: false, text: originalPrompt };
  }

  const decision = normalizeGuardDecision(response.body.decision);
  if (decision === "block") {
    return {
      checked: true,
      blocked: true,
      text: originalPrompt,
      reason: summarizeGuardReasons(response.body) ?? "Blocked by Straja Guard.",
    };
  }

  const sanitized =
    decision === "redact" && typeof response.body.sanitized_text === "string"
      ? response.body.sanitized_text
      : originalPrompt;
  return {
    checked: true,
    blocked: false,
    text: sanitized,
  };
}

export async function guardModelResponse(params: {
  requestId: string;
  provider: string;
  modelId: string;
  outputText: string;
  sessionId?: string;
  userId?: string;
}): Promise<GuardResponseCheckOutcome> {
  const cfg = resolveGuardRuntimeConfig();
  const originalText = params.outputText;
  if (!cfg.enabled || !originalText.trim()) {
    return { checked: false, blocked: false, text: originalText };
  }

  const response = await postGuardJson("/v1/guard/response", {
    request_id: params.requestId,
    output_text: clampGuardText(originalText),
    metadata: {
      source: params.modelId,
      session_id: params.sessionId,
      user_id: params.userId,
      streaming: false,
    },
  });
  if (!response.ok) {
    if (isGuardPolicyBlockResponse(response)) {
      if (shouldIgnoreThreatOnlyOutputDecision(response.body)) {
        return { checked: false, blocked: false, text: originalText };
      }
      return {
        checked: true,
        blocked: true,
        text: originalText,
        reason: summarizeGuardReasons(response.body) ?? "Blocked by Straja Guard.",
      };
    }
    return { checked: false, blocked: false, text: originalText };
  }

  const decision = normalizeGuardDecision(response.body.decision);
  if (decision === "block") {
    if (shouldIgnoreThreatOnlyOutputDecision(response.body)) {
      return { checked: false, blocked: false, text: originalText };
    }
    return {
      checked: true,
      blocked: true,
      text: originalText,
      reason: summarizeGuardReasons(response.body) ?? "Blocked by Straja Guard.",
    };
  }
  if (decision === "redact" && shouldIgnoreThreatOnlyOutputDecision(response.body)) {
    return { checked: false, blocked: false, text: originalText };
  }

  const sanitized =
    decision === "redact" && typeof response.body.sanitized_text === "string"
      ? response.body.sanitized_text
      : originalText;
  return {
    checked: true,
    blocked: false,
    text: sanitized,
  };
}

function serializeJsonForGuard(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseSanitizedJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function guardToolParams(params: {
  requestId: string;
  toolName: string;
  toolParams: unknown;
  sessionId?: string;
  userId?: string;
}): Promise<{ blocked: boolean; params: unknown; reason?: string }> {
  const cfg = resolveGuardRuntimeConfig();
  if (!cfg.enabled) {
    return { blocked: false, params: params.toolParams };
  }

  const payload = {
    tool: params.toolName,
    params: params.toolParams,
  };
  const serialized = serializeJsonForGuard(payload);
  if (!serialized) {
    return { blocked: false, params: params.toolParams };
  }

  const response = await postGuardJson("/v1/guard/request", {
    request_id: params.requestId,
    project_id: cfg.projectId,
    input_text: clampGuardText(serialized),
    tool_calls: [
      {
        name: params.toolName,
        arguments_json: clampGuardText(serializeJsonForGuard(params.toolParams) ?? "{}"),
      },
    ],
    metadata: {
      source: `tool:${params.toolName}`,
      session_id: params.sessionId,
      user_id: params.userId,
      streaming: false,
    },
  });

  if (!response.ok) {
    if (isGuardPolicyBlockResponse(response)) {
      return {
        blocked: true,
        params: params.toolParams,
        reason: summarizeGuardReasons(response.body) ?? "Blocked by Straja Guard.",
      };
    }
    return { blocked: false, params: params.toolParams };
  }

  const decision = normalizeGuardDecision(response.body.decision);
  if (decision === "block") {
    return {
      blocked: true,
      params: params.toolParams,
      reason: summarizeGuardReasons(response.body) ?? "Blocked by Straja Guard.",
    };
  }
  if (decision !== "redact" || typeof response.body.sanitized_text !== "string") {
    return { blocked: false, params: params.toolParams };
  }

  const parsed = parseSanitizedJson<{ tool?: unknown; params?: unknown }>(
    response.body.sanitized_text,
  );
  return {
    blocked: false,
    params: parsed?.params ?? params.toolParams,
  };
}

export async function guardToolResult(params: {
  requestId: string;
  toolName: string;
  result: unknown;
  sessionId?: string;
  userId?: string;
}): Promise<{ blocked: boolean; result: unknown; reason?: string }> {
  const cfg = resolveGuardRuntimeConfig();
  if (!cfg.enabled) {
    return { blocked: false, result: params.result };
  }

  const sanitizedResult = sanitizeToolResult(params.result);
  const serialized = serializeJsonForGuard(sanitizedResult);
  if (!serialized) {
    return { blocked: false, result: params.result };
  }

  const response = await postGuardJson("/v1/guard/response", {
    request_id: params.requestId,
    output_text: clampGuardText(serialized),
    metadata: {
      source: `tool:${params.toolName}`,
      session_id: params.sessionId,
      user_id: params.userId,
      streaming: false,
    },
  });

  if (!response.ok) {
    if (isGuardPolicyBlockResponse(response)) {
      if (shouldIgnoreThreatOnlyOutputDecision(response.body)) {
        return { blocked: false, result: params.result };
      }
      return {
        blocked: true,
        result: params.result,
        reason: summarizeGuardReasons(response.body) ?? "Blocked by Straja Guard.",
      };
    }
    return { blocked: false, result: params.result };
  }

  const decision = normalizeGuardDecision(response.body.decision);
  if (decision === "block") {
    if (shouldIgnoreThreatOnlyOutputDecision(response.body)) {
      return { blocked: false, result: params.result };
    }
    return {
      blocked: true,
      result: params.result,
      reason: summarizeGuardReasons(response.body) ?? "Blocked by Straja Guard.",
    };
  }
  if (decision === "redact" && shouldIgnoreThreatOnlyOutputDecision(response.body)) {
    return { blocked: false, result: params.result };
  }
  if (decision !== "redact" || typeof response.body.sanitized_text !== "string") {
    return { blocked: false, result: params.result };
  }

  return {
    blocked: false,
    result: parseSanitizedJson(response.body.sanitized_text) ?? params.result,
  };
}
