import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";

function resolveSafeCwd(): string | null {
  try {
    const cwd = process.cwd();
    if (typeof cwd === "string" && cwd.trim().length > 0) {
      return cwd;
    }
  } catch {
    // Ignore uv_cwd failures when the inherited cwd no longer exists.
  }
  return null;
}

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first, but only when cwd is resolvable.
  const cwd = resolveSafeCwd();
  if (cwd) {
    const localEnvPath = path.join(cwd, ".env");
    if (fs.existsSync(localEnvPath)) {
      dotenv.config({ quiet, path: localEnvPath, override: false });
    }
  }

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}
