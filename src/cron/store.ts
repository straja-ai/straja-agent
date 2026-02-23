import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { expandHomePrefix } from "../infra/home-dir.js";
import { CONFIG_DIR } from "../utils.js";
import type { CronStoreFile } from "./types.js";

export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");

// ---------------------------------------------------------------------------
// Vault patch bridge — when the straja-vault plugin is loaded, cron storage
// is routed through the vault HTTP API instead of the local filesystem.
// ---------------------------------------------------------------------------

const CRON_STORE_PATCH_KEY = Symbol.for("openclaw.cronStorePatchCallback");

type CronStorePatchOps = {
  loadCronStore: (storePath: string) => Promise<CronStoreFile>;
  saveCronStore: (storePath: string, store: CronStoreFile) => Promise<void>;
};

function resolveVaultCronStoreOps(): CronStorePatchOps | undefined {
  const g = globalThis as Record<symbol, unknown>;
  const factory = g[CRON_STORE_PATCH_KEY] as (() => CronStorePatchOps) | undefined;
  return factory?.();
}

// ---------------------------------------------------------------------------

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return DEFAULT_CRON_STORE_PATH;
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  // Vault override: if the straja-vault plugin registered a cron store patch,
  // delegate to the vault-backed implementation.
  const vaultOps = resolveVaultCronStoreOps();
  if (vaultOps) {
    return vaultOps.loadCronStore(storePath);
  }

  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
        cause: err,
      });
    }
    const parsedRecord =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
    return {
      version: 1,
      jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
    };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

export async function saveCronStore(storePath: string, store: CronStoreFile) {
  // Vault override: if the straja-vault plugin registered a cron store patch,
  // delegate to the vault-backed implementation.
  const vaultOps = resolveVaultCronStoreOps();
  if (vaultOps) {
    return vaultOps.saveCronStore(storePath, store);
  }

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const { randomBytes } = await import("node:crypto");
  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, "utf-8");
  await fs.promises.rename(tmp, storePath);
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // best-effort
  }
}
