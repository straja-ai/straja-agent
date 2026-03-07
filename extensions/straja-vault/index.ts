import { execFileSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerAuditPatch } from "./src/audit-patch.js";
import { registerAuthProfilesPatch } from "./src/auth-profiles-patch.js";
import { registerBootstrapPatch } from "./src/bootstrap-patch.js";
import { registerCredentialsPatch } from "./src/credentials-patch.js";
import { registerCronStorePatch } from "./src/cron-store-patch.js";
import { registerDeliveryQueuePatch } from "./src/delivery-queue-patch.js";
import { registerFsToolsPatch } from "./src/fs-tools-patch.js";
import { registerGatewayWorkspacePatch } from "./src/gateway-workspace-patch.js";
import {
  appendVaultProbeCurlArgs,
  formatVaultCurlError,
  registerVaultAuthToken,
  vaultFetch,
} from "./src/http.js";
import { registerLogsPatch } from "./src/logs-patch.js";
import { registerSessionPatch } from "./src/session-patch.js";
import { registerSessionStorePatch } from "./src/session-store-patch.js";
import { registerSubagentRegistryPatch } from "./src/subagent-registry-patch.js";
import { createVaultTools } from "./src/tools.js";

const DEFAULT_BASE_URL = "http://localhost:8181";

function normalizeVaultBaseUrl(raw: string | undefined): string {
  const candidate = (raw ?? "").trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid vault base URL: ${candidate}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Vault base URL must use http/https: ${candidate}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Vault base URL must not include credentials");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function assertVaultReachable(baseUrl: string): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  const probeUrl = `${baseUrl}/raw/_workspace/${encodeURIComponent("__vault_required_probe__")}`;
  try {
    const result = execFileSync(
      "curl",
      appendVaultProbeCurlArgs(["-s", "-w", "\n%{http_code}", "-X", "GET", probeUrl]),
      {
        encoding: "utf-8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const statusRaw = result.trimEnd().split("\n").pop() || "0";
    const status = Number.parseInt(statusRaw, 10);
    if (!Number.isFinite(status) || status <= 0 || status >= 500) {
      throw new Error(`HTTP ${status}`);
    }
  } catch (err: unknown) {
    const msg = formatVaultCurlError(err);
    throw new Error(`Vault is required but unreachable at ${baseUrl}: ${msg}`);
  }
}

// Prevent double-patching across hot-reloads
let sessionPatched = false;
let fsToolsPatched = false;
let bootstrapPatched = false;
let gatewayWorkspacePatched = false;
let cronStorePatched = false;
let sessionStorePatched = false;
let subagentRegistryPatched = false;
let authProfilesPatched = false;
let credentialsPatched = false;
let deliveryQueuePatched = false;
let logsPatched = false;
let auditPatched = false;
let hookRegistered = false;
let promptHookRegistered = false;

// ---------------------------------------------------------------------------
// Lightweight cache for MEMORY.md content injection.
// Avoids hitting the vault HTTP server on every single LLM turn.
// Cache is per-process and refreshed every 60 seconds.
// ---------------------------------------------------------------------------
const MEMORY_CACHE_TTL_MS = 60_000;
let memoryCacheContent: string | null = null;
let memoryCacheTs = 0;

/** Invalidate the MEMORY.md cache (e.g. after a vault_memory_write to MEMORY.md). */
export function invalidateMemoryCache() {
  memoryCacheTs = 0;
}

async function fetchMemoryContent(baseUrl: string): Promise<string | null> {
  const now = Date.now();
  if (memoryCacheContent !== null && now - memoryCacheTs < MEMORY_CACHE_TTL_MS) {
    return memoryCacheContent;
  }

  try {
    const resp = await vaultFetch(`${baseUrl}/raw/_memory/${encodeURIComponent("MEMORY.md")}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const text = await resp.text();
      const trimmed = text.trim();
      memoryCacheContent = trimmed || null;
      memoryCacheTs = now;
      return memoryCacheContent;
    }
    // 404 or similar — no MEMORY.md yet
    memoryCacheContent = null;
    memoryCacheTs = now;
    return null;
  } catch {
    // Vault unreachable — use stale cache if available, else null
    return memoryCacheContent;
  }
}

/**
 * Strip injected system metadata from user messages before saving to memory.
 * Removes: <persistent_memory> blocks, conversation metadata JSON blocks,
 * session-start system instructions, and timestamp prefixes.
 */
function cleanUserMessage(text: string): string {
  let cleaned = text;

  // Remove <persistent_memory>...</persistent_memory> blocks (our injection)
  cleaned = cleaned.replace(/<persistent_memory>[\s\S]*?<\/persistent_memory>/g, "");

  // Remove "Conversation info (untrusted metadata):" + JSON code block
  cleaned = cleaned.replace(
    /Conversation info \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```/g,
    "",
  );

  // Remove session-start system instructions (various forms).
  // These are injected by OpenClaw when a session starts via /new or /reset.
  cleaned = cleaned.replace(
    /A new session was started via \/new or \/reset\.[^\n]*(?:\n[^\n]*)*?(?:Do not mention internal steps[^\n]*\.)/g,
    "",
  );
  // Also match the greeting instruction block without the "A new session" prefix
  cleaned = cleaned.replace(
    /Greet the user in your configured persona[^\n]*(?:\n[^\n]*)*?(?:Do not mention internal steps[^\n]*\.)/g,
    "",
  );

  // Remove timestamp prefixes like "[Sat 2026-02-21 22:06 GMT+1] "
  cleaned = cleaned.replace(/^\[.*?\]\s*/gm, "");

  // Collapse whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}

const plugin = {
  id: "straja-vault",
  kind: "memory" as const,
  name: "Straja Vault",
  description:
    "Vault-backed document store, file I/O, sandboxed execution, and persistent memory. " +
    "Replaces native memory-core with vault-backed memory (search, get, write) in the _memory collection.",
  configSchema: {
    safeParse(value: unknown) {
      if (value === undefined) {
        return { success: true, data: undefined } as const;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "expected config object" }] },
        } as const;
      }
      return { success: true, data: value } as const;
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        injectMemoryInPrompt: {
          type: "boolean",
          description:
            "Inject MEMORY.md content into every LLM prompt via before_prompt_build hook. Useful for smaller models that don't proactively call vault_memory_search. Default: false.",
        },
        baseUrl: {
          type: "string",
          description: "Vault HTTP API base URL. Default: http://localhost:8181",
        },
        authToken: {
          type: "string",
          description:
            "Bearer token used when the vault requires paired-agent authorization. " +
            "Can also be set via STRAJA_VAULT_TOKEN.",
        },
        debugLogPrompt: {
          type: "boolean",
          description:
            "Save the full LLM prompt (system + history + user message) to vault on each turn. View at /raw/_workspace/_debug/last-prompt.json. Default: false.",
        },
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const baseUrl = normalizeVaultBaseUrl(
      ((api.pluginConfig?.baseUrl as string) || process.env.STRAJA_VAULT_URL) ?? undefined,
    );
    registerVaultAuthToken(
      ((api.pluginConfig?.authToken as string) || process.env.STRAJA_VAULT_TOKEN) ?? undefined,
    );
    assertVaultReachable(baseUrl);

    // Register tools synchronously so they are available immediately.
    const tools = createVaultTools(baseUrl, {
      onMemoryWrite: (path) => {
        // Invalidate the MEMORY.md prompt-injection cache when MEMORY.md is written
        if (path.toLowerCase() === "memory.md") {
          invalidateMemoryCache();
        }
      },
    });
    for (const tool of tools) {
      api.registerTool(tool);
    }
    api.logger.info(`Straja Vault plugin registered (${tools.length} tools, url: ${baseUrl})`);

    // Register a session patch callback on globalThis.
    // This callback will be invoked by flushPluginSetup() in attempt.ts
    // with the REAL SessionManager class from the bundle, bypassing
    // Jiti's module isolation.
    if (!sessionPatched) {
      registerSessionPatch(baseUrl);
      sessionPatched = true;
      api.logger.info("Session persistence patch registered (will apply before session open)");
    }

    // Register FS tools patch — routes read/write/edit through vault.
    // The callback is invoked from pi-tools.ts when creating file tools,
    // passing the workspace root so paths can be converted to vault keys.
    if (!fsToolsPatched) {
      registerFsToolsPatch(baseUrl);
      fsToolsPatched = true;
      api.logger.info("FS tools patch registered (read/write/edit → vault)");
    }

    // Register bootstrap patch — routes workspace .md files through vault.
    // The callback is invoked from workspace.ts when loading bootstrap files
    // (AGENTS.md, SOUL.md, TOOLS.md, etc.). All reads go to the vault's
    // _bootstrap collection — no disk access.
    if (!bootstrapPatched) {
      registerBootstrapPatch(baseUrl);
      bootstrapPatched = true;
      api.logger.info(
        "Bootstrap patch registered (workspace .md files → vault _workspace collection)",
      );
    }

    // Register gateway workspace patch — routes gateway file list/get/set,
    // identity file loading, workspace state, and auth JSON through vault.
    if (!gatewayWorkspacePatched) {
      registerGatewayWorkspacePatch(baseUrl);
      gatewayWorkspacePatched = true;
      api.logger.info(
        "Gateway workspace patch registered (file ops → vault _workspace collection)",
      );
    }

    // Register cron store patch — routes cron job storage and run logs
    // through vault's _cron collection instead of filesystem.
    if (!cronStorePatched) {
      registerCronStorePatch(baseUrl);
      cronStorePatched = true;
      api.logger.info("Cron store patch registered (jobs + run logs → vault _cron collection)");
    }

    // Register session-store patch — routes sessions.json load/save through vault.
    if (!sessionStorePatched) {
      registerSessionStorePatch(baseUrl);
      sessionStorePatched = true;
      api.logger.info("Session store patch registered (sessions.json → vault _sessions_store)");
    }

    // Register subagent registry patch — routes subagents/runs.json through vault.
    if (!subagentRegistryPatched) {
      registerSubagentRegistryPatch(baseUrl);
      subagentRegistryPatched = true;
      api.logger.info("Subagent registry patch registered (runs.json → vault _subagents)");
    }

    // Register auth-profiles patch — routes auth-profiles.json through vault.
    if (!authProfilesPatched) {
      registerAuthProfilesPatch(baseUrl);
      authProfilesPatched = true;
      api.logger.info("Auth profiles patch registered (auth-profiles.json → vault _auth_profiles)");
    }

    // Register credentials patch — routes pairing/allowFrom files through vault.
    if (!credentialsPatched) {
      registerCredentialsPatch(baseUrl);
      credentialsPatched = true;
      api.logger.info("Credentials patch registered (pairing/allowFrom → vault _credentials)");
    }

    // Register delivery queue patch — routes delivery-queue/*.json through vault.
    if (!deliveryQueuePatched) {
      registerDeliveryQueuePatch(baseUrl);
      deliveryQueuePatched = true;
      api.logger.info("Delivery queue patch registered (delivery-queue → vault _delivery_queue)");
    }

    // Register logs patch — routes commands.log + config-audit.jsonl through vault.
    if (!logsPatched) {
      registerLogsPatch(baseUrl);
      logsPatched = true;
      api.logger.info("Logs patch registered (commands.log + config-audit.jsonl → vault _logs)");
    }

    // Register audit patch — routes agent-side audit entries through vault _audit.
    if (!auditPatched) {
      registerAuditPatch(baseUrl);
      auditPatched = true;
      api.logger.info("Audit patch registered (audit entries → vault _audit collection)");
    }

    // Register vault-backed session memory hook.
    // Replaces the native session-memory hook (which writes to disk via fs.writeFile).
    // On /new command, saves session summary to the vault's _memory collection.
    if (!hookRegistered) {
      api.registerHook(
        "command:new",
        async (event) => {
          try {
            const context = event.context || {};
            const sessionEntry = (context.previousSessionEntry ||
              context.sessionEntry ||
              {}) as Record<string, unknown>;

            const now = new Date(event.timestamp);
            const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
            const timeStr = now.toISOString().split("T")[1].split(".")[0]; // HH:MM:SS

            const sessionId = (sessionEntry.sessionId as string) || "unknown";
            const source = (context.commandSource as string) || "unknown";

            // Read recent session content from the vault's _sessions collection.
            // Sessions are stored by session ID (UUID), not session key.
            const vaultSessionPath =
              sessionId !== "unknown" ? `${sessionId}.jsonl` : event.sessionKey;
            let sessionContent: string | null = null;

            try {
              const resp = await vaultFetch(
                `${baseUrl}/raw/_sessions/${encodeURIComponent(vaultSessionPath)}`,
              );
              if (resp.ok) {
                const raw = await resp.text();
                // Parse JSONL and extract recent user/assistant messages
                const messages: string[] = [];
                for (const line of raw.trim().split("\n")) {
                  try {
                    const entry = JSON.parse(line);
                    if (entry.type === "message" && entry.message) {
                      const msg = entry.message;
                      if ((msg.role === "user" || msg.role === "assistant") && msg.content) {
                        let text = Array.isArray(msg.content)
                          ? msg.content.find(
                              (c: { type: string; text?: string }) => c.type === "text",
                            )?.text
                          : msg.content;
                        if (!text || text.startsWith("/")) continue;

                        // Strip injected system metadata from user messages so
                        // daily memory files only contain actual conversation.
                        if (msg.role === "user") {
                          text = cleanUserMessage(text);
                        }
                        if (text) {
                          messages.push(`${msg.role}: ${text}`);
                        }
                      }
                    }
                  } catch {
                    // Skip invalid JSON lines
                  }
                }
                // Take last 15 messages
                sessionContent = messages.slice(-15).join("\n");
              }
            } catch {
              // If vault read fails, proceed without session content
            }

            // Build markdown entry
            const entryParts = [
              `# Session: ${dateStr} ${timeStr} UTC`,
              "",
              `- **Session Key**: ${event.sessionKey}`,
              `- **Session ID**: ${sessionId}`,
              `- **Source**: ${source}`,
              "",
            ];

            if (sessionContent) {
              entryParts.push("## Conversation Summary", "", sessionContent, "");
            }

            const entry = entryParts.join("\n");

            // Write to vault _memory collection (append to daily file)
            const memoryPath = `memory/${dateStr}.md`;
            const writeResp = await vaultFetch(
              `${baseUrl}/raw/_memory/${encodeURIComponent(memoryPath)}/append`,
              { method: "POST", body: entry },
            );

            if (writeResp.ok) {
              api.logger.info(`Session memory saved to _memory/${memoryPath}`);

              // Fire-and-forget: trigger embedding
              vaultFetch(`${baseUrl}/embed`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              }).catch(() => {});
            } else {
              api.logger.error(`Failed to save session memory: ${writeResp.status}`);
            }
          } catch (err) {
            api.logger.error(`Session memory hook error: ${String(err)}`);
          }
        },
        { name: "vault-session-memory" },
      );

      hookRegistered = true;
      api.logger.info("Vault session-memory hook registered (command:new → _memory)");
    }

    // -----------------------------------------------------------------------
    // before_prompt_build hook: inject MEMORY.md into the LLM context.
    //
    // Many smaller models (e.g. gpt-4.1-mini) don't proactively call
    // vault_memory_search before answering identity/preference questions.
    // By injecting MEMORY.md as prependContext, the model has persistent
    // knowledge available in its context window from the very first turn —
    // no tool call required.
    //
    // Controlled by pluginConfig.injectMemoryInPrompt (default: false).
    // When bootstrap files are vault-sourced, the agent already has
    // instructions to use vault_memory_search — this injection is redundant.
    // -----------------------------------------------------------------------
    const injectMemoryInPrompt = api.pluginConfig?.injectMemoryInPrompt === true;
    if (!promptHookRegistered && injectMemoryInPrompt) {
      api.on(
        "before_prompt_build",
        async (_event, _ctx) => {
          const memoryContent = await fetchMemoryContent(baseUrl);
          if (!memoryContent) {
            return;
          }
          return {
            prependContext:
              `<persistent_memory>\n` +
              `The following is your persistent memory from previous sessions. ` +
              `Use this information when answering questions about your identity, ` +
              `the user's preferences, prior decisions, or anything discussed before.\n\n` +
              `${memoryContent}\n` +
              `</persistent_memory>`,
          };
        },
        { priority: 10 },
      );
      promptHookRegistered = true;
      api.logger.info("Memory context injection hook registered (before_prompt_build → MEMORY.md)");
    } else if (!promptHookRegistered) {
      promptHookRegistered = true;
      api.logger.info(
        "Memory prompt injection disabled (injectMemoryInPrompt: false). Agent uses vault_memory_search instead.",
      );
    }

    // -----------------------------------------------------------------------
    // llm_input hook: save the full LLM prompt to vault for debugging.
    //
    // When enabled, writes the complete prompt (system prompt with all
    // bootstrap files, conversation history, and current user message) to
    // _workspace/_debug/last-prompt.json on every LLM turn.
    //
    // Controlled by pluginConfig.debugLogPrompt (default: false).
    // -----------------------------------------------------------------------
    const debugLogPrompt = api.pluginConfig?.debugLogPrompt === true;
    if (debugLogPrompt) {
      api.on("llm_input", async (event) => {
        const payload = {
          timestamp: new Date().toISOString(),
          runId: event.runId,
          sessionId: event.sessionId,
          provider: event.provider,
          model: event.model,
          systemPrompt: event.systemPrompt,
          prompt: event.prompt,
          historyMessages: event.historyMessages,
          imagesCount: event.imagesCount,
        };
        vaultFetch(`${baseUrl}/raw/_workspace/_debug/last-prompt.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload, null, 2),
          signal: AbortSignal.timeout(3000),
        }).catch((err) => {
          api.logger.warn(`debugLogPrompt write failed: ${String(err)}`);
        });
      });
      api.logger.info("Debug prompt logging enabled → vault _workspace/_debug/last-prompt.json");
    }
  },
};

export default plugin;
