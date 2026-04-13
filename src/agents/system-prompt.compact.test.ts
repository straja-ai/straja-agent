import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt compact mode", () => {
  it("uses a condensed local-model prompt layout", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "compact",
      toolNames: [
        "vault_search",
        "vault_get",
        "vault_memory_search",
        "vault_memory_get",
        "vault_memory_write",
        "vault_browser_navigate",
        "vault_browser_snapshot",
        "vault_note_create",
        "message",
        "gateway",
      ],
      docsPath: "/tmp/openclaw/docs",
      modelAliasLines: ["- local-fast -> ollama/gemma4:e4b"],
      contextFiles: [
        { path: "AGENTS.md", content: "agents" },
        { path: "USER.md", content: "user" },
      ],
    });

    expect(prompt).toContain("condensed for local-model runs");
    expect(prompt).toContain("### Vault Knowledge");
    expect(prompt).toContain("- vault_search, vault_get");
    expect(prompt).toContain("## Memory");
    expect(prompt).not.toContain("## Straja CLI Quick Reference");
    expect(prompt).not.toContain("## Documentation");
    expect(prompt).not.toContain("## Straja Self-Update");
    expect(prompt).not.toContain("## Model Aliases");
    expect(prompt).toContain(
      "Only core workspace identity files are injected for local-model efficiency.",
    );
  });
});

describe("buildAgentSystemPrompt local_worker mode", () => {
  it("omits project context and heavy runtime sections for local workers", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "local_worker",
      toolNames: [
        "vault_search",
        "vault_get",
        "vault_memory_search",
        "vault_memory_get",
        "vault_memory_write",
        "vault_note_create",
        "message",
      ],
      contextFiles: [
        { path: "AGENTS.md", content: "agents" },
        { path: "SOUL.md", content: "soul" },
      ],
      extraSystemPrompt: "Route: local_fast_path",
    });

    expect(prompt).toContain("You are a local worker inside Straja.");
    expect(prompt).toContain("Tool availability (strictly narrowed for this run):");
    expect(prompt).toContain("## Run Context");
    expect(prompt).not.toContain("# Project Context");
    expect(prompt).not.toContain("## Workspace Files (injected)");
    expect(prompt).not.toContain("## Heartbeats");
    expect(prompt).not.toContain("## Silent Replies");
  });
});
