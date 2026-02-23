import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerCronStorePatch,
  CRON_STORE_PATCH_KEY,
  type CronStorePatchOps,
} from "./cron-store-patch.js";

const BASE_URL = "http://localhost:8181";

function resolveOps(): CronStorePatchOps | undefined {
  const g = globalThis as Record<symbol, unknown>;
  const factory = g[CRON_STORE_PATCH_KEY] as (() => CronStorePatchOps) | undefined;
  return factory?.();
}

describe("cron-store-patch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    delete (globalThis as Record<symbol, unknown>)[CRON_STORE_PATCH_KEY];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as Record<symbol, unknown>)[CRON_STORE_PATCH_KEY];
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  it("registers callback on globalThis", () => {
    registerCronStorePatch(BASE_URL);
    expect((globalThis as Record<symbol, unknown>)[CRON_STORE_PATCH_KEY]).toBeDefined();
  });

  it("resolveOps returns ops after registration", () => {
    registerCronStorePatch(BASE_URL);
    const ops = resolveOps();
    expect(ops).toBeDefined();
    expect(typeof ops!.loadCronStore).toBe("function");
    expect(typeof ops!.saveCronStore).toBe("function");
    expect(typeof ops!.appendCronRunLog).toBe("function");
    expect(typeof ops!.readCronRunLogEntries).toBe("function");
  });

  it("resolveOps returns undefined when not registered", () => {
    const ops = resolveOps();
    expect(ops).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // loadCronStore
  // ---------------------------------------------------------------------------

  describe("loadCronStore", () => {
    it("returns jobs from vault on 200", async () => {
      const store = {
        version: 1,
        jobs: [
          { id: "j1", name: "Daily report", enabled: true },
          { id: "j2", name: "Cleanup", enabled: false },
        ],
      };
      fetchMock.mockResolvedValue(new Response(JSON.stringify(store), { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const result = await ops.loadCronStore("/any/path/jobs.json");

      expect(result.version).toBe(1);
      expect(result.jobs).toHaveLength(2);
      expect(result.jobs[0]).toMatchObject({ id: "j1", name: "Daily report" });
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/raw/_cron/jobs.json`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns empty store on 404", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 404 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const result = await ops.loadCronStore("/any/path/jobs.json");

      expect(result).toEqual({ version: 1, jobs: [] });
    });

    it("throws on vault error (500)", async () => {
      fetchMock.mockResolvedValue(
        new Response("Server Error", { status: 500, statusText: "Internal Server Error" }),
      );
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      await expect(ops.loadCronStore("/any/path")).rejects.toThrow(
        "Vault cron store load failed: 500",
      );
    });

    it("throws on invalid JSON", async () => {
      fetchMock.mockResolvedValue(new Response("{ not json", { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      await expect(ops.loadCronStore("/any/path")).rejects.toThrow(
        /Failed to parse vault cron store/,
      );
    });

    it("handles empty or missing jobs array gracefully", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ version: 1 }), { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const result = await ops.loadCronStore("/any/path");
      expect(result).toEqual({ version: 1, jobs: [] });
    });

    it("filters out falsy values from jobs", async () => {
      const store = { version: 1, jobs: [{ id: "j1" }, null, undefined, false, { id: "j2" }] };
      fetchMock.mockResolvedValue(new Response(JSON.stringify(store), { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const result = await ops.loadCronStore("/any/path");
      expect(result.jobs).toHaveLength(2);
    });

    it("ignores storePath (always uses vault key)", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ version: 1, jobs: [] }), { status: 200 })),
      );
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      await ops.loadCronStore("/home/user/.openclaw/cron/jobs.json");
      await ops.loadCronStore("/completely/different/path");

      // Both calls should hit the same vault key
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const call of fetchMock.mock.calls) {
        expect(call[0]).toBe(`${BASE_URL}/raw/_cron/jobs.json`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // saveCronStore
  // ---------------------------------------------------------------------------

  describe("saveCronStore", () => {
    it("PUTs store JSON to vault", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const store = { version: 1 as const, jobs: [{ id: "j1", name: "Test" }] as any[] };
      await ops.saveCronStore("/any/path", store);

      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/raw/_cron/jobs.json`,
        expect.objectContaining({
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify(store, null, 2),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("throws on vault error", async () => {
      fetchMock.mockResolvedValue(
        new Response("Error", { status: 500, statusText: "Internal Server Error" }),
      );
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      await expect(
        ops.saveCronStore("/any/path", { version: 1, jobs: [] as any[] }),
      ).rejects.toThrow("Vault cron store save failed: 500");
    });
  });

  // ---------------------------------------------------------------------------
  // appendCronRunLog
  // ---------------------------------------------------------------------------

  describe("appendCronRunLog", () => {
    it("appends JSON line to vault via POST /append", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const entry = {
        ts: 1000,
        jobId: "abc-123",
        action: "finished" as const,
        status: "ok" as const,
        durationMs: 500,
      };

      await ops.appendCronRunLog("/home/user/.openclaw/cron/runs/abc-123.jsonl", entry);

      // First call is the append, subsequent calls may be the prune check
      const appendCall = fetchMock.mock.calls[0];
      expect(appendCall[0]).toBe(
        `${BASE_URL}/raw/_cron/${encodeURIComponent("runs/abc-123.jsonl")}/append`,
      );
      expect(appendCall[1].method).toBe("POST");
      expect(appendCall[1].body).toBe(JSON.stringify(entry));
    });

    it("extracts jobId from filesystem path", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      await ops.appendCronRunLog("/home/user/.openclaw/cron/runs/my-special-job-id.jsonl", {
        ts: 1,
        jobId: "my-special-job-id",
        action: "finished",
      });

      const appendCall = fetchMock.mock.calls[0];
      expect(appendCall[0]).toBe(
        `${BASE_URL}/raw/_cron/${encodeURIComponent("runs/my-special-job-id.jsonl")}/append`,
      );
    });

    it("throws on vault error", async () => {
      fetchMock.mockResolvedValue(
        new Response("Error", { status: 500, statusText: "Internal Server Error" }),
      );
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      await expect(
        ops.appendCronRunLog("/path/runs/j1.jsonl", {
          ts: 1,
          jobId: "j1",
          action: "finished",
        }),
      ).rejects.toThrow("Vault cron run log append failed: 500");
    });
  });

  // ---------------------------------------------------------------------------
  // readCronRunLogEntries
  // ---------------------------------------------------------------------------

  describe("readCronRunLogEntries", () => {
    it("returns parsed entries from vault JSONL", async () => {
      const lines = [
        JSON.stringify({ ts: 1, jobId: "j1", action: "finished", status: "ok", durationMs: 100 }),
        JSON.stringify({ ts: 2, jobId: "j1", action: "finished", status: "error", error: "boom" }),
        JSON.stringify({ ts: 3, jobId: "j1", action: "finished", status: "ok", summary: "done" }),
      ].join("\n");

      fetchMock.mockResolvedValue(new Response(lines, { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const entries = await ops.readCronRunLogEntries("/home/user/.openclaw/cron/runs/j1.jsonl", {
        limit: 10,
      });

      expect(entries).toHaveLength(3);
      expect(entries[0]!.ts).toBe(1);
      expect(entries[1]!.status).toBe("error");
      expect(entries[1]!.error).toBe("boom");
      expect(entries[2]!.summary).toBe("done");

      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/raw/_cron/${encodeURIComponent("runs/j1.jsonl")}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns empty array on 404", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 404 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const entries = await ops.readCronRunLogEntries("/path/runs/j1.jsonl");
      expect(entries).toEqual([]);
    });

    it("respects limit parameter", async () => {
      const lines = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ ts: i, jobId: "j1", action: "finished", status: "ok" }),
      ).join("\n");

      fetchMock.mockResolvedValue(new Response(lines, { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const entries = await ops.readCronRunLogEntries("/path/runs/j1.jsonl", { limit: 3 });

      // Returns the 3 most recent entries (ts=7,8,9) in chronological order
      expect(entries).toHaveLength(3);
      expect(entries[0]!.ts).toBe(7);
      expect(entries[2]!.ts).toBe(9);
    });

    it("returns entries in chronological order (oldest first)", async () => {
      const lines = [
        JSON.stringify({ ts: 100, jobId: "j1", action: "finished", status: "ok" }),
        JSON.stringify({ ts: 200, jobId: "j1", action: "finished", status: "ok" }),
        JSON.stringify({ ts: 300, jobId: "j1", action: "finished", status: "ok" }),
      ].join("\n");

      fetchMock.mockResolvedValue(new Response(lines, { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const entries = await ops.readCronRunLogEntries("/path/runs/j1.jsonl");

      expect(entries.map((e) => e.ts)).toEqual([100, 200, 300]);
    });

    it("filters by jobId", async () => {
      const lines = [
        JSON.stringify({ ts: 1, jobId: "j1", action: "finished", status: "ok" }),
        JSON.stringify({ ts: 2, jobId: "j2", action: "finished", status: "ok" }),
        JSON.stringify({ ts: 3, jobId: "j1", action: "finished", status: "ok" }),
      ].join("\n");

      fetchMock.mockResolvedValue(new Response(lines, { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const entries = await ops.readCronRunLogEntries("/path/runs/j1.jsonl", {
        jobId: "j1",
      });

      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.jobId === "j1")).toBe(true);
    });

    it("skips invalid lines", async () => {
      const lines = [
        JSON.stringify({ ts: 1, jobId: "j1", action: "finished", status: "ok" }),
        "{ not json",
        "",
        JSON.stringify({ ts: 2, action: "finished" }), // missing jobId
        JSON.stringify({ ts: "bad", jobId: "j1", action: "finished" }), // non-number ts
        JSON.stringify({ ts: 3, jobId: "j1", action: "finished", status: "ok" }),
      ].join("\n");

      fetchMock.mockResolvedValue(new Response(lines, { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const entries = await ops.readCronRunLogEntries("/path/runs/j1.jsonl");

      expect(entries).toHaveLength(2);
      expect(entries[0]!.ts).toBe(1);
      expect(entries[1]!.ts).toBe(3);
    });

    it("parses telemetry fields", async () => {
      const line = JSON.stringify({
        ts: 1,
        jobId: "j1",
        action: "finished",
        status: "ok",
        model: "gpt-5.2",
        provider: "openai",
        sessionId: "session-abc",
        sessionKey: "agent:main:cron:j1",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cache_read_tokens: 2,
          cache_write_tokens: 1,
        },
      });

      fetchMock.mockResolvedValue(new Response(line, { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const entries = await ops.readCronRunLogEntries("/path/runs/j1.jsonl");

      expect(entries).toHaveLength(1);
      const e = entries[0]!;
      expect(e.model).toBe("gpt-5.2");
      expect(e.provider).toBe("openai");
      expect(e.sessionId).toBe("session-abc");
      expect(e.sessionKey).toBe("agent:main:cron:j1");
      expect(e.usage).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cache_read_tokens: 2,
        cache_write_tokens: 1,
      });
    });

    it("strips empty model/provider strings", async () => {
      const line = JSON.stringify({
        ts: 1,
        jobId: "j1",
        action: "finished",
        status: "ok",
        model: " ",
        provider: "",
      });

      fetchMock.mockResolvedValue(new Response(line, { status: 200 }));
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      const entries = await ops.readCronRunLogEntries("/path/runs/j1.jsonl");

      expect(entries[0]!.model).toBeUndefined();
      expect(entries[0]!.provider).toBeUndefined();
    });

    it("throws on vault error", async () => {
      fetchMock.mockResolvedValue(
        new Response("Error", { status: 500, statusText: "Internal Server Error" }),
      );
      registerCronStorePatch(BASE_URL);
      const ops = resolveOps()!;

      await expect(ops.readCronRunLogEntries("/path/runs/j1.jsonl")).rejects.toThrow(
        "Vault cron run log read failed: 500",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Core integration: store.ts and run-log.ts vault delegation
  // ---------------------------------------------------------------------------

  describe("core delegation", () => {
    it("loadCronStore delegates to vault when patch is registered", async () => {
      const store = { version: 1, jobs: [{ id: "v1", name: "Vault job" }] };
      fetchMock.mockResolvedValue(new Response(JSON.stringify(store), { status: 200 }));
      registerCronStorePatch(BASE_URL);

      // Import the core function — it should pick up the globalThis patch
      const { loadCronStore } = await import("../../../src/cron/store.js");
      const result = await loadCronStore("/does/not/matter");

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]).toMatchObject({ id: "v1" });
      // The call went to vault, not filesystem
      expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/raw/_cron/jobs.json`, expect.any(Object));
    });

    it("saveCronStore delegates to vault when patch is registered", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      registerCronStorePatch(BASE_URL);

      const { saveCronStore } = await import("../../../src/cron/store.js");
      await saveCronStore("/does/not/matter", { version: 1, jobs: [] as any[] });

      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/raw/_cron/jobs.json`,
        expect.objectContaining({ method: "PUT" }),
      );
    });

    it("appendCronRunLog delegates to vault when patch is registered", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      registerCronStorePatch(BASE_URL);

      const { appendCronRunLog } = await import("../../../src/cron/run-log.js");
      await appendCronRunLog("/any/runs/test-job.jsonl", {
        ts: 1,
        jobId: "test-job",
        action: "finished",
      });

      const appendCall = fetchMock.mock.calls[0];
      expect(appendCall[0]).toContain("/raw/_cron/");
      expect(appendCall[0]).toContain("runs%2Ftest-job.jsonl");
      expect(appendCall[1].method).toBe("POST");
    });

    it("readCronRunLogEntries delegates to vault when patch is registered", async () => {
      const lines = JSON.stringify({
        ts: 42,
        jobId: "test-job",
        action: "finished",
        status: "ok",
      });
      fetchMock.mockResolvedValue(new Response(lines, { status: 200 }));
      registerCronStorePatch(BASE_URL);

      const { readCronRunLogEntries } = await import("../../../src/cron/run-log.js");
      const entries = await readCronRunLogEntries("/any/runs/test-job.jsonl");

      expect(entries).toHaveLength(1);
      expect(entries[0]!.ts).toBe(42);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/raw/_cron/"),
        expect.any(Object),
      );
    });
  });
});
