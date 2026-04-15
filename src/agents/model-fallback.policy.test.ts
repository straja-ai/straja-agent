import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runWithModelFallback } from "./model-fallback.js";

function makeCfg(primary: string, fallbacks: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary,
          fallbacks,
        },
      },
    },
  } as OpenClawConfig;
}

describe("runWithModelFallback routing policy", () => {
  it("keeps configured order when policy is hybrid", async () => {
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg: makeCfg("openai/gpt-5.4", ["anthropic/claude-sonnet-4-5", "ollama/gemma4:26b"]),
      provider: "openai",
      model: "gpt-5.4",
      policyOverride: "hybrid",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([["openai-codex", "gpt-5.4"]]);
  });

  it("filters local candidates entirely when policy is cloud only", async () => {
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg: makeCfg("openai/gpt-5.4", ["ollama/gemma4:e4b", "anthropic/claude-sonnet-4-5"]),
      provider: "openai",
      model: "gpt-5.4",
      policyOverride: "cloud_only",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([["openai-codex", "gpt-5.4"]]);
  });

  it("filters cloud candidates entirely when policy is local only", async () => {
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg: makeCfg("ollama/gemma4:e4b", ["openai/gpt-5.4", "ollama/gemma4:26b"]),
      provider: "ollama",
      model: "gemma4:e4b",
      policyOverride: "local_only",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([["ollama", "gemma4:e4b"]]);
  });

  it("fails clearly when local-only policy leaves no eligible candidates", async () => {
    const run = vi.fn();

    await expect(
      runWithModelFallback({
        cfg: makeCfg("openai/gpt-5.4", ["anthropic/claude-sonnet-4-5"]),
        provider: "openai",
        model: "gpt-5.4",
        policyOverride: "local_only",
        run,
      }),
    ).rejects.toThrow(
      "No eligible models remain after applying the agent's local-only routing policy.",
    );
    expect(run).not.toHaveBeenCalled();
  });
});
