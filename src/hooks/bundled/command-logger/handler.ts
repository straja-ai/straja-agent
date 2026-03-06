/**
 * Example hook handler: Log all commands to a file
 *
 * This handler demonstrates how to create a hook that logs all command events
 * to a centralized log file for audit/debugging purposes.
 *
 * To enable this handler, add it to your config:
 *
 * ```json
 * {
 *   "hooks": {
 *     "internal": {
 *       "enabled": true,
 *       "handlers": [
 *         {
 *           "event": "command",
 *           "module": "./hooks/handlers/command-logger.ts"
 *         }
 *       ]
 *     }
 *   }
 * }
 * ```
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import type { HookHandler } from "../../hooks.js";

// ---------------------------------------------------------------------------
// Vault patch consumer — routes command logs through vault when available
// ---------------------------------------------------------------------------

const LOGS_PATCH_KEY = Symbol.for("openclaw.logsPatchCallback");

type LogsPatchOps = {
  appendLine(logName: string, line: string): Promise<void>;
};

function resolveVaultLogsOps(): LogsPatchOps | undefined {
  const g = globalThis as Record<symbol, unknown>;
  const factory = g[LOGS_PATCH_KEY] as (() => LogsPatchOps) | undefined;
  return factory?.();
}

// ---------------------------------------------------------------------------

/**
 * Log all command events to a file
 */
const logCommand: HookHandler = async (event) => {
  // Only trigger on command events
  if (event.type !== "command") {
    return;
  }

  try {
    const logLine = JSON.stringify({
      timestamp: event.timestamp.toISOString(),
      action: event.action,
      sessionKey: event.sessionKey,
      senderId: event.context.senderId ?? "unknown",
      source: event.context.commandSource ?? "unknown",
    });

    // Vault path: append to vault's _logs collection.
    const vaultOps = resolveVaultLogsOps();
    if (vaultOps) {
      await vaultOps.appendLine("commands.log", logLine);
      return;
    }

    // Disk path (original).
    const stateDir = resolveStateDir(process.env, os.homedir);
    const logDir = path.join(stateDir, "logs");
    await fs.mkdir(logDir, { recursive: true });

    const logFile = path.join(logDir, "commands.log");
    await fs.appendFile(logFile, logLine + "\n", "utf-8");
  } catch (err) {
    console.error(
      "[command-logger] Failed to log command:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default logCommand;
