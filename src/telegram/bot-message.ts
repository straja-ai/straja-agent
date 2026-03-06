import type { ReplyToMode } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.telegram.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";

// ---------------------------------------------------------------------------
// Vault audit consumer — routes messaging audit entries through vault
// ---------------------------------------------------------------------------

const AUDIT_PATCH_KEY = Symbol.for("openclaw.auditPatchCallback");

type AuditPatchOps = {
  appendEntry(category: string, entry: Record<string, unknown>): Promise<void>;
};

function resolveVaultAuditOps(): AuditPatchOps | undefined {
  const g = globalThis as Record<symbol, unknown>;
  const factory = g[AUDIT_PATCH_KEY] as (() => AuditPatchOps) | undefined;
  return factory?.();
}

// ---------------------------------------------------------------------------

/** Dependencies injected once when creating the message processor. */
type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  "primaryCtx" | "allMedia" | "storeAllowFrom" | "options"
> & {
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  opts: Pick<TelegramBotOptions, "token">;
};

export const createTelegramMessageProcessor = (deps: TelegramMessageProcessorDeps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
  } = deps;

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: { messageIdOverride?: string; forceWasMentioned?: boolean },
  ) => {
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
    });
    if (!context) {
      return;
    }
    await dispatchTelegramMessage({
      context,
      bot,
      cfg,
      runtime,
      replyToMode,
      streamMode,
      textLimit,
      telegramCfg,
      opts,
    });

    // Audit: inbound Telegram message processed
    try {
      const ops = resolveVaultAuditOps();
      if (ops) {
        const msg = primaryCtx.message;
        ops
          .appendEntry("messaging", {
            timestamp: new Date().toISOString(),
            toolName: "messaging",
            action: "receive",
            channel: "telegram",
            verdict: "allowed",
            reason: "Inbound message processed",
            severity: "low",
            details: {
              chatId: msg.chat?.id,
              userId: msg.from?.id,
              messageLength: (msg.text ?? msg.caption ?? "").length,
              mediaCount: allMedia.length,
              accountId: account,
            },
          })
          .catch(() => {});
      }
    } catch {
      // Audit must never break message processing
    }
  };
};
