import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import { captureEnv } from "../test-utils/env.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "./pairing-store.js";

let fixtureRoot = "";
let caseId = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pairing-"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>) {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG"]);
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, "{}\n", "utf8");
  process.env.OPENCLAW_STATE_DIR = dir;
  process.env.OPENCLAW_CONFIG = configPath;
  try {
    return await fn(dir);
  } finally {
    envSnapshot.restore();
  }
}

describe("pairing store", () => {
  it("reuses pending code and reports created=false", async () => {
    await withTempStateDir(async () => {
      const first = await upsertChannelPairingRequest({
        channel: "discord",
        id: "u1",
      });
      const second = await upsertChannelPairingRequest({
        channel: "discord",
        id: "u1",
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.code).toBe(first.code);

      const list = await listChannelPairingRequests("discord");
      expect(list).toHaveLength(1);
      expect(list[0]?.code).toBe(first.code);
    });
  });

  it("expires pending requests after TTL", async () => {
    await withTempStateDir(async (stateDir) => {
      const created = await upsertChannelPairingRequest({
        channel: "signal",
        id: "+15550001111",
      });
      expect(created.created).toBe(true);

      const oauthDir = resolveOAuthDir(process.env, stateDir);
      const filePath = path.join(oauthDir, "signal-pairing.json");
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        requests?: Array<Record<string, unknown>>;
      };
      const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const requests = (parsed.requests ?? []).map((entry) => ({
        ...entry,
        createdAt: expiredAt,
        lastSeenAt: expiredAt,
      }));
      await fs.writeFile(
        filePath,
        `${JSON.stringify({ version: 1, requests }, null, 2)}\n`,
        "utf8",
      );

      const list = await listChannelPairingRequests("signal");
      expect(list).toHaveLength(0);

      const next = await upsertChannelPairingRequest({
        channel: "signal",
        id: "+15550001111",
      });
      expect(next.created).toBe(true);
    });
  });

  it("regenerates when a generated code collides", async () => {
    await withTempStateDir(async () => {
      const spy = vi.spyOn(crypto, "randomInt") as unknown as {
        mockReturnValue: (value: number) => void;
        mockImplementation: (fn: () => number) => void;
        mockRestore: () => void;
      };
      try {
        spy.mockReturnValue(0);
        const first = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "123",
        });
        expect(first.code).toBe("AAAAAAAA");

        const sequence = Array(8).fill(0).concat(Array(8).fill(1));
        let idx = 0;
        spy.mockImplementation(() => sequence[idx++] ?? 1);
        const second = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "456",
        });
        expect(second.code).toBe("BBBBBBBB");
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("caps pending requests at the default limit", async () => {
    await withTempStateDir(async () => {
      const ids = ["+15550000001", "+15550000002", "+15550000003"];
      for (const id of ids) {
        const created = await upsertChannelPairingRequest({
          channel: "whatsapp",
          id,
        });
        expect(created.created).toBe(true);
      }

      const blocked = await upsertChannelPairingRequest({
        channel: "whatsapp",
        id: "+15550000004",
      });
      expect(blocked.created).toBe(false);

      const list = await listChannelPairingRequests("whatsapp");
      const listIds = list.map((entry) => entry.id);
      expect(listIds).toHaveLength(3);
      expect(listIds).toContain("+15550000001");
      expect(listIds).toContain("+15550000002");
      expect(listIds).toContain("+15550000003");
      expect(listIds).not.toContain("+15550000004");
    });
  });

  it("stores allowFrom entries per account when accountId is provided", async () => {
    await withTempStateDir(async () => {
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });

      const accountScoped = await readChannelAllowFromStore("telegram", process.env, "yy");
      const channelScoped = await readChannelAllowFromStore("telegram");
      expect(accountScoped).toContain("12345");
      expect(channelScoped).not.toContain("12345");
    });
  });

  it("approves pairing codes into account-scoped allowFrom via pairing metadata", async () => {
    await withTempStateDir(async () => {
      const created = await upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "yy",
        id: "12345",
      });
      expect(created.created).toBe(true);

      const approved = await approveChannelPairingCode({
        channel: "telegram",
        code: created.code,
      });
      expect(approved?.id).toBe("12345");

      const accountScoped = await readChannelAllowFromStore("telegram", process.env, "yy");
      const channelScoped = await readChannelAllowFromStore("telegram");
      expect(accountScoped).toContain("12345");
      expect(channelScoped).not.toContain("12345");
    });
  });

  it("persists approved ids in commands.ownerAllowFrom", async () => {
    await withTempStateDir(async (stateDir) => {
      const created = await upsertChannelPairingRequest({
        channel: "telegram",
        id: "8425169799",
      });
      expect(created.created).toBe(true);

      const approved = await approveChannelPairingCode({
        channel: "telegram",
        code: created.code,
        owner: true,
      });
      expect(approved?.id).toBe("8425169799");

      const configPath = path.join(stateDir, "openclaw.json");
      const rawConfig = await fs.readFile(configPath, "utf8");
      const parsedConfig = JSON.parse(rawConfig) as {
        commands?: {
          ownerAllowFrom?: unknown[];
        };
      };
      expect(parsedConfig.commands?.ownerAllowFrom).toContain("8425169799");

      const createdAgain = await upsertChannelPairingRequest({
        channel: "telegram",
        id: "8425169799",
      });
      expect(createdAgain.created).toBe(true);
      await approveChannelPairingCode({
        channel: "telegram",
        code: createdAgain.code,
        owner: true,
      });
      const rawConfigAfter = await fs.readFile(configPath, "utf8");
      const parsedAfter = JSON.parse(rawConfigAfter) as {
        commands?: {
          ownerAllowFrom?: unknown[];
        };
      };
      const entries = (parsedAfter.commands?.ownerAllowFrom ?? []).filter(
        (entry) => entry === "8425169799",
      );
      expect(entries).toHaveLength(1);
    });
  });

  it("does not persist approved ids in commands.ownerAllowFrom unless owner is requested", async () => {
    await withTempStateDir(async (stateDir) => {
      const created = await upsertChannelPairingRequest({
        channel: "telegram",
        id: "8425169799",
      });
      expect(created.created).toBe(true);

      const approved = await approveChannelPairingCode({
        channel: "telegram",
        code: created.code,
      });
      expect(approved?.id).toBe("8425169799");

      const configPath = path.join(stateDir, "openclaw.json");
      const rawConfig = await fs.readFile(configPath, "utf8");
      const parsedConfig = JSON.parse(rawConfig) as {
        commands?: {
          ownerAllowFrom?: unknown[];
        };
      };
      expect(parsedConfig.commands?.ownerAllowFrom ?? []).not.toContain("8425169799");
    });
  });

  it("reads legacy channel-scoped allowFrom for default account", async () => {
    await withTempStateDir(async (stateDir) => {
      const oauthDir = resolveOAuthDir(process.env, stateDir);
      await fs.mkdir(oauthDir, { recursive: true });
      await fs.writeFile(
        path.join(oauthDir, "telegram-allowFrom.json"),
        JSON.stringify(
          {
            version: 1,
            allowFrom: ["1001"],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(oauthDir, "telegram-default-allowFrom.json"),
        JSON.stringify(
          {
            version: 1,
            allowFrom: ["1002"],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const scoped = await readChannelAllowFromStore("telegram", process.env, "default");
      expect(scoped).toEqual(["1002", "1001"]);
    });
  });
});
