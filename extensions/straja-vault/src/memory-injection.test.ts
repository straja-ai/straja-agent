import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_PROMPT_INJECTION_MODE,
  resolveMemoryInjectionSessionKey,
  resolveMemoryPromptInjectionMode,
  shouldInjectMemoryForSession,
} from "./memory-injection.js";

describe("memory prompt injection", () => {
  it("defaults to always when unset", () => {
    expect(resolveMemoryPromptInjectionMode(undefined)).toBe(DEFAULT_MEMORY_PROMPT_INJECTION_MODE);
  });

  it("supports explicit enum modes", () => {
    expect(resolveMemoryPromptInjectionMode({ memoryPromptInjectionMode: "off" })).toBe("off");
    expect(resolveMemoryPromptInjectionMode({ memoryPromptInjectionMode: "new_sessions" })).toBe(
      "new_sessions",
    );
    expect(resolveMemoryPromptInjectionMode({ memoryPromptInjectionMode: "always" })).toBe(
      "always",
    );
  });

  it("keeps backward compatibility with injectMemoryInPrompt=true and ignores legacy false defaults", () => {
    expect(resolveMemoryPromptInjectionMode({ injectMemoryInPrompt: false })).toBe("always");
    expect(resolveMemoryPromptInjectionMode({ injectMemoryInPrompt: true })).toBe("always");
  });

  it("uses session id before session key", () => {
    expect(resolveMemoryInjectionSessionKey({ sessionId: "abc", sessionKey: "fallback" })).toBe(
      "session:abc",
    );
    expect(resolveMemoryInjectionSessionKey({ sessionKey: "fallback" })).toBe("key:fallback");
  });

  it("injects once per session in new_sessions mode", () => {
    const seen = new Set<string>();
    expect(shouldInjectMemoryForSession("new_sessions", "session:1", seen)).toBe(true);
    seen.add("session:1");
    expect(shouldInjectMemoryForSession("new_sessions", "session:1", seen)).toBe(false);
    expect(shouldInjectMemoryForSession("always", "session:1", seen)).toBe(true);
    expect(shouldInjectMemoryForSession("off", "session:1", seen)).toBe(false);
  });
});
