import {
  TOOL_GROUPS,
  USER_FACING_TOOL_GROUPS,
  ALL_KNOWN_TOOLS,
  CHIEF_OF_STAFF_DENYLIST,
} from "../shared/tool-catalog.js";
import { type AnyAgentTool, wrapOwnerOnlyToolExecution } from "./tools/common.js";

export { TOOL_GROUPS, USER_FACING_TOOL_GROUPS, ALL_KNOWN_TOOLS, CHIEF_OF_STAFF_DENYLIST };

export type ToolProfileId =
  | "minimal"
  | "coding"
  | "messaging"
  | "full"
  | "chief-of-staff"
  | "software-engineer";

type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
  vault_apply_patch: "apply_patch",
  vault_agents_list: "agents_list",
  vault_sessions_list: "sessions_list",
  vault_sessions_history: "sessions_history",
  vault_sessions_send: "sessions_send",
  vault_sessions_spawn: "sessions_spawn",
  vault_subagents: "subagents",
  vault_session_status: "session_status",
};

const OWNER_ONLY_TOOL_NAME_FALLBACKS = new Set<string>(["whatsapp_login", "vault_cron", "gateway"]);

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
  "chief-of-staff": {
    deny: [...CHIEF_OF_STAFF_DENYLIST],
  },
  "software-engineer": {
    allow: ["group:developer", "group:github_api", "group:sessions", "image"],
    deny: [
      "group:vault_read",
      "group:vault_write",
      "group:vault_browser",
      "group:web",
      "group:messaging",
      "group:memory",
      "group:artifacts",
      "group:automation",
      "group:gmail",
      "group:runtime",
      "vault_cron",
      "gateway",
    ],
  },
};

export function normalizeToolName(name: string) {
  const normalized = name.trim().toLowerCase();
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function isOwnerOnlyToolName(name: string) {
  return OWNER_ONLY_TOOL_NAME_FALLBACKS.has(normalizeToolName(name));
}

function isOwnerOnlyTool(tool: AnyAgentTool) {
  return tool.ownerOnly === true || isOwnerOnlyToolName(tool.name);
}

export function applyOwnerOnlyToolPolicy(tools: AnyAgentTool[], senderIsOwner: boolean) {
  const withGuard = tools.map((tool) => {
    if (!isOwnerOnlyTool(tool)) {
      return tool;
    }
    return wrapOwnerOnlyToolExecution(tool, senderIsOwner);
  });
  if (senderIsOwner) {
    return withGuard;
  }
  return withGuard.filter((tool) => !isOwnerOnlyTool(tool));
}

export function normalizeToolList(list?: string[]) {
  if (!list) {
    return [];
  }
  return list.map(normalizeToolName).filter(Boolean);
}

export type ToolPolicyLike = {
  allow?: string[];
  deny?: string[];
};

export type PluginToolGroups = {
  all: string[];
  byPlugin: Map<string, string[]>;
};

export type AllowlistResolution = {
  policy: ToolPolicyLike | undefined;
  unknownAllowlist: string[];
  strippedAllowlist: boolean;
};

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

export function collectExplicitAllowlist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.allow) {
      continue;
    }
    for (const value of policy.allow) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
    }
  }
  return entries;
}

export function buildPluginToolGroups<T extends { name: string }>(params: {
  tools: T[];
  toolMeta: (tool: T) => { pluginId: string } | undefined;
}): PluginToolGroups {
  const all: string[] = [];
  const byPlugin = new Map<string, string[]>();
  for (const tool of params.tools) {
    const meta = params.toolMeta(tool);
    if (!meta) {
      continue;
    }
    const name = normalizeToolName(tool.name);
    all.push(name);
    const pluginId = meta.pluginId.toLowerCase();
    const list = byPlugin.get(pluginId) ?? [];
    list.push(name);
    byPlugin.set(pluginId, list);
  }
  return { all, byPlugin };
}

export function expandPluginGroups(
  list: string[] | undefined,
  groups: PluginToolGroups,
): string[] | undefined {
  if (!list || list.length === 0) {
    return list;
  }
  const expanded: string[] = [];
  for (const entry of list) {
    const normalized = normalizeToolName(entry);
    if (normalized === "group:plugins") {
      if (groups.all.length > 0) {
        expanded.push(...groups.all);
      } else {
        expanded.push(normalized);
      }
      continue;
    }
    const tools = groups.byPlugin.get(normalized);
    if (tools && tools.length > 0) {
      expanded.push(...tools);
      continue;
    }
    expanded.push(normalized);
  }
  return Array.from(new Set(expanded));
}

export function expandPolicyWithPluginGroups(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
): ToolPolicyLike | undefined {
  if (!policy) {
    return undefined;
  }
  return {
    allow: expandPluginGroups(policy.allow, groups),
    deny: expandPluginGroups(policy.deny, groups),
  };
}

export function stripPluginOnlyAllowlist(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
  coreTools: Set<string>,
): AllowlistResolution {
  if (!policy?.allow || policy.allow.length === 0) {
    return { policy, unknownAllowlist: [], strippedAllowlist: false };
  }
  const normalized = normalizeToolList(policy.allow);
  if (normalized.length === 0) {
    return { policy, unknownAllowlist: [], strippedAllowlist: false };
  }
  const pluginIds = new Set(groups.byPlugin.keys());
  const pluginTools = new Set(groups.all);
  const unknownAllowlist: string[] = [];
  let hasCoreEntry = false;
  for (const entry of normalized) {
    if (entry === "*") {
      hasCoreEntry = true;
      continue;
    }
    const isPluginEntry =
      entry === "group:plugins" || pluginIds.has(entry) || pluginTools.has(entry);
    const expanded = expandToolGroups([entry]);
    const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
    if (isCoreEntry) {
      hasCoreEntry = true;
    }
    if (!isCoreEntry && !isPluginEntry) {
      unknownAllowlist.push(entry);
    }
  }
  const strippedAllowlist = !hasCoreEntry;
  // When an allowlist contains only plugin tools, we strip it to avoid accidentally
  // disabling core tools. Users who want additive behavior should prefer `tools.alsoAllow`.
  if (strippedAllowlist) {
    // Note: logging happens in the caller (pi-tools/tools-invoke) after this function returns.
    // We keep this note here for future maintainers.
  }
  return {
    policy: strippedAllowlist ? { ...policy, allow: undefined } : policy,
    unknownAllowlist: Array.from(new Set(unknownAllowlist)),
    strippedAllowlist,
  };
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

export function mergeAlsoAllowPolicy<TPolicy extends { allow?: string[] }>(
  policy: TPolicy | undefined,
  alsoAllow?: string[],
): TPolicy | undefined {
  if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) {
    return policy;
  }
  return { ...policy, allow: Array.from(new Set([...policy.allow, ...alsoAllow])) };
}
