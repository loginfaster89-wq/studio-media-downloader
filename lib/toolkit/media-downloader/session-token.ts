/**
 * Short-lived HMAC tokens for download sessions.
 *
 * The browser never sees the shared secret. The Worker mints a signed URL that
 * points straight at the sidecar; the sidecar verifies it before touching disk.
 * That is what lets the media bytes bypass the edge entirely without turning
 * the sidecar into an open file server.
 *
 * Uses Web Crypto only — available in Workers and in Node 18+ — so both sides
 * share one implementation with no dependency.
 */

const encoder = new TextEncoder();

/** How long a signed download session stays valid. */
export const SESSION_TTL_SECONDS = 60 * 60;

/** Sessions stay valid at most this long, even if still being polled. */
export const SESSION_IDLE_SECONDS = 15 * 60;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

/** Constant-time compare that does not leak length via early return. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The exact string both sides sign. Field order is part of the contract. */
function signingInput(sessionId: string, expiresAt: number): string {
  return `${sessionId}.${expiresAt}`;
}

export async function signSessionQuery(
  sessionId: string,
  secret: string,
  ttlSeconds: number = SESSION_TTL_SECONDS,
  nowMs: number = Date.now(),
): Promise<string> {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const signature = await hmac(secret, signingInput(sessionId, expiresAt));
  return `exp=${expiresAt}&sig=${signature}`;
}

/**
 * Verify a signature and its expiry.
 * Returns the expiry on success so the caller can also enforce an idle window.
 */
export async function verifySession(
  sessionId: string,
  expiresAt: number,
  signature: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: "expired" | "bad_signature" }> {
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= nowMs) {
    return { ok: false, reason: "expired" };
  }
  const expected = await hmac(secret, signingInput(sessionId, expiresAt));
  return safeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/** Opaque, URL-safe session id. 128 bits of entropy. */
export function createSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}