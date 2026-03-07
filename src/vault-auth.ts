const VAULT_AUTH_TOKEN_KEY = Symbol.for("openclaw.vaultAuthToken");

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

export function appendVaultAuthCurlArgs(args: string[]): string[] {
  const token = getVaultAuthToken();
  if (!token) {
    return args;
  }
  return ["-H", `Authorization: Bearer ${token}`, ...args];
}
