import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt vault tool injection", () => {
  it("keeps vault, memory, and web guidance separated for a vault-only chief-of-staff toolset", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: [
        "vault_memory_search",
        "vault_memory_get",
        "vault_memory_write",
        "vault_note_create",
        "vault_note_update",
        "vault_agent_collection_create",
        "vault_agent_collection_write",
        "vault_collection_write",
        "vault_agent_collection_list",
        "vault_artifact_write",
        "vault_artifact_list",
        "vault_artifact_url",
        "vault_report_build",
        "vault_presentation_build",
        "vault_search",
        "vault_get",
        "vault_multi_get",
        "vault_status",
        "vault_spreadsheet_get",
        "vault_spreadsheet_match",
        "vault_spreadsheet_update",
        "vault_gcalendar_create_event",
        "vault_gcalendar_update_event",
        "vault_gcalendar_delete_event",
        "vault_cron",
        "vault_web_search_duckduckgo",
        "vault_web_fetch",
        "vault_approve_domain",
        "vault_browser_navigate",
        "vault_browser_snapshot",
        "sessions_list",
        "sessions_history",
        "sessions_send",
        "sessions_spawn",
        "subagents",
        "session_status",
        "message",
      ],
    });

    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain("ALWAYS run vault_memory_search first");
    expect(prompt).toContain(
      "If memory search returns no results, ALSO run vault_search to check notes, documents, and other collections",
    );
    expect(prompt).toContain("## Vault Knowledge Search");
    expect(prompt).toContain(
      "When the user asks about information that could be in their own documents, notes, collections, student records, or emails, use vault_search to find relevant content.",
    );
    expect(prompt).toContain("## Vault Notes & Collections");
    expect(prompt).toContain("## Vault Artifacts");
    expect(prompt).toContain("## Vault Spreadsheets");
    expect(prompt).toContain("## Vault Automation");
    expect(prompt).toContain("## Vault Browser & Domain Approval");
    expect(prompt).toContain("## Web Research");
    expect(prompt).toContain("use vault_web_search_duckduckgo first");
    expect(prompt).toContain("Use vault_web_fetch after search");
    expect(prompt).toContain(
      "Escalate to vault browser tools only when the task requires interactive browsing that search/fetch cannot handle.",
    );
    expect(prompt).toContain("Use vault_status to check vault readiness or health");
    expect(prompt).toContain("Use vault_multi_get when you already have several relevant hits");
    expect(prompt).toContain("Use vault_spreadsheet_update for spreadsheet-backed mutations");
    expect(prompt).toContain(
      "For long waits, avoid rapid poll loops; prefer push-based sub-agents and check status only on-demand.",
    );
    expect(prompt).not.toContain("use exec with enough yieldMs");
    expect(prompt).not.toContain("process(action=poll");
    expect(prompt).not.toContain("OpenClaw docs: /tmp/openclaw/docs");
    expect(prompt).not.toContain("read its SKILL.md at <location> with `read`");
  });
});
