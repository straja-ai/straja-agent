import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const loadConfigMock = vi.fn();
const fetchWithSsrFGuardMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

import { buildGatewayCronService } from "./server-cron.js";

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    requestHeartbeatNowMock.mockReset();
    loadConfigMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
    vi.useRealTimers();
  });

  it("canonicalizes non-agent sessionKey to agent store key for enqueue + wake", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-ssrf-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;

    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: private/internal IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("runs isolated httpRequest cron payloads through the guarded fetch path", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-http-request-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;

    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("", { status: 200 }),
      release: vi.fn(async () => {}),
    });

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "scheduled-task-http-request",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "httpRequest",
          url: "http://127.0.0.1:8181/tasks/tsk_123/run",
          method: "POST",
          headers: {
            Authorization: "Bearer local",
            "Content-Type": "application/json",
          },
          body: '{"source":"cron"}',
          summary: "Scheduled task: tsk_123",
          allowPrivateNetwork: true,
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8181/tasks/tsk_123/run",
        init: {
          method: "POST",
          headers: {
            Authorization: "Bearer local",
            "Content-Type": "application/json",
          },
          body: '{"source":"cron"}',
          signal: expect.any(AbortSignal),
        },
        policy: {
          allowPrivateNetwork: true,
          hostnameAllowlist: ["127.0.0.1", "localhost", "::1"],
        },
        auditContext: "cron-http-request-internal",
      });
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
    }
  });

  it("marks internal vault callback outages as retryable httpRequest errors", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-http-request-retry-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;

    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("locked", { status: 423, statusText: "Locked" }),
      release: vi.fn(async () => {}),
    });

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "scheduled-task-http-request-retry",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "httpRequest",
          url: "http://127.0.0.1:8181/tasks/tsk_123/run",
          method: "POST",
          allowPrivateNetwork: true,
        },
      });

      await state.cron.run(job.id, "force");

      const updated = state.cron.getJob(job.id);
      expect(updated?.enabled).toBe(true);
      expect(updated?.state.lastStatus).toBe("error");
      expect(updated?.state.consecutiveErrors).toBe(0);
    } finally {
      state.stop();
    }
  });

  it("retries cron startup after vault lock errors", async () => {
    vi.useFakeTimers();

    const tmpDir = path.join(os.tmpdir(), `server-cron-retry-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;

    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });

    const startSpy = vi
      .spyOn(state.cron, "start")
      .mockRejectedValueOnce(new Error("Vault cron store load failed: 423 Locked"))
      .mockResolvedValueOnce(undefined);

    try {
      state.start();
      await Promise.resolve();

      expect(startSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();

      expect(startSpy).toHaveBeenCalledTimes(2);
    } finally {
      state.stop();
    }
  });
});
