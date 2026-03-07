const VAULT_AUTH_TOKEN_KEY = Symbol.for("openclaw.vaultAuthToken");
const CURL_EXIT_REASONS = new Map<number, string>([
  [6, "could not resolve host"],
  [7, "failed to connect"],
  [28, "request timed out"],
  [52, "empty reply from server"],
  [56, "connection reset"],
]);

function normalizeVaultAuthToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let token = value.trim();
  if (!token) {
    return null;
  }
  token = token.replace(/^Bearer\s+/i, "").trim();
  return token || null;
}

export function registerVaultAuthToken(value: unknown): void {
  const token = normalizeVaultAuthToken(value);
  const g = globalThis as Record<symbol, unknown>;
  if (token) {
    g[VAULT_AUTH_TOKEN_KEY] = token;
  } else {
    delete g[VAULT_AUTH_TOKEN_KEY];
  }
}

export function getVaultAuthToken(): string | null {
  const g = globalThis as Record<symbol, unknown>;
  const fromGlobal = normalizeVaultAuthToken(g[VAULT_AUTH_TOKEN_KEY]);
  if (fromGlobal) {
    return fromGlobal;
  }
  return normalizeVaultAuthToken(process.env.STRAJA_VAULT_TOKEN);
}

function withVaultAuthHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers ?? undefined);
  const token = getVaultAuthToken();
  if (token) {
    merged.set("Authorization", `Bearer ${token}`);
  }
  return merged;
}

export function withVaultAuthRequestInit(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: withVaultAuthHeaders(init.headers),
  };
}

export function vaultFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, withVaultAuthRequestInit(init));
}

export function appendVaultAuthCurlArgs(args: string[]): string[] {
  const token = getVaultAuthToken();
  if (!token) {
    return args;
  }
  return ["-H", `Authorization: Bearer ${token}`, ...args];
}

export function appendVaultProbeCurlArgs(args: string[]): string[] {
  return appendVaultAuthCurlArgs([
    "--connect-timeout",
    "2",
    "--max-time",
    "12",
    "--retry",
    "6",
    "--retry-delay",
    "1",
    "--retry-all-errors",
    ...args,
  ]);
}

function sanitizeVaultExecMessage(value: string): string {
  return value
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/svlt_agent_[A-Za-z0-9_-]+/g, "svlt_agent_[REDACTED]");
}

export function formatVaultCurlError(err: unknown): string {
  const anyErr = err as {
    code?: string;
    status?: number | null;
    signal?: string | null;
    stderr?: string | Buffer;
    message?: string;
  };

  if (anyErr?.code === "ENOENT") {
    return "curl not found";
  }
  if (anyErr?.code === "ETIMEDOUT") {
    return "request timed out";
  }
  if (typeof anyErr?.status === "number") {
    const reason = CURL_EXIT_REASONS.get(anyErr.status);
    const stderr =
      typeof anyErr.stderr === "string"
        ? anyErr.stderr.trim()
        : Buffer.isBuffer(anyErr.stderr)
          ? anyErr.stderr.toString("utf-8").trim()
          : "";
    if (stderr) {
      return sanitizeVaultExecMessage(stderr);
    }
    return reason ? `curl failed: ${reason}` : `curl failed with exit code ${anyErr.status}`;
  }
  if (typeof anyErr?.signal === "string" && anyErr.signal) {
    return `curl terminated by signal ${anyErr.signal}`;
  }
  if (err instanceof Error && err.message) {
    return sanitizeVaultExecMessage(err.message);
  }
  return sanitizeVaultExecMessage(String(err ?? "curl failed"));
}
