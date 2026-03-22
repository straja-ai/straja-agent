import {
  getFlowTestContext,
  recordFlowTestVaultMutation,
} from "../../../src/auto-reply/flow-test-context.js";

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

function previewRequestBody(body: BodyInit | null | undefined): {
  preview?: string;
  bytes?: number;
} {
  if (body == null) {
    return {};
  }
  if (typeof body === "string") {
    return {
      preview: body.slice(0, 1000),
      bytes: Buffer.byteLength(body),
    };
  }
  if (body instanceof URLSearchParams) {
    const value = body.toString();
    return {
      preview: value.slice(0, 1000),
      bytes: Buffer.byteLength(value),
    };
  }
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return {
      preview: `[binary ${body.byteLength} bytes]`,
      bytes: body.byteLength,
    };
  }
  return {
    preview: `[${Object.prototype.toString.call(body)}]`,
  };
}

function mockVaultMutationResponse(input: string | URL, init: RequestInit): Response {
  const url = new URL(String(input));
  const pathname = url.pathname;
  const bodyText =
    typeof init.body === "string"
      ? init.body
      : init.body instanceof URLSearchParams
        ? init.body.toString()
        : "";

  if (pathname === "/embed") {
    return new Response(JSON.stringify({ ok: true, dryRun: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (pathname === "/notes") {
    let parsed: { title?: string; content?: string } = {};
    try {
      parsed = bodyText ? (JSON.parse(bodyText) as typeof parsed) : {};
    } catch {}
    return new Response(
      JSON.stringify({
        path: "dry-run-note.md",
        title: parsed.title ?? "Dry run note",
        size: typeof parsed.content === "string" ? parsed.content.length : 0,
        dryRun: true,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  if (pathname.startsWith("/notes/")) {
    let parsed: { title?: string; content?: string } = {};
    try {
      parsed = bodyText ? (JSON.parse(bodyText) as typeof parsed) : {};
    } catch {}
    const path = decodeURIComponent(pathname.replace(/^\/notes\//, ""));
    return new Response(
      JSON.stringify({
        path,
        title: parsed.title ?? path,
        size: typeof parsed.content === "string" ? parsed.content.length : 0,
        dryRun: true,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  if (pathname === "/artifacts/build" || pathname === "/reports/build") {
    let parsed: { name?: string } = {};
    try {
      parsed = bodyText ? (JSON.parse(bodyText) as typeof parsed) : {};
    } catch {}
    const name = parsed.name?.trim() || "dry-run";
    if (pathname === "/artifacts/build") {
      return new Response(
        JSON.stringify({
          ok: true,
          pptxPath: `presentations/${name}/build/${name}.pptx`,
          size: 0,
          slides: 0,
          dryRun: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        pdfPath: `reports/${name}/build/${name}.pdf`,
        size: 0,
        sections: 0,
        dryRun: true,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  if (pathname === "/artifacts/url") {
    return new Response(
      JSON.stringify({
        ok: true,
        url: "https://dry-run.invalid/artifact",
        dryRun: true,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return new Response(JSON.stringify({ ok: true, hash: "dry-run", dryRun: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function vaultFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const ctx = getFlowTestContext();
  const method = (init.method ?? "GET").toUpperCase();
  if (ctx && method !== "GET" && method !== "HEAD") {
    const bodyInfo = previewRequestBody(init.body);
    recordFlowTestVaultMutation({
      method,
      url: String(input),
      status: ctx.mode === "apply" ? "applied" : "captured",
      bodyPreview: bodyInfo.preview,
      bodyBytes: bodyInfo.bytes,
    });
    if (ctx.mode === "dry_run") {
      return Promise.resolve(mockVaultMutationResponse(input, init));
    }
  }
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
