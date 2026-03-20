export type MemoryPromptInjectionMode = "off" | "new_sessions" | "always";

export const DEFAULT_MEMORY_PROMPT_INJECTION_MODE: MemoryPromptInjectionMode = "always";

export function resolveMemoryPromptInjectionMode(
  pluginConfig: Record<string, unknown> | undefined,
): MemoryPromptInjectionMode {
  const explicitMode =
    typeof pluginConfig?.memoryPromptInjectionMode === "string"
      ? pluginConfig.memoryPromptInjectionMode.trim()
      : "";
  if (explicitMode === "off" || explicitMode === "new_sessions" || explicitMode === "always") {
    return explicitMode;
  }

  if (pluginConfig?.injectMemoryInPrompt === true) {
    return "always";
  }

  return DEFAULT_MEMORY_PROMPT_INJECTION_MODE;
}

export function resolveMemoryInjectionSessionKey(ctx: {
  sessionId?: string;
  sessionKey?: string;
}): string | null {
  if (typeof ctx.sessionId === "string" && ctx.sessionId.trim()) {
    return `session:${ctx.sessionId.trim()}`;
  }
  if (typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()) {
    return `key:${ctx.sessionKey.trim()}`;
  }
  return null;
}

export function shouldInjectMemoryForSession(
  mode: MemoryPromptInjectionMode,
  sessionKey: string | null,
  seenSessions: Set<string>,
): boolean {
  if (mode === "off") {
    return false;
  }
  if (mode === "always") {
    return true;
  }
  if (!sessionKey) {
    return true;
  }
  return !seenSessions.has(sessionKey);
}
