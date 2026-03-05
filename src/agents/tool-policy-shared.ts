export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
  vault_agents_list: "agents_list",
  vault_sessions_list: "sessions_list",
  vault_sessions_history: "sessions_history",
  vault_sessions_send: "sessions_send",
  vault_sessions_spawn: "sessions_spawn",
  vault_subagents: "subagents",
  vault_session_status: "session_status",
};

export const TOOL_GROUPS: Record<string, string[]> = {
  // NOTE: Keep canonical (lowercase) tool names here.
  "group:memory": ["memory_search", "memory_get", "vault_memory_search", "vault_memory_get"],
  "group:web": ["web_search", "web_fetch", "vault_web_search_duckduckgo"],
  // Basic workspace/file tools
  "group:fs": ["read", "write", "edit", "apply_patch"],
  // Host/runtime execution tools
  "group:runtime": ["exec", "process"],
  // Session management tools
  "group:sessions": [
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "subagents",
    "session_status",
  ],
  // UI helpers
  "group:ui": ["browser", "canvas"],
  // Artifact creation tools
  "group:artifacts": [
    "vault_artifact_write",
    "vault_artifact_list",
    "vault_presentation_build",
    "vault_report_build",
    "vault_artifact_url",
  ],
  // Automation + infra
  "group:automation": ["vault_cron", "gateway"],
  // Messaging surface
  "group:messaging": ["message"],
  // Nodes + device tools
  "group:nodes": ["nodes"],
  // All OpenClaw native tools (excludes provider plugins).
  "group:openclaw": [
    "browser",
    "canvas",
    "nodes",
    "vault_cron",
    "message",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "subagents",
    "session_status",
    "memory_search",
    "memory_get",
    "web_search",
    "web_fetch",
    "image",
  ],
};

const TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: ["session_status"],
  },
  coding: {
    allow: ["group:fs", "group:runtime", "group:sessions", "group:memory", "image"],
  },
  messaging: {
    allow: [
      "group:messaging",
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "session_status",
    ],
  },
  full: {},
};

export function normalizeToolName(name: string) {
  const normalized = name.trim().toLowerCase();
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function normalizeToolList(list?: string[]) {
  if (!list) {
    return [];
  }
  return list.map(normalizeToolName).filter(Boolean);
}

export function expandToolGroups(list?: string[]) {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = TOOL_GROUPS[value];
    if (group) {
      expanded.push(...group);
      continue;
    }
    expanded.push(value);
  }
  return Array.from(new Set(expanded));
}

export function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  const resolved = TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved) {
    return undefined;
  }
  if (!resolved.allow && !resolved.deny) {
    return undefined;
  }
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}
