/**
 * Per-platform circuit breaker.
 *
 * Why this exists: the dominant failure mode for a hosted downloader is not a
 * bug, it is a platform refusing us. YouTube in particular blocks datacenter
 * egress in waves — cobalt's own tracker has an open incident for it
 * (imputnet/cobalt#1356, "unable to download anything from youtube… we can't
 * go around them at their scale").
 *
 * The naive response is to keep spawning yt-dlp and returning 500s. That burns
 * CPU, hammers the platform, makes our IP reputation worse, and tells the user
 * nothing. The right response is to notice the pattern, stop calling that
 * platform, and say something true and specific.
 *
 * States: CLOSED (normal) -> OPEN (platform is refusing us) -> HALF_OPEN
 * (probe) -> CLOSED or OPEN again.
 *
 * In-memory on purpose: this is a per-instance load shedder. Horizontal
 * scaling would need a shared store, which is documented in the README.
 */

export type BreakerState = "closed" | "open" | "half_open";

type PlatformStats = {
  state: BreakerState;
  failures: number;
  /** Rolling window of recent outcomes. */
  recent: readonly boolean[];
  /** When the breaker may next probe. */
  nextProbeAt: number;
  /** When the current open window ends. */
  openedAt: number;
  lastError?: string;
  totalRequests: number;
  totalFailures: number;
};

export type BreakerOptions = {
  /** Consecutive-ish failures needed to trip. Default 5. */
  readonly failureThreshold?: number;
  /** Rolling window size for the failure ratio. Default 20. */
  readonly windowSize?: number;
  /** Ratio of failures in the window that trips the breaker. Default 0.8. */
  readonly failureRatio?: number;
  /** How long to stay OPEN before probing. Default 120s. */
  readonly cooldownMs?: number;
  /** After a successful probe, how many successes close it. Default 2. */
  readonly successThreshold?: number;
};

const DEFAULTS = {
  failureThreshold: 5,
  windowSize: 20,
  failureRatio: 0.8,
  cooldownMs: 120_000,
  successThreshold: 2,
} as const;

export type PlatformHealth = {
  readonly platform: string;
  readonly state: BreakerState;
  readonly failureRate: number;
  readonly recentFailures: number;
  readonly totalRequests: number;
  readonly totalFailures: number;
  readonly retryAfterSeconds: number;
  readonly lastError?: string;
};

export class PlatformBreakers {
  private readonly platforms = new Map<string, PlatformStats>();
  private readonly opts: Required<BreakerOptions>;

  constructor(options: BreakerOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * May we attempt this platform right now?
   * Returns the reason when we may not, so the caller can give the user a
   * truthful answer instead of a generic 500.
   */
  canAttempt(platform: string, nowMs: number = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number; lastError?: string } {
    const stats = this.stats(platform);

    if (stats.state === "closed") return { ok: true };

    if (stats.state === "open") {
      if (nowMs >= stats.nextProbeAt) {
        // Cooldown elapsed: let exactly one probe through.
        stats.state = "half_open";
        stats.failures = 0;
        return { ok: true };
      }
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((stats.nextProbeAt - nowMs) / 1000)),
        lastError: stats.lastError,
      };
    }

    // half_open: only one probe at a time.
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((stats.nextProbeAt - nowMs) / 1000)),
      lastError: stats.lastError,
    };
  }

  recordSuccess(platform: string, nowMs: number = Date.now()): void {
    const stats = this.stats(platform);
    stats.totalRequests += 1;
    stats.recent = [...stats.recent, true].slice(-this.opts.windowSize);
    stats.failures = 0;
    stats.lastError = undefined;

    if (stats.state === "half_open") {
      stats.successes = (stats.successes ?? 0) + 1;
      if ((stats.successes ?? 0) >= this.opts.successThreshold) {
        this.close(stats);
        return;
      }
      return;
    }

    // Evaluate the rolling ratio here too, not only on failure. A window can
    // cross the threshold on the success that completes it, and waiting for
    // the next failure to notice is exactly the wrong delay during an outage.
    this.evaluate(stats, nowMs);
  }

  /**
   * Record a platform-caused failure.
   *
   * Only genuine extraction/download failures count. A client sending garbage
   * is not the platform's fault and must not trip a breaker for everyone.
   */
  recordFailure(platform: string, error: string, nowMs: number = Date.now()): void {
    const stats = this.stats(platform);
    stats.totalRequests += 1;
    stats.totalFailures += 1;
    stats.failures += 1;
    stats.recent = [...stats.recent, false].slice(-this.opts.windowSize);
    stats.lastError = error;

    if (stats.state === "half_open") {
      this.trip(stats, nowMs);
      return;
    }

    this.evaluate(stats, nowMs);
  }

  /**
   * Trip on either the consecutive-failure streak or the rolling failure ratio.
   * A full window of mostly failures is as damning as an unbroken streak.
   */
  private evaluate(stats: PlatformStats & { successes?: number }, nowMs: number): void {
    if (stats.failures >= this.opts.failureThreshold) {
      this.trip(stats, nowMs);
      return;
    }
    const window = stats.recent;
    if (window.length < this.opts.windowSize) return;
    const ratio = window.filter((ok) => !ok).length / window.length;
    if (ratio >= this.opts.failureRatio) this.trip(stats, nowMs);
  }

  health(platform: string, nowMs: number = Date.now()): PlatformHealth {
    const stats = this.stats(platform);
    const window = stats.recent;
    return {
      platform,
      state: stats.state,
      failureRate: window.length === 0 ? 0 : window.filter((ok) => !ok).length / window.length,
      recentFailures: window.filter((ok) => !ok).length,
      totalRequests: stats.totalRequests,
      totalFailures: stats.totalFailures,
      retryAfterSeconds:
        stats.state === "open" ? Math.max(0, Math.ceil((stats.nextProbeAt - nowMs) / 1000)) : 0,
      lastError: stats.lastError,
    };
  }

  /** Every platform we have seen, for the health endpoint. */
  allHealth(nowMs: number = Date.now()): readonly PlatformHealth[] {
    return [...this.platforms.keys()].map((platform) => this.health(platform, nowMs));
  }

  private stats(platform: string): PlatformStats & { successes?: number } {
    let stats = this.platforms.get(platform) as (PlatformStats & { successes?: number }) | undefined;
    if (!stats) {
      stats = {
        state: "closed",
        failures: 0,
        recent: [],
        nextProbeAt: 0,
        openedAt: 0,
        totalRequests: 0,
        totalFailures: 0,
        successes: 0,
      };
      this.platforms.set(platform, stats);
    }
    return stats;
  }

  private trip(stats: PlatformStats & { successes?: number }, nowMs: number): void {
    stats.state = "open";
    stats.openedAt = nowMs;
    stats.nextProbeAt = nowMs + this.opts.cooldownMs;
    stats.successes = 0;
  }

  private close(stats: PlatformStats & { successes?: number }): void {
    stats.state = "closed";
    stats.failures = 0;
    stats.successes = 0;
    stats.nextProbeAt = 0;
  }
}