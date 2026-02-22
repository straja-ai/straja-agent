import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const VaultSearchSchema = Type.Object({
  query: Type.String({
    description:
      "Natural language question or keywords to search for in the document vault. " +
      "The search runs a hybrid pipeline (keyword + semantic + hypothetical document) for best recall.",
  }),
  collections: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter to specific collections (by name). Omit to search all.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return (default: 10).",
      minimum: 1,
      maximum: 50,
      default: 10,
    }),
  ),
});

export const VaultGetSchema = Type.Object({
  collection: Type.String({
    description: "Collection name (e.g. 'subaru').",
  }),
  path: Type.String({
    description:
      "File path within the collection, as returned by vault_search " +
      "(e.g. 'subaru-manual.pdf#page-353'). Use the 'file' field from search results.",
  }),
});

export const VaultStatusSchema = Type.Object({});

// ---------------------------------------------------------------------------
// Memory Schemas
// ---------------------------------------------------------------------------

export const VaultMemorySearchSchema = Type.Object({
  query: Type.String({
    description:
      "Natural language query to search persistent memory. " +
      "Runs hybrid search (keyword + semantic + hypothetical document) across the vault's _memory collection.",
  }),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 6).",
      minimum: 1,
      maximum: 20,
      default: 6,
    }),
  ),
  minScore: Type.Optional(
    Type.Number({
      description: "Minimum relevance score threshold (default: 0).",
      minimum: 0,
      maximum: 1,
    }),
  ),
});

export const VaultMemoryGetSchema = Type.Object({
  path: Type.String({
    description:
      "Relative path within the _memory collection (e.g. 'MEMORY.md' or 'memory/2026-02-21.md').",
  }),
  from: Type.Optional(
    Type.Number({
      description: "Start line (1-based). Omit to read from the beginning.",
      minimum: 1,
    }),
  ),
  lines: Type.Optional(
    Type.Number({
      description: "Number of lines to return. Omit to read to the end.",
      minimum: 1,
    }),
  ),
});

export const VaultMemoryWriteSchema = Type.Object({
  path: Type.String({
    description: "Path within the _memory collection (e.g. 'memory/2026-02-21.md' or 'MEMORY.md').",
  }),
  content: Type.String({
    description: "Content to write.",
  }),
  append: Type.Optional(
    Type.Boolean({
      description:
        "If true, append content to the existing file instead of overwriting. " +
        "Use append for incremental memory updates (e.g. pre-compaction flush).",
      default: false,
    }),
  ),
});

export const VaultExecSchema = Type.Object({
  command: Type.String({
    description:
      "The command to execute (e.g. 'python3', 'node', 'sh', 'grep'). " +
      "The command runs inside a kernel-enforced sandbox with access only to workspace files.",
  }),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description: "Arguments to pass to the command (e.g. ['script.py'] or ['-c', 'echo hello']).",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Timeout in seconds. For synchronous mode: 1-300 (default: 30). " +
        "For background mode: 1-1800 (30 min). Command is killed if it exceeds this.",
      minimum: 1,
      maximum: 1800,
      default: 30,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory relative to workspace root (e.g. 'src' or 'tests'). Defaults to workspace root.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run the command in background immediately and return a session ID. " +
        "Use vault_process to interact with the running process (poll output, write stdin, kill, etc.).",
    }),
  ),
  yieldMs: Type.Optional(
    Type.Number({
      description:
        "Wait this many milliseconds for the command to complete. " +
        "If still running after this time, background the command and return a session ID. " +
        "Use vault_process to interact with backgrounded processes.",
      minimum: 10,
      maximum: 120000,
    }),
  ),
});

export const VaultProcessSchema = Type.Object({
  action: Type.String({
    description:
      "Process management action: " +
      "list (show all sessions), " +
      "poll (drain new output from a session), " +
      "log (get full aggregated output), " +
      "write (send data to stdin), " +
      "kill (terminate a running process), " +
      "clear (remove a finished session), " +
      "remove (kill if running + remove session).",
  }),
  sessionId: Type.Optional(
    Type.String({
      description:
        "Session ID (required for all actions except 'list'). Returned by vault_exec in background mode.",
    }),
  ),
  data: Type.Optional(
    Type.String({
      description: "Data to write to the process stdin (for 'write' action).",
    }),
  ),
  eof: Type.Optional(
    Type.Boolean({
      description: "Close stdin after writing data (for 'write' action).",
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description: "Line offset for 'log' action (0-based, default: 0).",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of lines to return for 'log' action (default: 200).",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "For 'poll' action: wait up to this many milliseconds for the process to produce output or exit. " +
        "0 means return immediately (default: 0).",
      minimum: 0,
      maximum: 120000,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

type SearchResult = {
  docid: string;
  file: string;
  title: string;
  score: number;
  context: string | null;
  snippet: string;
};

export type VaultToolsOptions = {
  onMemoryWrite?: (path: string) => void;
};

export function createVaultTools(baseUrl: string, options?: VaultToolsOptions): AnyAgentTool[] {
  // -- vault_search -----------------------------------------------------------
  const vaultSearch: AnyAgentTool = {
    name: "vault_search",
    label: "Vault Search",
    description:
      "Search the Straja Vault document collections using hybrid retrieval " +
      "(keyword + semantic + hypothetical document). Returns ranked results " +
      "with titles, relevance scores, and text snippets. " +
      "Use vault_get to read the full content of a specific result.",
    parameters: VaultSearchSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const query = String(params.query || "");
      if (!query) {
        return { content: [{ type: "text" as const, text: "Error: query is required." }] };
      }

      const collections = params.collections as string[] | undefined;
      const limit = (params.limit as number) ?? 10;

      // Build hybrid sub-searches for best recall
      const searches = [
        { type: "lex", query },
        { type: "vec", query },
        { type: "hyde", query },
      ];

      const payload: Record<string, unknown> = { searches, limit };
      if (collections && collections.length > 0) {
        payload.collections = collections;
      }

      try {
        const resp = await fetch(`${baseUrl}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [{ type: "text" as const, text: `Vault error (${resp.status}): ${errText}` }],
          };
        }

        const data = (await resp.json()) as { results: SearchResult[] };
        const results = data.results || [];

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No results found." }],
          };
        }

        // Format results for the LLM
        const lines = results.map(
          (r, i) => `[${i + 1}] ${r.title} (${r.file}) — score: ${r.score}\n${r.snippet}`,
        );
        const text = `Found ${results.length} result(s):\n\n${lines.join("\n\n")}`;

        return {
          content: [{ type: "text" as const, text }],
          details: { results },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_get --------------------------------------------------------------
  const vaultGet: AnyAgentTool = {
    name: "vault_get",
    label: "Vault Get Document",
    description:
      "Retrieve the full text content of a document from Straja Vault. " +
      "Use the collection name and file path from vault_search results.",
    parameters: VaultGetSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const collection = String(params.collection || "");
      const path = String(params.path || "");

      if (!collection || !path) {
        return {
          content: [{ type: "text" as const, text: "Error: collection and path are required." }],
        };
      }

      // The file field from search results is "collection/path" — strip the collection prefix if present
      const cleanPath = path.startsWith(`${collection}/`)
        ? path.slice(collection.length + 1)
        : path;

      try {
        const url = `${baseUrl}/collections/${encodeURIComponent(collection)}/files/${encodeURIComponent(cleanPath)}`;
        const resp = await fetch(url, { signal });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [{ type: "text" as const, text: `Vault error (${resp.status}): ${errText}` }],
          };
        }

        const data = (await resp.json()) as {
          path: string;
          displayPath: string;
          title: string;
          content: string;
          docid: string;
        };

        const text = `# ${data.title}\n\nPath: ${data.displayPath}\nDoc ID: ${data.docid}\n\n${data.content}`;

        return {
          content: [{ type: "text" as const, text }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_status -----------------------------------------------------------
  const vaultStatus: AnyAgentTool = {
    name: "vault_status",
    label: "Vault Status",
    description:
      "Show the status of the Straja Vault index: collections, document counts, and health.",
    parameters: VaultStatusSchema,
    async execute(_toolCallId: string, _params: Record<string, unknown>, signal?: AbortSignal) {
      try {
        const resp = await fetch(`${baseUrl}/status`, { signal });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [{ type: "text" as const, text: `Vault error (${resp.status}): ${errText}` }],
          };
        }

        const data = await resp.json();
        const text = JSON.stringify(data, null, 2);

        return {
          content: [{ type: "text" as const, text: `Vault status:\n${text}` }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_exec --------------------------------------------------------------
  const vaultExec: AnyAgentTool = {
    name: "vault_exec",
    label: "Vault Execute",
    description:
      "Execute a command in a sandboxed environment with access to workspace files. " +
      "The vault materializes all workspace files into a temporary directory, " +
      "runs the command in a kernel-enforced sandbox (nono), " +
      "and captures any new or modified files back into the vault. " +
      "Use this to run scripts, tests, builds, or any command that operates on workspace files. " +
      "The command cannot access the host filesystem outside the workspace. " +
      "Commands that complete within 5 seconds return results immediately. " +
      "Longer-running commands are automatically backgrounded — " +
      "use vault_process to poll output, write stdin, or kill the process. " +
      "Set background: true to background immediately without waiting.",
    parameters: VaultExecSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const command = String(params.command || "");
      if (!command) {
        return {
          content: [{ type: "text" as const, text: "Error: command is required." }],
        };
      }

      const payload: Record<string, unknown> = {
        command,
        args: (params.args as string[]) ?? [],
        timeout: (params.timeout as number) ?? 30,
      };
      if (params.cwd) {
        payload.cwd = String(params.cwd);
      }
      if (params.background === true) {
        payload.background = true;
      }
      // Default yieldMs: if the model didn't explicitly set background or yieldMs,
      // auto-yield after 5 seconds so long-running commands don't block the conversation.
      // The model can still set background: true for immediate backgrounding,
      // or yieldMs for a custom wait time.
      if (typeof params.yieldMs === "number") {
        payload.yieldMs = params.yieldMs;
      } else if (params.background !== true) {
        payload.yieldMs = 5000;
      }

      try {
        const resp = await fetch(`${baseUrl}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Vault exec error (${resp.status}): ${errText}` },
            ],
          };
        }

        const data = (await resp.json()) as Record<string, unknown>;

        // Background mode: process is running, return session info
        if (data.status === "running") {
          const text =
            `Command running in background.\n` +
            `Session ID: ${data.sessionId}\n` +
            `PID: ${data.pid}\n` +
            `Use vault_process to interact (poll, log, write, kill, clear, remove).`;
          return {
            content: [{ type: "text" as const, text }],
            details: data,
          };
        }

        // Synchronous mode: command completed
        const parts: string[] = [];

        if (data.timedOut) {
          parts.push("⚠ Command timed out and was killed.");
        }

        parts.push(`Exit code: ${data.exitCode}`);

        const stdout = String(data.stdout || "").trim();
        const stderr = String(data.stderr || "").trim();

        if (stdout) {
          parts.push(`\nStdout:\n${stdout}`);
        }

        if (stderr) {
          parts.push(`\nStderr:\n${stderr}`);
        }

        const filesChanged = (data.filesChanged as { path: string; action: string }[]) || [];
        if (filesChanged.length > 0) {
          const changes = filesChanged.map((f) => `  ${f.action}: ${f.path}`).join("\n");
          parts.push(`\nFiles changed (${filesChanged.length}):\n${changes}`);
        } else {
          parts.push("\nNo files were changed.");
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_process -----------------------------------------------------------
  const vaultProcess: AnyAgentTool = {
    name: "vault_process",
    label: "Vault Process Manager",
    description:
      "Manage background processes launched by vault_exec. " +
      "Actions: list (show all sessions), poll (drain new output), log (full output), " +
      "write (send data to stdin), kill (terminate process), " +
      "clear/remove (clean up session).",
    parameters: VaultProcessSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const action = String(params.action || "")
        .trim()
        .toLowerCase();
      const sessionId = params.sessionId ? String(params.sessionId) : undefined;

      if (!action) {
        return {
          content: [{ type: "text" as const, text: "Error: action is required." }],
        };
      }

      // PTY-specific actions not supported in vault (nono doesn't allocate PTY)
      if (["send-keys", "submit", "paste"].includes(action)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Action '${action}' is not supported in vault execution (no PTY). ` +
                `Use 'write' to send data to stdin instead.`,
            },
          ],
        };
      }

      try {
        switch (action) {
          case "list": {
            const resp = await fetch(`${baseUrl}/exec/sessions`, { signal });
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            const data = (await resp.json()) as { sessions: Array<Record<string, unknown>> };
            if (!data.sessions || data.sessions.length === 0) {
              return {
                content: [{ type: "text" as const, text: "No active sessions." }],
              };
            }
            const lines = data.sessions.map((s) => {
              const runtime = s.runtimeMs ? `${Math.round((s.runtimeMs as number) / 1000)}s` : "?";
              if (s.status === "running") {
                return `  [${s.id}] ${s.command} — running (${runtime}) pid=${s.pid}\n    tail: ${s.tail || "(no output)"}`;
              }
              return (
                `  [${s.id}] ${s.command} — ${s.status} exit=${s.exitCode} (${runtime})` +
                (s.timedOut ? " TIMED OUT" : "")
              );
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Sessions (${data.sessions.length}):\n${lines.join("\n")}`,
                },
              ],
              details: data,
            };
          }

          case "poll": {
            if (!sessionId) {
              return {
                content: [
                  { type: "text" as const, text: "Error: sessionId is required for poll." },
                ],
              };
            }
            const timeout = typeof params.timeout === "number" ? params.timeout : 0;
            const url = `${baseUrl}/exec/sessions/${encodeURIComponent(sessionId)}/poll?timeout=${timeout}`;
            const resp = await fetch(url, { signal });
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            const data = (await resp.json()) as Record<string, unknown>;
            const parts: string[] = [];
            const stdout = String(data.stdout || "").trim();
            const stderr = String(data.stderr || "").trim();
            if (stdout) parts.push(`Stdout:\n${stdout}`);
            if (stderr) parts.push(`Stderr:\n${stderr}`);
            if (!stdout && !stderr) parts.push("(no new output)");
            if (data.exited) {
              parts.push(
                `\nProcess exited with code ${data.exitCode}${data.timedOut ? " (timed out)" : ""}`,
              );
              const filesChanged = data.filesChanged as Array<{
                path: string;
                action: string;
              }> | null;
              if (filesChanged && filesChanged.length > 0) {
                const changes = filesChanged.map((f) => `  ${f.action}: ${f.path}`).join("\n");
                parts.push(`Files changed (${filesChanged.length}):\n${changes}`);
              }
            }
            return {
              content: [{ type: "text" as const, text: parts.join("\n") }],
              details: data,
            };
          }

          case "log": {
            if (!sessionId) {
              return {
                content: [{ type: "text" as const, text: "Error: sessionId is required for log." }],
              };
            }
            const offset = typeof params.offset === "number" ? params.offset : 0;
            const limit = typeof params.limit === "number" ? params.limit : 200;
            const url = `${baseUrl}/exec/sessions/${encodeURIComponent(sessionId)}/log?offset=${offset}&limit=${limit}`;
            const resp = await fetch(url, { signal });
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            const data = (await resp.json()) as Record<string, unknown>;
            const parts: string[] = [];
            const logContent = String(data.log || "");
            parts.push(logContent || "(empty log)");
            parts.push(
              `\nTotal lines: ${data.totalLines}, chars: ${data.totalChars}${data.truncated ? " (truncated)" : ""}`,
            );
            if (data.exited) {
              parts.push(`Process exited with code ${data.exitCode}`);
            }
            return {
              content: [{ type: "text" as const, text: parts.join("\n") }],
              details: data,
            };
          }

          case "write": {
            if (!sessionId) {
              return {
                content: [
                  { type: "text" as const, text: "Error: sessionId is required for write." },
                ],
              };
            }
            const writePayload: Record<string, unknown> = {};
            if (params.data !== undefined) writePayload.data = String(params.data);
            if (params.eof === true) writePayload.eof = true;

            const resp = await fetch(
              `${baseUrl}/exec/sessions/${encodeURIComponent(sessionId)}/write`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(writePayload),
                signal,
              },
            );
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            const data = (await resp.json()) as Record<string, unknown>;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Wrote ${data.bytes} bytes to stdin.${params.eof ? " (stdin closed)" : ""}`,
                },
              ],
              details: data,
            };
          }

          case "kill": {
            if (!sessionId) {
              return {
                content: [
                  { type: "text" as const, text: "Error: sessionId is required for kill." },
                ],
              };
            }
            const resp = await fetch(
              `${baseUrl}/exec/sessions/${encodeURIComponent(sessionId)}/kill`,
              {
                method: "POST",
                signal,
              },
            );
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            const data = (await resp.json()) as Record<string, unknown>;
            const parts: string[] = ["Process killed."];
            if (data.exited) {
              parts.push(`Exit code: ${data.exitCode}`);
            }
            const filesChanged = data.filesChanged as Array<{
              path: string;
              action: string;
            }> | null;
            if (filesChanged && filesChanged.length > 0) {
              const changes = filesChanged.map((f) => `  ${f.action}: ${f.path}`).join("\n");
              parts.push(`Files changed (${filesChanged.length}):\n${changes}`);
            }
            return {
              content: [{ type: "text" as const, text: parts.join("\n") }],
              details: data,
            };
          }

          case "clear":
          case "remove": {
            if (!sessionId) {
              return {
                content: [
                  { type: "text" as const, text: `Error: sessionId is required for ${action}.` },
                ],
              };
            }
            const resp = await fetch(`${baseUrl}/exec/sessions/${encodeURIComponent(sessionId)}`, {
              method: "DELETE",
              signal,
            });
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            return {
              content: [{ type: "text" as const, text: `Session ${sessionId} removed.` }],
            };
          }

          default:
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown action: '${action}'. Valid actions: list, poll, log, write, kill, clear, remove.`,
                },
              ],
            };
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_memory_search ----------------------------------------------------
  const vaultMemorySearch: AnyAgentTool = {
    name: "vault_memory_search",
    label: "Memory Search",
    description:
      "Mandatory recall step: semantically search persistent memory " +
      "(MEMORY.md + memory/*.md stored in the vault's _memory collection) before answering " +
      "questions about prior work, decisions, dates, people, preferences, or todos. " +
      "Returns top snippets with path and relevance scores.",
    parameters: VaultMemorySearchSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const query = String(params.query || "");
      if (!query) {
        return { content: [{ type: "text" as const, text: "Error: query is required." }] };
      }

      const maxResults = (params.maxResults as number) ?? 6;
      const minScore = params.minScore as number | undefined;

      const searches = [
        { type: "lex", query },
        { type: "vec", query },
        { type: "hyde", query },
      ];

      const payload: Record<string, unknown> = {
        searches,
        collections: ["_memory"],
        limit: maxResults,
      };
      if (minScore !== undefined) {
        payload.minScore = minScore;
      }

      try {
        const resp = await fetch(`${baseUrl}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Memory search error (${resp.status}): ${errText}` },
            ],
          };
        }

        const data = (await resp.json()) as { results: SearchResult[] };
        const results = data.results || [];

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No memory results found." }],
          };
        }

        const lines = results.map(
          (r, i) => `[${i + 1}] ${r.file} — score: ${r.score}\n${r.snippet}`,
        );
        const text = `Found ${results.length} memory result(s):\n\n${lines.join("\n\n")}`;

        return {
          content: [{ type: "text" as const, text }],
          details: { results },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_memory_get -------------------------------------------------------
  const vaultMemoryGet: AnyAgentTool = {
    name: "vault_memory_get",
    label: "Memory Get",
    description:
      "Read a specific memory file from the vault's _memory collection with optional " +
      "from/lines slicing. Use after vault_memory_search to pull only the needed lines " +
      "and keep context small.",
    parameters: VaultMemoryGetSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const path = String(params.path || "");
      if (!path) {
        return { content: [{ type: "text" as const, text: "Error: path is required." }] };
      }

      const from = params.from as number | undefined;
      const lineCount = params.lines as number | undefined;

      try {
        const url = `${baseUrl}/raw/_memory/${encodeURIComponent(path)}`;
        const resp = await fetch(url, { signal });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Memory get error (${resp.status}): ${errText}` },
            ],
          };
        }

        let text = await resp.text();

        // Apply from/lines slicing if specified
        if (from !== undefined || lineCount !== undefined) {
          const allLines = text.split("\n");
          const startIdx = from ? from - 1 : 0; // from is 1-based
          const endIdx = lineCount !== undefined ? startIdx + lineCount : allLines.length;
          text = allLines.slice(startIdx, endIdx).join("\n");
        }

        return {
          content: [{ type: "text" as const, text }],
          details: { path, text },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_memory_write -----------------------------------------------------
  const vaultMemoryWrite: AnyAgentTool = {
    name: "vault_memory_write",
    label: "Memory Write",
    description:
      "Write or append to a memory file in the vault's _memory collection. " +
      "Use path like 'memory/2026-02-21.md' or 'MEMORY.md'. " +
      "Set append: true to add content without overwriting existing entries.",
    parameters: VaultMemoryWriteSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const path = String(params.path || "");
      const content = String(params.content ?? "");
      const append = Boolean(params.append);

      if (!path) {
        return { content: [{ type: "text" as const, text: "Error: path is required." }] };
      }
      if (!content) {
        return { content: [{ type: "text" as const, text: "Error: content is required." }] };
      }

      try {
        const encodedPath = encodeURIComponent(path);
        let resp: Response;

        if (append) {
          resp = await fetch(`${baseUrl}/raw/_memory/${encodedPath}/append`, {
            method: "POST",
            body: content,
            signal,
          });
        } else {
          resp = await fetch(`${baseUrl}/raw/_memory/${encodedPath}`, {
            method: "PUT",
            body: content,
            signal,
          });
        }

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Memory write error (${resp.status}): ${errText}` },
            ],
          };
        }

        // Fire-and-forget: trigger embedding for the new/updated memory
        fetch(`${baseUrl}/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => {});

        // Invalidate the MEMORY.md cache so the next prompt build picks up changes
        options?.onMemoryWrite?.(path);

        const action = append ? "appended to" : "wrote";
        return {
          content: [{ type: "text" as const, text: `Successfully ${action} _memory/${path}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  return [
    vaultSearch,
    vaultGet,
    vaultStatus,
    vaultExec,
    vaultProcess,
    vaultMemorySearch,
    vaultMemoryGet,
    vaultMemoryWrite,
  ];
}
