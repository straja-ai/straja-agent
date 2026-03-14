import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";

// ---------------------------------------------------------------------------
// Vault I/O bridge for workspace state + extra bootstrap files
// ---------------------------------------------------------------------------

/** Well-known Symbol for the gateway workspace patch (vault-backed file ops). */
const GATEWAY_WORKSPACE_PATCH_KEY = Symbol.for("openclaw.gatewayWorkspacePatchCallback");

type VaultWorkspaceOps = {
  readFile(filename: string): Promise<string | null>;
  writeFile(filename: string, content: string): Promise<void>;
};

function resolveVaultWorkspaceOps(): VaultWorkspaceOps | undefined {
  const g = globalThis as Record<symbol, unknown>;
  const factory = g[GATEWAY_WORKSPACE_PATCH_KEY] as (() => VaultWorkspaceOps) | undefined;
  return factory?.();
}

function requireVaultWorkspaceOps(context: string): VaultWorkspaceOps {
  const ops = resolveVaultWorkspaceOps();
  if (ops) {
    return ops;
  }
  throw new Error(`[vault] ${context}: workspace patch is missing; refusing disk fallback`);
}

/** Well-known Symbol for the bootstrap patch (vault-backed bootstrap file loader). */
const BOOTSTRAP_PATCH_KEY = Symbol.for("openclaw.bootstrapPatchCallback");

type VaultBootstrapLoader = (filename: string) => Promise<string | null>;

function resolveVaultBootstrapLoader(): VaultBootstrapLoader | undefined {
  const g = globalThis as Record<symbol, unknown>;
  const factory = g[BOOTSTRAP_PATCH_KEY] as (() => VaultBootstrapLoader) | undefined;
  return factory?.();
}

function requireVaultBootstrapLoader(context: string): VaultBootstrapLoader {
  const loader = resolveVaultBootstrapLoader();
  if (loader) {
    return loader;
  }
  throw new Error(`[vault] ${context}: bootstrap patch is missing; refusing disk fallback`);
}

export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveRequiredHomeDir(env, homedir);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";
const WORKSPACE_STATE_DIRNAME = ".openclaw";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

type WorkspaceOnboardingState = {
  version: typeof WORKSPACE_STATE_VERSION;
  bootstrapSeededAt?: string;
  onboardingCompletedAt?: string;
};

/** Set of recognized bootstrap filenames for runtime validation */
const VALID_BOOTSTRAP_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
]);

function resolveWorkspaceStatePath(dir: string): string {
  return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}

function parseWorkspaceOnboardingState(raw: string): WorkspaceOnboardingState | null {
  try {
    const parsed = JSON.parse(raw) as {
      bootstrapSeededAt?: unknown;
      onboardingCompletedAt?: unknown;
    };
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      version: WORKSPACE_STATE_VERSION,
      bootstrapSeededAt:
        typeof parsed.bootstrapSeededAt === "string" ? parsed.bootstrapSeededAt : undefined,
      onboardingCompletedAt:
        typeof parsed.onboardingCompletedAt === "string" ? parsed.onboardingCompletedAt : undefined,
    };
  } catch {
    return null;
  }
}

/** Vault key for workspace state — stored as .openclaw/workspace-state.json in _workspace. */
const WORKSPACE_STATE_VAULT_KEY = ".openclaw/workspace-state.json";

async function readWorkspaceOnboardingState(statePath: string): Promise<WorkspaceOnboardingState> {
  void statePath;
  const vaultOps = requireVaultWorkspaceOps("readWorkspaceOnboardingState");
  const raw = await vaultOps.readFile(WORKSPACE_STATE_VAULT_KEY);
  if (raw) {
    return (
      parseWorkspaceOnboardingState(raw) ?? {
        version: WORKSPACE_STATE_VERSION,
      }
    );
  }
  return { version: WORKSPACE_STATE_VERSION };
}

async function readWorkspaceOnboardingStateForDir(dir: string): Promise<WorkspaceOnboardingState> {
  const statePath = resolveWorkspaceStatePath(resolveUserPath(dir));
  return await readWorkspaceOnboardingState(statePath);
}

export async function isWorkspaceOnboardingCompleted(dir: string): Promise<boolean> {
  const state = await readWorkspaceOnboardingStateForDir(dir);
  return (
    typeof state.onboardingCompletedAt === "string" && state.onboardingCompletedAt.trim().length > 0
  );
}

async function writeWorkspaceOnboardingState(
  statePath: string,
  state: WorkspaceOnboardingState,
): Promise<void> {
  void statePath;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const vaultOps = requireVaultWorkspaceOps("writeWorkspaceOnboardingState");
  await vaultOps.writeFile(WORKSPACE_STATE_VAULT_KEY, payload);
}

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
}): Promise<{
  dir: string;
  agentsPath?: string;
  soulPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  heartbeatPath?: string;
  bootstrapPath?: string;
}> {
  const vaultOps = requireVaultWorkspaceOps("ensureAgentWorkspace");
  void vaultOps;
  const rawDir = params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);

  if (!params?.ensureBootstrapFiles) {
    return { dir };
  }

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);
  const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
  const statePath = resolveWorkspaceStatePath(dir);
  const vaultBootstrapLoader = requireVaultBootstrapLoader("ensureAgentWorkspace");

  let state = await readWorkspaceOnboardingState(statePath);
  let stateDirty = false;
  const markState = (next: Partial<WorkspaceOnboardingState>) => {
    state = { ...state, ...next };
    stateDirty = true;
  };
  const nowIso = () => new Date().toISOString();

  let bootstrapExists = (await vaultBootstrapLoader(DEFAULT_BOOTSTRAP_FILENAME)) !== null;
  if (!state.bootstrapSeededAt && bootstrapExists) {
    markState({ bootstrapSeededAt: nowIso() });
  }

  if (!state.onboardingCompletedAt && state.bootstrapSeededAt && !bootstrapExists) {
    markState({ onboardingCompletedAt: nowIso() });
  }

  if (!state.bootstrapSeededAt && !state.onboardingCompletedAt && !bootstrapExists) {
    // In vault-backed mode, bootstrap files are seeded by Vault into _workspace.
    // If BOOTSTRAP.md is absent there, treat onboarding as complete rather than
    // falling back to packaged templates or disk writes.
    markState({ onboardingCompletedAt: nowIso() });
  }

  if (stateDirty) {
    await writeWorkspaceOnboardingState(statePath, state);
  }

  return {
    dir,
    agentsPath,
    soulPath,
    toolsPath,
    identityPath,
    userPath,
    heartbeatPath,
    bootstrapPath,
  };
}

export async function loadWorkspaceBootstrapFiles(dir: string): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  const vaultLoader = requireVaultBootstrapLoader("loadWorkspaceBootstrapFiles");
  const result: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    const content = await vaultLoader(entry.name);
    if (content !== null) {
      result.push({ name: entry.name, path: entry.filePath, content, missing: false });
    } else {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

const MINIMAL_BOOTSTRAP_ALLOWLIST = new Set([DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME]);

export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  sessionKey?: string,
): WorkspaceBootstrapFile[] {
  if (!sessionKey || (!isSubagentSessionKey(sessionKey) && !isCronSessionKey(sessionKey))) {
    return files;
  }
  return files.filter((file) => MINIMAL_BOOTSTRAP_ALLOWLIST.has(file.name));
}

export async function loadExtraBootstrapFiles(
  dir: string,
  extraPatterns: string[],
): Promise<WorkspaceBootstrapFile[]> {
  if (!extraPatterns.length) {
    return [];
  }

  const vaultLoader = requireVaultBootstrapLoader("loadExtraBootstrapFiles");
  const result: WorkspaceBootstrapFile[] = [];
  const filenames = new Set<string>();
  for (const pattern of extraPatterns) {
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
      for (const name of VALID_BOOTSTRAP_NAMES) {
        if (pattern === "*.md" || pattern === "**/*.md" || pattern.endsWith("/" + name)) {
          filenames.add(name);
        }
      }
    } else {
      const baseName = path.basename(pattern);
      if (VALID_BOOTSTRAP_NAMES.has(baseName)) {
        filenames.add(baseName);
      }
    }
  }

  for (const filename of filenames) {
    const content = await vaultLoader(filename);
    if (content !== null) {
      result.push({
        name: filename as WorkspaceBootstrapFileName,
        path: path.join(resolveUserPath(dir), filename),
        content,
        missing: false,
      });
    }
  }
  return result;
}
