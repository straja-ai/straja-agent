import type { OpenClawConfig } from "../config/config.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  filterBootstrapFilesForLocalModel,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const COMPACT_LOCAL_BOOTSTRAP_MAX_CHARS = 3_500;
const COMPACT_LOCAL_BOOTSTRAP_TOTAL_MAX_CHARS = 12_000;

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  if (!params.warn) {
    return undefined;
  }
  return (message: string) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  compactLocal?: boolean;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  let bootstrapFiles = filterBootstrapFilesForSession(
    await loadWorkspaceBootstrapFiles(params.workspaceDir),
    sessionKey,
  );
  if (params.compactLocal) {
    bootstrapFiles = filterBootstrapFilesForLocalModel(bootstrapFiles);
  }

  return applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  compactLocal?: boolean;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const maxChars = params.compactLocal
    ? Math.min(resolveBootstrapMaxChars(params.config), COMPACT_LOCAL_BOOTSTRAP_MAX_CHARS)
    : resolveBootstrapMaxChars(params.config);
  const totalMaxChars = params.compactLocal
    ? Math.min(
        resolveBootstrapTotalMaxChars(params.config),
        COMPACT_LOCAL_BOOTSTRAP_TOTAL_MAX_CHARS,
      )
    : resolveBootstrapTotalMaxChars(params.config);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars,
    totalMaxChars,
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
