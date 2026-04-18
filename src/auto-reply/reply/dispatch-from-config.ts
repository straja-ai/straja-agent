import crypto from "node:crypto";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveAgentModelPolicy } from "../../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { maybeApplyTtsToPayload, normalizeTtsAutoMode, resolveTtsConfig } from "../../tts/tts.js";
import { getReplyFromConfig } from "../reply.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { shouldSkipDuplicateInbound } from "./inbound-dedupe.js";
import { buildOrchestrationPacket } from "./orchestration-packet.js";
import {
  persistOrchestrationRunSnapshot,
  persistOrchestrationStep,
} from "./orchestration-vault.js";
import {
  evaluateInboundOrchestration,
  isInboundOrchestrationEnabled,
  traceInboundOrchestration,
  type InboundOrchestrationDecision,
  type InboundOrchestrationResult,
} from "./orchestration.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { resolveTypingMode } from "./typing-mode.js";

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;

const normalizeMediaType = (value: string): string => value.split(";")[0]?.trim().toLowerCase();

const isLocalProvider = (provider: string | undefined): boolean => {
  const normalized = String(provider ?? "")
    .trim()
    .toLowerCase();
  return normalized === "ollama" || normalized === "vllm";
};

const isLikelyLocalFastPathError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return [
    "ollama",
    "local runtime",
    "managed ollama",
    "did not become healthy",
    "failed to start managed ollama",
    "fetch failed",
    "econnrefused",
    "127.0.0.1:11435",
    "127.0.0.1:11434",
  ].some((needle) => normalized.includes(needle));
};

const isLocalFastPathPolicyMismatchError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return normalized.includes(
    "no eligible models remain after applying the agent's cloud-only routing policy",
  );
};

const resolveInboundTraceBody = (ctx: FinalizedMsgContext, fallback?: string): string => {
  const candidates = [
    ctx.BodyForAgent,
    ctx.BodyForCommands,
    ctx.CommandBody,
    ctx.RawBody,
    ctx.Body,
    fallback,
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
};

const isInboundAudioContext = (ctx: FinalizedMsgContext): boolean => {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean) as string[];
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
};

const resolveSessionTtsAuto = (
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): string | undefined => {
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionKey = (targetSessionKey ?? ctx.SessionKey)?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey.toLowerCase()] ?? store[sessionKey];
    return normalizeTtsAutoMode(entry?.ttsAuto);
  } catch {
    return undefined;
  }
};

function persistTraceAsync(task: Promise<void>, label: string): void {
  void task.catch((err) => {
    logVerbose(`dispatch-from-config: ${label} failed: ${String(err)}`);
  });
}

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
  inboundPrependContext?: string;
  orchestration?: InboundOrchestrationDecision;
};

export async function dispatchReplyFromConfig(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof getReplyFromConfig;
  prependContextOverride?: string;
  skipBeforeInboundDispatchHooks?: boolean;
}): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  let dispatchCtx = ctx;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = String(ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey = ctx.SessionKey;
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);

  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionKey,
      durationMs: Date.now() - startTime,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ sessionKey, channel, source: "dispatch" });
    logSessionStateChange({
      sessionKey,
      state: "processing",
      reason: "message_start",
    });
  };

  const markIdle = (reason: string) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      sessionKey,
      state: "idle",
      reason,
    });
  };

  if (shouldSkipDuplicateInbound(ctx)) {
    recordProcessed("skipped", { reason: "duplicate" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }

  const inboundAudio = isInboundAudioContext(ctx);
  const sessionTtsAuto = resolveSessionTtsAuto(ctx, cfg);
  const hookRunner = getGlobalHookRunner();
  const orchestrationEnabled = isInboundOrchestrationEnabled(cfg);
  const traceId = crypto.randomUUID();

  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const content =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.RawBody === "string"
        ? ctx.RawBody
        : typeof ctx.Body === "string"
          ? ctx.Body
          : "";
  const channelId = (ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
  const conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? undefined;
  const agentId = sessionKey ? resolveSessionAgentId({ sessionKey, config: cfg }) : undefined;

  const beforeInboundDispatchTimeoutMs = 4_000;
  let inboundDispatchResult;
  if (
    !params.skipBeforeInboundDispatchHooks &&
    !params.prependContextOverride &&
    hookRunner?.hasHooks("before_inbound_dispatch")
  ) {
    const hookStartedAt = Date.now();
    if (traceId) {
      await persistOrchestrationStep({
        traceId,
        stage: "hooks:before_inbound_dispatch:start",
        data: {
          timeoutMs: beforeInboundDispatchTimeoutMs,
          channelId,
          sessionKey,
          messageId: messageIdForHook,
        },
      });
    }
    try {
      inboundDispatchResult = await Promise.race([
        hookRunner.runBeforeInboundDispatch(
          {
            from: ctx.From ?? "",
            content,
            timestamp,
            metadata: {
              to: ctx.To,
              provider: ctx.Provider,
              surface: ctx.Surface,
              threadId: ctx.MessageThreadId,
              originatingChannel: ctx.OriginatingChannel,
              originatingTo: ctx.OriginatingTo,
              messageId: messageIdForHook,
              senderId: ctx.SenderId,
              senderName: ctx.SenderName,
              senderUsername: ctx.SenderUsername,
              senderE164: ctx.SenderE164,
            },
          },
          {
            channelId,
            accountId: ctx.AccountId,
            conversationId,
            sessionKey,
            agentId,
          },
        ),
        new Promise<undefined>((resolve) => {
          setTimeout(resolve, beforeInboundDispatchTimeoutMs);
        }),
      ]);
      if (traceId) {
        await persistOrchestrationStep({
          traceId,
          stage: "hooks:before_inbound_dispatch:end",
          data: {
            durationMs: Date.now() - hookStartedAt,
            timedOut: inboundDispatchResult === undefined,
            prependedContext:
              typeof inboundDispatchResult?.prependContext === "string"
                ? inboundDispatchResult.prependContext.length
                : 0,
            cancelled: inboundDispatchResult?.cancel === true,
          },
        });
      }
      if (inboundDispatchResult === undefined) {
        logVerbose(
          `dispatch-from-config: before_inbound_dispatch hook timed out after ${beforeInboundDispatchTimeoutMs}ms`,
        );
      }
    } catch (err) {
      if (traceId) {
        await persistOrchestrationStep({
          traceId,
          stage: "hooks:before_inbound_dispatch:error",
          data: {
            durationMs: Date.now() - hookStartedAt,
            error: String(err),
          },
        });
      }
      logVerbose(`dispatch-from-config: before_inbound_dispatch hook failed: ${String(err)}`);
      inboundDispatchResult = undefined;
    }
  }
  const inboundPrependContext =
    params.prependContextOverride?.trim() || inboundDispatchResult?.prependContext?.trim();
  if (inboundDispatchResult?.cancel) {
    markIdle("before_inbound_dispatch_cancel");
    recordProcessed("skipped", { reason: "before_inbound_dispatch_cancel" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts(), inboundPrependContext };
  }
  if (inboundPrependContext) {
    dispatchCtx = finalizeInboundContext({
      ...ctx,
      FlowContext: [
        ...(Array.isArray(ctx.FlowContext) ? ctx.FlowContext : []),
        inboundPrependContext,
      ],
    });
  }
  const typingModeForDispatch = resolveTypingMode({
    configured: cfg.session?.typingMode ?? cfg.agents?.defaults?.typingMode,
    isGroupChat: dispatchCtx.ChatType === "group",
    wasMentioned: dispatchCtx.WasMentioned === true,
    isHeartbeat: params.replyOptions?.isHeartbeat === true,
  });
  if (orchestrationEnabled && typingModeForDispatch === "instant") {
    await params.replyOptions?.onReplyStart?.();
  }
  const sessionAgentIdForPacket = resolveSessionAgentId({
    sessionKey: dispatchCtx.SessionKey,
    config: cfg,
  });
  const directModelRef = resolveDefaultModelForAgent({
    cfg,
    agentId: sessionAgentIdForPacket,
  });
  const orchestrationResult: InboundOrchestrationResult | null = orchestrationEnabled
    ? await evaluateInboundOrchestration({
        ctx: dispatchCtx,
        cfg,
        traceId,
      })
    : traceId
      ? {
          decision: {
            traceId,
            assignedAgentId: sessionAgentIdForPacket,
            assignedModel: directModelRef.model,
            assignedProvider: directModelRef.provider,
            executionModel: directModelRef.model,
            executionProvider: directModelRef.provider,
            taskClass: "general_agent_turn" as const,
            confidence: 1,
            suggestedRoute: "default_specialist" as const,
            finalRoute: "default_specialist" as const,
            policyChecks: [
              {
                rule: "local_routing_enabled",
                passed: false,
                detail: "disabled",
              },
            ],
            blockers: ["local_routing_disabled"],
            reasons: ["Local routing disabled; assigned agent ran directly."],
            promptNote: "",
          },
          routerDecision: {
            source: "fallback" as const,
            selectedAgentId: sessionAgentIdForPacket ?? "",
            selectedAgentReason: "Local routing disabled; using the assigned session agent.",
            candidates: [],
            taskClass: "general_agent_turn" as const,
            suggestedRoute: "default_specialist" as const,
            confidence: 1,
            toolFamily: "general" as const,
            memoryQuery: "",
            vaultQuery: "",
            reasons: ["Local routing disabled; assigned agent ran directly."],
            provider: directModelRef.provider,
            model: directModelRef.model,
            rawResponse: "routing-disabled",
          },
          replyOptions: {
            extraSystemPrompt: "",
          },
        }
      : null;
  const shouldUsePacketizedContext = orchestrationResult
    ? orchestrationResult.decision.finalRoute === "local_fast_path" ||
      orchestrationResult.decision.assignedAgentId !== sessionAgentIdForPacket ||
      orchestrationResult.routerDecision.toolFamily !== "general" ||
      orchestrationResult.routerDecision.taskClass !== "general_agent_turn" ||
      (Array.isArray(dispatchCtx.FlowContext) && dispatchCtx.FlowContext.length > 0)
    : false;
  const orchestrationPacket =
    orchestrationResult && shouldUsePacketizedContext
      ? await buildOrchestrationPacket({
          cfg,
          ctx: dispatchCtx,
          body:
            [
              dispatchCtx.BodyForAgent,
              dispatchCtx.BodyForCommands,
              dispatchCtx.CommandBody,
              dispatchCtx.RawBody,
              dispatchCtx.Body,
            ]
              .find((entry) => typeof entry === "string" && entry.trim().length > 0)
              ?.trim() ?? "",
          currentAgentId: orchestrationResult.decision.assignedAgentId,
          localFastPath: orchestrationResult.decision.finalRoute === "local_fast_path",
          routerDecision: orchestrationResult.routerDecision,
        })
      : null;
  const inboundTraceBody = resolveInboundTraceBody(dispatchCtx, content);
  if (orchestrationResult) {
    persistTraceAsync(
      persistOrchestrationRunSnapshot({
        traceId: orchestrationResult.decision.traceId,
        snapshot: {
          traceId: orchestrationResult.decision.traceId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sessionKey: dispatchCtx.SessionKey,
          messageId:
            dispatchCtx.MessageSidFull ??
            dispatchCtx.MessageSid ??
            dispatchCtx.MessageSidFirst ??
            dispatchCtx.MessageSidLast,
          assignedAgentId: orchestrationResult.decision.assignedAgentId,
          assignedProvider: orchestrationResult.decision.assignedProvider,
          assignedModel: orchestrationResult.decision.assignedModel,
          executionProvider: orchestrationResult.decision.executionProvider,
          executionModel: orchestrationResult.decision.executionModel,
          taskClass: orchestrationResult.decision.taskClass,
          suggestedRoute: orchestrationResult.decision.suggestedRoute,
          finalRoute: orchestrationResult.decision.finalRoute,
          promptModeOverride: orchestrationResult.decision.promptModeOverride,
          modelOverride: orchestrationResult.replyOptions.modelOverride,
          confidence: orchestrationResult.decision.confidence,
          policyChecks: orchestrationResult.decision.policyChecks,
          blockers: orchestrationResult.decision.blockers,
          reasons: orchestrationResult.decision.reasons,
          router: orchestrationResult.routerDecision,
          packet: orchestrationPacket
            ? {
                selectedAgentId: orchestrationPacket.selectedAgentId,
                selectedAgentReason: orchestrationPacket.selectedAgentReason,
                agentCandidates: orchestrationPacket.agentCandidates,
                toolAllowlist: orchestrationPacket.toolAllowlist,
                memoryResults: orchestrationPacket.memoryResults,
                vaultResults: orchestrationPacket.vaultResults,
                packetText: orchestrationPacket.packetText,
              }
            : null,
          inbound: {
            body: inboundTraceBody,
            flowContext: Array.isArray(dispatchCtx.FlowContext) ? dispatchCtx.FlowContext : [],
            hasMedia: Boolean(
              dispatchCtx.MediaPath ||
              dispatchCtx.MediaUrl ||
              (Array.isArray(dispatchCtx.MediaPaths) && dispatchCtx.MediaPaths.length > 0) ||
              (Array.isArray(dispatchCtx.MediaUrls) && dispatchCtx.MediaUrls.length > 0),
            ),
          },
          inboundText: inboundTraceBody,
          status: "route_evaluated",
        },
      }),
      "persist run snapshot",
    );
    persistTraceAsync(
      persistOrchestrationStep({
        traceId: orchestrationResult.decision.traceId,
        stage: "route:evaluated",
        data: {
          decision: orchestrationResult.decision,
          router: orchestrationResult.routerDecision,
          replyOptions: orchestrationResult.replyOptions,
          packet: orchestrationPacket,
        },
      }),
      "persist route evaluated",
    );
  }
  const orchestrationTrace = orchestrationResult
    ? traceInboundOrchestration({
        cfg,
        ctx: dispatchCtx,
        result: orchestrationResult,
      })
    : null;
  const orchestrationDecision = orchestrationResult?.decision;
  let orchestrationReplyOptions = orchestrationResult?.replyOptions;
  const orchestrationTraceId = orchestrationDecision?.traceId;
  let orchestrationFinalRoute = orchestrationDecision?.finalRoute;

  // Trigger plugin hooks (fire-and-forget)
  if (hookRunner?.hasHooks("message_received")) {
    void hookRunner
      .runMessageReceived(
        {
          from: ctx.From ?? "",
          content,
          timestamp,
          metadata: {
            to: ctx.To,
            provider: ctx.Provider,
            surface: ctx.Surface,
            threadId: ctx.MessageThreadId,
            originatingChannel: ctx.OriginatingChannel,
            originatingTo: ctx.OriginatingTo,
            messageId: messageIdForHook,
            senderId: ctx.SenderId,
            senderName: ctx.SenderName,
            senderUsername: ctx.SenderUsername,
            senderE164: ctx.SenderE164,
          },
        },
        {
          channelId,
          accountId: ctx.AccountId,
          conversationId,
        },
      )
      .catch((err) => {
        logVerbose(`dispatch-from-config: message_received plugin hook failed: ${String(err)}`);
      });
  }

  // Bridge to internal hooks (HOOK.md discovery system) - refs #8807
  if (sessionKey) {
    void triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        from: ctx.From ?? "",
        content,
        timestamp,
        channelId,
        accountId: ctx.AccountId,
        conversationId,
        messageId: messageIdForHook,
        metadata: {
          to: ctx.To,
          provider: ctx.Provider,
          surface: ctx.Surface,
          threadId: ctx.MessageThreadId,
          senderId: ctx.SenderId,
          senderName: ctx.SenderName,
          senderUsername: ctx.SenderUsername,
          senderE164: ctx.SenderE164,
        },
      }),
    ).catch((err) => {
      logVerbose(`dispatch-from-config: message_received internal hook failed: ${String(err)}`);
    });
  }

  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // by a shared session that's currently on Slack) while preserving normal dispatcher
  // flow when the provider handles its own messages.
  //
  // Debug: `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts`
  const originatingChannel = dispatchCtx.OriginatingChannel;
  const originatingTo = dispatchCtx.OriginatingTo;
  const currentSurface = (dispatchCtx.Surface ?? dispatchCtx.Provider)?.toLowerCase();
  const shouldRouteToOriginating =
    isRoutableChannel(originatingChannel) && originatingTo && originatingChannel !== currentSurface;
  const ttsChannel = shouldRouteToOriginating ? originatingChannel : currentSurface;

  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * originatingChannel and originatingTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ): Promise<void> => {
    // TypeScript doesn't narrow these from the shouldRouteToOriginating check,
    // but they're guaranteed non-null when this function is called.
    if (!originatingChannel || !originatingTo) {
      return;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const result = await routeReply({
      payload,
      channel: originatingChannel,
      to: originatingTo,
      sessionKey: ctx.SessionKey,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      cfg,
      abortSignal,
      mirror,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };

  markProcessing();

  try {
    if (orchestrationDecision && orchestrationTraceId) {
      orchestrationTrace?.record("dispatch:start", {
        assignedAgentId: orchestrationDecision.assignedAgentId,
        assignedModel: orchestrationDecision.assignedModel,
        assignedProvider: orchestrationDecision.assignedProvider,
        executionModel: orchestrationDecision.executionModel,
        executionProvider: orchestrationDecision.executionProvider,
        taskClass: orchestrationDecision.taskClass,
        suggestedRoute: orchestrationDecision.suggestedRoute,
        finalRoute: orchestrationDecision.finalRoute,
        confidence: orchestrationDecision.confidence,
        reasons: orchestrationDecision.reasons,
        blockers: orchestrationDecision.blockers,
      });
      persistTraceAsync(
        persistOrchestrationStep({
          traceId: orchestrationTraceId,
          stage: "dispatch:start",
          data: {
            assignedAgentId: orchestrationDecision.assignedAgentId,
            assignedProvider: orchestrationDecision.assignedProvider,
            assignedModel: orchestrationDecision.assignedModel,
            executionProvider: orchestrationDecision.executionProvider,
            executionModel: orchestrationDecision.executionModel,
            finalRoute: orchestrationDecision.finalRoute,
            selectedAgentId: orchestrationPacket?.selectedAgentId,
            toolAllowlist: orchestrationPacket?.toolAllowlist,
          },
        }),
        "persist dispatch start",
      );
      persistTraceAsync(
        persistOrchestrationStep({
          traceId: orchestrationTraceId,
          stage: "dispatch:fast_abort_check:start",
          data: {
            finalRoute: orchestrationDecision.finalRoute,
          },
        }),
        "persist fast-abort start",
      );
    }
    const fastAbort = await tryFastAbortFromMessage({ ctx, cfg });
    if (orchestrationTraceId) {
      persistTraceAsync(
        persistOrchestrationStep({
          traceId: orchestrationTraceId,
          stage: "dispatch:fast_abort_check:end",
          data: {
            finalRoute: orchestrationFinalRoute,
            handled: fastAbort.handled,
            aborted: fastAbort.aborted,
            stoppedSubagents: fastAbort.stoppedSubagents ?? 0,
          },
        }),
        "persist fast-abort end",
      );
    }
    if (fastAbort.handled) {
      const payload = {
        text: formatAbortReplyText(fastAbort.stoppedSubagents),
      } satisfies ReplyPayload;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      if (orchestrationTraceId) {
        orchestrationTrace?.record("dispatch:end", {
          finalRoute: orchestrationFinalRoute,
          note: "fast_abort",
        });
        await persistOrchestrationRunSnapshot({
          traceId: orchestrationTraceId,
          snapshot: {
            traceId: orchestrationTraceId,
            updatedAt: new Date().toISOString(),
            inbound: {
              body: inboundTraceBody,
              flowContext: Array.isArray(dispatchCtx.FlowContext) ? dispatchCtx.FlowContext : [],
              hasMedia: Boolean(
                dispatchCtx.MediaPath ||
                dispatchCtx.MediaUrl ||
                (Array.isArray(dispatchCtx.MediaPaths) && dispatchCtx.MediaPaths.length > 0) ||
                (Array.isArray(dispatchCtx.MediaUrls) && dispatchCtx.MediaUrls.length > 0),
              ),
            },
            inboundText: inboundTraceBody,
            status: "dispatch_completed",
            finalRoute: orchestrationFinalRoute,
            outcome: "fast_abort",
            payload,
            counts,
          },
        });
        await persistOrchestrationStep({
          traceId: orchestrationTraceId,
          stage: "dispatch:end",
          data: {
            finalRoute: orchestrationFinalRoute,
            outcome: "fast_abort",
            payload,
            counts,
          },
        });
      }
      return {
        queuedFinal,
        counts,
        orchestration: orchestrationDecision,
      };
    }

    // Track accumulated block text for TTS generation after streaming completes.
    // When block streaming succeeds, there's no final reply, so we need to generate
    // TTS audio separately from the accumulated block content.
    let accumulatedBlockText = "";
    let blockCount = 0;

    const shouldSendToolSummaries =
      dispatchCtx.ChatType !== "group" && dispatchCtx.CommandSource !== "native";

    const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
      if (shouldSendToolSummaries) {
        return payload;
      }
      // Group/native flows intentionally suppress tool summary text, but media-only
      // tool results (for example TTS audio) must still be delivered.
      const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
      if (!hasMedia) {
        return null;
      }
      return { ...payload, text: undefined };
    };

    const combinedExtraSystemPrompt = [
      params.replyOptions?.extraSystemPrompt?.trim(),
      orchestrationReplyOptions?.extraSystemPrompt,
      orchestrationPacket?.packetText,
    ]
      .filter(Boolean)
      .join("\n\n");

    const effectiveReplyOptions: GetReplyOptions = {
      ...params.replyOptions,
      extraSystemPrompt: combinedExtraSystemPrompt || undefined,
      promptModeOverride:
        params.replyOptions?.promptModeOverride ?? orchestrationReplyOptions?.promptModeOverride,
      agentIdOverride: params.replyOptions?.agentIdOverride ?? orchestrationPacket?.selectedAgentId,
      modelOverride: params.replyOptions?.modelOverride ?? orchestrationReplyOptions?.modelOverride,
      modelPolicyOverride:
        params.replyOptions?.modelPolicyOverride ?? orchestrationReplyOptions?.modelPolicyOverride,
      toolAllowlistOverride:
        params.replyOptions?.toolAllowlistOverride ?? orchestrationPacket?.toolAllowlist,
      orchestrationTraceId,
      historyLimitOverride:
        params.replyOptions?.historyLimitOverride ??
        orchestrationReplyOptions?.historyLimitOverride,
      suppressThreadHistory:
        params.replyOptions?.suppressThreadHistory ??
        orchestrationReplyOptions?.suppressThreadHistory,
      suppressUntrustedContext:
        params.replyOptions?.suppressUntrustedContext ??
        orchestrationReplyOptions?.suppressUntrustedContext,
    };

    const invokeReplyResolver = async (options: GetReplyOptions) =>
      await (params.replyResolver ?? getReplyFromConfig)(
        dispatchCtx,
        {
          ...options,
          onToolResult: (payload: ReplyPayload) => {
            const run = async () => {
              const ttsPayload = await maybeApplyTtsToPayload({
                payload,
                cfg,
                channel: ttsChannel,
                kind: "tool",
                inboundAudio,
                ttsAuto: sessionTtsAuto,
              });
              const deliveryPayload = resolveToolDeliveryPayload(ttsPayload);
              if (!deliveryPayload) {
                if (orchestrationTraceId) {
                  await persistOrchestrationStep({
                    traceId: orchestrationTraceId,
                    stage: "dispatch:tool_result_skipped",
                    data: {
                      finalRoute: orchestrationFinalRoute,
                      payload: ttsPayload,
                      reason: "summary_suppressed_without_media",
                    },
                  });
                }
                return;
              }
              if (shouldRouteToOriginating) {
                await sendPayloadAsync(deliveryPayload, undefined, false);
              } else {
                dispatcher.sendToolResult(deliveryPayload);
              }
              if (orchestrationTraceId) {
                await persistOrchestrationStep({
                  traceId: orchestrationTraceId,
                  stage: "dispatch:tool_result",
                  data: {
                    finalRoute: orchestrationFinalRoute,
                    routedToOriginating: shouldRouteToOriginating,
                    payload: deliveryPayload,
                  },
                });
              }
            };
            return run();
          },
          onBlockReply: (payload: ReplyPayload, context) => {
            const run = async () => {
              if (payload.text) {
                if (accumulatedBlockText.length > 0) {
                  accumulatedBlockText += "\n";
                }
                accumulatedBlockText += payload.text;
                blockCount++;
              }
              const ttsPayload = await maybeApplyTtsToPayload({
                payload,
                cfg,
                channel: ttsChannel,
                kind: "block",
                inboundAudio,
                ttsAuto: sessionTtsAuto,
              });
              if (shouldRouteToOriginating) {
                await sendPayloadAsync(ttsPayload, context?.abortSignal, false);
              } else {
                dispatcher.sendBlockReply(ttsPayload);
              }
              if (orchestrationTraceId) {
                await persistOrchestrationStep({
                  traceId: orchestrationTraceId,
                  stage: "dispatch:block_reply",
                  data: {
                    finalRoute: orchestrationFinalRoute,
                    routedToOriginating: shouldRouteToOriginating,
                    payload: ttsPayload,
                  },
                });
              }
            };
            return run();
          },
        },
        cfg,
      );

    let replyResult;
    try {
      replyResult = await invokeReplyResolver(effectiveReplyOptions);
    } catch (err) {
      const assignedProvider = orchestrationDecision?.assignedProvider;
      const assignedPolicy = orchestrationDecision?.assignedAgentId
        ? resolveAgentModelPolicy(cfg, orchestrationDecision.assignedAgentId)
        : undefined;
      const cloudSpecialistPreferred =
        Boolean(assignedProvider) &&
        !isLocalProvider(assignedProvider) &&
        (assignedPolicy === "cloud_only" || assignedPolicy === "hybrid");
      const attemptedLocalModelOverride = isLocalProvider(
        orchestrationReplyOptions?.modelOverride?.split("/", 1)[0],
      );
      const canRetryWithoutLocalFastPath =
        orchestrationFinalRoute === "local_fast_path" &&
        cloudSpecialistPreferred &&
        (isLikelyLocalFastPathError(err) ||
          (attemptedLocalModelOverride && isLocalFastPathPolicyMismatchError(err)));

      if (!canRetryWithoutLocalFastPath) {
        throw err;
      }

      if (orchestrationDecision) {
        orchestrationDecision.finalRoute = "default_specialist";
        orchestrationDecision.executionProvider = orchestrationDecision.assignedProvider;
        orchestrationDecision.executionModel = orchestrationDecision.assignedModel;
        orchestrationDecision.promptModeOverride = undefined;
        orchestrationDecision.blockers = [
          ...new Set([...orchestrationDecision.blockers, "local_worker_model_available"]),
        ];
        orchestrationDecision.reasons = [
          ...orchestrationDecision.reasons,
          "local fast-path failed; fell back to cloud specialist execution",
        ];
      }
      orchestrationFinalRoute = "default_specialist";
      if (orchestrationTraceId) {
        await persistOrchestrationStep({
          traceId: orchestrationTraceId,
          stage: "dispatch:local_fast_path_fallback",
          data: {
            error: String(err),
            assignedProvider,
            assignedModel: orchestrationDecision?.assignedModel,
            finalRoute: orchestrationFinalRoute,
          },
        });
      }

      const specialistReplyOptions: GetReplyOptions = {
        ...effectiveReplyOptions,
        promptModeOverride: params.replyOptions?.promptModeOverride,
        modelOverride: params.replyOptions?.modelOverride,
        modelPolicyOverride: params.replyOptions?.modelPolicyOverride,
        historyLimitOverride: params.replyOptions?.historyLimitOverride,
        suppressThreadHistory: params.replyOptions?.suppressThreadHistory,
        suppressUntrustedContext: params.replyOptions?.suppressUntrustedContext,
      };
      replyResult = await invokeReplyResolver(specialistReplyOptions);
    }

    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];

    let queuedFinal = false;
    let routedFinalCount = 0;
    for (const reply of replies) {
      const ttsReply = await maybeApplyTtsToPayload({
        payload: reply,
        cfg,
        channel: ttsChannel,
        kind: "final",
        inboundAudio,
        ttsAuto: sessionTtsAuto,
      });
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        // Route final reply to originating channel.
        const result = await routeReply({
          payload: ttsReply,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        queuedFinal = result.ok || queuedFinal;
        if (result.ok) {
          routedFinalCount += 1;
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(ttsReply) || queuedFinal;
      }
      if (orchestrationTraceId) {
        await persistOrchestrationStep({
          traceId: orchestrationTraceId,
          stage: "dispatch:final_reply",
          data: {
            finalRoute: orchestrationFinalRoute,
            routedToOriginating: shouldRouteToOriginating,
            payload: ttsReply,
          },
        });
      }
    }

    const ttsMode = resolveTtsConfig(cfg).mode ?? "final";
    // Generate TTS-only reply after block streaming completes (when there's no final reply).
    // This handles the case where block streaming succeeds and drops final payloads,
    // but we still want TTS audio to be generated from the accumulated block content.
    if (
      ttsMode === "final" &&
      replies.length === 0 &&
      blockCount > 0 &&
      accumulatedBlockText.trim()
    ) {
      try {
        const ttsSyntheticReply = await maybeApplyTtsToPayload({
          payload: { text: accumulatedBlockText },
          cfg,
          channel: ttsChannel,
          kind: "final",
          inboundAudio,
          ttsAuto: sessionTtsAuto,
        });
        // Only send if TTS was actually applied (mediaUrl exists)
        if (ttsSyntheticReply.mediaUrl) {
          // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content
          const ttsOnlyPayload: ReplyPayload = {
            mediaUrl: ttsSyntheticReply.mediaUrl,
            audioAsVoice: ttsSyntheticReply.audioAsVoice,
          };
          if (shouldRouteToOriginating && originatingChannel && originatingTo) {
            const result = await routeReply({
              payload: ttsOnlyPayload,
              channel: originatingChannel,
              to: originatingTo,
              sessionKey: ctx.SessionKey,
              accountId: ctx.AccountId,
              threadId: ctx.MessageThreadId,
              cfg,
            });
            queuedFinal = result.ok || queuedFinal;
            if (result.ok) {
              routedFinalCount += 1;
            }
            if (!result.ok) {
              logVerbose(
                `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
              );
            }
          } else {
            const didQueue = dispatcher.sendFinalReply(ttsOnlyPayload);
            queuedFinal = didQueue || queuedFinal;
          }
          if (orchestrationTraceId) {
            await persistOrchestrationStep({
              traceId: orchestrationTraceId,
              stage: "dispatch:final_reply",
              data: {
                finalRoute: orchestrationFinalRoute,
                routedToOriginating: shouldRouteToOriginating,
                payload: ttsOnlyPayload,
                synthesizedFromBlocks: true,
              },
            });
          }
        }
      } catch (err) {
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed("completed");
    markIdle("message_completed");
    if (orchestrationTraceId) {
      orchestrationTrace?.record("dispatch:end", {
        finalRoute: orchestrationFinalRoute,
        note: replies.length > 0 ? `final_replies:${replies.length}` : "no_final_reply",
      });
      await persistOrchestrationRunSnapshot({
        traceId: orchestrationTraceId,
        snapshot: {
          traceId: orchestrationTraceId,
          updatedAt: new Date().toISOString(),
          assignedAgentId: orchestrationDecision?.assignedAgentId,
          assignedProvider: orchestrationDecision?.assignedProvider,
          assignedModel: orchestrationDecision?.assignedModel,
          executionProvider: orchestrationDecision?.executionProvider,
          executionModel: orchestrationDecision?.executionModel,
          taskClass: orchestrationDecision?.taskClass,
          suggestedRoute: orchestrationDecision?.suggestedRoute,
          confidence: orchestrationDecision?.confidence,
          policyChecks: orchestrationDecision?.policyChecks,
          blockers: orchestrationDecision?.blockers,
          reasons: orchestrationDecision?.reasons,
          router: orchestrationDecision ? orchestrationResult?.routerDecision : undefined,
          packet: orchestrationPacket
            ? {
                selectedAgentId: orchestrationPacket.selectedAgentId,
                selectedAgentReason: orchestrationPacket.selectedAgentReason,
                agentCandidates: orchestrationPacket.agentCandidates,
                toolAllowlist: orchestrationPacket.toolAllowlist,
                memoryResults: orchestrationPacket.memoryResults,
                vaultResults: orchestrationPacket.vaultResults,
                packetText: orchestrationPacket.packetText,
              }
            : undefined,
          inbound: {
            body: inboundTraceBody,
            flowContext: Array.isArray(dispatchCtx.FlowContext) ? dispatchCtx.FlowContext : [],
            hasMedia: Boolean(
              dispatchCtx.MediaPath ||
              dispatchCtx.MediaUrl ||
              (Array.isArray(dispatchCtx.MediaPaths) && dispatchCtx.MediaPaths.length > 0) ||
              (Array.isArray(dispatchCtx.MediaUrls) && dispatchCtx.MediaUrls.length > 0),
            ),
          },
          inboundText: inboundTraceBody,
          status: "dispatch_completed",
          finalRoute: orchestrationFinalRoute,
          replyResult,
          counts,
        },
      });
      await persistOrchestrationStep({
        traceId: orchestrationTraceId,
        stage: "dispatch:end",
        data: {
          finalRoute: orchestrationFinalRoute,
          replyResult,
          counts,
        },
      });
    }
    return {
      queuedFinal,
      counts,
      inboundPrependContext,
      orchestration: orchestrationDecision,
    };
  } catch (err) {
    if (orchestrationTraceId) {
      orchestrationTrace?.record("dispatch:error", {
        finalRoute: orchestrationFinalRoute,
        error: String(err),
      });
      await persistOrchestrationRunSnapshot({
        traceId: orchestrationTraceId,
        snapshot: {
          traceId: orchestrationTraceId,
          updatedAt: new Date().toISOString(),
          assignedAgentId: orchestrationDecision?.assignedAgentId,
          assignedProvider: orchestrationDecision?.assignedProvider,
          assignedModel: orchestrationDecision?.assignedModel,
          executionProvider: orchestrationDecision?.executionProvider,
          executionModel: orchestrationDecision?.executionModel,
          taskClass: orchestrationDecision?.taskClass,
          suggestedRoute: orchestrationDecision?.suggestedRoute,
          confidence: orchestrationDecision?.confidence,
          policyChecks: orchestrationDecision?.policyChecks,
          blockers: orchestrationDecision?.blockers,
          reasons: orchestrationDecision?.reasons,
          router: orchestrationDecision ? orchestrationResult?.routerDecision : undefined,
          packet: orchestrationPacket
            ? {
                selectedAgentId: orchestrationPacket.selectedAgentId,
                selectedAgentReason: orchestrationPacket.selectedAgentReason,
                agentCandidates: orchestrationPacket.agentCandidates,
                toolAllowlist: orchestrationPacket.toolAllowlist,
                memoryResults: orchestrationPacket.memoryResults,
                vaultResults: orchestrationPacket.vaultResults,
                packetText: orchestrationPacket.packetText,
              }
            : undefined,
          inbound: {
            body: inboundTraceBody,
            flowContext: Array.isArray(dispatchCtx.FlowContext) ? dispatchCtx.FlowContext : [],
            hasMedia: Boolean(
              dispatchCtx.MediaPath ||
              dispatchCtx.MediaUrl ||
              (Array.isArray(dispatchCtx.MediaPaths) && dispatchCtx.MediaPaths.length > 0) ||
              (Array.isArray(dispatchCtx.MediaUrls) && dispatchCtx.MediaUrls.length > 0),
            ),
          },
          inboundText: inboundTraceBody,
          status: "dispatch_error",
          finalRoute: orchestrationFinalRoute,
          error: String(err),
        },
      });
      await persistOrchestrationStep({
        traceId: orchestrationTraceId,
        stage: "dispatch:error",
        data: {
          finalRoute: orchestrationFinalRoute,
          error: String(err),
        },
      });
    }
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    throw err;
  }
}
