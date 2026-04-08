import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  guardModelRequest,
  guardModelResponse,
  guardToolParams,
  guardToolResult,
  replaceMessageTextContent,
} from "./straja-guard.js";

describe("straja guard standalone helpers", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    process.env.STRAJA_GUARD_URL = "http://127.0.0.1:18080";
    process.env.STRAJA_GUARD_PROJECT_ID = "dev_workspace";
    process.env.STRAJA_GUARD_PROJECT_KEY = "guard-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...envSnapshot };
  });

  it("rewrites the prompt when guard redacts the model request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            decision: "redact",
            sanitized_text: "hello [REDACTED]",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await guardModelRequest({
      requestId: "req-1",
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      prompt: "hello secret",
      sessionId: "session-1",
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe("hello [REDACTED]");
  });

  it("blocks tool params when guard rejects the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "prompt_injection",
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await guardToolParams({
      requestId: "tool-1",
      toolName: "read",
      toolParams: { path: "/tmp/secret.txt" },
      sessionId: "session-1",
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("prompt_injection");
  });

  it("fails open when guard is rate limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "Too many requests",
            },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await guardModelRequest({
      requestId: "req-rate-limit",
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      prompt: "hello",
      sessionId: "session-1",
    });

    expect(result.checked).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe("hello");
  });

  it("fails open for response-side jailbreak-only blocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            decision: "block",
            reasons: [{ category: "jailbreak" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await guardModelResponse({
      requestId: "resp-jailbreak-only",
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      outputText: "Here are the latest headlines I can see right now...",
      sessionId: "session-1",
    });

    expect(result.checked).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe("Here are the latest headlines I can see right now...");
  });

  it("fails open for response-side prompt injection policy blocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "prompt_injection",
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await guardModelResponse({
      requestId: "resp-prompt-injection-policy",
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      outputText: "Latest news summary",
      sessionId: "session-1",
    });

    expect(result.checked).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe("Latest news summary");
  });

  it("still blocks response-side secrets hits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            decision: "block",
            reasons: [{ category: "secrets" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await guardModelResponse({
      requestId: "resp-secrets-block",
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      outputText: "OPENAI_API_KEY=sk-secret",
      sessionId: "session-1",
    });

    expect(result.checked).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("secrets");
  });

  it("ignores response-side prompt injection redaction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            decision: "redact",
            sanitized_text: "sanitized",
            reasons: [{ category: "prompt_injection" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await guardModelResponse({
      requestId: "resp-prompt-redact",
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      outputText: "Original output",
      sessionId: "session-1",
    });

    expect(result.checked).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe("Original output");
  });

  it("rewrites sanitized tool results back into structured JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            decision: "redact",
            sanitized_text: JSON.stringify({
              content: [{ type: "text", text: '{"secret":"[REDACTED]"}' }],
              details: { secret: "[REDACTED]" },
            }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await guardToolResult({
      requestId: "tool-2",
      toolName: "read",
      result: {
        content: [{ type: "text", text: '{"secret":"abc"}' }],
        details: { secret: "abc" },
      },
      sessionId: "session-1",
    });

    expect(result.blocked).toBe(false);
    expect((result.result as { details?: { secret?: string } }).details?.secret).toBe("[REDACTED]");
  });

  it("ignores jailbreak-only tool result blocks", async () => {
    const originalResult = {
      content: [{ type: "text", text: "tool output" }],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            decision: "block",
            reasons: [{ category: "jailbreak" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await guardToolResult({
      requestId: "tool-jailbreak-output",
      toolName: "search",
      result: originalResult,
      sessionId: "session-1",
    });

    expect(result.blocked).toBe(false);
    expect(result.result).toEqual(originalResult);
  });

  it("ignores prompt injection-only tool result redactions", async () => {
    const originalResult = {
      content: [{ type: "text", text: "tool output" }],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            decision: "redact",
            sanitized_text: JSON.stringify({
              content: [{ type: "text", text: "sanitized tool output" }],
            }),
            reasons: [{ category: "prompt_injection" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await guardToolResult({
      requestId: "tool-prompt-redact-output",
      toolName: "search",
      result: originalResult,
      sessionId: "session-1",
    });

    expect(result.blocked).toBe(false);
    expect(result.result).toEqual(originalResult);
  });

  it("replaces text content blocks in-place", () => {
    const message = {
      content: [
        { type: "text", text: "before" },
        { type: "image", url: "x" },
      ],
    };

    replaceMessageTextContent(message, "after");

    expect(message.content).toEqual([
      { type: "text", text: "after" },
      { type: "image", url: "x" },
    ]);
  });
});
