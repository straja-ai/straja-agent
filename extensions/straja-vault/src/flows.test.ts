import { afterEach, describe, expect, it } from "vitest";
import { buildInboundFlowPromptContext, resetFlowCache } from "./flows.js";

afterEach(() => {
  resetFlowCache();
});

describe("buildInboundFlowPromptContext", () => {
  it("matches sender + channel and renders template vars", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/collections/_flows/files")) {
        return new Response(JSON.stringify([{ path: "parent-absence.json" }]), { status: 200 });
      }
      if (url.includes("/raw/_flows/")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            name: "Parent absence",
            trigger: {
              channels: ["whatsapp"],
              senders: ["+491234"],
            },
            vars: {
              student_name: "Mara",
              file_path: "Prezenta elevi.md",
            },
            instruction:
              "If the message means {{student_name}} is absent, update {{file_path}} and reply politely.",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const result = await buildInboundFlowPromptContext({
      baseUrl: "http://vault.test",
      fetchImpl,
      event: {
        from: "+491234",
        content: "Mara nu vine maine",
        metadata: { senderE164: "+491234" },
      },
      ctx: {
        channelId: "whatsapp",
        conversationId: "+491234",
      },
    });

    expect(result).toContain("Parent absence");
    expect(result).toContain("Mara");
    expect(result).toContain("Prezenta elevi.md");
  });

  it("returns undefined when no flow matches", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/collections/_flows/files")) {
        return new Response(JSON.stringify([{ path: "other.json" }]), { status: 200 });
      }
      if (url.includes("/raw/_flows/")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            trigger: { channels: ["telegram"], senders: ["123"] },
            instruction: "Never used",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const result = await buildInboundFlowPromptContext({
      baseUrl: "http://vault.test",
      fetchImpl,
      event: {
        from: "+491234",
        content: "hello",
      },
      ctx: {
        channelId: "whatsapp",
        conversationId: "+491234",
      },
    });

    expect(result).toBeUndefined();
  });
});
