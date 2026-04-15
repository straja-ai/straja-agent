import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { safeJsonStringify } from "../../utils/safe-json.js";
import { withVaultAuthRequestInit } from "../../vault-auth.js";
import type { FinalizedMsgContext } from "../templating.js";
import type {
  OrchestrationAgentCandidate,
  OrchestrationRouterDecision,
  OrchestrationToolFamily,
} from "./orchestration-router.js";

const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");

type SearchResult = {
  title: string;
  file: string;
  score: number;
  snippet: string;
};

export type OrchestrationPacket = {
  selectedAgentId: string;
  selectedAgentReason: string;
  agentCandidates: OrchestrationAgentCandidate[];
  toolAllowlist: string[];
  memoryResults: SearchResult[];
  vaultResults: SearchResult[];
  packetText: string;
};

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

async function queryVault(params: {
  query: string;
  collections?: string[];
  limit: number;
}): Promise<SearchResult[]> {
  const baseUrl = resolveVaultBaseUrl();
  if (!baseUrl || !params.query.trim()) {
    return [];
  }
  const payload: Record<string, unknown> = {
    searches: [
      { type: "lex", query: params.query },
      { type: "vec", query: params.query },
      { type: "hyde", query: params.query },
    ],
    limit: params.limit,
  };
  if (params.collections?.length) {
    payload.collections = params.collections;
  }
  try {
    const resp = await fetch(
      `${baseUrl}/query`,
      withVaultAuthRequestInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4_000),
      }),
    );
    if (!resp.ok) {
      return [];
    }
    const data = (await resp.json()) as { results?: SearchResult[] };
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    logVerbose(`orchestration packet vault query failed: ${String(err)}`);
    return [];
  }
}

export function resolveToolAllowlist(params: {
  body: string;
  localFastPath: boolean;
  toolFamily: OrchestrationToolFamily;
  flowContextCount?: number;
}): string[] {
  const normalized = params.body.toLowerCase();
  if (params.localFastPath || params.toolFamily === "local_automation") {
    const baseTools = [
      "vault_search",
      "vault_get",
      "vault_memory_search",
      "vault_memory_get",
      "vault_memory_write",
      "vault_note_create",
      "vault_note_update",
      "vault_collection_write",
      "vault_spreadsheet_get",
      "vault_spreadsheet_match",
      "vault_spreadsheet_update",
    ];
    if ((params.flowContextCount ?? 0) > 0) {
      return ["message", ...baseTools];
    }
    return baseTools;
  }
  if (
    params.toolFamily === "coding" ||
    /\b(code|coding|bug|repo|repository|fix|implement)\b/.test(normalized)
  ) {
    return [
      "message",
      "vault_search",
      "vault_get",
      "vault_memory_search",
      "vault_memory_get",
      "vault_read",
      "vault_write",
      "vault_edit",
      "vault_apply_patch",
      "vault_repo_exec",
      "vault_note_create",
      "vault_note_update",
    ];
  }
  if (
    params.toolFamily === "research" ||
    /\b(research|search|find|compare|investigate|analyze|analysis|web)\b/.test(normalized)
  ) {
    return [
      "message",
      "vault_search",
      "vault_get",
      "vault_memory_search",
      "vault_memory_get",
      "vault_web_search_duckduckgo",
      "vault_web_fetch",
      "vault_note_create",
      "vault_note_update",
      "vault_report_build",
    ];
  }
  if (params.toolFamily === "email" || /\b(email|draft|gmail)\b/.test(normalized)) {
    return [
      "message",
      "vault_search",
      "vault_get",
      "vault_memory_search",
      "vault_memory_get",
      "vault_gmail_create_draft",
      "vault_gmail_update_draft",
      "vault_note_create",
      "vault_note_update",
    ];
  }
  if (
    params.toolFamily === "presentation" ||
    /\b(slides|presentation|deck|report|artifact)\b/.test(normalized)
  ) {
    return [
      "message",
      "vault_search",
      "vault_get",
      "vault_memory_search",
      "vault_memory_get",
      "vault_presentation_build",
      "vault_report_build",
      "vault_artifact_write",
      "vault_note_create",
    ];
  }
  return [
    "message",
    "vault_search",
    "vault_get",
    "vault_memory_search",
    "vault_memory_get",
    "vault_note_create",
    "vault_note_update",
    "vault_collection_write",
  ];
}

export async function buildOrchestrationPacket(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  body: string;
  currentAgentId?: string;
  localFastPath: boolean;
  routerDecision?: OrchestrationRouterDecision;
}): Promise<OrchestrationPacket> {
  const flowContext = Array.isArray(params.ctx.FlowContext) ? params.ctx.FlowContext : [];
  const selection = params.routerDecision ?? {
    selectedAgentId: params.currentAgentId ?? "main",
    selectedAgentReason: "router decision unavailable; kept current agent",
    candidates: [] as OrchestrationAgentCandidate[],
    taskClass: "general_agent_turn" as const,
    toolFamily: params.localFastPath ? "local_automation" : "general",
    memoryQuery: params.body,
    vaultQuery: params.body,
    reasons: ["router decision unavailable"],
  };
  const shouldQueryVault =
    params.localFastPath ||
    flowContext.length > 0 ||
    selection.toolFamily !== "general" ||
    selection.taskClass !== "general_agent_turn";
  const memoryResults = shouldQueryVault
    ? await queryVault({
        query: selection.memoryQuery,
        collections: ["_memory"],
        limit: params.localFastPath ? 3 : 4,
      })
    : [];
  const vaultResults = shouldQueryVault
    ? await queryVault({
        query: selection.vaultQuery,
        limit: params.localFastPath ? 3 : 5,
      })
    : [];
  const toolAllowlist = resolveToolAllowlist({
    body: params.body,
    localFastPath: params.localFastPath,
    toolFamily: selection.toolFamily,
    flowContextCount: flowContext.length,
  });

  const packet = {
    selectedAgentId: selection.selectedAgentId,
    selectedAgentReason: selection.selectedAgentReason,
    toolAllowlist,
    memoryResults: memoryResults.slice(0, params.localFastPath ? 2 : 3),
    vaultResults: vaultResults
      .filter((entry) => !entry.file.startsWith("_memory/"))
      .slice(0, params.localFastPath ? 2 : 3),
    flowContext: flowContext.slice(0, 3),
  };

  const packetText = [
    "## Context Packet",
    `Selected agent: ${packet.selectedAgentId}`,
    `Why: ${packet.selectedAgentReason}`,
    `Router tool family: ${selection.toolFamily}`,
    `Router reasons: ${selection.reasons.join("; ") || "none"}`,
    `Tool allowlist: ${packet.toolAllowlist.join(", ")}`,
    packet.flowContext.length > 0
      ? `Flow context:\n${packet.flowContext.map((entry, index) => `[${index + 1}] ${entry}`).join("\n\n")}`
      : null,
    packet.memoryResults.length > 0
      ? `Memory hits:\n${packet.memoryResults
          .map((entry, index) => `[${index + 1}] ${entry.file} (${entry.score})\n${entry.snippet}`)
          .join("\n\n")}`
      : "Memory hits: none",
    packet.vaultResults.length > 0
      ? `Vault hits:\n${packet.vaultResults
          .map((entry, index) => `[${index + 1}] ${entry.file} (${entry.score})\n${entry.snippet}`)
          .join("\n\n")}`
      : "Vault hits: none",
  ]
    .filter(Boolean)
    .join("\n\n");

  logVerbose(
    `orchestration packet: agent=${packet.selectedAgentId} tools=${packet.toolAllowlist.join(",")} packet=${safeJsonStringify(
      {
        memoryResults: packet.memoryResults.length,
        vaultResults: packet.vaultResults.length,
        toolFamily: selection.toolFamily,
      },
    )}`,
  );

  return {
    selectedAgentId: packet.selectedAgentId,
    selectedAgentReason: packet.selectedAgentReason,
    agentCandidates: selection.candidates,
    toolAllowlist: packet.toolAllowlist,
    memoryResults: packet.memoryResults,
    vaultResults: packet.vaultResults,
    packetText,
  };
}
