import { describe, expect, it } from "vitest";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

const SESSION_STORE_PATCH_KEY = Symbol.for("openclaw.sessionStorePatchCallback");

describe("getSubagentDepthFromSessionStore", () => {
  it("uses spawnDepth from the session store when available", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: { spawnDepth: 2 },
      },
    });
    expect(depth).toBe(2);
  });

  it("derives depth from spawnedBy ancestry when spawnDepth is missing", () => {
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionStore(key3, {
      store: {
        [key1]: { spawnedBy: "agent:main:main" },
        [key2]: { spawnedBy: key1 },
        [key3]: { spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves depth when caller is identified by sessionId", () => {
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionStore("subagent-three-session", {
      store: {
        [key1]: { sessionId: "subagent-one-session", spawnedBy: "agent:main:main" },
        [key2]: { sessionId: "subagent-two-session", spawnedBy: key1 },
        [key3]: { sessionId: "subagent-three-session", spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves prefixed store keys when caller key omits the agent prefix", () => {
    const storeTemplate = "/tmp/openclaw-subagent-depth/sessions-{agentId}.json";
    const prefixedKey = "agent:main:subagent:flat";
    const storePath = storeTemplate.replaceAll("{agentId}", "main");
    const sessionStore = {
      [prefixedKey]: {
        sessionId: "subagent-flat",
        updatedAt: Date.now(),
        spawnDepth: 2,
      },
    };
    const g = globalThis as Record<symbol, unknown>;
    const previous = g[SESSION_STORE_PATCH_KEY];
    g[SESSION_STORE_PATCH_KEY] = () => ({
      loadSessionStore: (candidateStorePath: string) =>
        candidateStorePath === storePath ? sessionStore : {},
      saveSessionStore: () => undefined,
    });

    try {
      const depth = getSubagentDepthFromSessionStore("subagent:flat", {
        cfg: {
          session: {
            store: storeTemplate,
          },
        },
      });

      expect(depth).toBe(2);
    } finally {
      if (previous === undefined) {
        delete g[SESSION_STORE_PATCH_KEY];
      } else {
        g[SESSION_STORE_PATCH_KEY] = previous;
      }
    }
  });

  it("falls back to session-key segment counting when metadata is missing", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: {},
      },
    });
    expect(depth).toBe(1);
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("uses a timer-safe sentinel for no-timeout overrides", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(2_147_000_000);
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(2_147_000_000);
  });

  it("clamps very large timeout overrides to timer-safe values", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 9_999_999 })).toBe(2_147_000_000);
    expect(resolveAgentTimeoutMs({ overrideMs: 9_999_999_999 })).toBe(2_147_000_000);
  });
});
