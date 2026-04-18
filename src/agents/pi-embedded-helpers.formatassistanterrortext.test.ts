import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { formatAssistantErrorText } from "./pi-embedded-helpers.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

describe("formatAssistantErrorText Codex auth recovery", () => {
  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    makeAssistantMessageFixture({
      errorMessage,
      content: [{ type: "text", text: errorMessage }],
    });

  it("tells the user to re-authenticate Codex for 403 html failures", () => {
    const msg = makeAssistantError("403 <html><body>Access denied</body></html>");
    const result = formatAssistantErrorText(msg, { provider: "openai-codex" });
    expect(result).toContain("re-authenticate Codex");
  });

  it("tells the user to re-authenticate Codex when no auth profile remains", () => {
    const msg = makeAssistantError(
      "No available auth profile for openai-codex (all in cooldown or unavailable).",
    );
    const result = formatAssistantErrorText(msg, { provider: "openai-codex" });
    expect(result).toContain("re-authenticate Codex");
  });

  it("tells the user to re-authenticate Codex when a cloud-only agent has no eligible model", () => {
    const msg = makeAssistantError(
      "No eligible models remain after applying the agent's cloud-only routing policy.",
    );
    const result = formatAssistantErrorText(msg, {
      provider: "openai-codex",
      model: "gpt-5.4",
    });
    expect(result).toContain("cloud-only agent");
    expect(result).toContain("re-authenticate Codex");
  });
});
