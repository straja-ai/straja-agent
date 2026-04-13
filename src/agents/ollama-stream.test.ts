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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("emits incremental text events before the final done message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
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
      }),
    );

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
      {},
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
  });
});
