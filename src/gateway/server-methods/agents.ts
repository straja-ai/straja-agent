import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceOnboardingCompleted,
} from "../../agents/workspace.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  getFlowTestCaptureSnapshot,
  recordFlowTestInput,
  withFlowTestContext,
} from "../../auto-reply/flow-test-context.js";
import { buildTestCtx } from "../../auto-reply/reply/test-ctx.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { movePathToTrash } from "../../browser/trash.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
  pruneAgentConfig,
} from "../../commands/agents.config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentsCreateParams,
  validateAgentsDeleteParams,
  validateAgentsFilesGetParams,
  validateAgentsFilesListParams,
  validateAgentsFilesSetParams,
  validateAgentsFlowTestParams,
  validateAgentsListParams,
  validateAgentsUpdateParams,
} from "../protocol/index.js";
import { listAgentsForGateway } from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const BOOTSTRAP_FILE_NAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
] as const;
const BOOTSTRAP_FILE_NAMES_POST_ONBOARDING = BOOTSTRAP_FILE_NAMES.filter(
  (name) => name !== DEFAULT_BOOTSTRAP_FILENAME,
);

const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME] as const;

/** Well-known Symbol for vault gateway workspace patch. */
const GATEWAY_WORKSPACE_PATCH_KEY = Symbol.for("openclaw.gatewayWorkspacePatchCallback");

type GatewayWorkspaceOps = {
  statFile(filename: string): Promise<FileMeta | null>;
  readFile(filename: string): Promise<string | null>;
  writeFile(filename: string, content: string): Promise<void>;
  statFileInCollection?(
    collection: "_workspace" | "_memory",
    filename: string,
  ): Promise<FileMeta | null>;
  readFileInCollection?(
    collection: "_workspace" | "_memory",
    filename: string,
  ): Promise<string | null>;
  writeFileInCollection?(
    collection: "_workspace" | "_memory",
    filename: string,
    content: string,
  ): Promise<void>;
};

function resolveVaultOps(): GatewayWorkspaceOps | undefined {
  const g = globalThis as Record<symbol, unknown>;
  const factory = g[GATEWAY_WORKSPACE_PATCH_KEY] as (() => GatewayWorkspaceOps) | undefined;
  return factory?.();
}

const ALLOWED_FILE_NAMES = new Set<string>([...BOOTSTRAP_FILE_NAMES, ...MEMORY_FILE_NAMES]);

function collectionForAgentFileName(name: string): "_workspace" | "_memory" {
  return MEMORY_FILE_NAMES.includes(name as (typeof MEMORY_FILE_NAMES)[number])
    ? "_memory"
    : "_workspace";
}

async function statVaultFile(filename: string): Promise<FileMeta | null> {
  const vaultOps = resolveVaultOps();
  if (!vaultOps) {
    return null;
  }
  const collection = collectionForAgentFileName(filename);
  if (vaultOps.statFileInCollection) {
    return await vaultOps.statFileInCollection(collection, filename);
  }
  if (collection === "_workspace") {
    return await vaultOps.statFile(filename);
  }
  throw new Error("Vault workspace patch does not support _memory files");
}

async function readVaultFile(filename: string): Promise<string | null> {
  const vaultOps = resolveVaultOps();
  if (!vaultOps) {
    return null;
  }
  const collection = collectionForAgentFileName(filename);
  if (vaultOps.readFileInCollection) {
    return await vaultOps.readFileInCollection(collection, filename);
  }
  if (collection === "_workspace") {
    return await vaultOps.readFile(filename);
  }
  throw new Error("Vault workspace patch does not support _memory files");
}

async function writeVaultFile(filename: string, content: string): Promise<void> {
  const vaultOps = resolveVaultOps();
  if (!vaultOps) {
    return;
  }
  const collection = collectionForAgentFileName(filename);
  if (vaultOps.writeFileInCollection) {
    await vaultOps.writeFileInCollection(collection, filename, content);
    return;
  }
  if (collection === "_workspace") {
    await vaultOps.writeFile(filename, content);
    return;
  }
  throw new Error("Vault workspace patch does not support _memory files");
}

function buildSyntheticFlowTestContext(params: {
  channel: string;
  message: string;
  sender?: string;
  senderE164?: string;
  senderName?: string;
  senderUsername?: string;
  accountId?: string;
  conversationId?: string;
  to?: string;
  agentId: string;
}) {
  const channel = params.channel.trim().toLowerCase();
  const sender =
    params.sender?.trim() ||
    params.senderE164?.trim() ||
    (channel === "telegram" ? "telegram:123456789" : "+15550001111");
  const senderE164 = params.senderE164?.trim() || (sender.startsWith("+") ? sender : undefined);
  const conversationId = params.conversationId?.trim() || params.to?.trim() || sender;
  const to = params.to?.trim() || conversationId;
  const prefixedFrom = sender.includes(":") ? sender : `${channel}:${sender}`;
  const prefixedTo = to.includes(":") ? to : `${channel}:${to}`;
  const sessionKey = `agent:${normalizeAgentId(params.agentId)}:flow-test:${randomUUID().slice(0, 8)}`;

  return buildTestCtx({
    Body: params.message,
    RawBody: params.message,
    BodyForCommands: params.message,
    CommandBody: params.message,
    CommandSource: "text",
    Provider: channel,
    Surface: channel,
    OriginatingChannel: channel,
    From: prefixedFrom,
    To: prefixedTo,
    OriginatingTo: conversationId,
    SenderId: sender,
    SenderE164: senderE164,
    SenderName: params.senderName?.trim() || undefined,
    SenderUsername: params.senderUsername?.trim() || undefined,
    AccountId: params.accountId?.trim() || undefined,
    SessionKey: sessionKey,
    CommandAuthorized: true,
  });
}

async function resolveInboundFlowTestPrependContext(params: {
  ctx: ReturnType<typeof buildTestCtx>;
  agentId: string;
  prependContextOverride?: string;
}): Promise<string | undefined> {
  if (params.prependContextOverride?.trim()) {
    return params.prependContextOverride.trim();
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_inbound_dispatch")) {
    return undefined;
  }
  const ctx = params.ctx;
  const messageId =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const content =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.RawBody === "string"
        ? ctx.RawBody
        : typeof ctx.Body === "string"
          ? ctx.Body
          : "";
  const result = await hookRunner.runBeforeInboundDispatch(
    {
      from: ctx.From ?? "",
      content,
      timestamp:
        typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp)
          ? ctx.Timestamp
          : undefined,
      metadata: {
        to: ctx.To,
        provider: ctx.Provider,
        surface: ctx.Surface,
        threadId: ctx.MessageThreadId,
        originatingChannel: ctx.OriginatingChannel,
        originatingTo: ctx.OriginatingTo,
        messageId,
        senderId: ctx.SenderId,
        senderName: ctx.SenderName,
        senderUsername: ctx.SenderUsername,
        senderE164: ctx.SenderE164,
      },
    },
    {
      channelId: String(ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase(),
      accountId: ctx.AccountId,
      conversationId: ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? undefined,
      sessionKey: ctx.SessionKey,
      agentId: params.agentId,
    },
  );
  return result?.prependContext?.trim() || undefined;
}

function resolveAgentWorkspaceFileOrRespondError(
  params: Record<string, unknown>,
  respond: RespondFn,
): {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  workspaceDir: string;
  name: string;
} | null {
  const cfg = loadConfig();
  const rawAgentId = params.agentId;
  const agentId = resolveAgentIdOrError(
    typeof rawAgentId === "string" || typeof rawAgentId === "number" ? String(rawAgentId) : "",
    cfg,
  );
  if (!agentId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  const rawName = params.name;
  const name = (
    typeof rawName === "string" || typeof rawName === "number" ? String(rawName) : ""
  ).trim();
  if (!ALLOWED_FILE_NAMES.has(name)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`));
    return null;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return { cfg, agentId, workspaceDir, name };
}

type FileMeta = {
  size: number;
  updatedAtMs: number;
};

async function statFile(filePath: string): Promise<FileMeta | null> {
  if (resolveVaultOps()) {
    const filename = path.basename(filePath);
    return statVaultFile(filename);
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return {
      size: stat.size,
      updatedAtMs: Math.floor(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

async function listAgentFiles(workspaceDir: string, options?: { hideBootstrap?: boolean }) {
  const files: Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
  }> = [];

  const bootstrapFileNames = options?.hideBootstrap
    ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING
    : BOOTSTRAP_FILE_NAMES;
  for (const name of bootstrapFileNames) {
    const filePath = path.join(workspaceDir, name);
    const meta = await statFile(filePath);
    if (meta) {
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    } else {
      files.push({ name, path: filePath, missing: true });
    }
  }

  const primaryMemoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
  const primaryMeta = await statFile(primaryMemoryPath);
  if (primaryMeta) {
    files.push({
      name: DEFAULT_MEMORY_FILENAME,
      path: primaryMemoryPath,
      missing: false,
      size: primaryMeta.size,
      updatedAtMs: primaryMeta.updatedAtMs,
    });
  } else {
    const altMemoryPath = path.join(workspaceDir, DEFAULT_MEMORY_ALT_FILENAME);
    const altMeta = await statFile(altMemoryPath);
    if (altMeta) {
      files.push({
        name: DEFAULT_MEMORY_ALT_FILENAME,
        path: altMemoryPath,
        missing: false,
        size: altMeta.size,
        updatedAtMs: altMeta.updatedAtMs,
      });
    } else {
      files.push({ name: DEFAULT_MEMORY_FILENAME, path: primaryMemoryPath, missing: true });
    }
  }

  return files;
}

function resolveAgentIdOrError(agentIdRaw: string, cfg: ReturnType<typeof loadConfig>) {
  const agentId = normalizeAgentId(agentIdRaw);
  const allowed = new Set(listAgentIds(cfg));
  if (!allowed.has(agentId)) {
    return null;
  }
  return agentId;
}

function sanitizeIdentityLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function resolveOptionalStringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function moveToTrashBestEffort(pathname: string): Promise<void> {
  if (!pathname) {
    return;
  }
  try {
    await fs.access(pathname);
  } catch {
    return;
  }
  try {
    await movePathToTrash(pathname);
  } catch {
    // Best-effort: path may already be gone or trash unavailable.
  }
}

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": ({ params, respond }) => {
    if (!validateAgentsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.list params: ${formatValidationErrors(validateAgentsListParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const result = listAgentsForGateway(cfg);
    respond(true, result, undefined);
  },
  "agents.create": async ({ params, respond }) => {
    if (!validateAgentsCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.create params: ${formatValidationErrors(
            validateAgentsCreateParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const rawName = String(params.name ?? "").trim();
    const agentId = normalizeAgentId(rawName);
    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" is reserved`),
      );
      return;
    }

    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" already exists`),
      );
      return;
    }

    const workspaceDir = resolveUserPath(String(params.workspace ?? "").trim());

    // Resolve agentDir against the config we're about to persist (vs the pre-write config),
    // so subsequent resolutions can't disagree about the agent's directory.
    let nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: rawName,
      workspace: workspaceDir,
    });
    const agentDir = resolveAgentDir(nextConfig, agentId);
    nextConfig = applyAgentConfig(nextConfig, { agentId, agentDir });

    // Ensure workspace & transcripts exist BEFORE writing config so a failure
    // here does not leave a broken config entry behind.
    const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
    await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: !skipBootstrap });
    await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

    await writeConfigFile(nextConfig);

    // Always write Name to IDENTITY.md; optionally include emoji/avatar.
    const safeName = sanitizeIdentityLine(rawName);
    const emoji = resolveOptionalStringParam(params.emoji);
    const avatar = resolveOptionalStringParam(params.avatar);
    const identityPath = path.join(workspaceDir, DEFAULT_IDENTITY_FILENAME);
    const lines = [
      "",
      `- Name: ${safeName}`,
      ...(emoji ? [`- Emoji: ${sanitizeIdentityLine(emoji)}`] : []),
      ...(avatar ? [`- Avatar: ${sanitizeIdentityLine(avatar)}`] : []),
      "",
    ];
    await fs.appendFile(identityPath, lines.join("\n"), "utf-8");

    respond(true, { ok: true, agentId, name: rawName, workspace: workspaceDir }, undefined);
  },
  "agents.update": async ({ params, respond }) => {
    if (!validateAgentsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.update params: ${formatValidationErrors(
            validateAgentsUpdateParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const agentId = normalizeAgentId(String(params.agentId ?? ""));
    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) < 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
      );
      return;
    }

    const workspaceDir =
      typeof params.workspace === "string" && params.workspace.trim()
        ? resolveUserPath(params.workspace.trim())
        : undefined;

    const model = resolveOptionalStringParam(params.model);
    const avatar = resolveOptionalStringParam(params.avatar);

    const nextConfig = applyAgentConfig(cfg, {
      agentId,
      ...(typeof params.name === "string" && params.name.trim()
        ? { name: params.name.trim() }
        : {}),
      ...(workspaceDir ? { workspace: workspaceDir } : {}),
      ...(model ? { model } : {}),
    });

    await writeConfigFile(nextConfig);

    if (workspaceDir) {
      const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
      await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: !skipBootstrap });
    }

    if (avatar) {
      const workspace = workspaceDir ?? resolveAgentWorkspaceDir(nextConfig, agentId);
      await fs.mkdir(workspace, { recursive: true });
      const identityPath = path.join(workspace, DEFAULT_IDENTITY_FILENAME);
      await fs.appendFile(identityPath, `\n- Avatar: ${sanitizeIdentityLine(avatar)}\n`, "utf-8");
    }

    respond(true, { ok: true, agentId }, undefined);
  },
  "agents.delete": async ({ params, respond }) => {
    if (!validateAgentsDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.delete params: ${formatValidationErrors(
            validateAgentsDeleteParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const agentId = normalizeAgentId(String(params.agentId ?? ""));
    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" cannot be deleted`),
      );
      return;
    }
    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) < 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
      );
      return;
    }

    const deleteFiles = typeof params.deleteFiles === "boolean" ? params.deleteFiles : true;
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);
    const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

    const result = pruneAgentConfig(cfg, agentId);
    await writeConfigFile(result.config);

    if (deleteFiles) {
      await Promise.all([
        moveToTrashBestEffort(workspaceDir),
        moveToTrashBestEffort(agentDir),
        moveToTrashBestEffort(sessionsDir),
      ]);
    }

    respond(true, { ok: true, agentId, removedBindings: result.removedBindings }, undefined);
  },
  "agents.files.list": async ({ params, respond }) => {
    if (!validateAgentsFilesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.list params: ${formatValidationErrors(
            validateAgentsFilesListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveAgentIdOrError(String(params.agentId ?? ""), cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    let hideBootstrap = false;
    try {
      hideBootstrap = await isWorkspaceOnboardingCompleted(workspaceDir);
    } catch {
      // Fall back to showing BOOTSTRAP if workspace state cannot be read.
    }
    const files = await listAgentFiles(workspaceDir, { hideBootstrap });
    respond(true, { agentId, workspace: workspaceDir, files }, undefined);
  },
  "agents.files.get": async ({ params, respond }) => {
    if (!validateAgentsFilesGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.get params: ${formatValidationErrors(
            validateAgentsFilesGetParams.errors,
          )}`,
        ),
      );
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond);
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    const filePath = path.join(workspaceDir, name);
    const meta = await statFile(filePath);
    if (!meta) {
      respond(
        true,
        {
          agentId,
          workspace: workspaceDir,
          file: { name, path: filePath, missing: true },
        },
        undefined,
      );
      return;
    }
    const content = resolveVaultOps()
      ? ((await readVaultFile(name)) ?? "")
      : await fs.readFile(filePath, "utf-8");
    respond(
      true,
      {
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta.size,
          updatedAtMs: meta.updatedAtMs,
          content,
        },
      },
      undefined,
    );
  },
  "agents.files.set": async ({ params, respond }) => {
    if (!validateAgentsFilesSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.set params: ${formatValidationErrors(
            validateAgentsFilesSetParams.errors,
          )}`,
        ),
      );
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond);
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    const filePath = path.join(workspaceDir, name);
    const content = String(params.content ?? "");
    if (resolveVaultOps()) {
      await writeVaultFile(name, content);
    } else {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
    }
    const meta = await statFile(filePath);
    respond(
      true,
      {
        ok: true,
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta?.size,
          updatedAtMs: meta?.updatedAtMs,
          content,
        },
      },
      undefined,
    );
  },
  "agents.flow.test": async ({ params, respond }) => {
    if (!validateAgentsFlowTestParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.flow.test params: ${formatValidationErrors(
            validateAgentsFlowTestParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const agentId = resolveAgentIdOrError(String(params.agentId ?? ""), cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }

    const mode =
      typeof params.mode === "string" && params.mode.trim() ? params.mode.trim() : "dry_run";
    const syntheticCtx = buildSyntheticFlowTestContext({
      agentId,
      channel: String(params.channel ?? ""),
      message: String(params.message ?? ""),
      sender: typeof params.sender === "string" ? params.sender : undefined,
      senderE164: typeof params.senderE164 === "string" ? params.senderE164 : undefined,
      senderName: typeof params.senderName === "string" ? params.senderName : undefined,
      senderUsername: typeof params.senderUsername === "string" ? params.senderUsername : undefined,
      accountId: typeof params.accountId === "string" ? params.accountId : undefined,
      conversationId: typeof params.conversationId === "string" ? params.conversationId : undefined,
      to: typeof params.to === "string" ? params.to : undefined,
    });
    const prependContextOverride =
      typeof params.prependContextOverride === "string" ? params.prependContextOverride : undefined;

    const inboundPrependContext = await resolveInboundFlowTestPrependContext({
      ctx: syntheticCtx,
      agentId,
      prependContextOverride,
    });

    if (mode === "match_only") {
      respond(
        true,
        {
          ok: true,
          agentId,
          mode,
          inboundPrependContext,
          finalPayloads: [],
          blockPayloads: [],
          partialPayloads: [],
          toolStarts: [],
          toolResults: [],
          vaultMutations: [],
          messageActions: [],
        },
        undefined,
      );
      return;
    }

    const finalPayloads: ReplyPayload[] = [];
    const blockPayloads: ReplyPayload[] = [];
    const partialPayloads: ReplyPayload[] = [];
    const toolResults: ReplyPayload[] = [];
    const toolStarts: Array<{ name?: string; phase?: string }> = [];

    const runTest = async () => {
      recordFlowTestInput({
        channel: String(params.channel ?? ""),
        message: String(params.message ?? ""),
        sender: typeof params.sender === "string" ? params.sender : undefined,
        senderE164: typeof params.senderE164 === "string" ? params.senderE164 : undefined,
        senderName: typeof params.senderName === "string" ? params.senderName : undefined,
        senderUsername:
          typeof params.senderUsername === "string" ? params.senderUsername : undefined,
        accountId: typeof params.accountId === "string" ? params.accountId : undefined,
        conversationId:
          typeof params.conversationId === "string" ? params.conversationId : undefined,
        to: typeof params.to === "string" ? params.to : undefined,
        sessionKey: syntheticCtx.SessionKey,
        from: syntheticCtx.From,
      });
      const result = await dispatchInboundMessage({
        ctx: syntheticCtx,
        cfg,
        dispatcher: {
          sendToolResult: () => true,
          sendBlockReply: (payload) => {
            blockPayloads.push(payload);
            return true;
          },
          sendFinalReply: (payload) => {
            finalPayloads.push(payload);
            return true;
          },
          waitForIdle: async () => {},
          getQueuedCounts: () => ({
            tool: toolResults.length,
            block: blockPayloads.length,
            final: finalPayloads.length,
          }),
          markComplete: () => {},
        },
        replyOptions: {
          onPartialReply: (payload) => {
            partialPayloads.push(payload);
          },
          onToolResult: (payload) => {
            toolResults.push(payload);
          },
          onToolStart: (payload) => {
            toolStarts.push(payload);
          },
        },
        dispatchOptions: {
          prependContextOverride,
          skipBeforeInboundDispatchHooks: Boolean(prependContextOverride?.trim()),
        },
      });

      const capture = getFlowTestCaptureSnapshot();
      return {
        ok: true,
        agentId,
        mode,
        inboundPrependContext: result.inboundPrependContext ?? inboundPrependContext,
        counts: {
          ...result.counts,
          tool: toolResults.length,
          block: blockPayloads.length,
          final: finalPayloads.length,
        },
        finalPayloads,
        blockPayloads,
        partialPayloads,
        toolStarts,
        toolResults,
        input: capture?.input,
        promptSnapshot: capture?.promptSnapshot,
        modelSelections: capture?.modelSelections ?? [],
        systemPromptReport: capture?.systemPromptReport,
        toolCalls: capture?.toolCalls ?? [],
        vaultMutations: capture?.vaultMutations ?? [],
        messageActions: capture?.messageActions ?? [],
      };
    };

    try {
      const payload =
        mode === "apply"
          ? await withFlowTestContext({ mode: "apply" }, runTest)
          : await withFlowTestContext({ mode: "dry_run" }, runTest);
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
