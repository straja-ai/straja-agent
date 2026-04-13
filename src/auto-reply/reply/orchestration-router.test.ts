import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  resolveModel: vi.fn(),
  getApiKeyForModel: vi.fn(),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
  persistPromptInput: vi.fn(async () => {}),
  persistPromptOutput: vi.fn(async () => {}),
  persistStep: vi.fn(async () => {}),
}));

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    completeSimple: mocks.completeSimple,
  };
});

vi.mock("../../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel: mocks.getApiKeyForModel,
  requireApiKey: mocks.requireApiKey,
}));

vi.mock("./orchestration-vault.js", () => ({
  persistOrchestrationPromptInput: mocks.persistPromptInput,
  persistOrchestrationPromptOutput: mocks.persistPromptOutput,
  persistOrchestrationStep: mocks.persistStep,
}));

const { runInboundOrchestrationRouter } = await import("./orchestration-router.js");

describe("orchestration-router", () => {
  beforeEach(() => {
    mocks.completeSimple.mockReset();
    mocks.resolveModel.mockReset();
    mocks.getApiKeyForModel.mockReset();
    mocks.requireApiKey.mockClear();
    mocks.persistPromptInput.mockClear();
    mocks.persistPromptOutput.mockClear();
    mocks.persistStep.mockClear();

    mocks.resolveModel.mockReturnValue({
      model: {
        provider: "ollama",
        id: "gemma4:4b",
      },
      authStorage: {},
      modelRegistry: {},
    });
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "ollama-local",
      source: "env: OLLAMA_API_KEY",
      mode: "api-key",
    });
  });

  it("uses the local router model to select a specialist and task shape", async () => {
    mocks.completeSimple.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            selectedAgentId: "school",
            taskClass: "simple_inbound_automation",
            suggestedRoute: "local_fast_path",
            confidence: 0.91,
            toolFamily: "local_automation",
            memoryQuery: "Maria absence parent",
            vaultQuery: "Maria attendance absence",
            reasons: ["parent absence update", "school specialist matches"],
          }),
        },
      ],
      usage: { input: 120, output: 42, total: 162 },
    });

    const cfg = {
      agents: {
        defaults: {
          orchestration: {
            router: {
              model: "ollama/gemma4:4b",
            },
          },
        },
        list: [
          { id: "main", default: true, name: "General Assistant" },
          { id: "school", name: "School Admin", skills: ["school", "attendance", "absence"] },
        ],
      },
    } as OpenClawConfig;

    const decision = await runInboundOrchestrationRouter({
      cfg,
      traceId: "trace-router-1",
      sessionId: "whatsapp:+1",
      body: "Please mark Maria absent tomorrow and reply to the parent.",
      currentAgentId: "main",
      commandAuthorized: true,
      flowContext: [],
    });

    expect(decision.source).toBe("model");
    expect(decision.selectedAgentId).toBe("school");
    expect(decision.taskClass).toBe("simple_inbound_automation");
    expect(decision.suggestedRoute).toBe("local_fast_path");
    expect(decision.toolFamily).toBe("local_automation");
    expect(decision.memoryQuery).toBe("Maria absence parent");
    expect(decision.vaultQuery).toBe("Maria attendance absence");
    expect(mocks.persistPromptInput).toHaveBeenCalledTimes(1);
    expect(mocks.persistPromptOutput).toHaveBeenCalledTimes(1);
  });

  it("falls back to a validated agent when the model returns an invalid id", async () => {
    mocks.completeSimple.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            selectedAgentId: "ghost",
            taskClass: "general_agent_turn",
            suggestedRoute: "default_specialist",
            confidence: 0.7,
            toolFamily: "general",
            memoryQuery: "hello",
            vaultQuery: "hello",
            reasons: ["generic request"],
          }),
        },
      ],
      usage: { input: 90, output: 28, total: 118 },
    });

    const cfg = {
      agents: {
        defaults: {
          orchestration: {
            router: {
              model: "ollama/gemma4:4b",
            },
          },
        },
        list: [{ id: "main", default: true, name: "General Assistant" }],
      },
    } as OpenClawConfig;

    const decision = await runInboundOrchestrationRouter({
      cfg,
      traceId: "trace-router-2",
      sessionId: "whatsapp:+1",
      body: "Hello there",
      currentAgentId: "main",
      commandAuthorized: true,
      flowContext: [],
    });

    expect(decision.source).toBe("model");
    expect(decision.selectedAgentId).toBe("main");
    expect(decision.selectedAgentReason).toContain("invalid agent id");
  });
});
