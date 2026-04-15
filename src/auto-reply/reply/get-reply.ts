import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { applyLinkUnderstanding } from "../../link-understanding/apply.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveDefaultModel } from "./directive-handling.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runPreparedReply } from "./get-reply-run.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { persistOrchestrationStep } from "./orchestration-vault.js";
import { applyResetModelOverride } from "./session-reset-model.js";
import { initSessionState } from "./session.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";
import { createTypingController } from "./typing.js";

function mergeSkillFilters(channelFilter?: string[], agentFilter?: string[]): string[] | undefined {
  const normalize = (list?: string[]) => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    return list.map((entry) => String(entry).trim()).filter(Boolean);
  };
  const channel = normalize(channelFilter);
  const agent = normalize(agentFilter);
  if (!channel && !agent) {
    return undefined;
  }
  if (!channel) {
    return agent;
  }
  if (!agent) {
    return channel;
  }
  if (channel.length === 0 || agent.length === 0) {
    return [];
  }
  const agentSet = new Set(agent);
  return channel.filter((name) => agentSet.has(name));
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const cfg = configOverride ?? loadConfig();
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  const agentId =
    opts?.agentIdOverride?.trim() ||
    resolveSessionAgentId({
      sessionKey: agentSessionKey,
      config: cfg,
    });
  const mergedSkillFilter = mergeSkillFilters(
    opts?.skillFilter,
    resolveAgentSkillsFilter(cfg, agentId),
  );
  const resolvedOpts =
    mergedSkillFilter !== undefined ? { ...opts, skillFilter: mergedSkillFilter } : opts;
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg,
    agentId,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      opts.heartbeatModelOverride?.trim() ?? agentCfg?.heartbeat?.model?.trim() ?? "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromString({
          raw: heartbeatRaw,
          defaultProvider,
          aliasIndex,
        })
      : null;
    if (heartbeatRef) {
      provider = heartbeatRef.ref.provider;
      model = heartbeatRef.ref.model;
      hasResolvedHeartbeatModelOverride = true;
    }
  }
  const runtimeModelOverrideRaw = opts?.modelOverride?.trim() ?? "";
  const persistTraceStep = async (stage: string, data: Record<string, unknown>) => {
    const traceId = opts?.orchestrationTraceId?.trim();
    if (!traceId) {
      return;
    }
    await persistOrchestrationStep({
      traceId,
      stage,
      data,
    });
  };
  if (runtimeModelOverrideRaw) {
    const runtimeModelRef = resolveModelRefFromString({
      raw: runtimeModelOverrideRaw,
      defaultProvider,
      aliasIndex,
    });
    if (runtimeModelRef) {
      provider = runtimeModelRef.ref.provider;
      model = runtimeModelRef.ref.model;
    }
  }

  await persistTraceStep("reply:start", {
    agentId,
    provider,
    model,
    runtimeModelOverrideRaw: runtimeModelOverrideRaw || undefined,
    promptModeOverride: resolvedOpts?.promptModeOverride,
    hasHeartbeatOverride: hasResolvedHeartbeatModelOverride,
  });

  const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const shouldEnsureBootstrapFiles =
    !agentCfg?.skipBootstrap &&
    !isFastTestEnv &&
    resolvedOpts?.promptModeOverride !== "local_worker";
  let workspace;
  try {
    await persistTraceStep("reply:workspace:start", {
      workspaceDirRaw,
      ensureBootstrapFiles: shouldEnsureBootstrapFiles,
    });
    workspace = await ensureAgentWorkspace({
      dir: workspaceDirRaw,
      ensureBootstrapFiles: shouldEnsureBootstrapFiles,
    });
    await persistTraceStep("reply:workspace:end", {
      workspaceDir: workspace.dir,
    });
  } catch (err) {
    await persistTraceStep("reply:workspace:error", {
      error: String(err),
      workspaceDirRaw,
    });
    throw err;
  }
  const workspaceDir = workspace.dir;
  const agentDir = resolveAgentDir(cfg, agentId);
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideSeconds: opts?.timeoutOverrideSeconds });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    onReplyStart: opts?.onReplyStart,
    onCleanup: opts?.onTypingCleanup,
    typingIntervalSeconds,
    silentToken: SILENT_REPLY_TOKEN,
    log: defaultRuntime.log,
  });
  opts?.onTypingController?.(typing);

  let finalized;
  try {
    await persistTraceStep("reply:context_finalize:start", {});
    finalized = finalizeInboundContext(ctx);
    await persistTraceStep("reply:context_finalize:end", {
      hasBody: Boolean(finalized.Body?.trim()),
      hasBodyForAgent: Boolean(finalized.BodyForAgent?.trim()),
      hasBodyForCommands: Boolean(finalized.BodyForCommands?.trim()),
      mediaCount: finalized.MediaPaths?.length ?? (finalized.MediaPath ? 1 : 0),
    });
  } catch (err) {
    await persistTraceStep("reply:context_finalize:error", {
      error: String(err),
    });
    throw err;
  }

  if (!isFastTestEnv) {
    try {
      await persistTraceStep("reply:media_understanding:start", {
        hasMedia: Boolean(finalized.MediaPath) || (finalized.MediaPaths?.length ?? 0) > 0,
      });
      await applyMediaUnderstanding({
        ctx: finalized,
        cfg,
        agentDir,
        activeModel: { provider, model },
      });
      await persistTraceStep("reply:media_understanding:end", {
        hasMediaUnderstanding: (finalized.MediaUnderstanding?.length ?? 0) > 0,
        mediaUnderstandingCount: finalized.MediaUnderstanding?.length ?? 0,
      });
    } catch (err) {
      await persistTraceStep("reply:media_understanding:error", {
        error: String(err),
      });
      throw err;
    }

    try {
      await persistTraceStep("reply:link_understanding:start", {});
      await applyLinkUnderstanding({
        ctx: finalized,
        cfg,
      });
      await persistTraceStep("reply:link_understanding:end", {
        linkUnderstandingCount: finalized.LinkUnderstanding?.length ?? 0,
      });
    } catch (err) {
      await persistTraceStep("reply:link_understanding:error", {
        error: String(err),
      });
      throw err;
    }
  }

  const commandAuthorized = finalized.CommandAuthorized;
  resolveCommandAuthorization({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  let sessionState;
  try {
    await persistTraceStep("reply:session_init:start", {
      commandAuthorized,
    });
    sessionState = await initSessionState({
      ctx: finalized,
      cfg,
      commandAuthorized,
    });
    await persistTraceStep("reply:session_init:end", {
      sessionKey: sessionState.sessionKey,
      sessionId: sessionState.sessionId,
      isNewSession: sessionState.isNewSession,
      resetTriggered: sessionState.resetTriggered,
    });
  } catch (err) {
    await persistTraceStep("reply:session_init:error", {
      error: String(err),
      commandAuthorized,
    });
    throw err;
  }
  let {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
  } = sessionState;
  await persistTraceStep("reply:session_initialized", {
    agentId,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    commandAuthorized,
    provider,
    model,
  });

  try {
    await persistTraceStep("reply:reset_model:start", {
      resetTriggered,
      hasBody: Boolean(bodyStripped?.trim()),
    });
    await applyResetModelOverride({
      cfg,
      resetTriggered,
      bodyStripped,
      sessionCtx,
      ctx: finalized,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      defaultProvider,
      defaultModel,
      aliasIndex,
    });
    await persistTraceStep("reply:reset_model:end", {
      resetTriggered,
      bodyAfterReset: sessionCtx.BodyStripped ?? sessionCtx.Body ?? "",
    });
  } catch (err) {
    await persistTraceStep("reply:reset_model:error", {
      error: String(err),
    });
    throw err;
  }

  let directiveResult;
  try {
    await persistTraceStep("reply:directives:start", {
      provider,
      model,
      runtimeModelOverrideRaw: runtimeModelOverrideRaw || undefined,
      promptModeOverride: resolvedOpts?.promptModeOverride,
    });
    directiveResult = await resolveReplyDirectives({
      ctx: finalized,
      cfg,
      agentId,
      agentDir,
      workspaceDir,
      agentCfg,
      sessionCtx,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      groupResolution,
      isGroup,
      triggerBodyNormalized,
      commandAuthorized,
      defaultProvider,
      defaultModel,
      aliasIndex,
      provider,
      model,
      hasResolvedHeartbeatModelOverride,
      typing,
      opts: resolvedOpts,
      skillFilter: mergedSkillFilter,
    });
    await persistTraceStep("reply:directives:end", {
      kind: directiveResult.kind,
    });
  } catch (err) {
    await persistTraceStep("reply:directives:error", {
      error: String(err),
      provider,
      model,
    });
    throw err;
  }
  if (directiveResult.kind === "reply") {
    await persistTraceStep("reply:short_circuit", {
      source: "directives",
      hasReply: directiveResult.reply !== undefined,
    });
    return directiveResult.reply;
  }

  let {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    provider: resolvedProvider,
    model: resolvedModel,
    modelState,
    contextTokens,
    inlineStatusRequested,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  } = directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;
  if (runtimeModelOverrideRaw) {
    const runtimeModelRef = resolveModelRefFromString({
      raw: runtimeModelOverrideRaw,
      defaultProvider,
      aliasIndex,
    });
    if (runtimeModelRef) {
      provider = runtimeModelRef.ref.provider;
      model = runtimeModelRef.ref.model;
    }
  }

  let inlineActionResult;
  try {
    await persistTraceStep("reply:inline_actions:start", {
      provider,
      model,
      inlineStatusRequested,
    });
    inlineActionResult = await handleInlineActions({
      ctx,
      sessionCtx,
      cfg,
      agentId,
      agentDir,
      sessionEntry,
      previousSessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      workspaceDir,
      isGroup,
      opts: resolvedOpts,
      typing,
      allowTextCommands,
      inlineStatusRequested,
      command,
      skillCommands,
      directives,
      cleanedBody,
      elevatedEnabled,
      elevatedAllowed,
      elevatedFailures,
      defaultActivation: () => defaultActivation,
      resolvedThinkLevel,
      resolvedVerboseLevel,
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
      provider,
      model,
      contextTokens,
      directiveAck,
      abortedLastRun,
      skillFilter: mergedSkillFilter,
    });
    await persistTraceStep("reply:inline_actions:end", {
      kind: inlineActionResult.kind,
    });
  } catch (err) {
    await persistTraceStep("reply:inline_actions:error", {
      error: String(err),
      provider,
      model,
    });
    throw err;
  }
  if (inlineActionResult.kind === "reply") {
    await persistTraceStep("reply:short_circuit", {
      source: "inline_actions",
      hasReply: inlineActionResult.reply !== undefined,
    });
    return inlineActionResult.reply;
  }
  directives = inlineActionResult.directives;
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;

  try {
    await persistTraceStep("reply:stage_media:start", {
      hasMedia: Boolean(ctx.MediaPath || ctx.MediaUrl),
    });
    await stageSandboxMedia({
      ctx,
      sessionCtx,
      cfg,
      sessionKey,
      workspaceDir,
    });
    await persistTraceStep("reply:stage_media:end", {
      hasMedia: Boolean(sessionCtx.MediaPath || sessionCtx.MediaUrl),
    });
  } catch (err) {
    await persistTraceStep("reply:stage_media:error", {
      error: String(err),
    });
    throw err;
  }

  try {
    await persistTraceStep("reply:run_prepared:start", {
      provider,
      model,
      timeoutMs,
      promptModeOverride: resolvedOpts?.promptModeOverride,
      historyLimitOverride: resolvedOpts?.historyLimitOverride,
      toolAllowlistOverride: resolvedOpts?.toolAllowlistOverride,
    });
    const reply = await runPreparedReply({
      ctx,
      sessionCtx,
      cfg,
      agentId,
      agentDir,
      agentCfg,
      sessionCfg,
      commandAuthorized,
      command,
      commandSource,
      allowTextCommands,
      directives,
      defaultActivation,
      resolvedThinkLevel,
      resolvedVerboseLevel,
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      execOverrides,
      elevatedEnabled,
      elevatedAllowed,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      modelState,
      provider,
      model,
      perMessageQueueMode,
      perMessageQueueOptions,
      typing,
      opts: resolvedOpts,
      defaultProvider,
      defaultModel,
      timeoutMs,
      isNewSession,
      resetTriggered,
      systemSent,
      sessionEntry,
      sessionStore,
      sessionKey,
      sessionId,
      storePath,
      workspaceDir,
      abortedLastRun,
    });
    await persistTraceStep("reply:run_prepared:end", {
      returnedReply: reply !== undefined,
      isArray: Array.isArray(reply),
    });
    return reply;
  } catch (err) {
    await persistTraceStep("reply:run_prepared:error", {
      error: String(err),
      provider,
      model,
    });
    throw err;
  }
}
