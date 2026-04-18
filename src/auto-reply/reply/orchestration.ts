import crypto from "node:crypto";
import path from "node:path";
import { resolveAgentModelPolicy } from "../../agents/agent-scope.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { ensureOllamaRuntimeReady } from "../../agents/ollama-stream.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "../../agents/queued-file-writer.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { logVerbose } from "../../globals.js";
import { resolveUserPath } from "../../utils.js";
import { safeJsonStringify } from "../../utils/safe-json.js";
import type { FinalizedMsgContext } from "../templating.js";
import {
  runInboundOrchestrationRouter,
  type InboundOrchestrationRoute,
  type InboundOrchestrationTaskClass,
  type OrchestrationRouterDecision,
} from "./orchestration-router.js";

export type InboundOrchestrationPolicyCheck = {
  rule: string;
  passed: boolean;
  detail: string;
};

export type InboundOrchestrationDecision = {
  traceId: string;
  assignedAgentId?: string;
  assignedModel: string;
  assignedProvider: string;
  executionModel: string;
  executionProvider: string;
  taskClass: InboundOrchestrationTaskClass;
  confidence: number;
  suggestedRoute: InboundOrchestrationRoute;
  finalRoute: InboundOrchestrationRoute;
  promptModeOverride?: "full" | "compact" | "minimal" | "local_worker" | "none";
  policyChecks: InboundOrchestrationPolicyCheck[];
  blockers: string[];
  reasons: string[];
  promptNote: string;
};

export type InboundOrchestrationResult = {
  decision: InboundOrchestrationDecision;
  routerDecision: OrchestrationRouterDecision;
  replyOptions: {
    extraSystemPrompt: string;
    promptModeOverride?: "full" | "compact" | "minimal" | "local_worker" | "none";
    modelOverride?: string;
    modelPolicyOverride?: "local_only" | "cloud_only" | "hybrid";
    historyLimitOverride?: number;
    suppressThreadHistory?: boolean;
    suppressUntrustedContext?: boolean;
  };
};

type OrchestrationTraceStage =
  | "route:evaluated"
  | "dispatch:start"
  | "dispatch:end"
  | "dispatch:error";

type OrchestrationTraceEvent = {
  ts: string;
  seq: number;
  stage: OrchestrationTraceStage;
  traceId: string;
  sessionKey?: string;
  messageId?: string;
  assignedAgentId?: string;
  assignedModel?: string;
  assignedProvider?: string;
  executionModel?: string;
  executionProvider?: string;
  taskClass?: InboundOrchestrationTaskClass;
  finalRoute?: InboundOrchestrationRoute;
  suggestedRoute?: InboundOrchestrationRoute;
  confidence?: number;
  reasons?: string[];
  blockers?: string[];
  policyChecks?: InboundOrchestrationPolicyCheck[];
  context?: {
    bodyChars: number;
    flowContextCount: number;
    hasMedia: boolean;
  };
  note?: string;
  error?: string;
};

type OrchestrationTrace = {
  record: (stage: OrchestrationTraceStage, payload?: Partial<OrchestrationTraceEvent>) => void;
};

const DEFAULT_MAX_INPUT_CHARS = 1200;

const writers = new Map<string, QueuedFileWriter>();

function getTraceWriter(filePath: string): QueuedFileWriter {
  return getQueuedFileWriter(writers, filePath);
}

export function isInboundOrchestrationEnabled(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.agents?.defaults?.orchestration?.enabled === true;
}

function resolveTraceConfig(cfg: OpenClawConfig | undefined, env: NodeJS.ProcessEnv = process.env) {
  const traceCfg = cfg?.diagnostics?.orchestrationTrace;
  const enabled = traceCfg?.enabled ?? cfg?.diagnostics?.enabled ?? false;
  const fileOverride = traceCfg?.filePath?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "orchestration-trace.jsonl");
  return {
    enabled,
    filePath,
    includeContext: traceCfg?.includeContext ?? true,
    includePolicyChecks: traceCfg?.includePolicyChecks ?? true,
  };
}

function createOrchestrationTrace(params: {
  cfg?: OpenClawConfig;
  traceId: string;
  sessionKey?: string;
  messageId?: string;
}): OrchestrationTrace | null {
  const traceCfg = resolveTraceConfig(params.cfg);
  if (!traceCfg.enabled) {
    return null;
  }
  const writer = getTraceWriter(traceCfg.filePath);
  let seq = 0;

  return {
    record: (stage, payload = {}) => {
      const event: OrchestrationTraceEvent = {
        ts: new Date().toISOString(),
        seq: (seq += 1),
        stage,
        traceId: params.traceId,
        sessionKey: params.sessionKey,
        messageId: params.messageId,
        assignedAgentId: payload.assignedAgentId,
        assignedModel: payload.assignedModel,
        assignedProvider: payload.assignedProvider,
        executionModel: payload.executionModel,
        executionProvider: payload.executionProvider,
        taskClass: payload.taskClass,
        finalRoute: payload.finalRoute,
        suggestedRoute: payload.suggestedRoute,
        confidence: payload.confidence,
        reasons: payload.reasons,
        blockers: payload.blockers,
        note: payload.note,
        error: payload.error,
      };
      if (traceCfg.includePolicyChecks && payload.policyChecks) {
        event.policyChecks = payload.policyChecks;
      }
      if (traceCfg.includeContext && payload.context) {
        event.context = payload.context;
      }
      const line = safeJsonStringify(event);
      if (line) {
        writer.write(`${line}\n`);
      }
    },
  };
}

function normalizeBody(ctx: FinalizedMsgContext): string {
  const candidates = [
    ctx.BodyForAgent,
    ctx.BodyForCommands,
    ctx.CommandBody,
    ctx.RawBody,
    ctx.Body,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function isBareSessionResetCommand(ctx: FinalizedMsgContext): boolean {
  const raw = (ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "").trim().toLowerCase();
  return raw === "/new" || raw === "/reset";
}

function resolveLocalFastPathSettings(cfg: OpenClawConfig) {
  const orchestration = cfg.agents?.defaults?.orchestration;
  const localFastPath = orchestration?.localFastPath;
  const orchestrationEnabled = orchestration?.enabled === true;
  return {
    orchestrationEnabled,
    enabled: orchestrationEnabled,
    model: localFastPath?.model?.trim() || undefined,
    maxInputChars: localFastPath?.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
    requireFlowContext: false,
    allowMedia: localFastPath?.allowMedia === true,
    promptMode: localFastPath?.promptMode ?? "local_worker",
  };
}

function resolveLocalFastPathModel(params: {
  cfg: OpenClawConfig;
  assignedProvider: string;
  assignedModel: string;
}) {
  const settings = resolveLocalFastPathSettings(params.cfg);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.assignedProvider,
  });
  const configured = settings.model
    ? resolveModelRefFromString({
        raw: settings.model,
        defaultProvider: params.assignedProvider,
        aliasIndex,
      })?.ref
    : null;
  if (configured) {
    return configured;
  }
  if (params.assignedProvider === "ollama") {
    return {
      provider: params.assignedProvider,
      model: params.assignedModel,
    };
  }
  return null;
}

async function ensureLocalFastPathRuntimeReady(params: {
  cfg: OpenClawConfig;
  localFastPathModel: { provider: string; model: string } | null;
}): Promise<{ ready: boolean; detail: string }> {
  if (!params.localFastPathModel) {
    return {
      ready: false,
      detail: "no local worker model configured",
    };
  }
  if (params.localFastPathModel.provider !== "ollama") {
    return {
      ready: true,
      detail: `execution worker ${params.localFastPathModel.provider}/${params.localFastPathModel.model}`,
    };
  }
  const resolved = resolveModel(
    params.localFastPathModel.provider,
    params.localFastPathModel.model,
    undefined,
    params.cfg,
  );
  const baseUrl =
    resolved.model &&
    "baseUrl" in resolved.model &&
    typeof resolved.model.baseUrl === "string" &&
    resolved.model.baseUrl.trim()
      ? resolved.model.baseUrl.trim()
      : "http://127.0.0.1:11435";
  const ready = await ensureOllamaRuntimeReady(baseUrl);
  return {
    ready,
    detail: ready
      ? `execution worker ${params.localFastPathModel.provider}/${params.localFastPathModel.model} ready`
      : `execution worker ${params.localFastPathModel.provider}/${params.localFastPathModel.model} unavailable`,
  };
}

function buildPromptNote(decision: InboundOrchestrationDecision): string {
  const lines = [
    "## Orchestration",
    `Trace: ${decision.traceId}`,
    `Assigned specialist: ${decision.assignedProvider}/${decision.assignedModel}`,
    `Execution worker: ${decision.executionProvider}/${decision.executionModel}`,
    `Task class: ${decision.taskClass}`,
    `Route: ${decision.finalRoute}`,
    `Confidence: ${decision.confidence.toFixed(2)}`,
    `Reasons: ${decision.reasons.join("; ") || "none"}`,
  ];
  if (decision.blockers.length > 0) {
    lines.push(`Blockers: ${decision.blockers.join("; ")}`);
  }
  if (decision.finalRoute === "local_fast_path") {
    lines.push(
      "Stay narrowly scoped. Prefer the existing flow and vault tools. Avoid broad exploration or escalation unless blocked.",
    );
  }
  return lines.join("\n");
}

export async function evaluateInboundOrchestration(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  traceId?: string;
}): Promise<InboundOrchestrationResult> {
  const body = normalizeBody(params.ctx);
  const bodyChars = body.length;
  const flowContextCount = Array.isArray(params.ctx.FlowContext)
    ? params.ctx.FlowContext.length
    : 0;
  const bareSessionReset = isBareSessionResetCommand(params.ctx);
  const hasMedia = Boolean(
    params.ctx.MediaPath ||
    params.ctx.MediaUrl ||
    (Array.isArray(params.ctx.MediaPaths) && params.ctx.MediaPaths.length > 0) ||
    (Array.isArray(params.ctx.MediaUrls) && params.ctx.MediaUrls.length > 0),
  );
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: params.ctx.SessionKey,
    config: params.cfg,
  });
  const traceId = params.traceId?.trim() || crypto.randomUUID();
  const routerDecision = await runInboundOrchestrationRouter({
    cfg: params.cfg,
    traceId,
    sessionId: params.ctx.SessionKey,
    body,
    currentAgentId: sessionAgentId,
    commandAuthorized: params.ctx.CommandAuthorized,
    flowContext: Array.isArray(params.ctx.FlowContext) ? params.ctx.FlowContext : [],
  });
  const assignedAgentId = routerDecision.selectedAgentId || sessionAgentId;
  const assignedModelRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: assignedAgentId,
  });
  const assignedPolicy = resolveAgentModelPolicy(params.cfg, assignedAgentId);
  const fastPathSettings = resolveLocalFastPathSettings(params.cfg);
  const localFastPathModel = resolveLocalFastPathModel({
    cfg: params.cfg,
    assignedProvider: assignedModelRef.provider,
    assignedModel: assignedModelRef.model,
  });
  const maxInputChars = fastPathSettings.maxInputChars;
  const taskClass = routerDecision.taskClass;
  const localRequested = routerDecision.suggestedRoute === "local_fast_path";
  const localRuntime = localRequested
    ? await ensureLocalFastPathRuntimeReady({
        cfg: params.cfg,
        localFastPathModel,
      })
    : {
        ready: Boolean(localFastPathModel),
        detail: localFastPathModel
          ? `execution worker ${localFastPathModel.provider}/${localFastPathModel.model}`
          : "no local worker model configured",
      };

  const policyChecks: InboundOrchestrationPolicyCheck[] = [
    {
      rule: "orchestration_enabled",
      passed: fastPathSettings.orchestrationEnabled,
      detail: fastPathSettings.orchestrationEnabled ? "enabled" : "disabled",
    },
    {
      rule: "local_fast_path_enabled",
      passed: fastPathSettings.enabled,
      detail: fastPathSettings.enabled ? "enabled" : "disabled",
    },
    {
      rule: "local_worker_model_available",
      passed: localRuntime.ready,
      detail: localRuntime.detail,
    },
    {
      rule: "flow_context_required",
      passed: !fastPathSettings.requireFlowContext || flowContextCount > 0,
      detail: fastPathSettings.requireFlowContext
        ? `flow context count: ${flowContextCount}`
        : "flow context not required",
    },
    {
      rule: "input_within_budget",
      passed: bodyChars <= maxInputChars,
      detail: `body chars ${bodyChars} <= ${maxInputChars}`,
    },
    {
      rule: "no_media",
      passed: fastPathSettings.allowMedia || !hasMedia,
      detail: fastPathSettings.allowMedia
        ? "media allowed by policy"
        : hasMedia
          ? "media present"
          : "no media present",
    },
    {
      rule: "router_requested_local_fast_path",
      passed: !localRequested || taskClass === "simple_inbound_automation",
      detail: localRequested
        ? `router suggested ${routerDecision.suggestedRoute} for ${taskClass}`
        : `router suggested ${routerDecision.suggestedRoute}`,
    },
    {
      rule: "not_bare_session_reset",
      passed: !bareSessionReset,
      detail: bareSessionReset ? "bare /new or /reset command" : "normal message",
    },
  ];

  const blockers = policyChecks.filter((check) => !check.passed).map((check) => check.rule);
  const localAllowed = localRequested && policyChecks.every((check) => check.passed);
  const finalRoute: InboundOrchestrationRoute = localAllowed
    ? "local_fast_path"
    : "default_specialist";
  const reasons = [
    ...routerDecision.reasons,
    ...(localAllowed
      ? ["policy accepted local fast-path"]
      : localRequested
        ? ["policy blocked local fast-path"]
        : ["router chose specialist execution"]),
  ];

  const decision: InboundOrchestrationDecision = {
    traceId,
    assignedAgentId,
    assignedModel: assignedModelRef.model,
    assignedProvider: assignedModelRef.provider,
    executionModel: localAllowed
      ? (localFastPathModel?.model ?? assignedModelRef.model)
      : assignedModelRef.model,
    executionProvider: localAllowed
      ? (localFastPathModel?.provider ?? assignedModelRef.provider)
      : assignedModelRef.provider,
    taskClass,
    confidence: routerDecision.confidence,
    suggestedRoute: routerDecision.suggestedRoute,
    finalRoute,
    promptModeOverride: localAllowed ? fastPathSettings.promptMode : undefined,
    policyChecks,
    blockers,
    reasons,
    promptNote: "",
  };
  decision.promptNote = buildPromptNote(decision);

  logVerbose(
    `orchestration: trace=${decision.traceId} route=${decision.finalRoute} agent=${
      decision.assignedAgentId ?? "default"
    } assigned=${decision.assignedProvider}/${decision.assignedModel} execution=${
      decision.executionProvider
    }/${decision.executionModel} taskClass=${decision.taskClass}`,
  );

  return {
    decision,
    routerDecision,
    replyOptions: {
      extraSystemPrompt: decision.promptNote,
      promptModeOverride: decision.promptModeOverride,
      modelOverride:
        localAllowed && localFastPathModel
          ? `${localFastPathModel.provider}/${localFastPathModel.model}`
          : undefined,
      modelPolicyOverride: localAllowed
        ? assignedPolicy === "local_only"
          ? "local_only"
          : "hybrid"
        : undefined,
      historyLimitOverride: localAllowed ? 4 : undefined,
      suppressThreadHistory: localAllowed,
      suppressUntrustedContext: localAllowed,
    },
  };
}

export function traceInboundOrchestration(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  result: InboundOrchestrationResult;
}): OrchestrationTrace | null {
  const trace = createOrchestrationTrace({
    cfg: params.cfg,
    traceId: params.result.decision.traceId,
    sessionKey: params.ctx.SessionKey,
    messageId:
      params.ctx.MessageSidFull ??
      params.ctx.MessageSid ??
      params.ctx.MessageSidFirst ??
      params.ctx.MessageSidLast,
  });
  if (!trace) {
    return null;
  }
  const body = normalizeBody(params.ctx);
  trace.record("route:evaluated", {
    assignedAgentId: params.result.decision.assignedAgentId,
    assignedModel: params.result.decision.assignedModel,
    assignedProvider: params.result.decision.assignedProvider,
    executionModel: params.result.decision.executionModel,
    executionProvider: params.result.decision.executionProvider,
    taskClass: params.result.decision.taskClass,
    suggestedRoute: params.result.decision.suggestedRoute,
    finalRoute: params.result.decision.finalRoute,
    confidence: params.result.decision.confidence,
    reasons: params.result.decision.reasons,
    blockers: params.result.decision.blockers,
    policyChecks: params.result.decision.policyChecks,
    context: {
      bodyChars: body.length,
      flowContextCount: Array.isArray(params.ctx.FlowContext) ? params.ctx.FlowContext.length : 0,
      hasMedia: Boolean(
        params.ctx.MediaPath ||
        params.ctx.MediaUrl ||
        (Array.isArray(params.ctx.MediaPaths) && params.ctx.MediaPaths.length > 0) ||
        (Array.isArray(params.ctx.MediaUrls) && params.ctx.MediaUrls.length > 0),
      ),
    },
  });
  return trace;
}
