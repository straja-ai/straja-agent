import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveImplicitProviders, resolveOllamaApiBase } from "./models-config.providers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveOllamaApiBase", () => {
  it("returns default localhost base when no configured URL is provided", () => {
    expect(resolveOllamaApiBase()).toBe("http://127.0.0.1:11434");
  });

  it("prefers the managed workspace ollama base from env when present", () => {
    process.env.STRAJA_OLLAMA_BASE_URL = "http://127.0.0.1:11435/v1";
    try {
      expect(resolveOllamaApiBase()).toBe("http://127.0.0.1:11435");
    } finally {
      delete process.env.STRAJA_OLLAMA_BASE_URL;
    }
  });

  it("strips /v1 suffix from OpenAI-compatible URLs", () => {
    expect(resolveOllamaApiBase("http://ollama-host:11434/v1")).toBe("http://ollama-host:11434");
    expect(resolveOllamaApiBase("http://ollama-host:11434/V1")).toBe("http://ollama-host:11434");
  });

  it("keeps URLs without /v1 unchanged", () => {
    expect(resolveOllamaApiBase("http://ollama-host:11434")).toBe("http://ollama-host:11434");
  });

  it("handles trailing slash before canonicalizing", () => {
    expect(resolveOllamaApiBase("http://ollama-host:11434/v1/")).toBe("http://ollama-host:11434");
    expect(resolveOllamaApiBase("http://ollama-host:11434/")).toBe("http://ollama-host:11434");
  });
});

describe("Ollama provider", () => {
  it("registers ollama with a local placeholder key when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    expect(providers?.ollama).toBeDefined();
    expect(providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
    expect(process.env.OLLAMA_API_KEY).toBe("ollama-local");
  });

  it("should use native ollama api type", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.ollama).toBeDefined();
      expect(providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
      expect(providers?.ollama?.api).toBe("ollama");
      expect(providers?.ollama?.baseUrl).toBe("http://127.0.0.1:11434");
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("should use the managed workspace ollama base url for implicit provider injection", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";
    process.env.STRAJA_OLLAMA_BASE_URL = "http://127.0.0.1:11435";

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.ollama?.baseUrl).toBe("http://127.0.0.1:11435");
    } finally {
      delete process.env.STRAJA_OLLAMA_BASE_URL;
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("falls back to the managed local ollama port when 11434 is unavailable", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url === "http://127.0.0.1:11434/api/tags") {
        throw new TypeError("fetch failed");
      }
      if (url === "http://127.0.0.1:11435/api/tags") {
        return new Response(
          JSON.stringify({
            models: [{ name: "gemma4:e4b" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.ollama?.baseUrl).toBe("http://127.0.0.1:11435");
      expect(providers?.ollama?.models.map((model) => model.id)).toContain("gemma4:e4b");
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("should preserve explicit ollama baseUrl on implicit provider injection", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({
        agentDir,
        explicitProviders: {
          ollama: {
            baseUrl: "http://192.168.20.14:11434/v1",
            api: "openai-completions",
            models: [],
          },
        },
      });

      // Native API strips /v1 suffix via resolveOllamaApiBase()
      expect(providers?.ollama?.baseUrl).toBe("http://192.168.20.14:11434");
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("keeps configured ollama models available when discovery fails", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({
        agentDir,
        config: {
          agents: {
            defaults: {
              model: {
                primary: "ollama/gemma4:e4b",
                fallbacks: ["openai-codex/gpt-5.4"],
              },
            },
            list: [
              {
                id: "chief",
                model: {
                  primary: "ollama/gemma4:e4b",
                  fallbacks: ["ollama/gemma4:26b"],
                  policy: "local_only",
                },
              },
            ],
          },
        },
      });

      expect(providers?.ollama?.models.map((model) => model.id)).toEqual([
        "gemma4:e4b",
        "gemma4:26b",
      ]);
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("should have correct model structure without streaming override", () => {
    const mockOllamaModel = {
      id: "llama3.3:latest",
      name: "llama3.3:latest",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };

    // Native Ollama provider does not need streaming: false workaround
    expect(mockOllamaModel).not.toHaveProperty("params");
  });
});
