import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistOrchestrationPromptInput,
  persistOrchestrationPromptOutput,
  persistOrchestrationRunSnapshot,
} from "./orchestration-vault.js";

const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");

describe("orchestration-vault", () => {
  const originalFetch = global.fetch;
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    (globalThis as Record<symbol, unknown>)[VAULT_READER_KEY] = "http://vault.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const key = decodeURIComponent(url.split("/raw/_orchestration/")[1] ?? "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          const existing = store.get(key);
          if (existing == null) {
            return new Response("not found", { status: 404 });
          }
          return new Response(existing, { status: 200 });
        }
        if (method === "PUT") {
          store.set(
            key,
            typeof init?.body === "string" ? init.body : JSON.stringify(init?.body ?? ""),
          );
          return new Response("ok", { status: 200 });
        }
        return new Response("bad method", { status: 405 });
      }),
    );
  });

  afterEach(() => {
    if (originalFetch) {
      vi.stubGlobal("fetch", originalFetch);
    } else {
      vi.unstubAllGlobals();
    }
    delete (globalThis as Record<symbol, unknown>)[VAULT_READER_KEY];
  });

  it("merges orchestration run snapshots in vault", async () => {
    await persistOrchestrationRunSnapshot({
      traceId: "trace-1",
      snapshot: {
        traceId: "trace-1",
        status: "route_evaluated",
        inbound: { body: "hello" },
      },
    });
    await persistOrchestrationRunSnapshot({
      traceId: "trace-1",
      snapshot: {
        traceId: "trace-1",
        status: "dispatch_completed",
        replyResult: { text: "ok" },
      },
    });

    const stored = store.get("runs/trace-1.json");
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored ?? "{}") as Record<string, unknown>;
    expect(parsed.status).toBe("dispatch_completed");
    expect(parsed.inbound).toEqual({ body: "hello" });
    expect(parsed.replyResult).toEqual({ text: "ok" });
  });

  it("writes exact prompt input and output payloads into vault paths", async () => {
    await persistOrchestrationPromptInput({
      traceId: "trace-2",
      runId: "run-a",
      sessionId: "session-a",
      provider: "ollama",
      model: "gemma4:4b",
      systemPrompt: "system",
      prompt: "user prompt",
      historyMessages: [{ role: "user", content: "hello" }],
      imagesCount: 0,
    });
    await persistOrchestrationPromptOutput({
      traceId: "trace-2",
      runId: "run-a",
      sessionId: "session-a",
      provider: "ollama",
      model: "gemma4:4b",
      assistantTexts: ["done"],
      usage: { input: 10, output: 5 },
    });

    const input = store.get("prompts/trace-2/run-a-input.json");
    const output = store.get("prompts/trace-2/run-a-output.json");
    expect(input).toContain('"prompt":"user prompt"');
    expect(input).toContain('"systemPrompt":"system"');
    expect(output).toContain('"assistantTexts":["done"]');
    expect(output).toContain('"input":10');
  });
});
