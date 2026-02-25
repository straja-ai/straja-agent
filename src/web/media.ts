import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { SafeOpenError, readLocalFileSafely } from "../infra/fs-safe.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { type MediaKind, maxBytesForKind, mediaKindFromMime } from "../media/constants.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import {
  convertHeicToJpeg,
  hasAlphaChannel,
  optimizeImageToPng,
  resizeToJpeg,
} from "../media/image-ops.js";
import { getDefaultMediaLocalRoots } from "../media/local-roots.js";
import { detectMime, extensionForMime } from "../media/mime.js";
import { resolveUserPath } from "../utils.js";

export type WebMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind: MediaKind;
  fileName?: string;
};

type WebMediaOptions = {
  maxBytes?: number;
  optimizeImages?: boolean;
  ssrfPolicy?: SsrFPolicy;
  /** Narrow per-request URL prefix allowlist; matched URLs get a hostname exception with redirects disabled. */
  urlAllowlistPrefixes?: readonly string[];
  /** Allowed root directories for local path reads. "any" is deprecated; prefer sandboxValidated + readFile. */
  localRoots?: readonly string[] | "any";
  /** Caller already validated the local path (sandbox/other guards); requires readFile override. */
  sandboxValidated?: boolean;
  readFile?: (filePath: string) => Promise<Buffer>;
};

export type LocalMediaAccessErrorCode =
  | "path-not-allowed"
  | "invalid-root"
  | "invalid-file-url"
  | "unsafe-bypass"
  | "not-found"
  | "invalid-path"
  | "not-file";

export class LocalMediaAccessError extends Error {
  code: LocalMediaAccessErrorCode;

  constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "LocalMediaAccessError";
  }
}

export function getDefaultLocalRoots(): readonly string[] {
  return getDefaultMediaLocalRoots();
}

async function assertLocalMediaAllowed(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
): Promise<void> {
  if (localRoots === "any") {
    return;
  }
  const roots = localRoots ?? getDefaultLocalRoots();
  // Resolve symlinks so a symlink under /tmp pointing to /etc/passwd is caught.
  let resolved: string;
  try {
    resolved = await fs.realpath(mediaPath);
  } catch {
    resolved = path.resolve(mediaPath);
  }

  // Hardening: the default allowlist includes `os.tmpdir()`, and tests/CI may
  // override the state dir into tmp. Avoid accidentally allowing per-agent
  // `workspace-*` state roots via the tmpdir prefix match; require explicit
  // localRoots for those.
  if (localRoots === undefined) {
    const workspaceRoot = roots.find((root) => path.basename(root) === "workspace");
    if (workspaceRoot) {
      const stateDir = path.dirname(workspaceRoot);
      const rel = path.relative(stateDir, resolved);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        const firstSegment = rel.split(path.sep)[0] ?? "";
        if (firstSegment.startsWith("workspace-")) {
          throw new LocalMediaAccessError(
            "path-not-allowed",
            `Local media path is not under an allowed directory: ${mediaPath}`,
          );
        }
      }
    }
  }
  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await fs.realpath(root);
    } catch {
      resolvedRoot = path.resolve(root);
    }
    if (resolvedRoot === path.parse(resolvedRoot).root) {
      throw new LocalMediaAccessError(
        "invalid-root",
        `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`,
      );
    }
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) {
      return;
    }
  }
  throw new LocalMediaAccessError(
    "path-not-allowed",
    `Local media path is not under an allowed directory: ${mediaPath}`,
  );
}

const HEIC_MIME_RE = /^image\/hei[cf]$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;
const MB = 1024 * 1024;

function formatMb(bytes: number, digits = 2): string {
  return (bytes / MB).toFixed(digits);
}

function formatCapLimit(label: string, cap: number, size: number): string {
  return `${label} exceeds ${formatMb(cap, 0)}MB limit (got ${formatMb(size)}MB)`;
}

function formatCapReduce(label: string, cap: number, size: number): string {
  return `${label} could not be reduced below ${formatMb(cap, 0)}MB (got ${formatMb(size)}MB)`;
}

function isHeicSource(opts: { contentType?: string; fileName?: string }): boolean {
  if (opts.contentType && HEIC_MIME_RE.test(opts.contentType.trim())) {
    return true;
  }
  if (opts.fileName && HEIC_EXT_RE.test(opts.fileName.trim())) {
    return true;
  }
  return false;
}

const VAULT_SCREENSHOT_FETCH_BASE_PATH = "/connections/browser/screenshots/file";
const VAULT_SCREENSHOT_FETCH_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const VAULT_SCREENSHOT_FETCH_TOKEN_RE = /^[A-Fa-f0-9]{64}$/;

type StrictMediaUrlAllowRule = {
  protocol: "http:";
  hostname: "127.0.0.1";
  port: string;
  basePath: typeof VAULT_SCREENSHOT_FETCH_BASE_PATH;
};

function parseStrictMediaUrlAllowRules(values?: readonly string[]): StrictMediaUrlAllowRule[] {
  if (!values || values.length === 0) {
    return [];
  }
  const rules: StrictMediaUrlAllowRule[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:") {
      continue;
    }
    if (parsed.hostname !== "127.0.0.1") {
      continue;
    }
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    if (normalizedPath !== VAULT_SCREENSHOT_FETCH_BASE_PATH) {
      continue;
    }
    if (parsed.search || parsed.hash) {
      continue;
    }
    rules.push({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: parsed.port || "80",
      basePath: VAULT_SCREENSHOT_FETCH_BASE_PATH,
    });
  }
  return rules;
}

function matchesStrictMediaUrlAllowRule(url: URL, rule: StrictMediaUrlAllowRule): boolean {
  if (url.protocol !== rule.protocol) {
    return false;
  }
  if (url.hostname !== rule.hostname) {
    return false;
  }
  if ((url.port || "80") !== rule.port) {
    return false;
  }

  const prefix = `${rule.basePath}/`;
  if (!url.pathname.startsWith(prefix)) {
    return false;
  }
  const opaqueId = url.pathname.slice(prefix.length);
  if (!VAULT_SCREENSHOT_FETCH_ID_RE.test(opaqueId) || opaqueId.includes("/")) {
    return false;
  }

  const params = url.searchParams;
  if (params.size !== 1) {
    return false;
  }
  const token = params.get("token");
  if (!token || !VAULT_SCREENSHOT_FETCH_TOKEN_RE.test(token)) {
    return false;
  }
  return true;
}

function toJpegFileName(fileName?: string): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const trimmed = fileName.trim();
  if (!trimmed) {
    return fileName;
  }
  const parsed = path.parse(trimmed);
  if (!parsed.ext || HEIC_EXT_RE.test(parsed.ext)) {
    return path.format({ dir: parsed.dir, name: parsed.name || trimmed, ext: ".jpg" });
  }
  return path.format({ dir: parsed.dir, name: parsed.name, ext: ".jpg" });
}

type OptimizedImage = {
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  format: "jpeg" | "png";
  quality?: number;
  compressionLevel?: number;
};

function logOptimizedImage(params: { originalSize: number; optimized: OptimizedImage }): void {
  if (!shouldLogVerbose()) {
    return;
  }
  if (params.optimized.optimizedSize >= params.originalSize) {
    return;
  }
  if (params.optimized.format === "png") {
    logVerbose(
      `Optimized PNG (preserving alpha) from ${formatMb(params.originalSize)}MB to ${formatMb(params.optimized.optimizedSize)}MB (side≤${params.optimized.resizeSide}px)`,
    );
    return;
  }
  logVerbose(
    `Optimized media from ${formatMb(params.originalSize)}MB to ${formatMb(params.optimized.optimizedSize)}MB (side≤${params.optimized.resizeSide}px, q=${params.optimized.quality})`,
  );
}

async function optimizeImageWithFallback(params: {
  buffer: Buffer;
  cap: number;
  meta?: { contentType?: string; fileName?: string };
}): Promise<OptimizedImage> {
  const { buffer, cap, meta } = params;
  const isPng = meta?.contentType === "image/png" || meta?.fileName?.toLowerCase().endsWith(".png");
  const hasAlpha = isPng && (await hasAlphaChannel(buffer));

  if (hasAlpha) {
    const optimized = await optimizeImageToPng(buffer, cap);
    if (optimized.buffer.length <= cap) {
      return { ...optimized, format: "png" };
    }
    if (shouldLogVerbose()) {
      logVerbose(
        `PNG with alpha still exceeds ${formatMb(cap, 0)}MB after optimization; falling back to JPEG`,
      );
    }
  }

  const optimized = await optimizeImageToJpeg(buffer, cap, meta);
  return { ...optimized, format: "jpeg" };
}

async function loadWebMediaInternal(
  mediaUrl: string,
  options: WebMediaOptions = {},
): Promise<WebMediaResult> {
  const {
    maxBytes,
    optimizeImages = true,
    ssrfPolicy,
    urlAllowlistPrefixes,
    localRoots,
    sandboxValidated = false,
    readFile: readFileOverride,
  } = options;
  // Strip MEDIA: prefix used by agent tools (e.g. TTS) to tag media paths.
  // Be lenient: LLM output may add extra whitespace (e.g. "  MEDIA :  /tmp/x.png").
  mediaUrl = mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
  // Use fileURLToPath for proper handling of file:// URLs (handles file://localhost/path, etc.)
  if (mediaUrl.startsWith("file://")) {
    try {
      mediaUrl = fileURLToPath(mediaUrl);
    } catch {
      throw new LocalMediaAccessError("invalid-file-url", `Invalid file:// URL: ${mediaUrl}`);
    }
  }

  const optimizeAndClampImage = async (
    buffer: Buffer,
    cap: number,
    meta?: { contentType?: string; fileName?: string },
  ) => {
    const originalSize = buffer.length;
    const optimized = await optimizeImageWithFallback({ buffer, cap, meta });
    logOptimizedImage({ originalSize, optimized });

    if (optimized.buffer.length > cap) {
      throw new Error(formatCapReduce("Media", cap, optimized.buffer.length));
    }

    const contentType = optimized.format === "png" ? "image/png" : "image/jpeg";
    const fileName =
      optimized.format === "jpeg" && meta && isHeicSource(meta)
        ? toJpegFileName(meta.fileName)
        : meta?.fileName;

    return {
      buffer: optimized.buffer,
      contentType,
      kind: "image" as const,
      fileName,
    };
  };

  const clampAndFinalize = async (params: {
    buffer: Buffer;
    contentType?: string;
    kind: MediaKind;
    fileName?: string;
  }): Promise<WebMediaResult> => {
    // If caller explicitly provides maxBytes, trust it (for channels that handle large files).
    // Otherwise fall back to per-kind defaults.
    const cap = maxBytes !== undefined ? maxBytes : maxBytesForKind(params.kind);
    if (params.kind === "image") {
      const isGif = params.contentType === "image/gif";
      if (isGif || !optimizeImages) {
        if (params.buffer.length > cap) {
          throw new Error(formatCapLimit(isGif ? "GIF" : "Media", cap, params.buffer.length));
        }
        return {
          buffer: params.buffer,
          contentType: params.contentType,
          kind: params.kind,
          fileName: params.fileName,
        };
      }
      return {
        ...(await optimizeAndClampImage(params.buffer, cap, {
          contentType: params.contentType,
          fileName: params.fileName,
        })),
      };
    }
    if (params.buffer.length > cap) {
      throw new Error(formatCapLimit("Media", cap, params.buffer.length));
    }
    return {
      buffer: params.buffer,
      contentType: params.contentType ?? undefined,
      kind: params.kind,
      fileName: params.fileName,
    };
  };

  if (/^https?:\/\//i.test(mediaUrl)) {
    const strictRules = parseStrictMediaUrlAllowRules(urlAllowlistPrefixes);
    let parsedRemoteUrl: URL | null = null;
    try {
      parsedRemoteUrl = new URL(mediaUrl);
    } catch {
      parsedRemoteUrl = null;
    }
    const matchedRule = parsedRemoteUrl
      ? strictRules.find((rule) => matchesStrictMediaUrlAllowRule(parsedRemoteUrl, rule))
      : undefined;
    let effectiveSsrfPolicy = ssrfPolicy;
    let effectiveMaxRedirects: number | undefined;
    if (matchedRule && parsedRemoteUrl) {
      try {
        const existing = ssrfPolicy?.allowedHostnames ?? [];
        const mergedAllowedHostnames = Array.from(
          new Set(
            [...existing, parsedRemoteUrl.hostname].map((value) => value.trim()).filter(Boolean),
          ),
        );
        effectiveSsrfPolicy = {
          ...ssrfPolicy,
          allowedHostnames: mergedAllowedHostnames,
        };
        // Prevent redirect-based widening after a strict local screenshot route match.
        effectiveMaxRedirects = 0;
      } catch {
        // Let fetchRemoteMedia return the normal invalid URL error.
      }
    }
    // Enforce a download cap during fetch to avoid unbounded memory usage.
    // For optimized images, allow fetching larger payloads before compression.
    const defaultFetchCap = maxBytesForKind("unknown");
    const fetchCap =
      maxBytes === undefined
        ? defaultFetchCap
        : optimizeImages
          ? Math.max(maxBytes, defaultFetchCap)
          : maxBytes;
    const fetched = await fetchRemoteMedia({
      url: mediaUrl,
      maxBytes: fetchCap,
      ssrfPolicy: effectiveSsrfPolicy,
      ...(effectiveMaxRedirects !== undefined ? { maxRedirects: effectiveMaxRedirects } : {}),
    });
    const { buffer, contentType, fileName } = fetched;
    const kind = mediaKindFromMime(contentType);
    return await clampAndFinalize({ buffer, contentType, kind, fileName });
  }

  // Expand tilde paths to absolute paths (e.g., ~/Downloads/photo.jpg)
  if (mediaUrl.startsWith("~")) {
    mediaUrl = resolveUserPath(mediaUrl);
  }

  if ((sandboxValidated || localRoots === "any") && !readFileOverride) {
    throw new LocalMediaAccessError(
      "unsafe-bypass",
      "Refusing localRoots bypass without readFile override. Use sandboxValidated with readFile, or pass explicit localRoots.",
    );
  }

  // Guard local reads against allowed directory roots to prevent file exfiltration.
  if (!(sandboxValidated || localRoots === "any")) {
    await assertLocalMediaAllowed(mediaUrl, localRoots);
  }

  // Local path
  let data: Buffer;
  if (readFileOverride) {
    data = await readFileOverride(mediaUrl);
  } else {
    try {
      data = (await readLocalFileSafely({ filePath: mediaUrl })).buffer;
    } catch (err) {
      if (err instanceof SafeOpenError) {
        if (err.code === "not-found") {
          throw new LocalMediaAccessError("not-found", `Local media file not found: ${mediaUrl}`, {
            cause: err,
          });
        }
        if (err.code === "not-file") {
          throw new LocalMediaAccessError(
            "not-file",
            `Local media path is not a file: ${mediaUrl}`,
            { cause: err },
          );
        }
        throw new LocalMediaAccessError(
          "invalid-path",
          `Local media path is not safe to read: ${mediaUrl}`,
          { cause: err },
        );
      }
      throw err;
    }
  }
  const mime = await detectMime({ buffer: data, filePath: mediaUrl });
  const kind = mediaKindFromMime(mime);
  let fileName = path.basename(mediaUrl) || undefined;
  if (fileName && !path.extname(fileName) && mime) {
    const ext = extensionForMime(mime);
    if (ext) {
      fileName = `${fileName}${ext}`;
    }
  }
  return await clampAndFinalize({
    buffer: data,
    contentType: mime,
    kind,
    fileName,
  });
}

export async function loadWebMedia(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: {
    ssrfPolicy?: SsrFPolicy;
    urlAllowlistPrefixes?: readonly string[];
    localRoots?: readonly string[] | "any";
  },
): Promise<WebMediaResult> {
  if (typeof maxBytesOrOptions === "number" || maxBytesOrOptions === undefined) {
    return await loadWebMediaInternal(mediaUrl, {
      maxBytes: maxBytesOrOptions,
      optimizeImages: true,
      ssrfPolicy: options?.ssrfPolicy,
      urlAllowlistPrefixes: options?.urlAllowlistPrefixes,
      localRoots: options?.localRoots,
    });
  }
  return await loadWebMediaInternal(mediaUrl, {
    ...maxBytesOrOptions,
    optimizeImages: maxBytesOrOptions.optimizeImages ?? true,
  });
}

export async function loadWebMediaRaw(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: {
    ssrfPolicy?: SsrFPolicy;
    urlAllowlistPrefixes?: readonly string[];
    localRoots?: readonly string[] | "any";
  },
): Promise<WebMediaResult> {
  if (typeof maxBytesOrOptions === "number" || maxBytesOrOptions === undefined) {
    return await loadWebMediaInternal(mediaUrl, {
      maxBytes: maxBytesOrOptions,
      optimizeImages: false,
      ssrfPolicy: options?.ssrfPolicy,
      urlAllowlistPrefixes: options?.urlAllowlistPrefixes,
      localRoots: options?.localRoots,
    });
  }
  return await loadWebMediaInternal(mediaUrl, {
    ...maxBytesOrOptions,
    optimizeImages: false,
  });
}

export async function optimizeImageToJpeg(
  buffer: Buffer,
  maxBytes: number,
  opts: { contentType?: string; fileName?: string } = {},
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  quality: number;
}> {
  // Try a grid of sizes/qualities until under the limit.
  let source = buffer;
  if (isHeicSource(opts)) {
    try {
      source = await convertHeicToJpeg(buffer);
    } catch (err) {
      throw new Error(`HEIC image conversion failed: ${String(err)}`, { cause: err });
    }
  }
  const sides = [2048, 1536, 1280, 1024, 800];
  const qualities = [80, 70, 60, 50, 40];
  let smallest: {
    buffer: Buffer;
    size: number;
    resizeSide: number;
    quality: number;
  } | null = null;

  for (const side of sides) {
    for (const quality of qualities) {
      try {
        const out = await resizeToJpeg({
          buffer: source,
          maxSide: side,
          quality,
          withoutEnlargement: true,
        });
        const size = out.length;
        if (!smallest || size < smallest.size) {
          smallest = { buffer: out, size, resizeSide: side, quality };
        }
        if (size <= maxBytes) {
          return {
            buffer: out,
            optimizedSize: size,
            resizeSide: side,
            quality,
          };
        }
      } catch {
        // Continue trying other size/quality combinations
      }
    }
  }

  if (smallest) {
    return {
      buffer: smallest.buffer,
      optimizedSize: smallest.size,
      resizeSide: smallest.resizeSide,
      quality: smallest.quality,
    };
  }

  throw new Error("Failed to optimize image");
}

export { optimizeImageToPng };
