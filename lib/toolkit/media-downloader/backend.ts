/**
 * Worker -> sidecar client.
 *
 * The sidecar is the only component that talks to yt-dlp. This module is the
 * single place the Worker reaches out to it, so the shared secret and the
 * base URL have exactly one home.
 *
 * The Worker never proxies media bytes — it resolves metadata and mints a
 * signed session URL, then the browser pulls the file straight from the
 * sidecar. That keeps large files off a 128 MB / CPU-capped isolate.
 */

import { backendUnavailable, mapYtdlpError, type MappedError } from "./errors";
import { DOWNLOAD_LIMITS } from "./limits";
import { signSessionQuery, SESSION_TTL_SECONDS } from "./session-token";
import type {
  DownloaderErrorResponse,
  MediaMeta,
  QualityOption,
  ResolveResponse,
} from "./types";

/** Re-exported so the route has one import for everything sidecar-facing. */
export { DOWNLOAD_LIMITS };

/** Raw shape the sidecar sends back. */
export type SidecarResolveBody =
  | {
      readonly ok: true;
      readonly meta: MediaMeta;
      readonly qualities: readonly QualityOption[];
      /** Opaque handle the Worker signs and hands to the browser. */
      readonly sessionId: string;
    }
  | { readonly ok: false; readonly stderr: string };

/**
 * What the route actually consumes. The sidecar's own `ok:false` branch has
 * already been mapped to a user-facing error here, so callers get one
 * discriminated union on `ok` and never have to re-narrow.
 */
export type ResolveOutcome =
  | {
      readonly ok: true;
      readonly meta: MediaMeta;
      readonly qualities: readonly QualityOption[];
      readonly sessionId: string;
    }
  | { readonly ok: false; readonly error: MappedError };

export type SidecarConfig = {
  readonly baseUrl: string;
  readonly secret: string;
};

export function sidecarConfigFromEnv(): SidecarConfig | null {
  const baseUrl = process.env.MEDIA_DOWNLOADER_URL?.trim();
  const secret = process.env.MEDIA_DOWNLOADER_SECRET?.trim();
  if (!baseUrl || !secret) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), secret };
}

/** Pick the best error copy we have when the sidecar is simply down. */
function unreachable(cause: unknown): MappedError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return backendUnavailable(
    /abort/i.test(message)
      ? "The download service took too long to respond. Try again in a minute."
      : undefined,
  );
}

/**
 * Resolve a URL to metadata + a selectable quality list.
 * Never throws — failures come back as typed errors so the route can map them.
 */
export async function resolveOnSidecar(
  config: SidecarConfig,
  url: string,
): Promise<ResolveOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_LIMITS.resolveTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Downloader-Secret": config.secret,
      },
      body: JSON.stringify({ url }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, error: unreachable(error) };
  } finally {
    clearTimeout(timeout);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: unreachable(new Error("non-JSON response")) };
  }

  if (!response.ok) {
    // 4xx/5xx with no structured body means the sidecar itself broke.
    const message = readString(body, "message");
    return { ok: false, error: backendUnavailable(message) };
  }

  const payload = body as SidecarResolveBody;
  if (payload.ok === false) {
    return { ok: false, error: mapYtdlpError(payload.stderr) };
  }
  return payload;
}

/**
 * Mint the signed, absolute session URL the browser uses for progress + bytes.
 * Expires on its own, so a leaked URL is useless within the hour.
 *
 * `sessionId` comes from the sidecar, which already stored the resolved URL
 * against it during `/resolve` — the Worker never has to ship the URL back.
 */
export async function mintSessionUrl(
  config: SidecarConfig,
  sessionId: string,
): Promise<ResolveResponse["sessionUrl"]> {
  const query = await signSessionQuery(sessionId, config.secret, SESSION_TTL_SECONDS);
  return `${config.baseUrl}/session/${encodeURIComponent(sessionId)}?${query}`;
}

/** Liveness probe used by the health endpoint and by startup checks. */
export async function pingSidecar(config: SidecarConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.baseUrl}/health`, {
      headers: { "X-Downloader-Secret": config.secret },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

function readString(value: unknown, key: string): string | undefined {
  if (value && typeof value === "object" && key in value) {
    const found = (value as Record<string, unknown>)[key];
    return typeof found === "string" ? found : undefined;
  }
  return undefined;
}

export function toErrorResponse(error: MappedError): DownloaderErrorResponse {
  return error.hint
    ? { ok: false, code: error.code, message: error.message, hint: error.hint }
    : { ok: false, code: error.code, message: error.message };
}