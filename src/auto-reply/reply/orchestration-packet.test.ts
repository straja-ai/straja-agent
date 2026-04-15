import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildOrchestrationPacket } from "./orchestration-packet.js";
import { buildTestCtx } from "./test-ctx.js";

describe("orchestration-packet", () => {
  it("uses the router tool family to narrow the tool subset", async () => {
    const packet = await buildOrchestrationPacket({
      cfg: {} as OpenClawConfig,
      ctx: buildTestCtx({
        CommandAuthorized: true,
      }),
      body: "Draft an email to the parent",
      currentAgentId: "main",
      localFastPath: false,
      routerDecision: {
        source: "model",
        selectedAgentId: "main",
        selectedAgentReason: "selected by local router model",
        candidates: [],
        taskClass: "complex_turn",
        suggestedRoute: "default_specialist",
        confidence: 0.81,
        toolFamily: "email",
        memoryQuery: "parent email",
        vaultQuery: "parent email",
        reasons: ["needs email drafting"],
      },
    });

    expect(packet.toolAllowlist).toEqual(
      expect.arrayContaining(["vault_gmail_create_draft", "vault_gmail_update_draft"]),
    );
    expect(packet.packetText).toContain("Router tool family: email");
    expect(packet.packetText).toContain("Router reasons: needs email drafting");
  });
});
