import { execFileSync } from "node:child_process";
import { appendVaultAuthCurlArgs, formatVaultCurlError } from "./http.js";

const COLLECTION = "_subagents";
const REGISTRY_KEY = "runs.json";
const TIMEOUT_MS = 5_000;

/** Well-known Symbol used to pass vault subagent-registry ops from plugin → bundle. */
export const SUBAGENT_REGISTRY_PATCH_KEY = Symbol.for("openclaw.subagentRegistryPatchCallback");

export type SubagentRegistryPatchOps = {
  loadSubagentRegistry: () => Record<string, unknown>;
  saveSubagentRegistry: (runs: Record<string, unknown>) => void;
};

function syncHttpGet(url: string): { status: number; body: string } {
  const args = appendVaultAuthCurlArgs(["-s", "-w", "\n%{http_code}", "-X", "GET", url]);
  try {
    const result = execFileSync("curl", args, {
      encoding: "utf-8",
      timeout: TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = result.trimEnd().split("\n");
    const statusLine = lines.pop() || "0";
    return { status: parseInt(statusLine, 10), body: lines.join("\n") };
  } catch (err: unknown) {
    const msg = formatVaultCurlError(err);
    throw new Error(`Vault subagent-registry GET failed: ${msg}`);
  }
}

function syncHttpPut(url: string, body: string): void {
  try {
    const statusRaw = execFileSync(
      "curl",
      appendVaultAuthCurlArgs([
        "-s",
        "-w",
        "\n%{http_code}",
        "-X",
        "PUT",
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        "@-",
        url,
      ]),
      {
        input: body,
        encoding: "utf-8",
        timeout: TIMEOUT_MS,
        maxBuffer: 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const status = Number.parseInt(statusRaw.trim().split("\n").pop() || "0", 10);
    if (status === 423) {
      throw new Error(`Vault is locked — unlock it before starting the agent`);
    }
    if (!Number.isFinite(status) || status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}`);
    }
  } catch (err: unknown) {
    const msg = formatVaultCurlError(err);
    if (msg.includes("locked")) throw err;
    throw new Error(`Vault subagent-registry PUT failed: ${msg}`);
  }
}

function createVaultSubagentRegistryOps(baseUrl: string): SubagentRegistryPatchOps {
  const url = `${baseUrl}/raw/${COLLECTION}/${encodeURIComponent(REGISTRY_KEY)}`;

  const loadSubagentRegistry = (): Record<string, unknown> => {
    const resp = syncHttpGet(url);
    if (resp.status === 404) {
      return {};
    }
    if (resp.status === 423) {
      throw new Error(`Vault is locked — unlock it before starting the agent`);
    }
    if (resp.status !== 200) {
      throw new Error(`Vault subagent-registry read failed (${resp.status})`);
    }
    if (!resp.body.trim()) {
      return {};
    }
    const parsed = JSON.parse(resp.body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Vault subagent-registry payload is not an object");
    }
    return parsed as Record<string, unknown>;
  };

  const saveSubagentRegistry = (runs: Record<string, unknown>) => {
    const body = JSON.stringify(runs, null, 2);
    syncHttpPut(url, body);
  };

  return { loadSubagentRegistry, saveSubagentRegistry };
}

/**
 * Register the subagent-registry patch callback on globalThis.
 *
 * Called synchronously during plugin register(). The callback is invoked
 * from agents/subagent-registry.store.ts and returns vault-backed load/save ops.
 */
export function registerSubagentRegistryPatch(baseUrl: string): void {
  const g = globalThis as Record<symbol, unknown>;
  g[SUBAGENT_REGISTRY_PATCH_KEY] = (): SubagentRegistryPatchOps =>
    createVaultSubagentRegistryOps(baseUrl);
}
