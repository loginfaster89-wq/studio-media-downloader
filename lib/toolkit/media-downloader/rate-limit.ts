/**
 * Best-effort rate limiting for the resolve endpoint.
 *
 * IMPORTANT — what this is and is not: a Worker isolate is short-lived and
 * per-colo, so this in-memory map is a *load shedder*, not a security
 * boundary. It stops one runaway client from hammering yt-dlp out of a single
 * isolate, and it smooths bursts. It is trivially bypassed across colos.
 *
 * For hard enforcement put a Cloudflare Rate Limiting binding (or a Durable
 * Object counter) behind the same interface — see `check()` below. Do not treat
 * the current implementation as abuse prevention; pair it with a Turnstile
 * challenge if the endpoint becomes attractive to scrapers.
 */

type Bucket = { count: number; resetAt: number };

/** Keep the map from growing without bound on a long-lived isolate. */
const MAX_TRACKED_CLIENTS = 5000;

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

/** Evict expired buckets occasionally rather than on every request. */
function sweep(nowMs: number): void {
  if (nowMs - lastSweep < 60_000) return;
  lastSweep = nowMs;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= nowMs) buckets.delete(key);
  }
}

/**
 * Make room without wiping everyone's quota.
 *
 * A previous version called `buckets.clear()` here, so one client rotating
 * 5,000 forged keys reset every real client's limit as collateral damage.
 */
function evictOne(): void {
  let oldestKey: string | undefined;
  let oldestReset = Infinity;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < oldestReset) {
      oldestReset = bucket.resetAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) buckets.delete(oldestKey);
}

export type RateLimitVerdict =
  | { readonly ok: true; readonly remaining: number; readonly resetAt: number }
  | { readonly ok: false; readonly retryAfterSeconds: number };

/**
 * Count one hit against `key`.
 * `limit` is the number of requests allowed per window.
 */
export function check(
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number = Date.now(),
): RateLimitVerdict {
  sweep(nowMs);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= nowMs) {
    if (buckets.size >= MAX_TRACKED_CLIENTS) evictOne();
    buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return { ok: true, remaining: limit - 1, resetAt: nowMs + windowMs };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)),
    };
  }

  return { ok: true, remaining: limit - existing.count, resetAt: existing.resetAt };
}

/**
 * Derive a client key from proxy headers.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be forged by the client, so
 * it is the only header we trust.
 *
 * `X-Forwarded-For` is deliberately NOT used: it is fully client-controlled
 * whenever Cloudflare is not in front (direct origin access, `next dev`), and
 * trusting it let one client defeat the limit with a rotated header. Without a
 * trustworthy header we collapse to a single shared bucket rather than
 * inventing an identity from attacker-supplied data.
 */
export function clientKey(headers: Headers): string {
  return headers.get("cf-connecting-ip") ?? "shared";
}