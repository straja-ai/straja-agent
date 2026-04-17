import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaStreamFn } from "./ollama-stream.js";

function encodeLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

describe("createOllamaStreamFn", () => {
  afterEach(() => {
    const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");
    delete (globalThis as Record<symbol, unknown>)[VAULT_READER_KEY];
    delete process.env.STRAJA_OLLAMA_BASE_URL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("emits incremental text events before the final done message", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        encodeLines([
          `${JSON.stringify({
            model: "gemma4:e4b",
            created_at: "2026-04-09T00:00:00Z",
            message: { role: "assistant", content: "He" },
            done: false,
          })}\n`,
          `${JSON.stringify({
            model: "gemma4:e4b",
            created_at: "2026-04-09T00:00:01Z",
            message: { role: "assistant", content: "llo" },
            done: false,
          })}\n`,
          `${JSON.stringify({
            model: "gemma4:e4b",
            created_at: "2026-04-09T00:00:02Z",
            message: { role: "assistant", content: "" },
            done: true,
            prompt_eval_count: 12,
            eval_count: 3,
          })}\n`,
        ]),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const stream = createOllamaStreamFn("http://127.0.0.1:11435")(
      {
        id: "gemma4:e4b",
        api: "ollama",
        provider: "ollama",
        contextWindow: 128_000,
      } as never,
      {
        systemPrompt: "You are helpful.",
        messages: [],
      },
      { think: false },
    );

    const events: Array<{ type: string; delta?: string }> = [];
    for await (const event of stream) {
      events.push({
        type: event.type,
        delta: "delta" in event ? event.delta : undefined,
      });
    }

    expect(events.map((event) => event.type)).toEqual([
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ).toEqual(["He", "llo"]);

    const finalMessage = await stream.result();
    expect(finalMessage.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(finalMessage.model).toBe("gemma4:e4b");
    const fetchInit = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const requestBody = fetchInit?.body ? JSON.parse(fetchInit.body) : null;
    expect(requestBody).toEqual(
      expect.objectContaining({
        think: false,
        messages: [expect.objectContaining({ role: "system", content: "You are helpful." })],
      }),
    );
  });

  it("starts the managed local runtime on demand before inference", async () => {
    const VAULT_READER_KEY = Symbol.for("openclaw.vaultReaderBaseUrl");
    process.env.STRAJA_OLLAMA_BASE_URL = "http://127.0.0.1:11435";
    (globalThis as Record<symbol, unknown>)[VAULT_READER_KEY] = "http://vault.test";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          encodeLines([
            `${JSON.stringify({
              model: "gemma4:e4b",
              created_at: "2026-04-15T00:00:00Z",
              message: { role: "assistant", content: "Hello" },
              done: false,
            })}\n`,
            `${JSON.stringify({
              model: "gemma4:e4b",
              created_at: "2026-04-15T00:00:01Z",
              message: { role: "assistant", content: "" },
              done: true,
              prompt_eval_count: 4,
              eval_count: 2,
            })}\n`,
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const stream = createOllamaStreamFn("http://127.0.0.1:11435")(
      {
        id: "gemma4:e4b",
        api: "ollama",
        provider: "ollama",
        contextWindow: 128_000,
      } as never,
      {
        systemPrompt: "You are helpful.",
        messages: [],
      },
      { think: false },
    );

    await stream.result();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:11435/api/tags",
      "http://vault.test/connections/agents/ollama/runtime/start",
      "http://127.0.0.1:11435/api/tags",
      "http://127.0.0.1:11435/api/chat",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});
