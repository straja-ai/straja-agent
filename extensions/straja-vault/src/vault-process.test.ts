import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Tests for the vault_process tool — verifies HTTP action mapping,
 * error handling, and PTY-unsupported action guard.
 *
 * We mock `fetch` globally to intercept all vault HTTP calls and verify
 * the tool correctly maps actions → endpoints.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:8181";

/** Minimal mock for AnyAgentTool execute interface */
type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;

/** Extract just the vault_process tool from createVaultTools */
let vaultProcessExecute: ToolExecute;

beforeEach(async () => {
  // Dynamically import to get fresh tool instances
  const { createVaultTools } = await import("./tools.js");
  const tools = createVaultTools(BASE_URL);
  const vaultProcess = tools.find((t) => t.name === "vault_process");
  if (!vaultProcess) throw new Error("vault_process tool not found");
  vaultProcessExecute = vaultProcess.execute.bind(vaultProcess) as ToolExecute;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// PTY-unsupported actions
// ---------------------------------------------------------------------------

describe("vault_process PTY guard", () => {
  test("send-keys returns not-supported error", async () => {
    const result = await vaultProcessExecute("tc-1", { action: "send-keys", sessionId: "abc" });
    expect(result.content[0].text).toContain("not supported in vault execution");
    expect(result.content[0].text).toContain("no PTY");
  });

  test("submit returns not-supported error", async () => {
    const result = await vaultProcessExecute("tc-2", { action: "submit", sessionId: "abc" });
    expect(result.content[0].text).toContain("not supported in vault execution");
  });

  test("paste returns not-supported error", async () => {
    const result = await vaultProcessExecute("tc-3", { action: "paste", sessionId: "abc" });
    expect(result.content[0].text).toContain("not supported in vault execution");
  });
});

// ---------------------------------------------------------------------------
// Action requires action param
// ---------------------------------------------------------------------------

describe("vault_process missing params", () => {
  test("missing action returns error", async () => {
    const result = await vaultProcessExecute("tc-4", {});
    expect(result.content[0].text).toContain("action is required");
  });

  test("poll without sessionId returns error", async () => {
    // Mock fetch to not be called
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await vaultProcessExecute("tc-5", { action: "poll" });
    expect(result.content[0].text).toContain("sessionId is required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("log without sessionId returns error", async () => {
    const result = await vaultProcessExecute("tc-6", { action: "log" });
    expect(result.content[0].text).toContain("sessionId is required");
  });

  test("write without sessionId returns error", async () => {
    const result = await vaultProcessExecute("tc-7", { action: "write" });
    expect(result.content[0].text).toContain("sessionId is required");
  });

  test("kill without sessionId returns error", async () => {
    const result = await vaultProcessExecute("tc-8", { action: "kill" });
    expect(result.content[0].text).toContain("sessionId is required");
  });

  test("clear without sessionId returns error", async () => {
    const result = await vaultProcessExecute("tc-9", { action: "clear" });
    expect(result.content[0].text).toContain("sessionId is required");
  });

  test("remove without sessionId returns error", async () => {
    const result = await vaultProcessExecute("tc-10", { action: "remove" });
    expect(result.content[0].text).toContain("sessionId is required");
  });
});

// ---------------------------------------------------------------------------
// Unknown action
// ---------------------------------------------------------------------------

describe("vault_process unknown action", () => {
  test("unknown action returns error with valid actions list", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await vaultProcessExecute("tc-11", { action: "bogus" });
    expect(result.content[0].text).toContain("Unknown action");
    expect(result.content[0].text).toContain("bogus");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HTTP action mapping — list
// ---------------------------------------------------------------------------

describe("vault_process list", () => {
  test("calls GET /exec/sessions", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));

    const result = await vaultProcessExecute("tc-12", { action: "list" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`${BASE_URL}/exec/sessions`);
    expect(result.content[0].text).toContain("No active sessions");
  });

  test("formats running sessions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessions: [
            {
              id: "abc",
              command: "python3",
              status: "running",
              pid: 1234,
              runtimeMs: 5000,
              tail: "output...",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await vaultProcessExecute("tc-13", { action: "list" });
    expect(result.content[0].text).toContain("abc");
    expect(result.content[0].text).toContain("python3");
    expect(result.content[0].text).toContain("running");
  });
});

// ---------------------------------------------------------------------------
// HTTP action mapping — poll
// ---------------------------------------------------------------------------

describe("vault_process poll", () => {
  test("calls GET /exec/sessions/:id/poll with timeout", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ stdout: "hello", stderr: "", exited: false }), {
          status: 200,
        }),
      );

    const result = await vaultProcessExecute("tc-14", {
      action: "poll",
      sessionId: "abc",
      timeout: 5000,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/exec/sessions/abc/poll");
    expect(String(url)).toContain("timeout=5000");
    expect(result.content[0].text).toContain("hello");
  });

  test("shows exit info when process exited", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          stdout: "done",
          stderr: "",
          exited: true,
          exitCode: 0,
          timedOut: false,
          filesChanged: [{ path: "output.txt", action: "created" }],
        }),
        { status: 200 },
      ),
    );

    const result = await vaultProcessExecute("tc-15", { action: "poll", sessionId: "abc" });
    expect(result.content[0].text).toContain("exited with code 0");
    expect(result.content[0].text).toContain("output.txt");
    expect(result.content[0].text).toContain("created");
  });
});

// ---------------------------------------------------------------------------
// HTTP action mapping — log
// ---------------------------------------------------------------------------

describe("vault_process log", () => {
  test("calls GET /exec/sessions/:id/log with offset and limit", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            log: "line1\nline2",
            totalLines: 2,
            totalChars: 12,
            truncated: false,
            exited: true,
            exitCode: 0,
          }),
          { status: 200 },
        ),
      );

    const result = await vaultProcessExecute("tc-16", {
      action: "log",
      sessionId: "abc",
      offset: 10,
      limit: 50,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/exec/sessions/abc/log");
    expect(String(url)).toContain("offset=10");
    expect(String(url)).toContain("limit=50");
    expect(result.content[0].text).toContain("line1");
    expect(result.content[0].text).toContain("Total lines: 2");
  });
});

// ---------------------------------------------------------------------------
// HTTP action mapping — write
// ---------------------------------------------------------------------------

describe("vault_process write", () => {
  test("calls POST /exec/sessions/:id/write with data", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ bytes: 11 }), { status: 200 }));

    const result = await vaultProcessExecute("tc-17", {
      action: "write",
      sessionId: "abc",
      data: "hello world",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/exec/sessions/abc/write");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.data).toBe("hello world");
    expect(result.content[0].text).toContain("Wrote 11 bytes");
  });

  test("includes eof flag when specified", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ bytes: 5 }), { status: 200 }));

    const result = await vaultProcessExecute("tc-18", {
      action: "write",
      sessionId: "abc",
      data: "quit\n",
      eof: true,
    });
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.eof).toBe(true);
    expect(result.content[0].text).toContain("stdin closed");
  });
});

// ---------------------------------------------------------------------------
// HTTP action mapping — kill
// ---------------------------------------------------------------------------

describe("vault_process kill", () => {
  test("calls POST /exec/sessions/:id/kill", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ exited: true, exitCode: 137, filesChanged: [] }), {
          status: 200,
        }),
      );

    const result = await vaultProcessExecute("tc-19", { action: "kill", sessionId: "abc" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/exec/sessions/abc/kill");
    expect(opts.method).toBe("POST");
    expect(result.content[0].text).toContain("Process killed");
  });

  test("shows file changes after kill", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          exited: true,
          exitCode: 137,
          filesChanged: [{ path: "data.csv", action: "modified" }],
        }),
        { status: 200 },
      ),
    );

    const result = await vaultProcessExecute("tc-20", { action: "kill", sessionId: "abc" });
    expect(result.content[0].text).toContain("data.csv");
    expect(result.content[0].text).toContain("modified");
  });
});

// ---------------------------------------------------------------------------
// HTTP action mapping — clear/remove
// ---------------------------------------------------------------------------

describe("vault_process clear/remove", () => {
  test("clear calls DELETE /exec/sessions/:id", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await vaultProcessExecute("tc-21", { action: "clear", sessionId: "abc" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/exec/sessions/abc");
    expect(opts.method).toBe("DELETE");
    expect(result.content[0].text).toContain("Session abc removed");
  });

  test("remove calls DELETE /exec/sessions/:id", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await vaultProcessExecute("tc-22", { action: "remove", sessionId: "xyz" });
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/exec/sessions/xyz");
    expect(result.content[0].text).toContain("Session xyz removed");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("vault_process error handling", () => {
  test("HTTP error response is forwarded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Session not found", { status: 404 }),
    );

    const result = await vaultProcessExecute("tc-23", { action: "poll", sessionId: "nope" });
    expect(result.content[0].text).toContain("Error (404)");
    expect(result.content[0].text).toContain("Session not found");
  });

  test("network error is caught", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await vaultProcessExecute("tc-24", { action: "list" });
    expect(result.content[0].text).toContain("Vault connection error");
    expect(result.content[0].text).toContain("ECONNREFUSED");
  });
});
