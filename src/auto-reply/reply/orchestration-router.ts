import crypto from "node:crypto";
import { completeSimple, type Api, type Model } from "@mariozechner/pi-ai";
import {
  listAgentEntries,
  resolveAgentConfig,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import { createOllamaStreamFn } from "../../agents/ollama-stream.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { normalizeUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { clampNumber, safeParseJson } from "../../utils.js";
import {
  persistOrchestrationPromptInput,
  persistOrchestrationPromptOutput,
  persistOrchestrationStep,
} from "./orchestration-vault.js";

export type InboundOrchestrationRoute = "local_fast_path" | "default_specialist";
export type InboundOrchestrationTaskClass =
  | "simple_inbound_automation"
  | "general_agent_turn"
  | "complex_turn";
export type OrchestrationToolFamily =
  | "local_automation"
  | "general"
  | "coding"
  | "research"
  | "email"
  | "presentation";

export type OrchestrationAgentCandidate = {
  agentId: string;
  score: number;
  reasons: string[];
};

export type OrchestrationRouterDecision = {
  source: "model" | "fallback";
  selectedAgentId: string;
  selectedAgentReason: string;
  candidates: OrchestrationAgentCandidate[];
  taskClass: InboundOrchestrationTaskClass;
  suggestedRoute: InboundOrchestrationRoute;
  confidence: number;
  toolFamily: OrchestrationToolFamily;
  memoryQuery: string;
  vaultQuery: string;
  reasons: string[];
  provider?: string;
  model?: string;
  rawResponse?: string;
};

type RouterPayload = {
  selectedAgentId?: unknown;
  taskClass?: unknown;
  suggestedRoute?: unknown;
  confidence?: unknown;
  toolFamily?: unknown;
  memoryQuery?: unknown;
  vaultQuery?: unknown;
  reasons?: unknown;
};

type AgentRoutingProfile = {
  purpose?: string | null;
  primaryDomains?: string[];
  preferredTaskTypes?: string[];
  forbiddenTaskTypes?: string[];
  toolFamiliesAvailable?: string[];
  shortExamples?: string[];
};

const COMPLEX_KEYWORDS = [
  "research",
  "code",
  "coding",
  "presentation",
  "artifact",
  "artifacts",
  "slide",
  "slides",
  "email",
  "draft",
  "report",
  "analyze",
  "analysis",
];

const TRIVIAL_LOCAL_PATTERNS = [
  /^\s*(hi|hello|hey|yo|sup)\s*[.!?]*\s*$/i,
  /^\s*(thanks|thank you|thx)\s*[.!?]*\s*$/i,
  /^\s*(ok|okay|sure|cool|great|nice)\s*[.!?]*\s*$/i,
  /^\s*(what model are you|who are you)\s*[!?]*\s*$/i,
];

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]+/g, " ");
}

function collectKeywords(text: string): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 4);
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function truncateText(value: string | null | undefined, maxChars: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trim()}…`;
}

function compactList(values: string[] | undefined, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((entry) => truncateText(entry, maxChars))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, maxItems);
}

function isTrivialLocalTurn(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 120) {
    return false;
  }
  if (TRIVIAL_LOCAL_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }
  const normalized = normalizeText(trimmed).trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length <= 3 && tokens.every((token) => token.length <= 8)) {
    return !COMPLEX_KEYWORDS.some((keyword) => normalized.includes(keyword));
  }
  return false;
}

function scoreAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  body: string;
  currentAgentId?: string;
  flowContext: string[];
}): OrchestrationAgentCandidate {
  const entry = listAgentEntries(params.cfg).find((agent) => agent.id === params.agentId);
  const resolved = resolveAgentConfig(params.cfg, params.agentId);
  const keywords = collectKeywords(params.body);
  const metadataParts = [
    params.agentId,
    entry?.name,
    resolved?.identity?.name,
    resolved?.identity?.theme,
    resolved?.routing?.purpose,
    ...(resolved?.routing?.primaryDomains ?? []),
    ...(resolved?.routing?.preferredTaskTypes ?? []),
    ...(resolved?.routing?.forbiddenTaskTypes ?? []),
    ...(resolved?.routing?.toolFamiliesAvailable ?? []),
    ...(resolved?.routing?.shortExamples ?? []),
    ...(resolved?.skills ?? []),
    ...(resolved?.tools?.alsoAllow ?? []),
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => normalizeText(entry));
  const metadata = metadataParts.join(" ");
  let score = params.agentId === params.currentAgentId ? 2 : 0;
  const reasons: string[] = [];

  for (const keyword of keywords) {
    if (metadata.includes(keyword)) {
      score += 4;
      reasons.push(`metadata matched "${keyword}"`);
    }
  }

  for (const flow of params.flowContext) {
    const normalizedFlow = normalizeText(flow);
    if (normalizedFlow.includes(params.agentId.toLowerCase())) {
      score += 6;
      reasons.push("flow context mentions agent id");
    }
    if (entry?.name && normalizedFlow.includes(normalizeText(entry.name))) {
      score += 6;
      reasons.push("flow context mentions agent name");
    }
  }

  if (resolved?.tools?.profile) {
    score += 1;
  }
  if (resolved?.skills?.length) {
    score += 1;
  }

  return {
    agentId: params.agentId,
    score,
    reasons: uniq(reasons),
  };
}

function classifyFallbackTask(
  body: string,
  flowContext: string[],
): {
  taskClass: InboundOrchestrationTaskClass;
  suggestedRoute: InboundOrchestrationRoute;
  toolFamily: OrchestrationToolFamily;
  reasons: string[];
} {
  const normalized = normalizeText(body);
  const complexHits = COMPLEX_KEYWORDS.filter((keyword) => normalized.includes(keyword));
  if (/\b(code|coding|bug|repo|repository|fix|implement)\b/.test(normalized)) {
    return {
      taskClass: "complex_turn",
      suggestedRoute: "default_specialist",
      toolFamily: "coding",
      reasons: ["matched coding keywords"],
    };
  }
  if (/\b(research|search|find|compare|investigate|analyze|analysis|web)\b/.test(normalized)) {
    return {
      taskClass: "complex_turn",
      suggestedRoute: "default_specialist",
      toolFamily: "research",
      reasons: ["matched research keywords"],
    };
  }
  if (/\b(email|draft|gmail)\b/.test(normalized)) {
    return {
      taskClass: "complex_turn",
      suggestedRoute: "default_specialist",
      toolFamily: "email",
      reasons: ["matched email keywords"],
    };
  }
  if (/\b(slides|presentation|deck|report|artifact)\b/.test(normalized)) {
    return {
      taskClass: "complex_turn",
      suggestedRoute: "default_specialist",
      toolFamily: "presentation",
      reasons: ["matched artifact keywords"],
    };
  }
  if (isTrivialLocalTurn(body)) {
    return {
      taskClass: "simple_inbound_automation",
      suggestedRoute: "local_fast_path",
      toolFamily: "local_automation",
      reasons: ["trivial greeting or short owner chat"],
    };
  }
  if (flowContext.length > 0 && complexHits.length === 0 && body.trim().length <= 1_200) {
    return {
      taskClass: "simple_inbound_automation",
      suggestedRoute: "local_fast_path",
      toolFamily: "local_automation",
      reasons: ["flow context present", "small inbound message"],
    };
  }
  return {
    taskClass: complexHits.length > 0 ? "complex_turn" : "general_agent_turn",
    suggestedRoute: "default_specialist",
    toolFamily: "general",
    reasons:
      complexHits.length > 0
        ? [`complex keywords: ${complexHits.join(", ")}`]
        : ["no strong specialist pattern detected"],
  };
}

function buildFallbackDecision(params: {
  cfg: OpenClawConfig;
  body: string;
  currentAgentId?: string;
  commandAuthorized: boolean;
  flowContext: string[];
}): OrchestrationRouterDecision {
  const allAgentIds = listAgentEntries(params.cfg).map((agent) => agent.id);
  const fallbackAgentId =
    params.currentAgentId || resolveDefaultAgentId(params.cfg) || allAgentIds[0] || "main";
  const candidates =
    allAgentIds.length > 0
      ? allAgentIds
          .map((agentId) =>
            scoreAgent({
              cfg: params.cfg,
              agentId,
              body: params.body,
              currentAgentId: params.currentAgentId,
              flowContext: params.flowContext,
            }),
          )
          .toSorted((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId))
      : [
          {
            agentId: fallbackAgentId,
            score: 0,
            reasons: ["fallback"],
          },
        ];

  let selectedAgentId = fallbackAgentId;
  let selectedAgentReason = params.commandAuthorized
    ? "single-agent or no clear routing context"
    : "non-owner inbound kept on current session agent";
  if (params.commandAuthorized && candidates.length > 1) {
    const best = candidates[0];
    const second = candidates[1];
    if (best && best.score > 0 && (!second || best.score - second.score >= 3)) {
      selectedAgentId = best.agentId;
      selectedAgentReason = best.reasons[0] ?? "best metadata match";
    } else {
      selectedAgentReason = "no strong specialist match; stayed on current/default agent";
    }
  }

  const fallbackClassification = classifyFallbackTask(params.body, params.flowContext);
  const confidence =
    fallbackClassification.taskClass === "simple_inbound_automation"
      ? 0.72
      : fallbackClassification.taskClass === "general_agent_turn"
        ? 0.5
        : 0.28;

  return {
    source: "fallback",
    selectedAgentId,
    selectedAgentReason,
    candidates,
    taskClass: fallbackClassification.taskClass,
    suggestedRoute: fallbackClassification.suggestedRoute,
    confidence,
    toolFamily: fallbackClassification.toolFamily,
    memoryQuery: params.body.trim(),
    vaultQuery: params.body.trim(),
    reasons: fallbackClassification.reasons,
  };
}

function resolveRouterSettings(cfg: OpenClawConfig) {
  const orchestration = cfg.agents?.defaults?.orchestration;
  const router = orchestration?.router;
  const localFastPath = orchestration?.localFastPath;
  return {
    enabled: orchestration?.enabled !== false && router?.enabled !== false,
    model: router?.model?.trim() || localFastPath?.model?.trim() || "ollama/gemma4:e4b",
    timeoutMs: router?.timeoutMs ?? 60_000,
    maxTokens: router?.maxTokens ?? 180,
  };
}

function buildAgentCatalog(cfg: OpenClawConfig, currentAgentId?: string) {
  return listAgentEntries(cfg).map((entry) => {
    const resolved = resolveAgentConfig(cfg, entry.id);
    const routing: AgentRoutingProfile | undefined = resolved?.routing
      ? {
          purpose: truncateText(resolved.routing.purpose ?? null, 120),
          primaryDomains: compactList(resolved.routing.primaryDomains, 3, 32),
          preferredTaskTypes: compactList(resolved.routing.preferredTaskTypes, 3, 48),
          forbiddenTaskTypes: compactList(resolved.routing.forbiddenTaskTypes, 2, 48),
          toolFamiliesAvailable: compactList(resolved.routing.toolFamiliesAvailable, 4, 24),
          shortExamples: compactList(resolved.routing.shortExamples, 2, 64),
        }
      : undefined;
    return {
      id: entry.id,
      isCurrent: entry.id === currentAgentId,
      label: truncateText(
        entry.name ?? resolved?.identity?.name ?? resolved?.identity?.theme ?? entry.id,
        48,
      ),
      routing,
      tools: compactList(resolved?.tools?.alsoAllow, 5, 24),
    };
  });
}

function buildRouterSystemPrompt(): string {
  return [
    "You are the orchestration router for Straja.",
    "Choose the best specialist agent, task class, route, and tool family for the current inbound turn.",
    "Return strict JSON only. Do not include markdown, code fences, or extra text.",
    "Use local_fast_path for greetings, acknowledgements, very short owner chat, and narrow deterministic vault/message tasks.",
    "Never invent agent ids. Only use one of the provided candidates.",
    "Choose agents primarily from each candidate's routing purpose, domains, preferred task types, forbidden task types, available tool families, and examples.",
    'Valid taskClass: "simple_inbound_automation", "general_agent_turn", "complex_turn".',
    'Valid suggestedRoute: "local_fast_path", "default_specialist".',
    'Valid toolFamily: "local_automation", "general", "coding", "research", "email", "presentation".',
    "confidence must be a number between 0 and 1.",
    "reasons must be short factual strings.",
    'Examples: "hi" -> local_fast_path. "thanks" -> local_fast_path. "what model are you?" -> local_fast_path. "research competitors" -> default_specialist.',
  ].join("\n");
}

function applyTrivialLocalOverride(
  decision: OrchestrationRouterDecision,
  body: string,
): OrchestrationRouterDecision {
  if (!isTrivialLocalTurn(body)) {
    return decision;
  }
  return {
    ...decision,
    taskClass: "simple_inbound_automation",
    suggestedRoute: "local_fast_path",
    toolFamily: "local_automation",
    confidence: Math.max(decision.confidence, 0.82),
    reasons: uniq([...decision.reasons, "trivial greeting or short owner chat"]),
  };
}

function buildRouterPrompt(params: {
  body: string;
  commandAuthorized: boolean;
  flowContext: string[];
  currentAgentId?: string;
  cfg: OpenClawConfig;
}): string {
  const agentCatalog = buildAgentCatalog(params.cfg, params.currentAgentId);
  const inboundBody = truncateText(params.body, 700) ?? "";
  const flowHints = params.flowContext
    .map((entry) => truncateText(entry, 180))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 2);
  const candidateLines = agentCatalog.map((candidate) => {
    const parts = [
      `id=${candidate.id}`,
      candidate.label ? `label=${candidate.label}` : null,
      candidate.isCurrent ? "current=yes" : null,
      candidate.routing?.purpose ? `purpose=${candidate.routing.purpose}` : null,
      candidate.routing?.primaryDomains?.length
        ? `domains=${candidate.routing.primaryDomains.join(", ")}`
        : null,
      candidate.routing?.preferredTaskTypes?.length
        ? `prefers=${candidate.routing.preferredTaskTypes.join(" | ")}`
        : null,
      candidate.routing?.forbiddenTaskTypes?.length
        ? `avoid=${candidate.routing.forbiddenTaskTypes.join(" | ")}`
        : null,
      candidate.routing?.toolFamiliesAvailable?.length
        ? `tool_families=${candidate.routing.toolFamiliesAvailable.join(", ")}`
        : null,
      candidate.routing?.shortExamples?.length
        ? `examples=${candidate.routing.shortExamples.join(" | ")}`
        : null,
      candidate.tools.length ? `extra_tools=${candidate.tools.join(", ")}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    return `- ${parts.join("; ")}`;
  });
  return [
    "Return one JSON object with this exact shape and no extra text:",
    JSON.stringify(
      {
        selectedAgentId: "agent-id",
        taskClass: "general_agent_turn",
        suggestedRoute: "default_specialist",
        confidence: 0.5,
        toolFamily: "general",
        memoryQuery: "short query",
        vaultQuery: "short query",
        reasons: ["reason one", "reason two"],
      },
      null,
      2,
    ),
    "",
    `Command authorized: ${params.commandAuthorized ? "yes" : "no"}`,
    `Current agent: ${params.currentAgentId ?? "none"}`,
    `Inbound message: ${inboundBody || "(empty)"}`,
    `Flow hints: ${flowHints.length > 0 ? flowHints.join(" || ") : "none"}`,
    "Candidate agents:",
    ...candidateLines,
  ].join("\n");
}

function extractTextFromCompletionContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!content) {
    return "";
  }
  if (Array.isArray(content)) {
    return content
      .flatMap((block) => {
        if (typeof block === "string") {
          return [block.trim()];
        }
        if (!block || typeof block !== "object") {
          return [];
        }
        const record = block as {
          type?: string;
          text?: unknown;
          content?: unknown;
          reasoning?: unknown;
        };
        if (record.type === "text" && typeof record.text === "string") {
          return [record.text.trim()];
        }
        if (typeof record.content === "string") {
          return [record.content.trim()];
        }
        if (typeof record.reasoning === "string") {
          return [record.reasoning.trim()];
        }
        return [];
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof content !== "object") {
    return "";
  }

  const record = content as {
    text?: unknown;
    content?: unknown;
    reasoning?: unknown;
    message?: { content?: unknown; reasoning?: unknown };
  };
  if (typeof record.text === "string") {
    return record.text.trim();
  }
  if (typeof record.reasoning === "string") {
    return record.reasoning.trim();
  }
  if (record.content) {
    const nestedContent = extractTextFromCompletionContent(record.content);
    if (nestedContent) {
      return nestedContent;
    }
  }
  if (record.message?.content) {
    const nestedMessageContent = extractTextFromCompletionContent(record.message.content);
    if (nestedMessageContent) {
      return nestedMessageContent;
    }
  }
  if (record.message?.reasoning) {
    const nestedReasoning = extractTextFromCompletionContent(record.message.reasoning);
    if (nestedReasoning) {
      return nestedReasoning;
    }
  }
  return "";
}

function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

function extractJsonPayload(raw: string): RouterPayload | null {
  const trimmed = stripMarkdownFence(raw);
  const direct = safeParseJson<RouterPayload>(trimmed);
  if (direct) {
    return direct;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last <= first) {
    return null;
  }
  return safeParseJson<RouterPayload>(trimmed.slice(first, last + 1));
}

function normalizeReasonList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const reasons = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 6);
  return reasons.length > 0 ? reasons : fallback;
}

function normalizeTaskClass(
  value: unknown,
  fallback: InboundOrchestrationTaskClass,
): InboundOrchestrationTaskClass {
  return value === "simple_inbound_automation" ||
    value === "general_agent_turn" ||
    value === "complex_turn"
    ? value
    : fallback;
}

function normalizeRoute(
  value: unknown,
  fallback: InboundOrchestrationRoute,
): InboundOrchestrationRoute {
  return value === "local_fast_path" || value === "default_specialist" ? value : fallback;
}

function normalizeToolFamily(
  value: unknown,
  fallback: OrchestrationToolFamily,
): OrchestrationToolFamily {
  return value === "local_automation" ||
    value === "general" ||
    value === "coding" ||
    value === "research" ||
    value === "email" ||
    value === "presentation"
    ? value
    : fallback;
}

function normalizeQuery(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function persistAsync(task: Promise<void>, label: string): void {
  void task.catch((err) => {
    logVerbose(`orchestration router: ${label} failed: ${String(err)}`);
  });
}

export async function runInboundOrchestrationRouter(params: {
  cfg: OpenClawConfig;
  traceId: string;
  sessionId?: string;
  body: string;
  currentAgentId?: string;
  commandAuthorized: boolean;
  flowContext: string[];
}): Promise<OrchestrationRouterDecision> {
  const fallback = buildFallbackDecision({
    cfg: params.cfg,
    body: params.body,
    currentAgentId: params.currentAgentId,
    commandAuthorized: params.commandAuthorized,
    flowContext: params.flowContext,
  });
  const routerSettings = resolveRouterSettings(params.cfg);
  if (!routerSettings.enabled || !params.body.trim()) {
    return fallback;
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: "ollama",
  });
  const routerModelRef = resolveModelRefFromString({
    raw: routerSettings.model,
    defaultProvider: "ollama",
    aliasIndex,
  })?.ref;
  if (!routerModelRef) {
    logVerbose(`orchestration router: invalid model ref "${routerSettings.model}"`);
    return fallback;
  }

  const resolved = resolveModel(
    routerModelRef.provider,
    routerModelRef.model,
    undefined,
    params.cfg,
  );
  if (!resolved.model) {
    logVerbose(
      `orchestration router: failed to resolve ${routerModelRef.provider}/${routerModelRef.model}: ${
        resolved.error ?? "unknown error"
      }`,
    );
    return fallback;
  }

  let apiKey: string;
  try {
    apiKey = requireApiKey(
      await getApiKeyForModel({
        model: resolved.model,
        cfg: params.cfg,
      }),
      resolved.model.provider,
    );
  } catch (err) {
    logVerbose(`orchestration router: auth unavailable: ${String(err)}`);
    return fallback;
  }

  const systemPrompt = buildRouterSystemPrompt();
  const prompt = buildRouterPrompt({
    body: params.body,
    commandAuthorized: params.commandAuthorized,
    flowContext: params.flowContext,
    currentAgentId: params.currentAgentId,
    cfg: params.cfg,
  });
  const runId = `router-${crypto.randomUUID()}`;

  persistAsync(
    persistOrchestrationPromptInput({
      traceId: params.traceId,
      runId,
      sessionId: params.sessionId ?? params.currentAgentId ?? "orchestration-router",
      provider: resolved.model.provider,
      model: resolved.model.id,
      systemPrompt,
      prompt,
      historyMessages: [],
      imagesCount: 0,
    }),
    "persist prompt input",
  );

  try {
    const model = resolved.model;
    const ollamaModel = resolved.model as Awaited<typeof resolved>["model"] & {
      provider: string;
      id: string;
      api: string;
      baseUrl?: string;
    };
    const context = {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: prompt,
          timestamp: Date.now(),
        },
      ],
    };
    const response =
      ollamaModel.api === "ollama"
        ? await (
            await createOllamaStreamFn(ollamaModel.baseUrl ?? "http://127.0.0.1:11435")(
              ollamaModel as Model<Api>,
              context,
              {
                apiKey,
                temperature: 0,
                maxTokens: routerSettings.maxTokens,
                think: false,
                signal: AbortSignal.timeout(routerSettings.timeoutMs),
              } as Parameters<ReturnType<typeof createOllamaStreamFn>>[2] & { think?: boolean },
            )
          ).result()
        : await completeSimple(model, context, {
            apiKey,
            temperature: 0,
            maxTokens: routerSettings.maxTokens,
            reasoning: "low",
            signal: AbortSignal.timeout(routerSettings.timeoutMs),
          });
    const rawResponse = extractTextFromCompletionContent(response);
    const payload = extractJsonPayload(rawResponse);
    const usage = normalizeUsage(
      (response as unknown as { usage?: Record<string, unknown> }).usage ??
        (response as unknown as Record<string, unknown>),
    );

    persistAsync(
      persistOrchestrationPromptOutput({
        traceId: params.traceId,
        runId,
        sessionId: params.sessionId ?? params.currentAgentId ?? "orchestration-router",
        provider: resolved.model.provider,
        model: resolved.model.id,
        assistantTexts: rawResponse ? [rawResponse] : [],
        lastAssistant: payload ?? response,
        usage: {
          input: usage?.input,
          output: usage?.output,
          cacheRead: usage?.cacheRead,
          cacheWrite: usage?.cacheWrite,
          total:
            usage?.total ??
            (usage?.input ?? 0) +
              (usage?.output ?? 0) +
              (usage?.cacheRead ?? 0) +
              (usage?.cacheWrite ?? 0),
        },
      }),
      "persist prompt output",
    );

    if (!payload) {
      persistAsync(
        persistOrchestrationStep({
          traceId: params.traceId,
          stage: "router:parse_error",
          data: {
            provider: resolved.model.provider,
            model: resolved.model.id,
            rawResponse,
          },
        }),
        "persist parse error",
      );
      return fallback;
    }

    const allowedAgentIds = new Set(fallback.candidates.map((candidate) => candidate.agentId));
    const selectedAgentIdRaw =
      typeof payload.selectedAgentId === "string" ? payload.selectedAgentId.trim() : "";
    const selectedAgentId = allowedAgentIds.has(selectedAgentIdRaw)
      ? selectedAgentIdRaw
      : fallback.selectedAgentId;
    const taskClass = normalizeTaskClass(payload.taskClass, fallback.taskClass);
    const suggestedRoute = normalizeRoute(payload.suggestedRoute, fallback.suggestedRoute);
    const toolFamily = normalizeToolFamily(payload.toolFamily, fallback.toolFamily);
    const decision = applyTrivialLocalOverride(
      {
        source: "model",
        selectedAgentId,
        selectedAgentReason:
          selectedAgentId === selectedAgentIdRaw
            ? "selected by local router model"
            : "router output used invalid agent id; fell back to validated specialist",
        candidates: fallback.candidates,
        taskClass,
        suggestedRoute,
        confidence: clampNumber(
          typeof payload.confidence === "number" ? payload.confidence : fallback.confidence,
          0,
          1,
        ),
        toolFamily,
        memoryQuery: normalizeQuery(payload.memoryQuery, fallback.memoryQuery),
        vaultQuery: normalizeQuery(payload.vaultQuery, fallback.vaultQuery),
        reasons: normalizeReasonList(payload.reasons, fallback.reasons),
        provider: resolved.model.provider,
        model: resolved.model.id,
        rawResponse,
      },
      params.body,
    );

    persistAsync(
      persistOrchestrationStep({
        traceId: params.traceId,
        stage: "router:model",
        data: {
          source: decision.source,
          provider: decision.provider,
          model: decision.model,
          selectedAgentId: decision.selectedAgentId,
          taskClass: decision.taskClass,
          suggestedRoute: decision.suggestedRoute,
          confidence: decision.confidence,
          toolFamily: decision.toolFamily,
          reasons: decision.reasons,
        },
      }),
      "persist router decision",
    );

    return decision;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const fallbackWithError = applyTrivialLocalOverride(
      {
        ...fallback,
        selectedAgentReason: `router failed; ${fallback.selectedAgentReason}`,
        reasons: uniq([`router error: ${errorMessage}`, ...fallback.reasons]),
        provider: resolved.model.provider,
        model: resolved.model.id,
        rawResponse: errorMessage,
      },
      params.body,
    );
    persistAsync(
      persistOrchestrationStep({
        traceId: params.traceId,
        stage: "router:error",
        data: {
          provider: resolved.model.provider,
          model: resolved.model.id,
          error: errorMessage,
          fallback: fallbackWithError,
        },
      }),
      "persist router error",
    );
    logVerbose(`orchestration router: model call failed: ${String(err)}`);
    return fallbackWithError;
  }
}
