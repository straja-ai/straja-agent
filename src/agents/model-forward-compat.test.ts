import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveForwardCompatModel } from "./model-forward-compat.js";
import type { ModelRegistry } from "./pi-model-discovery.js";

function createTemplateModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: provider === "openai-codex" ? "openai-codex-responses" : "anthropic-messages",
    baseUrl: provider === "openai-codex" ? "https://chatgpt.com/backend-api" : undefined,
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  } as Model<Api>;
}

function createRegistry(models: Record<string, Model<Api>>): ModelRegistry {
  return {
    find(provider: string, modelId: string) {
      return models[`${provider}/${modelId}`] ?? null;
    },
  } as ModelRegistry;
}

describe("agents/model-forward-compat", () => {
  it("resolves anthropic opus 4.6 via 4.5 template", () => {
    const registry = createRegistry({
      "anthropic/claude-opus-4-5": createTemplateModel("anthropic", "claude-opus-4-5"),
    });
    const model = resolveForwardCompatModel("anthropic", "claude-opus-4-6", registry);
    expect(model?.id).toBe("claude-opus-4-6");
    expect(model?.name).toBe("claude-opus-4-6");
    expect(model?.provider).toBe("anthropic");
  });

  it("resolves anthropic sonnet 4.6 dot variant with suffix", () => {
    const registry = createRegistry({
      "anthropic/claude-sonnet-4.5-20260219": createTemplateModel(
        "anthropic",
        "claude-sonnet-4.5-20260219",
      ),
    });
    const model = resolveForwardCompatModel("anthropic", "claude-sonnet-4.6-20260219", registry);
    expect(model?.id).toBe("claude-sonnet-4.6-20260219");
    expect(model?.name).toBe("claude-sonnet-4.6-20260219");
    expect(model?.provider).toBe("anthropic");
  });

  it("does not resolve anthropic 4.6 fallback for other providers", () => {
    const registry = createRegistry({
      "anthropic/claude-opus-4-5": createTemplateModel("anthropic", "claude-opus-4-5"),
    });
    const model = resolveForwardCompatModel("openai", "claude-opus-4-6", registry);
    expect(model).toBeUndefined();
  });

  it("uses a configured provider baseUrl for codex fallback when no template exists", () => {
    const registry = createRegistry({});
    const model = resolveForwardCompatModel("openai-codex", "gpt-5.3-codex", registry, {
      providerBaseUrl: "http://127.0.0.1:18080/v1",
    });
    expect(model?.id).toBe("gpt-5.3-codex");
    expect(model?.provider).toBe("openai-codex");
    expect(model?.api).toBe("openai-responses");
    expect(model?.baseUrl).toBe("http://127.0.0.1:18080/v1");
  });

  it("rewrites codex template fallbacks onto openai responses when provider baseUrl points at /v1", () => {
    const registry = createRegistry({
      "openai-codex/gpt-5.2-codex": createTemplateModel("openai-codex", "gpt-5.2-codex"),
    });
    const model = resolveForwardCompatModel("openai-codex", "gpt-5.3-codex", registry, {
      providerBaseUrl: "http://127.0.0.1:18080/v1",
    });
    expect(model?.id).toBe("gpt-5.3-codex");
    expect(model?.provider).toBe("openai-codex");
    expect(model?.api).toBe("openai-responses");
    expect(model?.baseUrl).toBe("http://127.0.0.1:18080/v1");
  });
});
