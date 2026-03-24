import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (Tooling, Workspace, Runtime) - used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";

function buildGroupedToolingLines(params: {
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
  summarizeTool: (normalized: string) => string | undefined;
}) {
  const groups: Array<{ title: string; tools: string[] }> = [
    {
      title: "Core",
      tools: ["message", "gateway", "agents_list", "nodes", "image", "vault_cron"],
    },
    {
      title: "Sessions & Delegation",
      tools: [
        "sessions_list",
        "sessions_history",
        "sessions_send",
        "sessions_spawn",
        "subagents",
        "session_status",
      ],
    },
    {
      title: "Vault Knowledge",
      tools: ["vault_search", "vault_get", "vault_multi_get", "vault_status"],
    },
    {
      title: "Vault Memory",
      tools: ["vault_memory_search", "vault_memory_get", "vault_memory_write"],
    },
    {
      title: "Notes & Collections",
      tools: [
        "vault_note_create",
        "vault_note_update",
        "vault_agent_collection_create",
        "vault_agent_collection_write",
        "vault_collection_write",
        "vault_agent_collection_list",
      ],
    },
    {
      title: "Spreadsheets",
      tools: ["vault_spreadsheet_get", "vault_spreadsheet_match", "vault_spreadsheet_update"],
    },
    {
      title: "Artifacts & Deliverables",
      tools: [
        "vault_artifact_write",
        "vault_artifact_list",
        "vault_artifact_url",
        "vault_report_build",
        "vault_presentation_build",
      ],
    },
    {
      title: "Calendar & Mail",
      tools: [
        "vault_gcalendar_create_event",
        "vault_gcalendar_update_event",
        "vault_gcalendar_delete_event",
        "vault_gmail_create_draft",
        "vault_gmail_update_draft",
      ],
    },
    {
      title: "Web & Browser",
      tools: [
        "vault_web_search_duckduckgo",
        "vault_web_fetch",
        "vault_approve_domain",
        "vault_browser_navigate",
        "vault_browser_snapshot",
        "vault_browser_click",
        "vault_browser_type",
        "vault_browser_fill",
        "vault_browser_select",
        "vault_browser_hover",
        "vault_browser_press_key",
        "vault_browser_screenshot",
        "vault_browser_tab_list",
        "vault_browser_tab_new",
        "vault_browser_tab_close",
        "vault_browser_tabs",
        "vault_browser_pdf",
        "vault_browser_dialog",
        "vault_browser_upload",
        "vault_browser_status",
        "vault_browser_start",
        "vault_browser_stop",
        "vault_browser_console",
        "vault_browser_wait",
      ],
    },
    {
      title: "Developer & GitHub",
      tools: [
        "vault_repo_exec",
        "vault_repos_list",
        "vault_process",
        "vault_github_create_issue",
        "vault_github_list_issues",
        "vault_github_create_branch",
        "vault_github_create_pr",
        "vault_github_list_prs",
        "vault_github_push",
      ],
    },
  ];

  const lines: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const present = group.tools.filter((tool) => params.availableTools.has(tool));
    if (present.length === 0) {
      continue;
    }
    lines.push(`### ${group.title}`);
    for (const tool of present) {
      seen.add(tool);
      const name = params.resolveToolName(tool);
      const summary = params.summarizeTool(tool);
      lines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
    }
    lines.push("");
  }

  const extras = Array.from(params.availableTools)
    .filter((tool) => !seen.has(tool))
    .toSorted();
  if (extras.length > 0) {
    lines.push("### Other");
    for (const tool of extras) {
      const name = params.resolveToolName(tool);
      const summary = params.summarizeTool(tool);
      lines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
    }
    lines.push("");
  }

  return lines;
}

function buildSkillsSection(params: {
  skillsPrompt?: string;
  isMinimal: boolean;
  readToolName?: string;
}) {
  if (params.isMinimal) {
    return [];
  }
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed || !params.readToolName) {
    return [];
  }
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    trimmed,
    "",
  ];
}

function buildMemorySection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) {
  if (params.isMinimal) {
    return [];
  }
  if (
    !params.availableTools.has("memory_search") &&
    !params.availableTools.has("memory_get") &&
    !params.availableTools.has("vault_memory_search") &&
    !params.availableTools.has("vault_memory_get")
  ) {
    return [];
  }
  const searchTool = params.availableTools.has("vault_memory_search")
    ? "vault_memory_search"
    : "memory_search";
  const getTool = params.availableTools.has("vault_memory_get") ? "vault_memory_get" : "memory_get";
  const writeTool = params.availableTools.has("vault_memory_write")
    ? "vault_memory_write"
    : "memory_write";
  const hasVaultSearch = params.availableTools.has("vault_search");
  const lines = [
    "## Memory Recall",
    `You have persistent memory stored in a vault. Before answering ANY question about your name, identity, prior work, decisions, dates, people, user preferences, project details, or todos: ALWAYS run ${searchTool} first; then use ${getTool} to pull only the needed lines. When in doubt about whether something was discussed before, search first.${hasVaultSearch ? ` If memory search returns no results, ALSO run vault_search to check notes, documents, and other collections — the information may be stored outside of memory.` : ""} If low confidence after search, say you checked.`,
    "",
    "## Memory Persistence",
    `When the user shares important personal information (their name, preferences, project details, decisions, or anything they'd expect you to remember next time), ALWAYS save it using ${writeTool} to path "MEMORY.md" with append: true. This ensures you remember it in future sessions. Do not wait to be asked — proactively persist facts the user would want recalled later.`,
  ];
  if (params.availableTools.has("vault_gmail_create_draft")) {
    const hasUpdate = params.availableTools.has("vault_gmail_update_draft");
    lines.push(
      "",
      "## Gmail Drafts",
      "You can create Gmail draft emails using vault_gmail_create_draft. The draft is saved in the user's Gmail Drafts folder for them to review and send.",
      ...(hasUpdate
        ? [
            "Use vault_gmail_update_draft to revise a draft if the user requests changes (pass the Draft ID from the create result).",
          ]
        : []),
      "For replies to emails found in the vault: use the message_id field as inReplyTo and the thread_id field as threadId from the vault email document to correctly thread the reply.",
      "Always confirm with the user before creating a draft. Never send emails directly — only create drafts.",
    );
  }
  if (params.citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
}

function buildVaultKnowledgeSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
}) {
  if (params.isMinimal) {
    return [];
  }
  if (!params.availableTools.has("vault_search")) {
    return [];
  }
  const toolNames = [
    params.resolveToolName("vault_search"),
    params.resolveToolName("vault_get"),
    ...(params.availableTools.has("vault_multi_get")
      ? [params.resolveToolName("vault_multi_get")]
      : []),
    ...(params.availableTools.has("vault_status") ? [params.resolveToolName("vault_status")] : []),
  ];
  return [
    "## Vault Knowledge Search",
    `Core tools: ${toolNames.join(", ")}.`,
    "You have access to a document vault containing imported emails, documents, books, notes, and other user data sources.",
    "When the user asks about information that could be in their own documents, notes, collections, student records, or emails, use vault_search to find relevant content. Then use vault_get to read the full document if needed.",
    ...(params.availableTools.has("vault_multi_get")
      ? [
          "Use vault_multi_get when you already have several relevant hits and need to inspect multiple documents together.",
        ]
      : []),
    ...(params.availableTools.has("vault_status")
      ? [
          "Use vault_status to check vault readiness or health before concluding that the vault is unavailable.",
        ]
      : []),
    "Prefer vault_search over external tools and general reasoning when the answer is likely in the user's own data.",
    "If the user explicitly says to search the vault, collections, notes, student records, or documents, do not use exec, vault_exec, or repo-exec as the first lookup step.",
    "Do not delegate vault or collection retrieval to software-engineer or other subagents. Handle vault_search, vault_get, spreadsheet lookup, notes, and collection inspection directly unless the user explicitly asks for repo/code work.",
    "Do not claim the information is unavailable until you have actually tried vault_search (and vault_get if there are relevant hits).",
    "",
  ];
}

function buildVaultCollectionsSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
}) {
  if (params.isMinimal) {
    return [];
  }
  const noteTools = [
    ...(params.availableTools.has("vault_note_create")
      ? [params.resolveToolName("vault_note_create")]
      : []),
    ...(params.availableTools.has("vault_note_update")
      ? [params.resolveToolName("vault_note_update")]
      : []),
  ];
  const collectionTools = [
    ...(params.availableTools.has("vault_agent_collection_create")
      ? [params.resolveToolName("vault_agent_collection_create")]
      : []),
    ...(params.availableTools.has("vault_agent_collection_write")
      ? [params.resolveToolName("vault_agent_collection_write")]
      : []),
    ...(params.availableTools.has("vault_collection_write")
      ? [params.resolveToolName("vault_collection_write")]
      : []),
    ...(params.availableTools.has("vault_agent_collection_list")
      ? [params.resolveToolName("vault_agent_collection_list")]
      : []),
  ];
  if (noteTools.length === 0 && collectionTools.length === 0) {
    return [];
  }
  const lines = ["## Vault Notes & Collections"];
  if (noteTools.length > 0) {
    lines.push(`Note tools: ${noteTools.join(", ")}.`);
    lines.push(
      "Use note tools for standalone notes and markdown-like records that belong in the vault note space rather than a spreadsheet or artifact.",
    );
  }
  if (collectionTools.length > 0) {
    lines.push(`Collection tools: ${collectionTools.join(", ")}.`);
    lines.push(
      "Use vault_collection_write to create or update normal collection documents at an explicit collection path.",
    );
    lines.push(
      "Use vault_agent_collection_create, vault_agent_collection_write, and vault_agent_collection_list only for agent-owned collections and their structured documents.",
    );
  }
  lines.push(
    "Prefer collection and note tools over inventing file-system paths or asking the user to upload data that is already in the vault.",
  );
  lines.push("");
  return lines;
}

function buildVaultArtifactsSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
}) {
  if (params.isMinimal) {
    return [];
  }
  const tools = [
    ...(params.availableTools.has("vault_artifact_write")
      ? [params.resolveToolName("vault_artifact_write")]
      : []),
    ...(params.availableTools.has("vault_artifact_list")
      ? [params.resolveToolName("vault_artifact_list")]
      : []),
    ...(params.availableTools.has("vault_artifact_url")
      ? [params.resolveToolName("vault_artifact_url")]
      : []),
    ...(params.availableTools.has("vault_report_build")
      ? [params.resolveToolName("vault_report_build")]
      : []),
    ...(params.availableTools.has("vault_presentation_build")
      ? [params.resolveToolName("vault_presentation_build")]
      : []),
  ];
  if (tools.length === 0) {
    return [];
  }
  return [
    "## Vault Artifacts",
    `Artifact tools: ${tools.join(", ")}.`,
    "Use vault_artifact_write to store source specs or supporting assets in the vault artifact space.",
    ...(params.availableTools.has("vault_artifact_list")
      ? [
          "Use vault_artifact_list to inspect what deliverables or generated files already exist before creating duplicates.",
        ]
      : []),
    ...(params.availableTools.has("vault_artifact_url")
      ? [
          "Use vault_artifact_url to turn a vault artifact into a user-deliverable link instead of exposing internal vault paths.",
        ]
      : []),
    "",
  ];
}

function buildVaultSpreadsheetsSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
}) {
  if (params.isMinimal) {
    return [];
  }
  const tools = [
    ...(params.availableTools.has("vault_spreadsheet_get")
      ? [params.resolveToolName("vault_spreadsheet_get")]
      : []),
    ...(params.availableTools.has("vault_spreadsheet_match")
      ? [params.resolveToolName("vault_spreadsheet_match")]
      : []),
    ...(params.availableTools.has("vault_spreadsheet_update")
      ? [params.resolveToolName("vault_spreadsheet_update")]
      : []),
  ];
  if (tools.length === 0) {
    return [];
  }
  const lines = ["## Vault Spreadsheets", `Spreadsheet tools: ${tools.join(", ")}.`];
  if (params.availableTools.has("vault_spreadsheet_get")) {
    lines.push(
      "Use vault_spreadsheet_get to inspect a spreadsheet-backed document before summarizing or editing it.",
    );
  }
  if (params.availableTools.has("vault_spreadsheet_match")) {
    lines.push(
      "Use vault_spreadsheet_match to find rows by names, phone numbers, ids, or other structured values instead of relying on free-text search.",
    );
  }
  if (params.availableTools.has("vault_spreadsheet_update")) {
    lines.push(
      "Use vault_spreadsheet_update for spreadsheet-backed mutations so the structured document and regenerated spreadsheet stay in sync.",
    );
  }
  lines.push(
    "Prefer spreadsheet tools over generic collection writes when the source document is spreadsheet-backed.",
  );
  lines.push("");
  return lines;
}

function buildVaultCalendarSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
}) {
  if (params.isMinimal) {
    return [];
  }
  const tools = [
    ...(params.availableTools.has("vault_gcalendar_create_event")
      ? [params.resolveToolName("vault_gcalendar_create_event")]
      : []),
    ...(params.availableTools.has("vault_gcalendar_update_event")
      ? [params.resolveToolName("vault_gcalendar_update_event")]
      : []),
    ...(params.availableTools.has("vault_gcalendar_delete_event")
      ? [params.resolveToolName("vault_gcalendar_delete_event")]
      : []),
  ];
  if (tools.length === 0) {
    return [];
  }
  return [
    "## Vault Calendar",
    `Calendar tools: ${tools.join(", ")}.`,
    "Use calendar tools for real schedule changes, not just for discussing dates in chat.",
    "Confirm destructive calendar changes when deleting or materially altering an event unless the user has already asked for that exact change.",
    "",
  ];
}

function buildVaultAutomationSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
}) {
  if (params.isMinimal || !params.availableTools.has("vault_cron")) {
    return [];
  }
  return [
    "## Vault Automation",
    `Automation tool: ${params.resolveToolName("vault_cron")}.`,
    "Use vault_cron for reminders, delayed follow-ups, recurring checks, and scheduled wakeups.",
    "When scheduling a reminder, write the reminder text so it reads naturally when it fires; include enough context for the future message to make sense on its own.",
    "",
  ];
}

function buildVaultBrowserSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
}) {
  if (params.isMinimal) {
    return [];
  }
  const browserTools = Array.from(params.availableTools)
    .filter((tool) => tool.startsWith("vault_browser_"))
    .toSorted()
    .map((tool) => params.resolveToolName(tool));
  const uploadStageTools = params.availableTools.has("vault_stage_media_upload")
    ? [params.resolveToolName("vault_stage_media_upload")]
    : [];
  const approvalTools = params.availableTools.has("vault_approve_domain")
    ? [params.resolveToolName("vault_approve_domain")]
    : [];
  if (browserTools.length === 0 && approvalTools.length === 0 && uploadStageTools.length === 0) {
    return [];
  }
  return [
    "## Vault Browser & Domain Approval",
    ...(approvalTools.length > 0 ? [`Approval tools: ${approvalTools.join(", ")}.`] : []),
    ...(uploadStageTools.length > 0
      ? [`Upload staging tools: ${uploadStageTools.join(", ")}.`]
      : []),
    ...(browserTools.length > 0 ? [`Browser tools: ${browserTools.join(", ")}.`] : []),
    ...(approvalTools.length > 0
      ? [
          "Use vault_approve_domain when a web fetch or browser task is blocked on domain approval instead of failing silently or asking the user for raw URLs again.",
        ]
      : []),
    ...(uploadStageTools.length > 0
      ? [
          "If an image or file comes from inbound vault media (for example a Telegram photo exposed as a vault /media URL), stage it into '_uploads' with vault_stage_media_upload before relying on browser upload.",
          "If the source is already a vault /media URL, vault_browser_upload can also auto-stage it, but explicit staging is preferred when you want a reusable upload path.",
        ]
      : []),
    ...(browserTools.length > 0
      ? [
          "Use vault browser tools for interactive navigation, forms, JS-rendered pages, screenshots, uploads, dialogs, downloads, and tab control.",
        ]
      : []),
    "",
  ];
}

function buildUserIdentitySection(ownerLine: string | undefined, isMinimal: boolean) {
  if (!ownerLine || isMinimal) {
    return [];
  }
  return ["## User Identity", ownerLine, ""];
}

function buildTimeSection(params: { userTimezone?: string }) {
  if (!params.userTimezone) {
    return [];
  }
  return ["## Current Date & Time", `Time zone: ${params.userTimezone}`, ""];
}

function buildReplyTagsSection(isMinimal: boolean) {
  if (isMinimal) {
    return [];
  }
  return [
    "## Reply Tags",
    "To request a native reply/quote on supported surfaces, include one tag in your reply:",
    "- Reply tags must be the very first token in the message (no leading text/newlines): [[reply_to_current]] your reply.",
    "- [[reply_to_current]] replies to the triggering message.",
    "- Prefer [[reply_to_current]]. Use [[reply_to:<id>]] only when an id was explicitly provided (e.g. by the user or a tool).",
    "Whitespace inside the tag is allowed (e.g. [[ reply_to_current ]] / [[ reply_to: 123 ]]).",
    "Tags are stripped before sending; support depends on the current channel config.",
    "",
  ];
}

function buildMessagingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  messageChannelOptions: string;
  inlineButtonsEnabled: boolean;
  runtimeChannel?: string;
  messageToolHints?: string[];
}) {
  if (params.isMinimal) {
    return [];
  }
  const crossSessionSendTool = params.availableTools.has("vault_sessions_send")
    ? "vault_sessions_send"
    : params.availableTools.has("sessions_send")
      ? "sessions_send"
      : null;
  const subagentsTool = params.availableTools.has("vault_subagents")
    ? "vault_subagents"
    : params.availableTools.has("subagents")
      ? "subagents"
      : null;
  return [
    "## Messaging",
    "- Reply in current session → automatically routes to the source channel (Signal, Telegram, etc.)",
    crossSessionSendTool
      ? `- Cross-session messaging → use ${crossSessionSendTool}(sessionKey, message)`
      : "",
    subagentsTool ? `- Sub-agent orchestration → use ${subagentsTool}(action=list|steer|kill)` : "",
    "- `[System Message] ...` blocks are internal context and are not user-visible by default.",
    `- If a \`[System Message]\` reports completed cron/subagent work and asks for a user update, rewrite it in your normal assistant voice and send that update (do not forward raw system text or default to ${SILENT_REPLY_TOKEN}).`,
    "- Never use exec/curl for provider messaging; Straja handles all routing internally.",
    params.availableTools.has("message")
      ? [
          "",
          "### message tool",
          "- Use `message` for proactive sends + channel actions (polls, reactions, etc.).",
          "- For `action=send`, include `to` and `message`.",
          `- If multiple channels are configured, pass \`channel\` (${params.messageChannelOptions}).`,
          `- If you use \`message\` (\`action=send\`) to deliver your user-visible reply, respond with ONLY: ${SILENT_REPLY_TOKEN} (avoid duplicate replies).`,
          params.inlineButtonsEnabled
            ? "- Inline buttons supported. Use `action=send` with `buttons=[[{text,callback_data,style?}]]`; `style` can be `primary`, `success`, or `danger`."
            : params.runtimeChannel
              ? `- Inline buttons not enabled for ${params.runtimeChannel}. If you need them, ask to set ${params.runtimeChannel}.capabilities.inlineButtons ("dm"|"group"|"all"|"allowlist").`
              : "",
          ...(params.messageToolHints ?? []),
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
  ];
}

function buildVoiceSection(params: { isMinimal: boolean; ttsHint?: string }) {
  if (params.isMinimal) {
    return [];
  }
  const hint = params.ttsHint?.trim();
  if (!hint) {
    return [];
  }
  return ["## Voice (TTS)", hint, ""];
}

function buildDocsSection(params: {
  docsPath?: string;
  isMinimal: boolean;
  readToolName?: string;
}) {
  const docsPath = params.docsPath?.trim();
  if (!docsPath || params.isMinimal || !params.readToolName) {
    return [];
  }
  return [
    "## Documentation",
    `Straja docs: ${docsPath}`,
    "Mirror: https://docs.openclaw.ai",
    "Source: https://github.com/openclaw/openclaw",
    "Community: https://discord.com/invite/clawd",
    "Find new skills: https://clawhub.com",
    "For Straja behavior, commands, config, or architecture: consult local docs first.",
    "When diagnosing issues, run `openclaw status` yourself when possible; only ask the user if you lack access (e.g., sandboxed).",
    "",
  ];
}

function buildDeliverablesSection(params: { isMinimal: boolean; availableTools: Set<string> }) {
  if (params.isMinimal) {
    return [];
  }

  const hasReportBuild = params.availableTools.has("vault_report_build");
  const hasPresentationBuild = params.availableTools.has("vault_presentation_build");
  const hasArtifactWrite = params.availableTools.has("vault_artifact_write");
  const hasArtifactUrl = params.availableTools.has("vault_artifact_url");

  if (!hasReportBuild && !hasPresentationBuild) {
    return [];
  }

  const lines = ["## Deliverables"];
  if (hasReportBuild) {
    lines.push(
      "When the user is asking for a standalone written deliverable, default to a polished PDF report instead of pasting a long memo into chat.",
      "Written deliverables include memos, summaries, research briefs, weekly updates, one-pagers, analyses, and reports.",
      "Reports can include headings, tables, quotes, charts, screenshots, and images.",
      "Report specs must read like the document itself, not like an assistant reply.",
      "Do not put status updates, follow-up offers, or assistant chatter inside report fields (for example: 'I made...', 'If you want, I can...', 'Let me know...').",
      "If you want to offer a next step or alternate version, say it in the chat message outside the file, not inside the PDF.",
    );
  }
  if (hasPresentationBuild) {
    lines.push(
      "For presentations, decks, or slides, build a presentation artifact instead of a report.",
    );
  }
  lines.push("For spreadsheets or models, use spreadsheet/sheet tools when available.");
  if (hasArtifactWrite) {
    lines.push("Store specs and supporting assets with vault_artifact_write.");
  }
  if (hasReportBuild) {
    lines.push(
      "Report flow: reports/<name>/spec.json -> vault_report_build -> reports/<name>/build/<name>.pdf",
    );
  }
  if (hasPresentationBuild) {
    lines.push(
      "Presentation flow: presentations/<name>/spec.json -> vault_presentation_build -> presentations/<name>/build/<name>.pptx",
    );
  }
  if (hasArtifactUrl) {
    lines.push(
      "Deliver the finished file directly to the user via vault_artifact_url. Never return vault paths or ask the user to browse internal storage.",
    );
  }
  lines.push("");
  return lines;
}

function buildWebResearchSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
}) {
  if (params.isMinimal) {
    return [];
  }

  const hasVaultDuckDuckGo = params.availableTools.has("vault_web_search_duckduckgo");
  const hasWebSearch = params.availableTools.has("web_search");
  const hasWebFetch =
    params.availableTools.has("web_fetch") || params.availableTools.has("vault_web_fetch");
  const hasBrowser =
    params.availableTools.has("browser") ||
    Array.from(params.availableTools).some((tool) => tool.startsWith("vault_browser_"));

  if (!hasVaultDuckDuckGo && !hasWebSearch && !hasWebFetch && !hasBrowser) {
    return [];
  }

  const lines = ["## Web Research"];
  const preferredSearchTool = hasVaultDuckDuckGo
    ? params.resolveToolName("vault_web_search_duckduckgo")
    : hasWebSearch
      ? params.resolveToolName("web_search")
      : null;

  if (preferredSearchTool) {
    lines.push(
      `For ordinary factual web lookups, current-events questions, rankings, dates, and quick comparisons, use ${preferredSearchTool} first.`,
      `Do not open Google or another search engine in the browser for routine lookups when ${preferredSearchTool} is available.`,
    );
  }

  if (hasWebFetch) {
    const webFetchToolName = params.availableTools.has("vault_web_fetch")
      ? params.resolveToolName("vault_web_fetch")
      : params.resolveToolName("web_fetch");
    lines.push(
      `Use ${webFetchToolName} after search when you need to inspect one or two specific result pages in more detail.`,
    );
  }

  if (hasBrowser) {
    lines.push(
      "Escalate to vault browser tools only when the task requires interactive browsing that search/fetch cannot handle.",
    );
  }

  if (preferredSearchTool && hasBrowser) {
    lines.push(
      "Default escalation path: search first, then fetch a specific page if needed, and use browser tools only as the final fallback.",
    );
  }

  lines.push("");
  return lines;
}

function buildDeveloperSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
}) {
  if (params.isMinimal) {
    return [];
  }

  const repoTools = [
    ...(params.availableTools.has("vault_repos_list")
      ? [params.resolveToolName("vault_repos_list")]
      : []),
    ...(params.availableTools.has("vault_repo_exec")
      ? [params.resolveToolName("vault_repo_exec")]
      : []),
    ...(params.availableTools.has("vault_process")
      ? [params.resolveToolName("vault_process")]
      : []),
  ];
  const githubTools = [
    ...(params.availableTools.has("vault_github_create_issue")
      ? [params.resolveToolName("vault_github_create_issue")]
      : []),
    ...(params.availableTools.has("vault_github_list_issues")
      ? [params.resolveToolName("vault_github_list_issues")]
      : []),
    ...(params.availableTools.has("vault_github_create_branch")
      ? [params.resolveToolName("vault_github_create_branch")]
      : []),
    ...(params.availableTools.has("vault_github_create_pr")
      ? [params.resolveToolName("vault_github_create_pr")]
      : []),
    ...(params.availableTools.has("vault_github_list_prs")
      ? [params.resolveToolName("vault_github_list_prs")]
      : []),
    ...(params.availableTools.has("vault_github_push")
      ? [params.resolveToolName("vault_github_push")]
      : []),
  ];

  if (repoTools.length === 0 && githubTools.length === 0) {
    return [];
  }

  const lines = ["## Repo Engineering"];
  if (repoTools.length > 0) {
    lines.push(`Repo tools: ${repoTools.join(", ")}.`);
    if (params.availableTools.has("vault_repos_list")) {
      lines.push(
        "Use vault_repos_list first when you need to discover which attached repositories are available.",
      );
    }
    if (params.availableTools.has("vault_repo_exec")) {
      lines.push(
        "Use vault_repo_exec for repository-local coding work such as searching code, reading project files, running git, installing dependencies, building, and testing.",
      );
    }
    if (params.availableTools.has("vault_process")) {
      lines.push(
        "Use vault_process to monitor, poll, or manage background repo execution sessions started through the vault.",
      );
    }
  }
  if (githubTools.length > 0) {
    lines.push(`GitHub tools: ${githubTools.join(", ")}.`);
    lines.push(
      "Use GitHub tools for repository hosting actions like issues, branches, pull requests, and pushes instead of merely describing those actions.",
    );
  }
  lines.push(
    "Prefer repo-engineering tools over vault knowledge-search tools when the task is clearly about code, repository state, git history, builds, tests, or GitHub workflow.",
  );
  lines.push("");
  return lines;
}

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  reasoningTagHint?: boolean;
  toolNames?: string[];
  toolSummaries?: Record<string, string>;
  modelAliasLines?: string[];
  userTimezone?: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  skillsPrompt?: string;
  heartbeatPrompt?: string;
  docsPath?: string;
  workspaceNotes?: string[];
  ttsHint?: string;
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    channel?: string;
    capabilities?: string[];
    repoRoot?: string;
  };
  messageToolHints?: string[];
  sandboxInfo?: {
    enabled: boolean;
    workspaceDir?: string;
    containerWorkspaceDir?: string;
    workspaceAccess?: "none" | "ro" | "rw";
    agentWorkspaceMount?: string;
    browserBridgeUrl?: string;
    browserNoVncUrl?: string;
    hostBrowserAllowed?: boolean;
    elevated?: {
      allowed: boolean;
      defaultLevel: "on" | "off" | "ask" | "full";
    };
  };
  /** Reaction guidance for the agent (for Telegram minimal/extensive modes). */
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  memoryCitationsMode?: MemoryCitationsMode;
}) {
  const coreToolSummaries: Record<string, string> = {
    read: "Read file contents",
    write: "Create or overwrite files",
    edit: "Make precise edits to files",
    apply_patch: "Apply multi-file patches",
    grep: "Search file contents for patterns",
    find: "Find files by glob pattern",
    ls: "List directory contents",
    exec: "Run shell commands (pty available for TTY-required CLIs)",
    process: "Manage background exec sessions",
    web_search: "Search the web (Brave API)",
    web_fetch: "Fetch and extract readable content from a URL",
    vault_web_fetch:
      "Fetch and extract readable content from a URL via the vault (preferred over browser for reading pages)",
    vault_web_search_duckduckgo:
      "Search the web via the vault's DuckDuckGo adapter (preferred for simple factual lookups)",
    // Channel docking: add login tools here when a channel needs interactive linking.
    browser: "Control web browser",
    canvas: "Present/eval/snapshot the Canvas",
    nodes: "List/describe/notify/camera/screen on paired nodes",
    vault_cron: "Manage reminders, schedules, and wake events inside the vault runtime",
    message: "Send messages and channel actions",
    gateway: "Restart, apply config, or run updates on the running Straja process",
    agents_list: "List agent ids allowed for sessions_spawn",
    vault_agents_list: "List agent ids allowed for vault_sessions_spawn",
    sessions_list: "List other sessions (incl. sub-agents) with filters/last",
    vault_sessions_list: "List other sessions (incl. sub-agents) with filters/last",
    sessions_history: "Fetch history for another session/sub-agent",
    vault_sessions_history: "Fetch history for another session/sub-agent",
    sessions_send: "Send a message to another session/sub-agent",
    vault_sessions_send: "Send a message to another session/sub-agent",
    sessions_spawn: "Spawn a sub-agent session",
    vault_sessions_spawn: "Spawn a sub-agent session",
    subagents: "List, steer, or kill sub-agent runs for this requester session",
    vault_subagents: "List, steer, or kill sub-agent runs for this requester session",
    session_status:
      "Show a /status-equivalent status card (usage + time + Reasoning/Verbose/Elevated); use for model-use questions (📊 session_status); optional per-session model override",
    vault_session_status:
      "Show a /status-equivalent status card (usage + time + Reasoning/Verbose/Elevated); use for model-use questions (📊 vault_session_status); optional per-session model override",
    image: "Analyze an image with the configured image model",
    vault_note_create: "Create a note in the vault note space",
    vault_note_update: "Update an existing vault note",
    vault_agent_collection_create: "Create an agent-owned collection",
    vault_agent_collection_write: "Write a document inside an agent-owned collection",
    vault_collection_write: "Write a document directly to a normal vault collection path",
    vault_agent_collection_list: "List agent-owned collections",
    vault_artifact_write: "Store an artifact or artifact source file in the vault",
    vault_artifact_list: "List existing vault artifacts",
    vault_artifact_url: "Get a deliverable URL for a vault artifact",
    vault_presentation_build: "Build a presentation artifact from a stored spec",
    vault_report_build: "Build a report artifact from a stored spec",
    vault_gcalendar_create_event: "Create a Google Calendar event through the vault",
    vault_gcalendar_update_event: "Update a Google Calendar event through the vault",
    vault_gcalendar_delete_event: "Delete a Google Calendar event through the vault",
    vault_gmail_create_draft: "Create a Gmail draft through the vault",
    vault_gmail_update_draft: "Update an existing Gmail draft through the vault",
    vault_search: "Search the user's vault documents, notes, and collections",
    vault_get: "Read a vault document by path",
    vault_multi_get: "Read several vault documents in one call",
    vault_status: "Check vault availability and health",
    vault_spreadsheet_get: "Read a spreadsheet-backed vault document",
    vault_spreadsheet_match: "Find structured rows inside a spreadsheet-backed vault document",
    vault_spreadsheet_update: "Update a spreadsheet-backed vault document and regenerate the sheet",
    vault_memory_search: "Search persistent memory stored in the vault",
    vault_memory_get: "Read memory entries stored in the vault",
    vault_memory_write: "Write persistent memory to the vault",
    vault_browser_navigate: "Open a URL in the vault browser",
    vault_browser_snapshot: "Capture the current vault browser page state",
    vault_browser_click: "Click an element in the vault browser",
    vault_browser_type: "Type into the vault browser",
    vault_browser_fill: "Fill a form field in the vault browser",
    vault_browser_select: "Select an option in the vault browser",
    vault_browser_hover: "Hover an element in the vault browser",
    vault_browser_press_key: "Send a key press in the vault browser",
    vault_browser_screenshot: "Take a screenshot in the vault browser",
    vault_browser_tab_list: "List open vault browser tabs",
    vault_browser_tab_new: "Open a new vault browser tab",
    vault_browser_tab_close: "Close a vault browser tab",
    vault_browser_tabs: "Switch or inspect vault browser tabs",
    vault_browser_pdf: "Save the current vault browser page as PDF",
    vault_browser_dialog: "Handle browser dialogs in the vault browser",
    vault_stage_media_upload:
      "Stage inbound vault media into '_uploads' so it can be used for browser uploads",
    vault_browser_upload: "Upload a file through the vault browser",
    vault_browser_status: "Check vault browser status",
    vault_browser_start: "Start the vault browser service",
    vault_browser_stop: "Stop the vault browser service",
    vault_browser_console: "Inspect vault browser console output",
    vault_browser_wait: "Wait for a selector, URL, or condition in the vault browser",
    vault_approve_domain: "Approve a web domain for vault fetch/browser access",
    vault_repo_exec:
      "Run commands inside an attached local repository through the vault repo execution proxy",
    vault_repos_list: "List attached repositories available to the repo execution proxy",
    vault_process: "Manage background repo execution sessions started through the vault",
    vault_github_create_issue: "Create a GitHub issue through the vault",
    vault_github_list_issues: "List GitHub issues through the vault",
    vault_github_create_branch: "Create a GitHub branch through the vault",
    vault_github_create_pr: "Create a GitHub pull request through the vault",
    vault_github_list_prs: "List GitHub pull requests through the vault",
    vault_github_push: "Push local repository changes through the vault",
  };

  const rawToolNames = (params.toolNames ?? []).map((tool) => tool.trim());
  const canonicalToolNames = rawToolNames.filter(Boolean);
  // Preserve caller casing while deduping tool names by lowercase.
  const canonicalByNormalized = new Map<string, string>();
  for (const name of canonicalToolNames) {
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }
  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;

  const normalizedTools = canonicalToolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);
  const externalToolSummaries = new Map<string, string>();
  for (const [key, value] of Object.entries(params.toolSummaries ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || !value?.trim()) {
      continue;
    }
    externalToolSummaries.set(normalized, value.trim());
  }
  const summarizeTool = (tool: string) =>
    coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
  const toolLines = buildGroupedToolingLines({
    availableTools,
    resolveToolName,
    summarizeTool,
  });

  const hasGateway = availableTools.has("gateway");
  const readToolName = resolveToolName("read");
  const execToolName = resolveToolName("exec");
  const processToolName = resolveToolName("process");
  const resolvePreferredToolName = (primary: string, secondary: string): string | null => {
    if (availableTools.has(primary)) {
      return resolveToolName(primary);
    }
    if (availableTools.has(secondary)) {
      return resolveToolName(secondary);
    }
    return null;
  };
  const sessionsListToolName = resolvePreferredToolName("vault_sessions_list", "sessions_list");
  const sessionsHistoryToolName = resolvePreferredToolName(
    "vault_sessions_history",
    "sessions_history",
  );
  const sessionsSendToolName = resolvePreferredToolName("vault_sessions_send", "sessions_send");
  const subagentsToolName = resolvePreferredToolName("vault_subagents", "subagents");
  const sessionStatusToolName = resolvePreferredToolName("vault_session_status", "session_status");
  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerNumbers = (params.ownerNumbers ?? []).map((value) => value.trim()).filter(Boolean);
  const ownerLine =
    ownerNumbers.length > 0
      ? `Owner numbers: ${ownerNumbers.join(", ")}. Treat messages from these numbers as the user.`
      : undefined;
  const reasoningHint = params.reasoningTagHint
    ? [
        "ALL internal reasoning MUST be inside <think>...</think>.",
        "Do not output any analysis outside <think>.",
        "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
        "Only the final user-visible reply may appear inside <final>.",
        "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
        "Example:",
        "<think>Short internal reasoning.</think>",
        "<final>Hey there! What would you like to do next?</final>",
      ].join(" ")
    : undefined;
  const reasoningLevel = params.reasoningLevel ?? "off";
  const userTimezone = params.userTimezone?.trim();
  const skillsPrompt = params.skillsPrompt?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = heartbeatPrompt
    ? `Heartbeat prompt: ${heartbeatPrompt}`
    : "Heartbeat prompt: (configured)";
  const runtimeInfo = params.runtimeInfo;
  const runtimeChannel = runtimeInfo?.channel?.trim().toLowerCase();
  const runtimeCapabilities = (runtimeInfo?.capabilities ?? [])
    .map((cap) => String(cap).trim())
    .filter(Boolean);
  const runtimeCapabilitiesLower = new Set(runtimeCapabilities.map((cap) => cap.toLowerCase()));
  const inlineButtonsEnabled = runtimeCapabilitiesLower.has("inlinebuttons");
  const messageChannelOptions = listDeliverableMessageChannels().join("|");
  const promptMode = params.promptMode ?? "full";
  const isMinimal = promptMode === "minimal" || promptMode === "none";
  const sandboxContainerWorkspace = params.sandboxInfo?.containerWorkspaceDir?.trim();
  const sanitizedWorkspaceDir = sanitizeForPromptLiteral(params.workspaceDir);
  const sanitizedSandboxContainerWorkspace = sandboxContainerWorkspace
    ? sanitizeForPromptLiteral(sandboxContainerWorkspace)
    : "";
  const hasReadTool = availableTools.has("read");
  const hasFileEditTools =
    hasReadTool ||
    availableTools.has("write") ||
    availableTools.has("edit") ||
    availableTools.has("apply_patch");
  const hasExecTool = availableTools.has("exec");
  const hasProcessTool = availableTools.has("process");
  const hasSubagentTool = availableTools.has("subagents") || availableTools.has("vault_subagents");
  const hasSessionsListTool =
    availableTools.has("sessions_list") || availableTools.has("vault_sessions_list");
  const displayWorkspaceDir =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? sanitizedSandboxContainerWorkspace
      : sanitizedWorkspaceDir;
  const workspaceGuidance =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? hasFileEditTools && hasExecTool
        ? `For read/write/edit/apply_patch, file paths resolve against host workspace: ${sanitizedWorkspaceDir}. For bash/exec commands, use sandbox container paths under ${sanitizedSandboxContainerWorkspace} (or relative paths from that workdir), not host paths. Prefer relative paths so both sandboxed exec and file tools work consistently.`
        : hasFileEditTools
          ? `File tool paths resolve against host workspace: ${sanitizedWorkspaceDir}.`
          : hasExecTool
            ? `For bash/exec commands, use sandbox container paths under ${sanitizedSandboxContainerWorkspace} (or relative paths from that workdir), not host paths.`
            : "This runtime relies on vault/native tools rather than local workspace file or exec tools."
      : hasFileEditTools
        ? "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise."
        : "This workspace path is reference context only; prefer the available vault/native tools in this runtime.";
  const safetySection = [
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    "",
  ];
  const skillsSection = buildSkillsSection({
    skillsPrompt,
    isMinimal,
    readToolName: hasReadTool ? readToolName : undefined,
  });
  const memorySection = buildMemorySection({
    isMinimal,
    availableTools,
    citationsMode: params.memoryCitationsMode,
  });
  const vaultKnowledgeSection = buildVaultKnowledgeSection({
    isMinimal,
    availableTools,
    resolveToolName,
  });
  const vaultCollectionsSection = buildVaultCollectionsSection({
    isMinimal,
    availableTools,
    resolveToolName,
  });
  const vaultArtifactsSection = buildVaultArtifactsSection({
    isMinimal,
    availableTools,
    resolveToolName,
  });
  const vaultSpreadsheetsSection = buildVaultSpreadsheetsSection({
    isMinimal,
    availableTools,
    resolveToolName,
  });
  const vaultCalendarSection = buildVaultCalendarSection({
    isMinimal,
    availableTools,
    resolveToolName,
  });
  const vaultAutomationSection = buildVaultAutomationSection({
    isMinimal,
    availableTools,
    resolveToolName,
  });
  const vaultBrowserSection = buildVaultBrowserSection({
    isMinimal,
    availableTools,
    resolveToolName,
  });
  const developerSection = buildDeveloperSection({
    isMinimal,
    availableTools,
    resolveToolName,
  });
  const deliverablesSection = buildDeliverablesSection({
    isMinimal,
    availableTools,
  });
  const webResearchSection = buildWebResearchSection({
    isMinimal,
    availableTools,
    resolveToolName,
  });
  const docsSection = buildDocsSection({
    docsPath: params.docsPath,
    isMinimal,
    readToolName: hasReadTool ? readToolName : undefined,
  });
  const longWaitGuidance =
    hasExecTool && hasProcessTool
      ? `For long waits, avoid rapid poll loops: use ${execToolName} with enough yieldMs or ${processToolName}(action=poll, timeout=<ms>).`
      : hasExecTool
        ? `For long waits, avoid rapid poll loops: use ${execToolName} with enough yieldMs.`
        : hasSubagentTool
          ? "For long waits, avoid rapid poll loops; prefer push-based sub-agents and check status only on-demand."
          : "";
  const subagentGuidance = hasSubagentTool
    ? "If a task is more complex or takes longer, spawn a sub-agent. Completion is push-based: it will auto-announce when done."
    : "";
  const pollingGuidance =
    hasSubagentTool && hasSessionsListTool
      ? `Do not poll \`${subagentsToolName} list\` / \`${sessionsListToolName}\` in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).`
      : hasSubagentTool
        ? `Do not poll \`${subagentsToolName} list\` in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).`
        : hasSessionsListTool
          ? `Do not poll \`${sessionsListToolName}\` in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).`
          : "";
  const workspaceNotes = (params.workspaceNotes ?? []).map((note) => note.trim()).filter(Boolean);

  // For "none" mode, return just the basic identity line
  if (promptMode === "none") {
    return "You are a personal assistant running inside Straja.";
  }

  const lines = [
    "You are a personal assistant running inside Straja.",
    "",
    "## Tooling",
    "Tool availability (filtered by policy):",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    toolLines.length > 0
      ? toolLines.join("\n")
      : [
          "Pi lists the standard tools above. This runtime enables:",
          "- grep: search file contents for patterns",
          "- find: find files by glob pattern",
          "- ls: list directory contents",
          "- apply_patch: apply multi-file patches",
          `- ${execToolName}: run shell commands (supports background via yieldMs/background)`,
          `- ${processToolName}: manage background exec sessions`,
          "- browser: control Straja's dedicated browser",
          "- canvas: present/eval/snapshot the Canvas",
          "- nodes: list/describe/notify/camera/screen on paired nodes",
          "- cron: manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
          sessionsListToolName ? `- ${sessionsListToolName}: list sessions` : "",
          sessionsHistoryToolName ? `- ${sessionsHistoryToolName}: fetch session history` : "",
          sessionsSendToolName ? `- ${sessionsSendToolName}: send to another session` : "",
          subagentsToolName ? `- ${subagentsToolName}: list/steer/kill sub-agent runs` : "",
          sessionStatusToolName
            ? `- ${sessionStatusToolName}: show usage/time/model state and answer "what model are we using?"`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    longWaitGuidance,
    subagentGuidance,
    pollingGuidance,
    "",
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "Use plain human language for narration unless in a technical context.",
    "",
    ...safetySection,
    "## Straja CLI Quick Reference",
    "Straja is controlled via subcommands. Do not invent commands.",
    "To manage the Gateway daemon service (start/stop/restart):",
    "- openclaw gateway status",
    "- openclaw gateway start",
    "- openclaw gateway stop",
    "- openclaw gateway restart",
    "If unsure, ask the user to run `openclaw help` (or `openclaw gateway --help`) and paste the output.",
    "",
    ...skillsSection,
    ...memorySection,
    ...vaultKnowledgeSection,
    ...vaultCollectionsSection,
    ...vaultArtifactsSection,
    ...vaultSpreadsheetsSection,
    ...vaultCalendarSection,
    ...vaultAutomationSection,
    ...vaultBrowserSection,
    ...developerSection,
    ...deliverablesSection,
    ...webResearchSection,
    // Skip self-update for subagent/none modes
    hasGateway && !isMinimal ? "## Straja Self-Update" : "",
    hasGateway && !isMinimal
      ? [
          "Get Updates (self-update) is ONLY allowed when the user explicitly asks for it.",
          "Do not run config.apply or update.run unless the user explicitly requests an update or config change; if it's not explicit, ask first.",
          "Actions: config.get, config.schema, config.apply (validate + write full config, then restart), update.run (update deps or git, then restart).",
          "After restart, Straja pings the last active session automatically.",
        ].join("\n")
      : "",
    hasGateway && !isMinimal ? "" : "",
    "",
    // Skip model aliases for subagent/none modes
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "## Model Aliases"
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "Prefer aliases when specifying model overrides; full provider/model is also accepted."
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? params.modelAliasLines.join("\n")
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal ? "" : "",
    userTimezone && sessionStatusToolName
      ? `If you need the current date, time, or day of week, run ${sessionStatusToolName} (📊 ${sessionStatusToolName}).`
      : "",
    "## Workspace",
    `Your working directory is: ${displayWorkspaceDir}`,
    workspaceGuidance,
    ...workspaceNotes,
    "",
    ...docsSection,
    params.sandboxInfo?.enabled ? "## Sandbox" : "",
    params.sandboxInfo?.enabled
      ? [
          "You are running in a sandboxed runtime (tools execute in Docker).",
          "Some tools may be unavailable due to sandbox policy.",
          "Sub-agents stay sandboxed (no elevated/host access). Need outside-sandbox read/write? Don't spawn; ask first.",
          params.sandboxInfo.containerWorkspaceDir
            ? `Sandbox container workdir: ${sanitizeForPromptLiteral(params.sandboxInfo.containerWorkspaceDir)}`
            : "",
          params.sandboxInfo.workspaceDir
            ? `Sandbox host mount source (file tools bridge only; not valid inside sandbox exec): ${sanitizeForPromptLiteral(params.sandboxInfo.workspaceDir)}`
            : "",
          params.sandboxInfo.workspaceAccess
            ? `Agent workspace access: ${params.sandboxInfo.workspaceAccess}${
                params.sandboxInfo.agentWorkspaceMount
                  ? ` (mounted at ${sanitizeForPromptLiteral(params.sandboxInfo.agentWorkspaceMount)})`
                  : ""
              }`
            : "",
          params.sandboxInfo.browserBridgeUrl ? "Sandbox browser: enabled." : "",
          params.sandboxInfo.browserNoVncUrl
            ? `Sandbox browser observer (noVNC): ${sanitizeForPromptLiteral(params.sandboxInfo.browserNoVncUrl)}`
            : "",
          params.sandboxInfo.hostBrowserAllowed === true
            ? "Host browser control: allowed."
            : params.sandboxInfo.hostBrowserAllowed === false
              ? "Host browser control: blocked."
              : "",
          params.sandboxInfo.elevated?.allowed
            ? "Elevated exec is available for this session."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? "User can toggle with /elevated on|off|ask|full."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? "You may also send /elevated on|off|ask|full when needed."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? `Current elevated level: ${params.sandboxInfo.elevated.defaultLevel} (ask runs exec on host with approvals; full auto-approves).`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    params.sandboxInfo?.enabled ? "" : "",
    ...buildUserIdentitySection(ownerLine, isMinimal),
    ...buildTimeSection({
      userTimezone,
    }),
    "## Workspace Files (injected)",
    "These user-editable files are loaded by Straja and included below in Project Context.",
    "",
    ...buildReplyTagsSection(isMinimal),
    ...buildMessagingSection({
      isMinimal,
      availableTools,
      messageChannelOptions,
      inlineButtonsEnabled,
      runtimeChannel,
      messageToolHints: params.messageToolHints,
    }),
    ...buildVoiceSection({ isMinimal, ttsHint: params.ttsHint }),
  ];

  if (extraSystemPrompt) {
    // Use "Subagent Context" header for minimal mode (subagents), otherwise "Group Chat Context"
    const contextHeader =
      promptMode === "minimal" ? "## Subagent Context" : "## Group Chat Context";
    lines.push(contextHeader, extraSystemPrompt, "");
  }
  if (params.reactionGuidance) {
    const { level, channel } = params.reactionGuidance;
    const guidanceText =
      level === "minimal"
        ? [
            `Reactions are enabled for ${channel} in MINIMAL mode.`,
            "React ONLY when truly relevant:",
            "- Acknowledge important user requests or confirmations",
            "- Express genuine sentiment (humor, appreciation) sparingly",
            "- Avoid reacting to routine messages or your own replies",
            "Guideline: at most 1 reaction per 5-10 exchanges.",
          ].join("\n")
        : [
            `Reactions are enabled for ${channel} in EXTENSIVE mode.`,
            "Feel free to react liberally:",
            "- Acknowledge messages with appropriate emojis",
            "- Express sentiment and personality through reactions",
            "- React to interesting content, humor, or notable events",
            "- Use reactions to confirm understanding or agreement",
            "Guideline: react whenever it feels natural.",
          ].join("\n");
    lines.push("## Reactions", guidanceText, "");
  }
  if (reasoningHint) {
    lines.push("## Reasoning Format", reasoningHint, "");
  }

  const contextFiles = params.contextFiles ?? [];
  const validContextFiles = contextFiles.filter(
    (file) => typeof file.path === "string" && file.path.trim().length > 0,
  );
  if (validContextFiles.length > 0) {
    const hasSoulFile = validContextFiles.some((file) => {
      const normalizedPath = file.path.trim().replace(/\\/g, "/");
      const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
      return baseName.toLowerCase() === "soul.md";
    });
    lines.push("# Project Context", "", "The following project context files have been loaded:");
    if (hasSoulFile) {
      lines.push(
        "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
      );
    }
    lines.push("");
    for (const file of validContextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  // Skip silent replies for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## Silent Replies",
      `When you have nothing to say, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
      "",
      "⚠️ Rules:",
      "- It must be your ENTIRE message — nothing else",
      `- Never append it to an actual response (never include "${SILENT_REPLY_TOKEN}" in real replies)`,
      "- Never wrap it in markdown or code blocks",
      "",
      `❌ Wrong: "Here's help... ${SILENT_REPLY_TOKEN}"`,
      `❌ Wrong: "${SILENT_REPLY_TOKEN}"`,
      `✅ Right: ${SILENT_REPLY_TOKEN}`,
      "",
    );
  }

  // Skip heartbeats for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## Heartbeats",
      heartbeatPromptLine,
      "If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:",
      "HEARTBEAT_OK",
      'Straja treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).',
      'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
      "",
    );
  }

  lines.push(
    "## Runtime",
    buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, params.defaultThinkLevel),
    `Reasoning: ${reasoningLevel} (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.`,
  );

  return lines.filter(Boolean).join("\n");
}

export function buildRuntimeLine(
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    repoRoot?: string;
  },
  runtimeChannel?: string,
  runtimeCapabilities: string[] = [],
  defaultThinkLevel?: ThinkLevel,
): string {
  return `Runtime: ${[
    runtimeInfo?.agentId ? `agent=${runtimeInfo.agentId}` : "",
    runtimeInfo?.host ? `host=${runtimeInfo.host}` : "",
    runtimeInfo?.repoRoot ? `repo=${runtimeInfo.repoRoot}` : "",
    runtimeInfo?.os
      ? `os=${runtimeInfo.os}${runtimeInfo?.arch ? ` (${runtimeInfo.arch})` : ""}`
      : runtimeInfo?.arch
        ? `arch=${runtimeInfo.arch}`
        : "",
    runtimeInfo?.node ? `node=${runtimeInfo.node}` : "",
    runtimeInfo?.model ? `model=${runtimeInfo.model}` : "",
    runtimeInfo?.defaultModel ? `default_model=${runtimeInfo.defaultModel}` : "",
    runtimeInfo?.shell ? `shell=${runtimeInfo.shell}` : "",
    runtimeChannel ? `channel=${runtimeChannel}` : "",
    runtimeChannel
      ? `capabilities=${runtimeCapabilities.length > 0 ? runtimeCapabilities.join(",") : "none"}`
      : "",
    `thinking=${defaultThinkLevel ?? "off"}`,
  ]
    .filter(Boolean)
    .join(" | ")}`;
}
