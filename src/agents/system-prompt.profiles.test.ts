import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt profile-shaped toolsets", () => {
  it("builds a repo-engineering prompt for software-engineer tools", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/engineer",
      toolNames: [
        "vault_repo_exec",
        "vault_repos_list",
        "vault_process",
        "vault_github_create_issue",
        "vault_github_list_issues",
        "vault_github_create_branch",
        "vault_github_create_pr",
        "vault_github_list_prs",
        "vault_github_push",
        "sessions_list",
        "sessions_history",
        "sessions_send",
        "sessions_spawn",
        "session_status",
        "image",
      ],
    });

    expect(prompt).toContain("### Developer & GitHub");
    expect(prompt).toContain("## Repo Engineering");
    expect(prompt).toContain("Use vault_repos_list first");
    expect(prompt).toContain("Use vault_repo_exec for repository-local coding work");
    expect(prompt).toContain(
      "Use vault_process to monitor, poll, or manage background repo execution sessions",
    );
    expect(prompt).toContain("Use GitHub tools for repository hosting actions");
    expect(prompt).toContain("sessions_send(sessionKey, message)");
    expect(prompt).not.toContain("## Vault Knowledge Search");
    expect(prompt).not.toContain("## Memory Recall");
    expect(prompt).not.toContain("## Web Research");
  });

  it("builds only the relevant sections for a representative custom vault agent", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/custom",
      toolNames: ["vault_search", "vault_get", "vault_status", "vault_cron", "message"],
    });

    expect(prompt).toContain("### Core");
    expect(prompt).toContain("### Vault Knowledge");
    expect(prompt).toContain("## Vault Knowledge Search");
    expect(prompt).toContain("## Vault Automation");
    expect(prompt).toContain("## Messaging");
    expect(prompt).not.toContain("## Repo Engineering");
    expect(prompt).not.toContain("## Memory Recall");
    expect(prompt).not.toContain("## Web Research");
    expect(prompt).not.toContain("## Vault Browser & Domain Approval");
    expect(prompt).not.toContain("sessions_send(sessionKey, message)");
    expect(prompt).not.toContain("Sub-agent orchestration");
    expect(prompt).not.toContain("run session_status");
  });
});
