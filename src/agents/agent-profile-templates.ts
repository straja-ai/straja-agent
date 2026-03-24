/**
 * Agent profile templates for multi-agent workspace support.
 *
 * Each profile defines a role with specific tool access and execution model.
 * The vault uses this metadata for UI display and auto-pairing.
 */

import type { ToolProfileId } from "../config/types.tools.js";

export type AgentProfileId = "chief-of-staff" | "software-engineer" | "custom";

export interface AgentProfileMeta {
  id: AgentProfileId;
  label: string;
  description: string;
  /** Human-readable capability summary for UI cards. */
  capabilities: string[];
  /** Maps to TOOL_PROFILES entry in tool-policy.ts. Undefined for "custom". */
  toolProfile?: ToolProfileId;
  /** SE agents get network access (through domain-filtered proxy). */
  allowsNetwork?: boolean;
  /** Default network allowlist domains for this profile. */
  defaultNetworkAllowlist?: string[];
}

export const AGENT_PROFILES: AgentProfileMeta[] = [
  {
    id: "chief-of-staff",
    label: "Chief of Staff",
    description:
      "General knowledge work, scheduling, drafting, research, reports, browser tasks, coordination.",
    capabilities: [
      "Web search & browse",
      "Notes, artifacts & reports",
      "GitHub (issues, PRs, push)",
      "Gmail drafts",
      "Memory, collections & spreadsheets",
    ],
    toolProfile: "chief-of-staff",
  },
  {
    id: "software-engineer",
    label: "Software Engineer",
    description:
      "Repo-focused coding with real git, npm, and build tools. Works against shared repos under ~/.straja/repos/.",
    capabilities: [
      "Repo execution (git, npm, build, test)",
      "GitHub (issues, PRs, push)",
      "Session management",
    ],
    toolProfile: "software-engineer",
    allowsNetwork: true,
    defaultNetworkAllowlist: ["github.com", "api.github.com", "registry.npmjs.org"],
  },
];

/** Look up profile metadata by id. Returns undefined for "custom". */
export function getAgentProfile(id: AgentProfileId): AgentProfileMeta | undefined {
  return AGENT_PROFILES.find((p) => p.id === id);
}

/** All profile ids including "custom". */
export const ALL_PROFILE_IDS: AgentProfileId[] = ["chief-of-staff", "software-engineer", "custom"];
