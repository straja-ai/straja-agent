import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { HookInboundEnvelope, HookMessageChannel, HooksConfigResolved } from "../hooks.js";
import { createHooksRequestHandler } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  /**
   * If the hook carried an `inbound` envelope, run the `before_inbound_dispatch`
   * hook chain so plugins (flow matcher, memory injector, etc.) can compute
   * trusted prepend context for this synthetic inbound event. Returns the
   * computed prepend string, or undefined if no plugin contributed.
   *
   * Failures are logged but never propagate — a flow hook misbehaving must not
   * block the underlying notification turn.
   */
  async function computeInboundPrependContext(
    inbound: HookInboundEnvelope,
    sessionKey: string,
  ): Promise<string | undefined> {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner || !hookRunner.hasHooks("before_inbound_dispatch")) {
      return undefined;
    }
    const timeoutMs = 4_000;
    try {
      const result = await Promise.race([
        hookRunner.runBeforeInboundDispatch(
          {
            from: inbound.from ?? "",
            content: inbound.content ?? "",
            timestamp: Date.now(),
            metadata: inbound.metadata ?? {},
          },
          {
            channelId: inbound.channel,
            accountId: undefined,
            conversationId: undefined,
            sessionKey,
            agentId: undefined,
          },
        ),
        new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      const prepend =
        result && typeof result === "object" && "prependContext" in result
          ? (result as { prependContext?: unknown }).prependContext
          : undefined;
      return typeof prepend === "string" && prepend.trim() ? prepend : undefined;
    } catch (err) {
      logHooks.warn(
        `before_inbound_dispatch failed for inbound ${inbound.channel} hook: ${String(err)}`,
      );
      return undefined;
    }
  }

  const dispatchAgentHook = (value: {
    message: string;
    name: string;
    agentId?: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
    skipGuardModelChecks?: boolean;
    inbound?: HookInboundEnvelope;
  }) => {
    const sessionKey = value.sessionKey.trim();
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        deliver: value.deliver,
        channel: value.channel,
        to: value.to,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
        skipGuardModelChecks: value.skipGuardModelChecks,
      },
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      try {
        const cfg = loadConfig();
        // Run flow / inbound-dispatch plugins for inbound-shaped hooks so the
        // user's flows can match on the inbound channel (e.g. "email").
        let effectiveMessage = value.message;
        if (value.inbound) {
          const inbound = value.inbound;
          logHooks.info(
            `hook ${value.name}: inbound dispatcher entered (channel=${inbound.channel} from=${inbound.from ?? "?"} content.len=${(inbound.content ?? "").length})`,
          );
          const prepend = await computeInboundPrependContext(value.inbound, sessionKey);
          if (prepend) {
            effectiveMessage = `${prepend}\n\n${value.message}`;
            logHooks.info(
              `hook ${value.name}: prepended ${prepend.length} chars of inbound flow context (channel=${value.inbound.channel})`,
            );
          } else {
            logHooks.info(
              `hook ${value.name}: no inbound flow context (no plugin returned prepend)`,
            );
          }
        }
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: effectiveMessage,
          sessionKey,
          lane: "cron",
        });
        const summary = result.summary?.trim() || result.error?.trim() || result.status;
        const prefix =
          result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
        enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}` });
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}:error` });
        }
      }
    })();

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
